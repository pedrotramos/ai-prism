<!-- i18n: source=docs/operations.md source-hash=55e9629fc23d8c6ec8a07a97060bfff1aaa2080c status=current -->
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

**Não existe endpoint `/health` hoje.** Para liveness, use:

| Sinal | Como | O que prova | O que não prova |
|---|---|---|---|
| SPA | `GET <APP_URL>/` sem redirect | Processo no ar e `client/dist` presente | Banco, gateway |
| Identidade | `GET <APP_URL>/api/me` autenticado | Processo, proxy e token aceitos | Banco: `/api/me` degrada para "não admin" quando o banco falha |
| Persistência | `npm run smoke` (passo "persistência") | Escrita e leitura no Lakebase | Latência real sob carga |

O smoke completo (`npm run smoke`, com `APP_URL` e `DATABRICKS_TOKEN`) é o teste de
saúde que importa depois de um deploy. Ele cria uma sessão de teste, faz um turno real,
lê as mensagens de volta, gera um documento e apaga a sessão. Veja
[§6.1](#61-deploy) para a ordem.

*Recomendação (fora deste repositório de docs):* uma rota `/api/health` que faça um
`SELECT 1` no Lakebase e responda 503 quando falhar. Isso exige mudar `server/index.js`.

---

## 2. Logs

```bash
# últimas linhas do app
databricks apps logs ai-prism -p <PROFILE>

# o comando também aceita --help para filtros; confira a versão da CLI instalada
databricks apps logs --help
```

Não há log estruturado. Tudo é `console.log/warn/error`. Mensagens que valem alerta
manual (texto exato, como aparece no log):

| Mensagem (início) | Significado | Ação |
|---|---|---|
| `AI Prism listening on :<porta>` | Processo subiu | Confirmar após cada deploy/restart |
| `identity-binding: could not verify the forwarded token, allowing the request (…)` | O workspace não respondeu ao `SCIM /Me` (timeout, 5xx, escopo); a requisição passou sem o vínculo e-mail ↔ token. No máximo 1 linha/min | Frequente: checar o workspace e o escopo `iam.current-user:read` do token OBO |
| `identity-binding: identity_mismatch: … (IDENTITY_BINDING=warn, allowed)` / `identity-binding: invalid_token: …` | Modo `warn`: a divergência foi registrada e a requisição passou | Diagnóstico do rollback; corrigir a causa e voltar para `enforce` ([SECURITY.md](SECURITY.md#vínculo-entre-e-mail-e-token-serveridentitybindingjs)) |
| `identity-binding: rejected a request: identity_mismatch` / `invalid_token` | Uma requisição chegou com e-mail que não é do dono do token, ou com token recusado pelo workspace, e recebeu 401 | Ver [§6.4](#64-tokens-e-lakebase); repetido sem explicação é sinal de tentativa de personificação |
| `unhandled error on <MÉTODO> <rota> -> <status>:` | Erro que nenhuma rota tratou (JSON malformado, upload grande, exceção); o cliente recebeu JSON genérico | Ler o detalhe na própria linha |
| `lakebase: service-principal login unavailable, using per-user identity:` | Login do SP falhou; o app usou a identidade do usuário | Ver [§6.4](#64-tokens-e-lakebase) |
| `ensureSpGrants: pulado para <e-mail> - …` | GRANTs ao SP ainda não aplicados | Ver [§6.4](#64-tokens-e-lakebase) |
| `lakebase SP pool: idle client error (dropped):` | Conexão ociosa caiu (normal após suspensão) | Só investigar se for frequente |
| `embedding update failed:` / `message embedding index failed:` / `title/session update failed:` | Pós-processamento do turno falhou (não impede a resposta) | Frequente indica problema no gateway de embedding |
| `transcrição falhou (…)` / `análise de planilha falhou (…)` / `ingestão de pptx falhou (…)` | Falha em anexo específico | Ver a mensagem para o motivo |
| `history retrieval failed:` | Recuperação do histórico (pgvector) falhou | Checar a extensão `vector` e o índice |
| `python tool setup failed, continuing without it:` | UDF Python indisponível (warehouse, grant ou escopo `sql`) | Ver [§6.4](#64-tokens-e-lakebase) |
| `limpeza de imagens da sessão falhou:` | Arquivo do Volume não foi apagado | Limpeza manual, se persistir |

*Consulta de exemplo:* para contar essas ocorrências, copie a saída de `apps logs` para
um arquivo local e use `grep -c` por mensagem. Não há agregação no servidor.

---

## 3. Telemetria OpenTelemetry

> **A PREENCHER.** Esta seção será escrita quando o AppKit (com telemetria OTEL) estiver
> disponível neste projeto. Até lá não há traces, métricas nem spans por turno; o que
> existe hoje é o log de §2 e o ledger de custos.
>
> Pontos a registrar nessa seção: endpoint e variáveis de exportação, nomes dos spans
> (`chat.turn`, chamada de LLM, tool call, query SQL), campos de cada span, retenção no
> destino, e como ligar um trace a um `request_id`.

---

## 4. O que monitorar

| Sinal | Fonte hoje | Limite de atenção | Ação |
|---|---|---|---|
| Disponibilidade (`/` e `/api/me` com 2xx) | Smoke e teste de carga | Qualquer falha em 5 min | Ver [§6.5](#65-processo-travado-ou-sem-resposta) |
| Erros 5xx no app | Logs (`apps logs`) | Ver SLO S1 | Diagnóstico de [§6.6](#66-diagnosticar-um-turno-lento) |
| Latência de API | Teste de carga (`npm run loadtest`) | Ver SLO S2 | Medir no mesmo ambiente |
| Turno de chat (TTFT e conclusão) | Smoke e teste de carga; SSE do cliente | Ver SLO S3 e S4 | [§6.6](#66-diagnosticar-um-turno-lento) |
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
| S5 | Primeira requisição após suspensão do Lakebase | ≤ 15 s | Por ocorrência | Logs e teste manual (o `connectionTimeoutMillis` do pool é 15 s, `server/db.js`) |
| S6 | Smoke pós-deploy | 100% verde antes de liberar o tráfego | Por deploy | `npm run smoke`; o mesmo script roda em todo PR na CI ([§5.3](#53-smoke-na-ci)) |

### 5.2 Regras de alerta propostas

| ID | Condição | Janela | Severidade | Ação |
|---|---|---|---|---|
| A1 | Smoke pós-deploy falha (S6) | Imediata | Crítica | Rollback ([§6.2](#62-rollback)) |
| A2 | Mais de 5% de respostas 5xx ou erro de login (302 ou 401) em `/api/*` | 10 min | Alta | Logs; token e Lakebase ([§6.4](#64-tokens-e-lakebase)) |
| A3 | Sequência de `lakebase: service-principal login unavailable` nos logs | 10 min | Alta | Ver [§6.4](#64-tokens-e-lakebase) |
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

Não há rollback de banco. O DDL é aditivo e idempotente, e não há migrações "down".
Logo, o rollback é de **código**:

1. Identifique o último commit bom (tag ou SHA) que tinha `client/dist` e `server-dist`
   consistentes.
2. Faça checkout desses artefatos em uma branch de hotfix (não reescreva `main`).
3. Repita o [§6.1](#61-deploy) a partir do passo 1.
4. Confirme com `npm run smoke`.

*Atenção:* dados gravados pela versão nova precisam continuar legíveis pela antiga. Em
mudança de schema, verifique antes de voltar a versão.

### 6.3 Parar e iniciar a App

```bash
databricks apps get ai-prism -p <PROFILE>
databricks apps stop ai-prism -p <PROFILE>
databricks apps start ai-prism -p <PROFILE>
```

Confira `databricks apps --help` na versão da CLI instalada.

### 6.4 Tokens e Lakebase

| Sintoma (log ou resposta) | Causa provável | Ação |
|---|---|---|
| HTTP 401 em `/api/*` | Token ausente ou expirado | Gerar token novo e repetir |
| HTTP 401 `{"code":"identity_mismatch"}` ou `{"code":"invalid_token"}` | O e-mail do proxy não é o dono do token, ou o workspace recusou o token (`server/identityBinding.js`) | Se atinge usuários legítimos, defina `IDENTITY_BINDING=warn` no `env` do `app.yaml`, faça deploy e leia as linhas `identity-binding:` antes de voltar para `enforce` |
| HTTP 403 `{"code":"cross_site_request"}` | Escrita em `/api/*` vinda de outra origem (`server/csrfGuard.js`) | Esperado para outro site. Se for o próprio app, conferir se `DATABRICKS_APP_URL` e o `Host` repassado pelo proxy batem com a URL aberta no navegador |
| HTTP 302 na raiz ou no smoke ("redirect de login") | O proxy não aceitou a credencial | Verificar o profile/token e o acesso ao app |
| `External authorization failed` ou SQLSTATE `28000` | Host do Lakebase errado para este workspace | Conferir os recursos e a injeção de `PG_ENDPOINT`/`PGHOST` (ver comentário em `app.yaml`). Não fixar host no `app.yaml` |
| `permission denied` no banco | GRANTs do SP ainda não aplicados | Quem é dono (o primeiro admin) deve abrir o app; `ensureSpGrants` tenta de novo a cada 5 min |
| `OAuth token does not have required scopes: genie` | Escopo OBO faltando | Ajustar `user_api_scopes` no **bundle** (o `app.yaml` não é aplicado) e reconsentir |
| `python tool setup failed` | Warehouse indisponível, grant de `CREATE FUNCTION` ou escopo `sql` faltando | O chat segue sem a ferramenta Python; corrigir a causa |

### 6.5 Processo travado ou sem resposta

1. `databricks apps get ai-prism -p <PROFILE>` e confira o estado.
2. `databricks apps logs ai-prism -p <PROFILE>` e procure a última linha de
   `AI Prism listening on`.
3. Se o processo estiver de pé mas sem resposta, reinicie com `stop`/`start` (§6.3) e
   rode o smoke.
4. Se o problema voltar após o restart, o suspeito é o Lakebase. Confira o endpoint no
   console (estado e CU) antes de mexer no app.

### 6.6 Diagnosticar um turno lento

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

---

## 7. Escala e limites conhecidos

- **Pool do service principal:** um pool compartilhado com `max: 8` conexões
  (`POOL_OPTS` e `getSpPool`, `server/db.js`). Com muitos usuários simultâneos, as
  consultas esperam por conexão. Meça antes de aumentar o teto.
- **Ociosidade:** conexões ociosas são fechadas após 5 min (`idleTimeoutMillis`). O
  Lakebase suspende após 30 min sem uso (`suspend_timeout_duration: 1800s`).
- **Warehouse:** 2X-Small, `max_num_clusters: 1`, auto-stop de 10 min. Aumentar o
  máximo aumenta o custo da UDF e das UC Functions.
- **Limites de entrada:** JSON 40 MB, upload 80 MB, 10 arquivos.
