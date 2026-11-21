// Browser-side audio segmentation for long recordings (1h+ meetings).
//
// The server understands audio/video via a multimodal LLM (Gemini), but a
// single request can only carry ~15MB of media. The Databricks Apps runtime has
// no ffmpeg, so we can't segment server-side — instead we do it HERE with the
// Web Audio API, which every modern browser ships:
//   1. decodeAudioData() decodes ANY container/codec the browser supports
//      (mp3, m4a, ogg/opus, wav, aac, flac, and the audio track of mp4/mov/webm
//      videos) into raw PCM samples.
//   2. we downmix to MONO and resample to 16 kHz (speech-grade — Whisper/Gemini
//      transcribe fine at 16k, and it shrinks the data ~6× vs 44.1k stereo).
//   3. we slice the timeline into chunks whose encoded WAV stays under the cap
//      and emit each as a File, so the existing multipart upload + /api/chat
//      attachment loop transcribes them in order.
//
// A 1h meeting at mono 16k/16-bit is ~115MB of PCM → ~12 chunks of ~13MB WAV,
// each well within one request. Files already small enough are left untouched
// (and, for video within budget, sent whole so the model also sees the screen).

// Keep chunk WAVs comfortably under the server's 15MB per-request cap.
const CHUNK_TARGET_BYTES = 12 * 1024 * 1024 // ~12MB WAV per chunk
const TARGET_RATE = 16000 // 16 kHz mono — speech-grade, small
const BYTES_PER_SAMPLE = 2 // 16-bit PCM

// Files at or below this need no segmentation — send as-is (audio) or whole
// (video, so the model can also read on-screen content). Mirrors the server cap
// minus a margin for the base64 + JSON overhead.
export const CLIENT_MEDIA_LIMIT = 14 * 1024 * 1024

const AUDIO_EXT = ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'flac', 'wma', 'amr', 'aiff']
const VIDEO_EXT = ['mp4', 'mov', 'webm', 'm4v', 'mpeg', 'mpg', 'avi', 'mkv', '3gp']

// Anything with a name/type/size: a File, or a plain object in tests.
type FileLike = Pick<File, 'name' | 'type'>

function ext(name = ''): string {
  const i = name.lastIndexOf('.')
  return i >= 0 ? name.slice(i + 1).toLowerCase() : ''
}
export function isAudioFile(file: FileLike): boolean {
  return (file.type || '').startsWith('audio/') || AUDIO_EXT.includes(ext(file.name))
}
export function isVideoFile(file: FileLike): boolean {
  return (file.type || '').startsWith('video/') || VIDEO_EXT.includes(ext(file.name))
}
export function isMediaFile(file: FileLike): boolean {
  return isAudioFile(file) || isVideoFile(file)
}

// Encode a Float32 PCM slice as a 16-bit mono WAV (RIFF) Blob.
function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const dataLen = samples.length * BYTES_PER_SAMPLE
  const buf = new ArrayBuffer(44 + dataLen)
  const view = new DataView(buf)
  const wr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i))
  }
  wr(0, 'RIFF')
  view.setUint32(4, 36 + dataLen, true)
  wr(8, 'WAVE')
  wr(12, 'fmt ')
  view.setUint32(16, 16, true) // PCM chunk size
  view.setUint16(20, 1, true) // PCM format
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * BYTES_PER_SAMPLE, true) // byte rate
  view.setUint16(32, BYTES_PER_SAMPLE, true) // block align
  view.setUint16(34, 16, true) // bits per sample
  wr(36, 'data')
  view.setUint32(40, dataLen, true)
  let off = 44
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!))
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true)
    off += BYTES_PER_SAMPLE
  }
  return new Blob([buf], { type: 'audio/wav' })
}

// Downmix an AudioBuffer's channels to a single mono Float32Array.
function toMono(audioBuffer: AudioBuffer): Float32Array {
  const ch = audioBuffer.numberOfChannels
  const len = audioBuffer.length
  if (ch === 1) return audioBuffer.getChannelData(0)
  const out = new Float32Array(len)
  for (let c = 0; c < ch; c++) {
    const data = audioBuffer.getChannelData(c)
    for (let i = 0; i < len; i++) out[i]! += data[i]! / ch
  }
  return out
}

// Linear resample mono Float32 samples from srcRate → TARGET_RATE.
function resample(samples: Float32Array, srcRate: number): Float32Array {
  if (srcRate === TARGET_RATE) return samples
  const ratio = srcRate / TARGET_RATE
  const outLen = Math.floor(samples.length / ratio)
  const out = new Float32Array(outLen)
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio
    const i0 = Math.floor(pos)
    const frac = pos - i0
    out[i] = (samples[i0] || 0) * (1 - frac) + (samples[i0 + 1] || 0) * frac
  }
  return out
}

/**
 * Segment one audio (or video's audio track) File into ≤cap mono-16k WAV chunk
 * Files, named "<base> (parte K de N).wav" so they read in order as attachments.
 * Returns [file] unchanged when it already fits, or [] on decode failure (the
 * caller then falls back to sending the original and letting the server note it).
 */
export async function segmentAudioFile(file: File, onProgress?: (done: number, total: number) => void): Promise<File[]> {
  const AC = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AC) return [file] // no Web Audio → send as-is, server caps it
  let audioBuffer: AudioBuffer
  try {
    const arrayBuf = await file.arrayBuffer()
    const ctx = new AC()
    try {
      audioBuffer = await ctx.decodeAudioData(arrayBuf)
    } finally {
      ctx.close?.()
    }
  } catch {
    return [] // undecodable in this browser (e.g. some video codecs) — signal fallback
  }

  const mono = resample(toMono(audioBuffer), audioBuffer.sampleRate)
  // samples per chunk so the encoded WAV (44B header + 2B/sample) stays ≤ target
  const samplesPerChunk = Math.floor((CHUNK_TARGET_BYTES - 44) / BYTES_PER_SAMPLE)
  const total = Math.ceil(mono.length / samplesPerChunk)
  if (total <= 1) {
    // fits in one chunk once compacted to mono-16k — still re-encode so an
    // oversized-but-short-duration source (e.g. lossless) shrinks under the cap
    const wav = encodeWav(mono, TARGET_RATE)
    const base = file.name.replace(/\.[^.]+$/, '')
    return [new File([wav], `${base}.wav`, { type: 'audio/wav' })]
  }
  const base = file.name.replace(/\.[^.]+$/, '')
  const out: File[] = []
  for (let k = 0; k < total; k++) {
    const slice = mono.subarray(k * samplesPerChunk, (k + 1) * samplesPerChunk)
    const wav = encodeWav(slice, TARGET_RATE)
    out.push(new File([wav], `${base} (parte ${k + 1} de ${total}).wav`, { type: 'audio/wav' }))
    onProgress?.(k + 1, total)
  }
  return out
}

/**
 * Expand a file list for upload: oversized audio (and video whose audio must be
 * extracted because it's over budget) is replaced by sub-cap WAV chunks; small
 * media and non-media files pass through untouched. Video within budget is left
 * whole so the model also sees on-screen content.
 *
 */
export async function prepareMediaFiles(
  files: File[],
  onProgress?: (info: { name: string; done: number; total: number }) => void
): Promise<File[]> {
  const out: File[] = []
  for (const f of files) {
    const media = isMediaFile(f)
    const oversized = f.size > CLIENT_MEDIA_LIMIT
    if (!media || !oversized) {
      out.push(f) // non-media, or media that already fits
      continue
    }
    // oversized media → segment its audio in the browser
    const chunks = await segmentAudioFile(f, (done: number, total: number) =>
      onProgress?.({ name: f.name, done, total })
    )
    if (chunks.length) out.push(...chunks)
    else out.push(f) // decode failed — send original; server returns a clear note
  }
  return out
}
