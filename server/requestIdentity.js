// Quem é a requisição: o proxy do Databricks Apps repassa o e-mail do usuário
// logado (x-forwarded-email) e o token OBO (x-forwarded-access-token). No runtime
// de Apps nada mais conta: sem o e-mail do header → sem identidade (401), e nunca
// token ou e-mail vindos do ambiente. Só uma execução local (npm run dev:local,
// fora do runtime de Apps) pode cair no DATABRICKS_USER_EMAIL / DATABRICKS_USER_TOKEN
// e nos placeholders de dev.
//
// Ports the fork's server/requestIdentity.js (2.3.x). Diferença: a flag local
// aqui é LOCAL_DEV_MODE=1 (já vem no .env.local); LOCAL_DEV_IDENTITY=1 também vale.

// Definidas pelo runtime do Databricks Apps em todo processo do app. Qualquer uma
// presente significa runtime de Apps, seja qual for o resto do ambiente.
export const APPS_RUNTIME_MARKERS = ['DATABRICKS_APP_NAME', 'DATABRICKS_APP_PORT', 'DATABRICKS_APP_URL']

/**
 * Se o processo pode usar a identidade do ambiente: só uma execução local que
 * diz isso (LOCAL_DEV_IDENTITY=1 ou LOCAL_DEV_MODE=1) e não traz nenhum marcador
 * do runtime de Apps. NODE_ENV não conta: o npm o define como production nos
 * scripts do repo (.npmrc com omit=dev).
 */
export function devIdentityAllowed(env = process.env) {
  if (APPS_RUNTIME_MARKERS.some((name) => String(env[name] ?? '').trim())) return false
  return env.LOCAL_DEV_IDENTITY === '1' || env.LOCAL_DEV_MODE === '1'
}

/** Chave canônica de identidade (minúscula): credenciais, caches e chaves de pool usam esta. */
export function identityKey(email) {
  return String(email || '').trim().toLowerCase()
}

/**
 * { email, token, key } da requisição; campos nulos quando ela não traz nada.
 * `email` fica como foi repassado (as tabelas de chat são chaveadas por ele);
 * `key` é a identidade minúscula.
 */
export function requestIdentity(req, env = process.env) {
  const dev = devIdentityAllowed(env)
  const header = (name) => {
    const v = req.headers?.[name]
    return typeof v === 'string' && v.trim() ? v.trim() : null
  }
  const email = header('x-forwarded-email') || (dev ? env.DATABRICKS_USER_EMAIL || 'local-dev@databricks.com' : null)
  const token =
    header('x-forwarded-access-token') ||
    (dev ? env.DATABRICKS_USER_TOKEN || (env.LOCAL_DEV_MODE === '1' ? 'local-dev-token' : null) : null)
  return { email, token, key: email ? identityKey(email) : null }
}
