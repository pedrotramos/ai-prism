// The export (server/xlsx-export.ts, buildInstructionsSheet) writes the colour legend on a sheet with this name,
// suffixed " 2", " 3"... when the model already used it. The studio's footer note points at that sheet, so it shows
// only when the workbook carries it.
export const INSTRUCTIONS_SHEET_NAME = 'Instruções de Uso'

export function hasInstructionsSheet(sheets: ReadonlyArray<{ name?: string }> | null | undefined): boolean {
  return (sheets ?? []).some((s) => typeof s.name === 'string' && new RegExp(`^${INSTRUCTIONS_SHEET_NAME}( \\d+)?$`).test(s.name))
}
