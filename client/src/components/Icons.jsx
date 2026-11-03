import toolsIconUrl from '../assets/tool-icons/tools.png'
import genieOneIconUrl from '../assets/tool-icons/genie-one.png'
import genieSpacesIconUrl from '../assets/tool-icons/genie-spaces.png'
import ucFunctionsIconUrl from '../assets/tool-icons/uc-functions.png'
import vectorSearchIconUrl from '../assets/tool-icons/vector-search.png'
import mcpExternalIconUrl from '../assets/tool-icons/mcp-external.png'

const img = (src, alt) => (p) => (
  <img
    src={src}
    alt={alt}
    width={p.size || 18}
    height={p.size || 18}
    decoding="async"
    className={p.className}
    style={{ objectFit: 'contain', flexShrink: 0 }}
  />
)

// Illustration-style tool icons (not stroke paths like the rest of this
// file) supplied for each tool category — rendered as images rather than
// redrawn as SVG paths, to keep them pixel-faithful to the originals.
export const ToolsGlyph = img(toolsIconUrl, 'Tools')
export const GenieOne = img(genieOneIconUrl, 'Genie One')
export const GenieSpaces = img(genieSpacesIconUrl, 'Genie Agents')
export const UcFunctions = img(ucFunctionsIconUrl, 'Unity Catalog Functions')
export const VectorSearch = img(vectorSearchIconUrl, 'Vector Search Indexes')
export const McpExternal = img(mcpExternalIconUrl, 'MCPs Externos')

const s = (props) => ({
  width: props.size || 18,
  height: props.size || 18,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: props.sw || 1.8,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  className: props.className,
})

export const Plus = (p) => (
  <svg {...s(p)}><path d="M12 5v14M5 12h14" /></svg>
)
export const Trash = (p) => (
  <svg {...s(p)}><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m2 0v14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V6" /></svg>
)
export const Paperclip = (p) => (
  <svg {...s(p)}><path d="M21.4 11.05 12.25 20.2a5 5 0 0 1-7.07-7.07l9.19-9.19a3 3 0 0 1 4.24 4.24l-9.2 9.19a1 1 0 0 1-1.41-1.41l8.48-8.49" /></svg>
)
export const Mic = (p) => (
  <svg {...s(p)}><rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 10a7 7 0 0 0 14 0M12 19v3" /></svg>
)
export const Send = (p) => (
  <svg {...s(p)}><path d="M12 19V5M5 12l7-7 7 7" /></svg>
)
export const Stop = (p) => (
  <svg {...s(p)}><rect x="6" y="6" width="12" height="12" rx="2.5" fill="currentColor" stroke="none" /></svg>
)
export const Waveform = (p) => (
  <svg {...s(p)}><path d="M3 12h2M8 7v10M12 4v16M16 8v8M20 11h1" /></svg>
)
export const Settings = (p) => (
  <svg {...s(p)}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
)
export const Sun = (p) => (
  <svg {...s(p)}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>
)
export const Moon = (p) => (
  <svg {...s(p)}><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" /></svg>
)
export const Copy = (p) => (
  <svg {...s(p)}><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
)
export const Check = (p) => (
  <svg {...s(p)}><path d="M20 6 9 17l-5-5" /></svg>
)
export const Close = (p) => (
  <svg {...s(p)}><path d="M18 6 6 18M6 6l12 12" /></svg>
)
export const Menu = (p) => (
  <svg {...s(p)}><path d="M3 6h18M3 12h18M3 18h18" /></svg>
)
export const Pencil = (p) => (
  <svg {...s(p)}><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></svg>
)
export const Speaker = (p) => (
  <svg {...s(p)}><path d="M11 5 6 9H2v6h4l5 4zM15.5 8.5a5 5 0 0 1 0 7M19 5a9 9 0 0 1 0 14" /></svg>
)
export const Regenerate = (p) => (
  <svg {...s(p)}><path d="M21 2v6h-6M3 12a9 9 0 0 1 15-6.7L21 8M3 22v-6h6M21 12a9 9 0 0 1-15 6.7L3 16" /></svg>
)
// Curved-arrow undo/redo (Claude Design edit toolbar): a hook that curves back
// on itself with the arrowhead at the tail — mirror for redo.
export const Undo = (p) => (
  <svg {...s(p)}><path d="M9 14 4 9l5-5" /><path d="M4 9h11a5 5 0 0 1 0 10h-1" /></svg>
)
export const Redo = (p) => (
  <svg {...s(p)}><path d="m15 14 5-5-5-5" /><path d="M20 9H9a5 5 0 0 0 0 10h1" /></svg>
)
export const File = (p) => (
  <svg {...s(p)}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></svg>
)
export const Sparkle = (p) => (
  <svg {...s(p)}><path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8" /></svg>
)
// picture frame + sun + mountain — the generic "image" glyph
export const Image = (p) => (
  <svg {...s(p)}><rect x="3" y="3" width="18" height="18" rx="2.5" /><circle cx="8.5" cy="8.5" r="1.6" /><path d="m21 15-4.5-4.5L6 21" /></svg>
)
export const ChevronDown = (p) => (
  <svg {...s(p)}><path d="m6 9 6 6 6-6" /></svg>
)
export const Search = (p) => (
  <svg {...s(p)}><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
)
export const Edit = (p) => (
  <svg {...s(p)}><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.5 2.5a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4z" /></svg>
)
export const Wrench = (p) => (
  <svg {...s(p)}><path d="M14.7 6.3a4 4 0 0 1-5.4 5.4L4 17l3 3 5.3-5.3a4 4 0 0 1 5.4-5.4l-2.3 2.3-2-2z" /></svg>
)
// monochrome toolbox (stroke) — for the admin Tools tab, matching the other
// rail icons (ToolsGlyph is a colored PNG used only for the chat tools trigger)
export const Toolbox = (p) => (
  <svg {...s(p)}><path d="M4 8h16a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z" /><path d="M8 8V6a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 13h18M10 12h4" /></svg>
)
export const Terminal = (p) => (
  <svg {...s(p)}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m7 9 3 3-3 3M13 15h4" /></svg>
)
export const ChevronRight = (p) => (
  <svg {...s(p)}><path d="m9 6 6 6-6 6" /></svg>
)
export const ChevronLeft = (p) => (
  <svg {...s(p)}><path d="m15 6-6 6 6 6" /></svg>
)
export const AlertTriangle = (p) => (
  <svg {...s(p)}><path d="M10.3 3.9 1.8 18a1 1 0 0 0 .87 1.5h18.6a1 1 0 0 0 .87-1.5L13.7 3.9a1 1 0 0 0-1.74 0z" /><path d="M12 9v4M12 17h.01" /></svg>
)
export const Database = (p) => (
  <svg {...s(p)}><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v14c0 1.66 3.58 3 8 3s8-1.34 8-3V5M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3" /></svg>
)
// a document with a folded corner and a table/grid inside — the spreadsheet
// file card icon (replaces the misleading Database cylinder). The page body
// spans x:4→18 (center 11); the grid is centered exactly on that (x:6→16,
// width 10) with roomy cells (3 cols × 3 rows) so it reads clearly small.
export const SpreadsheetFile = (p) => (
  <svg {...s(p)}>
    <path d="M6 2h8l4 4v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z" />
    <path d="M14 2v4h4" />
    <rect x="6" y="10" width="10" height="9" rx="0.6" />
    <path d="M6 13h10M6 16h10M9.33 10v9M12.67 10v9" />
  </svg>
)
export const Plug = (p) => (
  <svg {...s(p)}><path d="M12 22v-5M9 8V2M15 8V2M6 8h12l-1 5a5 5 0 0 1-10 0z" /></svg>
)
export const Download = (p) => (
  <svg {...s(p)}><path d="M12 3v12m0 0 5-5m-5 5-5-5M4 20h16" /></svg>
)
export const Upload = (p) => (
  <svg {...s(p)}><path d="M12 21V9m0 0-5 5m5-5 5 5M4 4h16" /></svg>
)
export const FileText = (p) => (
  <svg {...s(p)}><path d="M6 2h9l5 5v15a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z" /><path d="M14 2v6h6M8 13h8M8 17h8M8 9h3" /></svg>
)
export const History = (p) => (
  <svg {...s(p)}><path d="M3 12a9 9 0 1 0 3-6.7M3 4v5h5" /><path d="M12 7v5l3.5 2" /></svg>
)
export const Presentation = (p) => (
  <svg {...s(p)}><rect x="2" y="3" width="20" height="13" rx="1.5" /><path d="M8 21h8M12 16v5M6 8h4M6 11h7" /></svg>
)
// rich-text editor toolbar glyphs (lucide-standard paths)
export const List = (p) => (
  <svg {...s(p)}><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" /></svg>
)
export const ListOrdered = (p) => (
  <svg {...s(p)}><path d="M10 6h11M10 12h11M10 18h11M4 6h1v4M4 10h2M6 18H4c0-1 2-2 2-3s-1-1.5-2-1" /></svg>
)
export const Quote = (p) => (
  <svg {...s(p)}><path d="M6 17h3l2-4V7H5v6h3zM14 17h3l2-4V7h-6v6h3z" /></svg>
)
export const Link = (p) => (
  <svg {...s(p)}><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1.5 1.5" /><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1.5-1.5" /></svg>
)
export const Eraser = (p) => (
  <svg {...s(p)}><path d="M7 21h10M5 13l6-6 7 7-5 5H8z" /></svg>
)
export const Eye = (p) => (
  <svg {...s(p)}><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z" /><circle cx="12" cy="12" r="3" /></svg>
)
export const Folder = (p) => (
  <svg {...s(p)}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /></svg>
)
export const Play = (p) => (
  <svg {...s(p)}><path d="M7 4.5v15l12-7.5z" /></svg>
)
export const User = (p) => (
  <svg {...s(p)}><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>
)
export const Users = (p) => (
  <svg {...s(p)}><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /></svg>
)
export const Shield = (p) => (
  <svg {...s(p)}><path d="M12 3l8 3v5c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10V6z" /></svg>
)
export const Globe2 = (p) => (
  <svg {...s(p)}><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c-3.5 4-3.5 14 0 18c3.5-4 3.5-14 0-18" /></svg>
)
export const Expand = (p) => (
  <svg {...s(p)}><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" /></svg>
)
export const Shrink = (p) => (
  <svg {...s(p)}><path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7" /></svg>
)
export const Wand = (p) => (
  <svg {...s(p)}><path d="m15 4 5 5L8.5 20.5a2.1 2.1 0 0 1-3-3L17 6" /><path d="M15 4l5 5M9 3l.8 2.2L12 6l-2.2.8L9 9l-.8-2.2L6 6l2.2-.8zM19 13l.6 1.6L21 15l-1.4.6L19 17l-.6-1.4L17 15l1.4-.4z" /></svg>
)
// A faceted prism/gem — the mark for an activated skill (nods to "AI Prism").
// Elegant line form: a hexagonal cut gem with internal facet lines that catch
// the eye without shouting.
export const SkillGlyph = (p) => (
  <svg {...s(p)}>
    <path d="M12 2.5 20 8v8l-8 5.5L4 16V8z" />
    <path d="M12 2.5v19M4 8l8 4 8-4M12 12l-4.5 9.5M12 12l4.5 9.5" />
  </svg>
)
export const Monitor = (p) => (
  <svg {...s(p)}><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></svg>
)
export const Bell = (p) => (
  <svg {...s(p)}><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0" /></svg>
)
export const Languages = (p) => (
  <svg {...s(p)}><path d="M4 5h7M9 3v2c0 4.4-2.7 8-6 8M5 9c0 2.5 3 4.5 6 4.5M12 20l4-9 4 9M14.5 16h5" /></svg>
)
// taxímetro: a speedometer gauge with its needle
export const Gauge = (p) => (
  <svg {...s(p)}><path d="M3.5 17a9 9 0 1 1 17 0" /><path d="M12 13.5 16 9" /><circle cx="12" cy="14" r="1.2" /></svg>
)
