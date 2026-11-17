# ADR 0001: Adoção incremental do Databricks AppKit

- **Status:** Proposta (spike concluído; implementação real na Fase 1 do plano)
- **Data:** 2026-11-17
- **Escopo:** bootstrap do servidor, empacotamento, Lakebase, telemetria, plugins
- **Versão testada:** `@databricks/appkit@0.76.1` (pinada exata em `devDependencies`), Node 22.22.3

## Contexto

O AI Prism roda hoje em um Express escrito em JS (`server/index.js`, ~3.4k linhas) empacotado
por esbuild em `server-dist/index.cjs` (CJS, `node18`) e servido como Databricks App com
`app.yaml` → `node server-dist/index.cjs`. O deploy não tem `node_modules` (o `.npmrc` tem
`omit=dev` e o bundle é pré-compilado), então **todo código de runtime precisa estar dentro do
bundle**.

O plano aprovado (Fase 1) pede adotar `@databricks/appkit` de forma incremental (strangler):
o app passa a bootar por `createApp({ plugins: [server(), lakebase()] })` e as rotas não são
reescritas. Este ADR registra o que foi provado no spike, o que não foi, e a ordem de migração.

## Evidências do spike

Todos os comandos foram executados na worktree `feat/appkit-spike`. Os comandos e saídas
resumidos estão abaixo; os artefatos temporários ficaram em `.spike/` (não versionados).

| # | Verificação | Comando / método | Resultado |
|---|---|---|---|
| E1 | AppKit é ESM-only e exige Node ≥ 22 | leitura de `node_modules/@databricks/appkit/package.json` (`"type": "module"`, `exports` só com `import`, `engines`) | confirmado |
| E2 | Bundle ESM sem stubs falha | `esbuild .spike/min.mjs --bundle --format=esm --target=node22` | falha: `@babel/preset-typescript/package.json` (via `@babel/core`) e `fsevents.node` (sem loader) |
| E3 | Bundle ESM precisa de `require` em dependências CJS | sem banner, `node min-esm.mjs` | `Dynamic require of "node:http" is not supported` (sdk-experimental) → corrigido com banner `createRequire(import.meta.url)` |
| E4 | `vite` e `@ast-grep/napi` são importados estaticamente | leitura do bundle (`import * as vite from "vite"`, `import { Lang, parse } from "@ast-grep/napi"`) | sem stub: `Cannot find package 'vite'` ao rodar fora de `node_modules` |
| E5 | Bundle com stubs roda fora de `node_modules` | `scripts/build-appkit.mjs` → `server-dist/appkit.mjs` (12.2 MB, minificado); copiado para `/tmp/appkit-spike/deploy` sem `node_modules` | `/health` → `{"status":"ok"}`; SPA em `/` → HTML; `/api/me` sem token → 401 (rota legada); com `x-forwarded-access-token` → 200 com e-mail |
| E6 | Boot exige auth e campos de ambiente | variações de env | sem `DATABRICKS_HOST`/auth: `Databricks authentication failed`; sem `PGPORT`/`PGSSLMODE` fora de `NODE_ENV=development`: `Missing required resources: postgres [lakebase]`; sem `PGUSER` nem `DATABRICKS_CLIENT_ID`: `config.user, PGUSER or DATABRICKS_CLIENT_ID ... is required` |
| E7 | Chamadas HTTP no boot | servidor mock em 127.0.0.1 registrando requisições | `GET /api/2.0/preview/scim/v2/Me` e a resposta precisa do header `x-databricks-org-id` (senão `resourceNotFound("Workspace ID")`). **Boot não conecta no Postgres** (`pg.Pool` é lazy) |
| E8 | `bodyLimit` do AppKit roda antes do nosso parser | leitura de `plugins/server/index.js` (`express.json({ limit: bodyLimit ?? "1mb" })`) e teste: POST de 2 MB em rota JSON → 404 (não 413) com `bodyLimit: '40mb'` | o padrão de 1 mb rejeitaria bodies > 1 mb antes do `express.json('40mb')` legado. **Gotcha obrigatório**: `server({ bodyLimit: '40mb' })` |
| E9 | Seam sem reescrever rotas | `server/index.js` exporta `app` e só faz `listen` se `APPKIT_BOOT !== '1'`; `server/appkit.js` faz `appkit.server.extend(app => app.use(legacyApp))` | `/health` vem do AppKit (registrado antes das extensões); demais rotas do legado |
| E10 | Padrão anterior preservado | `esbuild server/index.js --format=cjs --target=node18 --minify` + `node` no diretório de simulação | boota e serve SPA (`/` 200, `/api/me` 401). `/health` retorna 200 **só porque o catch-all do SPA responde** (o legado não tem `/health` JSON) |
| E11 | Sem `APPKIT_BOOT=1` o legado ainda escuta | rodar o bundle CJS do AppKit sem a flag | dois listeners (`AI Prism listening on :8000` e AppKit em `:8127`). A flag precisa estar setada em **todo** caminho de boot |
| E12 | AppKit em CJS | `esbuild .spike/appkit-cjs-entry.js --format=cjs --target=node22` (com `await` embrulhado) | emite e roda (`/health` 200); o único bloqueio é o top-level await de `server/appkit.js` (`Top-level await is currently not supported with the "cjs" output format`) |
| E13 | Dev sem bundle | `APPKIT_BOOT=1 node server/appkit.js` (com `node_modules`) | `/health` 200, `/` 200 (static, porque o `dist` existe) |
| E14 | `tsc --noEmit` | `npm run typecheck` (tsconfig com `allowJs`, `checkJs: false`) | exit 0; 136 arquivos do projeto analisados |
| E15 | Lockfile | `npm install --save-dev --include=dev --save-exact @databricks/appkit@0.76.1 typescript@5 @types/node@22 @types/express@4` + reescrita de URLs | 305 pacotes adicionados, 0 removidos, 1 versão alterada (`@types/node` 22.20.0 → 22.20.5); 306 URLs `npm-proxy...` reescritas para `registry.npmjs.org` |

Não foi possível verificar: conexão real com Lakebase (sem Postgres/Lakebase disponível; Docker
indisponível), exportação OTLP real, e o comportamento do Databricks Apps com OTEL.

## Decisão (proposta)

1. **Adotar AppKit em modo strangler**, com `server()` como dono do listener e `/health`, e o
   Express atual montado como sub-app via `appkit.server.extend`. Nenhuma rota é reescrita nesta
   fase.
2. **Empacotar com esbuild em ESM, `--target=node22`**, via `scripts/build-appkit.mjs`, com
   stubs para `vite`, `@ast-grep/napi`, `@babel/core` e `fsevents`
   (`scripts/appkit/stubs/`) e banner `createRequire`. O artefato é `server-dist/appkit.mjs`.
   **Não** é ligado ao `npm run bundle` ainda.
3. **`lakebase()` NÃO entra no bootstrap ainda.** O spike mostrou que o plugin só adiciona
   requisitos de boot (ver tabela de diferenças abaixo) sem uso real enquanto `db.js` continuar
   sendo o dono das conexões. Entra junto com a migração de `db.js` (passo 2 do plano).
4. **Desligar a telemetria interna do AppKit** (`disableInternalTelemetry: true`; equivale a
   `DISABLE_APPKIT_INTERNAL_TELEMETRY=true` ou `DO_NOT_TRACK=1`). Ela envia para a Databricks
   `APP_STARTUP`, `HEARTBEAT` (5 min) e `REQUEST_METRICS` (por minuto, por rota), com `app_id` =
   `DATABRICKS_CLIENT_ID`. Isso é egress de metadados para fora do workspace do cliente, o que
   conflita com o posicionamento do produto. A decisão de reabilitar é do dono do produto.
5. **Manter `devDependencies`** para `@databricks/appkit`, `typescript`, `@types/*`. Como o bundle
   é autocontido, o deploy continua sem `npm install` em runtime.

### Caminho de boot e rollback

- Hoje: `app.yaml` → `node server-dist/index.cjs` (legado, inalterado).
- Com o flip: duas opções, com trade-offs diferentes:
  - **A (recomendada):** manter `command: node server-dist/index.cjs` como launcher CJS fino que
    faz `import('./appkit.mjs')` quando `APPKIT_BOOT=1` e `require('./legacy.cjs')` caso contrário.
    Rollback = mudar a env var e reiniciar o app, sem novo `bundle deploy`. Custa um arquivo a mais
    e um rename do legado.
  - **B:** `command: node server-dist/appkit.mjs`. Mais simples, mas rollback exige redeploy com o
    comando antigo.
- Em ambos, `APPKIT_BOOT` precisa ser setado em todo caminho de boot (E11).

## Lakebase: `lakebase()` do AppKit vs `server/db.js`

Leitura de `@databricks/lakebase@0.6.0` e `appkit/dist/plugins/lakebase/lakebase.js`:

| Aspecto | `server/db.js` (hoje) | `lakebase()` (AppKit 0.76.1) | Impacto |
|---|---|---|---|
| Variável do endpoint | `PG_ENDPOINT` (valueFrom `lakebase`), resolvido em `PGHOST` via REST | `LAKEBASE_ENDPOINT` (token refresh por endpoint); `PGHOST` vem do resource | renomear em `app.yaml`; validar que `valueFrom: lakebase` injeta `LAKEBASE_ENDPOINT` (a doc usa `valueFrom: postgres`; **não verificado**) |
| Identidade do SP | `client_credentials` próprio, token cacheado, `password` como função por conexão | SDK (`DATABRICKS_CLIENT_ID/SECRET`), refresh a cada 1 h com buffer de 2 min | equivalente funcional; não testado ao vivo |
| Fallback OBO | `OBO token` como senha, role = e-mail do usuário | `asUser(req)` cria **pool por usuário** com OAuth do usuário | **incompatível com o modelo**: ambos exigem role PG por usuário. Nosso modelo usa um único role (SP) e isola por `WHERE user_email` (ver `project_lakebase_multiuser_sp`). **Não adotar `asUser`** |
| `PGPASSWORD` (dev) | pool por usuário com senha estável | `lakebase({ pool: { password } })` estático para o pool SP | cobre dev local com senha fixa, sem o caminho por usuário |
| SSL | `rejectUnauthorized: false` | `PGSSLMODE=require` → `rejectUnauthorized: true` | **mais estrito**; pode quebrar se a cadeia não for confiável no runtime. Não testado ao vivo |
| Limites | `max 8`, `idle 5 min`, `maxLifetime 30 min`, `query_timeout 60 s` | `max 10` (default), `idle 30 s`; sem `maxLifetime`; `statement_timeout` opcional | perda de `maxLifetime` e de `query_timeout` na migração. Precisa ser reconfigurado (`statement_timeout`) |
| Boot | lazy, sem I/O até a primeira query | `getUsernameWithApiLookup` + validação de recursos; exige PGUSER/CLIENT_ID, PGPORT, PGSSLMODE, LAKEBASE_ENDPOINT em produção | o boot ganha requisitos novos (E6, E7) |
| Telemetria | nenhuma | spans `lakebase.query` e métricas `lakebase.*` **só com OTLP configurado** | ganho real para a Fase 3 |
| Escopo | Autoscaling (`/api/2.0/postgres/...`) | só Autoscaling (`docs/faq.md`) | ver próximo item |

### Lakebase Provisioned

- O plano diz que o `databricks.yml` suporta Autoscaling **e** Provisioned. **Isso não procede.** O
  bundle usa `postgres_projects`/`postgres_endpoints` (Autoscaling); o próprio comentário do
  `databricks.yml` diz que usamos Autoscaling por causa do range de CU e do auto-stop, e
  `db.js` resolve o host via `/api/2.0/postgres/...`. Nenhum caminho de Provisioned existe no código.
- **Recomendação:** não criar `server/db/provisionedPool.ts`. Documentar explicitamente que o
  AI Prism suporta apenas Lakebase Autoscaling (como o AppKit). Se um cliente pedir Provisioned,
  tratar como feature nova com seu próprio ADR, não como adaptador preventivo.

## Telemetria (OpenTelemetry)

Como o AppKit faz (lido em `dist/telemetry/telemetry-manager.js` e `docs/configuration.md`):

- Sem `OTEL_EXPORTER_OTLP_ENDPOINT`, **nada é exportado**: meter/logger não são criados e o
  tracer só inicia se algum plugin registrar processor.
- Com o endpoint, exporta traces, métricas e logs via OTLP/HTTP-proto. `OTEL_SERVICE_NAME` ou
  `DATABRICKS_APP_NAME` define `service.name`. Instrumentação automática de http/express vem
  registrada pelo `server()`, com nomes de span `METHOD /rota`.
- O bundle já inclui `@opentelemetry/api`, então o código pode usar `trace.getTracer(...)` sem
  instalar mais nada. Sem provider global, os spans são no-op.
- **Como o Databricks Apps expõe OTEL: não está na documentação do pacote.** Não assumimos
  nenhum coletor da plataforma. Precisa de confirmação com a plataforma (ou usar um coletor
  próprio via `OTEL_EXPORTER_OTLP_ENDPOINT`). **Aberto.**

Spans manuais propostos (nomes e atributos para a Fase 3):

| Span | Quando | Atributos mínimos (sem conteúdo de usuário) |
|---|---|---|
| `chat.turn` (raiz) | cada turno de `/api/chat`, `/continue`, `/regenerate` | `session.id`, `route`, `model`, `caps`, `status` |
| `llm.call` | cada chamada ao gateway (stream e não-stream) | `model`, `prompt_tokens`, `completion_tokens`, `cost_usd` (do ledger), `status` |
| `tool.call` | cada tool (Genie, UC Function, MCP, vector search) | `tool.name`, `tool.kind`, `duration_ms`, `status` |
| `sql.statement` | statement no SQL Warehouse | `warehouse.id`, `statement.kind`, `rows` (sem SQL bruto) |
| `db.query` | wrapper de `db.js` (até a migração para o plugin) | `db.operation`, `db.table`, `pool.waiting` |

Regra: atributos sem e-mail, sem texto de prompt e sem SQL bruto. O request-id (de
`x-request-id` ou gerado) entra como atributo do span raiz e no log estruturado da Fase 2.

## Plugins: encaixe (base na documentação do pacote)

| Plugin | Encaixe | Motivo |
|---|---|---|
| `server()` | **sim, agora** | dono do listener, `/health`, error handling; monta o legado sem reescrever rotas |
| `lakebase()` | **depois** (com a migração de `db.js`) | ver seção Lakebase; hoje só adiciona requisitos de boot |
| `files()` | **candidato** | volumes nomeados (`DATABRICKS_VOLUME_*`) cobrem `imageStore`, mas o fluxo atual usa identidade SP/OBO específica; avaliar depois |
| `analytics()` | **só telas novas** | exige SQL nomeado em `config/queries/` com typegen; não substitui warehouse dinâmico nem UC Functions |
| `genie()` | **não substitui** | cobre espaços AI/BI; o AI Prism usa Genie One via MCP |
| `serving()` | **não substitui `llm.js`** | proxy de invoke/stream, mas nosso loop depende de tool calls, ledger de custos, roteamento e OpenAI-compat do gateway |
| `jobs()` | fora | sem caso hoje |
| `database()` (beta) | fora | beta; não cabe no modelo de dono por `user_email` |
| `agents()` (beta) | **fora** | beta; decisão de Agent Studio fica na Fase 5 |
| Loop de chat SSE, studios, artefatos, catálogo multi-modelo | **permanecem no Express** | nenhum plugin do AppKit cobre; `custom-plugins` só faria sentido para rotas isoladas |

## Consequências

- **Positivas:** boot padronizado, telemetria OTLP disponível sem código próprio quando houver
  coletor, base para `@databricks/appkit-ui` em telas novas, e rollback por flag com a opção A.
- **Negativas:** bundle ESM de ~12 MB (minificado) com stubs. Se o AppKit passar a chamar `vite`
  ou `@ast-grep/napi` em produção, o stub lança erro explícito (preferível a falha silenciosa, mas
  exige teste em CI). Mais uma dependência de versão 0.x pinada exata.
- **Riscos:**
  - Telemetria interna ligada por padrão (mitigado com a opção desligada).
  - `bodyLimit` esquecido causa 413 silencioso em uploads grandes (teste de regressão necessário).
  - SSL estrito do plugin pode quebrar a conexão (validar ao vivo antes da migração).
  - `asUser` tentado por engano reintroduz role por usuário.
  - O lockfile ganhou 305 pacotes (árvore do AppKit, incluindo `@opentelemetry/*`, `zod`,
    `apache-arrow`, `@databricks/sdk-experimental`). Todos ficam em `devDependencies` e entram no
    bundle, então o peso do deploy não muda; o peso do `npm ci` local sim.

## Plano de migração (ordem)

1. **Spike + ADR** (este PR). Seam com `APPKIT_BOOT=1`, build ESM de teste, `typecheck`.
2. **Bootstrap:** decidir entre launcher (opção A) e artefato direto (B). Ligar
   `build:server:appkit` em `npm run bundle` com artefato versionado. Ajustar `app.yaml` conforme a
   opção escolhida. Teste de regressão: `/health`, SPA, 401 sem token, body de 2 MB em rota JSON.
3. **Validação ao vivo** em workspace de teste (E2_Demo/FEVM): boot no Apps com APPKIT_BOOT=1,
   conferir logs do AppKit, `/health`, uma rota de chat real. Confirmar `valueFrom: lakebase` →
   `LAKEBASE_ENDPOINT` e SSL do plugin.
4. **Lakebase:** migrar `db.js` para `lakebase()` (pool SP), mantendo DDL idempotente, fallback
   `PGPASSWORD` (`pool.password`) e `statement_timeout`. Testar fim a fim contra Lakebase real.
5. **Telemetria:** definir o coletor (pergunta à plataforma), spans da tabela acima, request-id.
6. **Conversão TS** conforme o plano (shared → folhas → db → rotas → `index.js` em routers).
7. **Default:** passar `APPKIT_BOOT=1` a padrão em uma release; remover o legado no major 2.0.

## Questões em aberto

1. O Databricks Apps expõe um coletor OTLP? Qual endpoint/cabeçalho usar?
2. `valueFrom: lakebase` injeta `LAKEBASE_ENDPOINT` (o que a doc do plugin sugere com `postgres`)?
3. A cadeia TLS do Lakebase é confiável pelo Node do runtime com `rejectUnauthorized: true`?
4. Mantemos o artefato `server-dist/appkit.mjs` versionado no git (como os demais) ou só gerado no
   deploy? O tamanho (~12 MB minificado) pesa no histórico.
5. Ligar telemetria interna do AppKit? Recomendação: não, até decisão de produto.
6. Confirmar a remoção de Provisioned do escopo (ver seção própria).

## Rollback

- **Fase 1 (flag):** remover `APPKIT_BOOT` (ou pôr `0`) e reiniciar o app. Com a opção A, sem novo
  deploy. Com a opção B, redeploy com `command` antigo.
- **Após o flip de default:** o legado continua no artefato por uma release antes da remoção.
- **Lakebase:** o caminho do `db.js` permanece até a migração ser validada ao vivo; voltar é
  reverter o commit da migração.
- O AppKit não altera schema nem dados; o rollback não depende de migração de banco.

## Referências

- Pacote: `node_modules/@databricks/appkit/docs/` (v0.76.1): `plugins/server.md`, `plugins/lakebase.md`,
  `configuration.md`, `faq.md`, `privacy.md`, `architecture.md`; `node_modules/@databricks/lakebase/README.md`.
- Código: `server/appkit.js`, `server/index.js` (seam), `scripts/build-appkit.mjs`,
  `scripts/appkit/stubs/`, `tsconfig.json`.
- Plano: `Fase 1 — Fundação AppKit + TypeScript` (plano aprovado do Pedro).
