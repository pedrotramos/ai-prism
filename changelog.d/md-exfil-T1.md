### Security

- **Base da política de saída de URLs (fundação da correção de vazamento por imagem/link, T1).** Novo módulo
  compartilhado `shared/urlEgressPolicy` (cliente e servidor): valida a lista de origens permitidas
  (`EXTERNAL_ASSET_ORIGINS` e a lista do admin; só `https`, sem curinga, IP, caminho, credenciais, no máximo 32,
  nunca os hosts do app, do workspace ou da Databricks), classifica o `src` de uma imagem com o parser de URL do
  navegador (sufixo, subdomínio, userinfo, porta, ponto final, `%2e`, protocolo relativo, `file:` e `ftp:` ficam
  bloqueados) e lista os hosts externos de um markdown ou HTML. Novo `logEgress` (`server/egressLog.ts`) grava
  `egress_blocked` com apenas o host (nunca caminho nem query), com limite por usuário (`EGRESS_LOG_PER_MIN`,
  padrão 60). Nenhuma mudança de comportamento ainda: as próximas tarefas ligam a política.
