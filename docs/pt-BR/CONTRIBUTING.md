<!-- i18n: source=CONTRIBUTING.md source-hash=4525d5e6c83e8e43e1401bfd3127d17d06d37d26 status=current -->
# Contribuindo com o AI Prism

[English](../../CONTRIBUTING.md) · **Português (Brasil)** · [Español](../es/CONTRIBUTING.md)

Obrigado pelo interesse em contribuir! Este guia cobre como preparar o ambiente,
o fluxo de desenvolvimento e as convenções que mantemos no repositório.

> O AI Prism é um **acelerador de solução open-source**, não um produto oficial da
> Databricks. Cada pessoa deploya a sua própria cópia no próprio workspace — veja o
> [README](../../README.pt-BR.md) e o [onboarding de deploy](onboarding-deployment.md).

## Índice

- [Código de conduta](#código-de-conduta)
- [Pré-requisitos](#pré-requisitos)
- [Configurando o ambiente](#configurando-o-ambiente)
- [Fluxo de desenvolvimento](#fluxo-de-desenvolvimento)
- [Mapa de módulos do servidor](#mapa-de-módulos-do-servidor)
- [TypeScript](#typescript)
- [Padrões de commit](#padrões-de-commit)
- [Testes e QA](#testes-e-qa)
- [Abrindo um Pull Request](#abrindo-um-pull-request)
- [Reportando bugs e sugerindo features](#reportando-bugs-e-sugerindo-features)
- [Segurança](#segurança)

## Código de conduta

Este projeto adota o [Contributor Covenant](../../CODE_OF_CONDUCT.md). Ao participar,
você concorda em manter as interações respeitosas e acolhedoras.

## Pré-requisitos

- **Node.js 22.18+** para desenvolver (`engines` em `package.json`). A partir da 22.18 o Node
  roda arquivos `.ts` direto, removendo os tipos; numa 22 mais antiga os testes, o QA e o
  servidor de dev falham ao importar `shared/*.ts` (`ERR_UNKNOWN_FILE_EXTENSION`). O
  [`.nvmrc`](../../.nvmrc) fixa a linha que a CI usa (22.23; `nvm use` seleciona). O app deployado
  roda o bundle compilado (`server-dist/index.cjs`), sem nenhum `.ts`, então não depende disso;
  e o npm só avisa (`EBADENGINE`) se o runtime do Databricks Apps for mais antigo, sem barrar o
  install. `shared/typescript.test.js` falha se `.nvmrc` ou `engines` caírem abaixo da 22.18.
- **PostgreSQL 17 + pgvector** (`brew install postgresql@17 pgvector`); não requer Docker.
- **Databricks CLI ≥ 1.8** para deploy e para rodar o app contra um workspace real.
- Acesso a um workspace Databricks com AI Gateway, Serverless SQL e Lakebase habilitados,
  caso queira exercitar o fluxo completo (o QA offline não precisa de workspace).

## Configurando o ambiente

```bash
nvm use                 # Node da versão do .nvmrc
npm install
cp .env.local.example .env.local
npm run local:up
npm run dev:local
# em outro terminal: npm run local:seed
```

O Vite faz proxy de `/api` para `http://localhost:8000`. Fora do runtime da Databricks App,
o modo local usa Postgres nativo em `127.0.0.1:55432` e não requer tokens Lakebase.
Use [`.env.example`](../../.env.example) + `npm run dev` apenas para desenvolvimento híbrido
contra recursos reais do workspace.

## Fluxo de desenvolvimento

1. Crie um branch a partir de `main` com um nome descritivo e prefixo de tipo:
   `feat/…`, `fix/…`, `docs/…`, `chore/…`, `perf/…`.
2. Faça as mudanças mantendo o estilo do código ao redor (comentários, nomes, idioma).
3. Rode o [QA](#testes-e-qa) e valide localmente o que for afetado.
4. Faça commits pequenos e coesos seguindo os [padrões de commit](#padrões-de-commit).
5. Abra um [Pull Request](#abrindo-um-pull-request) contra `main`.

O app roda os artefatos **pré-compilados** (`client/dist` + `server-dist/index.cjs`).

**Não commite `client/dist` nem `server-dist` em PRs de feature.** Os nomes desses
arquivos levam hash do conteúdo, então dois PRs de client em paralelo entrariam em
conflito neles sempre. Esses artefatos são regenerados e commitados **só nos PRs de
release**: branch `release/*` ou label `release`. Só nesses PRs a CI confere se batem com
o código; nos demais, a CI roda `npm run bundle` (o build precisa passar) e avisa que os
artefatos são refeitos no release. Se o build alterar esses arquivos no seu branch,
descarte as mudanças: `git checkout -- client/dist server-dist`.

**Antes de qualquer deploy, rode `npm run bundle`** (`bundle deploy` / `apps deploy`
publicam o que estiver em `client/dist` e `server-dist`). Hoje o `deploy.sh` e o
`deploy.ps1` ainda **não** fazem esse build sozinhos.

## Mapa de módulos do servidor

O servidor Express (`server/`) é dividido por responsabilidade. `server/index.js` só monta o
app: instala o middleware, registra os módulos de rota na ordem da lista `routes`, serve o
frontend estático e instala o tratador de erro final.

| Módulo | O que contém |
| --- | --- |
| `server/index.js` | Cria o `app`, `installMiddleware(app)`, a lista `routes`, o frontend estático, o tratador de erro final e o `listen` (pulado com `APPKIT_BOOT=1`). |
| `server/middleware/index.ts` | `installMiddleware(app)` na ordem: request id, cabeçalhos de segurança, `security`, guarda CSRF em `/api`, validação numérica de `:id`/`:messageId`, `express.json`. Também exporta `upload` (multer) e `fixFilename`. |
| `server/middleware/auth.ts` | `auth`: identidade do proxy, vínculo e-mail↔token e escopo do taxímetro. |
| `server/middleware/requireAdmin.ts` | `requireAdmin`: 403 para quem não é admin. |
| `server/middleware/ensureReady.ts` | `ensureReady`: cria o schema uma vez por processo (latch de promise: requisições simultâneas esperam o mesmo DDL) e tenta os grants do SP a cada requisição. |
| `server/middleware/{requestId,security}.js` | Pontos de extensão que hoje só passam a requisição adiante. |
| `server/sse.ts` | `openSse(res)` e `makeSend(res)`: cabeçalhos e escrita de eventos SSE das rotas de turno. |
| `server/turn.js` | As três rotas que geram uma resposta (`POST /api/chat`, `/api/sessions/:id/continue`, `/api/sessions/:id/messages/:messageId/regenerate`) e o que elas compartilham: janela de histórico, ferramentas, `runAssistantTurn`, avisos, deck por outline e persistência de artefatos. |
| `server/models.ts` | Catálogo de modelos do usuário em cache, `getUserModels`, `resolveModelId`, `invalidateUserModels`. |
| `server/lib/tweak.js` | Utilitários dos "tweaks" de IA (deck, planilha, documento). |
| `server/lib/embeddings.js` | Embeddings de sessão e de mensagem, e o backfill do histórico. |
| `server/routes/admins.js` | `/api/me` e administradores do app. |
| `server/routes/models.js` | Modelos de chat e de imagem, política de ferramentas, resumo de custo, catálogo de modelos do admin. |
| `server/routes/sessions.js` | Sessões: lista, busca, keep-alive, mensagens, compactação, edição e exclusão. |
| `server/routes/toolsSearch.js` | Busca de ferramentas anexáveis (UC Functions, Genie, Vector Search, MCP externo). |
| `server/routes/mcpConnections.js` | Conexões MCP do usuário. |
| `server/routes/mcpCatalog.js` | Catálogo MCP do admin. |
| `server/routes/skills.js` | Skills autorais. |
| `server/routes/deckTemplates.js` | Design systems (modelos de apresentação). |
| `server/routes/decks.js` | Deck Studio: leitura, edição, tweak e export `.pptx`. |
| `server/routes/images.js` | Bytes das imagens geradas. |
| `server/routes/spreadsheets.js` | Estúdio de planilhas. |
| `server/routes/documents.js` | Estúdio de documentos. |
| `server/routes/messages.js` | Variante ativa, edição de prompt, respostas de `deck-questions`. |
| `server/routes/static.js` | `client/dist` e o fallback da SPA; registrado depois de todas as rotas de API. |

Regras:

- **Endpoint novo** = arquivo novo `server/routes/<nome>.js` que exporta
  `register(app)` + **uma linha** no fim da lista `routes` em `server/index.js`.
- As rotas são registradas **direto no `app`**, não num `express.Router`: o
  `app.param(['id', 'messageId'])` não vale dentro de um router, e as rotas perderiam a
  validação numérica dos ids.
- O guarda CSRF fica **antes** de qualquer parser de corpo; não mude a ordem de
  `installMiddleware`.
- Pós-processamento de turno (blocos, deck, custo, título) vale para **as três** rotas de
  `server/turn.js`; o stream SSE sai sempre de `server/sse.ts`.
- `server/routes/routeTable.test.js` fixa a tabela de rotas (método, caminho e cadeia de
  middleware). Ao adicionar ou mudar uma rota, atualize a lista esperada no mesmo PR.

## TypeScript

O código migra para TypeScript **por dono**: o arquivo que você possui e altera de forma
relevante vira `.ts` no mesmo PR. A decisão e o porquê estão no
[ADR 0006](../adr/0006-typescript.md). `shared/**` já está em TypeScript.

- **Receita de conversão (módulos do servidor).** Siga os passos, nesta ordem:
  1. `git mv server/foo.js server/foo.ts` e o teste: `git mv server/foo.test.js server/foo.test.ts`.
  2. Tipe com o `tsc` como juiz: `npm run typecheck`. Dê tipos explícitos de parâmetro e retorno
     aos exports, declare como `interface`/`type` os formatos que o módulo repassa e mantenha-os
     privados ao módulo: só use `export` num tipo que outro módulo realmente importa (a
     conversão não pode ampliar a API do módulo). Nunca mude assinatura, nome exportado ou formato de retorno (é conversão, não refatoração).
  3. Nada de `any` sem um comentário de uma linha dizendo por quê; nada de `// @ts-ignore`;
     `@ts-expect-error` só com motivo.
  4. Atualize cada importador para a extensão real (`./foo.ts`, `../foo.ts` e o
     `import('./foo.ts')` dinâmico). Mantenha um shim `foo.js` de uma linha
     (`export * from './foo.ts'`, mais `export { default } from './foo.ts'` se houver default)
     só quando algum importador não consegue importar `.ts`. `shared/**` mantém seus shims.
  5. Confira os três consumidores: `npm run typecheck`, `node tests/run.mjs --list` (o
     `foo.test.ts` aparece) e `npm run bundle` (o esbuild compila o `.ts` para o `server-dist`;
     não commite `client/dist` nem `server-dist` num PR de funcionalidade).
  6. Módulo sem teste próprio ganha um `foo.test.ts` mínimo no mesmo PR.
- **`strict` vale só para `.ts`.** O [`tsconfig.json`](../../tsconfig.json) liga `strict`,
  `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `erasableSyntaxOnly` e
  `allowImportingTsExtensions`. O JavaScript restante não é checado (`checkJs: false`).
- **Só sintaxe apagável.** Nada de `enum`, `namespace` ou parameter properties: o Node roda o
  `.ts` em dev só removendo os tipos. Use uniões de literais (`'a' | 'b'`) ou objetos `as const`.
- **Importe com a extensão real.** Entre arquivos `.ts`, use `./bar.ts`; para um módulo ainda em
  JS, `./baz.js`. Tipos entram com `import type { … }` (exigido por `verbatimModuleSyntax`).
- **Índice pode ser `undefined`.** Com `noUncheckedIndexedAccess`, `arr[i]` e `obj[chave]` têm
  tipo `T | undefined`. Trate o caso; use `!` só quando o invariante estiver garantido ali
  (por exemplo, `i < arr.length`) e não mude o comportamento em tempo de execução ao converter.
- **Testes são `*.test.ts`.** O `tests/run.mjs` descobre `*.test.js`, `*.test.mjs`, `*.test.ts` e
  `*.test.mts`; o CI os roda no job de testes unitários, e o `tests/runner.test.mjs` falha se um
  `*.test.*` versionado não estiver na lista descoberta (teste que nunca roda passa para sempre).
  Os arquivos de teste passam pelo typecheck como qualquer `.ts`. Os `.test.js`/`.test.mjs`
  existentes ficam como estão até o módulo ser convertido.
- **Como roda:** em dev e nos testes, o Node ≥ 22.18 remove os tipos; no build, o esbuild
  (`server-dist/index.cjs`) e o Vite (`client/dist`) compilam o `.ts`. Nenhum `.js` é gerado no
  repositório.
- **Antes do PR:** `npm run typecheck` (`tsc --noEmit`) precisa sair com 0 erros, além de
  `npm test`, `npm run qa` e `npm run bundle`.

## Padrões de commit

Usamos [Conventional Commits](https://www.conventionalcommits.org/). O escopo é opcional
mas recomendado; a descrição pode ser em português.

<!-- i18n: code-translated en=c3a8a92f8237 -->
```
<tipo>(<escopo>): <descrição no imperativo>
```

Tipos usados no projeto: `feat`, `fix`, `docs`, `chore`, `perf`, `refactor`, `test`.

Exemplos reais do histórico:

```
feat(deck): Fase 3 — tweaks de IA melhores (região, prévia, recompor, histórico)
fix(blocks): documento com bloco de código vazava JSON cru no chat
perf: fluidez de streaming + TTFT
```

Mudanças relevantes para quem usa/deploya o app ganham um **fragmento de changelog**:
um arquivo `changelog.d/<tarefa-ou-branch>.md` com as mesmas seções do
[CHANGELOG.md](../../CHANGELOG.md) (`### Added`, `### Fixed`…). Não edite o `CHANGELOG.md`
direto: com vários PRs abertos, todos mexendo nas mesmas linhas de `## [Unreleased]`,
cada rebase virava conflito. Os fragmentos são consolidados no release; veja
[`changelog.d/README.md`](../../changelog.d/README.md).

## Testes e QA

Tudo abaixo roda **offline, sem workspace**. A CI roda as mesmas checagens
([`.github/workflows/ci.yml`](../../.github/workflows/ci.yml)).

| Comando | O que cobre | Precisa de |
|---|---|---|
| `npm test` | Todos os `*.test.js`/`*.test.mjs`/`*.test.ts`/`*.test.mts` de `server`, `shared`, `scripts`, `tests` e `client/src` (unitários, isolamento entre dois usuários, rotas HTTP, fake do gateway) | Postgres local com pgvector para isolamento e rotas (`npm run local:up`); sem ele essas suítes são puladas e o resumo avisa |
| `npm run qa` | Checagens determinísticas de deck, planilha e UDF Python | nada |
| `npm run typecheck` | `tsc --noEmit`: os arquivos `.ts` com `strict` (ver [TypeScript](#typescript)) | nada |
| `npm run smoke` | O caminho real de um usuário contra uma URL (ver abaixo) | um servidor no ar |
| `npm run test:e2e` | Fluxos no navegador + régua de acessibilidade | Node ≥ 22.19 (exigência do Lighthouse), `npm run build:client` e `npx playwright install chromium` |

### Testes unitários e de rota

```bash
npm run local:up        # Postgres 17 + pgvector em 127.0.0.1:55432 (uma vez)
npm test                # descobre e roda tudo; mostra arquivos, totais e pulados
node tests/run.mjs --list                                          # só lista os arquivos
node tests/run.mjs --fail-on-skip --expect server/isolation.test.js=19 --expect server/rls.test.js=16   # igual à CI: falha em qualquer skip, exceto os '[infra-skip:' (avisos)
```

Use sempre `npm test` (ou `node tests/run.mjs`) e não `node --test` sem argumentos.
Sem lista de arquivos, o Node cai no glob padrão, que também casa com
`scripts/load-test.mjs` (`*-test.mjs`).

Os testes de rota (`tests/routes.test.mjs`) sobem o `app` real numa porta efêmera
(`APPKIT_BOOT=1`, `LOCAL_DEV_MODE=1`), com o fake do gateway e dois usuários
`*.test.invalid`. As linhas criadas são apagadas no fim.

### Fake do AI Gateway

`scripts/fake-gateway.mjs` responde no formato que o `server/llm.js` lê: streaming com
`delta.content`, `reasoning_content`, `tool_calls` indexados, `usage` e `[DONE]`; não streaming
com `message.content`; embeddings de 1024 dimensões; listagem de endpoints. O comportamento
vem da última mensagem do usuário: pedir um documento gera um bloco `document`, `[fake:tool]`
gera uma chamada de tool e `[fake:error]` gera um HTTP 503.

```bash
npm run fake-gateway -- --port 8787
DATABRICKS_HOST=http://127.0.0.1:8787 npm run dev:server:local   # o app inteiro sem workspace
```

Os formatos estão fixados em `tests/fixtures/gateway-shapes.live.json`, uma gravação de um
gateway real que guarda só caminhos de chave e tipos. Para regravar quando o gateway mudar
(6 chamadas pequenas a modelos baratos; o token nunca é impresso):

```bash
DATABRICKS_HOST=https://<workspace> \
DATABRICKS_TOKEN="$(databricks auth token -p <PROFILE> -o json | jq -r .access_token)" \
node tests/live/record-gateway-shapes.mjs
```

### Smoke local

O mesmo script do pós-deploy, contra o servidor local e o fake:

```bash
npm run fake-gateway -- --port 8787 &
LOCAL_DEV_MODE=1 DATABRICKS_HOST=http://127.0.0.1:8787 PGHOST=127.0.0.1 PGPORT=55432 \
  PGUSER=ai_prism PGPASSWORD=ai_prism PGDATABASE=ai_prism PGSSLMODE=disable node server/index.js &
APP_URL=http://127.0.0.1:8000 SMOKE_SKIP_ARTIFACT=0 npm run smoke
```

### E2E e acessibilidade (`client/e2e/`)

O navegador roda o **client compilado** (`client/dist`) atrás de
`client/e2e/fixture-server.mjs`. Esse servidor responde `/api/*` com fixtures gravadas
(`client/e2e/fixtures/api.json`), sem backend, banco ou gateway.

```bash
npm run build:client
npx playwright install chromium
npm run test:e2e                         # fluxos + régua de acessibilidade
E2E_STRICT=1 npm run test:e2e            # também falha em qualquer violação serious/critical
```

- `flows.spec.mjs`: resposta em streaming (o shim de `fetch` alimenta `/api/chat` com
  eventos SSE reais), HTTP 500 no envio, Configurações, Slides Studio, histórico no
  mobile, e nenhuma requisição sem fixture.
- `a11y.spec.mjs`: axe em boas-vindas, chat, Configurações e Slides Studio, nos temas
  escuro e claro, a 1440 e 390 px (16 execuções). Também mede alvos de toque < 24 px,
  elementos interativos sem nome, Lighthouse (acessibilidade) em boas-vindas, chat e
  histórico, e os estilos avulsos de `client/src` (`token-audit.mjs`).
- **Régua de regressão:** `client/e2e/baseline.json` guarda os números por sistema
  operacional, e o job falha se qualquer contagem subir ou alguma nota do Lighthouse cair.
  Ao melhorar, grave a nova régua com `E2E_UPDATE_BASELINE=1 npm run test:e2e` e commite
  o `baseline.json`.
- Relatório: `client/e2e/.output/a11y-report.json` e `client/e2e/.output/report/`
  (na CI, o artefato `e2e-report`).

Quando uma tela passar a chamar um endpoint novo, o teste de cobertura de fixtures
falha. Regrave as fixtures contra um servidor local com dados semeados:

```bash
npm run local:up
npm run fake-gateway -- --port 8787 &
# servidor local com DATABRICKS_HOST=http://127.0.0.1:8787 e
# DATABRICKS_USER_EMAIL=e2e-user@example.com APP_OWNER_EMAIL=e2e-user@example.com
DATABRICKS_USER_EMAIL=e2e-user@example.com npm run local:seed
IDS=$(node client/e2e/record/seed-rich.mjs)
APP_URL=http://127.0.0.1:8000 IDS="$IDS" node client/e2e/record/record-fixtures.mjs
```

O gravador recusa salvar fixtures que contenham tokens, hosts de workspace ou e-mails
`@databricks.com`.

Rode o QA antes de abrir um PR que toque em geração de deck/planilha/documento. Para
mudanças de UI, rode `npm run test:e2e`. Valide contra um workspace real via
`bundle deploy` quando fizer sentido.

## Abrindo um Pull Request

- Preencha o [template de PR](../../.github/pull_request_template.md).
- Descreva **o quê** e **por quê**, não só o *como*.
- Liste como testou (QA, dev local, deploy num workspace).
- PRs pequenos e focados são revisados mais rápido.
- O [CI](../../.github/workflows/ci.yml) precisa estar verde, com pelo menos uma aprovação
  antes do merge. Ele roda `npm test` (sem skips inesperados: um skip cujo motivo começa com `[infra-skip:` é só um aviso; isolamento 19/19, RLS 16/16), `npm run qa`,
  o build (a checagem de `client/dist`/`server-dist` em dia só em PRs de release), o smoke
  contra o fake do gateway, `npm audit` (só
  relatório), o job E2E + acessibilidade e o typecheck.
- O workflow [Lakebase branch](../../.github/workflows/lakebase-branch.yml) roda as migrações
  (up, down até 0, up) e as suítes de isolamento + RLS contra uma branch Lakebase efêmera. Ele é
  pulado com um aviso, e continua verde, quando os secrets `LAKEBASE_CI_*` não existem (forks,
  repositórios sem service principal de CI). Veja
  [operations.md](operations.md#ci-branch-lakebase-efêmera).
- O CI também exige um fragmento em `changelog.d/` (ou uma edição do `CHANGELOG.md`).
  Se a mudança não for relevante para quem usa/deploya (docs, chore, ajustes de CI),
  aplique a label `skip-changelog` no PR para dispensar essa checagem.

## Reportando bugs e sugerindo features

Use os templates de issue em `.github/ISSUE_TEMPLATE/`. Para bugs, inclua passos de
reprodução, comportamento esperado vs. obtido e o ambiente (cloud, versão do CLI, modelo).

## Segurança

**Não** abra issues públicas para vulnerabilidades. Siga a [política de segurança](SECURITY.md).
