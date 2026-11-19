<!-- i18n: source=docs/security-threat-model.md source-hash=371d628272d7bee5763f2faa001e0a322cf3c230 status=current -->
# Modelo de ameaças do AI Prism

[English](../security-threat-model.md) · **Português (Brasil)** · [Español](../es/security-threat-model.md)

Este documento descreve o que o AI Prism protege, quem interage com ele, onde ficam
as fronteiras de confiança e quais ameaças têm controle hoje, com as lacunas
declaradas. Ele é uma **avaliação de engenharia do código deste repositório**, não
um parecer jurídico nem uma auditoria externa. Cada controle citado aponta para o código
que o implementa; quando algo não foi verificado, está dito.

Para as perguntas típicas de revisão de segurança, veja o
[FAQ de segurança](security-faq.md). Para reportar uma vulnerabilidade, veja o
[SECURITY.md](SECURITY.md).

- **Escopo:** o app (servidor Express em `server/`, cliente React em `client/src/`)
  e os recursos que o `databricks.yml` provisiona.
- **Fora do escopo:** a plataforma Databricks (Apps proxy, Lakebase, Unity Catalog,
  AI Gateway, SQL Warehouses serverless) e a configuração de ACLs do workspace feita
  por quem faz o deploy. Essas camadas têm controles próprios; o que o app assume delas
  está listado em [Premissas](#8-premissas-sobre-a-plataforma).

---

## 1. Ativos

| Ativo | Onde fica | Sensibilidade | Observação |
|---|---|---|---|
| Conversas e mensagens (texto, anexos, blocos, trace de tools) | Lakebase: `chat_sessions`, `chat_messages`, `chat_tool_calls` | Alta: podem conter dados da empresa e dados pessoais | Escopadas por `user_email` (ou JOIN com o dono da sessão) em todas as leituras do código atual. |
| Artefatos (decks HTML, planilhas, documentos) | Lakebase: `chat_decks`, `chat_spreadsheets`, `chat_documents` | Alta | Mesmo escopo das conversas. |
| Imagens geradas | UC Volume `ai_prism_images` (catálogo `ai_prism`) + índice `chat_images` | Média/alta | Leitura: checagem de dono no banco, depois o bytes são lidos com o token do SP (`server/imageStore.js`). |
| Embeddings de mensagens (RAG por histórico) | Lakebase: `chat_message_embeddings` (pgvector) | Alta | Derivados do conteúdo; mesma classe de dado da mensagem. |
| Ledger de custos por chamada | Lakebase: `usage_ledger` | Média | Contém e-mail, sessão, modelo e tokens. |
| Configuração administrativa | Lakebase: `app_admins`, `model_catalog_overrides`, `app_mcp_catalog`, `app_tool_policy`, `deck_templates` | Alta (define quem é admin e quais ferramentas existem) | Escrita só por rotas com `requireAdmin`. |
| Conexões MCP do usuário | Lakebase: `user_mcp_connections` (nome, comentário, status — **sem credenciais**); a conexão em si é uma conexão do Unity Catalog, referenciada por nome | Média/alta | As credenciais ficam na conexão do UC, sob o escopo `catalog.connections`, não no Lakebase. |
| Dados do workspace lidos em nome do usuário | Unity Catalog, Genie spaces, Vector Search indexes, SQL Warehouse | Depende da fonte | Acessados via OBO: o que o usuário não pode ler, o app também não lê. |
| Credenciais de deploy e runtime | Segredos do runtime do Apps (`DATABRICKS_CLIENT_ID`/`SECRET` do SP), variáveis do operador | Crítica | Nenhum segredo no repositório (`.gitignore` ignora `.env`). `PGPASSWORD` é só para dev local. |

---

## 2. Atores

| Ator | Confiança | O que pode fazer |
|---|---|---|
| **Usuário final** (autenticado no workspace) | Autenticado pela plataforma; não confiável quanto ao conteúdo que envia | Criar conversas, usar os modelos e as ferramentas que a própria identidade alcança, editar artefatos próprios. |
| **Admin do app** (`app_admins`, por e-mail ou grupo do workspace) | Confiável para configuração | Gerenciar modelos, políticas de ferramenta, catálogo MCP e templates de deck. |
| **Owner** (`APP_OWNER_EMAIL`, quando definido) | Confiável | Mesmo que admin, mais o que `isOwner` libera (`server/authz.js`). O bundle **não** define `APP_OWNER_EMAIL`; o admin de bootstrap é o deployer, semeado pelo job de auto-config (`bundle/auto_config.py`). |
| **Operador/deployer** | Confiável para deploy | Roda `bundle deploy`, o job de auto-config e o `apps deploy`. Vira admin de bootstrap. |
| **Administrador do workspace** | Fora do modelo do app | Controla ACLs, grupos, orçamentos e a plataforma. |
| **Atacante externo** | Sem credencial | Tenta chegar ao app sem passar pelo proxy. |
| **Usuário malicioso com conta no workspace** | Autenticado, hostil | Tenta ler dados de outro usuário (IDOR), estourar custo ou injetar instruções. |
| **Conteúdo de terceiros** | Não confiável | Descrições e respostas de servidores MCP e A2A, páginas da web (`web_search`), arquivos anexados, HTML gerado pelo modelo. |
| **Modelo de linguagem** (via AI Gateway) | Não confiável quanto à saída | Saídas podem conter instruções injetadas, HTML, SQL ou pedidos de ferramenta. |

---

## 3. Fronteiras de confiança

<!-- i18n: code-translated -->
```mermaid
flowchart LR
  U["Usuário no navegador"]
  subgraph PLAT["Plataforma Databricks"]
    P["Apps proxy (OAuth/SSO)"]
    GW["AI Gateway / modelos"]
    UC["Unity Catalog, Genie, Vector Search, SQL Warehouse"]
    LB[("Lakebase Postgres")]
    VOL[("UC Volume de imagens")]
  end
  subgraph APP["Processo do app (Express, server-dist)"]
    S["server/index.js"]
  end
  EXT["Terceiros: MCP, A2A, web"]

  U -- "TB1: HTTPS + credencial" --> P
  P -- "TB2: x-forwarded-email / access-token" --> S
  S -- "TB3: OBO (token do usuário)" --> GW
  S -- "TB3: OBO" --> UC
  S -- "TB4: SP (ou usuário, fallback)" --> LB
  S -- "TB5: SP" --> VOL
  S -- "TB6: conteúdo não confiável" --> EXT
  GW -. "TB7: saída do modelo não confiável" .-> S
  S -- "TB8: HTML de slide em iframe" --> U
```

| Fronteira | Quem cruza | Garantia que o app depende | Onde a verificação acontece |
|---|---|---|---|
| **TB1** Usuário → Apps proxy | Navegador/cliente | Autenticação OAuth/SSO do workspace | Plataforma |
| **TB2** Proxy → processo do app | Cabeçalhos `x-forwarded-email` e `x-forwarded-access-token` | O proxy sobrescreve esses cabeçalhos a partir da sessão autenticada | Plataforma; o app exige os dois e **confere o vínculo** e-mail ↔ token no workspace (`server/identityBinding.js`, SCIM `/Me`, cache de 5 min por hash do token). Sem resposta do workspace, aceita e registra aviso |
| **TB3** App → APIs do workspace | Token OBO do usuário | As permissões do próprio usuário (UC, Genie, endpoints) | Plataforma, com os escopos declarados em `databricks.yml` (`user_api_scopes`) |
| **TB4** App → Lakebase | Service principal do app (um papel Postgres para todos os usuários; não é dono das tabelas, sem `BYPASSRLS`) | **RLS com `FORCE`** em todas as tabelas do app (migração 0003); a identidade do usuário vai por transação (`withTx`: `app.user_email`, `app.is_admin`) | Banco (G2 fechada) |
| **TB5** App → Volume | SP do app | Idem TB4, com escopo `files` | App |
| **TB6** App → terceiros | Respostas de MCP/A2A/web; consultas de busca enviadas ao provedor (via Unity Gateway com o token do usuário, ou API com chave) | Nenhuma: conteúdo é tratado como dado, não como instrução | Parcial (G7 mitigada; G12 mitigada para `web_search`; G14) |
| **TB7** Modelo → app | Texto, HTML e pedidos de ferramenta | Renderização segura no cliente; ferramentas rodam com o OBO do usuário | Parcial |
| **TB8** App → iframe do slide | HTML/CSS gerado pelo modelo | Sandbox do iframe; `<script>` removido do HTML persistido | `client/src/components/deck/HtmlSlideFrame.jsx`, `server/blocks.js` (`sanitizeHtmlDeck`) |
| **TB9** Usuário → outro usuário (compartilhamento, W2-3) | Membros de um projeto: conversas, mensagens, instruções e arquivos do projeto | Só membros atuais (pessoa ou grupo SCIM confirmado) leem e postam; papel owner > manage > view; admin do app **sem** acesso implícito; quem sai perde tudo, inclusive as conversas que criou | Banco: `ai_prism.aip_project_rank` + políticas `aipj_*` (migração 0005, incluindo uma política **restritiva** em `chat_sessions`); app: `server/access.js`, `server/db/projects.js`, `sessionAccessSql` (`server/ownerScopedWrites.js`) |

**TB9 em detalhe.** Até a W2-3 todo dado tinha um dono e nenhuma linha era lida
por outra pessoa. Projetos abrem a primeira fronteira entre usuários:

- *Quem é membro* é decidido no banco por `aip_project_rank(projeto)`, a partir de
  `app.user_email` e de `app.user_groups` (JSON com os grupos SCIM do chamador, que
  `withTx` define a cada transação). Identidade vazia nunca casa, com ou sem grupos;
  `app.is_admin` não é lido por nenhuma política de projeto.
- *Grupos falham fechado*: `server/access.js` consulta SCIM `/Me` com o token do
  usuário (timeout de 3 s, cache de 5 min; falha em cache por 30 s). Só um HTTP 200
  completo conta: 206 (Partial Content), outro 2xx, lista paginada (`totalResults`
  maior que a lista, `itemsPerPage` menor, `startIndex` > 1), entrada malformada,
  erro HTTP, de rede, timeout ou corpo inesperado = nenhum grupo, e um grupo nunca concede o que
  não pôde ser provado. Só os grupos que `/Me` devolve contam (sem expansão de
  grupos aninhados). Usuário e grupo são `kind`s diferentes: um grupo com o nome
  do e-mail de alguém não dá acesso a essa pessoa.
- *Conversa de projeto*: a política restritiva `aipj_project_gate` faz `AND` com a
  de dono da 0003, então nem o criador lê uma conversa de projeto depois de sair. As
  tabelas filhas (mensagens, ferramentas, compactações, Genie, embeddings) checam a
  sessão por subconsulta em `chat_sessions`, que passa pelo mesmo filtro. Membros
  postam (inclusive viewers); a linha de custo e os artefatos de quem postou ficam
  no nome de quem postou. Um gatilho impede trocar `user_email` de uma sessão e só
  deixa tirar uma conversa do projeto com manage+ (e só o criador, porque a linha
  precisa continuar visível para quem escreve).
- *Reescrever a história de uma conversa de projeto* (editar um prompt, regenerar
  uma resposta, trocar a variante ativa, responder às perguntas de uma mensagem,
  compactar) exige manage ou owner: view lê e posta turnos novos (`/api/chat`,
  `/continue`), mas não muda o que outro membro escreveu. As mensagens não têm autor
  próprio, então a regra é por papel e não por autoria; a rota responde 403
  (`historyRewriteAccess`, `server/db/projects.js`) e o SQL da escrita repete a regra
  (`historyWriteSql`, `server/ownerScopedWrites.js`). Conversas pessoais: só o dono.
- *Sem exceção para a identidade de manutenção* (AC-P1): a varredura de retenção
  (0007: e-mail vazio + a flag da varredura) não lê nem apaga nada de uma conversa de
  projeto, porque a política restritiva não tem cláusula para ela. Conversas de
  projeto ficam fora da retenção por idade (saem com o projeto, `ON DELETE CASCADE`);
  uma retenção própria de projeto é acompanhamento.
- *Por que `project_members` não tem `FORCE`*: uma política em `project_members`
  que lê `project_members` (para mostrar o elenco aos membros) entraria em recursão.
  A função de pertinência é `SECURITY DEFINER`, com `search_path` fixo, do dono da
  tabela (`ai_prism_owner`), que lê a tabela sem políticas; o papel do app continua
  preso a elas. Durante a janela de hand-off do deploy (o SP é membro temporário do
  dono, `server/db/grants.js`) o SP também passaria por cima nessa tabela, como já
  pode fazer `ALTER TABLE` em qualquer uma: a janela fecha no `migrate.mjs grants`.
- *Arquivos de projeto* guardam só o texto extraído (sem bytes, sem caminho de
  armazenamento): o nome é reduzido ao último segmento, sem `/`, `\` ou controle.
- Provas: `server/isolation.projects.test.js` (SQL cru como o papel do app, sem
  código do app) e a matriz de permissões em `tests/routes/projects.test.mjs`.

---

## 4. Identidade e autorização por recurso

O app não tem login próprio. Cada requisição chega com a identidade do proxy e o
token OAuth do usuário. A tabela mostra qual identidade é usada em cada recurso
(verificado no código):

| Recurso | Identidade usada | Código | Efeito de segurança |
|---|---|---|---|
| Model Serving / AI Gateway (chat, embeddings, transcrição) | **OBO** (`serving.serving-endpoints`) | `server/llm.js`, `server/serving.js` | O gateway atribui o custo e aplica permissões do usuário. |
| Genie (espaços e Genie One MCP) | **OBO** (`dashboards.genie`, `genie`) | `server/genie.js` | O usuário só consulta espaços que pode acessar. |
| SQL Warehouse (UC Functions, Python UDF, DDL do Volume) | **OBO** (`sql`) — `execStatement(userToken, …)` | `server/warehouse.js`, `server/tools.js` | Execução limitada ao que o usuário pode executar. |
| Vector Search | **OBO** | `server/vectorSearch.js` | Idem. |
| MCP externo do usuário (conexões próprias) | **Token do usuário** por conexão | `server/externalMcp.js`, `server/mcpClient.js` | Cada conexão só é usada pelo usuário que a criou. |
| Catálogo de MCP (sugestões do workspace) | **SP** (`all-apis`), só para listar | `listMcpServicesViaSp` em `server/externalMcp.js` | Só sugestões; a validação continua OBO. |
| Lakebase (chats, artefatos, ledger, admins) | **SP** por padrão (`withTx`, `server/db/pool.js`); **usuário** como fallback (dev local, SP sem login) | `server/db/pool.js` (`withTx`, `getSpPool`) | O SP tem DML nas tabelas do schema `ai_prism` (`migrate.mjs grants`), **filtrado por RLS com `FORCE`** (migração 0003): só as linhas do usuário da transação; tabelas de admin só com `app.is_admin = 'on'`. Ver G2. |
| Volume de imagens | **SP** quando disponível, senão o token do usuário | `server/imageStore.js` (`storageToken`) | Leitura só após consulta de dono no banco. |
| Grupos de admin (SCIM `Me`) | **Token do usuário** | `server/authz.js` (`userGroups`) | Falha de SCIM degrada para "sem grupos", sem liberar acesso. |
| Grupos de membros de projeto (SCIM `Me`) | **Token do usuário** | `server/access.js` (`createGroupResolver`), por transação via `withTx` | Falha fechada: erro, timeout ou corpo inesperado = nenhum grupo (TB9). |

**Autorização no app.** Três níveis: `requireAdmin` nas rotas `/api/admin/*` e nas
de templates globais (`server/index.js`); `isOwner` por `APP_OWNER_EMAIL`; `isAdmin`
por `app_admins` (e-mail ou grupo). Dono de sessão, mensagem, artefato e imagem é
verificado no banco com `user_email` (ex.: `fetchActiveMessages` faz JOIN com
`chat_sessions` pelo dono; `POST /api/chat` responde 403 para `sessionId` alheio).

---

## 5. Controles presentes

| ID | Controle | Implementação |
|---|---|---|
| C1 | Rejeição sem credencial de usuário | `auth()` responde 401 quando não há token (`server/index.js`). |
| C2 | Escopo de dados por dono | `WHERE user_email` e JOIN com `chat_sessions` em listas, leituras, buscas (`listSessions`, `fetchActiveMessages`, `retrieveRelevantMessages`, `searchSessionsByVector`). |
| C3 | Ownership verificado antes do stream | `POST /api/chat` checa `getSession` antes de abrir SSE (403 limpo). |
| C4 | Gate de admin | `requireAdmin` (`server/index.js`) para rotas de administração. |
| C5 | Anti-SSRF no fetch da web | `server/web.js`: bloqueia `localhost`, IPs privados (IPv4 e IPv6, inclusive mapeados), resolve o DNS antes de conectar e limita redirects. Coberto por teste em `server/web.test.js`. Endurecimento (`server/webHardening.test.js`): a lista de endereços (`blockedAddressReason`, `server/a2aGuard.js`) também decodifica o IPv4 embutido em 6to4 `2002::/16` e SIIT `::ffff:0:0/96` e recusa Teredo `2001::/32` e NAT64 de uso local `64:ff9b:1::/48`; o lookup fixado responde no tick seguinte, então uma falha síncrona de `connect()` (EHOSTUNREACH) rejeita o fetch em vez de derrubar o processo; o nome da conexão MCP vira um único segmento codificado em `externalMcpUrl` e `/api/mcp/connections/:name` responde 400 a nomes com caracteres de caminho ou query. |
| C6 | Markdown sem HTML cru | O cliente não usa `rehype-raw` (`client/src`): HTML embutido no markdown não é renderizado como HTML. |
| C7 | Slides isolados | `HtmlSlideFrame` usa `sandbox="allow-scripts"` (sem `allow-same-origin`: origem opaca, sem acesso a cookies/armazenamento do app). Outro iframe de preview usa `allow-same-origin` **sem** `allow-scripts`. |
| C8 | Remoção de `<script>` do HTML de deck | `sanitizeHtmlDeck` (`server/blocks.js`) e `deckHtmlPolicy.js`. Defesa em profundidade: o sandbox já bloqueia execução. |
| C9 | Web search sob controle do admin | Só é registrado quando `WEB_SEARCH_CONNECTION` está configurada (`server/tools.js`, `server/blocks.js`). |
| C10 | Ferramentas com o próprio OBO | Execução de UC Functions e da UDF Python com o token do usuário (`server/warehouse.js`, `server/tools.js`). O processo do app não executa código gerado pelo modelo. |
| C11 | Limites de entrada | Limite de corpo JSON por classe de rota, numa tabela explícita (`JSON_ROUTE_LIMITS` em `server/middleware/security.js`); toda rota de escrita tem classe, e um teste falha quando uma rota nova não escolhe a sua (`server/routes/routeTable.test.js`). Classes: **1 MB** por padrão (`BODY_LIMIT_JSON`); 40 MB na importação/atualização de design system (`POST /api/deck-templates`, `PATCH /api/deck-templates/:id`, `label-assets`; `BODY_LIMIT_DECK_TEMPLATES`); 48 MiB nas escritas do estúdio com mídia, que levam slides, notas do apresentador e anexos como `data:` (`PATCH /api/decks/:id`, `POST /api/decks/:id/tweak`, `POST /api/decks/:id/export-html`, `POST /api/spreadsheets/:id/tweak`; `BODY_LIMIT_STUDIO_MEDIA`; medido: export de 40 slides com fundo de marca em cada um = 25,6 MB; tweak com 4 imagens de 6 MiB + uma nota de 9 MiB = 45,4 MB); 4 MB no salvamento de planilha (`PATCH /api/spreadsheets/:id`; `BODY_LIMIT_WORKBOOK`; 0,94 MB nos tetos do sanitizador). Upload do chat até 80 MB e 10 arquivos; upload de skill até 5 MB e 1 arquivo; arquivos de projeto até 25 MB e 10 por requisição, 50 por projeto, lidos só depois de conferir que o chamador é manage+ (`PROJECT_FILE_LIMITS`, `server/middleware/index.js`; `POST /api/projects/:id/files`, excesso de tamanho ou de quantidade = 413). As rotas de escrita de projeto (`/api/projects…`) estão na classe padrão (1 MB). Acima do limite: 413 JSON. **Boot legado:** o limite é aplicado durante a leitura, então o corpo acima dele nunca é lido inteiro. **Boot legado:** o `body-parser` conta o próprio stream, com ou sem `Content-Length` (inclusive `Transfer-Encoding: chunked`). **Boot AppKit:** o `express.json` do próprio AppKit lê e parseia o corpo antes de toda a cadeia do app, em **toda** rota, até **64 MB** (`APPKIT_BODY_LIMIT` em `server/middleware/security.js`, usado por `server/appkit.js`; um teste garante que nenhuma classe passa disso). Esse é o teto de memória por requisição sob o AppKit; o limite por rota continua valendo pelo `Content-Length` declarado (acima dele: 413), e um corpo JSON **sem** `Content-Length` recebe **411 Length Required**: o objeto parseado não mede o que veio pela rede (espaços e escapes somem no parse), então as rotas JSON exigem tamanho declarado sob o AppKit. A aplicação continua sendo a regra do `Content-Length` (413) e do chunked (411): é uma checagem de política, não uma proteção de memória, porque até 64 MB já foram lidos. Os anexos de imagem da edição por IA vão uma vez só por imagem raster (`client/src/lib/promptImages.js`), com um orçamento total de anexos (34M caracteres); as notas do apresentador ainda não têm teto (ver §7.2). |
| C17 | Rate limit por usuário | Token bucket por identidade encaminhada pelo proxy (`x-forwarded-email`; IP só sem identidade): 120 requisições `/api`/min e 12 turnos/min (chat, continue, regenerate, compact e os tweaks dos estúdios), `RATE_LIMIT_API_PER_MIN` / `RATE_LIMIT_TURNS_PER_MIN` (`0` desliga). Excesso: 429 JSON com `Retry-After` (`server/middleware/rateLimit.js`). Em memória, por processo. |
| C18 | CSP report-only com coleta | `Content-Security-Policy-Report-Only` com a política alvo (`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-src 'self' blob:; frame-ancestors 'none'`) e `Permissions-Policy: microphone=(self), camera=()` em toda resposta; violações vão para `POST /api/csp-report`, que grava uma linha JSON por violação só com diretiva, origem bloqueada, caminho do documento e disposição (sem query, amostra ou e-mail), com teto por usuário (`CSP_REPORT_PER_MIN`, padrão 60) (`server/middleware/security.js`). |
| C19 | Compartilhamento por projeto | Papéis owner > manage > view (`server/access.js`), não-membro (admin do app incluído) recebe 404, membro sem papel 403; checagem e escrita na mesma transação (`server/db/projects.js`); RLS `aipj_*` repete as regras no banco (migração 0005, TB9). |
| C12 | Segredos fora do repositório | `.gitignore` ignora `.env`; `.env.example` sem valores reais; SP credentials injetadas pelo runtime. |
| C13 | Dependências no artefato de deploy | O deploy roda `server-dist/index.cjs` (bundle esbuild, com as dependências de runtime embutidas) e `client/dist`, ambos commitados. O `.npmrc` tem `omit=dev`, então o build do Apps instala só dependências de produção. |
| C14 | CI com lockfile | `npm ci --include=dev --ignore-scripts` em `.github/workflows/ci.yml`; permissões do `GITHUB_TOKEN` restritas a leitura. |
| C15 | Escopos OBO mínimos declarados | `user_api_scopes` no `databricks.yml`, com motivo por escopo. Alguns escopos `catalog.*` estão marcados como vestigiais no próprio arquivo. |
| C16 | Limites de recursos | SQL Warehouse 2X-Small com `max_num_clusters: 1` e auto-stop de 10 min; Lakebase autoscaling 0,5–16 CU com suspensão em 1800 s (`databricks.yml`). |

---

## 6. STRIDE

Cada linha é uma ameaça concreta ao código atual. "Risco residual" é o que continua
aberto depois dos controles de [§5](#5-controles-presentes).

| Categoria | Ameaça concreta | Controles | Risco residual / lacuna | Ação recomendada |
|---|---|---|---|---|
| **S**poofing | Chamada direta ao app com `x-forwarded-access-token` sem `x-forwarded-email` cai no fallback de identidade (G1). | C1, proxy da plataforma | Médio: se o proxy não estiver na frente, a identidade vira `DATABRICKS_USER_EMAIL` ou `local-dev@databricks.com`. | Rejeitar com 401 quando o e-mail do proxy faltar em runtime de Apps. |
| **S**poofing | Requisição que chega ao processo sem o proxy (ou com header repassado) com `x-forwarded-email` de outra pessoa e qualquer token. | Vínculo e-mail ↔ token (`server/identityBinding.js`) | Baixo: 401 com divergência ou token inválido; resta o caso do workspace fora do ar (aceita com aviso) e o de token válido roubado. | Manter `IDENTITY_BINDING=enforce`; confirmar com a plataforma que o container só é alcançável pelo proxy. |
| **S**poofing | Admin por grupo do workspace depende de SCIM com token do usuário. | `userGroups` com TTL de 5 min | Baixo: falha de SCIM nega grupo, não concede. | Nenhuma imediata. |
| **T**ampering | Modelo ou conteúdo de terceiros injeta HTML/JS em slide ou documento. | C6, C7, C8 | Baixo para execução (sandbox); o HTML do slide preserva CSS e estrutura do modelo. | Manter a sanitização; testar regressões em `scripts/deck-html-qa.mjs`. |
| **T**ampering | Usuário altera artefato de outro usuário pelo `PATCH /api/decks/:id` etc. | Ownership checado nas rotas de artefato | Médio: a escrita depende de `WHERE` correto em cada rota; não há teste automatizado de IDOR (G2). | Teste de isolamento entre dois usuários na CI. |
| **R**epudiation | Não há trilha de auditoria própria para ações administrativas (criar admin, alterar catálogo MCP, templates). | Logs em `console` (sem estrutura); `usage_ledger` cobre só custo | Médio: a trilha é a da plataforma (`system.access.audit`), não a do app (G8). | Registrar eventos admin em tabela própria ou confiar explicitamente em `system.access.audit`. |
| **I**nformation disclosure | Um bug de query lê conversas de outro usuário. O SP tem DML em todas as tabelas e não há RLS. | C2, C3 | **Alto** (impacto), probabilidade dependente de revisão de código; sem prova automatizada hoje (G2). | RLS com `FORCE` nas tabelas de dono e testes de isolamento contra o banco. |
| **I**nformation disclosure | Um membro removido de um projeto (ou um admin do app, ou um grupo cuja checagem SCIM falhou) continua lendo as conversas do projeto. | C19, TB9: política restritiva em `chat_sessions`, grupos falham fechado, admin sem acesso implícito | Baixo: provado no banco (`server/isolation.projects.test.js`). Resta o cache de grupos: quem sai de um grupo no workspace mantém o acesso por até 5 min. | Nenhuma imediata; reduzir `GROUPS_TTL_MS` se 5 min for longo demais. |
| **I**nformation disclosure | A CA do servidor Lakebase não é verificada na conexão. | TLS (`PGSSLMODE=require`) | Médio: `rejectUnauthorized: false` em `server/db.js` (G3). | Ancorar a CA do Lakebase ou documentar a exceção com justificativa. |
| **I**nformation disclosure | Dados do usuário saem para terceiros via MCP/A2A que ele configurou. | Conexões são por usuário | Depende do destino configurado pelo usuário; o app não filtra conteúdo enviado. | Documentar; permitir allowlist de destinos por admin. |
| **I**nformation disclosure | Logs gravam mensagens de erro de banco/gateway que podem conter fragmentos de dados. | Nenhum filtro de logs | Baixo a médio (G11). | Política de redação para logs. |
| **D**enial of service | Um usuário dispara muitos turnos e consome o orçamento de tokens do workspace. | C17 (12 turnos/min, 120 req/min por usuário); ledger por usuário; limites do workspace | Médio (G4): o limite é por processo e não é uma cota de custo; um usuário ainda gasta até 12 turnos/min. | Orçamentos nativos do Unity AI Gateway por usuário ou grupo para o teto de custo. |
| **D**enial of service | Muitas conexões concorrentes esgotam o pool. | Pool com `max: 8` por processo e por usuário (`POOL_OPTS`, `server/db.js`) | Médio: o pool do SP é único, então a concorrência é limitada a 8 consultas simultâneas (ver `docs/performance.md`). | Medir com `npm run loadtest`; dimensionar. |
| **D**enial of service | Upload grande ou SSE longo prendem o processo. | Limites de tamanho por rota (C11), rate limit (C17) | Baixo a médio. | Medir; ajustar timeouts. |
| **E**levation of privilege | Ferramenta ou MCP leva o modelo a agir além do que o usuário pode. | Ferramentas com OBO (C10) | Médio: não há política de confirmação para ações de escrita em ferramentas externas. | Limitar ferramentas de escrita por política (`app_tool_policy`); confirmação humana. |
| **E**levation of privilege | Descrição de tool MCP com instrução maliciosa altera o comportamento do modelo (prompt injection indireta). | Truncamento de descrição a 300 caracteres em `externalMcp.js` | Médio a alto (G7): descrições e metadados não são sanitizados antes do prompt. | Tratar metadados de tool como dado não confiável, com delimitadores e sanitização. |
| **E**levation of privilege | Requisição de escrita cross-site (CSRF) em rotas `POST/PUT/PATCH/DELETE`. | `server/csrfGuard.js` (`Sec-Fetch-Site: cross-site` → 403 sempre; senão `Origin`/`Referer` ≠ host → 403), antes do rate limit e, no boot legado, antes do parse do corpo | Baixo (G5): navegadores antigos sem `Sec-Fetch-Site` nem `Origin` não são cobertos. No boot AppKit o corpo já foi lido e parseado (até 64 MB) quando a recusa acontece (C11). | Confirmar `SameSite` do cookie do proxy (G-live, §7.1). |

---

## 7. Lacunas declaradas

Lacunas são ausências verificadas no código, não suposições. A severidade considera
impacto e probabilidade no estado atual.

| ID | Lacuna | Evidência | Severidade | Status |
|---|---|---|---|---|
| **G1** | Fallback de identidade quando `x-forwarded-email` está ausente | `userEmail()` em `server/index.js` cai em `DATABRICKS_USER_EMAIL` e depois `local-dev@databricks.com` | Média (defesa em profundidade) | **Fechada** em `server/requestIdentity.js`: no runtime de Apps, sem `x-forwarded-email` a resposta é 401; a identidade de ambiente só vale com `LOCAL_DEV_MODE=1`/`LOCAL_DEV_IDENTITY=1` e sem `DATABRICKS_APP_*`. |
| **G2** | Isolamento só pelo `WHERE`; SP com DML em todo o schema `public`; sem RLS nem suíte de isolamento | — | **Alta** | **Fechada (W1-5 + W2-1).** Schema `ai_prism` com dono neutro e grants mínimos (0002); RLS `ENABLE` + `FORCE` nas 20 tabelas do app (0003): 14 por usuário (`user_email` direto ou via `chat_sessions`/`chat_messages`), 2 mistas (próprias ou globais; global só com a flag de admin), 4 de admin (leitura livre, escrita só com a flag). O SP não é dono e não tem `BYPASSRLS` (`server/rls.test.js` confere `rolbypassrls = false` e dono ≠ `current_user`); toda query passa por `withTx` (teste de lint: nenhum `withClient(` fora de `pool.js`). O backfill entre usuários do ledger virou migração de dados do dono (`migrate.mjs backfill-usage`). Falta a prova numa branch Lakebase real (G-live). |
| **G3** | `rejectUnauthorized: false` na conexão com o Lakebase | `connInfo` em `server/db.js` | Média | Aberta. |
| **G4** | Sem rate limit nem cota por usuário no app | Antes: nenhum middleware de limite | Média (era Alta para custo) | **Mitigada** em `server/middleware/rateLimit.js` (C17): token bucket por usuário, 120 req/min e 12 turnos/min, 429 + `Retry-After`, ajustável por env (testes em `server/middleware/rateLimit.test.js` e `server/httpHardening.test.js`). Continua aberto: o limite é por processo (várias instâncias multiplicam o teto) e não é uma cota de custo; o teto de gasto fica com os orçamentos do Unity AI Gateway. |
| **G5** | Sem token anti-CSRF próprio | Rotas de escrita aceitam JSON/multipart sem token | Baixa (era Média) | **Mitigada** em `server/csrfGuard.js`: escrita (`POST/PUT/PATCH/DELETE`) em `/api/*` com `Sec-Fetch-Site: cross-site` recebe 403 mesmo que o `Origin` pareça do app; sem `Sec-Fetch-Site`, `Origin`/`Referer` de outro host recebe 403 (testes em `server/csrfGuard.test.js` e `server/httpHardening.test.js`, variantes de `Sec-Fetch-Site` e `Origin`). A recusa vem antes do rate limit e, no boot legado, antes de ler o corpo; no boot AppKit o `express.json` do AppKit já leu e parseou o corpo (até 64 MB) antes do guard, então uma escrita cross-site ainda é recusada, mas custa a leitura (C11). Pendente G-live: `SameSite` do cookie do proxy (§7.1). |
| **G6** | Sem cabeçalhos de segurança do próprio app (CSP, HSTS etc.) | Antes: nenhum `setHeader` de segurança global | Baixa | **Mitigada em parte**: `server/securityHeaders.js` aplica `nosniff`, `Referrer-Policy: same-origin`, `X-Frame-Options: SAMEORIGIN` e uma CSP aplicada conservadora (`frame-ancestors 'self'; base-uri 'self'; object-src 'none'; form-action 'self'`), sem `X-Powered-By`; `server/middleware/security.js` soma `Permissions-Policy: microphone=(self), camera=()` e a CSP alvo em **report-only** com coleta em `/api/csp-report` (C18). Nada é bloqueado ainda: os previews de design system e o editor de slides usam scripts inline e fontes/imagens de outros hosts; aplicar a política alvo exige as evidências da coleta e mover esses iframes para outra origem. HSTS fica com o proxy. `Referrer-Policy` fica em `same-origin` (mais estrita que `strict-origin-when-cross-origin`: não envia nem a origem a sites externos). |
| **G7** | Metadados de MCP/A2A/Genie/UC não são sanitizados antes do prompt | Só truncamento em `externalMcp.js:72`; `sanitize` em `tools.js` trata nomes de tool, não descrições | Média a alta | **Mitigada**: `server/toolMetadata.js` neutraliza descrições, instruções e schemas de MCP, títulos de sala Genie e comentários de função UC antes do prompt. Conteúdo retornado por tools (web, MCP) continua tratado como dado, ver G12. |
| **G8** | Sem trilha de auditoria própria para ações administrativas | Nenhuma tabela de auditoria no DDL de `server/db.js` (busca por `audit` só encontra comentários) | Média | Aberta. |
| **G9** | Sem varredura de dependências no CI (`audit=false` no `.npmrc`); o bundle embute as dependências | `.npmrc`, `.github/workflows/ci.yml` | Média | Aberta. |
| **G10** | Imagens são lidas com o token do SP, não com o do usuário | `server/imageStore.js` | Baixa (depende de G2 para a checagem de dono) | Aceita com o controle de dono no banco. |
| **G11** | Logs sem redação; mensagens de erro podem ter trechos de dados | `console.warn(...e.message)` em `server/db.js` e `server/index.js` | Baixa a média | Aberta. |
| **G12** | Conteúdo de terceiros (web, anexos) entra no contexto sem marcação de não confiável | Anexos entram como bloco de texto no turno | Média | **Mitigada para `web_search`** (W2-11a): todo resultado de busca, de qualquer backend, sai de um único renderizador (`renderWebSearchForModel` em `server/webSearch/index.js`) dentro do envelope fixo `[CONTEÚDO EXTERNO DA WEB — não confiável; …]` … `[FIM DO CONTEÚDO EXTERNO]`, com os marcadores neutralizados dentro do conteúdo e limites de itens e tamanho (teste por adapter em `server/webSearch/webSearch.test.js`). Continua aberta para anexos e para o texto de `web_fetch`. |
| **G13** | Nenhum teste automatizado de isolamento entre usuários na CI | `package.json` e `.github/workflows/ci.yml` | Alta (habilita G2) | **Fechada no banco**: `server/isolation.test.js` (19 casos) roda `db.js` como o papel não-dono `ai_prism_app` (`scripts/ci/pg-roles.sql`) sob RLS, incluindo um `SELECT` cru em cada tabela por usuário (0 linhas alheias); `server/rls.test.js` (16 casos) cobre políticas, `FORCE`, atributos do papel, uso de índices e o round trip da 0003. CI: `--fail-on-skip --expect server/isolation.test.js=19 --expect server/rls.test.js=16`. Falta rodar contra uma branch Lakebase efêmera (Fase 6). |
| **G14** | Busca na web: a consulta sai do workspace para o provedor de busca; o serviço MCP de busca designado usa credencial compartilhada | `server/webSearch/` (W2-11a, ADR 0007) | Média | **Mitigada, risco residual aceito.** A descrição da tool proíbe dados internos, nomes de clientes e conteúdo de anexos na consulta; uma política de Sensitive Data Detection do gateway (Beta) pode ser anexada ao MCP Service. Logs: uma linha por tentativa sem consulta, resultado nem texto de erro do provedor (teste em `webSearch.test.js`). O serviço designado em `WEB_SEARCH_MCP_SERVICE` é a **única exceção** à recusa de credencial compartilhada (PR #83), limitada por seis invariantes testados: uma só tool fixa é chamada (nunca "a primeira" da lista); os argumentos são montados pelo app só com consulta e limite; descrições, instruções e schema do servidor nunca chegam ao prompt; `admitMcpConnection` fica intacto e continua recusando o serviço em todo caminho do usuário; com a tool nativa ativa, refs do usuário a `system.ai.web_search` ou ao serviço designado são ignoradas no turno; a documentação exige seleção de tools no serviço. As duas chamadas MCP usam o token do usuário (grants, rate limit e auditoria do gateway por usuário); a chave do provedor fica na connection do UC, nunca no app. Chave de fallback (Brave/Tavily): secret do Apps, lida pelo SP, nunca logada nem exibida (o status de admin só mostra presença). Lacuna conhecida até a W2-11d: com a tool nativa desligada, uma ref antiga a esse serviço ainda chega ao modelo. |

### 7.1 Pendências de verificação no ambiente real (G-live)

Itens que só um deploy real responde. Nenhum foi verificado ainda; cada um decide um
ajuste nos controles acima.

| Item | O que verificar | Decide | Status |
|---|---|---|---|
| G-live-1 | Atributo `SameSite` do cookie de sessão do Apps proxy | Se `Lax`/`Strict`, o navegador já não envia o cookie em `POST` cross-site, e o guard de CSRF vira defesa em profundidade (G5) | TODO |
| G-live-2 | Quais destes cabeçalhos o proxy já define ou sobrescreve: `Content-Security-Policy(-Report-Only)`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`, `Strict-Transport-Security` | Evita cabeçalhos duplicados ou conflitantes (G6) | TODO |
| G-live-3 | Se a UI do Apps (ou outro produto do workspace) exibe o app num iframe: violações `frame-ancestors` em `/api/csp-report` | Valor de `frame-ancestors` quando a CSP passar a ser aplicada (`'none'` ou a origem do workspace) | TODO |
| G-live-4 | Volume e tipo das violações em `/api/csp-report` num uso real (deck editor, preview de design system, fontes do DS) | Política aplicada final (G6) | TODO |
| G-live-5 | Número de instâncias do app em produção | Se o rate limit em memória (G4) precisa de estado compartilhado | TODO |

### 7.2 Acompanhamentos (decisões de produto, não implementados)

| Item | O que fazer | Por que | Dono | Status |
|---|---|---|---|---|
| F-1 | Apertar os orçamentos do cliente na edição por IA do deck: um teto para as notas do apresentador (hoje sem limite no editor e no servidor) e um orçamento que some anexos **e** o deck enviado, menor que o atual (34M caracteres de anexos) | O pior caso admitido hoje (4 imagens de 6 MiB + nota de 9 MiB ≈ 45,4 MB) obrigou a classe `studioMedia` a 48 MiB e o parser do AppKit a 64 MB para todas as rotas; uma nota maior que ~11 MiB ainda recebe 413. Orçamentos menores deixam baixar os dois limites | Produto (dono do estúdio de deck) | TODO |

---

## 8. Premissas sobre a plataforma

O app assume que a plataforma faz o que está descrito abaixo. Se alguma premissa
falhar, o modelo deste documento muda.

- O **Apps proxy** autentica o usuário e é o único caminho até o processo, e reescreve
  `x-forwarded-email` e `x-forwarded-access-token` a partir da sessão autenticada.
- O **token OBO** entregue ao app tem somente os escopos declarados em
  `user_api_scopes` (o bundle, não `app.yaml`, é quem os aplica no deploy).
- O **Lakebase** é acessível só pela rede do workspace e autentica o SP e o usuário
  pelo token de conexão emitido pela plataforma.
- O **UC Volume** e o catálogo `ai_prism` são criados pelo job de auto-config com
  `READ/WRITE VOLUME` concedido apenas ao SP do app.
- Criptografia em repouso e em trânsito do workspace segue a configuração da própria
  plataforma (incluindo chaves gerenciadas pelo cliente, quando configuradas).
- A auditoria da plataforma (`system.access.audit`) registra os eventos de workspace e de
  Unity Catalog. O app não substitui essa trilha (G8).

---

## 9. Como manter este documento

- Revisar a cada mudança em `server/authz.js`, `server/db.js` (`withClient`,
  `ensureSpGrants`, DDL), `databricks.yml` (`user_api_scopes`, recursos) e em qualquer
  rota nova sob `/api/`.
- Ao fechar uma lacuna, mover a linha para a tabela de controles e citar o teste que a
  cobre.
- Mudanças que alteram uma fronteira de confiança (novo recurso acessado com o SP, nova
  fonte de conteúdo de terceiros) exigem atualizar a [§3](#3-fronteiras-de-confiança).
