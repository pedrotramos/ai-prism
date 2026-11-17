# Política de Segurança

O AI Prism é um acelerador de solução open-source que você deploya no **seu próprio**
workspace Databricks. Não é um produto oficial da Databricks e não possui SLA. Ainda
assim, levamos vulnerabilidades a sério — este documento explica como reportá-las.

## Reportando uma vulnerabilidade

**Não abra uma issue pública** para relatar uma vulnerabilidade de segurança.

Em vez disso, use o canal privado do GitHub:

1. Acesse a aba **Security** do repositório.
2. Clique em **Report a vulnerability** (GitHub Security Advisories).

Se preferir, abra uma issue mínima **sem detalhes técnicos** pedindo um canal privado
de contato, e a resposta virá por lá.

Inclua no relatório, sempre que possível:

- Uma descrição da vulnerabilidade e do impacto potencial.
- Passos para reproduzir (proof of concept).
- Versões/ambiente afetados (cloud, versão do Databricks CLI, commit).
- Qualquer mitigação que você já tenha identificado.

Faremos o possível para confirmar o recebimento em poucos dias úteis e manter você
informado sobre o progresso até a resolução.

## Escopo

Como cada instalação roda no workspace de quem deploya, tenha em mente o modelo de
confiança do projeto:

- **Isolamento entre usuários é feito no nível da aplicação** (cláusulas `WHERE user_email`),
  sobre uma identidade fornecida pelo proxy da Databricks App. Relatos sobre furos nesse
  isolamento (um usuário acessando dados de outro) são especialmente bem-vindos.
- Autenticação usa **OBO (on-behalf-of) do usuário** para chamadas de API e o **service
  principal do app** para armazenamento próprio (Lakebase, Volume de imagens).
- Segredos (tokens do workspace, credenciais do Lakebase) **nunca** devem ser commitados.
  Veja o [`.env.example`](.env.example) e o [`.gitignore`](.gitignore) — `.env` é ignorado.

## Identidade da requisição

Quem é o usuário vem só do proxy do Databricks Apps (`server/requestIdentity.js`):

- No runtime de Apps (presença de `DATABRICKS_APP_NAME`, `DATABRICKS_APP_PORT` ou
  `DATABRICKS_APP_URL`), a requisição precisa do header `x-forwarded-email` e do
  `x-forwarded-access-token`. Faltando qualquer um, a resposta é **401**. Nenhum e-mail
  ou token vem do ambiente nesse caso.
- Fora do runtime, o ambiente só entra com `LOCAL_DEV_MODE=1` (o `.env.local` do
  `npm run dev:local`) ou `LOCAL_DEV_IDENTITY=1`. `NODE_ENV` não conta: o npm o define
  como `production` nos scripts do repo. Nesse modo o servidor só escuta em
  `127.0.0.1` (`listenHost()`): uma requisição sem headers vira o dono do app, então a
  porta não fica exposta na rede local. No runtime de Apps ele escuta em `0.0.0.0`.

### Vínculo entre e-mail e token (`server/identityBinding.js`)

O e-mail do header escopa todas as consultas, e o Lakebase conecta como o service
principal do app (não como o usuário). Sem vínculo, uma requisição que chegasse ao
processo sem passar pelo proxy, com `x-forwarded-email: <qualquer pessoa>` e qualquer
token, viraria essa pessoa (inclusive o dono/admin). Por isso, a cada requisição
autenticada, o app pergunta ao workspace de quem é o token (`SCIM /Me` com o próprio
token, o mesmo chamado que `server/authz.js` usa para grupos; o escopo
`iam.current-user:read` é concedido automaticamente ao token OBO):

- O e-mail do header precisa ser o `userName` ou um dos `emails` do dono do token
  (comparação sem maiúsculas/minúsculas). Divergência → **401**
  `{"code":"identity_mismatch"}`. Token que o workspace recusa (401, ou 403 "Invalid
  access token") → **401** `{"code":"invalid_token"}`.
- O resultado fica em cache por 5 min, chaveado pelo `sha256` do token (nunca o token
  em claro), num LRU limitado; requisições simultâneas com o mesmo token fazem uma
  consulta só.
- **Disponibilidade primeiro:** se o workspace não responde de forma definitiva
  (timeout de 3 s, 5xx, 403 de escopo, `DATABRICKS_HOST` ausente), a requisição passa e o
  log registra `identity-binding: could not verify…` no máximo uma vez por minuto. Só
  uma resposta definitiva bloqueia.

| `IDENTITY_BINDING` | Efeito |
|---|---|
| (não definido) | `enforce` no runtime de Apps; `off` em dev local |
| `enforce` | Divergência ou token inválido → 401 |
| `warn` | Divergência ou token inválido só gera log (`identity-binding: …`); a requisição passa. Use para diagnosticar um 401 inesperado sem derrubar o app |
| `off` | Sem verificação (o comportamento anterior) |

Defina no `env` do `app.yaml` (o `config.env` do `databricks.yml` não chega ao app).
Valor inválido cai no padrão (`enforce` no runtime): erro de digitação nunca desliga a
checagem.

**O que isto verifica e o que continua dependendo do proxy.** Verificado pelo app: que
o par e-mail/token foi emitido pelo workspace para a mesma pessoa. Continua dependendo da
plataforma: que o proxy autentica o usuário e é o único caminho até o processo, e que ele
sobrescreve (não repassa) os `x-forwarded-*` do cliente. Quem rouba um token válido de
outra pessoa ainda age como ela; isso é o modelo de qualquer bearer token.

## Proteções HTTP

| Proteção | Onde | O que bloqueia |
|---|---|---|
| **CSRF** | `server/csrfGuard.js`, em `/api/*` antes do parse do corpo | `POST`/`PUT`/`PATCH`/`DELETE` vindos de outro site: passa com `Sec-Fetch-Site` `same-origin`/`none`, ou com `Origin` (ou, sem ele, `Referer`) cujo host é o da requisição (`Host`/`X-Forwarded-Host`) ou o de `DATABRICKS_APP_URL`. Requisição sem nenhum dos três cabeçalhos (curl, scripts, `npm run smoke`) passa: não vem de navegador. O resto recebe **403** `{"code":"cross_site_request"}`. Motivo: `/api/chat` aceita `multipart/form-data`, que um `<form>` de outro site envia sem preflight |
| **Cabeçalhos** | `server/securityHeaders.js` | `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`, `X-Frame-Options: SAMEORIGIN`, sem `X-Powered-By` e uma CSP conservadora: `frame-ancestors 'self'; base-uri 'self'; object-src 'none'; form-action 'self'` |
| **Ids numéricos** | `app.param(['id','messageId'])` | Id fora de `^\d{1,18}$` pula a rota e termina em 404, em vez de chegar ao Postgres e voltar como 500 com a mensagem do driver |
| **Erro final** | `finalErrorHandler` (último middleware) | Erro que nenhuma rota tratou (JSON malformado, corpo ou upload grande demais, exceção) vira JSON genérico (`bad_request` 400, `payload_too_large` 413, `internal_error` 500); o detalhe vai só para o log. As rotas que já tratam o próprio erro não mudaram |

**Por que a CSP não restringe scripts, estilos nem imagens.** Iframes `srcdoc` herdam a
CSP da página. O editor de slide injeta um `<script>` inline no iframe, e o design system
importado traz scripts inline, estilos e fontes/imagens de qualquer host. Uma
`script-src`/`style-src`/`img-src`/`font-src` quebraria o preview e a edição de decks
(verificado no Chrome contra o SPA compilado: com a CSP acima não há violação, e script
inline, estilo e fonte rodam em iframes `srcdoc` com e sem sandbox). Apertar a CSP exige
servir esses iframes de uma origem própria antes. HSTS e TLS ficam com o proxy do Apps.

**Depende do proxy:** o `SameSite` do cookie de sessão do Apps e se o proxy acrescenta
os próprios cabeçalhos de segurança não foram verificados. O guard de CSRF não depende
disso: ele recusa a requisição cross-site mesmo que o cookie vá junto.

## Isolamento entre usuários

Todas as conexões Postgres usam a mesma identidade (o service principal do app, ou o
usuário local em dev). Por isso, cada leitura **e cada gravação** precisa filtrar pelo
dono no próprio SQL: `chat_sessions.user_email` e, para o que pertence a uma sessão
(mensagens, tool calls, embeddings, artefatos, conversa Genie), um `EXISTS` sobre a
sessão do chamador. Um id numérico enumerável (BIGSERIAL) não pode ser suficiente.

O que foi reforçado nesta versão:

- **Gravações por id** que antes confiavam numa checagem anterior agora re-checam o dono
  na mesma instrução (`server/ownerScopedWrites.js`): reativação de variantes (o
  `variant_group` vem do cliente), embeddings de mensagem, chamadas de tool, conversa
  Genie (leitura e escrita), embedding de skill e a criação de deck, planilha,
  documento e imagem (sessão alheia dá 404).
- **Testes de dois usuários** em `server/isolation.test.js`, contra as funções reais de
  `db.js`: sessões, mensagens, variantes, tool calls, embeddings e busca semântica,
  artefatos, conexões MCP, skills, Genie e custos. A suíte roda com
  `node --test server/isolation.test.js` contra o Postgres do `npm run local:up` e é
  pulada sem ele. Ela falha no código anterior a estas mudanças (variantes, tool calls,
  embeddings, artefatos, skills e Genie).
- **Escritas que dependem da rota** (sem re-checagem no SQL): `upsertSkill`,
  `deleteSkill`, `updateDeckTemplate`, `deleteDeckTemplate` e `setDeckTemplateScope`
  recebem um flag de admin do chamador e são protegidas pelas rotas
  (`requireAdmin` / `isAdmin`). `getUsageStats` (auditoria de custos de todos os
  usuários) não filtra por dono por desenho: só pode ser exposta atrás de `requireAdmin`.
  Nenhuma rota a usa hoje.

## Conteúdo de terceiros no prompt

Texto que o app não escreve e que vai para o modelo (descrições, instruções e schemas de
tools MCP, títulos e descrições de sala Genie, comentários de funções UC, títulos de
documento) passa por `server/toolMetadata.js`: imperativos ("ignore as instruções"),
rótulos de papel ("system:"), HTML e links são neutralizados, e o texto é limitado em
tamanho. Essa é uma defesa parcial contra injeção de prompt, não uma garantia: o modelo
ainda pode ser influenciado por texto que não casa com os padrões. Por isso o dado de
ferramenta não deve ser tratado como instrução confiável.

Documentos Markdown são gravados sem HTML cru e sem links com esquema perigoso
(`shared/markdownSafety.js`): o editor WYSIWYG renderiza com `innerHTML`, então isso
impede que um membro de projeto execute código no editor de outro.

Quando o app busca uma URL escolhida pelo modelo (ferramenta de página web), a conexão
só segue para endereços públicos: loopback, redes privadas, CGNAT, link-local (incluindo o
endpoint de metadados de nuvem), ULA e reservados ficam bloqueados, em cada salto de
redirecionamento. A mesma regra está em `server/a2aGuard.js`, que será usado pelo A2A.

## TLS para o Postgres (Lakebase)

Por padrão a conexão ao Postgres é **criptografada, mas a cadeia do certificado não é
verificada** (`ssl: { rejectUnauthorized: false }` em `server/db.js`, função
`pgSslOptions`). Essa é a escolha histórica do projeto, e ela tem um custo que você deve
conhecer:

- **Por que existe**: o código não registra a justificativa original. A razão provável é
  operacional: o app não empacota a CA do Lakebase, então a validação com o trust store
  padrão do Node falharia sem configuração extra. Os knobs abaixo tornam a CA configurável
  sem mudar o padrão.
- **Modelo de ameaça**: a conexão sai do container do app para o endpoint do Lakebase
  dentro da rede do workspace. Sem verificação, um atacante capaz de interceptar esse
  caminho poderia se passar pelo endpoint e receber o token do service principal ou a
  credencial do usuário (que é o próprio token OBO, usado como senha). O risco é menor que
  em uma rede pública, mas não é zero.
- **Como fechar**: forneça a CA e a verificação é ligada automaticamente.

| Variável | Efeito |
|---|---|
| (nenhuma) | Criptografado, cadeia não verificada (padrão, sem mudança) |
| `PG_SSL_CA` | PEM inline ou caminho de arquivo com a CA. Liga a verificação |
| `PG_SSL_REJECT_UNAUTHORIZED=1` | Verifica a cadeia (com ou sem `PG_SSL_CA`; sem CA usa o trust store do Node) |
| `PG_SSL_REJECT_UNAUTHORIZED=0` | Não verifica, mesmo com `PG_SSL_CA` (para diagnóstico) |
| `PGSSLMODE=disable` | Sem TLS (só para banco local) |

Com `PG_SSL_CA` a cadeia é verificada por padrão, porque uma CA fixada que não é
verificada não protege nada. Use a CA que o endpoint do seu Lakebase apresenta (ela está
na documentação do Lakebase do seu workspace).

## Fora de escopo

- Vulnerabilidades na plataforma Databricks em si (reporte à Databricks).
- Configurações inseguras feitas por quem deploya (ex.: expor segredos, conceder
  permissões amplas demais no workspace).

## Boas práticas para quem deploya

- Rode sempre a versão mais recente do `main`.
- Não hardcode hosts, tokens ou credenciais em `app.yaml` / `databricks.yml` — o modelo
  cloud-agnóstico injeta tudo em runtime (veja o README).
- Restrinja o acesso à App e ao workspace pelos ACLs da Databricks.
