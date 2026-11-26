### Security

- **O sanitizador de slides HTML fecha os caminhos de vazamento sem clique (md-exfil T5).** `sanitizeHtmlDeck` agora
  remove handlers `on*`, `javascript:`/`vbscript:`, `<meta>`, `<base>`, `<link>`, `<iframe|frame|object|embed|form>`,
  `ping` e toda referência remota (`src`, `srcset`, `poster`, `href` de mídia, `url()` e `@import`), registrando só o
  host em `egress_blocked`. Estilos inline, SVG, imagens `data:` e `data-ds-asset-id` continuam. O mesmo filtro roda na
  leitura (`GET /api/decks/:id`), então slides antigos ficam limpos sem novo salvamento. Um `data-ds-asset-id` com aspas
  simples agora resolve para o ativo do design system.
  Qualquer `url()` remoto em qualquer valor de atributo (inclusive `cursor` do SVG) ou propriedade CSS é removido, os hosts
  citados em handlers `on*` removidos são registrados (só o host), e os snapshots `deck-html` das mensagens do chat também
  são limpos na leitura (`GET /api/sessions/:id/messages`).
