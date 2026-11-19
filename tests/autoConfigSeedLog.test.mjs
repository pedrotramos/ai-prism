import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('auto-config does not print the bootstrap admin email', () => {
  const source = fs.readFileSync(path.join(REPO, 'bundle/auto_config.py'), 'utf8')
  const leakLines = source
    .split('\n')
    .map((line, index) => (/\bprint\s*\(/.test(line) && /\bdeployer_email\b/.test(line) ? index + 1 : null))
    .filter((line) => line !== null)
  assert.deepEqual(leakLines, [], `bootstrap email is interpolated into job logs at lines: ${leakLines.join(', ')}`)
})
