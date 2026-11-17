<!-- i18n: source=dashboards/README.md source-hash=7a166c3166a6ebb3b554d5293ca1dd4dcea389d3 status=current -->
# AI Prism — dashboards AI/BI

[English](../../../dashboards/README.md) · **Português (Brasil)** · [Español](../../es/dashboards/README.md)

Os admins auditam o AI Prism por dois **dashboards AI/BI (Lakeview) do Databricks**, e
não dentro do app. Os dois leem só **system tables** do Unity Catalog: não precisam de
instrumentação extra e não dependem do Lakebase do app. As consultas rodam na AI/BI,
no SQL Warehouse do bundle, em execuções próprias: um warehouse frio ou uma varredura
pesada de system table nunca trava a interface do app.

| Dashboard | Arquivo | Responde |
| --- | --- | --- |
| **AI Prism — AI costs per user** | `ai-costs.lvdash.json` | "Quanto custou, e quem usou?" |
| **AI Prism — Operations** | `ai-ops.lvdash.json` | "O app está sendo usado e respondendo?" |

Um `databricks bundle deploy` (ou `./deploy.sh`) entrega os dois: eles estão declarados
no `databricks.yml` como `dashboards.ai_prism_costs` e `dashboards.ai_prism_ops`, no
mesmo warehouse do app. Cada workspace que roda o AI Prism deploya a própria cópia;
nada nesta pasta está preso a uma conta, warehouse ou usuário específico.

## Dashboard de custos (`ai-costs.lvdash.json`)

### O que mostra

Custo **faturado** de verdade — `DBU × preço de tabela` de `system.billing.usage` ⋈
`system.billing.list_prices` — rateado por usuário pela fatia dele nos tokens diários
do endpoint (`system.serving.endpoint_usage` ⋈ `system.serving.served_entities` para o
nome do endpoint). O escopo é o AI Prism, pela marca
`usage_context['application'] = 'ai-prism'` gravada em toda chamada ao gateway (ver
`server/llm.js`). **Atenção:** o `usage_context` cai em
`system.serving.endpoint_usage.usage_context`, *não* em
`system.ai_gateway.usage.request_tags`; uma consulta antiga lia a tabela/coluna errada
e sempre devolvia "No data".

Um dataset (**`ai_prism_detail`**), por usuário × endpoint × dia, com `prompt_tokens`,
`completion_tokens`, `total_tokens`, `turns` e os `dbus` / `usd` rateados, alimenta
todos os widgets (últimos 90 dias).

Layout (grade de 12 colunas), igual à versão curada no editor de dashboards:

- **Filtros + KPIs principais** (topo): seleção múltipla de usuário e seletor de
  período (padrão: últimos 30 dias), mais contadores: DBUs consumidas, custo estimado
  (USD), turnos, usuários distintos, tokens de entrada / saída / total.
- **Tabela de detalhe**: usuário · endpoint · dia, com colunas de tokens e turnos.
- **Quatro seções**, cada uma com barras por endpoint + por dia + por usuário:
  **USD**, **Tokens**, **DBUs** e **Turnos**.

As cores usam as posições de `visualizationColors` do tema do workspace, então o
dashboard segue a linguagem visual do app em vez de uma cor diferente por gráfico.

### Observações

> **Atraso de ingestão.** `system.serving.endpoint_usage` (tokens) e
> `system.billing.usage` (custo) atrasam cerca de 1 h: o dashboard é quase em tempo
> real, não ao vivo.

> **Edição.** `ai-costs.lvdash.json` é o export exato do editor de dashboards do
> Databricks. Edite lá e traga a mudança de volta para o repositório (ver
> [Editar um dashboard](#editar-um-dashboard)); não edite o JSON à mão.

## Dashboard de operação (`ai-ops.lvdash.json`)

Complementa o de custos com **volume, usuários e latência**. Mesmo escopo
(`usage_context['application'] = 'ai-prism'` em `system.serving.endpoint_usage`), a
mesma janela de 90 dias nas consultas e um filtro de período (padrão: últimos 30 dias).

### O que mostra

| Widget | Dataset | Medida |
| --- | --- | --- |
| Chamadas, usuários ativos, tokens (contadores) | `ops_daily`, `ops_user` | Total no período |
| Chamadas por dia × endpoint | `ops_daily` | Volume diário, empilhado por endpoint |
| Tokens por dia × endpoint | `ops_daily` | Idem, em tokens |
| Chamadas por usuário | `ops_user` | Concentração de uso |
| Totais por endpoint | `ops_daily` | Chamadas e tokens por modelo |
| Latência p95 do gateway por dia | `ops_latency` (join com `system.ai_gateway.usage`) | p95 por dia e endpoint, com atraso de ingestão |

O join de latência usa `databricks_request_id = request_id`. Ele só devolve linhas das
chamadas que também caem em `system.ai_gateway.usage`. No workspace de teste
verificado em 2026-11-17 a consulta rodou, mas devolveu 0 linhas: as chamadas do AI
Prism a `/serving-endpoints` não estavam nessa tabela ali, então o painel de latência
fica vazio até que estejam. Os outros cinco widgets não dependem dele.

### O que não mostra (e por quê)

- **Taxa de erro**: `system.serving.endpoint_usage` tem a coluna `status_code` (schema
  conferido em 2026-11-17), mas nenhum widget a usa ainda. Um painel de taxa de erro
  está previsto junto com os painéis de OpenTelemetry abaixo.
- **Chamadas sem preço** (`cost_usd IS NULL`): é um conceito do `usage_ledger`, que vive
  no Lakebase do app e não é uma system table.
- **Volume por tipo de chamada** (chat, mídia, classificador de intenção, imagem): o app
  só grava `application` em `usage_context`. Para separar por tipo, o `server/llm.js`
  precisa passar também uma chave como `feature`.
- **Latência ponta a ponta de um turno**: o gateway só mede a chamada ao modelo. A
  latência do turno inteiro (banco, tools, pós-processamento) vem da telemetria
  OpenTelemetry.

### Painéis de OpenTelemetry (a adicionar)

> **A preencher quando a telemetria estiver ativa.** Painéis previstos, sem dados hoje:
>
> - Taxa de erro por rota (`/api/*`) e por tipo de erro.
> - Latência p50/p95/p99 por rota e por tool.
> - Turno de chat ponta a ponta: TTFT, tempo até `done` e a divisão por fase
>   (banco, tools, modelo, pós-processamento).
> - Saturação do pool de conexões do Lakebase (tempo de espera por conexão).
> - Taxa de erro de tool e de MCP, com o servidor de origem.
> - Tokens e custo por turno, correlacionados com o `request_id`.
>
> Ver [docs/operations.md §3](../../operations.md#3-telemetry-opentelemetry).

## Deploy e publicação

### Pelo bundle (padrão)

Normalmente você não deploya esses dashboards à mão. O `databricks bundle deploy` (que
o `./deploy.sh` e o `.\deploy.ps1` rodam por você) cria ou atualiza os dois como
**rascunho** na pasta do bundle no workspace. Depois:

- **Dashboard de custos**: o job de auto-config pós-deploy (`bundle/auto_config.py`) o
  **publica**, e os admins já o veem publicado, sem passo manual.
- **Dashboard de operação**: fica como **rascunho**. Abra-o no workspace
  (*Dashboards* → "AI Prism — Operations"; no alvo `dev` o nome ganha o prefixo
  `[dev <usuário>]`) e clique em **Publish** uma vez. Os próximos deploys atualizam o
  rascunho; publique de novo para levar a mudança a quem só visualiza.

### Sozinho, com `deploy.sh`

O `dashboards/deploy.sh` envia um dashboard pela API do Lakeview, fora do bundle.
Precisa de um perfil autenticado da CLI `databricks` e do `jq`. Use os seus valores
(nada aqui está preso a uma conta específica):

| Variável | O que colocar |
| --- | --- |
| `PROFILE` | Seu perfil da CLI `databricks` (de `databricks auth login`). |
| `WAREHOUSE_ID` | Qualquer SQL Warehouse do workspace que consiga ler as system tables. |
| `PARENT_PATH` | A pasta do workspace onde criar o dashboard, ex.: `/Users/<você>@<empresa>.com`. |
| `DASHBOARD_ID` | Só para atualizar no lugar: o id impresso na primeira criação. |
| `DASHBOARD_FILE` | Opcional: `ai-costs.lvdash.json` (padrão) ou `ai-ops.lvdash.json`. |
| `DISPLAY_NAME` | Opcional: o nome do dashboard (padrão "AI Prism — AI costs per user"). |

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

# The operations dashboard, with its own name:
PROFILE=<your-cli-profile> \
WAREHOUSE_ID=<your-warehouse-id> \
PARENT_PATH=/Users/<you>@<company>.com \
DASHBOARD_FILE=ai-ops.lvdash.json \
DISPLAY_NAME="AI Prism — Operations" \
  ./dashboards/deploy.sh
```

Depois, abra o dashboard no workspace e clique em **Publish** para que os outros
admins o vejam. Os arquivos `.lvdash.json` são totalmente portáveis, e as system tables
que eles leem (`system.billing.*`, `system.serving.*`, `system.ai_gateway.*`) existem em
todo workspace com Unity Catalog.

## Editar um dashboard

Os arquivos JSON são exports do editor de dashboards, e a cópia do repositório é o que
todo deploy entrega. Para mudar um dashboard:

1. Edite o rascunho deployado no editor de dashboards e confira que todo dataset roda.
2. Traga a mudança de volta para o repositório, por exemplo
   `databricks bundle generate dashboard --resource ai_prism_ops --force -p <PROFILE>`
   (ou `ai_prism_costs`), ou *File → Export* e sobrescreva o arquivo aqui.
3. Faça commit do JSON. O próximo `bundle deploy` o entrega como está.

O teste `tests/bundleDashboards.test.mjs` confere, offline, que todo arquivo daqui está
declarado no `databricks.yml`, que todo widget lê um dataset que existe e que toda
consulta em `system.serving.endpoint_usage` tem o escopo do AI Prism.

## Arquivos

- `ai-costs.lvdash.json`: o dashboard de custos (fonte de verdade do bundle).
- `ai-ops.lvdash.json`: o dashboard de operação (fonte de verdade do bundle).
- `deploy.sh`: cria ou atualiza um dashboard num workspace pela API do Lakeview, fora
  do bundle.
