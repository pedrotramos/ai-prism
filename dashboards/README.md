# AI Prism — AI/BI cost dashboard

Admins audit AI Prism's LLM cost/usage through a **Databricks AI/BI (Lakeview)
dashboard**, not inside the app. The heavy system-table scans run in AI/BI's own
compute, so a cold SQL Warehouse never blocks the app UI (the in-app "AI costs"
tab was removed in favor of this).

## What it shows

Real **billed** cost — `DBU × list price` from `system.billing.usage` ⋈
`system.billing.list_prices` — allocated to each user by their share of the
endpoint's daily tokens (`system.serving.endpoint_usage` ⋈
`system.serving.served_entities` for the endpoint name). Scoped to AI Prism via
the `usage_context['application'] = 'ai-prism'` stamp set on every gateway call
(see `server/llm.js`). **Note:** `usage_context` lands in
`system.serving.endpoint_usage.usage_context`, *not* in
`system.ai_gateway.usage.request_tags` — an earlier query read the wrong
table/column and always returned "No data".

One dataset (**`ai_prism_detail`**) — per user × endpoint × day, with `prompt_tokens`,
`completion_tokens`, `total_tokens`, `turns`, and the allocated `dbus` / `usd` —
feeds every widget (last 90 days).

Layout (12-column grid), matching the version curated in the dashboard editor:

- **Filters + headline KPIs** (top): a user multi-select and a period date-range
  picker (default last 30 days), plus counter cards — DBUs consumed, estimated cost
  (USD), turns, distinct users, input / output / total tokens.
- **Detail table**: user · endpoint · day with token and turn columns.
- **Four sections**, each a per-endpoint + per-day + per-user bar breakdown:
  **USD**, **Tokens**, **DBUs** and **Turns**.

Colors use the workspace theme's `visualizationColors` positions, so the dashboard
matches the app's visual language rather than a different color per chart.

> **Ingestion lag.** `system.serving.endpoint_usage` (tokens) and
> `system.billing.usage` (cost) both lag ~1 h — the dashboard is near-real-time,
> not live.

> **Editing.** `ai-costs.lvdash.json` is the exact export from the Databricks
> dashboard editor — edit there and re-export to update it; don't hand-edit the
> JSON. `deploy.sh` pushes it to a workspace and the bundle ships it as-is.

## Files

- `ai-costs.lvdash.json` — the serialized Lakeview dashboard (source of truth),
  exported from the Databricks dashboard editor and versioned here so the bundle
  can ship it as-is. To change the dashboard, edit it in the editor, then export
  and overwrite this file (File → Export, or the Lakeview API).
- `deploy.sh` — create or update it in a workspace via the Lakeview API.
- `ai-ops.lvdash.json` — dashboard de **operação** (ver a seção abaixo). É um rascunho
  gerado a partir da estrutura do export do editor; ainda não foi validado em um
  workspace. Antes de publicar, abra no editor, confira as consultas e re-exporte.

## Deploy

Usually you don't run this by hand: the **bundle deploys _and publishes_ the
dashboard for you**. `databricks.yml` references `./dashboards/ai-costs.lvdash.json`,
so `databricks bundle deploy` ships it into your workspace as a draft, and the
post-deploy auto-config job (`bundle/auto_config.py`) publishes it — so admins see
it live with no manual step. Use `deploy.sh` only to push the dashboard on its own,
outside the bundle (then publish it yourself, as noted below).

`deploy.sh` needs an authenticated `databricks` CLI profile and `jq`. Set these
to your own values (nothing here is tied to a specific account):

| Variable | What to set it to |
| --- | --- |
| `PROFILE` | Your `databricks` CLI profile (from `databricks auth login`). |
| `WAREHOUSE_ID` | Any SQL Warehouse in your workspace that can query the system tables. |
| `PARENT_PATH` | The workspace folder to create the dashboard in, e.g. `/Users/<you>@<company>.com`. |
| `DASHBOARD_ID` | Only when updating in place — the id printed on first create. |

```bash
# First time (creates a new dashboard in your workspace, prints its id):
PROFILE=<your-cli-profile> \
WAREHOUSE_ID=<your-warehouse-id> \
PARENT_PATH=/Users/<you>@<company>.com \
  ./dashboards/deploy.sh

# Update in place afterwards (idempotent):
PROFILE=<your-cli-profile> \
WAREHOUSE_ID=<your-warehouse-id> \
DASHBOARD_ID=<id-from-create> \
  ./dashboards/deploy.sh
```

Then open the dashboard in your workspace and **Publish** it so other admins can
view it. Each workspace running AI Prism deploys its own copy — the `.lvdash.json`
is fully portable, and the system tables it reads (`system.billing.*`,
`system.serving.*`) exist in every Unity Catalog workspace. Nothing in this
folder is bound to a particular account, warehouse, or user.

---

## Dashboard de operação (`ai-ops.lvdash.json`)

Complementa o de custos com **volume, usuários e latência**. Responde "o app está
sendo usado e respondendo?" e não "quanto custou?". Como o de custos, lê só
**system tables** do Unity Catalog, então não depende do Lakebase nem de uma
instrumentação nova. As consultas rodam pela AI/BI no warehouse configurado no deploy
(no bundle, o mesmo do app), mas em execução separada: o dashboard não passa pelo
processo do app.

### O que mostra

Filtro de período (padrão: últimos 30 dias) e, nas consultas, janela de 90 dias.

| Widget | Fonte | Medida |
| --- | --- | --- |
| Chamadas, usuários ativos, tokens (contadores) | `ops_daily`, `ops_user` | Total no período |
| Chamadas por dia × endpoint | `ops_daily` | Volume diário, empilhado por endpoint |
| Tokens por dia × endpoint | `ops_daily` | Idem, em tokens |
| Chamadas por usuário | `ops_user` | Concentração de uso |
| Totais por endpoint | `ops_daily` | Chamadas e tokens por modelo |
| Latência p95 do gateway por dia | `ops_latency` (join com `system.ai_gateway.usage`) | p95 por dia e endpoint, com atraso de ingestão |

Todas as consultas filtram `usage_context['application'] = 'ai-prism'` em
`system.serving.endpoint_usage`, o mesmo escopo do dashboard de custos (ver o começo
deste README). O join de latência usa `databricks_request_id = request_id`.

### O que não mostra (e por quê)

- **Taxa de erro e de "sem preço"**: `system.serving.endpoint_usage` não tem um campo de
  status verificado neste repositório, e o "sem preço" (`cost_usd IS NULL`) é um conceito
  do `usage_ledger`, que vive no Lakebase do app e não é uma system table. Ficam para a
  fase de telemetria.
- **Volume por tipo de chamada** (chat, mídia, classificador de intenção, imagem): o app
  só grava `application` em `usage_context`. Para separar por tipo, é preciso que
  `server/llm.js` passe também uma chave como `feature`. Essa mudança está fora deste
  dashboard.
- **Latência de cada turno ponta a ponta**: o gateway mede só a chamada ao modelo. A
  latência do turno inteiro (banco, tools, pós-processamento) é da telemetria OTEL.

### Publicar

Como o de custos, o arquivo é um export do editor e a fonte de verdade é o editor.
Para publicar fora do bundle, use `deploy.sh` com `DASHBOARD_FILE` e um nome próprio:

```bash
PROFILE=<profile> WAREHOUSE_ID=<warehouse-id> PARENT_PATH=/Users/<você>@<empresa>.com \
  DASHBOARD_FILE=ai-ops.lvdash.json \
  DISPLAY_NAME="AI Prism — Operação" \
  ./dashboards/deploy.sh
```

Depois: abra no editor, confira que as três consultas rodam, **Publique**, e re-exporte
o JSON se tiver alterado algo (não edite o JSON à mão).

Para o bundle publicar o dashboard junto com o deploy, adicione um recurso
`dashboards.ai_prism_ops` no `databricks.yml` apontando para este arquivo, com o mesmo
`warehouse_id` do dashboard de custos. Essa edição não foi feita aqui porque o
`databricks.yml` é de outra frente de trabalho.

### Telemetria OpenTelemetry (a adicionar)

> **A PREENCHER quando a telemetria estiver ativa.** Painéis previstos, sem dados hoje:
>
> - Taxa de erro por rota (`/api/*`) e por tipo de erro.
> - Percentis p50/p95/p99 de latência por rota e por tool.
> - Turno de chat ponta a ponta: TTFT, tempo até `done`, e distribuição por fase
>   (banco, tools, modelo, pós-processamento).
> - Saturação do pool de conexões do Lakebase (tempo de espera por conexão).
> - Taxa de erro de tool e de MCP, com o servidor de origem.
> - Tokens e custo por turno, correlacionados com o `request_id`.
>
> Ver [docs/operations.md §3](../docs/operations.md#3-telemetria-opentelemetry).

