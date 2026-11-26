### Security

- **O sanitizador de slides HTML fecha os caminhos de vazamento sem clique (md-exfil T5).** `sanitizeHtmlDeck` agora
  remove handlers `on*`, `javascript:`/`vbscript:`, `<meta>`, `<base>`, `<link>`, `<iframe|frame|object|embed|form>`,
  `ping` e toda referência remota (`src`, `srcset`, `poster`, `href` de mídia, `url()` e `@import`), registrando só o
  host em `egress_blocked`. Estilos inline, SVG, imagens `data:` e `data-ds-asset-id` continuam. O mesmo filtro roda na
  leitura (`GET /api/decks/:id`), então slides antigos ficam limpos sem novo salvamento. Um `data-ds-asset-id` com aspas
  simples agora resolve para o ativo do design system.
