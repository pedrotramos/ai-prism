// Builds the downloadable starter-kit ZIP from the static files committed
// under client/public/starter-kit/ (served by Vite/express as /starter-kit/*).
// The kit is itself a VALID design-system bundle (see INSTRUCOES.md inside) —
// scripts/ds-import-qa.mjs client/public/starter-kit must always import clean.
export async function downloadStarterKit() {
  const JSZip = (await import('jszip')).default
  const files = await (await fetch('/starter-kit/kit-files.json')).json()
  const zip = new JSZip()
  const root = zip.folder('acme-design-system') as InstanceType<typeof JSZip> // folder() returns null only for an empty name
  await Promise.all(
    files.map(async (path: string) => {
      const res = await fetch(`/starter-kit/${path}`)
      if (!res.ok) throw new Error(`kit incompleto: ${path}`)
      root.file(path, await res.arrayBuffer())
    })
  )
  const blob = await zip.generateAsync({ type: 'blob' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'kit-inicial-design-system.zip'
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}
