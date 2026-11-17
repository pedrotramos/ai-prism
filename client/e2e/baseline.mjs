// The e2e/a11y regression bar: numbers from the 16 axe runs (4 screens × 2
// themes × 2 widths), the touch-target scan, Lighthouse accessibility scores
// and the one-off style audit, compared with client/e2e/baseline.json.
//
// Rule: no count may rise (per axe rule, serious/critical total, small
// targets, unnamed elements, one-off styles) and no Lighthouse score may drop (a ratchet; record
// improvements with E2E_UPDATE_BASELINE=1). E2E_STRICT=1 additionally fails on
// any serious/critical axe node — the switch for when the UX waves land.
import { readFileSync, writeFileSync } from 'node:fs'

export const BASELINE_URL = new URL('./baseline.json', import.meta.url)
const SEVERE = new Set(['serious', 'critical'])

export function aggregateRuns(runs) {
  const axe = {}
  let seriousCritical = 0
  let touchUnder24 = 0
  let unnamed = 0
  for (const r of runs) {
    for (const v of r.axe) {
      axe[v.id] = (axe[v.id] || 0) + v.nodes
      if (SEVERE.has(v.impact)) seriousCritical += v.nodes
    }
    touchUnder24 += r.touch.under24
    unnamed += r.touch.noName
  }
  const sorted = Object.fromEntries(Object.keys(axe).sort().map((k) => [k, axe[k]]))
  return { axe: sorted, seriousCritical, touchUnder24, unnamed }
}

export function compareToBaseline(current, baseline) {
  const regressions = []
  const improvements = []
  const lower = (label, cur, base) => {
    if (cur > base) regressions.push(`${label}: ${cur} > ${base}`)
    else if (cur < base) improvements.push(`${label}: ${cur} < ${base}`)
  }
  const rules = new Set([...Object.keys(baseline.axe || {}), ...Object.keys(current.axe || {})])
  for (const rule of [...rules].sort()) lower(`axe ${rule}`, current.axe[rule] || 0, baseline.axe?.[rule] || 0)
  // per-rule counts can hold while severity shifts (e.g. a moderate node turns
  // critical), so the serious/critical total is ratcheted on its own
  lower('axe serious/critical nodes', current.seriousCritical, baseline.seriousCritical)
  lower('touch targets < 24 px', current.touchUnder24, baseline.touchUnder24)
  lower('unnamed interactive elements', current.unnamed, baseline.unnamed)
  for (const [page, base] of Object.entries(baseline.lighthouse || {})) {
    const cur = current.lighthouse?.[page]
    if (cur == null) regressions.push(`lighthouse ${page}: no score`)
    else if (cur < base) regressions.push(`lighthouse ${page}: ${cur} < ${base}`)
    else if (cur > base) improvements.push(`lighthouse ${page}: ${cur} > ${base}`)
  }
  lower('one-off styles', current.oneOff.total, baseline.oneOff.total)
  for (const [kind, base] of Object.entries(baseline.oneOff.byKind || {})) lower(`one-off ${kind}`, current.oneOff.byKind?.[kind] || 0, base)
  return { regressions, improvements }
}

export function strictFailures(current) {
  return current.seriousCritical ? [`${current.seriousCritical} serious/critical axe nodes (E2E_STRICT=1 requires 0)`] : []
}

export function baselineFor(file, platform) {
  const b = file.platforms?.[platform]
  if (!b) {
    throw new Error(
      `no e2e baseline for platform "${platform}" in client/e2e/baseline.json. Record it from a run of the base branch with E2E_UPDATE_BASELINE=1 npm run test:e2e`
    )
  }
  return b
}

export const readBaselineFile = () => JSON.parse(readFileSync(BASELINE_URL, 'utf8'))

export function writeBaseline(platform, metrics, note) {
  let file
  try {
    file = readBaselineFile()
  } catch {
    file = { platforms: {} }
  }
  file.platforms ||= {}
  file.platforms[platform] = { recordedAt: new Date().toISOString().slice(0, 10), note, ...metrics }
  writeFileSync(BASELINE_URL, JSON.stringify(file, null, 2) + '\n')
}
