// N1b: a project member reads another member's artifact in a shared chat, but
// only its creator edits it. The getters (server/db.js) say `read_only`; every
// write route (save, AI edit with or without preview) answers a reader with this.
// `error` is the stable code the client localizes; `message` is the pt-BR fallback.

export const ARTIFACT_READ_ONLY = 'artifact_read_only'

/** true when `artifact` (a getter's result) belongs to someone else and the caller may only read it. */
export const isReadOnlyArtifact = (artifact) => artifact?.read_only === true || artifact?.readOnly === true

/** Sends 403 artifact_read_only. Returns true so a route can `if (refuseReadOnly(res, x)) return`. */
export function refuseReadOnly(res, artifact) {
  if (!isReadOnlyArtifact(artifact)) return false
  res.status(403).json({
    error: ARTIFACT_READ_ONLY,
    code: ARTIFACT_READ_ONLY,
    message: 'este artefato foi criado por outro membro do projeto: você pode ler e exportar, mas só quem o criou edita',
  })
  return true
}
