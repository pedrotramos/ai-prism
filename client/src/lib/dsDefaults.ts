// Fallback colours for previewing a design-system template whose own value is
// missing. These stand in for DS data (a company's brand colours), not app
// UI colours, which come from styles/tokens.css, so they live here and
// not as literals in the settings components.
export const DS_FALLBACK = {
  primary: '#1A1A1A', // template.primaryColor
  accent: '#0099FF', // template.accentColor
  background: '#FFFFFF', // template.backgroundColor
  brandDark: '#1A1A2E', // dark brand plate behind a logo
  swatch: '#CCCCCC', // an unset colour role in the inspector
  colorInput: '#000000', // <input type=color> needs a valid #rrggbb
  inkOnLight: '#1A1A1A', // text on a light DS colour
  inkOnDark: '#FFFFFF', // text on a dark DS colour
  paper: '#FFFFFF', // page behind a free-flowing DS specimen card
}
