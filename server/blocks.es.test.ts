// Spanish artifact vocabulary: a Spanish deck / sheet / document / image request must reach the
// intent classifier (shouldClassifyIntent) and light the right regex capability (detectCapabilities),
// with and without accents. Held-out items #132-#134 were silently skipped by the gate before.
//
//   node --test server/blocks.es.test.ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { shouldClassifyIntent, detectCapabilities, hasDataIntent } from './blocks.ts'

const held = readFileSync(new URL('./__fixtures__/intentRouter/heldout-eval-set.jsonl', import.meta.url), 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l)) as { id: number; text: string; required: string[] }[]
const item = (id: number) => held.find((i) => i.id === id)!

for (const id of [132, 133, 134]) {
  test(`held-out #${id}: the gate lets the Spanish request reach the classifier`, () => {
    assert.equal(shouldClassifyIntent(item(id).text, [], {}), true)
  })
}

test('held-out #132: presentación + nuestras ventas + base de datos -> deck and data by regex', () => {
  const t = item(132).text
  assert.equal(detectCapabilities(t, [], {}).deck, true)
  assert.equal(hasDataIntent(t), true)
})
test('held-out #133 and #134: carta -> document, hoja de cálculo -> spreadsheet by regex', () => {
  assert.equal(detectCapabilities(item(133).text, [], {}).document, true)
  assert.equal(detectCapabilities(item(134).text, [], {}).spreadsheet, true)
})

const CASES: [string, 'deck' | 'document' | 'spreadsheet' | 'image'][] = [
  ['Crea una presentación sobre la estrategia de 2027', 'deck'],
  ['Crea una presentacion sobre la estrategia de 2027', 'deck'],
  ['Hazme unas diapositivas para el comité', 'deck'],
  ['Prepara una hoja de cálculo con el presupuesto del equipo', 'spreadsheet'],
  ['Prepara una hoja de calculo con el presupuesto del equipo', 'spreadsheet'],
  ['Redacta un informe sobre el churn del trimestre', 'document'],
  ['Escribe una carta de renuncia', 'document'],
  ['Redacta un documento con la política de viajes', 'document'],
  ['Genera una imagen de un faro al amanecer', 'image'],
  ['Crea un logotipo para mi cafetería', 'image'],
  ['Dibuja una ilustración de un gato astronauta', 'image'],
]
for (const [text, cap] of CASES) {
  test(`es: "${text}" reaches the classifier and lights ${cap}`, () => {
    assert.equal(shouldClassifyIntent(text, [], {}), true)
    assert.equal(detectCapabilities(text, [], {})[cap], true)
  })
}

test('es: plain chat still skips the classifier and lights nothing', () => {
  for (const t of ['¿Cuál es la capital de Francia?', 'Gracias, muy amable', 'Explícame cómo funciona el sistema solar']) {
    assert.equal(shouldClassifyIntent(t, [], {}), false, t)
    const c = detectCapabilities(t, [], {})
    assert.deepEqual([c.deck, c.document, c.spreadsheet, c.image], [false, false, false, false], t)
  }
})

test('es: a general explanation about data is plain chat and skips the classifier', () => {
  const t = 'Explícame cómo se almacenan los datos en una base relacional.'
  assert.equal(hasDataIntent(t), false)
  assert.equal(shouldClassifyIntent(t, [], {}), false)
})

test('es: the Spanish data nouns never open the gate alone, but still mark data once a request is present', () => {
  for (const t of ['¿Qué son los datos?', 'Háblame de las ventas en general', 'Los ingresos son importantes']) {
    assert.equal(shouldClassifyIntent(t, [], {}), false, t)
  }
  assert.equal(hasDataIntent('Analiza nuestras ventas por país'), true)
  assert.equal(hasDataIntent('Saca los datos de la empresa de 2026'), true)
})
