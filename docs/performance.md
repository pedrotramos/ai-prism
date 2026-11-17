# Performance: método de carga e análise de consultas

Este documento define como medir o AI Prism sob carga e como analisar as consultas
críticas do Lakebase com `EXPLAIN (ANALYZE, BUFFERS)`. As tabelas de resultados estão
**vazias de propósito**: devem ser preenchidas com medições reais, no ambiente de teste
da instalação, e nunca copiadas de outro ambiente.

Ferramentas do repositório:

- `npm run smoke`: verificação funcional, um usuário, um turno (ver [operations.md](operations.md)).
- `npm run loadtest`: gerador de carga sem dependências (`scripts/load-test.mjs`).
- `EXPLAIN` das consultas da §4, rodado direto no Lakebase.

---

## 1. Objetivo e critérios

Responder três perguntas, na ordem:

1. Em quantos usuários simultâneos a latência das leituras e do primeiro token passa
   dos alvos de SLO (ver [operations.md §5](pt-BR/operations.md#51-slos-propostos))?
2. Qual é o gargalo ao crescer: o pool do banco, o gateway de modelo, o warehouse ou a
   CPU do app?
3. Quais consultas dominam o tempo de banco, e o plano delas muda com o volume de dados?

Cenários padrão: **1, 5, 20 e 50 usuários virtuais**, com duração por estágio de pelo
menos 60 s para que a fila se estabilize. Esses são os valores de referência do
`loadtest`.

---

## 2. Método

### 2.1 Preparação

1. **Ambiente de teste dedicado.** Use uma instalação de teste no mesmo workspace e na
   mesma região do usuário. Medir de um notebook longe da região mede a rede, não o app.
2. **Estado do Lakebase declarado.** Registre se o teste começou com o endpoint
   suspenso (cold) ou ativo (warm). O primeiro request após suspensão paga o cold start.
3. **Dados de volume declarados.** Registre quantas sessões, mensagens e embeddings o
   usuário de teste tem antes do teste. Sem isso, os planos não são comparáveis.
4. **Smoke antes de carga.** `npm run smoke` precisa passar. Carga sobre um app quebrado
   só mede erro.

Massa de dados para um usuário de teste (rodar **só** numa instalação de teste; o
e-mail é fictício e a limpeza é obrigatória ao final):

```sql
-- 200 sessões × 40 mensagens para carga-teste@example.com
INSERT INTO chat_sessions (user_email, title, model)
SELECT 'carga-teste@example.com', 'carga ' || g, 'databricks-claude-opus-5'
FROM generate_series(1, 200) g;

INSERT INTO chat_messages (session_id, role, content, created_at)
SELECT s.id,
       CASE WHEN m % 2 = 0 THEN 'user' ELSE 'assistant' END,
       'mensagem de carga ' || m,
       now() - (m || ' minutes')::interval
FROM chat_sessions s
CROSS JOIN generate_series(1, 40) m
WHERE s.user_email = 'carga-teste@example.com';

-- embeddings de teste (vetores aleatórios de 1024 dimensões; só para Q4 e Q5, que
-- exigem a variante pgvector de chat_message_embeddings)
INSERT INTO chat_message_embeddings (message_id, session_id, embedding)
SELECT m.id, m.session_id,
       (SELECT ('[' || string_agg(round(random()::numeric, 4)::text, ',') || ']')::vector
          FROM generate_series(1, 1024))
FROM chat_messages m
JOIN chat_sessions s ON s.id = m.session_id
WHERE s.user_email = 'carga-teste@example.com';

-- limpeza ao final do teste (cascata remove mensagens, embeddings e tool calls)
DELETE FROM chat_sessions WHERE user_email = 'carga-teste@example.com';
```

### 2.2 Execução

```bash
# leituras baratas, 1/5/20/50 usuários, 60 s por estágio, think time de 1 s
APP_URL=<URL-do-app> DATABRICKS_TOKEN=<token-oauth> \
  npm run loadtest -- --stages 1,5,20,50 --duration 60 --think 1000 > resultados-leitura.md

# com turnos de chat (CUSTA TOKENS): um turno a cada 10 iterações por usuário
APP_URL=<URL-do-app> DATABRICKS_TOKEN=<token-oauth> \
  npm run loadtest -- --chat --chat-every 10 --stages 1,5,20 --duration 120 --think 3000 > resultados-chat.md
```

O `loadtest` não roda em CI: se a variável `CI` estiver definida, ele se recusa a
rodar. Os turnos de chat são apagados ao final de cada um, mas geram custo real no
gateway e entram no `usage_ledger`. Combine o horário e o modelo antes.

Use o mesmo `--think` e a mesma duração entre execuções que serão comparadas.

### 2.3 Durante o teste

Registre, por estágio, o que não aparece no `loadtest`:

- Estado do Lakebase no console: CU consumido e conexões, se disponíveis.
- Estado do warehouse (se a carga passar por UC Functions ou UDF Python).
- Erros nos logs do app: `databricks apps logs ai-prism -p <PROFILE>` (ver
  [operations.md §2](pt-BR/operations.md#2-logs)).

### 2.4 Interpretação

- **Joelho da curva.** O ponto em que a latência p95 cresce mais rápido que o número de
  usuários. Antes dele, o sistema escala; depois, há fila.
- **Fila no pool.** O pool do service principal tem `max: 8` conexões (`POOL_OPTS` e
  `getSpPool`, `server/db.js`). Se o p95 de leituras de banco sobe linearmente com os
  usuários enquanto o CU do Lakebase está ocioso, o gargalo é o pool, não o banco.
- **Erro sem latência alta** indica falha de auth ou de rota. Leia a tabela de erros
  mais frequentes antes de concluir qualquer coisa.
- **Taxa de erro não é o único critério.** Um estágio com 0% de erro e p95 acima do SLO
  continua reprovado.

---

## 3. Resultados de carga

> **A PREENCHER com medições reais.** Uma linha por estágio. Inclua o SHA do commit
> testado, a região, o estado inicial do Lakebase e o volume de dados (§2.1).

**Ambiente:** instalação ______ · commit ______ · região ______ · Lakebase ______ (cold/warm) · dados ______

### 3.1 Leituras (`/api/me`, `/api/models`, `/api/sessions`)

| Usuários | Requisições | Erros | Taxa de erro | Throughput (req/s) | p50 (ms) | p95 (ms) | p99 (ms) |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | | | | | | | |
| 5 | | | | | | | |
| 20 | | | | | | | |
| 50 | | | | | | | |

### 3.2 Turnos de chat (com `--chat`)

| Usuários | Turnos | Erros | Taxa de erro | p50 turno (ms) | p95 turno (ms) | p99 turno (ms) |
|---:|---:|---:|---:|---:|---:|---:|
| 1 | | | | | | |
| 5 | | | | | | |
| 20 | | | | | | |
| 50 | | | | | | |

### 3.3 Recursos durante o teste

| Usuários | CU máx. do Lakebase | Conexões ativas (máx.) | Warehouse (estado) | Observações |
|---:|---:|---:|---|---|
| 1 | | | | |
| 5 | | | | |
| 20 | | | | |
| 50 | | | | |

---

## 4. Consultas críticas

Consultas tiradas de `server/db.js` e do `server/usage.js` (ou `server/index.js`, quando
indicado). Os parâmetros `$1`, `$2`… foram trocados por variáveis do `psql`. Rode com
`psql` conectado ao banco da instalação de teste, com um usuário de diagnóstico, nunca
com credenciais do app no repositório.

| ID | Consulta | Chamada por | Frequência esperada |
|---|---|---|---|
| Q1 | Lista de sessões (`listSessions`) | `GET /api/sessions` | Abertura da barra lateral |
| Q2 | Mensagens da sessão (`fetchActiveMessages`) | `GET /api/sessions/:id/messages`, a cada turno | Abertura de conversa e turno |
| Q3 | Mensagens tool da sessão (`listMessages`, `chat_tool_calls`) | Junto com Q2 | Idem |
| Q4 | Recuperação de histórico por embedding (`retrieveRelevantMessages`) | Cada turno, com `HISTORY_RETRIEVAL` ativo | Cada turno |
| Q5 | Busca semântica entre sessões (`searchSessionsByVector`) | `GET /api/search` | Digitação na busca |
| Q6 | Uso do mês (`usageTotals`, mês) | `GET /api/usage/summary` | Início da sessão, troca de conversa e fim de cada turno (o medidor não faz polling) |
| Q7 | Uso da sessão (`usageTotals`, por tipo) | Idem, com `sessionId` | Idem |

Os nomes das colunas e dos índices abaixo vêm do DDL de `server/db.js`:
`idx_chat_sessions_user (user_email, updated_at DESC)`, `idx_chat_messages_session
(session_id, id)`, `idx_chat_tool_calls_message (message_id, seq)`,
`idx_msg_emb_session (session_id)`, `idx_msg_emb_hnsw` (HNSW, `vector_cosine_ops`),
`idx_usage_ledger_user_time (user_email, created_at)` e `idx_usage_ledger_session (session_id)`.

### 4.1 Q1: lista de sessões

```sql
\set uemail 'carga-teste@example.com'

EXPLAIN (ANALYZE, BUFFERS)
SELECT s.id, s.title, s.model, s.system_prompt, s.enabled_tools, s.created_at, s.updated_at,
       COALESCE(att.names, ARRAY[]::text[]) AS attachment_names
FROM chat_sessions s
LEFT JOIN LATERAL (
  SELECT array_agg(DISTINCT elem) AS names
  FROM chat_messages m
  CROSS JOIN LATERAL jsonb_array_elements_text(m.attachments::jsonb) AS elem
  WHERE m.session_id = s.id AND m.attachments IS NOT NULL
) att ON true
WHERE s.user_email = :'uemail'
ORDER BY s.updated_at DESC
LIMIT 100;
```

**Ponto de atenção:** o `LATERAL` lê as mensagens de cada sessão para extrair nomes de
anexo. Com muitas mensagens por sessão, o custo cresce com o total de mensagens do
usuário, não só com o número de sessões. Compare o plano com 200 e com 2.000 sessões.

### 4.2 Q2: mensagens da sessão

```sql
\set uemail 'carga-teste@example.com'
\set sid 1

EXPLAIN (ANALYZE, BUFFERS)
SELECT m.id, m.role, m.content, m.attachments, m.model, m.prompt_tokens, m.completion_tokens,
       m.blocks, m.variant_group, m.active, m.created_at, m.media_processing, m.intent_classify, m.reasoning
FROM chat_messages m
JOIN chat_sessions s ON s.id = m.session_id AND s.user_email = :'uemail'
WHERE m.session_id = :sid
ORDER BY m.id ASC;
```

Q3, as tools da mesma leitura (`fetchActiveMessages` faz essa segunda consulta):

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT message_id, call_id, tool_name, tool_label, arguments, result, status, duration_ms
FROM chat_tool_calls
WHERE message_id = ANY(ARRAY(
  SELECT m.id FROM chat_messages m WHERE m.session_id = :sid
))
ORDER BY message_id, seq ASC;
```

*Nota:* a Q3 real recebe a lista de ids já lida pela Q2 (`WHERE message_id = ANY($1)`).
A forma acima é equivalente para o plano e não depende de estado da aplicação.

### 4.3 Q4: recuperação de histórico por embedding

Requer o tipo `vector` (instalações com a variante `double precision[]`, sem pgvector,
não executam esta consulta). O vetor de consulta é um vetor de teste de 1024 dimensões.

```sql
\set uemail 'carga-teste@example.com'
\set sid 1

EXPLAIN (ANALYZE, BUFFERS)
WITH qv AS (
  SELECT ('[' || string_agg('0.01', ',') || ']')::vector AS v
  FROM generate_series(1, 1024)
)
SELECT m.id, m.role, m.content,
       1 - (e.embedding <=> qv.v) AS similarity
FROM qv,
     chat_message_embeddings e
JOIN chat_messages m ON m.id = e.message_id
JOIN chat_sessions s ON s.id = m.session_id AND s.user_email = :'uemail'
WHERE e.session_id = :sid AND m.active = true
ORDER BY similarity DESC
LIMIT 6;
```

**Ponto de atenção:** o `WHERE e.session_id = …` restringe a uma sessão, então o plano
provavelmente usa `idx_msg_emb_session` e calcula a distância por linha da sessão. O
índice HNSW só ajuda quando a ordenação é direta pela distância sobre a tabela inteira.
A consulta real faz `ROW_NUMBER` e um filtro extra (`recency_rank > $4`); compare com a
forma acima antes de concluir.

### 4.4 Q5: busca semântica entre sessões

Esta consulta é a candidata a gargalo mais forte. Ela agrega por sessão com `MAX` e filtra
com `HAVING`, o que impede o uso direto do índice HNSW.

```sql
\set uemail 'carga-teste@example.com'

EXPLAIN (ANALYZE, BUFFERS)
WITH qv AS (
  SELECT ('[' || string_agg('0.01', ',') || ']')::vector AS v
  FROM generate_series(1, 1024)
)
SELECT s.id, s.title, MAX(1 - (e.embedding <=> qv.v)) AS score
FROM qv,
     chat_message_embeddings e
JOIN chat_sessions s ON s.id = e.session_id AND s.user_email = :'uemail'
GROUP BY s.id, s.title
HAVING MAX(1 - (e.embedding <=> qv.v)) >= 0.3
ORDER BY score DESC
LIMIT 20;
```

**Hipótese a confirmar:** o plano lê os embeddings de **todas** as sessões do banco (e
não só as do usuário) antes de cruzar com `chat_sessions`, porque o filtro por dono está
no `JOIN`, e o `GROUP BY`/`HAVING` impede o HNSW. Se confirmado, o custo cresce com o
total de embeddings da instalação, não com o do usuário. Compare o número de linhas
lidas (`rows` no plano) com e sem dados de outro usuário.

### 4.5 Q6 e Q7: uso (medidor)

```sql
\set uemail 'carga-teste@example.com'
\set sid 1

-- Q6: total do mês
EXPLAIN (ANALYZE, BUFFERS)
SELECT COALESCE(SUM(cost_usd), 0)::float8 AS usd,
       COALESCE(BOOL_OR(estimated), false) AS estimated,
       COALESCE(BOOL_OR(cost_usd IS NULL), false) AS unpriced
FROM usage_ledger
WHERE user_email = :'uemail' AND created_at >= date_trunc('month', now());

-- Q7: por tipo, na sessão
EXPLAIN (ANALYZE, BUFFERS)
SELECT kind, COALESCE(SUM(cost_usd), 0)::float8 AS usd, COUNT(*)::int AS calls,
       COALESCE(BOOL_OR(estimated), false) AS estimated,
       COALESCE(BOOL_OR(cost_usd IS NULL), false) AS unpriced
FROM usage_ledger
WHERE user_email = :'uemail' AND session_id = :sid
GROUP BY kind;
```

Espera-se que Q6 use `idx_usage_ledger_user_time` e Q7 use `idx_usage_ledger_session`.
Confirme no plano. O `unpriced` aparece nas duas: é um dado do custo, não da performance.

### 4.6 Resultados de EXPLAIN

> **A PREENCHER.** Uma linha por consulta e por volume de dados. Cole o plano completo
> em um anexo e resuma aqui: tipo de varredura, linhas lidas, buffers, tempo de execução
> e índice usado.

| ID | Volume (sessões / mensagens / embeddings) | Tempo de execução (ms) | Buffers (hit/read) | Varredura e índice | Observações |
|---|---|---:|---|---|---|
| Q1 | | | | | |
| Q2 | | | | | |
| Q3 | | | | | |
| Q4 | | | | | |
| Q5 | | | | | |
| Q6 | | | | | |
| Q7 | | | | | |

---

## 5. Próximos passos depois da medição

- Se Q5 for confirmada como varredura total: reescrever a consulta para restringir a
  sessões do usuário antes do cálculo de distância, e avaliar um índice composto.
- Se o pool do SP for o gargalo: avaliar teto maior de conexões (com o limite de
  conexões do Lakebase em mente) ou dividir leituras e escritas.
- Se o gargalo for o gateway: a latência do modelo não é do app. Mostre o dado de
  `system.ai_gateway.usage` (dashboard `ai-ops`) no relatório.
- Repita o teste depois de cada mudança relevante e compare com o mesmo `--think` e a
  mesma duração.
