### Security

- **Web fetch não derruba mais o processo numa falha síncrona de conexão**: o lookup de DNS fixado do
  `web_fetch` (`server/web.js`, `pinnedLookup`) respondia dentro da própria chamada. Quando o `connect()`
  falhava na hora (EHOSTUNREACH/ENETUNREACH, por exemplo um host só com IPv6 num container sem rota IPv6),
  o socket emitia `'error'` antes de o `http` registrar o listener e o Node encerrava. Um `web_fetch`
  induzido por prompt bastava para tirar o app do ar. Agora a resposta vem no tick seguinte e a requisição
  é rejeitada normalmente.
- **Mais prefixos IPv6 de túnel/tradução bloqueados** (`blockedAddressReason`, `server/a2aGuard.js`):
  6to4 `2002::/16` e SIIT `::ffff:0:0/96` têm o IPv4 embutido decodificado e classificado como na forma
  `::ffff:` (por exemplo `2002:7f00:1::` → loopback, `2002:a9fe:a9fe::1` → metadata); Teredo `2001::/32`
  e NAT64 de uso local `64:ff9b:1::/48` são recusados. Vale para o `web_fetch` e para o guard de A2A.
- **Nome de conexão MCP não altera mais a URL do gateway**: `externalMcpUrl` (`server/externalMcp.js`)
  codifica o nome como um único segmento, e `POST`/`DELETE /api/mcp/connections/:name` (e `/probe`)
  respondem 400 `invalid_connection_name` a nomes com `/`, `\`, `?`, `#`, `%`, espaços ou só pontos.
  Os nomes existentes (`catálogo.schema.serviço` e nomes antigos de uma parte) seguem iguais.
