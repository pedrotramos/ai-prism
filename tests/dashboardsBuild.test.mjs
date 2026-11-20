// dashboards/build.py generates ai-telemetry.lvdash.json for one catalog.schema (AC2), and
// databricks.yml declares the telemetry alerts over the same tables (AC4 offline half).
// `databricks bundle validate` cannot see inside a dashboard or an alert query: a widget on a
// missing dataset or an alert reading a column the query does not select only shows after a
// deploy as a broken tile or an alert that never fires. These checks catch that offline.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BUILD = path.join(ROOT, 'dashboards', 'build.py')
const FILE = path.join(ROOT, 'dashboards', 'ai-telemetry.lvdash.json')
const bundle = yaml.load(readFileSync(path.join(ROOT, 'databricks.yml'), 'utf8'))

function py(args) {
  return spawnSync('python3', ['-I', BUILD, ...args], { encoding: 'utf8' })
}
function generate(args) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dash-build-'))
  const out = path.join(dir, 'out.json')
  const r = py([...args, '--out', out])
  const text = r.status === 0 ? readFileSync(out, 'utf8') : ''
  rmSync(dir, { recursive: true, force: true })
  return { r, text }
}
const dash = JSON.parse(readFileSync(FILE, 'utf8'))
const widgets = dash.pages.flatMap((p) => p.layout.map((l) => ({ page: p, ...l })))
const sqlOf = (ds) => ds.queryLines.join('')

test('AC2: the committed dashboard JSON is exactly what build.py generates', () => {
  const r = py(['--check'])
  assert.equal(r.status, 0, r.stderr)
})

test('AC2: generation is deterministic and ends with a newline', () => {
  const a = generate([])
  const b = generate([])
  assert.equal(a.r.status, 0, a.r.stderr)
  assert.equal(a.text, b.text)
  assert.ok(a.text.endsWith('}\n'))
})

test('the schema is a build argument: every dataset reads the chosen otel_spans and nothing else', () => {
  const { r, text } = generate(['--catalog', 'my_cat', '--schema', 'my_sch'])
  assert.equal(r.status, 0, r.stderr)
  const d = JSON.parse(text)
  for (const ds of d.datasets) {
    const sql = sqlOf(ds)
    assert.match(sql, /my_cat\.my_sch\.otel_spans/, ds.name)
    assert.doesNotMatch(sql, /ai_prism\.telemetry/, ds.name)
  }
})

test('catalog and schema must be plain identifiers (they are interpolated into SQL)', () => {
  for (const args of [['--catalog', 'a;drop table x'], ['--schema', 'a.b'], ['--schema', "x'y"]]) {
    const r = py(args)
    assert.notEqual(r.status, 0, args.join(' '))
  }
})

test('the default schema equals the bundle variable defaults (one source of truth for the docs)', () => {
  const sql = sqlOf(dash.datasets[0])
  const cat = bundle.variables.telemetry_catalog.default
  const sch = bundle.variables.telemetry_schema.default
  assert.match(sql, new RegExp(`${cat}\\.${sch}\\.otel_spans`))
})

test('every widget reads a dataset that exists and fields that the dataset selects', () => {
  const byName = Object.fromEntries(dash.datasets.map((d) => [d.name, d]))
  for (const { widget } of widgets) {
    for (const q of widget.queries || []) {
      const ds = byName[q.query.datasetName]
      assert.ok(ds, `${widget.name}: dataset ${q.query.datasetName}`)
      const sql = sqlOf(ds)
      const cols = new Set([...sql.matchAll(/\bAS (\w+)/g)].map((m) => m[1]))
      for (const m of sql.matchAll(/^\s*(?:\w+\.)?(\w+),?\s*$/gm)) cols.add(m[1])
      for (const f of q.query.fields) {
        for (const c of f.expression.matchAll(/`(\w+)`/g)) assert.ok(cols.has(c[1]), `${widget.name}: column ${c[1]} not selected by ${ds.name}`)
      }
    }
  }
})

test('encodings reference the fields the widget query declares (a mismatch renders "no selected fields")', () => {
  for (const { widget } of widgets) {
    const spec = widget.spec
    if (!spec) continue
    const declared = new Set((widget.queries || []).flatMap((q) => q.query.fields.map((f) => f.name)))
    const refs = []
    const enc = spec.encodings || {}
    for (const [k, v] of Object.entries(enc)) {
      if (k === 'columns' || k === 'fields') for (const c of v) refs.push(c.fieldName)
      else if (v && v.fieldName) refs.push(v.fieldName)
    }
    for (const r of refs) assert.ok(declared.has(r), `${widget.name}: ${r}`)
  }
})

test('no draft widgets: widget versions, no counter trend/color keys, filters framed, stacked bars long-format', () => {
  const versions = { counter: 2, table: 2, bar: 3, 'filter-date-range-picker': 2, 'filter-single-select': 2 }
  for (const { widget } of widgets) {
    const spec = widget.spec
    if (!spec) continue
    assert.equal(spec.version, versions[spec.widgetType], `${widget.name} (${spec.widgetType})`)
    assert.match(widget.name, /^[A-Za-z0-9_-]+$/)
    if (spec.widgetType === 'counter') {
      assert.equal('trend' in spec.encodings, false, `${widget.name}: a trend key makes a draft widget`)
      assert.equal('color' in spec.encodings.value, false, `${widget.name}: counters take no color`)
    }
    if (spec.widgetType.startsWith('filter')) assert.equal(spec.frame?.showTitle, true, widget.name)
    if (spec.widgetType === 'bar' && spec.encodings.color) {
      // long format: the series column is a dimension of the dataset, not a measure per series
      const ds = dash.datasets.find((d) => d.name === widget.queries[0].query.datasetName)
      assert.match(sqlOf(ds), new RegExp(`AS ${spec.encodings.color.fieldName}\\b`), widget.name)
    }
  }
  assert.doesNotMatch(JSON.stringify(dash), /associative_filter_predicate_group/)
})

test('layout: GRID_V1, widgets inside 12 columns, no overlap on a page', () => {
  for (const p of dash.pages) {
    assert.equal(p.layoutVersion, 'GRID_V1')
    assert.equal(p.pageType, 'PAGE_TYPE_CANVAS')
    const cells = new Set()
    for (const { position: s } of p.layout) {
      assert.ok(s.x >= 0 && s.x + s.width <= 12, `${p.name}: ${JSON.stringify(s)}`)
      for (let x = s.x; x < s.x + s.width; x++)
        for (let y = s.y; y < s.y + s.height; y++) {
          assert.ok(!cells.has(`${x},${y}`), `${p.name}: overlap at ${x},${y}`)
          cells.add(`${x},${y}`)
        }
    }
  }
})

test('the trace page of the failures tab: failing rows expose trace_id and the trace table filters by it', () => {
  const ids = widgets.map((w) => w.widget.name)
  for (const n of ['tbl_tel_failures', 'flt_tel_trace', 'tbl_tel_trace']) assert.ok(ids.includes(n), n)
  const flt = widgets.find((w) => w.widget.name === 'flt_tel_trace').widget
  assert.equal(flt.queries[0].query.datasetName, 'tel_trace')
  assert.equal(flt.spec.encodings.fields[0].fieldName, 'trace_id')
})

test('AC4: the telemetry dashboard and alerts are declared in the bundle on the bundle warehouse', () => {
  assert.equal(bundle.resources.dashboards.ai_prism_telemetry.file_path, './dashboards/ai-telemetry.lvdash.json')
  assert.equal(bundle.resources.dashboards.ai_prism_telemetry.warehouse_id, '${resources.sql_warehouses.ai_prism_wh.id}')
  for (const k of ['ai_prism_a2_http_errors', 'ai_prism_a7_turn_errors']) assert.ok(bundle.resources.alerts[k], k)
})

test('alerts: created paused by default, no "/" in the name, query selects the evaluated column, tables come from the variables', () => {
  assert.equal(bundle.variables.telemetry_alerts_pause.default, 'PAUSED')
  for (const [k, a] of Object.entries(bundle.resources.alerts)) {
    assert.ok(!a.display_name.includes('/'), `${k}: workspace items cannot contain "/"`)
    assert.equal(a.schedule.pause_status, '${var.telemetry_alerts_pause}', k)
    assert.match(a.query_text, new RegExp(`AS ${a.evaluation.source.name}\\b`), `${k}: evaluates a column the query does not select`)
    assert.match(a.query_text, /\$\{var\.telemetry_catalog\}\.\$\{var\.telemetry_schema\}\.otel_spans/, k)
    assert.match(a.query_text, /AS last_failing_trace_id/, `${k}: the alert must hand over the failing trace id`)
    assert.equal(a.warehouse_id, '${resources.sql_warehouses.ai_prism_wh.id}')
    assert.equal(typeof a.evaluation.threshold.value.double_value, 'number')
    assert.match(a.custom_description, /ai_prism_telemetry\.url/, `${k}: links the dashboard`)
  }
})

test('A2 can fire: it counts 5xx/302/401 server spans on /api and has a volume guard that the threshold can cross', () => {
  const a = bundle.resources.alerts.ai_prism_a2_http_errors
  assert.match(a.query_text, /kind = 'SPAN_KIND_SERVER'/)
  assert.match(a.query_text, /http\.status_code/)
  assert.match(a.query_text, /status >= 500 OR status IN \(302, 401\)/)
  assert.match(a.query_text, /INTERVAL 10 MINUTES/)
  assert.equal(a.evaluation.comparison_operator, 'GREATER_THAN')
  assert.equal(a.evaluation.threshold.value.double_value, 5)
  const guard = Number(a.query_text.match(/COUNT\(\*\) >= (\d+)/)?.[1])
  assert.ok(guard >= 1 && guard <= 20, `volume guard ${guard}`)
  // 1 failure out of `guard` requests is already above 5%: the guard never hides a real incident
  assert.ok(100 / guard > a.evaluation.threshold.value.double_value)
})
