// What may never be committed in recorded fixtures: personal or company
// e-mails (only the placeholder domains used by the seeds are allowed),
// personal access tokens and workspace hosts.
const ALLOWED_EMAIL_DOMAINS = new Set(['example.com', 'test.invalid'])
const EMAIL_RE = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g
const CHECKS = [
  [/dapi[0-9a-f]{20,}/i, 'a personal access token'],
  [/[a-z0-9-]+\.cloud\.databricks\.com/i, 'a workspace host'],
  [/[a-z0-9.-]+\.azuredatabricks\.net/i, 'a workspace host'],
  [/[a-z0-9.-]+\.gcp\.databricks\.com/i, 'a workspace host'],
]

/** Problems that make `text` unsafe to commit; [] means it can be written. */
export function publishProblems(text) {
  const problems = []
  for (const [re, what] of CHECKS) if (re.test(text)) problems.push(`contains ${what}`)
  const bad = new Set()
  for (const m of text.matchAll(EMAIL_RE)) if (!ALLOWED_EMAIL_DOMAINS.has(m[1].toLowerCase())) bad.add(m[0])
  for (const e of bad) problems.push(`e-mail outside example.com/test.invalid: ${e}`)
  return problems
}
