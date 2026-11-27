// W3-3: the Preferences intro must not promise per-project defaults (deferred, Q10-B).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import en from './en/settings.ts'
import pt from './pt/settings.ts'
import es from './es/settings.ts'

const PROJECT_WORD = { en: /project/i, pt: /projeto/i, es: /proyecto/i }

for (const [lang, catalog] of Object.entries({ en, pt, es })) {
  test(`personal.intro (${lang}) applies to all chats and does not mention projects`, () => {
    const intro = (catalog as Record<string, string>)['personal.intro']
    assert.ok(intro && intro.length > 10)
    assert.doesNotMatch(intro, PROJECT_WORD[lang as keyof typeof PROJECT_WORD])
    assert.equal(intro.split(/[.!?]\s/).filter(Boolean).length, 1, 'a single sentence')
  })
}
