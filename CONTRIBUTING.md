# Contribuindo com o AI Prism

Obrigado pelo interesse em contribuir! Este guia cobre como preparar o ambiente,
o fluxo de desenvolvimento e as convenções que mantemos no repositório.

> O AI Prism é um **acelerador de solução open-source**, não um produto oficial da
> Databricks. Cada pessoa deploya a sua própria cópia no próprio workspace — veja o
> [README](README.md) e o [onboarding de deploy](docs/onboarding-deployment.md).

## Índice

- [Código de conduta](#código-de-conduta)
- [Pré-requisitos](#pré-requisitos)
- [Configurando o ambiente](#configurando-o-ambiente)
- [Fluxo de desenvolvimento](#fluxo-de-desenvolvimento)
- [Mapa de módulos do servidor](#mapa-de-módulos-do-servidor)
- [Padrões de commit](#padrões-de-commit)
- [Testes e QA](#testes-e-qa)
- [Abrindo um Pull Request](#abrindo-um-pull-request)
- [Reportando bugs e sugerindo features](#reportando-bugs-e-sugerindo-features)
- [Segurança](#segurança)

## Código de conduta

Este projeto adota o [Contributor Covenant](CODE_OF_CONDUCT.md). Ao participar,
você concorda em manter as interações respeitosas e acolhedoras.

## Pré-requisitos

- **Node.js 22+** (veja [`.nvmrc`](.nvmrc) — `nvm use` seleciona a versão certa).
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
Use [`.env.example`](.env.example) + `npm run dev` apenas para desenvolvimento híbrido
contra recursos reais do workspace.

## Fluxo de desenvolvimento

1. Crie um branch a partir de `main` com um nome descritivo e prefixo de tipo:
   `feat/…`, `fix/…`, `docs/…`, `chore/…`, `perf/…`.
2. Faça as mudanças mantendo o estilo do código ao redor (comentários, nomes, idioma).
3. Rode o [QA](#testes-e-qa) e valide localmente o que for afetado.
4. Faça commits pequenos e coesos seguindo os [padrões de commit](#padrões-de-commit).
5. Abra um [Pull Request](#abrindo-um-pull-request) contra `main`.

O app roda os artefatos **pré-compilados** (`client/dist` + `server-dist/index.cjs`).
Sempre rode `npm run bundle` antes de qualquer `bundle deploy` / `apps deploy`.

## Mapa de módulos do servidor

O servidor Express (`server/`) é dividido por responsabilidade. `server/index.js` só monta o
app: instala o middleware, registra os módulos de rota na ordem da lista `routes`, serve o
frontend estático e instala o tratador de erro final.

| Módulo | O que contém |
| --- | --- |
| `server/index.js` | Cria o `app`, `installMiddleware(app)`, a lista `routes`, o frontend estático, o tratador de erro final e o `listen` (pulado com `APPKIT_BOOT=1`). |
| `server/middleware/index.js` | `installMiddleware(app)` na ordem: request id, cabeçalhos de segurança, `security`, guarda CSRF em `/api`, validação numérica de `:id`/`:messageId`, `express.json`. Também exporta `upload` (multer) e `fixFilename`. |
| `server/middleware/auth.js` | `auth`: identidade do proxy, vínculo e-mail↔token e escopo do taxímetro. |
| `server/middleware/requireAdmin.js` | `requireAdmin`: 403 para quem não é admin. |
| `server/middleware/ensureReady.js` | `ensureReady`: cria o schema uma vez por processo (latch de promise: requisições simultâneas esperam o mesmo DDL) e tenta os grants do SP a cada requisição. |
| `server/middleware/{requestId,security}.js` | Pontos de extensão que hoje só passam a requisição adiante. |
| `server/sse.js` | `openSse(res)` e `makeSend(res)`: cabeçalhos e escrita de eventos SSE das rotas de turno. |
| `server/turn.js` | As três rotas que geram uma resposta (`POST /api/chat`, `/api/sessions/:id/continue`, `/api/sessions/:id/messages/:messageId/regenerate`) e o que elas compartilham: janela de histórico, ferramentas, `runAssistantTurn`, avisos, deck por outline e persistência de artefatos. |
| `server/models.js` | Catálogo de modelos do usuário em cache, `getUserModels`, `resolveModelId`, `invalidateUserModels`. |
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
  `server/turn.js`; o stream SSE sai sempre de `server/sse.js`.
- `server/routes/routeTable.test.js` fixa a tabela de rotas (método, caminho e cadeia de
  middleware). Ao adicionar ou mudar uma rota, atualize a lista esperada no mesmo PR.

## Padrões de commit

Usamos [Conventional Commits](https://www.conventionalcommits.org/). O escopo é opcional
mas recomendado; a descrição pode ser em português.

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

Mudanças relevantes para quem usa/deploya o app devem ganhar uma entrada no
[CHANGELOG.md](CHANGELOG.md), na seção `## [Unreleased]`.

## Testes e QA

O pipeline de artefatos (decks, planilhas, mineração de .pptx) tem checagens
determinísticas que rodam **offline, sem workspace**:

```bash
npm run qa   # deck-elements + deck-composition + mine-pptx + spreadsheet QA
```

Rode o QA antes de abrir um PR que toque em geração de deck/planilha/documento.
Para mudanças de UI ou de servidor, valide manualmente rodando `npm run dev` e,
quando fizer sentido, contra um workspace real via `bundle deploy`.

## Abrindo um Pull Request

- Preencha o [template de PR](.github/pull_request_template.md).
- Descreva **o quê** e **por quê**, não só o *como*.
- Liste como testou (QA, dev local, deploy num workspace).
- PRs pequenos e focados são revisados mais rápido.
- O [CI](.github/workflows/ci.yml) (build + `npm run qa`) precisa estar verde, com pelo
  menos uma aprovação antes do merge.
- O CI também exige que o `CHANGELOG.md` tenha sido atualizado. Se a mudança não for
  relevante para quem usa/deploya (docs, chore, ajustes de CI), aplique a label
  `skip-changelog` no PR para dispensar essa checagem.

## Reportando bugs e sugerindo features

Use os templates de issue em `.github/ISSUE_TEMPLATE/`. Para bugs, inclua passos de
reprodução, comportamento esperado vs. obtido e o ambiente (cloud, versão do CLI, modelo).

## Segurança

**Não** abra issues públicas para vulnerabilidades. Siga a [política de segurança](SECURITY.md).
