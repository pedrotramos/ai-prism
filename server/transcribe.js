// Speech/vision understanding for attached audio & video — via a MULTIMODAL LLM.
//
// STRATEGY (rewritten jul/2026): the chat models AI Prism serves through the
// Databricks AI Gateway include Gemini, which ingests audio AND video NATIVELY
// via the OpenAI-compatible `audio_url`/`video_url` content parts (URL or a
// base64 data URI). This replaces the old Whisper `/invocations` ASR hop with a
// single multimodal call, so:
//   - audio is TRANSCRIBED and video is UNDERSTOOD (speech + on-screen content),
//   - the model can follow the user's own instruction directly on the media
//     (summary, action items, decisions, a follow-up email — never hardcoded),
//   - no separate ASR endpoint to provision.
// Verified live (e2-demo-field-eng): the Gemini Flash endpoint returns a
// correct transcript for an `audio_url` data URI; request bodies up to ~20MB are
// accepted (raw media ~15MB), well past the 4MB foundation-model cap because the
// gateway's external-model route is more generous.
//
// WHY NOT "just use the model the user selected": probed live — Claude
// (Sonnet/Opus) rejects audio with "Content type in user messages can only be
// 'text', 'image_url', or 'document'", and GPT-5.6 allows only text/image_url.
// ONLY Gemini ingests audio/video on this gateway. So the media-understanding
// hop ALWAYS routes to Gemini (independent of the chat model); its transcript is
// injected as an attachment and the user's chosen model then does the actual
// task (summary, to-dos, …) on that text. The user keeps their model for the
// reasoning; Gemini is used transparently only to read the media.
//
// LARGE FILES (1h+ meetings): a single request can't carry an hour of raw media.
// The CLIENT segments long audio in the browser (Web Audio API → mono 16kHz WAV
// chunks under the cap — no server ffmpeg, which the Apps runtime lacks) and
// sends each chunk as its own media attachment; the model sees the ordered
// transcript pieces and works across them. Files already under the cap (short
// clips, compressed voice notes, and video within budget) are sent whole so the
// model also captures what's ON SCREEN. This module transcribes ONE buffer;
// chunk orchestration lives client-side + in the /api/chat attachment loop.
//
// GRACEFUL DEGRADATION: any failure throws a TranscriptionError with a human
// message; the caller (index.js) turns it into an attachment note so the turn
// still runs on the prompt + other attachments — same pattern as extractText().

import { reportUsage } from './llm.js'

// Audio/video container + codec extensions we accept. Gemini decodes the common
// containers itself (it extracts the audio track from video), so no local
// transcode is needed for a file that fits one request.
const AUDIO_EXT = ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'flac', 'wma', 'amr', 'aiff']
const VIDEO_EXT = ['mp4', 'mov', 'webm', 'm4v', 'mpeg', 'mpg', 'avi', 'mkv', '3gp']

export const MEDIA_EXTENSIONS = [...AUDIO_EXT, ...VIDEO_EXT]

// Per-file cap for a SINGLE multimodal request. The gateway accepted ~16MB raw
// (≈21MB base64 body) and broke near 32MB, so 15MB is the safe ceiling for one
// hop. Larger media is segmented client-side into sub-cap chunks BEFORE upload,
// so this cap is a backstop, not the user-facing limit on total duration.
const MAX_MEDIA_BYTES = 15 * 1024 * 1024 // 15MB raw → ~20MB base64 body, under the ceiling

// The multimodal model used for media understanding. Gemini is the family that
// accepts audio/video on Databricks; overridable per workspace.
const DEFAULT_MEDIA_MODEL = 'databricks-gemini-3-6-flash'

function ext(name) {
  const i = name.lastIndexOf('.')
  return i >= 0 ? name.slice(i + 1).toLowerCase() : ''
}

export function isMediaFile(filename, mimetype = '') {
  const m = String(mimetype || '')
  if (m.startsWith('audio/') || m.startsWith('video/')) return true
  return MEDIA_EXTENSIONS.includes(ext(filename))
}

function isVideo(filename, mimetype = '') {
  if (String(mimetype || '').startsWith('video/')) return true
  return VIDEO_EXT.includes(ext(filename))
}

// Thrown when media understanding can't be performed. `code` distinguishes a
// config/size problem (actionable) from a generic endpoint failure.
export class TranscriptionError extends Error {
  constructor(message, code = 'failed') {
    super(message)
    this.name = 'TranscriptionError'
    this.code = code
  }
}

function envFlag(v) {
  return v === '1' || String(v).toLowerCase() === 'true'
}

export function transcriptionEnabled() {
  return !envFlag(process.env.TRANSCRIBE_DISABLED)
}

function host() {
  let h = process.env.DATABRICKS_HOST || ''
  if (h && !h.startsWith('http')) h = `https://${h}`
  return h
}

// The multimodal model endpoint name. TRANSCRIBE_ENDPOINT overrides the default
// Gemini model (kept for continuity with existing config); TRANSCRIBE_MODEL is
// an alias. Must be a model that accepts audio/video (Gemini family).
function mediaModel() {
  return (process.env.TRANSCRIBE_MODEL || process.env.TRANSCRIBE_ENDPOINT || DEFAULT_MEDIA_MODEL).trim()
}

// The model id used for media understanding — exported so the chat route can
// disclose "media processed by <this>" alongside the answering model.
export function mediaModelName() {
  return mediaModel()
}

// The invocations URL. An explicit TRANSCRIBE_URL wins; otherwise the standard
// Model Serving path for the chosen model, mirroring llm.js.
function invocationsUrl() {
  const override = (process.env.TRANSCRIBE_URL || '').trim()
  if (override) return override
  return `${host()}/serving-endpoints/${encodeURIComponent(mediaModel())}/invocations`
}

// A best-effort MIME for the data URI. Gemini keys decoding off the URI's media
// type, so map the extension when the upload mimetype is missing/generic.
const EXT_MIME = {
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac',
  ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac',
  wma: 'audio/x-ms-wma', amr: 'audio/amr', aiff: 'audio/aiff',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', m4v: 'video/x-m4v',
  mpeg: 'video/mpeg', mpg: 'video/mpeg', avi: 'video/x-msvideo', mkv: 'video/x-matroska', '3gp': 'video/3gpp',
}
function mimeFor(filename, mimetype) {
  const m = String(mimetype || '')
  if (m && m !== 'application/octet-stream' && (m.startsWith('audio/') || m.startsWith('video/'))) return m
  return EXT_MIME[ext(filename)] || (isVideo(filename, mimetype) ? 'video/mp4' : 'audio/mpeg')
}

// Pulls the assistant text out of a chat/completions response. The gateway
// returns choices[0].message.content as a string or an array of parts.
function extractContent(json) {
  const msg = json?.choices?.[0]?.message
  if (!msg) return ''
  const c = msg.content
  if (typeof c === 'string') return c.trim()
  if (Array.isArray(c)) {
    return c.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('').trim()
  }
  return ''
}

// The default instruction when the caller gives none: a faithful transcript.
// The real turn's prompt drives what happens with the transcript downstream —
// this call just extracts the words/observations so the chat model has them.
const DEFAULT_PROMPT =
  'Transcreva na íntegra a fala deste arquivo, em português quando o áudio estiver em português ' +
  '(ou no idioma falado). Se for vídeo, descreva também brevemente o que aparece na tela quando ' +
  'for relevante. Responda apenas com a transcrição/descrição, sem comentários seus.'

/**
 * Understand an audio/video buffer via a multimodal LLM. Returns
 * { text, usage, model } — the transcript/description plus the token usage and
 * media model, so the caller can disclose the media step's cost. Throws
 * TranscriptionError on any failure so the caller can degrade to a note.
 *
 * @param {string} token    the user's forwarded bearer (on-behalf-of auth)
 * @param {string} filename original filename (for MIME + errors)
 * @param {Buffer} buffer   the raw media bytes (already ≤ cap, or a client chunk)
 * @param {string} mimetype the upload mimetype (best-effort)
 * @param {object} [opts]   { prompt?: string } — instruction sent with the media
 */
export async function transcribe(token, filename, buffer, mimetype = 'application/octet-stream', opts = {}) {
  if (!transcriptionEnabled()) {
    throw new TranscriptionError(
      'A transcrição de áudio/vídeo está desabilitada neste workspace (TRANSCRIBE_DISABLED).',
      'disabled'
    )
  }
  if (!host()) {
    throw new TranscriptionError('DATABRICKS_HOST não configurado — sem modelo multimodal.', 'disabled')
  }
  if (buffer.length > MAX_MEDIA_BYTES) {
    throw new TranscriptionError(
      `arquivo grande demais para uma requisição (${Math.round(buffer.length / 1e6)}MB, máx ${Math.round(
        MAX_MEDIA_BYTES / 1e6
      )}MB). Arquivos longos são segmentados automaticamente no navegador antes do envio.`,
      'too_large'
    )
  }

  const mime = mimeFor(filename, mimetype)
  const partType = mime.startsWith('video/') ? 'video_url' : 'audio_url'
  const dataUri = `data:${mime};base64,${buffer.toString('base64')}`
  const body = JSON.stringify({
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: opts.prompt || DEFAULT_PROMPT },
          { type: partType, [partType]: { url: dataUri } },
        ],
      },
    ],
    max_tokens: 8192,
    // attribute the spend to AI Prism in system.serving.endpoint_usage
    usage_context: { application: 'ai-prism' },
  })

  let res
  try {
    res = await fetch(invocationsUrl(), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body,
    })
  } catch (e) {
    throw new TranscriptionError(`falha de rede ao contatar o modelo multimodal: ${e.message}`)
  }

  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300)
    if (res.status === 404) {
      throw new TranscriptionError(
        `modelo multimodal "${mediaModel()}" não encontrado (HTTP 404). ` +
          'Configure TRANSCRIBE_MODEL para um modelo que aceite áudio/vídeo (família Gemini).',
        'not_configured'
      )
    }
    throw new TranscriptionError(`o modelo multimodal respondeu HTTP ${res.status}: ${detail}`)
  }

  const json = await res.json().catch(() => ({}))
  reportUsage('media', mediaModel(), json.usage)
  const text = extractContent(json)
  if (!text) {
    throw new TranscriptionError('o modelo não retornou texto (mídia vazia, sem fala, ou formato não suportado?)')
  }
  // Return the token usage too so the chat can show the media step's cost (the
  // media model differs from the answering model). Callers that only want the
  // transcript can read `.text`.
  return { text, usage: json.usage || null, model: mediaModel() }
}
