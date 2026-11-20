// Tags de recurso: o operador passa pares chave=valor no deploy (variável de
// bundle `resource_tags`, `--tag`/`TAGS` no deploy.sh/deploy.ps1, ou o campo
// do notebook instalador) para marcar tudo que o app cria e, via
// usage_context/query_tags, o que ele consome. O runtime só vê o resultado já
// mesclado: a env AI_PRISM_RESOURCE_TAGS (JSON), escrita no app.yaml pelo
// deploy — ver docs/tags.md para a tabela completa recurso → mecanismo.
//
// A tag embutida (APP_TAG_KEY) é sempre adicionada por último, então uma
// tentativa do operador de sobrescrevê-la é ignorada (ver mergeResourceTags).

import { logger } from './log.ts'

type Env = Record<string, string | undefined>

export const APP_TAG_KEY = 'ai_prism_app'
// Valor do campo `application` do usage_context desde a primeira versão: as
// linhas de system.serving.endpoint_usage de AI Prism continuam com
// application='ai-prism' (o dashboard de custos filtra por ele).
export const USAGE_APPLICATION = 'ai-prism'
const DEFAULT_APP_NAME = 'ai-prism'
const MAX_OPERATOR_TAGS = 24
// Statement Execution API: no máximo 20 query_tags por statement.
const QUERY_TAGS_LIMIT = 20

// Chaves que o runtime usa para a própria atribuição de custo. Se o operador
// passar uma delas, ela venceria o valor real e colapsaria o breakdown.
const RESERVED_TAG_KEYS = new Set([APP_TAG_KEY, 'application'])

// Regras de tag do Databricks (cluster/job/UC tags): chave e valor de 1 a 255
// caracteres, só letras/números/espaço e + - = . _ : / @ (sem aspas — o que
// também deixa seguro embutir o JSON resultante dentro de uma string YAML de
// aspas simples em app.yaml).
//
// Unicode (\p{L}/\p{N}), não \w puro: o \w do JS é ASCII-only, enquanto o \w
// do Python (deploy.sh, o notebook instalador, bundle/auto_config.py) e a
// classe equivalente do PowerShell (deploy.ps1) já aceitam Unicode. As
// implementações precisam aceitar exatamente o mesmo conjunto (ver
// tests/resourceTags.test.mjs).
const TAG_RE = /^[\p{L}\p{N}_+\-=.:/@ ]{1,255}$/u

export function isValidTagKey(key: unknown): boolean {
  return typeof key === 'string' && key.length > 0 && TAG_RE.test(key)
}

export function isValidTagValue(value: unknown): boolean {
  return typeof value === 'string' && (value === '' || TAG_RE.test(value))
}

/**
 * Valida e mescla tags soltas (chave -> valor) com a tag embutida ai_prism_app.
 * Tags inválidas são reportadas em `warnings` (nunca lançam); uma tentativa de
 * sobrescrever a tag embutida também gera um warning e é ignorada. Retorna
 * { tags, warnings }, onde `tags` sempre contém a tag embutida por último.
 */
export function mergeResourceTags(
  rawTags: Record<string, unknown> | null | undefined,
  appName: unknown = DEFAULT_APP_NAME,
  { maxTags = MAX_OPERATOR_TAGS }: { maxTags?: number } = {}
): { tags: Record<string, string>; warnings: string[] } {
  const warnings: string[] = []
  const tags: Record<string, string> = {}
  const seenLower = new Set<string>()
  const name = (typeof appName === 'string' && appName.trim()) || DEFAULT_APP_NAME
  for (const [k, v] of Object.entries(rawTags || {})) {
    // Comparação por minúsculas, não só igualdade exata: o PowerShell trata
    // hashtable keys sem diferenciar maiúsculas/minúsculas, então "Area=x" e
    // "area=y" colidiriam lá. Vale para reservadas e para duplicatas.
    const lower = k.toLowerCase()
    const sv = v == null ? '' : String(v)
    if (lower === APP_TAG_KEY) {
      // O deploy SEMPRE escreve ai_prism_app=<nome do app> dentro de
      // AI_PRISM_RESOURCE_TAGS — isso é o mecanismo normal, não uma tentativa
      // de override. Só avisa quando o valor difere do que seria reimposto.
      if (sv !== name) {
        warnings.push(`a tag ${JSON.stringify(k)} é reservada (usada internamente pelo app) e não pode ser sobrescrita; valor informado ignorado`)
      }
      continue
    }
    if (RESERVED_TAG_KEYS.has(lower)) {
      warnings.push(`a tag ${JSON.stringify(k)} é reservada (usada internamente pelo app) e não pode ser sobrescrita; valor informado ignorado`)
      continue
    }
    if (!isValidTagKey(k)) {
      warnings.push(`chave de tag inválida ${JSON.stringify(k)}: use só letras, números, espaço e + - = . : / @ (até 255 caracteres)`)
      continue
    }
    if (!isValidTagValue(sv)) {
      warnings.push(`valor de tag inválido para ${JSON.stringify(k)} (${JSON.stringify(sv)}): use só letras, números, espaço e + - = . : / @ (até 255 caracteres)`)
      continue
    }
    if (seenLower.has(lower)) {
      warnings.push(`chave de tag ${JSON.stringify(k)} difere de outra tag já aceita só pela caixa (maiúsculas/minúsculas); o PowerShell trata as duas como a mesma chave — mantendo só a primeira`)
      continue
    }
    if (Object.keys(tags).length >= maxTags) {
      warnings.push(`mais de ${maxTags} tags de operador: ${JSON.stringify(k)} e as seguintes foram ignoradas`)
      break
    }
    tags[k] = sv
    seenLower.add(lower)
  }
  tags[APP_TAG_KEY] = name
  return { tags, warnings }
}

function parseEnvJson(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {}
  let obj
  try {
    obj = JSON.parse(raw)
  } catch {
    logger.warn('AI_PRISM_RESOURCE_TAGS: JSON inválido, ignorando tags do operador.')
    return {}
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    logger.warn('AI_PRISM_RESOURCE_TAGS: esperava um objeto {chave: valor}, ignorando tags do operador.')
    return {}
  }
  return obj
}

let cache: { env: Env; tags: Record<string, string> } | null = null

/**
 * Tags de recurso resolvidas para este processo: o conteúdo de
 * AI_PRISM_RESOURCE_TAGS (validado de novo — a env pode ter sido editada à mão)
 * mais a tag embutida ai_prism_app, sempre presente. Cacheado por processo;
 * use resetResourceTagsCache() nos testes.
 */
export function getResourceTags(env: Env = process.env): Record<string, string> {
  if (cache && cache.env === env) return cache.tags
  const appName = env.DATABRICKS_APP_NAME || DEFAULT_APP_NAME
  const { tags, warnings } = mergeResourceTags(parseEnvJson(env.AI_PRISM_RESOURCE_TAGS), appName)
  for (const w of warnings) logger.warn(`AI_PRISM_RESOURCE_TAGS: ${w}`)
  cache = { env, tags }
  return tags
}

export function resetResourceTagsCache(): void {
  cache = null
}

/**
 * usage_context de toda chamada ao AI Gateway (chat, embeddings, imagem,
 * transcrição): as tags de recurso e, por último, application='ai-prism', que
 * nenhuma tag do operador consegue sobrescrever (é reservada).
 */
export function usageContext(env: Env = process.env): Record<string, string> {
  return { ...getResourceTags(env), application: USAGE_APPLICATION }
}

/**
 * query_tags de todo statement do SQL Warehouse: [{key, value}] com a tag
 * embutida SEMPRE dentro do limite de 20. Reserva o slot dela antes de
 * preencher com as tags do operador (um slice(0, 20) simples a derrubaria,
 * já que ela entra por último em getResourceTags()).
 */
export function queryTagsFor(env: Env = process.env): { key: string; value: string }[] {
  const entries = Object.entries(getResourceTags(env))
  const builtIn = entries.find(([key]) => key === APP_TAG_KEY)
  const operatorEntries = entries.filter(([key]) => key !== APP_TAG_KEY)
  const budget = QUERY_TAGS_LIMIT - (builtIn ? 1 : 0)
  const kept = operatorEntries.slice(0, budget)
  const dropped = operatorEntries.length - kept.length
  if (dropped > 0) {
    logger.warn(
      `query_tags: ${dropped} tag(s) de operador descartada(s) por exceder o limite de ${QUERY_TAGS_LIMIT} ` +
        `(a tag embutida ${APP_TAG_KEY} é sempre mantida).`
    )
  }
  const ordered = builtIn ? [builtIn, ...kept] : kept
  return ordered.map(([key, value]) => ({ key, value }))
}
