import pg from 'pg'

const { Client, Pool } = pg

// ---- connection identity ----------------------------------------------------
// Preferred: the APP's service principal (Databricks Apps inject
// DATABRICKS_CLIENT_ID/SECRET). One PG role serves every signed-in user and
// per-user isolation is enforced app-level by the user_email WHERE clauses —
// this is what makes the app truly multi-user (workspace users don't get
// Lakebase PG roles of their own) and what lets admins publish global
// templates every user can read. Requires the SP's Postgres role to exist:
// the deploy job (bundle/auto_config.py) creates it on the Lakebase "Autoscaling"
// product via the databricks_auth extension —
//   SELECT databricks_create_role('<DATABRICKS_CLIENT_ID>', 'SERVICE_PRINCIPAL')
// — and ensureSpGrants (below) applies the table GRANTs at runtime.
// Fallback: the caller's own identity + OBO token as password (works for the
// table owner even without the SP role). A failed SP login only disables the SP
// path temporarily (never a permanent latch).
const SP_RETRY_MS = 5 * 60 * 1000
let spToken = { value: null, exp: 0 }
let spDisabledUntil = 0

function oidcHost() {
  let h = process.env.DATABRICKS_HOST || ''
  if (h && !h.startsWith('http')) h = `https://${h}`
  return h
}

async function spAccessToken() {
  if (spToken.value && Date.now() < spToken.exp - 120_000) return spToken.value
  const res = await fetch(`${oidcHost()}/oidc/v1/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      scope: 'all-apis',
      client_id: process.env.DATABRICKS_CLIENT_ID,
      client_secret: process.env.DATABRICKS_CLIENT_SECRET,
    }),
  })
  if (!res.ok) throw new Error(`sp token: HTTP ${res.status}`)
  const d = await res.json()
  spToken = { value: d.access_token, exp: Date.now() + (d.expires_in || 3600) * 1000 }
  return spToken.value
}

// ---- Lakebase host resolution (cloud-agnostic, no hardcoded PGHOST) ----------
// The app learns its Lakebase host from the `lakebase` app resource: the runtime
// injects the endpoint PATH as PG_ENDPOINT (value_from: lakebase in app.yaml /
// databricks.yml). We resolve that path -> host once via the REST API using the
// SP token, and cache it for the process. Local dev can still set PGHOST directly.
//
// Why not just an env host? A nested bundle ref (${...status.hosts.host}) does NOT
// resolve into app config, and a hardcoded host silently points the app at the
// wrong cloud's Lakebase (login fails with SQLSTATE 28000). The endpoint path,
// injected by the platform, is the reliable per-workspace handle.
let resolvedPgHost = null
async function lakebaseHost() {
  // explicit override wins: PGHOST is set directly for local dev, and is ALSO
  // auto-injected by the `lakebase` app resource — so in production this returns
  // immediately without an API call. The PG_ENDPOINT path below is the fallback.
  if (process.env.PGHOST) return process.env.PGHOST
  if (resolvedPgHost) return resolvedPgHost
  // endpoint path from the injected app resource, or derived from defaults the
  // bundle creates (project = app name; default branch "production"; endpoint
  // "primary" — see databricks.yml postgres_projects/postgres_endpoints).
  let endpointPath = process.env.PG_ENDPOINT
  if (!endpointPath) {
    const proj = process.env.DATABRICKS_APP_NAME || 'ai-prism'
    endpointPath = `projects/${proj}/branches/production/endpoints/primary`
  }
  const token = await spAccessToken()
  const res = await fetch(`${oidcHost()}/api/2.0/postgres/${endpointPath}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`lakebase endpoint lookup ${endpointPath}: HTTP ${res.status}`)
  const d = await res.json()
  const host = d?.status?.hosts?.host
  if (!host) throw new Error(`lakebase endpoint ${endpointPath}: no status.hosts.host`)
  resolvedPgHost = host
  return host
}

// The APP's own OAuth token (service principal, all-apis scope). Used for
// app-owned storage that must not depend on a per-user OAuth scope/consent —
// notably the generated-image UC Volume (see imageStore.js). Returns null when
// the app isn't running with SP credentials (local dev without them), so the
// caller can fall back to the user's OBO token. Per-user ISOLATION is NOT the
// storage identity's job here: it's enforced app-level by the user_email WHERE
// clauses (same trust model as every other artifact — see the module header).
export async function appServiceToken() {
  if (!process.env.DATABRICKS_CLIENT_ID || !process.env.DATABRICKS_CLIENT_SECRET) return null
  try {
    return await spAccessToken()
  } catch {
    return null
  }
}

async function connInfo(user, password) {
  const sslMode = String(process.env.PGSSLMODE || 'require').toLowerCase()
  return {
    host: await lakebaseHost(),
    port: parseInt(process.env.PGPORT || '5432', 10),
    database: process.env.PGDATABASE || 'databricks_postgres',
    user,
    password,
    ssl: ['disable', 'disabled', 'false', '0'].includes(sslMode) ? false : { rejectUnauthorized: false },
    // keep the handshake snappy; fail loud if Lakebase is unreachable
    connectionTimeoutMillis: 15000,
    // 60s: the Settings template list ships whole mined asset libraries (MBs
    // of jsonb) — comfortably fast in-region, but a remote dev laptop pays
    // the cross-region transfer inside the query and 30s wasn't enough
    query_timeout: 60000,
  }
}

// ---- connection pooling ------------------------------------------------------
// The Lakebase handshake (TLS + auth) costs ~2s in-region, and a single chat
// turn runs ~10 DB operations. Opening a fresh Client per op (the original
// design) serialized ~20s of pure handshake onto every turn. Pooling reuses
// warm sockets: only the FIRST op of a cold pool pays the handshake.
//
// Token rotation (the reason pooling was originally avoided) is handled two
// ways: (1) `password` is passed as an async FUNCTION — node-postgres calls it
// for each NEW physical connection, so a fresh SP token is fetched at connect
// time; and (2) an already-open socket doesn't re-authenticate (Postgres only
// checks credentials at connect), so a mid-flight token expiry can't break a
// live connection. Idle connections are reaped after `idleTimeoutMillis`, and
// `maxLifetime` caps how long any socket lives so we never sit on an ancient
// one. A per-connection error (e.g. server-side termination) just removes it
// from the pool; the next acquire opens a fresh one.
const POOL_OPTS = {
  max: 8,
  idleTimeoutMillis: 5 * 60 * 1000,
  maxLifetimeSeconds: 30 * 60,
  allowExitOnIdle: true,
}

// SP pool: one shared identity for the whole app, so a single pool serves every
// user. `password` is a function → each new connection gets a fresh SP token.
let spPool = null
async function getSpPool() {
  if (!spPool) {
    spPool = new Pool({
      ...(await connInfo(process.env.DATABRICKS_CLIENT_ID, () => spAccessToken())),
      ...POOL_OPTS,
    })
    // a broken idle socket must never crash the process — pg emits 'error' on
    // the pool for backend-terminated idle clients; drop it and move on.
    spPool.on('error', (e) => console.warn('lakebase SP pool: idle client error (dropped):', e.message))
  }
  return spPool
}

// Per-user pools, keyed by email — ONLY when the password is stable across the
// process (PGPASSWORD, i.e. local dev with a generated DB credential). With a
// rotating OBO token as password we can't safely pool (a reaped+reopened
// connection would use a stale token), so that path stays one-shot below.
const userPools = new Map()
async function getUserPool(userEmail, password) {
  let p = userPools.get(userEmail)
  if (!p) {
    // A normal local Postgres role is stable and deliberately independent of
    // the app-level test email. Lakebase keeps the historical email-as-role
    // behavior when PGUSER is absent.
    p = new Pool({ ...(await connInfo(process.env.PGUSER || userEmail, password)), ...POOL_OPTS })
    p.on('error', (e) => console.warn(`lakebase user pool (${userEmail}): idle client error (dropped):`, e.message))
    userPools.set(userEmail, p)
  }
  return p
}

// Runs fn(client) with a pooled connection, releasing it back afterward.
async function withPool(pool, fn) {
  const client = await pool.connect()
  try {
    return await fn(client)
  } finally {
    client.release()
  }
}

async function withClient(userEmail, userToken, fn) {
  if (process.env.DATABRICKS_CLIENT_ID && process.env.DATABRICKS_CLIENT_SECRET && Date.now() >= spDisabledUntil) {
    try {
      return await withPool(await getSpPool(), fn)
    } catch (e) {
      // only auth/connection/authorization failures demote to the per-user
      // path; real query errors (thrown inside fn) must surface, not be
      // silently retried. "permission denied" means the SP role exists but
      // its GRANTs haven't been applied yet (see ensureSpGrants) — degrading
      // to the caller's own identity keeps the table owner working meanwhile.
      // "external authorization failed" (SQLSTATE 28000) is Lakebase rejecting
      // the login — also an auth failure, so demote rather than 500 the app.
      if (!/password authentication|role .* does not exist|sp token|permission denied|external authorization|ECONNREFUSED|ETIMEDOUT/i.test(e.message || '')) throw e
      spDisabledUntil = Date.now() + SP_RETRY_MS
      console.warn('lakebase: service-principal login unavailable, using per-user identity:', e.message)
    }
  }
  // per-user fallback: the OBO token is the Postgres password. Local dev:
  // workspace CLI tokens are NOT accepted by Lakebase, so a dedicated
  // credential (databricks database generate-database-credential) can be
  // supplied via PGPASSWORD without affecting API bearer usage.
  const stablePassword = process.env.PGPASSWORD
  if (stablePassword) {
    // stable password across the process → safe to pool by user
    return await withPool(await getUserPool(userEmail, stablePassword), fn)
  }
  // rotating OBO token as password: can't pool safely, so keep the original
  // fresh-client-per-op behavior (always uses a currently-valid token).
  const client = new Client(await connInfo(userEmail, userToken))
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end().catch(() => {})
  }
}

export async function ensureSchema(userEmail, userToken) {
  await withClient(userEmail, userToken, async (c) => {
    // cheap probe of the NEWEST schema artifacts: when they exist the whole
    // DDL body can be skipped. This matters beyond speed — tables belong to
    // whoever created them, and ALTER TABLE from any other identity fails
    // with 42501, which used to 500 the app when a non-owner booted first.
    const schemaCurrent = async () => {
      try {
        await c.query(`SELECT scope FROM deck_templates LIMIT 0`)
        await c.query(`SELECT principal FROM app_admins LIMIT 0`)
        await c.query(`SELECT template_id FROM user_template_selection LIMIT 0`)
        await c.query(`SELECT id FROM chat_spreadsheets LIMIT 0`)
        await c.query(`SELECT endpoint_id FROM model_catalog_overrides LIMIT 0`)
        await c.query(`SELECT connection_name FROM user_mcp_connections LIMIT 0`)
        await c.query(`SELECT triggers FROM skills LIMIT 0`)
        await c.query(`SELECT message_id FROM chat_message_embeddings LIMIT 0`)
        await c.query(`SELECT volume_path FROM chat_images LIMIT 0`)
        await c.query(`SELECT tool_key FROM app_tool_policy LIMIT 0`)
        // newest artifacts — the probe must name the LATEST migrations (any one
        // still missing → false → the whole idempotent DDL re-runs). All DDL is
        // CREATE/ALTER IF NOT EXISTS, so re-running is safe regardless of order.
        await c.query(`SELECT markdown FROM chat_documents LIMIT 0`)
        await c.query(`SELECT media_processing FROM chat_messages LIMIT 0`)
        await c.query(`SELECT intent_classify FROM chat_messages LIMIT 0`)
        await c.query(`SELECT reasoning FROM chat_messages LIMIT 0`)
        return true
      } catch {
        return false
      }
    }
    if (await schemaCurrent()) return
    try {
      await runSchemaDdl(c)
    } catch (e) {
      if (e.code === '42501' && (await schemaCurrent())) {
        console.warn('ensureSchema: sem privilégio para DDL, mas o schema já está atual — seguindo:', e.message)
        return
      }
      throw e
    }
  })
}

async function runSchemaDdl(c) {
    await c.query(`
      CREATE TABLE IF NOT EXISTS chat_sessions (
        id BIGSERIAL PRIMARY KEY,
        user_email TEXT NOT NULL,
        title TEXT NOT NULL,
        model TEXT NOT NULL,
        system_prompt TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );`)
    await c.query(`
      CREATE TABLE IF NOT EXISTS chat_messages (
        id BIGSERIAL PRIMARY KEY,
        session_id BIGINT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        attachments TEXT,
        model TEXT,
        prompt_tokens INT,
        completion_tokens INT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );`)
    // forward-compat for older deployments of this table
    await c.query(`ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS system_prompt TEXT;`)
    await c.query(`ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();`)
    await c.query(`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS prompt_tokens INT;`)
    await c.query(`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS completion_tokens INT;`)
    await c.query(`ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS embedding DOUBLE PRECISION[];`)
    await c.query(`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS blocks JSONB;`)
    // transparency for the multimodal media hop: when an audio/video attachment
    // is read by a DIFFERENT model than the one that wrote the answer (media →
    // Gemini transcript → user's model summarizes), record who processed the
    // media so the UI can disclose it. Shape: { model: '<id>', files: ['a.mp3'] }
    await c.query(`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS media_processing JSONB;`)
    // transparency for the per-turn intent classifier: a cheap/fast model reads
    // the user's intent (which artifact/data tools the turn needs) before the
    // main answer, so we don't over-fire capabilities on ambiguous briefings.
    // Its tiny token spend is disclosed like the media hop. Shape:
    // { model: '<id>', usage: { prompt_tokens, completion_tokens } }
    await c.query(`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS intent_classify JSONB;`)
    // native reasoning/thinking trace, kept for later inspection (persisted so
    // the collapsible block survives a reload). Distinct from `content` — it is
    // never replayed into the model's context.
    await c.query(`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS reasoning TEXT;`)
    // regeneration versioning: all variants of one assistant turn share
    // `variant_group` (the id of the first/original row in that slot); only
    // one is `active` at a time — that's the one shown in the main thread,
    // replayed to the model, and what a new regeneration branches from.
    await c.query(`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS variant_group BIGINT;`)
    await c.query(`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true;`)
    await c.query(`UPDATE chat_messages SET variant_group = id WHERE variant_group IS NULL;`)
    await c.query(`CREATE INDEX IF NOT EXISTS idx_chat_messages_variant_group ON chat_messages(variant_group);`)
    // tools embedded in the session: the built-in Python UC function is
    // implicit and never stored here — only the *additional* Unity Catalog
    // Functions the user attached, so reopening a session re-enables them
    // without any reconfiguration.
    await c.query(`ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS enabled_tools JSONB DEFAULT '[]'::jsonb;`)
    // chart candidates accumulate across the whole session (not just one
    // turn): a report compiled several messages after the Genie calls that
    // actually fetched the numbers still needs those candidates to resolve
    // its prism-block fences. `nextId` is a monotonic counter so ids stay
    // unique even after `items` gets trimmed (see saveSessionChartCandidates).
    await c.query(
      `ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS chart_candidates JSONB DEFAULT '{"nextId":1,"items":[]}'::jsonb;`
    )
    await c.query(`
      CREATE TABLE IF NOT EXISTS chat_tool_calls (
        id BIGSERIAL PRIMARY KEY,
        message_id BIGINT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
        seq INT NOT NULL,
        tool_name TEXT NOT NULL,
        tool_label TEXT,
        arguments JSONB,
        result TEXT,
        status TEXT NOT NULL,
        duration_ms INT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );`)
    // the model/gateway's own tool_call id — lets stored message content
    // reference a specific call inline (see {{toolcall:ID}} in blocks.js)
    // instead of always rendering every tool call before the answer text
    await c.query(`ALTER TABLE chat_tool_calls ADD COLUMN IF NOT EXISTS call_id TEXT;`)
    // remembers which Genie conversation a session is using for a given space,
    // so follow-up questions within the same chat keep Genie's own context
    // instead of starting a fresh conversation (and losing it) every turn
    await c.query(`
      CREATE TABLE IF NOT EXISTS chat_genie_conversations (
        session_id BIGINT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
        space_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (session_id, space_id)
      );`)
    await c.query(`CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id, id);`)
    await c.query(`CREATE INDEX IF NOT EXISTS idx_chat_sessions_user ON chat_sessions(user_email, updated_at DESC);`)
    await c.query(`CREATE INDEX IF NOT EXISTS idx_chat_tool_calls_message ON chat_tool_calls(message_id, seq);`)
    // style templates ("design systems") used to steer generated decks toward
    // the user's own branding instead of generic defaults — a user can keep
    // several (e.g. one per audience/brand) with exactly one selected at a time
    await c.query(`
      CREATE TABLE IF NOT EXISTS deck_templates (
        user_email TEXT PRIMARY KEY,
        name TEXT,
        primary_color TEXT,
        secondary_color TEXT,
        accent_color TEXT,
        heading_font TEXT,
        body_font TEXT,
        logo_data_url TEXT,
        style_notes TEXT,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );`)
    // migrates the original "1 row per user" shape above to "N rows per user,
    // one selected" — ADD COLUMN/DROP CONSTRAINT IF EXISTS keep this idempotent
    // across restarts (Postgres always names a table's primary key constraint
    // `<table>_pkey`, so dropping-then-re-adding it every boot is a no-op once
    // already applied)
    await c.query(`ALTER TABLE deck_templates ADD COLUMN IF NOT EXISTS id BIGSERIAL;`)
    await c.query(`ALTER TABLE deck_templates ADD COLUMN IF NOT EXISTS is_selected BOOLEAN NOT NULL DEFAULT false;`)
    await c.query(`ALTER TABLE deck_templates ADD COLUMN IF NOT EXISTS background_color TEXT;`)
    await c.query(`ALTER TABLE deck_templates ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();`)
    // real icon/image assets mined from an imported .pptx (never emoji — see
    // server/blocks.js iconRef) + a lightweight per-slide summary used only by
    // the Design System inspector (client/src/components/DeckTemplateInspector.jsx)
    await c.query(`ALTER TABLE deck_templates ADD COLUMN IF NOT EXISTS icon_assets JSONB NOT NULL DEFAULT '[]'::jsonb;`)
    await c.query(`ALTER TABLE deck_templates ADD COLUMN IF NOT EXISTS preview_slides JSONB NOT NULL DEFAULT '[]'::jsonb;`)
    // full-bleed cover background photo mined from the imported .pptx —
    // carries the template's own visual identity into generated covers
    await c.query(`ALTER TABLE deck_templates ADD COLUMN IF NOT EXISTS cover_plate_data_url TEXT;`)
    // deeper mined identity: cover overlay layer, section plate, vector motif
    // spec, title ink/typography (see extractPptxTheme in the client)
    await c.query(`ALTER TABLE deck_templates ADD COLUMN IF NOT EXISTS mined_style JSONB;`)
    // design-system BUNDLE fields (Claude Design folder/zip exports — see
    // client/src/lib/dsImport.js): declared identity beyond what a .pptx
    // carries. readme = full text (viewer); brand_rules = condensed cut for
    // the model prompt; palette = named color tokens; font_assets =
    // self-hosted webfonts (preview/present-mode only — pptx references
    // fonts by name); ds_cards = self-contained HTML specimen cards.
    await c.query(`ALTER TABLE deck_templates ADD COLUMN IF NOT EXISTS logo_light_data_url TEXT;`)
    await c.query(`ALTER TABLE deck_templates ADD COLUMN IF NOT EXISTS readme TEXT;`)
    await c.query(`ALTER TABLE deck_templates ADD COLUMN IF NOT EXISTS brand_rules TEXT;`)
    await c.query(`ALTER TABLE deck_templates ADD COLUMN IF NOT EXISTS palette JSONB NOT NULL DEFAULT '[]'::jsonb;`)
    await c.query(`ALTER TABLE deck_templates ADD COLUMN IF NOT EXISTS font_assets JSONB NOT NULL DEFAULT '[]'::jsonb;`)
    await c.query(`ALTER TABLE deck_templates ADD COLUMN IF NOT EXISTS ds_cards JSONB NOT NULL DEFAULT '[]'::jsonb;`)
    // one-time migration of the primary key from the original `user_email`
    // shape to `id`. Guarded so it only fires on the OLD shape: once the PK is
    // on `id`, a bare DROP CONSTRAINT fails on any DB where a dependent FK
    // (user_template_selection_template_id_fkey) already references it.
    await c.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM pg_index i
          JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
          WHERE i.indrelid = 'deck_templates'::regclass AND i.indisprimary AND a.attname = 'user_email'
        ) THEN
          ALTER TABLE deck_templates DROP CONSTRAINT IF EXISTS deck_templates_pkey;
          ALTER TABLE deck_templates ADD PRIMARY KEY (id);
        END IF;
      END $$;`)
    await c.query(`
      UPDATE deck_templates SET is_selected = true
      WHERE user_email IN (
        SELECT user_email FROM deck_templates GROUP BY user_email HAVING NOT bool_or(is_selected)
      );`)
    await c.query(`CREATE INDEX IF NOT EXISTS idx_deck_templates_user ON deck_templates(user_email);`)
    // decks the model draws as a structured `deck` prism-block (see blocks.js)
    // — stored separately from chat_messages.blocks so the Deck Studio can
    // edit/export them without touching the message's own persisted content
    await c.query(`
      CREATE TABLE IF NOT EXISTS chat_decks (
        id BIGSERIAL PRIMARY KEY,
        session_id BIGINT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
        user_email TEXT NOT NULL,
        title TEXT NOT NULL,
        slides JSONB NOT NULL DEFAULT '[]'::jsonb,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );`)
    await c.query(`CREATE INDEX IF NOT EXISTS idx_chat_decks_session ON chat_decks(session_id);`)
    // deck-level metadata (audience/author/narrative — see sanitizeDeck in
    // blocks.js) that travels with the slides through Studio edits and export
    await c.query(`ALTER TABLE chat_decks ADD COLUMN IF NOT EXISTS meta JSONB DEFAULT '{}'::jsonb;`)

    // spreadsheets the model draws as a structured `spreadsheet` prism-block
    // (see sanitizeSpreadsheet in blocks.js) — the tabular sibling of chat_decks,
    // stored separately from the message so a workbook can be reloaded/exported
    // (server/xlsx-export.js) independent of the chat message's own content.
    await c.query(`
      CREATE TABLE IF NOT EXISTS chat_spreadsheets (
        id BIGSERIAL PRIMARY KEY,
        session_id BIGINT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
        user_email TEXT NOT NULL,
        title TEXT NOT NULL,
        spec JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );`)
    await c.query(`CREATE INDEX IF NOT EXISTS idx_chat_spreadsheets_session ON chat_spreadsheets(session_id);`)

    // ---- multi-user administration ----------------------------------------
    // extra app admins beyond the owner (APP_OWNER_EMAIL): user emails or
    // workspace group display names (resolved via SCIM /Me — see authz.js)
    await c.query(`
      CREATE TABLE IF NOT EXISTS app_admins (
        principal TEXT PRIMARY KEY,
        kind TEXT NOT NULL DEFAULT 'user',
        added_by TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );`)
    // 'user' rows stay private; 'global' rows (published by an admin) are
    // visible to everyone, editable only by admins. user_email keeps holding
    // the publishing admin for audit.
    await c.query(`ALTER TABLE deck_templates ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'user';`)
    await c.query(`CREATE INDEX IF NOT EXISTS idx_deck_templates_global ON deck_templates(scope) WHERE scope = 'global';`)
    // per-user selection of a (possibly shared/global) template — the per-row
    // is_selected flag can't express two users selecting the same global row.
    // The old column stays for back-compat but is no longer read or written.
    await c.query(`
      CREATE TABLE IF NOT EXISTS user_template_selection (
        user_email TEXT PRIMARY KEY,
        template_id BIGINT NOT NULL REFERENCES deck_templates(id) ON DELETE CASCADE,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );`)
    await c.query(`
      INSERT INTO user_template_selection (user_email, template_id)
        SELECT user_email, id FROM deck_templates WHERE is_selected
      ON CONFLICT (user_email) DO NOTHING;`)
    // ---- admin-curated model catalog -------------------------------------
    // one row per AI Gateway serving endpoint an admin has touched: whether
    // it's enabled for the org, plus the display name/blurb users will see in
    // the model picker. Endpoints with no row fall back to the derived/curated
    // defaults; GET /api/models surfaces only enabled ones (with a safe seed
    // so the org is never left with zero models). Global (org-wide), so no
    // user_email — writes are gated to admins at the route layer.
    await c.query(`
      CREATE TABLE IF NOT EXISTS model_catalog_overrides (
        endpoint_id TEXT PRIMARY KEY,
        enabled BOOLEAN NOT NULL DEFAULT false,
        display_name TEXT,
        blurb TEXT,
        sort_order INT,
        updated_by TEXT,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );`)
    // admin-set list prices (USD per 1M tokens) — an EXPLICIT override of the
    // curated/family-inferred defaults, so an uncurated endpoint stops showing
    // NaN in the chat's cost estimate. NULL = "use the inferred default" (never
    // NaN — the family price book / curated list fills it, else it's unpriced).
    await c.query(`ALTER TABLE model_catalog_overrides ADD COLUMN IF NOT EXISTS price_in DOUBLE PRECISION;`)
    await c.query(`ALTER TABLE model_catalog_overrides ADD COLUMN IF NOT EXISTS price_out DOUBLE PRECISION;`)
    // ---- per-user adopted external MCP connections -----------------------
    // records that a user has "connected" a UC HTTP MCP connection (chose to
    // use it) plus the last probed auth status. Holds NO credential — the
    // bearer is always the user's forwarded OAuth token; this only remembers
    // intent + status so the tool picker can show adopted connections as
    // on/off toggles (default on) instead of a search-every-time list.
    await c.query(`
      CREATE TABLE IF NOT EXISTS user_mcp_connections (
        user_email TEXT NOT NULL,
        connection_name TEXT NOT NULL,
        comment TEXT,
        status TEXT NOT NULL DEFAULT 'unknown',
        last_checked_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (user_email, connection_name)
      );`)
    // ---- authored skills (progressive-disclosure capabilities) -----------
    // A skill is a named capability whose detailed instructions (`body`) are
    // injected into the system prompt ONLY when a turn is routed to it (see
    // server/skills.js). `scope` = 'global' (admin-authored, whole org) or
    // 'user' (owner_email's own). The system skills (deck/spreadsheet/chart)
    // live in code, not here. `triggers` are optional keywords for the lexical
    // route; `embedding` (of "title — description") powers the semantic route.
    // Isolation is app-level, same as everything else: WHERE scope='global'
    // OR (scope='user' AND owner_email=$user).
    await c.query(`
      CREATE TABLE IF NOT EXISTS skills (
        id BIGSERIAL PRIMARY KEY,
        scope TEXT NOT NULL DEFAULT 'user',
        owner_email TEXT,
        name TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        body TEXT NOT NULL,
        triggers JSONB NOT NULL DEFAULT '[]'::jsonb,
        embedding DOUBLE PRECISION[],
        source TEXT DEFAULT 'write',
        enabled BOOLEAN NOT NULL DEFAULT true,
        created_by TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );`)
    // a skill name is unique within its owning scope (global names are org-wide;
    // user names are per-user) — enforced with two partial unique indexes so a
    // user can reuse a name the org also uses
    await c.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_skills_global_name ON skills(name) WHERE scope = 'global';`
    )
    await c.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_skills_user_name ON skills(owner_email, name) WHERE scope = 'user';`
    )
    // ---- per-message embeddings for semantic history retrieval (pgvector) ---
    // A separate table (not a column on chat_messages) so the hot read path —
    // fetchActiveMessages — never drags a 1024-dim vector per row. pgvector is
    // available on Lakebase (probed: v0.8.0); the native `vector` type is what
    // an HNSW index needs (a DOUBLE PRECISION[] can't be indexed). Dimension is
    // the qwen3-embedding-0-6b output width (probed: 1024). Isolation stays
    // app-level: every query JOINs back to chat_sessions on user_email.
    if (process.env.LOCAL_DEV_MODE === '1' && process.env.LOCAL_PGVECTOR !== '1') {
      // Homebrew Postgres is enough for UI/Studio development. Avoid requiring
      // a separately compiled pgvector extension; semantic retrieval is off in
      // .env.local and this compatible table keeps the schema probes current.
      await c.query(`
        CREATE TABLE IF NOT EXISTS chat_message_embeddings (
          message_id BIGINT PRIMARY KEY REFERENCES chat_messages(id) ON DELETE CASCADE,
          session_id BIGINT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
          embedding DOUBLE PRECISION[],
          created_at TIMESTAMPTZ DEFAULT NOW()
        );`)
      await c.query(`CREATE INDEX IF NOT EXISTS idx_msg_emb_session ON chat_message_embeddings(session_id);`)
    } else {
      await c.query(`CREATE EXTENSION IF NOT EXISTS vector;`)
      await c.query(`
        CREATE TABLE IF NOT EXISTS chat_message_embeddings (
          message_id BIGINT PRIMARY KEY REFERENCES chat_messages(id) ON DELETE CASCADE,
          session_id BIGINT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
          embedding vector(1024),
          created_at TIMESTAMPTZ DEFAULT NOW()
        );`)
      // HNSW uses vector_cosine_ops, matching the <=> queries below.
      await c.query(`CREATE INDEX IF NOT EXISTS idx_msg_emb_session ON chat_message_embeddings(session_id);`)
      await c.query(
        `CREATE INDEX IF NOT EXISTS idx_msg_emb_hnsw ON chat_message_embeddings USING hnsw (embedding vector_cosine_ops);`
      )
    }
    // ---- per-user image-generation model selection -----------------------
    // mirrors user_template_selection: one row per user naming the image model
    // their turns use (NULL/no row → the org default). Not on chat_sessions
    // because the choice is a stable user preference, not per-conversation.
    await c.query(`
      CREATE TABLE IF NOT EXISTS user_image_model_selection (
        user_email TEXT PRIMARY KEY,
        model_id TEXT NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );`)
    // ---- generated images (bytes live on a UC Volume; row keeps the path) --
    // The binary sibling of chat_decks/chat_spreadsheets: those persist a JSON
    // spec and render bytes on demand, but a generated image has no cheaper
    // form, so the PNG goes to a governed UC Volume (see server/imageStore.js)
    // and this row holds the volume_path + metadata. Isolation is app-level:
    // every read is scoped WHERE user_email. Must be the LAST table created
    // (the ensureSchema probe checks it as the newest artifact).
    await c.query(`
      CREATE TABLE IF NOT EXISTS chat_images (
        id BIGSERIAL PRIMARY KEY,
        session_id BIGINT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
        user_email TEXT NOT NULL,
        prompt TEXT,
        model TEXT,
        volume_path TEXT NOT NULL,
        content_type TEXT NOT NULL DEFAULT 'image/png',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );`)
    await c.query(`CREATE INDEX IF NOT EXISTS idx_chat_images_session ON chat_images(session_id);`)
    // ---- documents the model writes as a `document` prism-block (markdown) ---
    // The prose sibling of chat_decks/chat_spreadsheets: the model authors a
    // markdown document, persisted here so the Document Studio can reload/edit/
    // export it (DOCX/Markdown/PDF) independent of the chat message's content.
    await c.query(`
      CREATE TABLE IF NOT EXISTS chat_documents (
        id BIGSERIAL PRIMARY KEY,
        session_id BIGINT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
        user_email TEXT NOT NULL,
        title TEXT NOT NULL,
        markdown TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );`)
    await c.query(`CREATE INDEX IF NOT EXISTS idx_chat_documents_session ON chat_documents(session_id);`)

    // ---- org-wide tool policy: which built-in tool GROUPS are available -----
    // One row per tool kind an admin has toggled (python / genie-one / image-gen
    // / genie / vector-search / uc / mcp-external). A MISSING row means enabled
    // (default-on), so a fresh install has every tool available and the admin
    // only records exceptions. Global (no user_email); writes gated to admins at
    // the route layer. Enforced server-side in resolveToolDefs AND hidden in the
    // client picker. NOTE: not part of the ensureSchema probe (chat_images stays
    // the newest artifact); this CREATE runs on any deploy where the probe fails.
    await c.query(`
      CREATE TABLE IF NOT EXISTS app_tool_policy (
        tool_key TEXT PRIMARY KEY,
        enabled BOOLEAN NOT NULL DEFAULT true,
        updated_by TEXT,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );`)
}

// grants: the app service principal gets DML on the app tables — row
// isolation is app-level (user_email WHERE clauses), the same trust model the
// app always applied to the forwarded email header. GRANT ... TO the SP can
// only run as the table owner, and never over the SP connection itself, so
// this deliberately bypasses withClient and connects as the caller. Called on
// every request (see ensureReady) because the SP role may be created long
// after the schema — it must fire even when the DDL is skipped as current.
// Cheap in steady state: latched on success, per-caller cooldown on failure.
const SP_GRANT_RETRY_MS = 5 * 60 * 1000
let spGrantsDone = false
const spGrantAttempts = new Map()

export async function ensureSpGrants(userEmail, userToken) {
  const spRole = process.env.DATABRICKS_CLIENT_ID
  if (spGrantsDone || !spRole || !/^[\w-]+$/.test(spRole)) return
  const last = spGrantAttempts.get(userEmail) || 0
  if (Date.now() - last < SP_GRANT_RETRY_MS) return
  spGrantAttempts.set(userEmail, Date.now())
  const client = new Client(await connInfo(userEmail, process.env.PGPASSWORD || userToken))
  try {
    await client.connect()
    const probe = await client.query(`SELECT has_table_privilege($1, 'chat_sessions', 'SELECT') AS ok`, [spRole])
    if (!probe.rows[0]?.ok) {
      await client.query(`GRANT USAGE ON SCHEMA public TO "${spRole}"`)
      await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "${spRole}"`)
      await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO "${spRole}"`)
      await client.query(
        `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "${spRole}"`
      )
      await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO "${spRole}"`)
      console.log('ensureSpGrants: privilégios concedidos ao service principal', spRole)
    }
    spGrantsDone = true
    spDisabledUntil = 0 // re-enable the SP path right away
  } catch (e) {
    // non-owners can't grant (and non-owner logins may not even connect):
    // quiet skip, the owner's next request will land it
    console.warn('ensureSpGrants: pulado para', userEmail, '-', e.message)
  } finally {
    await client.end().catch(() => {})
  }
}

export async function getGenieConversationId(userEmail, userToken, sessionId, spaceId) {
  return withClient(userEmail, userToken, async (c) => {
    const r = await c.query(
      `SELECT conversation_id FROM chat_genie_conversations WHERE session_id = $1 AND space_id = $2`,
      [sessionId, spaceId]
    )
    return r.rows[0]?.conversation_id || null
  })
}

export async function setGenieConversationId(userEmail, userToken, sessionId, spaceId, conversationId) {
  await withClient(userEmail, userToken, async (c) => {
    await c.query(
      `INSERT INTO chat_genie_conversations (session_id, space_id, conversation_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (session_id, space_id) DO UPDATE SET conversation_id = $3, updated_at = NOW()`,
      [sessionId, spaceId, conversationId]
    )
  })
}

const MAX_STORED_CHART_CANDIDATES = 40

export async function getSessionChartCandidates(userEmail, userToken, sessionId) {
  return withClient(userEmail, userToken, async (c) => {
    const r = await c.query(`SELECT chart_candidates FROM chat_sessions WHERE id = $1 AND user_email = $2`, [
      sessionId,
      userEmail,
    ])
    const state = r.rows[0]?.chart_candidates
    return { nextId: state?.nextId || 1, items: Array.isArray(state?.items) ? state.items : [] }
  })
}

export async function saveSessionChartCandidates(userEmail, userToken, sessionId, state) {
  const trimmed = {
    nextId: state.nextId,
    items: state.items.slice(-MAX_STORED_CHART_CANDIDATES),
  }
  await withClient(userEmail, userToken, async (c) => {
    await c.query(`UPDATE chat_sessions SET chart_candidates = $1 WHERE id = $2 AND user_email = $3`, [
      JSON.stringify(trimmed),
      sessionId,
      userEmail,
    ])
  })
}

export async function createSession(userEmail, userToken, title, model, systemPrompt, enabledTools = []) {
  return withClient(userEmail, userToken, async (c) => {
    const r = await c.query(
      `INSERT INTO chat_sessions (user_email, title, model, system_prompt, enabled_tools)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [userEmail, title, model, systemPrompt || null, JSON.stringify(enabledTools || [])]
    )
    return r.rows[0].id
  })
}

const MAX_ATTACHMENT_NAMES_PER_SESSION = 6

export async function listSessions(userEmail, userToken, limit = 100) {
  return withClient(userEmail, userToken, async (c) => {
    const r = await c.query(
      `SELECT s.id, s.title, s.model, s.system_prompt, s.enabled_tools, s.created_at, s.updated_at,
              COALESCE(att.names, ARRAY[]::text[]) AS attachment_names
       FROM chat_sessions s
       LEFT JOIN LATERAL (
         SELECT array_agg(DISTINCT elem) AS names
         FROM chat_messages m
         CROSS JOIN LATERAL jsonb_array_elements_text(m.attachments::jsonb) AS elem
         WHERE m.session_id = s.id AND m.attachments IS NOT NULL
       ) att ON true
       WHERE s.user_email = $1
       ORDER BY s.updated_at DESC LIMIT $2`,
      [userEmail, limit]
    )
    return r.rows.map((x) => ({
      id: String(x.id),
      title: x.title,
      model: x.model,
      system_prompt: x.system_prompt,
      enabled_tools: x.enabled_tools || [],
      created_at: x.created_at,
      updated_at: x.updated_at,
      attachment_names: (x.attachment_names || []).slice(0, MAX_ATTACHMENT_NAMES_PER_SESSION),
    }))
  })
}

export async function getSession(userEmail, userToken, sessionId) {
  return withClient(userEmail, userToken, async (c) => {
    const r = await c.query(
      `SELECT id, title, model, system_prompt, enabled_tools FROM chat_sessions
       WHERE id = $1 AND user_email = $2`,
      [sessionId, userEmail]
    )
    if (!r.rows.length) return null
    const x = r.rows[0]
    return {
      id: String(x.id),
      title: x.title,
      model: x.model,
      system_prompt: x.system_prompt,
      enabled_tools: x.enabled_tools || [],
    }
  })
}

export async function updateSession(userEmail, userToken, sessionId, fields) {
  const sets = []
  const vals = []
  let i = 1
  for (const [k, v] of Object.entries(fields)) {
    sets.push(`${k} = $${i++}`)
    vals.push(k === 'enabled_tools' ? JSON.stringify(v || []) : v)
  }
  if (!sets.length) return
  sets.push(`updated_at = NOW()`)
  vals.push(sessionId, userEmail)
  await withClient(userEmail, userToken, async (c) => {
    await c.query(
      `UPDATE chat_sessions SET ${sets.join(', ')} WHERE id = $${i++} AND user_email = $${i}`,
      vals
    )
  })
}

export async function touchSession(userEmail, userToken, sessionId) {
  await withClient(userEmail, userToken, async (c) => {
    await c.query(`UPDATE chat_sessions SET updated_at = NOW() WHERE id = $1 AND user_email = $2`, [
      sessionId,
      userEmail,
    ])
  })
}

export async function deleteSession(userEmail, userToken, sessionId) {
  await withClient(userEmail, userToken, async (c) => {
    await c.query(`DELETE FROM chat_sessions WHERE id = $1 AND user_email = $2`, [
      sessionId,
      userEmail,
    ])
  })
}

export async function setSessionEmbedding(userEmail, userToken, sessionId, vec) {
  await withClient(userEmail, userToken, async (c) => {
    await c.query(
      `UPDATE chat_sessions SET embedding = $1 WHERE id = $2 AND user_email = $3`,
      [vec, sessionId, userEmail]
    )
  })
}

// Returns every session with its stored embedding and a concatenated text doc
// (title + message contents) used to (re)build embeddings for semantic search.
export async function listSessionsForSearch(userEmail, userToken) {
  return withClient(userEmail, userToken, async (c) => {
    const r = await c.query(
      `SELECT s.id, s.title, s.embedding,
              COALESCE(string_agg(m.content, ' ' ORDER BY m.id) FILTER (WHERE m.role = 'user'), s.title) AS doc
       FROM chat_sessions s
       LEFT JOIN chat_messages m ON m.session_id = s.id
       WHERE s.user_email = $1
       GROUP BY s.id, s.title, s.embedding, s.updated_at
       ORDER BY s.updated_at DESC`,
      [userEmail]
    )
    return r.rows.map((x) => ({
      id: String(x.id),
      title: x.title,
      embedding: x.embedding,
      doc: x.doc || x.title,
    }))
  })
}

// pgvector's wire format over node-postgres is a string literal like
// '[0.1,0.2,...]' (there's no array type parser registered), both for INSERT
// params and for the `<=>` distance operator's right-hand side.
function toVectorLiteral(vec) {
  return `[${vec.join(',')}]`
}

// Upserts the embedding for one message. Best-effort caller (tail of a turn);
// session_id is stored so retrieval can filter per session without a JOIN on
// the hot path of the ANN scan. ON CONFLICT keeps it idempotent under retries.
export async function setMessageEmbedding(userEmail, userToken, sessionId, messageId, vec) {
  await withClient(userEmail, userToken, async (c) => {
    await c.query(
      `INSERT INTO chat_message_embeddings (message_id, session_id, embedding)
       VALUES ($1, $2, $3::vector)
       ON CONFLICT (message_id) DO UPDATE SET embedding = EXCLUDED.embedding, created_at = NOW()`,
      [messageId, sessionId, toVectorLiteral(vec)]
    )
  })
}

// Semantic retrieval of the most relevant messages from ONE session, EXCLUDING
// the most recent `excludeRecent` messages (those are already replayed verbatim
// by the recency window — no point retrieving them too). Ownership is enforced
// by joining back to chat_sessions on user_email. Returns oldest-first so the
// caller can splice them into the prompt in chronological order. `<=>` is
// cosine distance (0 = identical); we convert to a similarity floor.
export async function retrieveRelevantMessages(
  userEmail,
  userToken,
  sessionId,
  queryVec,
  { topN = 6, excludeRecent = 6, minSimilarity = 0.35 } = {}
) {
  return withClient(userEmail, userToken, async (c) => {
    const r = await c.query(
      `WITH scoped AS (
         SELECT m.id, m.role, m.content, m.created_at,
                1 - (e.embedding <=> $2::vector) AS similarity,
                ROW_NUMBER() OVER (ORDER BY m.id DESC) AS recency_rank
           FROM chat_message_embeddings e
           JOIN chat_messages m ON m.id = e.message_id
           JOIN chat_sessions s ON s.id = m.session_id AND s.user_email = $3
          WHERE e.session_id = $1 AND m.active = true
       )
       SELECT id, role, content, similarity
         FROM scoped
        WHERE recency_rank > $4 AND similarity >= $5
        ORDER BY similarity DESC
        LIMIT $6`,
      [sessionId, toVectorLiteral(queryVec), userEmail, excludeRecent, minSimilarity, topN]
    )
    // return oldest-first (by id) for chronological splicing into the prompt
    return r.rows
      .map((x) => ({ id: String(x.id), role: x.role, content: x.content, similarity: x.similarity }))
      .sort((a, b) => Number(a.id) - Number(b.id))
  })
}

// Session-level semantic search (sidebar) via pgvector: aggregates each
// session's message vectors to its best match against the query, so the search
// reflects any turn in the conversation, not just a single session-level
// embedding. Runs the ranking IN the database (indexed) instead of pulling all
// vectors into Node. Ownership scoped by user_email.
export async function searchSessionsByVector(userEmail, userToken, queryVec, { limit = 20, minSimilarity = 0.3 } = {}) {
  return withClient(userEmail, userToken, async (c) => {
    const r = await c.query(
      `SELECT s.id, s.title, MAX(1 - (e.embedding <=> $1::vector)) AS score
         FROM chat_message_embeddings e
         JOIN chat_sessions s ON s.id = e.session_id AND s.user_email = $2
        GROUP BY s.id, s.title
       HAVING MAX(1 - (e.embedding <=> $1::vector)) >= $3
        ORDER BY score DESC
        LIMIT $4`,
      [toVectorLiteral(queryVec), userEmail, minSimilarity, limit]
    )
    return r.rows.map((x) => ({ id: String(x.id), title: x.title, score: x.score }))
  })
}

// Messages in a session missing a per-message embedding (lazy backfill target).
// Only user/assistant text is worth embedding; empty rows are skipped.
export async function listMessagesMissingEmbedding(userEmail, userToken, sessionId) {
  return withClient(userEmail, userToken, async (c) => {
    const r = await c.query(
      `SELECT m.id, m.role, m.content
         FROM chat_messages m
         JOIN chat_sessions s ON s.id = m.session_id AND s.user_email = $2
         LEFT JOIN chat_message_embeddings e ON e.message_id = m.id
        WHERE m.session_id = $1 AND e.message_id IS NULL
          AND m.content IS NOT NULL AND length(trim(m.content)) > 0
        ORDER BY m.id ASC`,
      [sessionId, userEmail]
    )
    return r.rows.map((x) => ({ id: String(x.id), role: x.role, content: x.content }))
  })
}

// Un-embedded messages across ALL of the user's sessions, newest-first, capped.
// Powers the migration backfill so search/retrieval work on history that predates
// this feature — the newest sessions (most likely searched) index first.
export async function listUserMessagesMissingEmbedding(userEmail, userToken, limit = 200) {
  return withClient(userEmail, userToken, async (c) => {
    const r = await c.query(
      `SELECT m.id, m.session_id, m.role, m.content
         FROM chat_messages m
         JOIN chat_sessions s ON s.id = m.session_id AND s.user_email = $1
         LEFT JOIN chat_message_embeddings e ON e.message_id = m.id
        WHERE e.message_id IS NULL
          AND m.content IS NOT NULL AND length(trim(m.content)) > 0
        ORDER BY m.id DESC
        LIMIT $2`,
      [userEmail, limit]
    )
    return r.rows.map((x) => ({ id: String(x.id), sessionId: String(x.session_id), role: x.role, content: x.content }))
  })
}

/**
 * Inserts a message. Pass `variantGroup` (the original message's id) to add a
 * regenerated variant to an existing slot — the new row becomes the active
 * one and every sibling in that group is deactivated. Omit it for a normal
 * new message, which becomes its own single-variant group.
 */
export async function addMessage(userEmail, userToken, msg) {
  return withClient(userEmail, userToken, async (c) => {
    // chat_messages has no user_email of its own — ownership is inherited from
    // the parent session. Since every user shares one Postgres identity (the
    // app SP), the ONLY isolation is this app-level check: the INSERT ... SELECT
    // materializes a row only when the target session belongs to the caller, so
    // a client can never inject a message into someone else's thread by passing
    // a guessed (enumerable BIGSERIAL) session id.
    const r = await c.query(
      `INSERT INTO chat_messages (session_id, role, content, attachments, model, prompt_tokens, completion_tokens, blocks, variant_group, media_processing, intent_classify, reasoning)
       SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $11, $12, $13
       WHERE EXISTS (SELECT 1 FROM chat_sessions WHERE id = $1 AND user_email = $10)
       RETURNING id, created_at`,
      [
        msg.sessionId,
        msg.role,
        msg.content,
        msg.attachments || null,
        msg.model || null,
        msg.promptTokens ?? null,
        msg.completionTokens ?? null,
        msg.blocks ? JSON.stringify(msg.blocks) : null,
        msg.variantGroup ?? null,
        userEmail,
        msg.mediaProcessing ? JSON.stringify(msg.mediaProcessing) : null,
        msg.intentClassify ? JSON.stringify(msg.intentClassify) : null,
        msg.reasoning || null,
      ]
    )
    if (!r.rows.length) throw Object.assign(new Error('sessão não encontrada'), { status: 404 })
    const id = r.rows[0].id
    if (msg.variantGroup == null) {
      await c.query(`UPDATE chat_messages SET variant_group = $1 WHERE id = $1`, [id])
    } else {
      await c.query(`UPDATE chat_messages SET active = (id = $1) WHERE variant_group = $2`, [id, msg.variantGroup])
    }
    return { id: String(id), created_at: r.rows[0].created_at }
  })
}

// Raw row lookup for a single message — used by the edit endpoint to verify
// role/ownership and to carry over the variant_group + attachment tail.
export async function getMessageRaw(userEmail, userToken, messageId) {
  return withClient(userEmail, userToken, async (c) => {
    const r = await c.query(
      `SELECT m.session_id, m.role, m.content, m.attachments, m.variant_group FROM chat_messages m
       JOIN chat_sessions s ON s.id = m.session_id AND s.user_email = $2
       WHERE m.id = $1`,
      [messageId, userEmail]
    )
    if (!r.rows.length) return null
    const x = r.rows[0]
    return {
      sessionId: String(x.session_id),
      role: x.role,
      content: x.content,
      attachments: x.attachments,
      variantGroup: String(x.variant_group),
    }
  })
}

// Returns the parsed blocks array stored on a message (or null).
export async function getMessageBlocks(userEmail, userToken, messageId) {
  return withClient(userEmail, userToken, async (c) => {
    const r = await c.query(
      `SELECT m.blocks FROM chat_messages m
       JOIN chat_sessions s ON s.id = m.session_id AND s.user_email = $2
       WHERE m.id = $1`,
      [messageId, userEmail]
    )
    return r.rows.length ? r.rows[0].blocks || null : null
  })
}

// Persists answers into a `deck-questions` block stored on a message's blocks
// JSONB. Answers are stamped onto the first deck-questions block found (there's
// only ever one per message). Returns the updated blocks array, or null if the
// message has no such block. `answersMap` is already sanitized by the caller.
export async function setDeckQuestionsAnswers(userEmail, userToken, messageId, answersMap, answeredAt) {
  return withClient(userEmail, userToken, async (c) => {
    // only read/write a message whose session belongs to the caller
    const r = await c.query(
      `SELECT m.blocks FROM chat_messages m
       JOIN chat_sessions s ON s.id = m.session_id AND s.user_email = $2
       WHERE m.id = $1`,
      [messageId, userEmail]
    )
    if (!r.rows.length || !r.rows[0].blocks) return null
    const blocks = r.rows[0].blocks
    let touched = false
    for (const b of blocks) {
      if (b && b.type === 'deck-questions') {
        b.answers = answersMap
        b.answeredAt = answeredAt
        touched = true
        break
      }
    }
    if (!touched) return null
    // the WHERE still re-checks ownership so a concurrent session move can't slip
    // the write onto another user's row between the SELECT and the UPDATE
    await c.query(
      `UPDATE chat_messages m SET blocks = $2
       FROM chat_sessions s
       WHERE m.id = $1 AND s.id = m.session_id AND s.user_email = $3`,
      [messageId, JSON.stringify(blocks), userEmail]
    )
    return blocks
  })
}

// Marks one specific variant as the active one for its slot — used when the
// user navigates the version carousel to a message other than the latest.
export async function activateVariant(userEmail, userToken, messageId) {
  await withClient(userEmail, userToken, async (c) => {
    // resolve the variant group only for a message in the caller's own session,
    // so the subsequent UPDATE can't flip the active variant in someone else's
    // thread by targeting a guessed message id
    const r = await c.query(
      `SELECT m.variant_group FROM chat_messages m
       JOIN chat_sessions s ON s.id = m.session_id AND s.user_email = $2
       WHERE m.id = $1`,
      [messageId, userEmail]
    )
    if (!r.rows.length) return
    await c.query(`UPDATE chat_messages SET active = (id = $1) WHERE variant_group = $2`, [
      messageId,
      r.rows[0].variant_group,
    ])
  })
}

// Shared by listMessages (full thread) and listMessagesBeforeMessage (history
// for a regeneration): fetches every row, attaches tool-call traces, then
// keeps only the active variant per slot — optionally cut off before a given
// slot — ordered by slot position rather than row id (see note below).
async function fetchActiveMessages(c, sessionId, userEmail, { beforeVariantGroup } = {}) {
  // ownership is enforced by joining chat_messages back to its parent session:
  // rows surface only when the session belongs to userEmail. Without this an
  // authenticated user could read another user's thread (messages + tool
  // traces) by passing a guessed session id — chat_messages carries no
  // user_email column of its own, and every user shares one PG identity.
  const r = await c.query(
    `SELECT m.id, m.role, m.content, m.attachments, m.model, m.prompt_tokens, m.completion_tokens, m.blocks, m.variant_group, m.active, m.created_at, m.media_processing, m.intent_classify, m.reasoning
     FROM chat_messages m
     JOIN chat_sessions s ON s.id = m.session_id AND s.user_email = $2
     WHERE m.session_id = $1 ORDER BY m.id ASC`,
    [sessionId, userEmail]
  )
  const ids = r.rows.map((x) => x.id)
  const toolsByMessage = new Map()
  if (ids.length) {
    const tr = await c.query(
      `SELECT message_id, call_id, tool_name, tool_label, arguments, result, status, duration_ms
       FROM chat_tool_calls WHERE message_id = ANY($1) ORDER BY message_id, seq ASC`,
      [ids]
    )
    for (const t of tr.rows) {
      const list = toolsByMessage.get(t.message_id) || []
      list.push({
        id: t.call_id,
        name: t.tool_name,
        label: t.tool_label,
        args: t.arguments,
        result: t.result,
        status: t.status,
        durationMs: t.duration_ms,
      })
      toolsByMessage.set(t.message_id, list)
    }
  }

  const toShape = (x) => ({
    id: String(x.id),
    role: x.role,
    content: x.content,
    attachments: x.attachments,
    model: x.model,
    prompt_tokens: x.prompt_tokens,
    completion_tokens: x.completion_tokens,
    blocks: x.blocks || null,
    tool_calls: toolsByMessage.get(x.id) || null,
    created_at: x.created_at,
    media_processing: x.media_processing || null,
    intent_classify: x.intent_classify || null,
    reasoning: x.reasoning || null,
  })

  // group every row (active or not) by slot, so each active row can carry
  // its sibling variants for the frontend's version carousel
  const groups = new Map()
  for (const x of r.rows) {
    const g = x.variant_group ?? x.id
    if (!groups.has(g)) groups.set(g, [])
    groups.get(g).push(x)
  }

  // active rows are ordered by their *slot* (variant_group), not by their own
  // id — a regenerated row's id is always the newest in the table, but it
  // must still render at the original position in the conversation
  let activeRows = r.rows.filter((x) => x.active)
  if (beforeVariantGroup != null) {
    activeRows = activeRows.filter((x) => Number(x.variant_group ?? x.id) < Number(beforeVariantGroup))
  }
  activeRows.sort((a, b) => Number(a.variant_group ?? a.id) - Number(b.variant_group ?? b.id))

  return activeRows.map((x) => {
    const shaped = toShape(x)
    const siblings = groups.get(x.variant_group ?? x.id)
    if (siblings && siblings.length > 1) shaped.variants = siblings.map(toShape)
    return shaped
  })
}

export async function listMessages(userEmail, userToken, sessionId) {
  return withClient(userEmail, userToken, (c) => fetchActiveMessages(c, sessionId, userEmail))
}

// Conversation history strictly before the slot `messageId` belongs to — what
// the model should see when regenerating that slot. Returns the resolved
// `variantGroup` too, since addMessage needs it to file the new variant into
// the same slot.
export async function listMessagesBeforeMessage(userEmail, userToken, sessionId, messageId) {
  return withClient(userEmail, userToken, async (c) => {
    // scope the slot lookup to a session the caller owns (join to chat_sessions)
    // so a regenerate can't be aimed at someone else's message id
    const g = await c.query(
      `SELECT m.variant_group FROM chat_messages m
       JOIN chat_sessions s ON s.id = m.session_id AND s.user_email = $3
       WHERE m.id = $1 AND m.session_id = $2`,
      [messageId, sessionId, userEmail]
    )
    if (!g.rows.length) return { variantGroup: null, messages: [] }
    const variantGroup = g.rows[0].variant_group
    const messages = await fetchActiveMessages(c, sessionId, userEmail, { beforeVariantGroup: variantGroup })
    return { variantGroup: String(variantGroup), messages }
  })
}

// Persists the ordered trace of tool calls made while producing one assistant
// message — purely for display/audit on reload; the model itself never
// replays this (its own past tool mechanics are irrelevant context, same
// rationale as stripping {{block:N}} placeholders from history).
export async function addToolCalls(userEmail, userToken, messageId, trace) {
  if (!trace?.length) return
  await withClient(userEmail, userToken, async (c) => {
    let seq = 0
    for (const t of trace) {
      await c.query(
        `INSERT INTO chat_tool_calls (message_id, seq, call_id, tool_name, tool_label, arguments, result, status, duration_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          messageId,
          seq++,
          t.id || null,
          t.name,
          t.label || null,
          JSON.stringify(t.args ?? {}),
          t.result != null ? String(t.result).slice(0, 8000) : null,
          t.status,
          t.durationMs ?? null,
        ]
      )
    }
  })
}

// Seeded the first time a user opens their (until-then-empty) template
// collection — pulled straight from the Databricks brand system (Navy/Lava/
// Coral/Oat, DM Sans) so Settings never starts as a blank slate and doubles
// as a concrete "design system" example.
const DATABRICKS_PRESET = {
  name: 'Databricks Corporate',
  primaryColor: '#1B3139',
  secondaryColor: '#FF5F46',
  accentColor: '#FF3621',
  backgroundColor: '#F9F7F4',
  headingFont: 'DM Sans',
  bodyFont: 'DM Sans',
  styleNotes:
    'Tom confiante e direto, como um colega experiente, não um vendedor. Frases curtas, sentence case (nunca Title Case), sem emojis. Fundos quentes (oat), acentos em coral/lava — nunca gradientes azul/roxo de SaaS genérico.',
}

// Extract a lean, self-contained "first slide" from a Templates-group specimen
// for the Settings grid thumbnail. A template card is a whole multi-slide deck
// (a <deck-stage> web component wrapping N <div class="slide">…</div>), often
// hundreds of KB with an inline runtime + external <script src> that 404s in a
// srcdoc. The grid only needs slide 1 as a static picture — so we keep the
// document's <style> blocks (layout + brand type) and the FIRST `.slide`
// element, drop every <script> (a plain div needs no runtime), strip embedded
// webfonts (the token CSS re-declares them from fontAssets) and squeeze
// whitespace. Result is a few tens of KB that renders slide 1 exactly.
// Returns '' when there's no recognizable slide (caller falls back to the
// branded placeholder). Hard cap as a backstop against pathological input.
const PREVIEW_CARD_CAP = 120_000
function extractFirstTemplateSlide(html) {
  if (typeof html !== 'string' || !html) return ''
  const styles = (html.match(/<style[^>]*>[\s\S]*?<\/style>/gi) || []).join('')
  // first element with a `slide` class — scan balanced <div> depth from its start
  const start = /<div[^>]*class="[^"]*\bslide\b[^"]*"[^>]*>/i.exec(html)
  if (!start) return ''
  let i = start.index
  let depth = 0
  let j = i
  const n = html.length
  for (; j < n; ) {
    if (html.startsWith('<div', j)) {
      depth++
      const gt = html.indexOf('>', j)
      if (gt < 0) break
      j = gt + 1
    } else if (html.startsWith('</div>', j)) {
      depth--
      j += 6
      if (depth === 0) break
    } else {
      j++
    }
  }
  let slide = html.slice(i, j)
  if (!slide) return ''
  // The DS's base typography targets the <section> the <deck-stage> component
  // wraps each slide in (e.g. `section{font-family:var(--font-sans)}`). We pull
  // the bare `.slide` div out of that component, so wrap it back in a <section>
  // — otherwise those inherited rules (font included) never match and the slide
  // falls back to the browser default serif.
  let out = `<!doctype html><html><head><meta charset="utf-8">${styles}<style>html,body{margin:0;padding:0;width:1280px;height:720px;overflow:hidden}section,.slide{width:1280px;height:720px;box-sizing:border-box}</style></head><body><section>${slide}</section></body></html>`
  out = out
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    // embedded webfonts: redundant with the injected token CSS in the preview
    .replace(/data:(?:font|application)\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi, '')
    // very large base64 rasters (rare full-bleed photos) → light neutral swatch;
    // small SVGs (logo, nodal motif) stay so the cover still reads as the brand
    .replace(/data:image\/(?:png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]{4000,}/gi,
      'data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%221%22 height=%221%22><rect width=%221%22 height=%221%22 fill=%22%23e6e6e6%22/></svg>')
    .replace(/>\s+</g, '><')
    .replace(/\s{2,}/g, ' ')
    .trim()
  if (out.length > PREVIEW_CARD_CAP) return ''
  return out
}

function rowToTemplate(x) {
  return {
    id: String(x.id),
    scope: x.scope === 'global' ? 'global' : 'user',
    name: x.name || '',
    primaryColor: x.primary_color || '',
    secondaryColor: x.secondary_color || '',
    accentColor: x.accent_color || '',
    backgroundColor: x.background_color || '',
    headingFont: x.heading_font || '',
    bodyFont: x.body_font || '',
    logoDataUrl: x.logo_data_url || '',
    styleNotes: x.style_notes || '',
    iconAssets: x.icon_assets || [],
    previewSlides: x.preview_slides || [],
    coverPlateDataUrl: x.cover_plate_data_url || '',
    minedStyle: x.mined_style || null,
    logoLightDataUrl: x.logo_light_data_url || '',
    readme: x.readme || '',
    brandRules: x.brand_rules || '',
    palette: x.palette || [],
    fontAssets: x.font_assets || [],
    dsCards: x.ds_cards || [],
    // lightweight specimen metadata (group/title/description) for the
    // generation composition brief — present on list/render-cut rows that
    // don't ship the full ds_cards HTML
    ...(x.ds_cards_meta !== undefined ? { dsCardsMeta: x.ds_cards_meta || [] } : {}),
    // list rows carry has-flags instead of the payloads (TEMPLATE_LIST_SELECT)
    ...(x.has_ds_cards !== undefined ? { hasDsCards: !!x.has_ds_cards, hasReadme: !!x.has_readme } : {}),
    // first Templates deck's first slide (extracted + lean) for the grid thumbnail (list rows only)
    ...(x.preview_card_html !== undefined ? { previewCardHtml: extractFirstTemplateSlide(x.preview_card_html) } : {}),
    // selection lives in user_template_selection (selected_by_user computed
    // via LEFT JOIN); rows fetched without the join fall back to the legacy flag
    isSelected: x.selected_by_user !== undefined ? !!x.selected_by_user : !!x.is_selected,
  }
}

// visibility + per-user selection in one shot: the caller sees their own rows
// plus every global row, with isSelected computed from their selection row
const TEMPLATE_SELECT = `
  SELECT t.*, (s.template_id IS NOT NULL) AS selected_by_user
  FROM deck_templates t
  LEFT JOIN user_template_selection s ON s.user_email = $1 AND s.template_id = t.id`

// list path: same visibility join, but the viewer-only payloads (ds_cards
// specimen HTML, readme) never leave the database — a mined design system
// carries MBs of them per row, and the list is fetched on every Studio and
// Settings open. Shipped as has-flags so the grid can still advertise them.
// renderAssets additionally cuts icon_assets in SQL to the kinds the painters
// resolve (icon/image slide refs, illustration theme art) — the backgrounds/
// lockups of a mined bundle are Settings-grid-only and dominate the row size.
const RENDER_ASSET_KINDS_SQL = `
  (SELECT COALESCE(jsonb_agg(e.a ORDER BY e.ord), '[]'::jsonb)
     FROM jsonb_array_elements(t.icon_assets) WITH ORDINALITY AS e(a, ord)
    WHERE (e.a->>'kind') IS NULL OR (e.a->>'kind') IN ('icon', 'image', 'illustration'))`
const templateListSelect = (renderAssets) => `
  SELECT t.id, t.user_email, t.scope, t.name, t.primary_color, t.secondary_color,
         t.accent_color, t.background_color, t.heading_font, t.body_font,
         t.logo_data_url, t.style_notes,
         ${renderAssets ? RENDER_ASSET_KINDS_SQL : 't.icon_assets'} AS icon_assets,
         t.preview_slides,
         t.cover_plate_data_url, t.mined_style, t.logo_light_data_url,
         t.brand_rules, t.palette, t.font_assets, t.is_selected, t.created_at,
         (COALESCE(jsonb_array_length(t.ds_cards), 0) > 0) AS has_ds_cards,
         -- lightweight metadata of the bundle's component/slide specimens
         -- (group/title/description only — the heavy self-contained HTML is
         -- stripped). Feeds the deck generator's composition brief so it can
         -- learn THIS design system's own slide vocabulary; cheap enough to
         -- always ship (KBs, not the MBs of inlined HTML).
         (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                   'group', c->>'group', 'title', c->>'title', 'description', c->>'description')), '[]'::jsonb)
            FROM jsonb_array_elements(t.ds_cards) AS c) AS ds_cards_meta,
         -- The FIRST deck in the Templates section for the Settings grid
         -- thumbnail (the preview renderer, restored after the semantic-tree
         -- engine was removed). 'Templates' is the group our importer assigns to
         -- every multi-slide template deck (dsImport.js), regardless of the DS's
         -- own naming — so this is positional ("first template deck"), not
         -- name-matched. extractFirstTemplateSlide (rowToTemplate) pulls just its
         -- first slide + styles so the payload stays small.
         (SELECT c->>'html'
            FROM jsonb_array_elements(t.ds_cards) WITH ORDINALITY AS e(c, ord)
           WHERE c->>'html' IS NOT NULL AND c->>'group' = 'Templates'
           ORDER BY ord
           LIMIT 1) AS preview_card_html,
         (COALESCE(length(t.readme), 0) > 0) AS has_readme,
         (s.template_id IS NOT NULL) AS selected_by_user
  FROM deck_templates t
  LEFT JOIN user_template_selection s ON s.user_email = $1 AND s.template_id = t.id`

// The heavy bundle payloads only matter to specific consumers (viewer,
// preview font loading) — list endpoints strip them so the Settings grid
// isn't shipping tens of MB of fonts/cards per template row.
export function templateSummary(t) {
  const { dsCards, fontAssets, readme, ...rest } = t
  return {
    ...rest,
    // list rows never fetched the payloads — trust their precomputed flags
    hasDsCards: rest.hasDsCards ?? !!dsCards?.length,
    hasReadme: rest.hasReadme ?? !!readme,
    fontAssets, // fonts stay: DeckSlidePreview loads them for brand-true previews
  }
}

export async function listDeckTemplates(userEmail, userToken, { renderAssets = false } = {}) {
  return withClient(userEmail, userToken, async (c) => {
    const list = `${templateListSelect(renderAssets)}
      WHERE t.user_email = $1 OR t.scope = 'global'
      ORDER BY (t.scope = 'global') DESC, t.created_at ASC, t.id ASC`
    let r = await c.query(list, [userEmail])
    // seed the Databricks preset only for a user with no personal templates
    // AND no org-wide (global) template to fall back on — once an admin
    // publishes a global design system, new users start from that instead
    if (!r.rows.length) {
      const ins = await c.query(
        `INSERT INTO deck_templates
           (user_email, name, primary_color, secondary_color, accent_color, background_color, heading_font, body_font, style_notes, is_selected)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true) RETURNING id`,
        [
          userEmail,
          DATABRICKS_PRESET.name,
          DATABRICKS_PRESET.primaryColor,
          DATABRICKS_PRESET.secondaryColor,
          DATABRICKS_PRESET.accentColor,
          DATABRICKS_PRESET.backgroundColor,
          DATABRICKS_PRESET.headingFont,
          DATABRICKS_PRESET.bodyFont,
          DATABRICKS_PRESET.styleNotes,
        ]
      )
      await c.query(
        `INSERT INTO user_template_selection (user_email, template_id) VALUES ($1, $2)
         ON CONFLICT (user_email) DO NOTHING`,
        [userEmail, ins.rows[0].id]
      )
      r = await c.query(list, [userEmail])
    }
    const rows = r.rows.map(rowToTemplate)
    // no selection row (fresh user with globals only, or their selection
    // cascaded away with a deleted template) → first visible acts as selected
    if (rows.length && !rows.some((t) => t.isSelected)) rows[0] = { ...rows[0], isSelected: true }
    return rows
  })
}

// Every consumer of the *selected* template (generation prompt, PPTX export,
// the /selected render endpoint) only resolves icon/image/illustration assets,
// so this always takes the render cut — the full asset library stays behind
// the list/detail endpoints for the Settings grid.
// The selected template is read on the hot path of EVERY chat turn, but its
// heavy render-cut payload (preview_slides/palette/font_assets/mined_style/
// cover plate — can be MBs of jsonb) changes only when the user edits/selects/
// deletes a template. So memoize it per user with a short TTL and invalidate
// explicitly on writes. TTL is a backstop for cross-process edits (this app can
// run multiple replicas); the explicit bump covers same-process edits instantly.
const SELECTED_TEMPLATE_TTL_MS = 60 * 1000
const selectedTemplateCache = new Map() // email -> { ts, template }

// Bumped by every template write (create/update/select/delete/scope) so the
// next hot-path read re-fetches instead of serving a stale bundle.
export function invalidateSelectedTemplate(userEmail) {
  if (userEmail) selectedTemplateCache.delete(userEmail)
  else selectedTemplateCache.clear()
}

export async function getSelectedDeckTemplate(userEmail, userToken) {
  const hit = selectedTemplateCache.get(userEmail)
  if (hit && Date.now() - hit.ts < SELECTED_TEMPLATE_TTL_MS) return hit.template
  const templates = await listDeckTemplates(userEmail, userToken, { renderAssets: true })
  const template = templates.find((t) => t.isSelected) || templates[0] || null
  selectedTemplateCache.set(userEmail, { ts: Date.now(), template })
  return template
}

export async function createDeckTemplate(userEmail, userToken, tpl) {
  invalidateSelectedTemplate()
  return withClient(userEmail, userToken, async (c) => {
    const existing = await c.query(`SELECT COUNT(*)::int AS n FROM deck_templates WHERE user_email = $1`, [
      userEmail,
    ])
    const isFirst = existing.rows[0].n === 0 // first PERSONAL template
    const r = await c.query(
      `INSERT INTO deck_templates
         (user_email, name, primary_color, secondary_color, accent_color, background_color, heading_font, body_font, logo_data_url, style_notes, icon_assets, preview_slides, cover_plate_data_url, mined_style, logo_light_data_url, readme, brand_rules, palette, font_assets, ds_cards, is_selected)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21) RETURNING *`,
      [
        userEmail,
        tpl.name || null,
        tpl.primaryColor || null,
        tpl.secondaryColor || null,
        tpl.accentColor || null,
        tpl.backgroundColor || null,
        tpl.headingFont || null,
        tpl.bodyFont || null,
        tpl.logoDataUrl || null,
        tpl.styleNotes || null,
        JSON.stringify(tpl.iconAssets || []),
        JSON.stringify(tpl.previewSlides || []),
        tpl.coverPlateDataUrl || null,
        tpl.minedStyle ? JSON.stringify(tpl.minedStyle) : null,
        tpl.logoLightDataUrl || null,
        tpl.readme || null,
        tpl.brandRules || null,
        JSON.stringify(tpl.palette || []),
        JSON.stringify(tpl.fontAssets || []),
        JSON.stringify(tpl.dsCards || []),
        isFirst,
      ]
    )
    // becomes the selection only when the user hasn't selected anything yet
    // (e.g. they may already be using a global template)
    const sel = await c.query(
      `INSERT INTO user_template_selection (user_email, template_id) VALUES ($1, $2)
       ON CONFLICT (user_email) DO NOTHING RETURNING template_id`,
      [userEmail, r.rows[0].id]
    )
    return rowToTemplate({ ...r.rows[0], selected_by_user: sel.rows.length > 0 })
  })
}

// Bundle-heavy columns (readme/palette/font_assets/ds_cards/logo_light) are
// only rewritten when the caller actually sends them — the Settings form
// edits identity fields off a SUMMARY row (see templateSummary) and must not
// blank out payloads it never loaded.
export async function updateDeckTemplate(userEmail, userToken, id, tpl, isAdmin = false) {
  // a global edit affects every user's hot-path read, so clear the whole cache
  invalidateSelectedTemplate()
  return withClient(userEmail, userToken, async (c) => {
    const r = await c.query(
      `UPDATE deck_templates SET
         name = $1, primary_color = $2, secondary_color = $3, accent_color = $4, background_color = $5,
         heading_font = $6, body_font = $7, logo_data_url = $8, style_notes = $9,
         icon_assets = $10, preview_slides = $11, cover_plate_data_url = $12, mined_style = $13,
         logo_light_data_url = COALESCE($14, logo_light_data_url),
         readme = COALESCE($15, readme),
         brand_rules = COALESCE($16, brand_rules),
         palette = COALESCE($17, palette),
         font_assets = COALESCE($18, font_assets),
         ds_cards = COALESCE($19, ds_cards),
         updated_at = NOW()
       WHERE id = $20 AND (user_email = $21 OR (scope = 'global' AND $22)) RETURNING id`,
      [
        tpl.name || null,
        tpl.primaryColor || null,
        tpl.secondaryColor || null,
        tpl.accentColor || null,
        tpl.backgroundColor || null,
        tpl.headingFont || null,
        tpl.bodyFont || null,
        tpl.logoDataUrl || null,
        tpl.styleNotes || null,
        JSON.stringify(tpl.iconAssets || []),
        JSON.stringify(tpl.previewSlides || []),
        tpl.coverPlateDataUrl || null,
        tpl.minedStyle ? JSON.stringify(tpl.minedStyle) : null,
        tpl.logoLightDataUrl !== undefined ? tpl.logoLightDataUrl || '' : null,
        tpl.readme !== undefined ? tpl.readme || '' : null,
        tpl.brandRules !== undefined ? tpl.brandRules || '' : null,
        tpl.palette !== undefined ? JSON.stringify(tpl.palette || []) : null,
        tpl.fontAssets !== undefined ? JSON.stringify(tpl.fontAssets || []) : null,
        tpl.dsCards !== undefined ? JSON.stringify(tpl.dsCards || []) : null,
        id,
        userEmail,
        isAdmin,
      ]
    )
    return r.rows.length > 0
  })
}

export async function getDeckTemplate(userEmail, userToken, id) {
  return withClient(userEmail, userToken, async (c) => {
    const r = await c.query(
      `${TEMPLATE_SELECT} WHERE t.id = $2 AND (t.user_email = $1 OR t.scope = 'global')`,
      [userEmail, id]
    )
    return r.rows.length ? rowToTemplate(r.rows[0]) : null
  })
}

export async function selectDeckTemplate(userEmail, userToken, id) {
  invalidateSelectedTemplate(userEmail)
  return withClient(userEmail, userToken, async (c) => {
    const visible = await c.query(
      `SELECT 1 FROM deck_templates WHERE id = $1 AND (user_email = $2 OR scope = 'global')`,
      [id, userEmail]
    )
    if (!visible.rows.length) return false
    await c.query(
      `INSERT INTO user_template_selection (user_email, template_id) VALUES ($1, $2)
       ON CONFLICT (user_email) DO UPDATE SET template_id = EXCLUDED.template_id, updated_at = NOW()`,
      [userEmail, id]
    )
    return true
  })
}

// admins may edit/delete global rows; everyone else only their own — the
// route computes isAdmin (authz.js) and the SQL mirrors it so a route bug
// can never silently cross-write another user's template
export async function deleteDeckTemplate(userEmail, userToken, id, isAdmin = false) {
  invalidateSelectedTemplate()
  return withClient(userEmail, userToken, async (c) => {
    const r = await c.query(
      `DELETE FROM deck_templates
       WHERE id = $1 AND (user_email = $2 OR (scope = 'global' AND $3)) RETURNING id`,
      [id, userEmail, isAdmin]
    )
    return r.rows.length > 0
  })
}

export async function setDeckTemplateScope(userEmail, userToken, id, scope) {
  invalidateSelectedTemplate()
  return withClient(userEmail, userToken, async (c) => {
    // demoting a global row hands ownership to the acting admin so it doesn't
    // become an orphan visible to nobody
    const r = await c.query(
      `UPDATE deck_templates
       SET scope = $1, user_email = CASE WHEN $1 = 'user' THEN $2 ELSE user_email END, updated_at = NOW()
       WHERE id = $3 AND (user_email = $2 OR scope = 'global') RETURNING id`,
      [scope, userEmail, id]
    )
    return r.rows.length > 0
  })
}

// ---- app admins (authz.js resolves owner/groups on top of these rows) -------

export async function listAppAdmins(userEmail, userToken) {
  return withClient(userEmail, userToken, async (c) => {
    const r = await c.query(`SELECT principal, kind, added_by, created_at FROM app_admins ORDER BY created_at ASC`)
    return r.rows.map((x) => ({
      principal: x.principal,
      kind: x.kind === 'group' ? 'group' : 'user',
      addedBy: x.added_by,
      createdAt: x.created_at,
    }))
  })
}

export async function addAppAdmin(userEmail, userToken, principal, kind) {
  await withClient(userEmail, userToken, async (c) => {
    await c.query(
      `INSERT INTO app_admins (principal, kind, added_by) VALUES ($1, $2, $3)
       ON CONFLICT (principal) DO UPDATE SET kind = EXCLUDED.kind`,
      [principal, kind, userEmail]
    )
  })
}

export async function removeAppAdmin(userEmail, userToken, principal) {
  await withClient(userEmail, userToken, async (c) => {
    await c.query(`DELETE FROM app_admins WHERE principal = $1`, [principal])
  })
}

// ---- admin: AI cost/usage auditing --------------------------------------
// Aggregates token usage from assistant messages (which carry model +
// prompt/completion tokens) joined to their session (which carries the owner
// email). Returns raw token sums grouped three ways — per user, per model, and
// a per-user-per-day time series — so the caller can price them with the
// MODELS catalog and slice/visualize freely. NOT user-scoped: this is an admin
// audit surface, so it MUST only be reached behind requireAdmin. The optional
// [from,to] window filters by message creation time (ISO strings or null).
export async function getUsageStats(userEmail, userToken, { from = null, to = null } = {}) {
  return withClient(userEmail, userToken, async (c) => {
    // shared WHERE: assistant rows with a known model and recorded tokens,
    // within the optional window. Active-only so regenerated-away variants
    // aren't double-counted.
    const where = `m.role = 'assistant' AND m.model IS NOT NULL AND m.active = true
                   AND ($1::timestamptz IS NULL OR m.created_at >= $1)
                   AND ($2::timestamptz IS NULL OR m.created_at <  $2)`
    const params = [from, to]

    const byUserModel = await c.query(
      `SELECT s.user_email, m.model,
              COUNT(*)::bigint AS turns,
              COALESCE(SUM(m.prompt_tokens), 0)::bigint AS prompt_tokens,
              COALESCE(SUM(m.completion_tokens), 0)::bigint AS completion_tokens
         FROM chat_messages m
         JOIN chat_sessions s ON s.id = m.session_id
        WHERE ${where}
        GROUP BY s.user_email, m.model
        ORDER BY s.user_email, m.model`,
      params
    )

    const daily = await c.query(
      `SELECT s.user_email,
              to_char(date_trunc('day', m.created_at), 'YYYY-MM-DD') AS day,
              m.model,
              COALESCE(SUM(m.prompt_tokens), 0)::bigint AS prompt_tokens,
              COALESCE(SUM(m.completion_tokens), 0)::bigint AS completion_tokens
         FROM chat_messages m
         JOIN chat_sessions s ON s.id = m.session_id
        WHERE ${where}
        GROUP BY s.user_email, day, m.model
        ORDER BY day ASC`,
      params
    )

    const num = (x) => Number(x) || 0
    return {
      byUserModel: byUserModel.rows.map((r) => ({
        userEmail: r.user_email,
        model: r.model,
        turns: num(r.turns),
        promptTokens: num(r.prompt_tokens),
        completionTokens: num(r.completion_tokens),
      })),
      daily: daily.rows.map((r) => ({
        userEmail: r.user_email,
        day: r.day,
        model: r.model,
        promptTokens: num(r.prompt_tokens),
        completionTokens: num(r.completion_tokens),
      })),
    }
  })
}

// ---- admin-curated model catalog overrides ------------------------------
export async function listModelOverrides(userEmail, userToken) {
  return withClient(userEmail, userToken, async (c) => {
    const r = await c.query(
      `SELECT endpoint_id, enabled, display_name, blurb, sort_order, price_in, price_out, updated_by, updated_at
         FROM model_catalog_overrides`
    )
    const map = {}
    for (const x of r.rows) {
      map[x.endpoint_id] = {
        endpointId: x.endpoint_id,
        enabled: !!x.enabled,
        displayName: x.display_name || '',
        blurb: x.blurb || '',
        sortOrder: x.sort_order,
        priceIn: x.price_in,
        priceOut: x.price_out,
        updatedBy: x.updated_by || '',
        updatedAt: x.updated_at,
      }
    }
    return map
  })
}

export async function upsertModelOverride(
  userEmail,
  userToken,
  endpointId,
  { enabled, displayName, blurb, sortOrder, priceIn, priceOut }
) {
  await withClient(userEmail, userToken, async (c) => {
    await c.query(
      `INSERT INTO model_catalog_overrides (endpoint_id, enabled, display_name, blurb, sort_order, price_in, price_out, updated_by, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
       ON CONFLICT (endpoint_id) DO UPDATE SET
         enabled = EXCLUDED.enabled,
         display_name = EXCLUDED.display_name,
         blurb = EXCLUDED.blurb,
         sort_order = EXCLUDED.sort_order,
         price_in = EXCLUDED.price_in,
         price_out = EXCLUDED.price_out,
         updated_by = EXCLUDED.updated_by,
         updated_at = NOW()`,
      [endpointId, !!enabled, displayName || null, blurb || null, sortOrder ?? null, priceIn ?? null, priceOut ?? null, userEmail]
    )
  })
}

// Reorders enabled models: assigns sequential sort_order from the given ordered
// list of endpoint ids (index 0 → lowest sort_order → first in the picker → the
// default model for new chats). Only touches sort_order — enabled/prices/names
// are untouched. Rows are UPSERTed so an id without a prior override still gets
// ordered. Runs in a single transaction so the ordering is atomic.
export async function reorderModelOverrides(userEmail, userToken, orderedIds) {
  await withClient(userEmail, userToken, async (c) => {
    await c.query('BEGIN')
    try {
      for (let i = 0; i < orderedIds.length; i++) {
        await c.query(
          `INSERT INTO model_catalog_overrides (endpoint_id, enabled, sort_order, updated_by, updated_at)
             VALUES ($1, TRUE, $2, $3, NOW())
           ON CONFLICT (endpoint_id) DO UPDATE SET
             sort_order = EXCLUDED.sort_order,
             updated_by = EXCLUDED.updated_by,
             updated_at = NOW()`,
          [orderedIds[i], i, userEmail]
        )
      }
      await c.query('COMMIT')
    } catch (e) {
      await c.query('ROLLBACK')
      throw e
    }
  })
}

// Seed the catalog from the static MODELS list the FIRST time an admin opens
// the models tab and no overrides exist yet — so switching /api/models to
// "enabled only" never leaves the org with zero models. Idempotent: only
// inserts rows that don't exist.
export async function seedModelOverridesIfEmpty(userEmail, userToken, seedRows) {
  return withClient(userEmail, userToken, async (c) => {
    const existing = await c.query(`SELECT COUNT(*)::int AS n FROM model_catalog_overrides`)
    if (existing.rows[0].n > 0) return false
    for (let i = 0; i < seedRows.length; i++) {
      const s = seedRows[i]
      // the default catalog enables the curated chat families (Claude, the
      // GPT-5.6 trio, Gemini Flash, Llama 4, GLM, Qwen) with their known list
      // prices pre-filled; a curated model flagged defaultOn:false (e.g. GPT-5
      // mini, GPT-OSS) is NOT enabled here but stays one click away in "Add
      // model" (prices already known → no cost prompt).
      const enabled = s.defaultOn !== false
      await c.query(
        `INSERT INTO model_catalog_overrides (endpoint_id, enabled, display_name, blurb, sort_order, price_in, price_out, updated_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (endpoint_id) DO NOTHING`,
        [s.id, enabled, s.label || null, s.blurb || null, i, s.in ?? null, s.out ?? null, userEmail]
      )
    }
    return true
  })
}

// ---- per-user adopted external MCP connections --------------------------
export async function listUserMcpConnections(userEmail, userToken) {
  return withClient(userEmail, userToken, async (c) => {
    const r = await c.query(
      `SELECT connection_name, comment, status, last_checked_at, created_at
         FROM user_mcp_connections WHERE user_email = $1 ORDER BY created_at ASC`,
      [userEmail]
    )
    return r.rows.map((x) => ({
      connectionName: x.connection_name,
      comment: x.comment || '',
      status: x.status || 'unknown',
      lastCheckedAt: x.last_checked_at,
      createdAt: x.created_at,
    }))
  })
}

export async function adoptUserMcpConnection(userEmail, userToken, connectionName, comment, status) {
  await withClient(userEmail, userToken, async (c) => {
    await c.query(
      `INSERT INTO user_mcp_connections (user_email, connection_name, comment, status, last_checked_at)
         VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (user_email, connection_name) DO UPDATE SET
         comment = EXCLUDED.comment,
         status = EXCLUDED.status,
         last_checked_at = NOW()`,
      [userEmail, connectionName, comment || null, status || 'unknown']
    )
  })
}

export async function setUserMcpStatus(userEmail, userToken, connectionName, status) {
  await withClient(userEmail, userToken, async (c) => {
    await c.query(
      `UPDATE user_mcp_connections SET status = $3, last_checked_at = NOW()
         WHERE user_email = $1 AND connection_name = $2`,
      [userEmail, connectionName, status]
    )
  })
}

export async function forgetUserMcpConnection(userEmail, userToken, connectionName) {
  await withClient(userEmail, userToken, async (c) => {
    await c.query(`DELETE FROM user_mcp_connections WHERE user_email = $1 AND connection_name = $2`, [
      userEmail,
      connectionName,
    ])
  })
}

// ---- authored skills ----------------------------------------------------
function shapeSkill(x) {
  return {
    id: String(x.id),
    scope: x.scope,
    ownerEmail: x.owner_email || null,
    name: x.name,
    title: x.title,
    description: x.description,
    body: x.body,
    triggers: Array.isArray(x.triggers) ? x.triggers : [],
    embedding: x.embedding || null,
    source: x.source || 'write',
    enabled: !!x.enabled,
    createdBy: x.created_by || '',
    updatedAt: x.updated_at,
  }
}

// Every skill this user can see: all global skills ∪ their own. `includeBody`
// false trims the (large) body/embedding for list views; the router needs
// them, the settings list doesn't.
export async function listSkills(userEmail, userToken, { includeBody = true } = {}) {
  return withClient(userEmail, userToken, async (c) => {
    const cols = includeBody
      ? `id, scope, owner_email, name, title, description, body, triggers, embedding, source, enabled, created_by, updated_at`
      : `id, scope, owner_email, name, title, description, '' AS body, triggers, NULL AS embedding, source, enabled, created_by, updated_at`
    const r = await c.query(
      `SELECT ${cols} FROM skills
        WHERE scope = 'global' OR (scope = 'user' AND owner_email = $1)
        ORDER BY scope DESC, updated_at DESC`,
      [userEmail]
    )
    return r.rows.map(shapeSkill)
  })
}

export async function getSkill(userEmail, userToken, id) {
  return withClient(userEmail, userToken, async (c) => {
    const r = await c.query(
      `SELECT id, scope, owner_email, name, title, description, body, triggers, embedding, source, enabled, created_by, updated_at
         FROM skills WHERE id = $1 AND (scope = 'global' OR (scope = 'user' AND owner_email = $2))`,
      [id, userEmail]
    )
    return r.rows.length ? shapeSkill(r.rows[0]) : null
  })
}

// Insert or update a skill. `scope` decides ownership: 'global' rows have a
// NULL owner (the caller must be admin — enforced at the route); 'user' rows
// belong to the caller. Returns the row's id.
export async function upsertSkill(userEmail, userToken, { id, scope, name, title, description, body, triggers, source, enabled }) {
  return withClient(userEmail, userToken, async (c) => {
    const owner = scope === 'global' ? null : userEmail
    const trig = JSON.stringify(Array.isArray(triggers) ? triggers : [])
    if (id) {
      // update in place, but only a row the caller may touch (own user row, or
      // any global row when this is a global-scoped call from an admin route)
      const r = await c.query(
        `UPDATE skills SET name=$3, title=$4, description=$5, body=$6, triggers=$7::jsonb,
           enabled=$8, embedding=NULL, updated_at=NOW()
         WHERE id=$1 AND (
           (scope='user' AND owner_email=$2) OR (scope='global' AND $9='global')
         )
         RETURNING id`,
        [id, userEmail, name, title, description, body, trig, enabled !== false, scope]
      )
      return r.rows[0] ? String(r.rows[0].id) : null
    }
    const r = await c.query(
      `INSERT INTO skills (scope, owner_email, name, title, description, body, triggers, source, enabled, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10) RETURNING id`,
      [scope || 'user', owner, name, title, description, body, trig, source || 'write', enabled !== false, userEmail]
    )
    return String(r.rows[0].id)
  })
}

export async function setSkillEmbedding(userEmail, userToken, id, vec) {
  await withClient(userEmail, userToken, async (c) => {
    await c.query(`UPDATE skills SET embedding = $2 WHERE id = $1`, [id, vec])
  })
}

export async function deleteSkill(userEmail, userToken, id, { allowGlobal = false } = {}) {
  return withClient(userEmail, userToken, async (c) => {
    const r = await c.query(
      `DELETE FROM skills
         WHERE id = $1 AND ((scope='user' AND owner_email=$2) OR (scope='global' AND $3))
       RETURNING id`,
      [id, userEmail, allowGlobal]
    )
    return r.rows.length > 0
  })
}

// Decks are drawn by the model as a structured `deck` prism-block (see
// blocks.js) and persisted here so the Deck Studio can reload/edit/export
// them independent of the chat message's own stored content.
export async function createDeck(userEmail, userToken, sessionId, title, slides, meta) {
  return withClient(userEmail, userToken, async (c) => {
    const r = await c.query(
      `INSERT INTO chat_decks (session_id, user_email, title, slides, meta) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [sessionId, userEmail, title, JSON.stringify(slides), JSON.stringify(meta || {})]
    )
    return String(r.rows[0].id)
  })
}

export async function getDeck(userEmail, userToken, deckId) {
  return withClient(userEmail, userToken, async (c) => {
    const r = await c.query(`SELECT id, session_id, title, slides, meta FROM chat_decks WHERE id = $1 AND user_email = $2`, [
      deckId,
      userEmail,
    ])
    if (!r.rows.length) return null
    const x = r.rows[0]
    // sessionId lets an editor pull the originating conversation for grounding;
    // kept off the enumerable spread so it never leaks into the persisted meta.
    return { id: String(x.id), sessionId: x.session_id != null ? String(x.session_id) : null, title: x.title, slides: x.slides || [], ...(x.meta || {}) }
  })
}

export async function updateDeckSlides(userEmail, userToken, deckId, title, slides, meta) {
  await withClient(userEmail, userToken, async (c) => {
    await c.query(
      `UPDATE chat_decks SET title = $1, slides = $2, meta = $3, updated_at = NOW() WHERE id = $4 AND user_email = $5`,
      [title, JSON.stringify(slides), JSON.stringify(meta || {}), deckId, userEmail]
    )
  })
}

// ---- spreadsheets (see sanitizeSpreadsheet in blocks.js) — mirrors the deck
// helpers above: the model draws a `spreadsheet` prism-block, persisted here so
// it can be reloaded/exported (server/xlsx-export.js) independent of the message.
export async function createSpreadsheet(userEmail, userToken, sessionId, title, spec) {
  return withClient(userEmail, userToken, async (c) => {
    const r = await c.query(
      `INSERT INTO chat_spreadsheets (session_id, user_email, title, spec) VALUES ($1, $2, $3, $4) RETURNING id`,
      [sessionId, userEmail, title, JSON.stringify(spec || {})]
    )
    return String(r.rows[0].id)
  })
}

export async function getSpreadsheet(userEmail, userToken, sheetId) {
  return withClient(userEmail, userToken, async (c) => {
    const r = await c.query(`SELECT id, title, spec FROM chat_spreadsheets WHERE id = $1 AND user_email = $2`, [
      sheetId,
      userEmail,
    ])
    if (!r.rows.length) return null
    const x = r.rows[0]
    return { id: String(x.id), title: x.title, ...(x.spec || {}) }
  })
}

export async function updateSpreadsheet(userEmail, userToken, sheetId, title, spec) {
  await withClient(userEmail, userToken, async (c) => {
    await c.query(
      `UPDATE chat_spreadsheets SET title = $1, spec = $2, updated_at = NOW() WHERE id = $3 AND user_email = $4`,
      [title, JSON.stringify(spec || {}), sheetId, userEmail]
    )
  })
}

// ---- documents (the model writes a `document` prism-block as markdown) —
// mirrors the deck/spreadsheet helpers: persisted so the Document Studio can
// reload/edit/export (DOCX/Markdown/PDF) independent of the chat message.
export async function createDocument(userEmail, userToken, sessionId, title, markdown) {
  return withClient(userEmail, userToken, async (c) => {
    const r = await c.query(
      `INSERT INTO chat_documents (session_id, user_email, title, markdown) VALUES ($1, $2, $3, $4) RETURNING id`,
      [sessionId, userEmail, title, markdown || '']
    )
    return String(r.rows[0].id)
  })
}

export async function getDocument(userEmail, userToken, docId) {
  return withClient(userEmail, userToken, async (c) => {
    const r = await c.query(`SELECT id, title, markdown FROM chat_documents WHERE id = $1 AND user_email = $2`, [
      docId,
      userEmail,
    ])
    if (!r.rows.length) return null
    const x = r.rows[0]
    return { id: String(x.id), title: x.title, markdown: x.markdown || '' }
  })
}

export async function updateDocument(userEmail, userToken, docId, title, markdown) {
  await withClient(userEmail, userToken, async (c) => {
    await c.query(
      `UPDATE chat_documents SET title = $1, markdown = $2, updated_at = NOW() WHERE id = $3 AND user_email = $4`,
      [title, markdown || '', docId, userEmail]
    )
  })
}

// ---- generated images (bytes on a UC Volume; row keeps the path) — the binary
// sibling of decks/spreadsheets. createImage stores the volume_path that the
// image tool just wrote (see server/imageStore.js); getImage returns the row
// (incl. volume_path) so GET /api/images/:id can stream the bytes back, scoped
// by user_email like every other artifact read.
export async function createImage(userEmail, userToken, sessionId, { prompt, model, volumePath, contentType }) {
  return withClient(userEmail, userToken, async (c) => {
    const r = await c.query(
      `INSERT INTO chat_images (session_id, user_email, prompt, model, volume_path, content_type)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [sessionId, userEmail, prompt || null, model || null, volumePath, contentType || 'image/png']
    )
    return String(r.rows[0].id)
  })
}

export async function getImage(userEmail, userToken, imageId) {
  return withClient(userEmail, userToken, async (c) => {
    const r = await c.query(
      `SELECT id, prompt, model, volume_path, content_type FROM chat_images WHERE id = $1 AND user_email = $2`,
      [imageId, userEmail]
    )
    if (!r.rows.length) return null
    const x = r.rows[0]
    return {
      id: String(x.id),
      prompt: x.prompt || '',
      model: x.model || '',
      volumePath: x.volume_path,
      contentType: x.content_type || 'image/png',
    }
  })
}

// Volume paths for every image in a session — used to purge the Volume files
// before the session (and its cascading chat_images rows) is deleted.
export async function listSessionImagePaths(userEmail, userToken, sessionId) {
  return withClient(userEmail, userToken, async (c) => {
    const r = await c.query(
      `SELECT volume_path FROM chat_images WHERE session_id = $1 AND user_email = $2`,
      [sessionId, userEmail]
    )
    return r.rows.map((x) => x.volume_path).filter(Boolean)
  })
}

// ---- per-user image-generation model selection (mirrors template selection) --
export async function getSelectedImageModel(userEmail, userToken) {
  return withClient(userEmail, userToken, async (c) => {
    const r = await c.query(`SELECT model_id FROM user_image_model_selection WHERE user_email = $1`, [userEmail])
    return r.rows.length ? r.rows[0].model_id : null
  })
}

export async function setSelectedImageModel(userEmail, userToken, modelId) {
  await withClient(userEmail, userToken, async (c) => {
    await c.query(
      `INSERT INTO user_image_model_selection (user_email, model_id) VALUES ($1, $2)
       ON CONFLICT (user_email) DO UPDATE SET model_id = EXCLUDED.model_id, updated_at = NOW()`,
      [userEmail, modelId]
    )
  })
}

// ---- org-wide tool policy (which built-in tool groups are available) --------
// Returns a { [toolKey]: boolean } map of EXPLICIT admin decisions. A key absent
// from the map means "default" (enabled) — callers treat missing as true. Any DB
// error degrades to {} (everything enabled), never blocking the app.
export async function getToolPolicy(userEmail, userToken) {
  return withClient(userEmail, userToken, async (c) => {
    const r = await c.query(`SELECT tool_key, enabled FROM app_tool_policy`)
    const map = {}
    for (const x of r.rows) map[x.tool_key] = !!x.enabled
    return map
  })
}

export async function setToolPolicy(userEmail, userToken, toolKey, enabled) {
  await withClient(userEmail, userToken, async (c) => {
    await c.query(
      `INSERT INTO app_tool_policy (tool_key, enabled, updated_by, updated_at) VALUES ($1, $2, $3, NOW())
       ON CONFLICT (tool_key) DO UPDATE SET enabled = EXCLUDED.enabled, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
      [toolKey, !!enabled, userEmail]
    )
  })
}
