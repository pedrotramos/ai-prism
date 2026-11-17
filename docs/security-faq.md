# FAQ de segurança do AI Prism

Respostas às objeções que aparecem em revisões de segurança. Cada resposta separa o
que **o app faz** (código deste repositório) do que **a plataforma Databricks ou o
serverless provê**. Quando a resposta depende de configuração do workspace, isso está
dito. Para o detalhamento, veja o [modelo de ameaças](security-threat-model.md)
(identificadores G1–G13 e C1–C16 vêm de lá).

---

### 1. O app implementa login?

**Não.** O app não tem tela nem fluxo de autenticação próprio. O **Apps proxy** do
workspace autentica o usuário (OAuth/SSO) e encaminha a requisição com
`x-forwarded-email` e `x-forwarded-access-token`. O app lê esses cabeçalhos
(`server/index.js`, `userEmail` e `userToken`) e responde 401 quando não há token.

*Plataforma:* autenticação, SSO, expiração de sessão e revogação de acesso.
*App:* confia nos cabeçalhos do proxy (G1 trata o caso em que o e-mail falta).

---

### 2. Um usuário consegue ver a conversa de outro?

**Não por desenho, mas o isolamento é aplicação, não banco.** Todas as leituras de
conversa, mensagem, artefato e busca filtram pelo dono (`WHERE user_email` ou JOIN com
`chat_sessions`). Um `sessionId` alheio recebe 403 antes do stream.

Ponto que um revisor deve saber: as consultas rodam com o **service principal** do app
(`withClient`, `server/db.js`), que tem DML em todas as tabelas do schema `public`, e
**não há RLS** nem teste automatizado de dois usuários. Um erro em uma query nova pode
expor dados de outro usuário. Esta é a lacuna de maior impacto do projeto (G2 e G13).

*Mitigação planejada:* schema dedicado com papéis mínimos, RLS com `FORCE` e suíte de
isolamento na CI.

---

### 3. Onde os dados ficam?

- **Conversas, artefatos, embeddings e ledger:** Lakebase (Postgres serverless) do
  próprio workspace, criado pelo `databricks.yml`.
- **Imagens geradas:** UC Volume `ai_prism_images` no catálogo `ai_prism`.
- **Dados consultados:** Unity Catalog, Genie e Vector Search, sempre com o token do
  usuário (OBO).
- **Saídas de modelo:** chamadas ao AI Gateway do workspace.

O app **não envia dados a outros destinos**, exceto servidores MCP ou A2A que o
próprio usuário ou um admin configurou, e a busca na web, quando habilitada pelo admin.

*Plataforma:* região, residência e encryption at rest/in transit do workspace.

---

### 4. Os dados são usados para treinar modelos?

Depende do **modelo servido pelo AI Gateway** e dos termos do provedor desse modelo.
O app não tem como mudar essa política. Antes de liberar um modelo, o admin deve
conferir os termos do endpoint no próprio workspace. Este documento não afirma nada
sobre a política de terceiros.

---

### 5. Quais permissões o app usa, e em nome de quem?

Dois modos, por recurso (tabela completa em §4 do [modelo de ameaças](security-threat-model.md)):

- **OBO (token do usuário):** modelos, Genie, SQL Warehouse (UC Functions e UDF
  Python), Vector Search e conexões MCP do usuário. O usuário só alcança o que já
  alcança.
- **Service principal do app:** Lakebase (padrão), Volume de imagens e a listagem de
  sugestões do catálogo MCP.

Os escopos OBO estão em `user_api_scopes` no `databricks.yml`. Eles precisam estar no
bundle, não no `app.yaml`: o `bundle deploy` não aplica os escopos do `app.yaml`.

*Limitação:* o SP tem mais privilégio do que a leitura de um usuário, pelo motivo da
resposta 2.

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

Há **três fontes**, e nenhuma é uma trilha de auditoria completa do app:

- **Plataforma:** `system.access.audit` registra eventos do workspace e do Unity Catalog.
  É a fonte de referência para quem fez o quê.
- **App:** `usage_ledger` (custo por chamada, por usuário e sessão) e as próprias
  mensagens do chat.
- **Logs:** saída de `console` do processo, sem formato estruturado. A retenção é
  definida pela plataforma (como consultar: [operations.md](operations.md)).

*Lacuna (G8):* ações administrativas (criar admin, mudar o catálogo MCP, alterar
templates) não têm tabela de auditoria própria no app.

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

- As descrições de tools MCP chegam ao prompt com truncamento a 300 caracteres e sem
  sanitização específica (G7).
- Anexos entram no contexto como texto, sem marcação de "não confiável" (G12).

O que limita o dano: cada ferramenta roda com o OBO do usuário, então uma injeção não
amplia privilégio além do que o usuário pode fazer. O risco real é o modelo executar
uma **escrita** que o usuário não pretendia. Por isso a recomendação é restringir
ferramentas de escrita por política (`app_tool_policy`) e exigir confirmação humana.

---

### 11. Há proteção contra SSRF?

Sim, no fetch da web (`server/web.js`): bloqueia `localhost`, IPs privados (IPv4 e
IPv6, inclusive mapeados), resolve o DNS antes de conectar e limita redirects. Há teste
em `server/web.test.js`. O mesmo controle **não** foi verificado para URLs de servidores
MCP informadas pelo usuário; trate isso como pendência antes de uma revisão formal.

---

### 12. Há rate limit ou proteção contra abuso de custo?

**Não no app (G4).** Um usuário autenticado pode disparar muitos turnos. As proteções
que existem:

- Limites de recurso: SQL Warehouse 2X-Small, `max_num_clusters: 1`, auto-stop de 10 min;
  Lakebase com teto de 16 CU.
- Visibilidade: `usage_ledger` por usuário e o dashboard de custos.

*Recomendação:* orçamento nativo do workspace por usuário ou grupo, e limite de taxa no
proxy, se o workspace oferecer.

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

**Parcialmente (G3).** A conexão usa TLS (`PGSSLMODE=require`), mas com
`rejectUnauthorized: false` em `server/db.js`, então a identidade do servidor não é
validado contra uma CA. Isso deixa a conexão exposta a um intermediário que consiga
interceptar a rede dentro do workspace. A correção é ancorar a CA do Lakebase; até lá,
o risco deve ser aceito formalmente.

---

### 15. A aplicação tem cabeçalhos de segurança (CSP, HSTS)?

**Não verificado (G6).** O Express não define cabeçalhos de segurança próprios
(`helmet` não está no projeto). Confirme o que o proxy do Apps acrescenta na resposta
antes de afirmar qualquer cabeçalho.

---

### 16. Existe proteção contra CSRF?

**Não verificado (G5).** As rotas de escrita não têm token anti-CSRF próprio. A proteção
depende de como o proxy emite a credencial (cookie `SameSite` ou cabeçalho
`Authorization`). Trate como pendência até confirmar o comportamento do proxy.

---

### 17. Dependências são auditadas?

**Não no CI hoje (G9).** O `.npmrc` tem `audit=false`, e o CI não roda `npm audit` nem
varredura de dependências. O que existe: `npm ci` com lockfile (com `--ignore-scripts`)
e o deploy que roda o bundle commitado. O bundle embute as dependências de runtime, então
uma vulnerabilidade em uma dependência continua presente no artefato até que o bundle
seja regenerado.

---

### 18. Como reportar uma vulnerabilidade?

Pelo canal privado do GitHub (aba **Security**), conforme o [SECURITY.md](../SECURITY.md).
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
| Isolamento entre usuários no banco | **Não provido** (é aplicação) | Revisa queries novas (ver G2) |
| Auditoria de plataforma | `system.access.audit` | Mantém retenção e acesso à tabela |
| Varredura de dependências e CVEs | — | Roda varredura e regenera o bundle |
| Rate limit e cota de uso | Parcial (proxy e orçamentos) | Configura orçamentos por usuário |
