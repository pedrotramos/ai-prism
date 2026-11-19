// W2-17: the admin_audit actor hash is keyed (HMAC-SHA256 with the app secret
// APP_AUDIT_HASH_KEY), so a dictionary of e-mails cannot reverse it; without
// the key the legacy unsalted scheme stays and ONE warning is logged at boot.
// The first-admin seed of the deploy (bundle/auto_config.py) is audited by the
// app once migration 0007 exists (server/settingsAudit.test.js covers the
// database side; here the contract between the two files).
//
//   node --test server/auditHash.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as audit from './audit.js'
import { userHash } from './log.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.join(HERE, '..')

// TEST DATA ONLY: a throwaway key, never a deployment secret.
const TEST_KEY = 'w2-17-test-only-audit-hash-key-not-a-secret'
const OTHER_TEST_KEY = 'w2-17-another-test-only-key'

const hmac12 = (key, email) => createHmac('sha256', key).update(email.trim().toLowerCase()).digest('hex').slice(0, 12)

test('AC-1 keyed: the actor hash is h2: + 12 hex of HMAC-SHA256(key, lowercased e-mail)', () => {
  const h = audit.actorHash('Ana.Admin@Example.com', { key: TEST_KEY })
  assert.match(h, /^h2:[0-9a-f]{12}$/)
  assert.equal(h, `h2:${hmac12(TEST_KEY, 'ana.admin@example.com')}`)
  assert.equal(h, audit.actorHash('ana.admin@example.com', { key: TEST_KEY }), 'case-insensitive')
  assert.equal(h, audit.actorHash('  ANA.ADMIN@EXAMPLE.COM ', { key: TEST_KEY }), 'trimmed')
  assert.notEqual(h.slice(3), userHash('ana.admin@example.com'), 'not the unsalted digest')
  assert.notEqual(h, audit.actorHash('ana.admin@example.com', { key: OTHER_TEST_KEY }), 'depends on the key')
  assert.notEqual(h, audit.actorHash('bob@example.com', { key: TEST_KEY }))
  assert.ok(!h.includes('@'))
  // the sweep stays the literal the RLS check (0007, aipr_maint_insert) expects
  assert.equal(audit.actorHash(audit.SYSTEM_ACTOR, { key: TEST_KEY }), 'system')
  assert.equal(audit.actorHash('', { key: TEST_KEY }), 'unknown')
})

test('AC-1 keyed: user targets use the keyed hash, group names are kept', () => {
  assert.equal(audit.principalTarget('Bob@Example.com', 'user', { key: TEST_KEY }), `user:h2:${hmac12(TEST_KEY, 'bob@example.com')}`)
  assert.equal(audit.principalTarget('data-team', 'group', { key: TEST_KEY }), 'group:data-team')
})

test('AC-2 no key: the legacy unsalted scheme (no prefix), equal to the log user_hash', () => {
  assert.equal(audit.actorHash('Ana@Example.com', { key: '' }), userHash('ana@example.com'))
  assert.equal(audit.actorHash('Ana@Example.com', { key: '   ' }), userHash('ana@example.com'), 'a blank key is no key')
  assert.equal(audit.principalTarget('bob@example.com', 'user', { key: '' }), `user:${userHash('bob@example.com')}`)
})

test('bootstrap target candidates cover both schemes, so a key added later does not duplicate the seed row', () => {
  const c = audit.principalTargetCandidates('Dep@Example.com', 'user', { key: TEST_KEY })
  assert.deepEqual(c, [`user:h2:${hmac12(TEST_KEY, 'dep@example.com')}`, `user:${userHash('dep@example.com')}`])
  assert.deepEqual(audit.principalTargetCandidates('Dep@Example.com', 'user', { key: '' }), [`user:${userHash('dep@example.com')}`])
})

// The process reads APP_AUDIT_HASH_KEY once, at boot (module load).
function boot(envKey) {
  const env = { ...process.env }
  delete env.APP_AUDIT_HASH_KEY
  if (envKey !== undefined) env.APP_AUDIT_HASH_KEY = envKey
  const script = `
    const a = await import(${JSON.stringify(path.join(HERE, 'audit.js'))})
    const out = [a.actorHash('Ana@Example.com'), a.actorHash('ana@example.com'), a.principalTarget('Bob@Example.com', 'user')]
    a.warnIfNoAuditHashKey()
    a.warnIfNoAuditHashKey()
    process.stdout.write(JSON.stringify(out))
  `
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  const warnings = r.stderr
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((l) => l.level === 'warn' && l.msg.includes('APP_AUDIT_HASH_KEY'))
  return { out: JSON.parse(r.stdout), warnings, stderr: r.stderr }
}

test('AC-1 env: with APP_AUDIT_HASH_KEY set, the process hashes keyed and logs no warning', () => {
  const { out, warnings, stderr } = boot(TEST_KEY)
  assert.equal(out[0], `h2:${hmac12(TEST_KEY, 'ana@example.com')}`)
  assert.equal(out[0], out[1], 'case-insensitive')
  assert.equal(out[2], `user:h2:${hmac12(TEST_KEY, 'bob@example.com')}`)
  assert.equal(warnings.length, 0)
  assert.ok(!stderr.includes(TEST_KEY), 'the key value is never printed')
})

test('AC-2 env: without the key, legacy hashes and exactly ONE startup warning', () => {
  const { out, warnings } = boot(undefined)
  assert.equal(out[0], userHash('ana@example.com'))
  assert.equal(out[0], out[1])
  assert.equal(warnings.length, 1, 'fires once, at boot, however many hashes are taken')
  assert.equal(boot('').warnings.length, 1, 'an empty value is no key')
})

test('the first-admin seed contract: auto_config writes added_by = BOOTSTRAP_ADDED_BY, never audits with a clear e-mail', () => {
  const py = fs.readFileSync(path.join(REPO, 'bundle', 'auto_config.py'), 'utf8')
  assert.equal(audit.BOOTSTRAP_ADDED_BY, 'auto-config')
  assert.match(py, /INSERT INTO app_admins \(principal, kind, added_by\) VALUES \(%s,'user','auto-config'\)/)
  // the audit row is the app's job (it holds the key and runs after migration 0007)
  assert.doesNotMatch(py, /INSERT INTO\s+(ai_prism\.)?admin_audit/i)
})

test('APP_AUDIT_HASH_KEY is wired from a secret resource, never as a literal value', () => {
  const yaml = fs.readFileSync(path.join(REPO, 'app.yaml'), 'utf8')
  const lines = yaml.split('\n')
  const i = lines.findIndex((l) => /name:\s*APP_AUDIT_HASH_KEY\b/.test(l))
  assert.ok(i >= 0, 'app.yaml names APP_AUDIT_HASH_KEY')
  assert.match(lines[i + 1], /valueFrom:\s*'audit-hash-key'/)
  assert.doesNotMatch(yaml, /APP_AUDIT_HASH_KEY\s*\n\s*#?\s*value:/)
  const example = path.join(REPO, 'bundle', 'optional', 'audit-hash-key-secret.yml.example')
  assert.match(fs.readFileSync(example, 'utf8'), /- name: audit-hash-key\s*\n\s*secret:/)
})
