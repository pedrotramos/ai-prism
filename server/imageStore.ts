// Binary storage for generated images, on a Unity Catalog Volume. Decks and
// spreadsheets persist as structured JSON and render bytes on demand, but a
// generated image IS bytes with no cheaper representation — so we write the PNG
// to a governed UC Volume and keep only its path in Lakebase (chat_images).
//
// Storage identity: the APP's service principal (same identity that owns the
// Lakebase tables), NOT the per-user OBO token. This is deliberate — an
// app-owned artifact store must not depend on each signed-in user having
// consented to the `files` OAuth scope in their browser session (that consent
// is fragile: it silently lapses whenever the app's scopes change and the user
// hasn't re-logged-in, which is exactly what broke image generation). The SP
// token (all-apis) is always available at runtime and needs no per-user setup.
//
// This does NOT weaken per-user isolation. Isolation is — and always was —
// enforced at the APPLICATION layer: GET /api/images/:id reads the chat_images
// row with `WHERE id = $1 AND user_email = $2`, so a user can only ever resolve
// the volume_path of an image they own; there is no code path that reads a
// client-supplied path. (The Volume itself lives under main.default, whose
// schema grants `account users → ALL PRIVILEGES` — it was workspace-readable
// under the OBO token too, so the OBO path never provided storage-level
// isolation either.) Files are still written under a per-user folder as
// defense-in-depth. See memory project_authz_app_level_isolation.
//
// The volume is provisioned lazily (CREATE VOLUME IF NOT EXISTS) once per
// process, mirroring ensureBuiltinPythonTool in tools.js. If the app has no SP
// credentials (local dev without them), every helper falls back to the caller's
// own token, preserving the original behavior.
import { execStatement } from './warehouse.ts'
import { appServiceToken } from './db.js'
import { logger } from './log.ts'

// Resolve the identity used for Volume/Files API calls: the app SP when
// available, else the passed-in user token. Cached-token lookup is cheap.
async function storageToken(userToken: string): Promise<string> {
  return (await appServiceToken()) || userToken
}

function host(): string {
  let h = process.env.DATABRICKS_HOST || ''
  if (h && !h.startsWith('http')) h = `https://${h}`
  return h
}

// Generated images live in their OWN catalog/schema/volume — kept separate from
// the tools catalog (main.default) so AI Prism's image bytes never mix with a
// workspace's other assets, and so the store can carry its own tight grants.
// Fully configurable via app.yaml: the app owner points these at whatever
// catalog they want (e.g. a dedicated `ai_prism` catalog on a fresh deploy, or
// a personal catalog like `pedro_ramos` on E2_Demo). Defaults to
// ai_prism.default.ai_prism_images. The catalog/schema/volume are provisioned
// at deploy time (bundle/auto_config.py) and lazily here (CREATE IF NOT EXISTS)
// as a fallback.
function catalog(): string {
  return process.env.IMAGE_VOLUME_CATALOG || 'ai_prism'
}
function schema(): string {
  return process.env.IMAGE_VOLUME_SCHEMA || 'default'
}
function volumeName(): string {
  return process.env.IMAGE_VOLUME_NAME || 'ai_prism_images'
}
export function volumeRoot(): string {
  return `/Volumes/${catalog()}/${schema()}/${volumeName()}`
}

let volumeReady = false
// Lazy provisioning of the catalog/schema/volume. This is a self-healing
// FALLBACK — the deploy job (bundle/auto_config.py) already creates the whole
// path and grants the app SP on it, so on a healthy deploy the DDL below is a
// no-op that the byte write doesn't actually depend on. Two things matter:
//   (1) the DDL runs with the USER's token, NOT the SP token — CREATE
//       VOLUME/SCHEMA runs on a SQL Warehouse, and the app SP has no warehouse
//       grant (nor should it need one); the byte write itself uses the Files
//       API with the SP token and touches no warehouse.
//   (2) it's BEST-EFFORT: if provisioning fails (e.g. the volume already exists
//       and the user can't re-create it, or the warehouse is unavailable), we
//       do NOT block the write — the volume is almost certainly already there
//       from deploy. A genuine "volume missing" surfaces as the Files API 404
//       on the actual PUT, with a clear message.
export async function ensureImageVolume(userToken: string): Promise<void> {
  if (volumeReady) return
  try {
    await execStatement(userToken, `CREATE CATALOG IF NOT EXISTS \`${catalog()}\``)
    await execStatement(userToken, `CREATE SCHEMA IF NOT EXISTS \`${catalog()}\`.\`${schema()}\``)
    await execStatement(userToken, `CREATE VOLUME IF NOT EXISTS \`${catalog()}\`.\`${schema()}\`.\`${volumeName()}\``)
  } catch (e) {
    // don't fail the image write on a provisioning hiccup — the volume is
    // provisioned at deploy time; log and proceed to the Files API call.
    logger.warn('ensureImageVolume: lazy provisioning skipped', { err: e })
  }
  volumeReady = true
}

// The Files API addresses a volume file directly by its /Volumes/... path.
function filesUrl(volumePath: string): string {
  return `${host()}/api/2.0/fs/files${volumePath}`
}

/**
 * Decodes a `data:image/png;base64,...` URL and uploads it to the volume under
 * a caller-provided relative path (e.g. `<email-hash>/<uuid>.png`). Returns the
 * absolute volume path stored in chat_images.volume_path. Best-effort volume
 * provisioning happens first.
 */
export async function putImageDataUrl(
  token: string,
  relPath: string,
  dataUrl: string
): Promise<{ volumePath: string; contentType: string; bytes: number }> {
  // provisioning DDL runs as the USER (needs a warehouse; the SP has none);
  // the byte write below uses the SP token (Files API, no warehouse).
  await ensureImageVolume(token)
  const stToken = await storageToken(token)
  const m = /^data:(image\/[a-z0-9.+-]+);base64,(.*)$/is.exec(dataUrl || '')
  if (!m) throw new Error('invalid image data URL')
  // both groups always participate in a successful match of the regex above
  const contentType = m[1]!
  const bytes = Buffer.from(m[2]!, 'base64')
  const volumePath = `${volumeRoot()}/${relPath}`
  const res = await fetch(`${filesUrl(volumePath)}?overwrite=true`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${stToken}`, 'Content-Type': 'application/octet-stream' },
    body: bytes,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Volume write failed (${res.status}): ${text.slice(0, 200)}`)
  }
  return { volumePath, contentType, bytes: bytes.length }
}

/** Reads a volume file back as a Buffer (for GET /api/images/:id). */
export async function getImageBytes(token: string, volumePath: string): Promise<Buffer> {
  const res = await fetch(filesUrl(volumePath), {
    method: 'GET',
    headers: { Authorization: `Bearer ${await storageToken(token)}` },
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Volume read failed (${res.status}): ${text.slice(0, 200)}`)
  }
  const arr = await res.arrayBuffer()
  return Buffer.from(arr)
}

/**
 * Best-effort delete (used when a session is removed, by the user or by the
 * retention sweep). Never throws; resolves true when the file is gone (deleted
 * now, or already absent: 404), false otherwise.
 */
export async function deleteImageFile(token: string, volumePath: string): Promise<boolean> {
  try {
    const res = await fetch(filesUrl(volumePath), {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${await storageToken(token)}` },
    })
    return res.ok || res.status === 404
  } catch {
    // orphaned volume files are harmless; the DB row is the source of truth
    return false
  }
}
