<!-- i18n: source=SECURITY.md source-hash=bffbe1c011c1732777b98981674726a3423693f8 status=current -->
# Política de Segurança

[English](../../SECURITY.md) · **Português (Brasil)** · [Español](../es/SECURITY.md)

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
  Veja o [`.env.example`](../../.env.example) e o [`.gitignore`](../../.gitignore) — `.env` é ignorado.

## Identidade da requisição

Quem é o usuário vem só do proxy do Databricks Apps (`server/requestIdentity.ts`):

- No runtime de Apps (presença de `DATABRICKS_APP_NAME`, `DATABRICKS_APP_PORT` ou
  `DATABRICKS_APP_URL`), a requisição precisa do header `x-forwarded-email` e do
  `x-forwarded-access-token`. Faltando qualquer um, a resposta é **401**. Nenhum e-mail
  ou token vem do ambiente nesse caso.
- Fora do runtime, o ambiente só entra com `LOCAL_DEV_MODE=1` (o `.env.local` do
  `npm run dev:local`) ou `LOCAL_DEV_IDENTITY=1`. `NODE_ENV` não conta: o npm o define
  como `production` nos scripts do repo. Nesse modo o servidor só escuta em
  `127.0.0.1` (`listenHost()`): uma requisição sem headers vira o dono do app, então a
  porta não fica exposta na rede local. No runtime de Apps ele escuta em `0.0.0.0`.

### Vínculo entre e-mail e token (`server/identityBinding.ts`)

O e-mail do header escopa todas as consultas, e o Lakebase conecta como o service
principal do app (não como o usuário). Sem vínculo, uma requisição que chegasse ao
processo sem passar pelo proxy, com `x-forwarded-email: <qualquer pessoa>` e qualquer
token, viraria essa pessoa (inclusive o dono/admin). Por isso, a cada requisição
autenticada, o app pergunta ao workspace de quem é o token (`SCIM /Me` com o próprio
token, o mesmo chamado que `server/authz.ts` usa para grupos; o escopo
`iam.current-user:read` é concedido automaticamente ao token OBO):

- O e-mail do header precisa ser igual ao `userName` **ou** a qualquer
  `emails[].value` do dono do token (comparação sem maiúsculas/minúsculas). Basta um
  bater: um `userName` que não é o e-mail (usuário externo, como
  `nome_dominio#EXT#@tenant…`, ou um login que não é e-mail) passa se o e-mail estiver em
  `emails`. Só quando nenhum bate a resposta é **401** `{"code":"identity_mismatch"}`.
  Nenhum outro campo conta: o `applicationId` de um service principal não prova a posse
  de um e-mail, e um `/Me` sem `userName` nem `emails` (token de service principal) dá
  `identity_mismatch` em `enforce`. Se o app precisar atender chamadas de service
  principal pelo proxy, use `warn` e verifique nos logs o que o proxy encaminha para elas. Token que o workspace recusa (401, ou 403 "Invalid
  access token") → **401** `{"code":"invalid_token"}`.
- Um resultado definitivo fica em cache por 5 min (um não verificado, como timeout ou 5xx, por 30 s), chaveado pelo `sha256` do token (nunca o token
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
| `warn` | Divergência ou token inválido **não é rejeitado**: só gera log (`identity-binding: identity_mismatch: …` ou `identity-binding: invalid_token: …`) e a requisição passa. É o **rollback seguro** se um workspace se comportar de forma inesperada (ex.: usuários legítimos recebendo 401) |
| `off` | Desliga a verificação (o comportamento anterior; nenhuma consulta ao workspace) |

Defina no `env` do `app.yaml` (o `config.env` do `databricks.yml` não chega ao app).
Valor inválido cai no padrão (`enforce` no runtime): erro de digitação nunca desliga a
checagem.

**Primeiro deploy (ou primeiro deploy num workspace novo):** depois de abrir o app com
alguns usuários reais, procure nos logs (`databricks apps logs <app> -p <PROFILE>`) por
`identity_mismatch` e `invalid_token`. Nenhuma ocorrência inesperada: mantenha `enforce`.
Usuários legítimos recebendo 401: defina `IDENTITY_BINDING=warn` no `env` do `app.yaml`,
faça deploy, colete as linhas `identity-binding:` (elas não trazem e-mail nem token) e
volte para `enforce` quando a causa estiver resolvida. Use `off` só se o `warn` não
bastar.

**O que isto verifica e o que continua dependendo do proxy.** Verificado pelo app: que
o par e-mail/token foi emitido pelo workspace para a mesma pessoa. Continua dependendo da
plataforma: que o proxy autentica o usuário e é o único caminho até o processo, e que ele
sobrescreve (não repassa) os `x-forwarded-*` do cliente. Quem rouba um token válido de
outra pessoa ainda age como ela; isso é o modelo de qualquer bearer token.

## Proteções HTTP

| Proteção | Onde | O que bloqueia |
|---|---|---|
| **CSRF** | `server/csrfGuard.ts`, em `/api/*` antes do parse do corpo | `POST`/`PUT`/`PATCH`/`DELETE` vindos de outro site: passa com `Sec-Fetch-Site` `same-origin`/`none`, ou com `Origin` (ou, sem ele, `Referer`) cujo host é o da requisição (`Host`/`X-Forwarded-Host`) ou o de `DATABRICKS_APP_URL`, comparando esquema, host e porta, com a porta padrão normalizada (`:443` em https, `:80` em http; outra porta, ou o mesmo host e porta no outro esquema, é outra origem). Requisição sem nenhum dos três cabeçalhos (curl, scripts, `npm run smoke`) passa: não vem de navegador. O resto recebe **403** `{"code":"cross_site_request"}`. Motivo: `/api/chat` aceita `multipart/form-data`, que um `<form>` de outro site envia sem preflight |
| **Cabeçalhos** | `server/securityHeaders.ts` | `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`, `X-Frame-Options: SAMEORIGIN`, sem `X-Powered-By` e uma CSP conservadora: `frame-ancestors 'self'; base-uri 'self'; object-src 'none'; form-action 'self'` |
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
  na mesma instrução (`server/ownerScopedWrites.ts`): reativação de variantes (o
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
documento) passa por `server/toolMetadata.ts`: imperativos ("ignore as instruções"),
rótulos de papel ("system:"), HTML e links são neutralizados, e o texto é limitado em
tamanho. Essa é uma defesa parcial contra injeção de prompt, não uma garantia: o modelo
ainda pode ser influenciado por texto que não casa com os padrões. Por isso o dado de
ferramenta não deve ser tratado como instrução confiável.

Documentos Markdown são gravados sem HTML cru e sem links com esquema perigoso
(`shared/markdownSafety.js`): o editor WYSIWYG renderiza com `innerHTML`, então isso
impede que um membro de projeto execute código no editor de outro.

### HTML de design system (miniaturas de template)

Um design system (DS) é HTML/CSS que vem de fora (bundle de agência, export do Figma,
zip) e um DS **global** aparece para todos os usuários na tela de Modelos. Por isso a
miniatura do primeiro slide tem duas camadas:

- **iframe sempre com `sandbox`** (`client/src/components/DeckTemplatesSettings.jsx`):
  sem o atributo, um documento `srcdoc` roda com a origem do próprio app e poderia chamar
  `/api/sessions` como quem está vendo a tela (ler os chats dessa pessoa). Agora a
  miniatura usa `sandbox=""` (nenhum script) e o inspetor de DS usa
  `sandbox="allow-scripts"` sem `allow-same-origin` (origem opaca, sem acesso à API).
- **HTML sanitizado no servidor** (`server/sanitizeDsHtml.ts`, aplicado por
  `extractFirstTemplateSlide` em `server/db.js` na leitura, então vale também para DS já
  gravados), com a biblioteca `sanitize-html` e uma allowlist feita para slides:
  estrutura, texto, listas, tabelas, `img`, desenho `svg` e blocos `<style>`. Ficam de fora
  `script`, atributos `on*`, `iframe`/`object`/`embed`, `base`, `meta`, `form` e
  `foreignObject`. URLs: `http`, `https`, `mailto` e relativas; `data:` só em `<img>` e só
  `data:image/*`; `<use>` só aponta para um `#fragmento`. Testes em
  `server/sanitizeDsHtml.test.ts`.
- **CSS sem recursos de outros hosts** (`stripRemoteCssUrls`, no mesmo arquivo): o sandbox
  impede scripts, mas não impede que CSS baixe arquivos. Vale para os blocos `<style>`, os
  atributos `style` e os atributos de pintura do SVG (`fill`, `stroke`, `clip-path`, `mask`,
  `filter`, `marker-*`). O CSS é primeiro **normalizado**: cada comentário `/* */` fora de
  strings vira um espaço (ele separa tokens), NUL é removido (dentro de uma string, `/* */` é
  texto e fica) e escapes que formam uma
  letra ASCII ou `-` (`\68`, `h\74tp`) são decodificados.
  O texto normalizado é o que se verifica **e** o que vai para o navegador. Regras:
  - `url(…)` só fica se o argumento for exatamente uma string entre aspas ou um token sem
    aspas cujo valor seja um URI `data:` de imagem ou fonte, um caminho relativo ou um
    `#fragmento`;
  - qualquer outro caso, ou caso ambíguo (aspa solta, barra invertida restante, parêntese
    desbalanceado), **remove a declaração inteira**. Sem um trecho balanceado, a remoção vai
    até o fim do CSS;
  - `@import`, `image-set()`, `-webkit-image-set()`, `image()`, `cross-fade()`,
    `-webkit-cross-fade()`, `element()` e `src()` são sempre removidos;
  - um atributo de pintura afetado vira `none`; um atributo `style` que fica vazio é
    removido;
  - a busca não distingue maiúsculas e também acha os nomes dentro de strings, então só
    pode remover a mais (ex.: `content:"url(https://…)"` também sai).

  Isso **não** é um tokenizador de CSS: é conservador por construção, e linear (duas
  varreduras da esquerda para a direita, sem reprocessar trechos: o tempo cresce na
  proporção do tamanho da entrada; os testes exigem que uma entrada malformada de 2 MB
  termine em menos de 1 s). Sem essa camada, um DS
  global faria o navegador de cada pessoa que abre a tela chamar um terceiro (rastreamento).
  Efeitos visuais: comentários de CSS viram um espaço, uma fonte de CDN importada pelo CSS do DS (ex.:
  Google Fonts) não carrega mais na miniatura, e uma lista `src` de `@font-face` com qualquer
  entrada remota perde a declaração `src` inteira. As fontes da marca continuam vindo como
  `data:` pelo CSS de tokens. **Ainda permitido:** `<img src>` com `http(s)` (a política de
  URLs acima), que também gera uma requisição para fora.
- **Tokens do DS validados na gravação** (`server/templatePayload.ts`, chamado por
  `validateTemplatePayload`): o cliente monta um `<style>` com `fontAssets[]` (família,
  peso, estilo, `dataUrl`), `headingFont`, `bodyFont` e `palette[].varName` **depois** da
  sanitização, então cada campo aceita só uma lista de caracteres (sem aspas, `\`, `;`,
  `{`, `}`, `<`, `>` ou `/`) e um tamanho máximo, e `dataUrl` precisa ser uma fonte em base64
  (`font/*`, `application/(x-)font-*`, EOT ou `application/octet-stream`, que o importador
  usa para extensões desconhecidas). Payload inválido dá 400 com o nome do campo.

**Por que `sanitize-html`:** é mantida e tem defesas específicas, com testes, para os casos
em que o parser dela e o navegador divergem. Ela escapa `<` dentro de `<style>` sob
`svg`/`math`, escapa o conteúdo de `textarea`/`xmp` e re-sanitiza o fallback de `iframe`. O
parser que ela usa (htmlparser2) não é conforme à especificação HTML: o próprio README dele
diz que toma atalhos. A segurança vem dessas defesas, da allowlist e do sandbox, não do
parser. É JS puro e roda no servidor sem DOM. DOMPurify precisaria de um DOM no Node
(jsdom ou linkedom), o que pesa mais no bundle e é mais uma dependência para manter.

**Outros iframes `srcdoc` revisados:**

| Onde | Sandbox | Avaliação |
|---|---|---|
| `DeckTemplateInspector.jsx:120,131` e a miniatura sem `previewCardHtml` (`DeckTemplatesSettings.jsx`) | `allow-scripts` | Aceitável. Os scripts do DS rodam com origem opaca (sem cookie, sem `/api` do app, sem navegar o topo nem abrir pop-ups). Eles ainda podem fazer requisições de rede para fora, mas o que está no frame é só o próprio DS. |
| `deck/HtmlSlideFrame.jsx:103`, `deck/HtmlSlideEditor.jsx:776` | `allow-scripts` | **Follow-up.** O HTML dos slides vem do modelo, e o servidor (`sanitizeHtmlDeck`, `server/blocks.ts:75`) só remove `<script>…</script>` por regex: atributos `on*` sobrevivem e rodam nesses frames. A origem é opaca (sem acesso à API), mas um slide gerado por injeção de prompt pode mandar o conteúdo do slide para fora e, no editor, enviar uma mensagem `html` que o pai aceita (`e.source` confere) e grava no próprio deck. Correção proposta: sanitizar o HTML do deck no servidor com a mesma biblioteca (o runtime do editor é injetado pelo cliente, então o conteúdo pode ficar sem handlers) e uma CSP com `connect-src`. |
| `lib/domToSlideOps.js:457`, `allow-same-origin`, sem scripts | `allow-same-origin` | Aceitável. Frame oculto para medir o layout na exportação. Os scripts e handlers não rodam, e nenhum nó do frame é movido para o documento principal. Não acrescente `allow-scripts` aqui: com `allow-same-origin` isso dá acesso total ao app. |
| `HtmlDeckPreview.jsx:53`, `allow-same-origin`, sem scripts | `allow-same-origin` | Aceitável, mesma regra. O componente não é importado em lugar nenhum (código morto, candidato a remoção). |

**Follow-up de teste:** a presença do `sandbox` hoje é verificada no código-fonte
(`server/iframeSandbox.test.js`). Falta um teste de UI que renderize a miniatura e
inspecione o `<iframe>` produzido.

O que isso **não** cobre: o próprio DS continua sendo conteúdo confiável para o prompt
(um DS global influencia os decks de todos), e a CSP do app (acima) não restringe
scripts, estilos, imagens nem `connect-src` nesses iframes.

Quando o app busca uma URL escolhida pelo modelo (ferramenta de página web), a conexão
só segue para endereços públicos: loopback, redes privadas, CGNAT, link-local (incluindo o
endpoint de metadados de nuvem), ULA e reservados ficam bloqueados, em cada salto de
redirecionamento. A mesma regra está em `server/a2aGuard.ts`, que será usado pelo A2A.

## Imagens geradas (UC Volume)

Os bytes das imagens geradas são gravados e lidos com o token do service principal do app
em `/Volumes/<catálogo>/<schema>/<volume>/<e-mail codificado>/<uuid>.png`
(`server/imageStore.ts`). Sem credenciais do service principal (desenvolvimento local),
o código usa o token do próprio usuário (`storageToken`, `server/imageStore.ts:24-34`). Dentro do app, uma imagem só é servida pela linha do banco do
próprio dono (`/api/images/:id`). **Fora do app não há isolamento por usuário**: quem tem
`READ VOLUME` nesse schema (dono do catálogo, admins do metastore, ou grants amplos num
catálogo já existente, como em workspaces com metastore compartilhado) consegue listar e
ler as imagens de todos os usuários e ver, pelo caminho, quem gerou cada uma. Ao instalar,
confira que só o service principal do app tem acesso ao volume de imagens.

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
