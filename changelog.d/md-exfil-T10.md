### Security

- **O log de saída bloqueada passa a nomear todos os hosts (md-exfil T10).** O extrator de hosts de `url()` e `@import`
  agora usa um tokenizador CSS de verdade (strings, escapes, comentários e bad-url conforme a especificação), então aspas
  ou espaços escapados dentro de `url()` não escondem mais o host. Os hosts citados em handlers `on*` removidos são lidos
  com `new URL()`, cobrindo userinfo, barras escapadas e hosts de um só rótulo. Só telemetria: a saída do sanitizador e a
  aplicação (CSP e sanitizadores) não mudam; o trabalho é linear e continua limitado pelo mesmo teto de tamanho.
