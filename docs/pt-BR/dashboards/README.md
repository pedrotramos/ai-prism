<!-- i18n: source=dashboards/README.md source-hash=390dfdb87acaf41c391e1b04185db261253be47d status=current -->
# AI Prism — dashboards AI/BI

[English](../../../dashboards/README.md) · **Português (Brasil)** · [Español](../../es/dashboards/README.md)

Os admins auditam o AI Prism por três **dashboards AI/BI (Lakeview) do Databricks**, e
não dentro do app. Dois leem só **system tables** do Unity Catalog: não precisam de
instrumentação extra e não dependem do Lakebase do app. As consultas rodam na AI/BI,
no SQL Warehouse do bundle, em execuções próprias: um warehouse frio ou uma varredura
pesada de system table nunca trava a interface do app.

| Dashboard | Arquivo | Responde |
| --- | --- | --- |
| **AI Prism — AI costs per user** | `ai-costs.lvdash.json` | "Quanto custou, e quem usou?" |
| **AI Prism — Operations** | `ai-ops.lvdash.json` | "O app está sendo usado e respondendo?" |
| **AI Prism — Telemetry** | `ai-telemetry.lvdash.json` (gerado) | "O que falhou, onde, e qual trace mostra o porquê?" |

Um `databricks bundle deploy` (ou `./deploy.sh`) entrega os três: eles estão declarados
no `databricks.yml` como `dashboards.ai_prism_costs`, `dashboards.ai_prism_ops` e `dashboards.ai_prism_telemetry`, no
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

## Dashboard de telemetria (`ai-telemetry.lvdash.json`)

Diferente dos outros dois, lê as **tabelas de telemetria do próprio app** (`otel_spans`): só
existe depois de ligar a telemetria com `scripts/telemetry/enable.sh`
([docs/pt-BR/operations.md §3](../operations.md#3-telemetria-opentelemetry)). O arquivo é
**gerado** por `build.py` para um `catalog.schema`, porque um arquivo de dashboard não aceita
variável do bundle:

```bash
python3 dashboards/build.py                                  # ai_prism.telemetry (padrões das variáveis do bundle)
python3 dashboards/build.py --catalog <catalog> --schema <schema>
python3 dashboards/build.py --check                          # sai com 1 se o arquivo em disco está velho
```

- **Aba Telemetria**: requisições a `/api`, 5xx, turnos de chat e chamadas ao gateway (contadores);
  requisições por dia por classe de status e turnos por dia por desfecho (barras empilhadas); tabelas de rotas
  (volume, 5xx, p95), modelos (chamadas, erros, tokens, custo, p95) e ferramentas (chamadas, erros, p95).
- **Aba Falhas e trace**: falhas dos últimos 7 dias (resposta 5xx, turno, chamada ao gateway ou
  ferramenta com erro) com o `trace_id`, e um filtro **Trace id** que lista todos os spans desse trace.
  É para aqui que levam os alertas SQL A2 e A7 (`databricks.yml`).

Edite o `build.py`, nunca o JSON. `tests/dashboardsBuild.test.mjs` confere que o arquivo versionado
é igual à saída do gerador e que nenhum widget fica em rascunho (contador com chave `trend`,
versões, campos que não casam com o dataset).

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

O dashboard de telemetria é a exceção: é gerado (veja acima), então altere o
`build.py` e rode de novo.

O teste `tests/bundleDashboards.test.mjs` confere, offline, que todo arquivo daqui está
declarado no `databricks.yml`, que todo widget lê um dataset que existe e que toda
consulta em `system.serving.endpoint_usage` tem o escopo do AI Prism.

## Arquivos

- `ai-costs.lvdash.json`: o dashboard de custos (fonte de verdade do bundle).
- `ai-ops.lvdash.json`: o dashboard de operação (fonte de verdade do bundle).
- `ai-telemetry.lvdash.json`: o dashboard de telemetria, gerado por `build.py` (versionado para `ai_prism.telemetry`).
- `build.py`: o gerador do dashboard de telemetria.
- `deploy.sh`: cria ou atualiza um dashboard num workspace pela API do Lakeview, fora
  do bundle.
