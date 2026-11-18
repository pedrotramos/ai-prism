<!-- i18n: source=docs/operations.md source-hash=69aa813ccf9e83dbdcbaa8b53671f14ef7180a8a status=current -->
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
`server/log.test.js`). Uma mensagem tem no máximo 1000 caracteres.

Mensagens que valem alerta manual (o início de `msg`, texto exato):

| Mensagem (início) | Significado | Ação |
|---|---|---|
| `AI Prism listening on :<porta>` | Processo subiu | Confirmar após cada deploy/restart |
| `identity-binding: could not verify the forwarded token, allowing the request (…)` | O workspace não respondeu ao `SCIM /Me` (timeout, 5xx, escopo); a requisição passou sem o vínculo e-mail ↔ token. No máximo 1 linha/min | Frequente: checar o workspace e o escopo `iam.current-user:read` do token OBO |
| `identity-binding: identity_mismatch: … (IDENTITY_BINDING=warn, allowed)` / `identity-binding: invalid_token: …` | Modo `warn`: a divergência foi registrada e a requisição passou | Diagnóstico do rollback; corrigir a causa e voltar para `enforce` ([SECURITY.md](SECURITY.md#vínculo-entre-e-mail-e-token-serveridentitybindingjs)) |
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

Cada rodada de chat, título, classificação de intenção, embedding e geração de imagem gera um
`llm.call`; cada invocação de tool gera um `tool.call`. Os atributos nunca levam texto de
prompt, argumentos de tool, e-mails ou SQL. Cada rota de turno gera um `chat.turn`, pai de
todo `llm.call` e `tool.call` daquele turno, então um trace é um turno.

**Exportação.** Os spans só são exportados quando `OTEL_EXPORTER_OTLP_ENDPOINT` está definida:
aí o AppKit registra o exporter OTLP. Sem ela, e sempre com `APPKIT_BOOT=0`, os spans não fazem
nada: nada é exportado e nada falha. O Databricks Apps define a variável quando a telemetria do
app é habilitada (Beta, só nas regiões suportadas; as tabelas têm de ser Delta gerenciadas na
região do workspace):

```bash
# enviar logs, métricas e spans para tabelas do Unity Catalog; depois, redeploy do app (§6.1)
databricks apps update ai-prism -p <PROFILE> --json '{"telemetry_export_destinations":[{"unity_catalog":{"logs_table":"<catalog>.<schema>.otel_logs","metrics_table":"<catalog>.<schema>.otel_metrics","traces_table":"<catalog>.<schema>.otel_spans"}}]}'
```

Ainda não verificado num workspace real: o runtime anuncia `OTEL_EXPORTER_OTLP_PROTOCOL=grpc`,
enquanto o exporter do AppKit fala OTLP sobre HTTP/protobuf. Se `otel_spans` continuar vazia
depois de um turno, confira isso primeiro. Onde a região não é suportada,
`OTEL_EXPORTER_OTLP_ENDPOINT` pode apontar para um coletor seu.

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
| Disponibilidade (`/` e `/api/me` com 2xx) | Smoke e teste de carga | Qualquer falha em 5 min | Ver [§6.6](#66-processo-travado-ou-sem-resposta) |
| Erros 5xx no app | Logs (`apps logs`) | Ver SLO S1 | Diagnóstico de [§6.7](#67-diagnosticar-um-turno-lento) |
| Latência de API | Teste de carga (`npm run loadtest`) | Ver SLO S2 | Medir no mesmo ambiente |
| Turno de chat (TTFT e conclusão) | Smoke e teste de carga; SSE do cliente | Ver SLO S3 e S4 | [§6.7](#67-diagnosticar-um-turno-lento) |
| Custo por dia e por modelo | Dashboard de custos (`ai-costs`) | Limite definido pelo operador (ver alerta A5) | Revisar usuário e endpoint |
| Volume, usuários ativos e tokens | Dashboard de operação (`ai-ops`) | Sem limite fixo | Acompanhar tendência |
| Latência do gateway | `system.ai_gateway.usage` (dashboard `ai-ops`) | Ver SLO S3 | Com atraso de ingestão |
| CPU, memória e conexões do Lakebase | Console do Lakebase | Ver alerta A4 | Dimensionar CU |
| Consumo do SQL Warehouse | Console do warehouse | Auto-stop de 10 min | Confirmar que desliga |

**Limitação:** não há métrica de erro por rota nem percentil de latência do servidor.
Esses números hoje saem apenas do teste de carga, que mede do lado do cliente.

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
| S4 | Turno concluído sem evento `error` | ≥ 98% | 7 dias | **Não medido automaticamente**; medir por `loadtest --chat` |
| S5 | Primeira requisição após suspensão do Lakebase | ≤ 15 s | Por ocorrência | Logs e teste manual (o `connectionTimeoutMillis` do pool é 15 s, `server/db/pool.js`) |
| S6 | Smoke pós-deploy | 100% verde antes de liberar o tráfego | Por deploy | `npm run smoke`; o mesmo script roda em todo PR na CI ([§5.3](#53-smoke-na-ci)) |

### 5.2 Regras de alerta propostas

| ID | Condição | Janela | Severidade | Ação |
|---|---|---|---|---|
| A1 | Smoke pós-deploy falha (S6) | Imediata | Crítica | Rollback ([§6.2](#62-rollback)) |
| A2 | Mais de 5% de respostas 5xx ou erro de login (302 ou 401) em `/api/*` | 10 min | Alta | Logs; token e Lakebase ([§6.5](#65-tokens-e-lakebase)) |
| A3 | Sequência de `lakebase: service-principal login unavailable` nos logs | 10 min | Alta | Ver [§6.5](#65-tokens-e-lakebase) |
| A4 | Lakebase no teto de 16 CU por mais de 15 min | 15 min | Média | Revisar carga; avaliar teto maior |
| A5 | Custo diário (`usd` em `ai-costs`) acima de 2× a média móvel de 7 dias | Diário | Média | Revisar usuário e endpoint no dashboard |
| A6 | Usuário com volume de chamadas acima do esperado (dashboard `ai-ops`, aba por usuário) | Diário | Média | Conferir o caso; pode ser abuso (G4) |

**Como executar hoje:** A1 é do script de deploy (o smoke falha = deploy falha). A5 e A6
são consultas de alerta no Databricks SQL sobre os datasets dos dashboards. A2 e A3
dependem de leitura manual dos logs; **não há alerta automatizado sobre o log** até a
telemetria estar pronta ([§3](#3-telemetria-opentelemetry)).

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

---

## 6. Runbook

### 6.1 Deploy

Pré-requisito: artefatos regenerados com `npm run bundle` logo antes do deploy. Os
PRs de feature não commitam `client/dist` nem `server-dist`, que são refeitos e commitados
nos PRs de release (branch `release/*` ou label `release`); só nesses a CI confere se
estão em dia. O `deploy.sh` ainda não roda o build sozinho.

<!-- i18n: code-translated -->
```bash
# valida a configuração (não cria nada)
databricks bundle validate -p <PROFILE> -t dev

# 1) Lakebase, warehouse, app, dashboards e job
databricks bundle deploy -p <PROFILE> -t dev

# 2) publica o CÓDIGO da App. O bundle deploy NÃO republica o processo em execução.
#    <SRC> é impresso pelo bundle deploy (tipicamente .../.bundle/ai-prism/dev/files)
databricks apps deploy ai-prism --source-code-path <SRC> -p <PROFILE>

# 3) roda o auto-config (role PG do SP, UDF Python, Volume de imagens, admin bootstrap)
databricks bundle run ai_prism_auto_config -p <PROFILE> -t dev

# 4) smoke (S6): bloqueia a liberação se falhar
APP_URL=<URL-do-app> DATABRICKS_TOKEN=<token-oauth> npm run smoke
```

Para `DATABRICKS_TOKEN`, use o token OAuth do usuário (`databricks auth token -p <PROFILE>`).
Não cole o token em logs nem em issues.

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

### 6.3 Parar e iniciar a App

```bash
databricks apps get ai-prism -p <PROFILE>
databricks apps stop ai-prism -p <PROFILE>
databricks apps start ai-prism -p <PROFILE>
```

Confira `databricks apps --help` na versão da CLI instalada.

### 6.4 Migrações do banco

O schema do Lakebase é versionado em arquivos SQL:

<!-- i18n: code-translated -->
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
em `server/db.js`. Crie o próximo número (`NNNN_<nome>.up.sql` e `.down.sql`), com o
`down` testado: `server/migrate.test.js` e `server/schemaAiPrism.test.js` mostram os testes
de ida e volta em banco temporário, o segundo com donos de tabela misturados.
Consultas de uma feature nova ficam em `server/db/<feature>.js`, usando `withClient` ou
`withTx` (transação) de `server/db/pool.js`.

### 6.5 Tokens e Lakebase

| Sintoma (log ou resposta) | Causa provável | Ação |
|---|---|---|
| HTTP 401 em `/api/*` | Token ausente ou expirado | Gerar token novo e repetir |
| HTTP 401 `{"code":"identity_mismatch"}` ou `{"code":"invalid_token"}` | O e-mail do proxy não é o dono do token, ou o workspace recusou o token (`server/identityBinding.js`) | Se atinge usuários legítimos, defina `IDENTITY_BINDING=warn` no `env` do `app.yaml`, faça deploy e leia as linhas `identity-binding:` antes de voltar para `enforce` |
| HTTP 403 `{"code":"cross_site_request"}` | Escrita em `/api/*` vinda de outra origem (`server/csrfGuard.js`) | Esperado para outro site. Se for o próprio app, conferir se `DATABRICKS_APP_URL` e o `Host` repassado pelo proxy batem com a URL aberta no navegador |
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

Consulta para achar as tools mais lentas (rodar no Lakebase, com o usuário de
diagnóstico, nunca com credenciais do app no repositório):

```sql
SELECT tool_name, status, duration_ms, created_at
FROM chat_tool_calls
WHERE created_at >= now() - interval '24 hours'
ORDER BY duration_ms DESC NULLS LAST
LIMIT 20;
```

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
  atividade** (`chat_sessions.updated_at`) é mais antiga que isso é apagada com tudo o que
  tem: mensagens, chamadas de ferramenta, embeddings, compactações, threads do Genie, decks,
  planilhas, documentos e imagens. As linhas de custo de `usage_ledger` ficam (o `session_id`
  vira `NULL`), então o dashboard de custos mantém o histórico. Os arquivos de imagem no UC
  Volume são apagados depois das linhas do banco.
- `orgInstructions`: até 8.000 caracteres, adicionadas a todo turno como uma mensagem de
  sistema. Um valor vazio remove a mensagem. As outras instâncias do app veem a mudança em
  até um minuto.

**A varredura** (`server/retention.js`) verifica a cada hora, começando 5 minutos depois do
boot, e roda no máximo uma vez por dia somando todas as instâncias. Ela roda dentro de um
`pg_try_advisory_xact_lock`: se uma segunda instância tentar enquanto uma roda, ela pula e
registra `retention sweep: skipped (locked)`. Cada execução registra uma linha com as
contagens, por exemplo `retention sweep: done sessions=12 users=3 images=4 files_deleted=4
files_failed=0 retention_days=90`, e grava uma linha `retention.sweep` (ator `system`) na
trilha de auditoria. Uma conversa com turno em andamento nesta instância fica para a próxima
execução. `files_failed` conta arquivos de imagem que não puderam ser apagados. Eles ficam
órfãos no volume e não há nova tentativa.

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
`details`. `actor_hash` é o mesmo hash de 12 caracteres de `user_hash` nos logs (§2), nunca o
e-mail, então dá para ligar a linha à linha de log da requisição. Um alvo que é usuário é
hasheado do mesmo jeito. Para o papel do app a tabela só aceita inserção (nenhuma política de
update ou delete, e esses privilégios são revogados). `GET /api/admin/audit?limit=50&cursor=<nextCursor>`
pagina do mais novo para o mais antigo (no máximo 200 linhas por página). `migrate.mjs down`
abaixo da versão 7 apaga a tabela: exporte antes se precisar guardá-la.

---

## 7. Escala e limites conhecidos

- **Pool do service principal:** um pool compartilhado com `max: 8` conexões
  (`POOL_OPTS` e `getSpPool`, `server/db/pool.js`). Com muitos usuários simultâneos, as
  consultas esperam por conexão. Meça antes de aumentar o teto.
- **Ociosidade:** conexões ociosas são fechadas após 5 min (`idleTimeoutMillis`). O
  Lakebase suspende após 30 min sem uso (`suspend_timeout_duration: 1800s`).
- **Warehouse:** 2X-Small, `max_num_clusters: 1`, auto-stop de 10 min. Aumentar o
  máximo aumenta o custo da UDF e das UC Functions.
- **Limites de entrada:** JSON 40 MB, upload 80 MB, 10 arquivos.
