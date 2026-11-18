#!/usr/bin/env node
// Schema migrations from a terminal (the app also runs `up` at boot).
//
//   node scripts/migrate.mjs status          applied / pending / changed versions
//   node scripts/migrate.mjs up [--role R]   apply every pending migration; with an app
//                                            role, then apply its grants (as below)
//   node scripts/migrate.mjs down --to N --yes   roll back every version above N (0 = all)
//   node scripts/migrate.mjs prepare [--role R]  owner hand-off before a deploy publishes
//                                            new code (server/db/grants.js, step 1)
//   node scripts/migrate.mjs grants [--role R]   least-privilege grants of the app role on
//                                            the ai_prism schema; idempotent (step 3)
//
// R defaults to DATABRICKS_CLIENT_ID (the app's service principal = its Postgres
// role). prepare, grants and up --role run as the database owner / table owner
// (the deploying identity); the deploy wrappers (deploy.sh / deploy.ps1) run
// `up --role <app SP>` after the smoke. The owner role is AI_PRISM_OWNER_ROLE
// (default ai_prism_owner; override only on scratch/test databases).
// Exit codes: 0 ok · 1 error · 2 usage · 3 up --role with 0002 deferred (grants
// skipped, owner hand-off closed) · 4 the owner hand-off could not be closed.
//
// Connection: the standard libpq variables (PGHOST, PGPORT, PGUSER, PGPASSWORD,
// PGDATABASE, PGSSLMODE) plus the app's TLS knobs (PG_SSL_CA, PG_SSL_VERIFY). Against Lakebase run it as the identity that
// owns the tables, with a database credential as PGPASSWORD. Example with the
// local dev database:
//
//   node --env-file=.env.local scripts/migrate.mjs status
//
// Every command prints its target (host:port/database as user) first. `down`
// deletes data (0001 down drops every app table), so it also needs --yes: only
// for scratch, CI or a rollback you have planned. See docs/operations.md §6.4.
import os from 'node:os'
import pg from 'pg'
import { GRANTS_NO_SCHEMA, applyAppGrants, closeOwnerHandoff, ownerRoleName, prepareOwnerHandoff } from '../server/db/grants.js'
import { migrateDown, migrateUp, migrationStatus } from '../server/db/migrate.js'
import { pgSslOptions } from '../server/db/pool.js'

const USAGE =
  'usage: node scripts/migrate.mjs status | up [--role R] | down --to N --yes | prepare [--role R] | grants [--role R]'
const COMMANDS = ['status', 'up', 'down', 'prepare', 'grants']

function parse(argv) {
  const [cmd, ...rest] = argv
  const args = { cmd }
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (a === '--to') args.to = rest[++i]
    else if (a.startsWith('--to=')) args.to = a.slice(5)
    else if (a === '--dir') args.dir = rest[++i]
    else if (a === '--yes') args.yes = true
    else if (a === '--role') args.role = rest[++i]
    else if (a.startsWith('--role=')) args.role = a.slice(7)
    else return { error: `unknown argument ${a}` }
  }
  if (!COMMANDS.includes(cmd)) return { error: cmd ? `unknown command ${cmd}` : 'no command' }
  if (cmd !== 'down' && (args.to !== undefined || args.yes)) return { error: `--to and --yes only apply to down` }
  if (args.role !== undefined && !['up', 'prepare', 'grants'].includes(cmd)) return { error: `--role only applies to up, prepare and grants` }
  if (args.role === undefined && ['prepare', 'grants'].includes(cmd)) args.role = process.env.DATABRICKS_CLIENT_ID
  if (['prepare', 'grants'].includes(cmd) && !args.role) {
    return { error: `${cmd} needs the app role: --role <name> or DATABRICKS_CLIENT_ID` }
  }
  if (cmd === 'down' && (args.to === undefined || !/^\d+$/.test(String(args.to)))) {
    return { error: 'down needs --to N (a version >= 0; 0 rolls back everything)' }
  }
  return args
}

const pad = (v) => String(v).padStart(4, '0')
const DATABASE = process.env.PGDATABASE || 'databricks_postgres'
const target = () =>
  `${process.env.PGHOST || 'localhost'}:${process.env.PGPORT || '5432'}/${DATABASE} as ${process.env.PGUSER || os.userInfo().username}`
const when = (d) => (d instanceof Date ? d.toISOString() : String(d ?? ''))

async function main() {
  const args = parse(process.argv.slice(2))
  if (args.error) {
    console.error(`${args.error}\n${USAGE}`)
    return 2
  }
  console.log(`target: ${target()}`)
  if (args.cmd === 'down' && !args.yes) {
    console.error(
      `down --to ${args.to} rolls back migrations on ${target()} and can delete data ` +
        `(down --to 0 drops every app table). Re-run with --yes to confirm.`
    )
    return 2
  }
  const client = new pg.Client({
    database: DATABASE,
    ssl: pgSslOptions(),
    connectionTimeoutMillis: 15000,
  })
  await client.connect()
  const owner = ownerRoleName()
  const grants = async () => {
    const r = await applyAppGrants(client, { role: args.role, owner })
    console.log(
      `grants: ${args.role} has USAGE + DML on ai_prism` +
        (r.revokedHandoff ? `; owner hand-off (${owner}) revoked` : '') +
        (r.defaultPrivileges ? '' : ' (default privileges not set: see the warning above)')
    )
    // exit 4: the SP can still act as the table owner; the deploy must not pass silently
    return r.handoffOpen ? 4 : 0
  }
  try {
    if (args.cmd === 'prepare') {
      await prepareOwnerHandoff(client, { role: args.role, owner })
      console.log(`prepare: ${owner} owns this identity's app tables; ${args.role} may act as it until \`grants\` runs`)
      return 0
    }
    if (args.cmd === 'grants') return await grants()
    if (args.cmd === 'status') {
      const st = await migrationStatus(client, { dir: args.dir })
      const changed = new Set(st.mismatched.map((m) => m.version))
      for (const m of st.applied) {
        const state = changed.has(m.version) ? 'CHANGED-AFTER-APPLY' : 'applied'
        console.log(`${pad(m.version)}  ${m.name}  ${state}  ${when(m.appliedAt)}`)
      }
      for (const m of st.pending) console.log(`${pad(m.version)}  ${m.name}  pending`)
      for (const m of st.unknown) console.log(`${pad(m.version)}  ${m.name}  applied-unknown-to-this-release  ${when(m.appliedAt)}`)
      return st.mismatched.length ? 1 : 0
    }
    if (args.cmd === 'up') {
      const up = async () => {
        const r = await migrateUp(client, { dir: args.dir, ownerRole: owner })
        if (!r.applied.length && !r.adopted && !r.deferred?.length) console.log('migrations: nothing to apply')
        return r
      }
      if (!args.role) {
        await up()
        return 0
      }
      {
        // up --role is the deploy's closing step: on every outcome the SP leaves
        // the owner role (grants close it on success; otherwise the revoke alone)
        let r = {}
        try {
          r = await up()
          return await grants()
        } catch (e) {
          const closed = await closeOwnerHandoff(client, { role: args.role, owner }).catch((ce) => {
            console.error(`grants: could not close the owner hand-off: ${ce.message}`)
            return { open: true }
          })
          if (closed.open) {
            console.error(`${e.message}\ngrants: the owner hand-off is still open (see above)`)
            return 4
          }
          if (e?.code !== GRANTS_NO_SCHEMA) {
            console.error('grants: owner hand-off closed')
            throw e
          }
          const which = r.deferred?.length ? `migration ${r.deferred.join(', ')}` : 'migration 0002'
          console.warn(
            `grants: skipped, ${which} deferred (not applied yet); owner hand-off closed. ` +
              'The app keeps running on the public schema; deploy again (the smoke makes the app apply it)'
          )
          return 3
        }
      }
    }
    const r = await migrateDown(client, { dir: args.dir, to: Number(args.to) })
    if (!r.reverted.length) console.log(`migrations: nothing above ${pad(args.to)} to roll back`)
    return 0
  } finally {
    await client.end().catch(() => {})
  }
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e.code ? `${e.message} [${e.code}]` : e.message)
    process.exit(1)
  }
)
