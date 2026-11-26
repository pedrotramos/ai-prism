// Name of the sheet the .xlsx export appends with the colour legend (server/xlsx-export.ts, buildInstructionsSheet;
// suffixed " 2", " 3"... when the model already used it). The spreadsheet studio's footer note names it from here, so
// it reads exactly as in the downloaded file, whatever the UI language.
export const INSTRUCTIONS_SHEET_NAME = 'Instruções de Uso'

// The name the export gives the generated sheet: the base name, or " 2", " 3"... when a sheet of the workbook
// already has it (ExcelJS throws on a duplicate; sheet names are case-insensitive). Pure, so the studio footer
// calls it with the preview's sheet names and shows exactly what the downloaded file will have.
export function instructionsSheetName(existing: ReadonlyArray<string | null | undefined>): string {
  const taken = new Set(existing.filter((n): n is string => typeof n === 'string').map((n) => n.toLowerCase()))
  let name: string = INSTRUCTIONS_SHEET_NAME
  for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${INSTRUCTIONS_SHEET_NAME} ${n}`
  return name
}
