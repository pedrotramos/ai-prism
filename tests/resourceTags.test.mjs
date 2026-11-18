// Testes de server/resourceTags.js (tags de recurso). Rode com:
//   node --test tests/resourceTags.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  APP_TAG_KEY,
  USAGE_APPLICATION,
  mergeResourceTags,
  getResourceTags,
  resetResourceTagsCache,
  usageContext,
  queryTagsFor,
  isValidTagKey,
  isValidTagValue,
} from '../server/resourceTags.js'
import { setLogWriter } from '../server/log.js'

// o log é silenciado nestes testes: os avisos são afirmados pelo retorno de
// mergeResourceTags / pelos efeitos, não pela saída do log.
function quiet(fn) {
  const prev = setLogWriter(() => {})
  try {
    return fn()
  } finally {
    setLogWriter(prev)
  }
}

test('a tag embutida ai_prism_app é sempre a última e vem com o nome do app', () => {
  const { tags, warnings } = mergeResourceTags({ area: 'Finanças' }, 'ai-prism')
  assert.deepEqual(Object.keys(tags), ['area', APP_TAG_KEY])
  assert.equal(tags[APP_TAG_KEY], 'ai-prism')
  assert.deepEqual(warnings, [])
})

test('sem tags do operador, só a embutida', () => {
  const { tags } = mergeResourceTags(undefined, 'ai-prism')
  assert.deepEqual(tags, { [APP_TAG_KEY]: 'ai-prism' })
})

test('tentar sobrescrever ai_prism_app com outro valor gera aviso e é ignorado', () => {
  const { tags, warnings } = mergeResourceTags({ ai_prism_app: 'outro' }, 'ai-prism')
  assert.equal(tags[APP_TAG_KEY], 'ai-prism')
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /reservada/)
})

test('repetir ai_prism_app com o próprio valor não gera aviso (é o mecanismo normal do deploy)', () => {
  const { tags, warnings } = mergeResourceTags({ ai_prism_app: 'ai-prism' }, 'ai-prism')
  assert.equal(tags[APP_TAG_KEY], 'ai-prism')
  assert.deepEqual(warnings, [])
})

test('a reservada vale sem diferenciar maiúsculas/minúsculas (Windows trata as chaves assim)', () => {
  for (const key of ['AI_PRISM_APP', 'Ai_Prism_App', 'Application', 'APPLICATION']) {
    const { tags, warnings } = mergeResourceTags({ [key]: 'x' }, 'ai-prism')
    assert.equal(Object.hasOwn(tags, key), false, key)
    assert.equal(tags[APP_TAG_KEY], 'ai-prism')
    assert.equal(warnings.length, 1, key)
  }
})

test('application é reservada: o operador não pode trocar o escopo do custo (ai-prism)', () => {
  const { tags, warnings } = mergeResourceTags({ application: 'outro' }, 'ai-prism')
  assert.equal(Object.hasOwn(tags, 'application'), false)
  assert.equal(warnings.length, 1)
})

test('chave ou valor com caracteres fora do conjunto são descartados com aviso', () => {
  const { tags, warnings } = mergeResourceTags(
    { 'bad"key': 'ok', good: 'bad"value', 'x;y': 'z' },
    'ai-prism'
  )
  assert.deepEqual(Object.keys(tags), [APP_TAG_KEY])
  assert.equal(warnings.length, 3)
})

test('duplicata que só difere pela caixa fica com a primeira', () => {
  const { tags, warnings } = mergeResourceTags({ Area: 'a', area: 'b' }, 'ai-prism')
  assert.equal(tags.Area, 'a')
  assert.equal(Object.hasOwn(tags, 'area'), false)
  assert.equal(warnings.length, 1)
})

test('no máximo 24 tags de operador; as seguintes são ignoradas (a embutida fica)', () => {
  const raw = {}
  for (let i = 0; i < 30; i++) raw[`k${i}`] = `v${i}`
  const { tags, warnings } = mergeResourceTags(raw, 'ai-prism')
  const operator = Object.keys(tags).filter((k) => k !== APP_TAG_KEY)
  assert.equal(operator.length, 24)
  assert.equal(tags[APP_TAG_KEY], 'ai-prism')
  assert.equal(warnings.length, 1)
})

test('valor vazio é aceito; null vira vazio', () => {
  const { tags, warnings } = mergeResourceTags({ vazio: '', nulo: null }, 'ai-prism')
  assert.equal(tags.vazio, '')
  assert.equal(tags.nulo, '')
  assert.deepEqual(warnings, [])
})

test('conjunto de caracteres: Unicode letra/número, _ + - = . : / @ e espaço', () => {
  const ok = ['área', 'Finanças', 'cost_center', 'a+b=c', 'x.y:z/w@v', 'nº 2', 'x²', '1 2 3']
  for (const s of ok) assert.equal(isValidTagKey(s), true, s)
  const bad = ['', 'a"b', "a'b", 'a;b', 'a,b', 'a\nb', 'a\\b', 'a(b)', 'x'.repeat(256), 'é']
  for (const s of bad) assert.equal(isValidTagKey(s), false, JSON.stringify(s))
  assert.equal(isValidTagValue(''), true)
  assert.equal(isValidTagValue('x'.repeat(255)), true)
  assert.equal(isValidTagValue('x'.repeat(256)), false)
})

test('getResourceTags lê AI_PRISM_RESOURCE_TAGS e usa DATABRICKS_APP_NAME', () => {
  resetResourceTagsCache()
  const env = {
    DATABRICKS_APP_NAME: 'ai-prism-teste',
    AI_PRISM_RESOURCE_TAGS: JSON.stringify({ cost_center: '1234' }),
  }
  const tags = quiet(() => getResourceTags(env))
  assert.deepEqual(tags, { cost_center: '1234', [APP_TAG_KEY]: 'ai-prism-teste' })
  resetResourceTagsCache()
})

test('JSON inválido ou não-objeto em AI_PRISM_RESOURCE_TAGS deixa só a embutida', () => {
  for (const raw of ['{nao json', '["a"]', '"texto"', 'null']) {
    resetResourceTagsCache()
    const tags = quiet(() => getResourceTags({ AI_PRISM_RESOURCE_TAGS: raw }))
    assert.deepEqual(tags, { [APP_TAG_KEY]: 'ai-prism' }, raw)
  }
  resetResourceTagsCache()
})

test('usageContext: tags de recurso + application=ai-prism, que o operador não consegue trocar', () => {
  resetResourceTagsCache()
  const env = {
    AI_PRISM_RESOURCE_TAGS: JSON.stringify({ area: 'Finanças', application: 'hack', ai_prism_app: 'x' }),
  }
  const ctx = quiet(() => usageContext(env))
  assert.equal(ctx.application, USAGE_APPLICATION)
  assert.equal(USAGE_APPLICATION, 'ai-prism')
  assert.equal(ctx.area, 'Finanças')
  assert.equal(ctx[APP_TAG_KEY], 'ai-prism')
  assert.equal(Object.values(ctx).includes('hack'), false)
  resetResourceTagsCache()
})

test('queryTagsFor: array {key,value} com a embutida sempre dentro do limite de 20', () => {
  resetResourceTagsCache()
  const raw = {}
  for (let i = 0; i < 24; i++) raw[`k${String(i).padStart(2, '0')}`] = `v${i}`
  const list = quiet(() => queryTagsFor({ AI_PRISM_RESOURCE_TAGS: JSON.stringify(raw), DATABRICKS_APP_NAME: 'ai-prism' }))
  assert.equal(list.length, 20)
  assert.deepEqual(list[0], { key: APP_TAG_KEY, value: 'ai-prism' })
  assert.ok(list.every((t) => typeof t.key === 'string' && typeof t.value === 'string'))
  resetResourceTagsCache()
})

test('queryTagsFor sem tags do operador: só a embutida', () => {
  resetResourceTagsCache()
  const list = queryTagsFor({})
  assert.deepEqual(list, [{ key: APP_TAG_KEY, value: 'ai-prism' }])
  resetResourceTagsCache()
})
