<!-- i18n: source=docs/operations.md source-hash=6b892cf4147f447e27116fb91191e2efb2801f3c status=current -->
# Operação do AI Prism

[English](../operations.md) · **Português (Brasil)** · [Español](../es/operations.md)

Este documento cobre o que é preciso para manter uma instalação do AI Prism em
funcionamento: como saber se ela está saudável, onde estão os logs, o que monitorar,
os SLOs propostos, e o runbook de deploy, rollback e diagnóstico.

Os nomes de recursos são os do `databricks.yml` (app `ai-prism`, Lakebase
`ai-prism`, warehouse `ai-prism`, job `ai-prism-auto-config`). Os comandos usam
`<PROFILE>` para o profile da CLI do workspace de destino; nada aqui depende de um
host fixo.

- Modelo de ameaças e controles: [security-threat-model.md](../security-threat-model.md)
- Performance e carga: [performance.md](../performance.md)
- Governança de várias instalações: [fleet-governance.md](../fleet-governance.md)

---

## 1. Saúde

`GET /api/health` diz se este processo e o banco dele respondem:

| Resposta | Corpo | Quando |
|---|---|---|
| `200` | `{"status":"ok","db":"ok","version":"1.4.0","commit":null,"uptime_s":123}` | O `SELECT 1` no Lakebase respondeu em até 2 s |
| `503` | `{"status":"degraded"}` | A consulta falhou ou não respondeu em 2 s; o motivo está no log (`health: database check failed: …`) |

```bash
# como o smoke faz: token OAuth de usuário para a URL do app
curl -sS -i -H "Authorization: Bearer $DATABRICKS_TOKEN" -H "x-request-id: probe-1" <APP_URL>/api/health
```

- Fica atrás da mesma autenticação de toda rota `/api` (o proxy do Apps fornece a identidade)
  e consulta com a identidade de quem chama, pelo pool compartilhado, como qualquer outra query.
- Nunca segura uma conexão: o próprio Postgres aborta a consulta em 2 s (`SET LOCAL
  statement_timeout`, então a conexão do pool volta livre e sem nenhuma configuração), a resposta sai em 2 s não importa o
  que o pool faça, e no máximo uma verificação roda por vez em cada processo (probes que chegam
  nesse meio-tempo esperam a mesma verificação).
- `version` é gravada no bundle do servidor no build (vale mesmo sem `package.json` ao lado de
  `server-dist/`); o app também a registra no log ao subir (`AI Prism version <x.y.z>`).
- `commit` vem da variável de ambiente `AI_PRISM_COMMIT` quando o deploy a define; senão é
  `null`.
- O `GET /health` do próprio AppKit (sem `/api`) só diz que o processo está no ar; ele também
  traz `x-request-id`.
- Um probe saudável não vai para o log; um 503 vai.

Outros sinais:

| Sinal | Como | O que prova | O que não prova |
|---|---|---|---|
| SPA | `GET <APP_URL>/` sem redirect | Processo no ar e `client/dist` presente | Banco, gateway |
| Identidade | `GET <APP_URL>/api/me` autenticado | Processo, proxy e token aceitos | Banco: `/api/me` degrada para "não admin" quando o banco falha |
| Persistência | `npm run smoke` (passo "persistência") | Escrita e leitura no Lakebase | Latência real sob carga |

O smoke completo (`npm run smoke`, com `APP_URL` e `DATABRICKS_TOKEN`) é o teste de
saúde que importa depois de um deploy. Ele cria uma sessão de teste, faz um turno real,
lê as mensagens de volta, gera um documento e apaga a sessão. Veja
[§6.1](#61-deploy) para a ordem.

---

## 2. Logs

```bash
# últimas linhas do app
databricks apps logs ai-prism -p <PROFILE>

# o comando também aceita --help para filtros; confira a versão da CLI instalada
databricks apps logs --help
```

Cada linha do servidor é um objeto JSON com exatamente estes campos (`null` quando o campo
não se aplica):

| Campo | Conteúdo |
|---|---|
| `ts` | Timestamp ISO-8601 |
| `level` | `debug`, `info`, `warn` ou `error` (`warn` e `error` vão para o stderr) |
| `request_id` | O id da requisição, também devolvido no cabeçalho de resposta `x-request-id`. Um `x-request-id` recebido (letras, dígitos, `.`, `_`, `:`, `-`, até 128 caracteres) é mantido; senão o servidor gera um UUID |
| `user_hash` | Os 12 primeiros caracteres hex do SHA-256 do e-mail do usuário em minúsculas: agrupa as linhas de um usuário sem o endereço |
| `route` | Método e padrão da rota (`POST /api/sessions/:id/compact`); nunca a query string |
| `status` | Status HTTP, na linha de acesso |
| `duration_ms` | Duração da requisição, na linha de acesso |
| `msg` | A mensagem; um erro vem depois de `: ` |

Cada requisição `/api` escreve uma linha de acesso (`"msg":"request"`) quando a resposta
termina, e qualquer 5xx fora de `/api` também. Linhas escritas durante uma requisição (um aviso
no meio de um turno) levam o `request_id` dela, então todas as linhas de uma requisição podem
ser reunidas; quem relata um problema pode informar o `x-request-id` da resposta que falhou.

O que nunca chega ao log: só os campos acima são escritos, então nenhum prompt, resposta, corpo
de requisição ou argumento de tool; e-mails viram `[email]`, bearer tokens, tokens de acesso
pessoal e JWTs viram `[token]`, e comandos SQL viram `[sql]` (garantido por
`server/log.test.ts`). Uma mensagem tem no máximo 1000 caracteres.

Mensagens que valem alerta manual (o início de `msg`, texto exato):

| Mensagem (início) | Significado | Ação |
|---|---|---|
| `AI Prism listening on :<porta>` | Processo subiu | Confirmar após cada deploy/restart |
| `identity-binding: could not verify the forwarded token, allowing the request (…)` | O workspace não respondeu ao `SCIM /Me` (timeout, 5xx, escopo); a requisição passou sem o vínculo e-mail ↔ token. No máximo 1 linha/min | Frequente: checar o workspace e o escopo `iam.current-user:read` do token OBO |
| `identity-binding: identity_mismatch: … (IDENTITY_BINDING=warn, allowed)` / `identity-binding: invalid_token: …` | Modo `warn`: a divergência foi registrada e a requisição passou | Diagnóstico do rollback; corrigir a causa e voltar para `enforce` ([SECURITY.md](SECURITY.md#vínculo-entre-e-mail-e-token-serveridentitybindingts)) |
| `identity-binding: rejected a request: identity_mismatch` / `invalid_token` | Uma requisição chegou com e-mail que não é do dono do token, ou com token recusado pelo workspace, e recebeu 401 | Ver [§6.5](#65-tokens-e-lakebase); repetido sem explicação é sinal de tentativa de personificação |
| `unhandled error on <MÉTODO> <rota> -> <status>:` | Erro que nenhuma rota tratou (JSON malformado, upload grande, exceção); o cliente recebeu JSON genérico | Ler o detalhe na própria linha |
| `lakebase: service-principal login unavailable, using per-user identity:` | Login do SP falhou; o app usou a identidade do usuário | Ver [§6.5](#65-tokens-e-lakebase) |
| `lakebase: permission denied for the service principal (…); identity unchanged` | Falta um privilégio ao SP: os grants dele não foram aplicados ou estão velhos | Rodar `node scripts/migrate.mjs grants --role <SP>` como dono das tabelas ([§6.4](#64-migrações-do-banco)) |
| `migrations: 0002 schema_ai_prism deferred … ownership not normalized` | O hand-off de dono não rodou antes de publicar o código novo; o app segue no `public` | Rodar o job de auto-config (ou `migrate.mjs prepare`) e depois `migrate.mjs grants` ([§6.4](#64-migrações-do-banco)) |
| `lakebase SP pool: idle client error (dropped):` | Conexão ociosa caiu (normal após suspensão) | Só investigar se for frequente |
| `embedding update failed:` / `message embedding index failed:` / `title/session update failed:` | Pós-processamento do turno falhou (não impede a resposta) | Frequente indica problema no gateway de embedding |
| `transcrição falhou (…)` / `análise de planilha falhou (…)` / `ingestão de pptx falhou (…)` | Falha em anexo específico | Ver a mensagem para o motivo |
| `history retrieval failed:` | Recuperação do histórico (pgvector) falhou | Checar a extensão `vector` e o índice |
| `python tool setup failed, continuing without it:` | UDF Python indisponível (warehouse, grant ou escopo `sql`) | Ver [§6.5](#65-tokens-e-lakebase) |
| `migrations: applied <NNNN> <nome>` / `migrations: recorded 0001 baseline for an existing 1.x schema (no DDL run)` | Migração aplicada no boot / banco 1.x registrado como versão 1 | Esperado uma vez por migração nova. Ver [§6.4](#64-migrações-do-banco) |
| `migrations: existing 1.x schema is incomplete (missing N: …)` | Banco 1.x sem algum item do baseline (tabela, coluna, índice ou constraint); o `0001` idempotente roda em vez de só registrar | Nenhuma, se não vier a linha abaixo |
| `migrations: after 0001 baseline the schema still differs from the baseline (…)` | Divergência que o `0001` não corrige (ex.: constraint apagada à mão); o app segue | Corrigir à mão ou restaurar backup ([§6.4](#64-migrações-do-banco)) |
| `migrations: the database has versions this code does not know (…)` | O banco foi migrado por uma release mais nova (ex.: depois de um rollback de código) | Esperado no rollback; ver [§6.2](#62-rollback) |
| `migrations: no privilege to record the schema version (42501: …)` | A identidade do app não pode criar ou gravar `schema_migrations`; o schema 1.x está completo e o app segue | Rodar `scripts/migrate.mjs up` como dono das tabelas ([§6.4](#64-migrações-do-banco)) |
| `migrations: applied file changed: …` `[MIGRATION_CHECKSUM]` | Um arquivo de migração já aplicado foi editado; o app não sobe | Restaurar o arquivo lançado ([§6.4](#64-migrações-do-banco)) |
| `limpeza de imagens da sessão falhou:` | Arquivo do Volume não foi apagado | Limpeza manual, se persistir |

*Consultas de exemplo:* com a saída de `apps logs` num arquivo local (cada linha JSON pode
vir com um prefixo do coletor de logs, daí o `grep -o`):

```bash
# salvar o log
databricks apps logs ai-prism -p <PROFILE> > app.log

# todas as linhas de uma requisição
grep -o '{"ts".*}' app.log | jq -c 'select(.request_id == "<REQUEST_ID>")'

# erros do servidor com rota e duração
grep -o '{"ts".*}' app.log | jq -r 'select(.status >= 500) | [.ts, .route, .status, .duration_ms, .msg] | @tsv'

# requisições por rota
grep -o '{"ts".*}' app.log | jq -r 'select(.msg == "request") | .route' | sort | uniq -c | sort -rn
```

Não há agregação no servidor; para contagens ao longo do tempo, use as tabelas de telemetria
([§3](#3-telemetria-opentelemetry)).

---

## 3. Telemetria OpenTelemetry

O servidor cria três tipos de span com a API do OpenTelemetry:

| Span | Atributo | Significado |
|---|---|---|
| `llm.call` | `gen_ai.request.model` | Serving endpoint chamado |
| `llm.call` | `gen_ai.usage.input_tokens` | Tokens de prompt (incluindo os de cache), como o gateway informou |
| `llm.call` | `gen_ai.usage.output_tokens` | Tokens de saída, contados como no ledger de custos: o maior entre `completion_tokens` e `total_tokens − prompt_tokens` |
| `llm.call` | `cost_usd` | Custo precificado da chamada (o preço do ledger); ausente fora de uma requisição de usuário |
| `llm.call` | `status` | `ok` ou `error` |
| `tool.call` | `tool.name` | Nome da função que o modelo chamou (`execute_python`, `ask_genie_one`, uma função UC, uma tool MCP) |
| `tool.call` | `tool.kind` | `python`, `genie`, `genie-one`, `vector-search`, `uc`, `mcp-external`, `image-gen`, … |
| `tool.call` | `duration_ms` | Duração da chamada da tool |
| `tool.call` | `status` | `ok` ou `error` (também `error` quando a tool respondeu com um texto `ERROR:`) |
| `chat.turn` | `route` | `/api/chat`, `/api/sessions/:id/continue` ou `/api/sessions/:id/messages/:messageId/regenerate` |
| `chat.turn` | `request_id` | O `x-request-id` da resposta, também nas linhas de log e no evento SSE `meta` |
| `chat.turn` | `session.id` | Id da sessão de chat (vazio quando a requisição foi recusada antes de haver um) |
| `chat.turn` | `model` | Modelo que o usuário escolheu para o turno |
| `chat.turn` | `caps` | Capacidades ativadas no turno, separadas por vírgula (`deck`, `document`, `image`, …) |
| `chat.turn` | `status` | `ok`, `error`, `cancelled` (o cliente saiu; nada foi gravado) ou `rejected` (4xx antes do streaming, como `409 turn_in_flight`) |
| `chat.turn` | `saved` | Só em `cancelled`: `false` quando nada foi gravado (a regra), `true` quando o cliente saiu com a resposta já sendo gravada, então ela foi gravada inteira |
| Span HTTP de servidor | `http.status_code`, `http.method`, `http.target` | Um span por requisição, chamado `<MÉTODO> <rota>` (`kind = SPAN_KIND_SERVER`); vem do AppKit, não do AI Prism. O trace de um turno começa aqui: `POST /api/chat` é o pai de `chat.turn` |

Cada rodada de chat, título, classificação de intenção, embedding e geração de imagem gera um
`llm.call`; cada invocação de tool gera um `tool.call`. Os atributos nunca levam texto de
prompt, argumentos de tool, e-mails ou SQL. Cada rota de turno gera um `chat.turn`, pai de
todo `llm.call` e `tool.call` daquele turno, então um trace é um turno.

**Exportação.** Os spans só são exportados quando `OTEL_EXPORTER_OTLP_ENDPOINT` está definida: o AppKit então
registra o exportador OTLP. Sem ela, e sempre com `APPKIT_BOOT=0`, os spans são no-ops:
nada é exportado e nada falha. O Databricks Apps define a variável quando a telemetria do app está
ligada (Beta, só em regiões suportadas; as tabelas devem ser Delta gerenciadas na região do
workspace). Verificado num workspace real: após um redeploy, os spans chegam a
`otel_spans` cerca de um minuto depois da requisição (o protocolo `grpc` anunciado pelo runtime não é problema).

Use o script, não um comando escrito à mão. `databricks apps update --json` **substitui o spec
inteiro do app**: enviar só `telemetry_export_destinations` apagaria os recursos do app
(warehouse, Lakebase) e seus escopos de API do usuário. O script lê o app antes e mescla.

```bash
# crie o schema uma vez; o service principal do app precisa de USE CATALOG no catálogo e
# USE SCHEMA + CREATE TABLE + SELECT + MODIFY no schema (a plataforma cria as tabelas)
scripts/telemetry/enable.sh --profile <PROFILE> --app <APP_NAME> --catalog <catalog> --schema <schema> --dry-run   # só imprime
scripts/telemetry/enable.sh --profile <PROFILE> --app <APP_NAME> --catalog <catalog> --schema <schema>
# depois faça redeploy do app (§6.1): a variável é lida na partida
```

O script exige `--profile` e `--app` explícitos, aceita só identificadores simples, não imprime
segredo e **recusa o app chamado `ai-prism`**: altere o app em produção à mão com o mesmo payload
(`{"telemetry_export_destinations":[{"unity_catalog":{"logs_table":"<c>.<s>.otel_logs","metrics_table":"<c>.<s>.otel_metrics","traces_table":"<c>.<s>.otel_spans"}}]}`),
depois de ler o spec atual para não perder mais nada. Onde a região não é suportada,
`OTEL_EXPORTER_OTLP_ENDPOINT` pode apontar para um coletor seu.

**Dashboard.** `dashboards/ai-telemetry.lvdash.json` ("AI Prism — Telemetry") é **gerado**
por `dashboards/build.py` para um `catalog.schema` (um arquivo Lakeview não aceita variável
do bundle). Edite o gerador, nunca o JSON; `python3 dashboards/build.py --check` falha quando
o arquivo em disco está velho. O arquivo versionado aponta para `ai_prism.telemetry`, os padrões das
variáveis do bundle `telemetry_catalog` e `telemetry_schema`; para outro schema rode
`python3 dashboards/build.py --catalog <catalog> --schema <schema>` antes do `bundle deploy`.
Aba **Telemetria**: requisições, 5xx, turnos e chamadas ao gateway, requisições por dia por classe de status,
turnos por dia por desfecho, e tabelas de rotas (p95), modelos (chamadas, erros, tokens, custo, p95)
e ferramentas. Aba **Falhas e trace**: as falhas dos últimos 7 dias com o `trace_id`, e um
filtro que mostra todos os spans de um trace.

**Consulta.** `attributes` é `VARIANT`; confira as colunas com
`DESCRIBE TABLE <catalog>.<schema>.otel_spans` antes da primeira consulta. As chamadas de
gateway e de tool mais lentas das últimas 24 horas:

```sql
SELECT
  time,
  trace_id,
  name,
  attributes:['gen_ai.request.model']::string AS model,
  attributes:['gen_ai.usage.input_tokens']::bigint AS input_tokens,
  attributes:['gen_ai.usage.output_tokens']::bigint AS output_tokens,
  attributes:['cost_usd']::double AS cost_usd,
  attributes:['tool.name']::string AS tool,
  attributes:['status']::string AS status,
  (end_time_unix_nano - start_time_unix_nano) / 1e6 AS duration_ms
FROM <catalog>.<schema>.otel_spans
WHERE service_name = 'ai-prism'
  AND name IN ('llm.call', 'tool.call')
  AND time >= current_timestamp() - INTERVAL 24 HOURS
ORDER BY duration_ms DESC
LIMIT 50
```

`service_name` é o nome do app. A retenção é a da tabela Delta (o app não define nenhuma).

---

## 4. O que monitorar

| Sinal | Fonte hoje | Limite de atenção | Ação |
|---|---|---|---|
| Disponibilidade (`/api/health` com 200 e `db: ok`, `/` e `/api/me` com 2xx) | Smoke e teste de carga; `GET /api/health` (autenticado; responde `{ status, db, version, commit, uptime_s }`, 503 `degraded` quando o banco não responde em 2 s) | Qualquer falha em 5 min | Ver [§6.6](#66-processo-travado-ou-sem-resposta) |
| Erros 5xx no app | Logs (`apps logs`) | Ver SLO S1 | Diagnóstico de [§6.7](#67-diagnosticar-um-turno-lento) |
| Latência de API | Teste de carga (`npm run loadtest`) | Ver SLO S2 | Medir no mesmo ambiente |
| Turno de chat (TTFT e conclusão) | Smoke e teste de carga; SSE do cliente | Ver SLO S3 e S4 | [§6.7](#67-diagnosticar-um-turno-lento) |
| Custo por dia e por modelo | Dashboard de custos (`ai-costs`) | Limite definido pelo operador (ver alerta A5) | Revisar usuário e endpoint |
| Volume, usuários ativos e tokens | Dashboard de operação (`ai-ops`) | Sem limite fixo | Acompanhar tendência |
| Latência do gateway | `system.ai_gateway.usage` (dashboard `ai-ops`) | Ver SLO S3 | Com atraso de ingestão |
| CPU, memória e conexões do Lakebase | Console do Lakebase | Ver alerta A4 | Dimensionar CU |
| Consumo do SQL Warehouse | Console do warehouse | Auto-stop de 10 min | Confirmar que desliga |
| Mudanças de admin e execuções de retenção | `GET /api/admin/audit` (só admins) | Qualquer ação de admin que ninguém saiba explicar; uma linha `retention.sweep` ausente por mais de um dia com `retentionDays` ligada | [§6.8](#68-retenção-instruções-da-organização-e-trilha-de-auditoria-de-admin) |
| Avisos de boot | Logs (`apps logs`): `APP_AUDIT_HASH_KEY is not set`, `the database has versions this code does not know`, `migrations: no privilege to record the schema version` | Qualquer um deles após um deploy | [§6.4](#64-migrações-do-banco), [§6.10](#610-papéis-e-segurança-em-nível-de-linha-rls) |

**Limitação:** sem telemetria ([§3](#3-telemetria-opentelemetry)) não há métrica de erro por
rota nem percentil de latência do servidor; esses números saem só do teste de carga, que mede
do lado do cliente. Com a telemetria ligada, o dashboard `ai-telemetry` mostra os dois
(5xx e p95 por rota, erros por modelo e ferramenta) e os alertas A2 e A7 os vigiam.

---

## 5. SLOs e alertas

Os números abaixo são **propostas**. Eles devem ser validados com
`npm run loadtest` no ambiente real antes de virar compromisso. Medição: as fontes de §4.

### 5.1 SLOs propostos

| ID | SLO | Alvo | Janela | Medição hoje |
|---|---|---|---|---|
| S1 | Disponibilidade da API (`/api/me` responde 2xx) | ≥ 99,5% | 30 dias, excluindo janelas de deploy anunciadas | Teste de carga periódico; logs |
| S2 | Latência de leitura (`/api/me`, `/api/models`, `/api/sessions`) | p95 ≤ 800 ms com o app aquecido, em 20 usuários virtuais | Por teste de carga | `npm run loadtest` |
| S3 | Primeiro token do turno (evento `meta` até o primeiro `token`) | p95 ≤ 4 s, modelo rápido, sem cold start do Lakebase | Por teste de carga | Smoke e `loadtest --chat` |
| S4 | Turno concluído sem evento `error` | ≥ 98% | 7 dias | Spans `chat.turn` com `status = error` (dashboard `ai-telemetry`, alerta A7) com a telemetria ligada; senão `loadtest --chat` |
| S5 | Primeira requisição após suspensão do Lakebase | ≤ 15 s | Por ocorrência | Logs e teste manual (o `connectionTimeoutMillis` do pool é 15 s, `server/db/pool.ts`) |
| S6 | Smoke pós-deploy | 100% verde antes de liberar o tráfego | Por deploy | `npm run smoke`; o mesmo script roda em todo PR na CI ([§5.3](#53-smoke-na-ci)) |

### 5.2 Regras de alerta propostas

| ID | Condição | Janela | Severidade | Ação |
|---|---|---|---|---|
| A1 | Smoke pós-deploy falha (S6) | Imediata | Crítica | Rollback ([§6.2](#62-rollback)) |
| A2 | Mais de 5% de respostas 5xx ou erro de login (302 ou 401) em `/api/*` (ao menos 5 requisições) | 10 min | Alta | Trace da requisição que falhou (abaixo); token e Lakebase ([§6.5](#65-tokens-e-lakebase)) |
| A3 | Sequência de `lakebase: service-principal login unavailable` nos logs | 10 min | Alta | Ver [§6.5](#65-tokens-e-lakebase) |
| A4 | Lakebase no teto de 16 CU por mais de 15 min | 15 min | Média | Revisar carga; avaliar teto maior |
| A5 | Custo diário (`usd` em `ai-costs`) acima de 2× a média móvel de 7 dias | Diário | Média | Revisar usuário e endpoint no dashboard |
| A6 | Usuário com volume de chamadas acima do esperado (dashboard `ai-ops`, aba por usuário) | Diário | Média | Conferir o caso; pode ser abuso (G4) |
| A7 | Mais de 10% dos spans `chat.turn` terminam em `error` (ao menos 5 turnos) | 30 min | Alta | Trace do turno que falhou (abaixo); SLO S4 |

**Como executar hoje:** A1 é do script de deploy (o smoke falha = deploy falha). A5 e A6
são consultas de alerta no Databricks SQL sobre os datasets dos dashboards. **A2 e A7 são alertas SQL
sobre as tabelas de telemetria**, declarados no `databricks.yml` (`alerts.ai_prism_a2_http_errors`,
`alerts.ai_prism_a7_turn_errors`) com as tabelas vindas das variáveis `telemetry_catalog` e
`telemetry_schema`. Nascem **pausados** (`telemetry_alerts_pause=PAUSED`): as consultas leem
`otel_spans`, que só existe depois de ligar a telemetria ([§3](#3-telemetria-opentelemetry)).
Quando existir, faça o deploy com `--var telemetry_alerts_pause=UNPAUSED` (e seu catálogo e schema) e adicione
assinantes a cada alerta no workspace. Cada alerta devolve `error_pct` (a coluna avaliada)
e `last_failing_trace_id`. A3 ainda depende da leitura dos logs.

**Do alerta ao trace em três cliques.**

1. Abra o alerta pela notificação: a linha de resultado mostra `error_pct` e `last_failing_trace_id`.
2. Abra o dashboard de telemetria pelo link na descrição do alerta, aba **Falhas e trace**.
3. Escolha esse trace id no filtro **Trace id**: a tabela lista todos os spans do turno
   (`POST /api/...` → `chat.turn` → `llm.call` / `tool.call`) com desfecho e duração. O passo
   que falhou é o que tem `error` ou 5xx.

Sem o dashboard, o mesmo trace em SQL: `SELECT time, name, attributes:['status']::string AS status,
(end_time_unix_nano - start_time_unix_nano) / 1e6 AS duration_ms FROM <catalog>.<schema>.otel_spans
WHERE trace_id = '<id>' ORDER BY time`. O `request_id` do turno (linhas de log, `meta` do SSE) é um
atributo do span `chat.turn`.

### 5.3 Smoke na CI

O `scripts/smoke.mjs` do pós-deploy (S6) também roda em todo PR e em todo push para
`main`, no job `Build & QA`. Assim, uma quebra no caminho do usuário aparece antes do
merge, e não só depois do deploy. O passo:

1. sobe `scripts/fake-gateway.mjs` em `127.0.0.1:8787`. É um AI Gateway falso cujos
   formatos (streaming, `tool_calls`, `usage`, embeddings) estão fixados numa gravação de
   um gateway real (`tests/fixtures/gateway-shapes.live.json`);
2. sobe `node server/index.js` com `LOCAL_DEV_MODE=1`, `DATABRICKS_HOST` apontando para o
   fake e o Postgres com pgvector do serviço da CI;
3. roda `npm run smoke` com `SMOKE_SKIP_ARTIFACT=0` e `SMOKE_EXPECT_EMAIL`: SPA, identidade,
   modelos, turno de chat com SSE, persistência, listagem, artefato (o fake responde ao
   pedido de documento com um bloco `document`, que o servidor salva) e limpeza;
4. se algo falha, imprime os logs do servidor e do fake no próprio job.

O que esse smoke **não** prova: autenticação do proxy do Apps, Lakebase real, modelos e
latência reais. Esses pontos continuam com o smoke pós-deploy contra a URL do App
([§6.1](#61-deploy)). Para reproduzir localmente, veja "Smoke local" em
[CONTRIBUTING.md](CONTRIBUTING.md#smoke-local).

### CI (branch Lakebase efêmera)

O workflow [`Lakebase branch`](../../.github/workflows/lakebase-branch.yml) (separado do
`ci.yml`) prova, contra um Lakebase **real** (Postgres 17, `databricks_auth`), o que o Postgres
descartável do job principal não prova: as migrações sobem, descem até 0 e sobem de novo, e as
suítes de isolamento e de RLS passam. Roda em PRs que tocam migrações, `server/db*` ou o script, e
sob demanda. Quem faz o trabalho é o [`scripts/ci/lakebase-branch.sh`](../../scripts/ci/lakebase-branch.sh):

1. cria a branch `w3-1-<run>` a partir de `production` com TTL de 4 h (a rede de segurança se o job
   morrer). `production` é só a origem da cópia; nunca recebe escrita nem é apagada;
2. cria um **banco novo** `ai_prism_ci` e a role `ai_prism_app` (`NOSUPERUSER`, `NOBYPASSRLS`) nele.
   As tabelas copiadas da produção pertencem ao service principal do app em produção e não podem
   ser assumidas, então nada delas é usado;
3. roda `migrate.mjs up` e depois o guarda de role: imprime `current_user`, `rolsuper` e
   `rolbypassrls` da role com que as suítes rodam e **reprova o job** se qualquer flag for
   verdadeira. A identidade que faz o deploy e o `databricks_superuser` têm `rolbypassrls = t`, e
   uma suíte de RLS rodada com essa role passa sem testar nada;
4. roda `server/isolation.test.js` e `server/rls.test.js` (35 casos, nenhum pulado);
5. roda `migrate.mjs down --to 0 --yes` e `up` de novo;
6. apaga a branch pelo caminho literal, em um trap que roda também quando um passo falha. A
   exclusão recusa qualquer caminho que contenha `production` ou que não seja
   `projects/<p>/branches/w3-1-<id>`. Um passo `always()` varre depois as branches da própria
   execução.

As suítes conectam com `ssl: false`, em um host de loopback, com uma senha para todas as roles. O
Lakebase exige TLS, aceita só o token OAuth como login (o login nativo por senha é desativado) e uma
role criada por SQL não consegue entrar. Por isso o job roda o
[`scripts/ci/pg-tls-proxy.mjs`](../../scripts/ci/pg-tls-proxy.mjs) em `127.0.0.1`: fala TLS com o
endpoint, troca uma senha descartável pelo token e mapeia um login como role `X` para a identidade
do deploy com `-c role=X`. A sessão passa a rodar como `X` (`current_user = X`, `rolbypassrls` de
`X`), que é o que o guarda de role confere.

**Sem credenciais o job é pulado e continua verde**, com um aviso no log. Ele precisa de três
secrets do repositório, criados por uma pessoa (o workflow nunca os cria): `LAKEBASE_CI_HOST`,
`LAKEBASE_CI_CLIENT_ID` e `LAKEBASE_CI_CLIENT_SECRET` (um service principal que cria e apaga
branches do projeto e pertence ao `databricks_superuser`), e, opcionalmente, a variável
`LAKEBASE_CI_PROJECT` (padrão `ai-prism`). O tempo total é de cerca de 15 minutos, quase todo na
suíte de RLS pela rede. Para rodar localmente do mesmo jeito:

```bash
# needs: databricks CLI, psql, node, jq, perl. Never touches the production branch.
SECRETS_PRESENT=1 LB_PROFILE=<PROFILE> LB_SUFFIX=local1 \
  LB_EVIDENCE_DIR=./evidence bash scripts/ci/lakebase-branch.sh run
```

Se um job morrer, procure branches `w3-1-*` sobrando (`databricks postgres list-branches
projects/<p>`); o TTL as remove de qualquer forma. Uma branch em `ARCHIVED` acorda na primeira
conexão; isso não é incidente.

---

## 6. Runbook

### 6.1 Deploy

**Preferido: um script.** `./deploy.sh [opções] <PROFILE> [CATALOG]` gera os artefatos
(`npm run bundle`), roda o `bundle deploy`, roda o job de auto-config, abre o hand-off de dono
(`migrate.mjs prepare`), publica o código (`apps deploy`), roda o smoke (`npm run smoke`)
contra a URL do app e, por fim, roda `migrate.mjs up --role <SP do app>` como dono do banco
(migrações, grants de menor privilégio, fecha o hand-off). O target vem de
`AI_PRISM_TARGET` (`dev` por padrão; `prod` para o deploy oficial). Um smoke que falha não
faz rollback: a versão nova já está no ar, então leia a tabela do smoke antes de liberar o
acesso aos usuários. A descrição completa e as opções (`--skip-build`, `--skip-smoke`, tags,
usage policy) estão em [onboarding-deployment.md](onboarding-deployment.md).

```bash
AI_PRISM_TARGET=prod ./deploy.sh <PROFILE>
```

**Manual, passo a passo** (a mesma sequência que o script roda; use para retomar uma execução
que falhou). Os PRs de feature não commitam `client/dist` nem `server-dist`; os PRs de release
os refazem e commitam.

<!-- i18n: code-translated en=19a229b432d5 -->
```bash
# valida a configuração (não cria nada)
databricks bundle validate -p <PROFILE> -t dev

# 0) artefatos que o app executa
npm run bundle

# 1) Lakebase, warehouse, app, dashboards e job
databricks bundle deploy -p <PROFILE> -t dev

# 2) auto-config (role PG do SP e hand-off de dono, UDF Python, Volume de imagens, semente de admin).
#    Rode-o ANTES de publicar o código.
databricks bundle run ai_prism_auto_config -p <PROFILE> -t dev

# 2b) como dono do banco: abre o hand-off de dono para o SP do app (§6.4)
node scripts/migrate.mjs prepare --role <client id do SP do app>

# 3) publica o CÓDIGO do app. O bundle deploy NÃO republica o processo em execução.
#    <SRC> é impresso pelo bundle deploy (tipicamente .../.bundle/ai-prism/dev/files)
databricks apps deploy ai-prism --source-code-path <SRC> -p <PROFILE>

# 4) smoke (S6): bloqueia a liberação se falhar
APP_URL=<URL-do-app> DATABRICKS_TOKEN=<token-oauth> npm run smoke

# 5) como dono do banco: migrações pendentes e grants do SP; fecha o hand-off
node scripts/migrate.mjs up --role <client id do SP do app>
```

Para `DATABRICKS_TOKEN`, use o token OAuth do usuário (`databricks auth token -p <PROFILE>`).
Não cole o token em logs nem em issues. Nunca deixe o passo 2b sem o passo 5: se uma execução parar
no meio, rode `node scripts/migrate.mjs close --role <client id do SP do app>` (só revoga).

### 6.2 Rollback

O rollback normal é de **código**. O schema do banco só volta junto quando a versão
nova trouxe uma migração que a antiga não aguenta (ver [§6.4](#64-migrações-do-banco)).

1. Identifique o último commit bom (tag ou SHA) que tinha `client/dist` e `server-dist`
   consistentes.
2. **Schema:** compare `server/migrations/` das duas versões. Se a versão nova não trouxe
   migração, ou se a migração nova só acrescenta (tabela ou coluna que a versão antiga
   ignora), não mexa no banco: a versão antiga sobe normalmente sobre um banco mais novo
   (a cada boot o log avisa `the database has versions this code does not know`). Se a migração nova
   muda algo que a antiga lê, rode o `down` **com o código novo ainda em mãos**, antes de
   trocar o código: `node scripts/migrate.mjs down --to <última versão da release antiga> --yes`.
3. Faça checkout dos artefatos bons em uma branch de hotfix (não reescreva `main`).
4. Repita o [§6.1](#61-deploy) a partir do passo 1.
5. Confirme com `npm run smoke`.

*Atenção:* o `down` de uma migração pode apagar dados que só a versão nova gravou. Leia o
arquivo `.down.sql` antes de rodar.

**Por ambiente.**

| Ambiente | Quem pode fazer rollback | Como | Checagens extras |
|---|---|---|---|
| Desenvolvimento local | A pessoa desenvolvedora | `git checkout`, depois `node --env-file=.env.local scripts/migrate.mjs status`; `down --to <N> --yes` é aceitável num banco de teste | Confira a linha `target:` que o comando imprime antes do `down` |
| CI / banco efêmero | Ninguém: descarte o banco | Recrie-o | `down --to 0` só é aceitável aqui |
| Target `dev` (`AI_PRISM_TARGET=dev`) | O responsável técnico | Passos 1-5 acima com os artefatos anteriores; `down` só para uma migração incompatível | Avise quem está testando; o `dev` prefixa os nomes dos recursos com o nome de usuário de quem faz o deploy |
| Target `prod` | O responsável técnico, com o responsável de custo/dados informado ([fleet-governance.md §2](fleet-governance.md#2-dono-e-responsáveis)) | Passos 1-5 acima a partir de uma branch de hotfix; `down` **só** depois de ler o `.down.sql` e, se ele apagar dados, depois de anotar um ponto de restauração point-in-time do Lakebase | Rode `npm run smoke` contra a URL do app; registre o SHA do commit no inventário |

Se os artefatos estão bons mas os dados estão errados (por exemplo, um `retentionDays`
reduzido), o rollback de código não ajuda: a restauração point-in-time do Lakebase é o único
caminho de volta ([§6.8](#68-retenção-instruções-da-organização-e-trilha-de-auditoria-de-admin)).

### 6.3 Parar e iniciar a App

```bash
databricks apps get ai-prism -p <PROFILE>
databricks apps stop ai-prism -p <PROFILE>
databricks apps start ai-prism -p <PROFILE>
```

Confira `databricks apps --help` na versão da CLI instalada.

### 6.4 Migrações do banco

O schema do Lakebase é versionado em arquivos SQL:

<!-- i18n: code-translated en=72cf80e8695f -->
```
server/migrations/NNNN_<nome>.up.sql     mudança (obrigatório)
server/migrations/NNNN_<nome>.down.sql   rollback dela (obrigatório)
```

A tabela `schema_migrations(version, name, checksum, applied_at)` registra o que já foi
aplicado. A versão `0001_baseline` é exatamente o schema que a 1.4 criava no boot.

**No boot (automático).** O primeiro request de cada processo roda `ensureSchema`, que
aplica as migrações pendentes em ordem. Cada uma roda numa transação junto com a sua linha
em `schema_migrations`: ou entra inteira e registrada, ou não entra. Um advisory lock do
Postgres deixa só um processo migrar por vez; os outros esperam e encontram tudo aplicado.
Com tudo aplicado, o custo são dois `SELECT`s e nenhum lock. A espera pelo lock tem limite
(2 min): passado esse tempo, o request falha com `[MIGRATION_LOCK_TIMEOUT]` e o próximo
tenta de novo. Como cada arquivo roda numa transação, comandos que o Postgres recusa em
transação (`CREATE INDEX CONCURRENTLY`, `VACUUM`) não podem ir numa migração.

**Banco criado por uma versão 1.x.** Sem `schema_migrations`, o runner confere no catálogo
do Postgres cada tabela, coluna, índice e constraint (com a definição) que o `0001` cria.
Se tudo está lá, registra a versão 1 sem rodar nenhum DDL (log
`recorded 0001 baseline for an existing 1.x schema`). Se falta qualquer item (uma 1.x mais
antiga, ou um schema parcial), roda o `0001` inteiro, que é idempotente e completa o que
falta sem tocar nos dados, e loga o que faltava (`existing 1.x schema is incomplete`).
O `0001` não recria tudo: uma constraint apagada à mão, por exemplo, continua faltando.
Nesse caso o log diz `the schema still differs from the baseline` com a lista, e o app
segue; corrija à mão.

**Identidade.** Quem cria `schema_migrations` e roda DDL precisa ser o dono das tabelas.
Se o app sobe com o service principal num banco criado por outra identidade, e o schema
1.x já está completo, o app segue funcionando e loga
`migrations: no privilege to record the schema version`. Nesse caso, rode `up` uma vez
como o dono (abaixo). Se houver uma migração nova pendente e o SP não puder aplicá-la, o
erro aparece. Um `permission denied` (42501) no SP não troca mais para a identidade do
usuário: o app loga `lakebase: permission denied for the service principal (…); identity unchanged`,
devolve o erro e pede uma rodada de grants (no máximo a cada 5 minutos). Num app
deployado essa rodada não faz nada, porque o SP não pode conceder privilégios a si mesmo.
A correção é `node scripts/migrate.mjs grants --role <SP>` como dono das tabelas (abaixo).

**Schema dedicado e menor privilégio (0002).** A migração `0002_schema_ai_prism` move as
20 tabelas do app e a `schema_migrations` do `public` para o schema `ai_prism`. As
sequências, os índices (inclusive o índice vetorial HNSW) e as linhas vão junto. O `down`
traz tudo de volta e apaga o schema vazio. O app conecta com
`search_path = ai_prism, public` (o `vector` continua no `public`). Bancos já deployados
têm donos misturados: o SP é dono da maioria das tabelas e a identidade do deploy é dona
de `app_admins`. Por isso o deploy passa as tabelas para um role neutro `NOLOGIN`, o
`ai_prism_owner`, em três etapas: `prepare` (o job de
auto-config e depois `migrate.mjs prepare` no `deploy.sh`/`deploy.ps1`, antes de publicar o
código), `0002` (a primeira requisição do SP) e `grants` (`migrate.mjs up --role` depois do
smoke, em qualquer saída com o hand-off aberto; os scripts só terminam com sucesso com o SP
fora do `ai_prism_owner`). Depois do `grants`, o SP tem `USAGE` em
`ai_prism`, DML nas tabelas do app, `USAGE/SELECT` nas sequências e `SELECT` em
`schema_migrations`. Não é dono de nenhuma tabela, não tem grant explícito no `public` e
não é membro do `ai_prism_owner`. Isso fecha a metade de privilégio da linha G2 do threat
model; a metade de isolamento (row-level security) é a W2-1. Sem o `prepare`, a `0002`
para antes de mudar qualquer coisa
(`migrations: 0002 schema_ai_prism deferred … ownership not normalized`): o app continua
no `public` e tenta de novo um minuto depois. Os roles e os comandos manuais estão em
[onboarding-deployment.md](onboarding-deployment.md#sobre-os-roles-e-grants-do-lakebase).

**Pela linha de comando.** `scripts/migrate.mjs` usa as variáveis padrão do Postgres
(`PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`, `PGSSLMODE`) e os mesmos
`PG_SSL_CA`/`PG_SSL_VERIFY` do app (`PG_SSL_REJECT_UNAUTHORIZED` é o nome antigo). No
Lakebase, use como `PGPASSWORD` uma credencial de banco do dono das tabelas
(`databricks postgres generate-database-credential <endpoint>`).
O token da CLI não é aceito. Todo comando imprime primeiro o alvo
(`target: <host>:<porta>/<banco> as <usuário>`): confira antes de seguir, sobretudo se o
`.env.local` aponta para o mesmo Lakebase do app.

```bash
# o que está aplicado, pendente ou alterado (sai com 1 se um arquivo aplicado mudou)
node scripts/migrate.mjs status

# upgrade: aplica as pendentes (o mesmo que o boot faz)
node scripts/migrate.mjs up

# rollback: desfaz, da mais nova para a mais antiga, toda versão acima de N
# (sem --yes ele só mostra o alvo e para)
node scripts/migrate.mjs down --to <N> --yes

# grants de menor privilégio do SP do app no ai_prism (idempotente; o deploy.sh roda como up --role)
node scripts/migrate.mjs grants --role <app SP client id>

# hand-off de dono antes de publicar código novo (o job de auto-config roda)
node scripts/migrate.mjs prepare --role <app SP client id>

# só revoga: o SP do app sai do role dono (a limpeza do deploy antes de publicar o código)
node scripts/migrate.mjs close --role <app SP client id>

# banco local de desenvolvimento
node --env-file=.env.local scripts/migrate.mjs status
```

`down --to 0` desfaz o `0001_baseline`, ou seja, **apaga todas as tabelas e os dados do
app**, e por fim remove a própria `schema_migrations`: o schema fica vazio. Use só em banco
de teste ou de CI. Em produção, o rollback de schema é de uma
migração específica, planejado ([§6.2](#62-rollback)).

**Arquivo alterado depois de aplicado.** O runner guarda o SHA-256 de cada `.up.sql`
aplicado (fim de linha CRLF e BOM não contam). Se o arquivo mudou, o boot e o `up` param
com `migrations: applied file changed … [MIGRATION_CHECKSUM]` e nada mais roda: dois
bancos com a mesma versão e schemas diferentes seriam piores que um app parado. Restaure
o arquivo da release e coloque a mudança numa migração nova.

**Mudança de schema (desenvolvedores).** Nunca edite um arquivo já lançado nem coloque DDL
em `server/db.ts`. Crie o próximo número (`NNNN_<nome>.up.sql` e `.down.sql`), com o
`down` testado: `server/migrate.test.ts` e `server/schemaAiPrism.test.ts` mostram os testes
de ida e volta em banco temporário, o segundo com donos de tabela misturados.
Consultas de uma feature nova ficam em `server/db/<feature>.js`, usando `withTx` de `server/db/pool.ts` (um teste de lint em `server/rls.test.js` rejeita `withClient(` fora desse arquivo).

**`0010_admin_usage_read` (tile de custo da busca na web).** Adiciona uma política SELECT em
`usage_ledger` (`aipa_admin_read`, presa à flag de admin e a uma identidade presente) e o índice
`idx_usage_ledger_kind_time (kind, created_at)`. O índice é um `CREATE INDEX` simples, não
`CONCURRENTLY` (a migração roda numa transação), então **bloqueia os inserts do razão enquanto é
construído**: segundos no volume atual. Se o razão for grande, faça o deploy numa janela tranquila. O
rollback é `node scripts/migrate.mjs down --to 0009`: remove a política e o índice e não toca nos dados.
Só `server/db/adminUsage.ts` lê o razão com a flag de admin, e devolve agregados.

### 6.5 Tokens e Lakebase

| Sintoma (log ou resposta) | Causa provável | Ação |
|---|---|---|
| HTTP 401 em `/api/*` | Token ausente ou expirado | Gerar token novo e repetir |
| HTTP 401 `{"code":"identity_mismatch"}` ou `{"code":"invalid_token"}` | O e-mail do proxy não é o dono do token, ou o workspace recusou o token (`server/identityBinding.ts`) | Se atinge usuários legítimos, defina `IDENTITY_BINDING=warn` no `env` do `app.yaml`, faça deploy e leia as linhas `identity-binding:` antes de voltar para `enforce` |
| HTTP 403 `{"code":"cross_site_request"}` | Escrita em `/api/*` vinda de outra origem (`server/csrfGuard.ts`) | Esperado para outro site. Se for o próprio app, conferir se `DATABRICKS_APP_URL` e o `Host` repassado pelo proxy batem com a URL aberta no navegador |
| HTTP 302 na raiz ou no smoke ("redirect de login") | O proxy não aceitou a credencial | Verificar o profile/token e o acesso ao app |
| `External authorization failed` ou SQLSTATE `28000` | Host do Lakebase errado para este workspace | Conferir os recursos e a injeção de `PG_ENDPOINT`/`PGHOST` (ver comentário em `app.yaml`). Não fixar host no `app.yaml` |
| `permission denied` no banco | GRANTs do SP ainda não aplicados, ou não reaplicados depois de uma migração | Rodar `node scripts/migrate.mjs grants --role <SP>` como dono das tabelas ([§6.4](#64-migrações-do-banco)); o `deploy.sh`/`deploy.ps1` faz isso depois do smoke |
| `OAuth token does not have required scopes: genie` | Escopo OBO faltando | Ajustar `user_api_scopes` no **bundle** (o `app.yaml` não é aplicado) e reconsentir |
| `python tool setup failed` | Warehouse indisponível, grant de `CREATE FUNCTION` ou escopo `sql` faltando | O chat segue sem a ferramenta Python; corrigir a causa |

### 6.6 Processo travado ou sem resposta

1. `databricks apps get ai-prism -p <PROFILE>` e confira o estado.
2. `databricks apps logs ai-prism -p <PROFILE>` e procure a última linha de
   `AI Prism listening on`.
3. Se o processo estiver de pé mas sem resposta, reinicie com `stop`/`start` (§6.3) e
   rode o smoke.
4. Se o problema voltar após o restart, o suspeito é o Lakebase. Confira o endpoint no
   console (estado e CU) antes de mexer no app.

### 6.7 Diagnosticar um turno lento

O turno tem várias partes com custos diferentes:

- **Antes do primeiro token:** gravação da mensagem do usuário, leitura do histórico
  (Lakebase), recuperação de histórico por embedding (gateway), chamada ao modelo.
  O evento `meta` sai logo depois da gravação do usuário. Se `meta` demora, o gargalo é
  o banco. Se `meta` sai rápido e o `token` demora, é o modelo ou uma ferramenta.
- **Durante a resposta:** tools. Cada tool gravada tem `duration_ms` em `chat_tool_calls`
  (consulta abaixo). Os eventos `tool_call` e `tool_progress` do SSE mostram o andamento.
- **Depois do último token:** o evento `done` só sai depois de embedding, indexação e
  título (`Promise.all` em `server/index.js`). Um `done` tardio com resposta completa
  quase sempre vem daí, não do modelo.

**Quais tools estão lentas.** Prefira os traces: com a exportação de telemetria ligada ([§3](#3-telemetria-opentelemetry)), cada span `tool.call` carrega seu `duration_ms`, e lê-los não exige acesso às linhas dos usuários (veja *Pelo trace* abaixo).

Para ler `ai_prism.chat_tool_calls` diretamente, saiba o que a row-level security faz com uma conexão de operador. A tabela tem row-level security forçada, e suas linhas pertencem a usuários (diretamente ou por um projeto). Uma conexão sem identidade de usuário, portanto, vê **0 linhas, sem erro**, mesmo como dono da tabela, porque o `FORCE` limita também o dono (migração 0003). Só um superusuário ou um papel com `BYPASSRLS` vê todas as linhas. No Lakebase, a identidade que faz o deploy, cuja credencial de banco o `migrate.mjs` usa ([§6.4](#64-migrações-do-banco)), tem `BYPASSRLS` ([performance.md §2.1](performance.md#21-preparação)). Ainda não existe um papel de diagnóstico somente leitura mais restrito.

1. Conecte-se como a identidade que faz o deploy, com as variáveis de conexão da [§6.4](#64-migrações-do-banco), e confirme que essa conexão ignora a row-level security:

   ```sql
   SELECT current_user, rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user;
   ```

   Se ambos forem `false`, pare. A consulta abaixo retornaria 0 linhas, e isso não significaria que não houve chamadas de tool. Em um banco local ou de CI, use o superusuário que o criou.
2. Rode a agregação em uma transação somente leitura. Selecione apenas estas colunas: `arguments` e `result` guardam conteúdo do usuário e não são necessárias para diagnosticar latência.

   ```sql
   BEGIN READ ONLY;
   SELECT tool_name, status, count(*) AS calls,
          percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) AS p95_ms,
          max(duration_ms) AS max_ms
   FROM ai_prism.chat_tool_calls
   WHERE created_at >= now() - interval '24 hours'
   GROUP BY tool_name, status
   ORDER BY p95_ms DESC NULLS LAST
   LIMIT 20;
   COMMIT;
   ```

Não obtenha as linhas de nenhum outro modo:

- nunca com as credenciais do service principal do app;
- nunca definindo as configurações de transação do app. `app.user_email` lê os dados de um usuário como esse usuário. `app.is_admin` não abre nenhuma linha por usuário. `app.maintenance` pertence à varredura de retenção e abre apenas chats pessoais expirados, não chamadas de tools;
- nunca com `ALTER TABLE … NO FORCE ROW LEVEL SECURITY`: ele pega um lock `ACCESS EXCLUSIVE` que segura toda requisição de chat até o commit.

Essa conexão ignora todas as políticas. Use-a apenas para esta consulta e para as checagens da [§6.10](#610-papéis-e-segurança-em-nível-de-linha-rls), e nunca para o tráfego da aplicação.

Para a latência do gateway de uma resposta específica, junte `system.serving.endpoint_usage`
com `system.ai_gateway.usage` por `databricks_request_id = request_id` (o mesmo join do
dashboard `ai-ops`). Há atraso de ingestão de alguns minutos.

**Pelo trace** (com a exportação de telemetria ligada, §3): pegue o `request_id` do evento SSE
`meta` ou do cabeçalho `x-request-id` da resposta, encontre em `otel_spans` o span `chat.turn`
com esse `request_id` e leia os filhos pelo `trace_id`. Cada `llm.call` é uma rodada do modelo
(ou um slide de deck, o título, o classificador de intenção), cada `tool.call` uma tool com seu
`duration_ms`; o intervalo entre eles é tempo no banco ou no servidor. Um `chat.turn` com
`status = 'cancelled'` foi parado pelo usuário ou por uma conexão que caiu: as chamadas ao
gateway e às tools foram canceladas e nada foi gravado.

### 6.8 Retenção, instruções da organização e trilha de auditoria de admin

Admins definem duas configurações da organização com `PUT /api/admin/settings` (gravadas em
`app_settings`, migração 0007):

- `retentionDays`: `0` = desligada (o padrão), ou de 1 a 3650. Uma conversa cuja **última
  atividade** é mais antiga que isso é apagada com tudo o que
  tem: mensagens, chamadas de ferramenta, embeddings, compactações, threads do Genie, decks,
  planilhas, documentos e imagens. As linhas de custo de `usage_ledger` ficam (o `session_id`
  vira `NULL`), então o dashboard de custos mantém o histórico. Os arquivos de imagem no UC
  Volume são apagados depois das linhas do banco.
  A última atividade é a mais recente entre: a atualização da própria conversa
  (`chat_sessions.updated_at`, que toda nova mensagem e todo salvamento no estúdio atualizam), a mensagem mais nova e a
  última edição dos decks, planilhas e documentos dela. Uma conversa com qualquer um desses
  dentro do período fica, inclusive as que têm `updated_at` desatualizado de antes desta
  versão.
- `orgInstructions`: até 8.000 caracteres, adicionadas a todo turno como uma mensagem de
  sistema. Um valor vazio remove a mensagem. As outras instâncias do app veem a mudança em
  até um minuto.

**A varredura** (`server/retention.ts`) verifica a cada hora, começando 5 minutos depois do
boot, e roda no máximo uma vez por dia somando todas as instâncias. Ela roda dentro de um
`pg_try_advisory_xact_lock`: se uma segunda instância tentar enquanto uma roda, ela pula e
registra `retention sweep: skipped (locked)`. Cada execução registra uma linha com as
contagens, por exemplo `retention sweep: done sessions=12 users=3 images=4 files_deleted=4
files_failed=0 retention_days=90`, e grava uma linha `retention.sweep` (ator `system`) na
trilha de auditoria. Uma conversa com turno em andamento nesta instância fica para a próxima
execução. `files_failed` conta arquivos de imagem que não puderam ser apagados. Eles ficam
órfãos no volume e não há nova tentativa. Uma execução apaga no máximo 100.000 conversas,
em comandos de 500. Um acúmulo maior registra `capped=true`, e as próximas execuções diárias
terminam o trabalho.

- **Desligar durante um incidente:** defina a variável de ambiente `RETENTION_SWEEP=off` no
  app e reinicie. A configuração continua gravada, então a varredura volta quando a variável
  sair.
- **Ver a última execução:** `GET /api/admin/settings` devolve `retentionLastSweepAt`, e
  `GET /api/admin/audit` lista as linhas `retention.sweep` com as contagens.
- **Reduza a retenção com cuidado:** passar de 365 para 30 dias apaga, na próxima execução,
  toda conversa parada há mais de 30 dias. Não há desfazer. O point-in-time restore do
  Lakebase é o único caminho de volta.

A varredura não tem identidade de usuário: a transação dela define `app.maintenance = 'on'`
(local à transação), e as políticas de row-level security da 0007 deixam que ela veja e
apague **só** conversas já expiradas, e leia os caminhos de imagem dessas conversas. Uma
transação com usuário (toda requisição) nunca tem esse acesso.

**Trilha de auditoria.** Toda mutação de admin grava uma linha em `admin_audit` na mesma
transação da mudança: admins, catálogo MCP, política de ferramentas, escopo de template,
edição e exclusão de templates e skills globais, endpoints de modelo (incluindo a carga
inicial) e as configurações acima. Uma linha tem `at`, `actor_hash`, `action`, `target` e
`details`. `actor_hash` é um hash do e-mail, nunca o e-mail. **Com `APP_AUDIT_HASH_KEY` definida**, é
`h2:` + 12 hex de um HMAC com esse segredo, e **não** é igual ao `user_hash` dos logs
(§2), de propósito: a tabela de auditoria não pode ser conferida contra uma lista de e-mails sem o segredo.
Sem a chave (e nas linhas gravadas antes de 2026-11-19), é o mesmo hash de 12 caracteres sem sal
de `user_hash`, e uma linha se junta às suas linhas de log por esse valor. Um alvo que é usuário é hasheado do mesmo jeito.
Para localizar uma pessoa conhecida nas duas fontes, ou para ligar uma linha a uma requisição, siga
[security-threat-model.md §6.1](security-threat-model.md#61-correlacionando-a-trilha-de-auditoria-com-os-logs).
Mantenha a mesma chave entre deploys: depois de trocar a chave, as linhas antigas deixam de casar com os novos hashes. A
ausência da chave registra um aviso no boot (`APP_AUDIT_HASH_KEY is not set`); como configurá-la está descrito em
`bundle/optional/audit-hash-key-secret.yml.example`. Para o papel do app a tabela só aceita inserção (nenhuma política de
update ou delete, e esses privilégios são revogados). `GET /api/admin/audit?limit=50&cursor=<nextCursor>`
pagina do mais novo para o mais antigo (no máximo 200 linhas por página). `migrate.mjs down`
abaixo da versão 7 apaga a tabela: exporte antes se precisar guardá-la.

### 6.9 Sondar quais modelos aceitam esforço de raciocínio

A flag `reasoning` de um modelo do catálogo (`server/llm.js`, `MODELS`) liga o controle **Esforço de
raciocínio** na lista de modelos. Ela só é definida com evidência: rode a sonda no workspace em que
você faz o deploy sempre que adicionar um modelo ou o gateway mudar.

```bash
node scripts/probe/reasoning-effort.mjs --profile <databricks-cli-profile> \
  [--models id1,id2] [--shape auto|openai|anthropic|anthropic-budget|gemini] \
  --out /path/outside/the/repo/reasoning-effort-probe.json
```

Para cada modelo de chat curado, ela envia cinco requisições pequenas e sem streaming (sem tools,
`max_tokens` 2048, uma pergunta curta que exige raciocínio): uma sem o parâmetro, uma para cada um
de `low`, `medium` e `high`, e uma com valor inválido como controle negativo. Grava uma linha por
requisição (`model`, `shape`, `level`, `accepted`, `status`, `usage`, `error` truncado) em `--out`
e imprime uma tabela. Chama só `serving-endpoints/chat/completions`; não cria, altera nem apaga
nada. O token vem de `databricks auth token` e nunca é impresso nem gravado. É uma ferramenta
manual e nunca roda na CI.

Defina a flag num modelo quando `low`, `medium` e `high` forem aceitos **e** o valor inválido for
rejeitado (o endpoint valida o campo, então a aceitação é real), e houver efeito visível no uso ou
documentado pelo provedor. `param` é o formato de corpo que foi aceito: `openai`
(`reasoning_effort`), `anthropic` (`thinking: adaptive` mais `output_config.effort`),
`anthropic-budget` (`thinking.enabled` com orçamento de tokens) ou `gemini` (`thinking_config`).

### 6.10 Papéis e segurança em nível de linha (RLS)

Um único papel Postgres atende todos os usuários (decisão D1): o service principal do app. Ele
não é dono de nenhuma tabela e não tem `BYPASSRLS`. Toda tabela do app no schema `ai_prism` tem
row-level security habilitada e forçada (migração 0003; `project_members` é a única exceção
documentada, veja
[security-threat-model.md TB9](security-threat-model.md#3-fronteiras-de-confiança)). A identidade
do usuário chega às políticas por transação: o `withTx` (`server/db/pool.ts`) define `app.user_email`,
`app.is_admin` e `app.user_groups` com `set_config(..., true)` (local à transação), então
uma query sem identidade não vê nenhuma linha. As tabelas pertencem ao papel `NOLOGIN`
`ai_prism_owner`; o deploy dá ao SP participação nele só durante a janela de hand-off (`prepare` … `up --role`).

Checagens de rotina (como dono das tabelas, com as variáveis de conexão da [§6.4](#64-migrações-do-banco)):

```bash
# versions applied, pending or changed
node scripts/migrate.mjs status

# re-apply the least-privilege grants (idempotent) after a migration or a permission denied
node scripts/migrate.mjs grants --role <app SP client id>
```

```sql
-- the app role must have rolbypassrls = false and rolsuper = false
SELECT rolname, rolbypassrls, rolsuper FROM pg_roles WHERE rolname = '<app SP client id>';

-- tables of the app schema WITHOUT forced row-level security (expected: project_members and schema_migrations)
SELECT c.relname
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'ai_prism' AND c.relkind = 'r' AND NOT (c.relrowsecurity AND c.relforcerowsecurity);

-- the SP must not be a member of the owner role once the deploy has finished
SELECT pg_has_role('<app SP client id>', 'ai_prism_owner', 'member');   -- expected: false
```

| Sintoma | Significado | Ação |
|---|---|---|
| Um usuário vê uma lista vazia que deveria ter linhas | A requisição rodou sem identidade (uma rota fora do `withTx`), ou o usuário não é o dono | Confira a linha de log daquele `request_id`; o teste de lint `server/rls.test.js` ("no withClient( call outside server/db/pool.ts") deveria ter pegado uma rota nova |
| `permission denied` para o SP | Grants não aplicados depois de uma migração | `migrate.mjs grants --role <SP>` como dono ([§6.5](#65-tokens-e-lakebase)) |
| 503 `service_unavailable` e a linha de log `lakebase: per-user fallback refused` | O service principal está indisponível e o papel do fallback por usuário é superusuário ou tem `BYPASSRLS` (a identidade que faz o deploy). O app falha fechado em vez de rodar fora das políticas (G15) | Restaure o service principal ([§6.5](#65-tokens-e-lakebase)). Não há configuração para desativar a checagem |
| A consulta `pg_has_role` retorna `true` | A janela de hand-off ainda está aberta (um deploy parou no meio) | `node scripts/migrate.mjs close --role <SP>` |

Nunca rode o tráfego da aplicação como `ai_prism_owner` ou como um papel com `BYPASSRLS`: as
políticas deixariam de valer. As migrações de dados que precisam ler as linhas de todos os usuários (`migrate.mjs
backfill-usage`) rodam só como dono, à mão.

### 6.11 Alertas para ações

| Alerta ([§5.2](#52-regras-de-alerta-propostas)) | Primeiro comando | Depois |
|---|---|---|
| A1 o smoke pós-deploy falha | A tabela de saída do `npm run smoke`; `databricks apps logs ai-prism -p <PROFILE>` | Faça rollback ([§6.2](#62-rollback)); não libere tráfego |
| A2 mais de 5% de respostas 5xx ou erros de login | `databricks apps logs ai-prism -p <PROFILE>` e filtre por `status` ≥ 500 (cada linha é JSON: `route`, `status`, `request_id`) | Tabela de token/Lakebase ([§6.5](#65-tokens-e-lakebase)); uma rota lenta: [§6.7](#67-diagnosticar-um-turno-lento) |
| A3 `lakebase: service-principal login unavailable` | `databricks apps get ai-prism -p <PROFILE>` e o estado do endpoint do Lakebase no console | [§6.5](#65-tokens-e-lakebase), depois [§6.6](#66-processo-travado-ou-sem-resposta) |
| A4 Lakebase em 16 CU por 15 min | Console do Lakebase (CPU, conexões) | Procure uma query lenta na [§6.7](#67-diagnosticar-um-turno-lento); só suba o teto depois de medir ([§7](#7-escala-e-limites-conhecidos)) |
| A5 custo diário acima de 2× a média de 7 dias | Dashboard `ai-costs`: usuário e endpoint | Se for um usuário: confira `GET /api/admin/audit` por uma mudança recente de modelo ou política, depois o volume do usuário; considere o orçamento por usuário ou grupo no AI Gateway (G4) |
| A6 volume de usuários acima do esperado | Dashboard `ai-ops`, aba por usuário | O mesmo da A5; o rate limit por processo (429) não é um teto de custo |
| Linha de retenção ausente | `GET /api/admin/settings` (`retentionLastSweepAt`) e a linha de log `retention sweep:` | [§6.8](#68-retenção-instruções-da-organização-e-trilha-de-auditoria-de-admin); `RETENTION_SWEEP=off` é a chave de desligamento |

### 6.12 Contexto do projeto no turno

Todo turno de uma conversa em um projeto leva as instruções do projeto (sempre por inteiro) e os arquivos
dele, até um orçamento de tokens (`server/projectContext.ts`, ADR 0013).

- `PROJECT_CONTEXT_FILES_MAX_TOKENS` (padrão `32000`, de `0` a `120000`): o orçamento de arquivos por turno.
  `0` desliga os arquivos e mantém as instruções. É a chave de desligamento dos arquivos e o botão do custo:
  os tokens são contados de forma conservadora (ASCII 0,5 token por caractere), e o custo aparece por turno
  em `usage_ledger` (`prompt_tokens`, `cache_read_tokens`); as rodadas de ferramenta dentro de um turno leem
  o texto do projeto do cache de prompt.
- Arquivos acima do orçamento são nomeados ao modelo e marcados por `GET /api/projects/:id/files`
  (`context: "excluded"`). Se isso ocorre em mais de cerca de 20% dos projetos ativos, é o sinal para
  construir recuperação sobre os arquivos.
- Uma leitura mais lenta que 1,5 s, ou que falha, é registrada como `project context: read failed` e o
  turno segue sem o projeto. A leitura também leva um limite de tempo no servidor logo abaixo desse valor,
  então o Postgres cancela a consulta lenta e a conexão volta ao pool. Uma sequência constante disso aponta
  para o banco.
- A migração `0009_project_context` adiciona `project_files.context_tokens` e `chat_messages.sent_by`
  (carimbado por um trigger a partir da identidade da transação). Exige o dono da tabela e não prende
  locks longos. `migrate.mjs down --to 8` remove as duas colunas, e a autoria gravada se perde.

### 6.13 Busca de sessões com candidatos HNSW (`SEARCH_VECTOR_ANN`)

A busca da barra lateral (`GET /api/search`, `searchSessionsByVector` em `server/db.ts`) ordena as sessões pela
melhor correspondência entre os vetores das suas mensagens. Por padrão é uma varredura exata dos vetores de quem
chama, sob a RLS, e cresce com o quanto a pessoa já escreveu (cerca de 0,5 s com 70.000 vetores).

- `SEARCH_VECTOR_ANN=on` (padrão desligado, lido uma vez na partida, qualquer outro valor é desligado) faz a
  busca partir do índice `idx_msg_emb_hnsw`: lê as `K = max(400, limit*20)` mensagens mais próximas entre as
  sessões de quem chama, agrupa por sessão e, quando poucas sessões enormes ocuparam todo o `K`, lê novas
  rodadas que pulam as sessões já achadas (no máximo 8). Ajusta `hnsw.ef_search` e `hnsw.iterative_scan` com
  `SET LOCAL`, então nada vaza para o pool. O escopo (sessões próprias, participação em projeto, sem chats
  temporários) e o formato do resultado são os mesmos da consulta exata.
- Nunca confia numa rodada curta: a varredura HNSW é aproximada e pode devolver menos linhas do que o pedido
  mesmo havendo linhas elegíveis. Quando as rodadas não conseguem mostrar que estão completas (qualquer rodada curta ou
  vazia, mesmo que tenha `limit` sessões, ou o teto de 8 rodadas atingido com menos de `limit` sessões acima do piso de similaridade), aquela
  chamada é respondida pela consulta exata, e uma linha de log em nível debug (sem dados de usuário) avisa.
  Quem tem poucos vetores acaba, na maioria das vezes, no caminho exato, que é barato para essas pessoas.
- Exige pgvector 0.8 ou mais novo (varredura iterativa). Com versão mais antiga o app registra uma vez
  `SEARCH_VECTOR_ANN=on needs pgvector 0.8 or newer` e mantém a consulta exata.
- Medido com 100.000 embeddings reais (75 perguntas fora do corpus, com um papel sem `BYPASSRLS`): para quem
  tem 70.000 vetores a consulta exata levou p50 483 ms e o caminho HNSW p50 51 ms, com sobreposição do top-20
  de sessões média 0,997 (p5 0,95, mínimo 0,95): cerca de 1 consulta em 19 troca uma sessão no fim da lista.
  Quem tem poucos vetores recebe um plano exato de qualquer forma. Rode `scripts/bench/q5-ann.mjs` num branch
  descartável com os seus dados antes de ligar.
- Desligado por padrão e sem migração: desligar de novo é remover a variável. O índice permanece.

---

## 7. Escala e limites conhecidos

- **Pool do service principal:** um pool compartilhado com `max: 8` conexões
  (`POOL_OPTS` e `getSpPool`, `server/db/pool.ts`). Com muitos usuários simultâneos, as
  consultas esperam por conexão. Meça antes de aumentar o teto. O teto está no código: não
  existe variável `PG_POOL_MAX` (`PG_POOL_IDLE_TIMEOUT_MS` é a única configuração do pool lida
  do ambiente). Na execução medida da [performance.md §3](performance.md#3-resultados-de-carga),
  50 usuários virtuais mantiveram as 8 conexões abertas com no máximo 2 ativas e latência de
  leitura estável: o pool não foi o gargalo.
- **Ociosidade:** conexões ociosas são fechadas após 2 min por padrão (`PG_POOL_IDLE_TIMEOUT_MS`, de 1 s a 30 min). O Lakebase suspende
  após 10 min sem uso por padrão (variável do bundle `lakebase_suspend_timeout`, `600s`).
- **Warehouse:** 2X-Small, `max_num_clusters: 1`, auto-stop de 10 min. Aumentar o
  máximo aumenta o custo da UDF e das UC Functions.
- **Limites de entrada:** os corpos JSON têm uma classe por rota: 1 MB por padrão, 4 MB para o
  salvamento de planilha, 40 MB para a importação de design system, 46 MiB para as escritas do
  estúdio de deck com mídia; os uploads do chat vão até 80 MB e 10 arquivos. O boot AppKit lê
  todo corpo JSON até 64 MB antes da checagem por rota (`JSON_ROUTE_LIMITS`, `APPKIT_BODY_LIMIT`
  em `server/middleware/security.ts`; a tabela está em
  [security-threat-model.md C11](security-threat-model.md#5-controles-presentes)).
- **Rate limits:** por usuário e por processo, 120 requisições `/api`/min e 12 turnos/min
  (`RATE_LIMIT_API_PER_MIN`, `RATE_LIMIT_TURNS_PER_MIN`; `0` desliga). Com várias instâncias
  do app o teto se multiplica, e ele não é um teto de gasto (G4).
- **Varredura de retenção:** no máximo 100.000 conversas por execução, em instruções de 500 ([§6.8](#68-retenção-instruções-da-organização-e-trilha-de-auditoria-de-admin)).
