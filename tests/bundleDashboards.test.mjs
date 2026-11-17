// The bundle ships every dashboard in dashboards/ and each one is a well-formed
// Lakeview export. `databricks bundle validate` checks that the resource is
// declared and the file exists, but not what is inside the JSON: a widget that
// points at a dataset that does not exist only shows up as a broken tile after a
// deploy. This test catches that offline.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BUNDLE = readFileSync(path.join(ROOT, 'databricks.yml'), 'utf8')

/** `dashboards:` resources in databricks.yml → { key: { file_path, warehouse_id } }. */
function bundleDashboards(yml) {
  const out = {}
  const block = yml.match(/^ {2}dashboards:\n((?: {4,}.*\n|\s*\n)+)/m)
  if (!block) return out
  let key = null
  for (const line of block[1].split('\n')) {
    const k = line.match(/^ {4}(\w+):\s*$/)
    if (k) {
      key = k[1]
      out[key] = {}
      continue
    }
    const f = line.match(/^ {6}(file_path|warehouse_id|display_name):\s*(.+?)\s*$/)
    if (key && f) out[key][f[1]] = f[2].replace(/^"|"$/g, '')
  }
  return out
}

const declared = bundleDashboards(BUNDLE)
const files = readdirSync(path.join(ROOT, 'dashboards')).filter((f) => f.endsWith('.lvdash.json'))

test('every dashboard file in dashboards/ is declared in databricks.yml', () => {
  const declaredFiles = Object.values(declared).map((d) => path.basename(d.file_path || ''))
  assert.deepEqual(declaredFiles.sort(), files.sort())
})

test('the operations dashboard is declared next to the cost dashboard', () => {
  assert.equal(declared.ai_prism_costs?.file_path, './dashboards/ai-costs.lvdash.json')
  assert.equal(declared.ai_prism_ops?.file_path, './dashboards/ai-ops.lvdash.json')
})

test('both dashboards run on the bundle warehouse and have distinct names', () => {
  for (const [key, d] of Object.entries(declared)) {
    assert.equal(d.warehouse_id, '${resources.sql_warehouses.ai_prism_wh.id}', key)
    assert.ok(d.display_name, `${key} needs a display_name`)
  }
  const names = Object.values(declared).map((d) => d.display_name)
  assert.equal(new Set(names).size, names.length)
})

for (const file of files) {
  test(`${file}: every widget query reads a dataset that exists`, () => {
    const dash = JSON.parse(readFileSync(path.join(ROOT, 'dashboards', file), 'utf8'))
    const datasets = new Set(dash.datasets.map((d) => d.name))
    assert.ok(datasets.size > 0)
    for (const d of dash.datasets) assert.ok(d.queryLines?.join('').trim(), `${d.name} has no SQL`)
    const refs = []
    for (const page of dash.pages) {
      for (const item of page.layout || []) {
        for (const q of item.widget?.queries || []) refs.push(q.query?.datasetName)
      }
    }
    assert.ok(refs.length > 0, 'no widget reads any dataset')
    for (const ref of refs) assert.ok(datasets.has(ref), `widget reads unknown dataset ${ref}`)
  })

  test(`${file}: every query is scoped to AI Prism traffic`, () => {
    const dash = JSON.parse(readFileSync(path.join(ROOT, 'dashboards', file), 'utf8'))
    for (const d of dash.datasets) {
      const sql = d.queryLines.join('')
      if (/system\.serving\.endpoint_usage/.test(sql)) {
        assert.match(sql, /usage_context\['application'\]\s*=\s*'ai-prism'/, `${d.name} reads every app's traffic`)
      }
    }
  })
}

