#!/usr/bin/env node
// Schema migrations from a terminal (the app also runs `up` at boot).
//
//   node scripts/migrate.mjs status          applied / pending / changed versions
//   node scripts/migrate.mjs up              apply every pending migration
//   node scripts/migrate.mjs down --to N     roll back every version above N (0 = all)
//
// Connection: the standard libpq variables (PGHOST, PGPORT, PGUSER, PGPASSWORD,
// PGDATABASE, PGSSLMODE) plus the app's TLS knobs (PG_SSL_CA,
// PG_SSL_REJECT_UNAUTHORIZED). Against Lakebase run it as the identity that
// owns the tables, with a database credential as PGPASSWORD. Example with the
// local dev database:
//
//   node --env-file=.env.local scripts/migrate.mjs status
//
// `down` deletes data (0001 down drops every app table): only for scratch, CI
// or a rollback you have planned. See docs/operations.md §6.4.
import pg from 'pg'
import { migrateDown, migrateUp, migrationStatus } from '../server/db/migrate.js'
import { pgSslOptions } from '../server/db/pool.js'

const USAGE = 'usage: node scripts/migrate.mjs status | up | down --to N'

function parse(argv) {
  const [cmd, ...rest] = argv
  const args = { cmd }
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (a === '--to') args.to = rest[++i]
    else if (a.startsWith('--to=')) args.to = a.slice(5)
    else if (a === '--dir') args.dir = rest[++i]
    else return { error: `unknown argument ${a}` }
  }
  if (!['status', 'up', 'down'].includes(cmd)) return { error: cmd ? `unknown command ${cmd}` : 'no command' }
  if (cmd === 'down' && (args.to === undefined || !/^\d+$/.test(String(args.to)))) {
    return { error: 'down needs --to N (a version >= 0; 0 rolls back everything)' }
  }
  return args
}

const pad = (v) => String(v).padStart(4, '0')
const when = (d) => (d instanceof Date ? d.toISOString() : String(d ?? ''))

async function main() {
  const args = parse(process.argv.slice(2))
  if (args.error) {
    console.error(`${args.error}\n${USAGE}`)
    return 2
  }
  const client = new pg.Client({
    database: process.env.PGDATABASE || 'databricks_postgres',
    ssl: pgSslOptions(),
    connectionTimeoutMillis: 15000,
  })
  await client.connect()
  try {
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
      const r = await migrateUp(client, { dir: args.dir })
      if (!r.applied.length && !r.adopted) console.log('migrations: nothing to apply')
      return 0
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
