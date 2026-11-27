// QA RED: T2 contract edge cases found during review.
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildEnforcedCsp } from './securityHeaders.ts'
import { summarizeCspReports } from './middleware/security.ts'

test('only the exact CSP_EGRESS=report literal relaxes enforcement', () => {
  for (const value of [' Report ', 'REPORT', 'reporting']) {
    assert.match(buildEnforcedCsp({ CSP_EGRESS: value }), /\bimg-src\b/, JSON.stringify(value))
  }
  assert.doesNotMatch(buildEnforcedCsp({ CSP_EGRESS: 'report' }), /\bimg-src\b/)
})

test('CSP report summaries omit URL paths and queries', () => {
  const summaries = summarizeCspReports({
    'csp-report': {
      'document-uri': 'https://app.example/private/session-42?secret=synthetic',
      'effective-directive': 'img-src',
      'blocked-uri': 'https://attacker.example/pixel?secret=synthetic',
      disposition: 'enforce',
    },
  })
  assert.doesNotMatch(JSON.stringify(summaries), /private|session-42|\?secret=/)
})
