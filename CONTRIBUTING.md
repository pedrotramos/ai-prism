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

Mudanças relevantes para quem usa/deploya o app ganham um **fragmento de changelog**:
um arquivo `changelog.d/<tarefa-ou-branch>.md` com as mesmas seções do
[CHANGELOG.md](CHANGELOG.md) (`### Added`, `### Fixed`…). Não edite o `CHANGELOG.md`
direto: com vários PRs abertos, todos mexendo nas mesmas linhas de `## [Unreleased]`,
cada rebase virava conflito. Os fragmentos são consolidados no release; veja
[`changelog.d/README.md`](changelog.d/README.md).

## Testes e QA

Tudo abaixo roda **offline, sem workspace**. A CI roda as mesmas checagens
([`.github/workflows/ci.yml`](.github/workflows/ci.yml)).

| Comando | O que cobre | Precisa de |
|---|---|---|
| `npm test` | Todos os `*.test.js`/`*.test.mjs` de `server`, `shared`, `scripts`, `tests` e `client/src` (unitários, isolamento entre dois usuários, rotas HTTP, fake do gateway) | Postgres local com pgvector para isolamento e rotas (`npm run local:up`); sem ele essas suítes são puladas e o resumo avisa |
| `npm run qa` | Checagens determinísticas de deck, planilha e UDF Python | nada |
| `npm run smoke` | O caminho real de um usuário contra uma URL (ver abaixo) | um servidor no ar |
| `npm run test:e2e` | Fluxos no navegador + régua de acessibilidade | Node ≥ 22.19 (exigência do Lighthouse; o app em si roda em qualquer Node 22), `npm run build:client` e `npx playwright install chromium` |

### Testes unitários e de rota

```bash
npm run local:up        # Postgres 17 + pgvector em 127.0.0.1:55432 (uma vez)
npm test                # descobre e roda tudo; mostra arquivos, totais e pulados
node tests/run.mjs --list                                          # só lista os arquivos
node tests/run.mjs --fail-on-skip --expect server/isolation.test.js=10   # igual à CI
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

- Preencha o [template de PR](.github/pull_request_template.md).
- Descreva **o quê** e **por quê**, não só o *como*.
- Liste como testou (QA, dev local, deploy num workspace).
- PRs pequenos e focados são revisados mais rápido.
- O [CI](.github/workflows/ci.yml) precisa estar verde, com pelo menos uma aprovação
  antes do merge. Ele roda `npm test` (sem testes pulados, isolamento 10/10), `npm run qa`,
  o build com checagem de artefatos, o smoke contra o fake do gateway, `npm audit` (só
  relatório), o job E2E + acessibilidade e o typecheck.
- O CI também exige um fragmento em `changelog.d/` (ou uma edição do `CHANGELOG.md`).
  Se a mudança não for relevante para quem usa/deploya (docs, chore, ajustes de CI),
  aplique a label `skip-changelog` no PR para dispensar essa checagem.

## Reportando bugs e sugerindo features

Use os templates de issue em `.github/ISSUE_TEMPLATE/`. Para bugs, inclua passos de
reprodução, comportamento esperado vs. obtido e o ambiente (cloud, versão do CLI, modelo).

## Segurança

**Não** abra issues públicas para vulnerabilidades. Siga a [política de segurança](SECURITY.md).
