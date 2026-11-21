// Rasterizes a live Recharts <svg> into a downloadable PNG. Recharts sets
// colors via CSS custom properties (var(--faint), var(--border), ...) so
// they follow the app's theme — but those only resolve inside this document.
// A detached SVG loaded into an <img> from a blob URL has no access to this
// page's :root variables, so every var(...) is inlined to its current
// resolved value in the serialized markup before rasterizing.
export function downloadChartAsPng(containerEl: HTMLElement | null | undefined, filename = 'grafico'): void {
  // The chart's SVG is the one Recharts renders inside its ResponsiveContainer
  // (class `.recharts-surface`). Scope to that — a bare querySelector('svg')
  // would match the FIRST <svg> in the card, which is the header's inline
  // download-button icon, so the "export" would download the button glyph.
  // The heatmap is our own SVG (no Recharts), marked data-chart-surface.
  const svg =
    containerEl?.querySelector('svg[data-chart-surface]') ||
    containerEl?.querySelector('.recharts-surface') ||
    containerEl?.querySelector('.recharts-wrapper svg')
  if (!svg) return

  const rootStyle = getComputedStyle(document.documentElement)
  let svgData = new XMLSerializer().serializeToString(svg)
  svgData = svgData.replace(/var\(--([\w-]+)\)/g, (_, name) => {
    const resolved = rootStyle.getPropertyValue(`--${name}`).trim()
    return resolved || '#888888'
  })

  const bg = getComputedStyle(containerEl as HTMLElement).backgroundColor || '#ffffff'
  const scale = 2
  const box: Partial<DOMRect> = svg.getBoundingClientRect?.() || {}
  const width = (svg.clientWidth || box.width || 640) * scale
  const height = (svg.clientHeight || box.height || 260) * scale

  const svgBlob = new Blob([svgData], { type: 'image/svg+xml;charset=utf-8' })
  const url = URL.createObjectURL(svgBlob)
  const img = new Image()
  img.onload = () => {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    // a 2d context is always available for a fresh canvas element
    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D
    ctx.fillStyle = bg
    ctx.fillRect(0, 0, width, height)
    ctx.drawImage(img, 0, 0, width, height)
    URL.revokeObjectURL(url)
    canvas.toBlob((blob) => {
      if (!blob) return
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = `${filename.replace(/[^\w\-]+/g, '_').slice(0, 80) || 'grafico'}.png`
      a.click()
      URL.revokeObjectURL(a.href)
    }, 'image/png')
  }
  img.src = url
}
