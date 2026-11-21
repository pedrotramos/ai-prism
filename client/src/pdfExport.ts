// Zero-dependency "export to PDF": opens a new window with the exact same
// bundled stylesheet + rendered HTML of one message, forced into the app's
// light theme (dark backgrounds waste ink and look wrong printed), then
// triggers the browser's native print dialog — the user picks "Save as PDF".
// This avoids pulling in a heavy client-side PDF-generation library just for
// an occasional export action.
export function exportMessageToPdf(containerEl: HTMLElement | null | undefined, title = 'Resposta'): void {
  if (!containerEl) return
  const printWindow = window.open('', '_blank', 'width=900,height=1200')
  if (!printWindow) return

  const headHtml = Array.from(document.querySelectorAll('link[rel="stylesheet"], style'))
    .map((n) => n.outerHTML)
    .join('\n')

  printWindow.document.open()
  printWindow.document.write(`<!doctype html>
<html data-theme="light">
<head>
<meta charset="utf-8" />
<title>${title}</title>
${headHtml}
<style>
  html, body { background: #fff; }
  body { padding: 32px; max-width: 860px; margin: 0 auto; }
  @page { margin: 16mm; }
</style>
</head>
<body class="prose-chat"><div id="print-root"></div></body>
</html>`)
  printWindow.document.close()

  const root = printWindow.document.getElementById('print-root') as HTMLElement // written by document.write above
  root.innerHTML = containerEl.innerHTML

  // give the stylesheet + chart SVGs a beat to apply before the print dialog
  // measures layout — without this, charts sometimes print with no styling
  printWindow.focus()
  setTimeout(() => {
    printWindow.print()
  }, 350)
}
