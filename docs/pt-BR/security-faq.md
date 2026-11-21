<!-- i18n: source=docs/security-faq.md source-hash=43939597d5ec3ec4d83a48b9bdb4b06c8360c900 status=current -->
# FAQ de segurança do AI Prism

[English](../security-faq.md) · **Português (Brasil)** · [Español](../es/security-faq.md)

Respostas às objeções que aparecem em revisões de segurança. Cada resposta separa o
que **o app faz** (código deste repositório) do que **a plataforma Databricks ou o
serverless provê**. Quando a resposta depende de configuração do workspace, isso está
dito. Para o detalhamento, veja o [modelo de ameaças](../security-threat-model.md)
(identificadores G1–G15 e C1–C22 vêm de lá).

---

### 1. O app implementa login?

**Não.** O app não tem tela nem fluxo de autenticação próprio. O **Apps proxy** do
workspace autentica o usuário (OAuth/SSO) e encaminha a requisição com
`x-forwarded-email` e `x-forwarded-access-token`. O app lê esses cabeçalhos
(`server/requestIdentity.ts`) e responde 401 quando falta o token ou o e-mail. Ele também
confere com o workspace (`SCIM /Me`) que o e-mail pertence ao dono do token e responde
401 se não pertencer (`server/identityBinding.ts`, `IDENTITY_BINDING`; ver
[SECURITY.md](SECURITY.md#vínculo-entre-e-mail-e-token-serveridentitybindingts)).

*Plataforma:* autenticação, SSO, expiração de sessão e revogação de acesso, e ser o único
caminho até o processo.
*App:* exige os dois cabeçalhos e o vínculo entre eles. Se o workspace não responder, a
requisição passa e o log registra o aviso.

---

### 2. Um usuário consegue ver a conversa de outro?

**Uma conversa pessoal, não, e quem garante é o banco (row-level security, migrações 0003 e 0005). A única exceção deliberada é um projeto compartilhado: suas conversas podem ser lidas pelos membros atuais do projeto.** As tabelas do app no schema `ai_prism` têm `ENABLE` e `FORCE ROW LEVEL SECURITY`. Há duas exceções, e nenhuma guarda conteúdo de conversa. `project_members` tem a row-level security habilitada, mas não forçada, para que a função de participação possa lê-la ([TB9 do modelo de ameaças](../security-threat-model.md#3-trust-boundaries)). `schema_migrations` não tem nenhuma: guarda apenas versões de migração. Por padrão, o app conecta com **um** papel Postgres para todos os usuários: o seu service principal. Esse papel não é dono de nenhuma tabela, não tem `BYPASSRLS` e não é membro do papel dono depois de um deploy. Quando o service principal não consegue conectar, o app recorre à identidade de banco do próprio chamador ([pergunta 5](#5-quais-permissões-o-app-usa-e-em-nome-de-quem)). Toda query roda dentro de `withTx` (`server/db/pool.js`). Só naquela transação, ele define o e-mail de quem chama (`app.user_email`), os grupos do workspace de quem chama (`app.user_groups`) e uma flag de admin (`app.is_admin`). Sem uma identidade de quem chama, nenhuma linha pessoal ou de projeto fica visível. As tabelas compartilhadas e de admin abaixo continuam legíveis, porque a sua política de leitura é aberta a todos.

- **Dados pessoais** (chats fora de um projeto com suas mensagens e chamadas de tool, artefatos, imagens, ledger de custos, memória, conexões MCP, seleções): a linha só é visível e gravável pelo usuário a quem pertence, direto (`user_email`) ou pelo chat (`chat_sessions`). Participar de um projeto não dá acesso aos chats pessoais de outro membro. Um chat temporário (migração 0011) é um chat pessoal que nunca pode pertencer a um projeto; valem para ele as mesmas regras de acesso só do dono.
- **Conversas de projeto** (migração 0005): um chat criado dentro de um projeto pode ser lido pelos *membros atuais* do projeto (uma pessoa ou um grupo do workspace confirmado) com qualquer papel (owner, manage, view). Eles podem ler o chat, suas mensagens, chamadas de tool, compactações, conversas do Genie e embeddings. Todo membro pode postar novos turnos; só manage ou owner podem reescrever o histórico. A partir da migração 0012, as apresentações, planilhas, documentos e imagens que um membro gera em um chat de projeto também podem ser lidos (nunca escritos) pelos membros atuais do projeto: o banco tem uma política `SELECT` por tabela (`aipj_member_read`, participação como conjunto), as escritas continuam só do dono e o app responde 403 `artifact_read_only` à edição de quem não criou. As linhas de custo dele continuam legíveis só por esse membro. Excluir um projeto apaga do volume os arquivos de imagem dos chats dele (best-effort). A partir da migração 0008, a participação é avaliada uma vez por instrução, como um conjunto de ids de projeto (`aip_my_project_ids()`, [ADR 0016](../adr/0016-project-membership-set.md)); as regras de acesso não mudam. Quem sai do projeto perde o acesso aos seus chats, inclusive aos que criou. Um admin do app não tem acesso implícito. Prova: `server/isolation.projects.test.js` (um membro lê o chat compartilhado de outro membro; um não membro, um admin e uma identidade vazia não leem). Veja TB9 no [modelo de ameaças](../security-threat-model.md#3-trust-boundaries).
- **Tabelas compartilhadas** (modelos de design system, skills): cada um lê as suas e as
  globais; só uma requisição de admin grava uma linha global.
- **Tabelas de admin** (admins, catálogo MCP, política de tools, catálogo de modelos, configurações da organização):
  todos leem; só uma requisição de admin grava. A trilha de auditoria de admin (`admin_audit`) só é legível com a flag de admin. Há mais uma leitura que cruza usuários: o ledger de custos (`usage_ledger`) continua por usuário, exceto que uma requisição com a flag de admin **e** uma identidade de chamador pode ler as linhas do ledger de todos os usuários por uma política só de SELECT (`aipa_admin_read`, migração 0010, [ADR 0015](../adr/0015-admin-ledger-read.md)). O app a usa apenas para os agregados de custo de busca na web do admin (usuários com hash na resposta); ela não dá acesso de escrita e, sem identidade, não dá leitura.

A flag de admin só é ligada pelo código do servidor depois da checagem de admin
(`requireAdmin`, `authz.isAdmin`), nunca por cabeçalho ou corpo, e não dá acesso às
linhas próprias de outros usuários. As queries mantêm os filtros `WHERE user_email` como
defesa em profundidade. A CI prova isso: `server/isolation.test.js` (19 casos) roda
`db.js` como um papel do app que não é dono, sob as políticas, incluindo um `SELECT` cru
em cada tabela por usuário que precisa devolver 0 linhas do outro usuário, e
`server/rls.test.js` (16 casos) confere as políticas, o `FORCE`, os atributos do papel, o
uso de índices e o round trip da migração. G2 e G13 estão fechadas (ver o modelo de
ameaças). Ainda aberto: rodar a mesma checagem numa branch Lakebase real (G-live-7 no modelo de ameaças).

---

### 3. Onde os dados ficam?

- **Conversas, artefatos, embeddings e ledger:** Lakebase (Postgres serverless) do
  próprio workspace, criado pelo `databricks.yml`.
- **Entradas de memória:** tabela `user_memories` no mesmo Lakebase, uma linha por fato
  lembrado, legível só pelo dono ([pergunta 20](#20-o-que-a-memória-guarda-e-como-apagar)).
- **Imagens geradas:** um UC Volume, por padrão `ai_prism.default.ai_prism_images` (configurável com `IMAGE_VOLUME_CATALOG`, `IMAGE_VOLUME_SCHEMA` e `IMAGE_VOLUME_NAME`).
- **Dados consultados:** Unity Catalog, Genie e Vector Search, sempre com o token do
  usuário (OBO).
- **Saídas de modelo:** chamadas ao AI Gateway do workspace.

O app **não envia dados a outros destinos**, exceto servidores MCP ou A2A que o
próprio usuário ou um admin configurou, e a busca na web, quando habilitada pelo admin.

**Por quanto tempo ficam:** até o usuário apagar a conversa, a menos que um admin defina um
período de retenção (`retentionDays`, desligado por padrão). Com a retenção ligada, uma
varredura diária apaga toda conversa parada há mais tempo que isso, com mensagens, artefatos
e arquivos de imagem. As linhas de custo ficam, sem a ligação com a conversa
([operations.md §6.8](operations.md#68-retenção-instruções-da-organização-e-trilha-de-auditoria-de-admin)). Um **chat temporário** (escolhido no menu + do compositor) é a exceção: ele é apagado quando o usuário sai dele, e por uma varredura quando fica parado por 24 horas (com a retenção ligada ou desligada). Ele não grava embeddings, não extrai memória e nunca aparece como resultado de busca; a auditoria guarda apenas uma contagem de quantos foram iniciados, sem id de chat, usuário, título nem conteúdo.
Um **chat temporário** (escolhido no menu + do compositor) é a exceção: é apagado quando o
usuário sai e, se isso não chegar, por uma varredura após 24 horas sem atividade (com a retenção
ligada ou não). Não grava embeddings, não extrai memória e nunca é resultado de busca; a
auditoria guarda só a contagem de quantos foram iniciados, sem id de conversa, usuário, título
nem conteúdo.

*Plataforma:* região, residência e encryption at rest/in transit do workspace.

---

### 4. Os dados são usados para treinar modelos?

Depende do **modelo servido pelo AI Gateway** e dos termos do provedor desse modelo.
O app não tem como mudar essa política. Antes de liberar um modelo, o admin deve
conferir os termos do endpoint no próprio workspace. Este documento não afirma nada
sobre a política de terceiros.

---

### 5. Quais permissões o app usa, e em nome de quem?

Três formas, por recurso (tabela completa em §4 do [modelo de ameaças](../security-threat-model.md)):

- **OBO (token do usuário):** modelos, Genie, SQL Warehouse (UC Functions e UDF
  Python, e a criação única do Volume de imagens), Vector Search e conexões MCP do usuário. O usuário só alcança o que já
  alcança.
- **Service principal do app, por padrão:** Lakebase, Volume de imagens e a listagem de
  sugestões do catálogo MCP.
- **Fallback para a identidade do usuário.** Se o app não tem credenciais de service principal, ou o service principal não consegue fazer login no Lakebase nem alcançá-lo, o app conecta ao Lakebase com o próprio papel Postgres de quem chama, usando o token do usuário como senha. Se o service principal está configurado e depois falha, o app permanece nesse caminho por 5 minutos antes de tentar o service principal de novo; sem nenhuma credencial de service principal não há o que tentar de novo, e o app usa o caminho por usuário diretamente até a configuração mudar (`createWithClient` em `server/db/pool.js`; linha de log `lakebase: service-principal login unavailable, using per-user identity`, alerta A3 em [operations.md](operations.md#52-regras-de-alerta-propostas)). Valem a mesma identidade de `withTx` e as mesmas políticas. A maioria dos usuários do workspace não tem papel no Lakebase, então as suas requisições falham durante um fallback. Logo após conectar, o app confere o papel de fallback: se ele for superusuário ou tiver `BYPASSRLS` (no Lakebase, a identidade que faz o deploy tem), a requisição é recusada com 503 e o trabalho dela nunca roda, então nenhuma requisição roda fora das políticas (lacuna G15 no [modelo de ameaças](../security-threat-model.md#7-declared-gaps); `assertFallbackRlsBound` em `server/db/pool.js`; linha de log `lakebase: per-user fallback refused`). A checagem roda uma vez por conexão e vale quando há credenciais de service principal configuradas ou o app roda no Databricks Apps (`DATABRICKS_APP_*`); o desenvolvimento local contra um Postgres local não é checado. Nenhuma configuração a desliga. Durante uma indisponibilidade do service principal, a identidade que faz o deploy perde o acesso em vez de contornar as políticas. Um erro de permissão (`42501`) ou uma recusa de política nunca aciona o fallback. O Volume de imagens usa o token do usuário quando o token do service principal não pode ser obtido (`storageToken` em `server/imageStore.ts`). Esse caminho exige o escopo `files` do usuário.

Os escopos OBO estão em `user_api_scopes` no `databricks.yml`. Eles precisam estar no
bundle, não no `app.yaml`: o `bundle deploy` não aplica os escopos do `app.yaml`.

*Limitação:* o privilégio de banco do próprio SP é mais amplo do que a leitura de qualquer usuário; a row-level security (resposta 2) o restringe por requisição; em um fallback, um papel que a ignoraria é recusado (G15).

---

### 6. Quem é administrador?

- **Owner:** o e-mail em `APP_OWNER_EMAIL`, quando definido. O bundle **não** define
  essa variável.
- **Admins:** tabela `app_admins`, por e-mail ou por grupo do workspace (a lista de
  grupos vem do SCIM com o token do próprio usuário; se o SCIM falhar, grupos não
  dão acesso).
- **Bootstrap:** o job de auto-config (`bundle/auto_config.py`) grava quem fez o deploy
  como primeiro admin.

Rotas de administração passam por `requireAdmin`. Não há dupla aprovação para mudar admins.

---

### 7. Há trilha de auditoria?

Sim, para ações administrativas, e há outras fontes para o resto:

- **Ações de admin (app):** toda mudança de admin grava uma linha na tabela `admin_audit`
  na mesma transação da mudança. Isso cobre admins, catálogo MCP, política de ferramentas,
  escopo de template, templates e skills globais, endpoints de modelo e as configurações
  de retenção e de instruções da organização. A varredura de retenção também grava uma
  linha com as contagens. Iniciar um chat temporário insere uma linha só de contagem (`ephemeral.started`, ator `system`, sem alvo, sem id de chat, usuário, título nem conteúdo; migração 0011, política `aipe_started_insert`), que os admins leem como um número por `GET /api/admin/ephemeral-chats`. O ator fica como hash, nunca o e-mail: com `APP_AUDIT_HASH_KEY`
  definida, é um HMAC com chave (prefixo `h2:`) que **não** coincide com o `user_hash` dos
  logs, de propósito; sem a chave, é o mesmo `user_hash` sem sal dos logs ([como correlacionar
  os dois](security-threat-model.md#61-correlacionando-a-trilha-de-auditoria-com-os-logs)). O app não consegue alterar nem apagar linhas. Admins leem com
  `GET /api/admin/audit` ([operations.md §6.8](operations.md#68-retenção-instruções-da-organização-e-trilha-de-auditoria-de-admin)).
- **Plataforma:** `system.access.audit` registra eventos do workspace e do Unity Catalog.
  É a fonte de referência para quem fez o quê fora do app.
- **App:** `usage_ledger` (custo por chamada, por usuário e sessão) e as próprias
  mensagens do chat.
- **Logs:** linhas JSON estruturadas com `request_id` e `user_hash` (o hash sem chave), com
  e-mails, tokens e SQL redigidos (`server/log.ts`). A retenção é
  definida pela plataforma (como consultar: [operations.md](operations.md)).

*Limite:* o que os usuários fazem nas próprias conversas não está em `admin_audit`. As
mensagens e o `usage_ledger` são o registro.

---

### 8. O app executa código gerado pelo modelo?

**Não no processo do app.** A ferramenta Python roda como UC Function (UDF) em um SQL
Warehouse serverless, com o token do usuário. A execução fica no sandbox do warehouse e
é limitada ao que o usuário pode executar. As ferramentas de Unity Catalog seguem a
mesma regra.

---

### 9. O conteúdo que o modelo gera pode executar scripts no navegador?

Há três camadas, e nenhuma é suficiente sozinha:

- Markdown: o cliente não renderiza HTML cru (sem `rehype-raw`).
- Slides HTML: `<script>` é removido ao persistir (`sanitizeHtmlDeck`), e o iframe usa
  `sandbox="allow-scripts"` **sem** `allow-same-origin`, portanto com origem opaca: sem
  acesso a cookies, armazenamento ou DOM do app.
- Um iframe de preview usa `allow-same-origin`, mas **sem** `allow-scripts`.

---

### 10. Prompt injection pode fazer o modelo agir contra o usuário?

**Risco aberto, e não há como eliminá-lo com o estado atual.** Um servidor MCP ou uma
página da web pode trazer instruções no conteúdo, e hoje:

- Descrições, instruções e schemas de tools MCP, títulos de salas Genie e comentários de
  funções UC são neutralizados antes de chegar ao prompt (`server/toolMetadata.ts`, G7
  mitigada). Isso reduz o risco; não o elimina.
- Os resultados da busca na web vão dentro de um envelope fixo de "conteúdo externo, não
  confiável" (G12, mitigada para `web_search`). Anexos e o texto do `web_fetch` ainda
  entram no contexto sem essa marcação (G12, aberta para esses dois).

O que limita o dano: as ferramentas que alcançam dados do workspace (Genie, SQL Warehouse e UC Functions, Vector Search, as conexões MCP do usuário, modelos) rodam com o token OBO do usuário, então uma injeção não alcança dados do workspace que o usuário já não alcance. O armazenamento do próprio app funciona de outro modo. O Lakebase e o Volume de imagens são alcançados com o service principal do app por padrão, e com a identidade do próprio chamador apenas como fallback ([pergunta 5](#5-quais-permissões-o-app-usa-e-em-nome-de-quem)). Em qualquer das identidades, o modelo não recebe conexão de banco e não escolhe caminho de armazenamento. Toda leitura ou escrita de dados do app é código do app que roda dentro de `withTx` com a identidade do chamador; no caminho do service principal ela roda sob row-level security, e o fallback por usuário recusa um papel que ignoraria as políticas (G15). Um arquivo de imagem só é alcançado pela sua linha em `chat_images`. Uma injeção, portanto, não amplia o que essas checagens permitem. O risco real é o modelo executar
uma **escrita** que o usuário não pretendia. Por isso a recomendação é restringir
ferramentas de escrita por política (`app_tool_policy`) e exigir confirmação humana.

---

### 11. Há proteção contra SSRF?

Sim, no fetch da web (`server/web.ts`): bloqueia `localhost`, IPs privados (IPv4 e
IPv6, inclusive mapeados), resolve o DNS antes de conectar e limita redirects. Há teste
em `server/web.test.ts`. Os usuários não informam URLs de servidores MCP: uma conexão MCP é um
serviço do Unity Catalog, e o app monta o endereço como o host do workspace mais
`/ai-gateway/mcp-services/<name>`, com o nome codificado como URL em um único segmento de
caminho (`externalMcpUrl`, `server/externalMcp.ts`); `/api/mcp/connections/:name` responde
400 a nomes com caracteres de caminho ou de query. Quem chama o servidor externo é o
gateway do workspace, não o app. A ferramenta `web_fetch` é o único ponto em que o próprio
app busca uma URL pública arbitrária, e é esse o caminho com as checagens anti-SSRF.

---

### 12. Há rate limit ou proteção contra abuso de custo?

**Sim, por usuário (G4, mitigada).** `server/middleware/rateLimit.ts` dá a cada usuário
um token bucket com a chave da identidade que o proxy do Apps encaminha
(`x-forwarded-email`), nunca só o IP, porque muitos usuários saem pelo mesmo IP:

- 120 requisições `/api` por minuto (`RATE_LIMIT_API_PER_MIN`) e 12 turnos de modelo por
  minuto (`RATE_LIMIT_TURNS_PER_MIN`: chat, continue, regenerate, compact e os tweaks dos
  estúdios). `0` desliga um limite. Acima do limite, a resposta é `429` com `Retry-After`.
- Limites de corpo, por classe de rota numa única tabela explícita
  (`server/middleware/security.ts`; toda rota de escrita tem classe): JSON até 1 MB por
  padrão; 40 MB na importação ou atualização de design system; 46 MiB no salvamento, na
  edição por IA e no export nativo do estúdio de deck e na edição por IA da planilha, que
  levam slides, notas do apresentador e imagens como data URLs (um deck de 40 slides com fundo
  de marca em cada um exporta um corpo de 25,6 MB; o estúdio de deck limita as entradas a 9 MiB
  por nota do apresentador e quatro anexos de 6 MiB cada, e uma edição por IA nesses tetos tem
  45,4 MB; acima de um teto, a resposta é `413` com o limite); 4 MB no salvamento de planilha. Upload do chat até 80 MB e
  10 arquivos, upload de skill até 5 MB e 1 arquivo. Acima do limite, a resposta é `413`.
  No boot AppKit, o parser JSON do próprio AppKit lê o corpo de toda rota (até 64 MB, o teto de memória por requisição) antes dos
  middlewares do app: o limite por rota continua respondendo `413` pelo `Content-Length`
  declarado, e um corpo JSON sem ele (chunked) recebe `411 Length Required`, porque o objeto
  parseado não mostra quantos bytes chegaram. Os bytes já foram lidos, então é uma checagem
  de política, não uma proteção de memória. No boot legado o parser conta o próprio stream,
  chunked ou não.
- Limites de recurso: SQL Warehouse 2X-Small, `max_num_clusters: 1`, auto-stop de 10 min;
  Lakebase com teto de 16 CU.
- Visibilidade: `usage_ledger` por usuário e o dashboard de custos.

*Limites deste controle:* os buckets ficam em cada processo do app, então várias
instâncias multiplicam o teto, e um limite de requisições não é um teto de gasto.
*Recomendação:* orçamentos por usuário ou grupo no Unity AI Gateway para o teto de custo.

---

### 13. Como as chaves e senhas são guardadas?

- **Nenhum segredo no repositório.** `.env` está no `.gitignore`; `.env.example` não tem
  valores reais.
- **Service principal:** `DATABRICKS_CLIENT_ID` e `DATABRICKS_CLIENT_SECRET` são
  injetados pelo runtime do Apps.
- **`PGPASSWORD`:** existe apenas para o banco local de desenvolvimento.
- **Tokens do usuário:** chegam por requisição, no cabeçalho do proxy.

*Plataforma:* rotação e armazenamento do segredo do SP.

---

### 14. A conexão com o banco é verificada?

**Parcialmente, e desligado por padrão (G3, aberta).** O TLS vem ligado por padrão (`PGSSLMODE=require`, definido no `app.yaml`); `PGSSLMODE=disable` o desliga e serve só para um banco local. O certificado do servidor só é verificado se você optar: defina
`PG_SSL_CA` (um PEM ou um caminho de arquivo; ancora a CA e liga a verificação) ou
`PG_SSL_VERIFY=1` (verifica contra o repositório de confiança do Node); um `0` explícito a
desliga (`pgSslOptions` em `server/db/pool.js`, `SECURITY.md`, testes em
`server/pgSsl.test.js`). Sem nenhuma das duas, a conexão é criptografada, mas a identidade
do servidor não é validada, o que a deixa exposta a um intermediário que consiga
interceptar a rede dentro do workspace. Não é o padrão porque a cadeia do Lakebase ainda
não foi confirmada contra o repositório de confiança do runtime em um deploy real
(G-live-6). Até lá, defina a variável no seu deploy ou aceite o risco formalmente.

---

### 15. A aplicação tem cabeçalhos de segurança (CSP, HSTS)?

**Parcial (G6).** Em toda resposta o app define `X-Content-Type-Options: nosniff`,
`Referrer-Policy: same-origin`, `X-Frame-Options: SAMEORIGIN` e
`Permissions-Policy: microphone=(self), camera=()` (o microfone só para o ditado do próprio
app), remove `X-Powered-By` e envia duas CSPs:

- **Aplicada**, conservadora: `frame-ancestors 'self'; base-uri 'self'; object-src 'none';
  form-action 'self'` (`server/securityHeaders.ts`).
- **Report-only**, a política alvo: `default-src 'self'; script-src 'self'; style-src 'self'
  'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-src 'self' blob:;
  frame-ancestors 'none'` (`server/middleware/security.ts`). O navegador não bloqueia nada
  com ela; só reporta para `POST /api/csp-report`, que grava uma linha JSON por violação
  com a diretiva, a origem bloqueada, o caminho do documento e a disposição, sem query
  string, amostra nem identidade.

A política alvo ainda não é aplicada porque os iframes `srcdoc` dos decks e dos previews de
design system herdam a política da página e precisam de script inline e de assets do
design system em outros hosts (motivo em [SECURITY.md](SECURITY.md#proteções-http)). Os
relatórios coletados são a evidência necessária antes de aplicá-la. `Referrer-Policy` fica
em `same-origin`, mais estrita que `strict-origin-when-cross-origin`: sites externos não
recebem referrer nenhum. HSTS é do proxy do Apps; o que o proxy acrescenta na resposta não
foi verificado (modelo de ameaças §7.1).

---

### 16. Existe proteção contra CSRF?

**Sim (G5, mitigada).** `server/csrfGuard.ts` recusa com 403 qualquer
`POST`/`PUT`/`PATCH`/`DELETE` em `/api/*` vindo de outro site, antes de cobrar o rate limit
do usuário e, no boot legado, antes de ler o corpo (no boot AppKit, o parser JSON do AppKit
já o leu): `Sec-Fetch-Site: cross-site` é sempre recusado, mesmo
quando o `Origin` parece o do app; fora isso, `Origin`/`Referer` de outro host é recusado. Não
há token anti-CSRF: a checagem de origem cobre os navegadores atuais e não depende do
`SameSite` do cookie do proxy, que segue não verificado. Chamadas sem nenhum desses
cabeçalhos (scripts, `npm run smoke`) passam, porque não vêm de navegador.

---

### 17. Dependências são auditadas?

**Reportado, não imposto (G9, aberta).** O CI roda `npm audit` (conjunto de runtime e árvore
completa) em uma etapa só de relatório que nunca falha o job, e o `.npmrc` tem `audit=false`
para a instalação no deploy. Não há automação de atualização de dependências nem barreira
sobre os achados. O que existe: `npm ci` com lockfile (com `--ignore-scripts`) e o deploy
que roda o bundle. O bundle embute as dependências, então uma vulnerabilidade em uma delas
continua presente no artefato até que o bundle seja reconstruído em um release.

---

### 18. Como reportar uma vulnerabilidade?

Pelo canal privado do GitHub (aba **Security**), conforme o [SECURITY.md](SECURITY.md).
Não abra issue pública com detalhes técnicos.

---

### 19. O que a plataforma faz e o que é responsabilidade de quem faz o deploy?

| Assunto | Plataforma Databricks | Quem faz o deploy |
|---|---|---|
| Autenticação e SSO | Apps proxy, OAuth | Configura o workspace e os grupos |
| Criptografia em repouso e em trânsito | Lakebase, UC, Volumes, Apps | Escolhe chaves gerenciadas, se exigidas |
| Isolamento de rede | Rede do workspace e do Lakebase | Configura a rede (ex.: private link) |
| Permissões de dados | UC, Genie, Vector Search | Concede acesso a tabelas e espaços |
| Custo e limites | SQL Warehouse, Lakebase, AI Gateway | Define orçamentos e auto-stop |
| Isolamento entre usuários no banco | O Lakebase aplica as políticas; não as cria | O app as entrega (row-level security com `FORCE`, migração 0003); quem faz o deploy mantém o papel do app sem ser dono e sem `BYPASSRLS`, e roda a suíte de isolamento contra uma branch real (G2, G13) |
| Auditoria de plataforma | `system.access.audit` | Mantém retenção e acesso à tabela |
| Varredura de dependências e CVEs | — | Lê a saída do `npm audit` (só relatório), aplica as correções e reconstrói o bundle (G9) |
| Rate limit e cota de uso | Limites de requisição e de turno por usuário no app; orçamentos no AI Gateway | Configura orçamentos por usuário |

---

### 20. O que a memória guarda, e como apagar?

- **O quê:** fatos curtos sobre um usuário (no máximo 200 entradas de 500 caracteres
  cada), cada um com categoria, origem (digitado pelo usuário ou aprendido depois de um
  turno) e, para um fato aprendido, o chat de onde veio. Tabela `user_memories` no
  Lakebase, migração 0006.
- **Quem lê:** só o dono. Row-level security em `user_memories` (`app.user_email`), como
  nos chats; admins não têm acesso.
- **O que é aprendido:** depois que um turno é respondido, o modelo pequeno do
  classificador de intenção lê **só a mensagem do usuário** (nunca a resposta, resultados
  de ferramentas ou conteúdo da web) e pode guardar até três fatos. Só roda em mensagens
  curtas com uma pista de primeira pessoa e sem cara de texto colado (sem citações, blocos
  de código ou cabeçalhos de e-mail), e descarta qualquer fato que pareça instrução ao
  assistente ou que traga link ou endereço, então um texto de terceiros colado não planta
  uma instrução duradoura. Ele nunca guarda
  saúde, política, religião ou finanças pessoais; uma entrada sensível digitada pelo
  usuário só é usada depois que ele der o consentimento naquela entrada. Um turno
  cancelado não aprende nada. A chamada entra no ledger com kind `memory`.
- **O que chega ao modelo:** no máximo 10 entradas por turno e no máximo 1.500 tokens,
  contados de forma conservadora por sistema de escrita (cerca do dobro da taxa usual em
  qualquer idioma, então escritas densas como o chinês não estouram o limite),
  marcadas como dados não confiáveis, não instruções, com os marcadores do bloco
  neutralizados dentro das entradas, então uma entrada não se passa por instrução de
  sistema (ver a pergunta 10).
- **Logs:** o texto da memória nunca é registrado em log.
- **Como apagar:** o usuário exclui uma entrada ou todas (`DELETE /api/memory/:id`,
  `DELETE /api/memory`). "Esquecer tudo" também grava uma marca por usuário
  (`user_memory_state.forgot_at`), então uma extração ainda em andamento em qualquer
  instância do app não grava nada depois; excluir um chat não apaga o que foi aprendido nele. Um admin
  desliga o recurso com a chave de política de ferramentas `memory` (Configurações →
  Ferramentas): nada é aprendido, injetado nem listado; as linhas guardadas ficam até o
  dono excluí-las, e excluir continua funcionando. Reverter a migração 0006 apaga a
  tabela e todas as entradas.

*Plataforma:* a mesma criptografia, residência e backup do Lakebase que o resto dos dados.
