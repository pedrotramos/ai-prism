<!-- i18n: source=docs/performance.md source-hash=dc464461554b1c1acf9c5cc41bcc41e30273ae8a status=current -->
# Performance: método de carga e análise de consultas

[English](../performance.md) · **Português (Brasil)** · [Español](../es/performance.md)

Esta página descreve como medir o AI Prism sob carga e como analisar as consultas
críticas do Lakebase com `EXPLAIN (ANALYZE, BUFFERS)`. Ela também registra uma execução
medida: cada tabela das §3, §4.6 e §4.7 informa o commit, a data e a configuração da
medição. Números de uma instalação são uma referência, não uma promessa para outra: meça
a sua instalação no ambiente de teste dela antes de confiar neles.

Ferramentas do repositório:

- `npm run smoke`: verificação funcional, um usuário, um turno (ver [operations.md](operations.md)).
- `npm run loadtest`: gerador de carga sem dependências (`scripts/load-test.mjs`).
- `scripts/bench/explain.sql`: `EXPLAIN (ANALYZE, BUFFERS)` das consultas da §4, rodado com
  `psql` direto num banco de teste.

---

## 1. Objetivo e critérios

Responder três perguntas, na ordem:

1. Em quantos usuários simultâneos a latência das leituras e do primeiro token passa dos
   alvos de SLO (ver [operations.md §5.1](operations.md#51-slos-propostos))?
2. Qual é o gargalo ao crescer: o pool do banco, o gateway de modelo, o warehouse ou a
   CPU do app?
3. Quais consultas dominam o tempo de banco, e o plano delas muda com o volume de dados?

Cenários padrão: **1, 5, 20 e 50 usuários virtuais**, com pelo menos 60 s por estágio para
que a fila se estabilize. São os valores padrão do `loadtest`.

---

## 2. Método

### 2.1 Preparação

1. **Ambiente de teste dedicado.** Use uma instalação de teste no mesmo workspace e na
   mesma região dos usuários. Medir de um notebook longe da região mede a rede, não o app
   (ver o piso de latência na §3).
2. **Banco descartável.** Aponte a instalação de teste para um branch descartável do
   Lakebase (`databricks postgres create-branch ... --ttl 4h`), nunca para o branch de
   produção, e apague o branch ao final. Um branch copia as tabelas do branch de origem e
   os papéis donos delas: se o service principal do app de teste não conseguir assumi-las,
   crie um banco separado no branch e rode `node scripts/migrate.mjs up --role <SP do app de teste>`
   nele, com a identidade que faz o deploy.
3. **Estado do Lakebase declarado.** Registre se o teste começou com o endpoint suspenso
   (cold) ou ativo (warm). A primeira requisição depois de uma suspensão paga o cold start.
4. **Volume de dados declarado.** Registre quantas sessões, mensagens e embeddings existem
   antes do teste. Sem isso, os planos não são comparáveis.
5. **Smoke antes da carga.** `npm run smoke` precisa passar. Carga sobre um app quebrado
   só mede erro.

Massa de dados para um usuário de teste (rode **só** numa instalação de teste; o e-mail é
fictício e a limpeza é obrigatória). As tabelas ficam no schema `ai_prism` e têm segurança
por linha forçada, então a transação que insere precisa carregar a identidade em nome da
qual escreve:

```sql
SET search_path = ai_prism, public;
BEGIN;
SELECT set_config('app.user_email', 'carga-teste@example.com', true);

-- 200 sessões x 40 mensagens
INSERT INTO chat_sessions (user_email, title, model)
SELECT 'carga-teste@example.com', 'load ' || g, 'databricks-claude-haiku-5-5'
FROM generate_series(1, 200) g;

INSERT INTO chat_messages (session_id, role, content, created_at)
SELECT s.id,
       CASE WHEN m % 2 = 0 THEN 'assistant' ELSE 'user' END,
       'load message ' || m,
       now() - (m || ' minutes')::interval
FROM chat_sessions s
CROSS JOIN generate_series(1, 40) m
WHERE s.user_email = 'carga-teste@example.com';

-- embeddings de 1024 dimensões (Q4 e Q5 exigem a variante pgvector da tabela)
INSERT INTO chat_message_embeddings (message_id, session_id, embedding)
SELECT m.id, m.session_id,
       (SELECT ('[' || string_agg(round(random()::numeric, 4)::text, ',') || ']')::vector
          FROM generate_series(1, 1024))
FROM chat_messages m
JOIN chat_sessions s ON s.id = m.session_id
WHERE s.user_email = 'carga-teste@example.com';
COMMIT;

-- limpeza ao final (a cascata remove mensagens, embeddings e tool calls)
BEGIN;
SELECT set_config('app.user_email', 'carga-teste@example.com', true);
DELETE FROM chat_sessions WHERE user_email = 'carga-teste@example.com';
COMMIT;
```

Vetores aleatórios uniformes são um caso degenerado para um índice aproximado: todo ponto
fica mais ou menos à mesma distância de todos os outros. Para as medições de HNSW da §4.7,
os vetores foram sorteados em torno de 64 centroides aleatórios (cada sessão cobre 3
deles), para que os vizinhos pareçam assuntos. Um segundo usuário fictício
(`outro-usuario@example.com`) é dono de 20% das linhas, para que os planos mostrem se uma
consulta lê dados de outros usuários.

### 2.2 Execução

```bash
# leituras baratas, 1/5/20/50 usuários, 60 s por estágio, think time de 1 s
APP_URL=<app-URL> DATABRICKS_TOKEN=<oauth-token> \
  npm run loadtest -- --stages 1,5,20,50 --duration 60 --think 1000 > read-results.md

# com turnos de chat (CUSTA TOKENS): um turno a cada 10 iterações por usuário
APP_URL=<app-URL> DATABRICKS_TOKEN=<oauth-token> \
  npm run loadtest -- --chat --chat-every 10 --model <fast model> \
  --stages 1,5,20,50 --duration 60 --think 1000 > chat-results.md
```

O `loadtest` não roda em CI: com a variável `CI` definida, ele se recusa a rodar. A sessão
de cada turno de chat é apagada depois, mas os turnos geram custo real no gateway e entram
no `usage_ledger` (o ledger guarda as linhas: `session_id` vira `NULL`). Combine o horário
e o modelo antes. Com `--chat`, o relatório traz também duas linhas derivadas por estágio,
que não são requisições e ficam fora do total do estágio: `chat: envio → 1º token` e
`chat: meta → 1º token (S3)` (do evento `meta` ao primeiro evento `token`, a medida do S3).

**Todos os usuários virtuais são a mesma identidade** (a dona do token). O limite de taxa
por usuário (`RATE_LIMIT_API_PER_MIN`, padrão 120, e `RATE_LIMIT_TURNS_PER_MIN`, padrão 12,
`server/middleware/rateLimit.js`) responderia a maior parte da carga com 429 e você estaria
medindo o limitador. Usuários reais ficam, cada um, muito abaixo dele; então, **só na
instalação de teste**, defina os dois como `0` no `app.yaml` durante o teste.

Rode um estágio por invocação (`--stages N`) quando precisar do custo de cada estágio:
leia `SUM(cost_usd)` do `usage_ledger` antes e depois de cada um.

Use o mesmo `--think` e a mesma duração entre execuções que serão comparadas.

### 2.3 Durante o teste

Registre, por estágio, o que o `loadtest` não mostra:

- Lakebase: conexões do service principal do app (`pg_stat_activity` com `usename` igual
  ao client id do SP) e, se disponível, o CU no console.
- O estado do warehouse (se a carga passar por UC Functions ou pela UDF Python).
- Erros nos logs do app: `databricks apps logs <app> -p <PROFILE>` (ver
  [operations.md §2](operations.md#2-logs)).

### 2.4 Interpretação

- **Joelho da curva.** O ponto em que a latência p95 cresce mais rápido que o número de
  usuários. Antes dele, o sistema escala; depois, há fila.
- **Fila no pool.** O pool do service principal tem um teto fixo de 8 conexões
  (`POOL_OPTS`, `server/db/pool.js`). Se o p95 das leituras de banco sobe linearmente com
  os usuários enquanto o Lakebase está ocioso e o SP tem 8 conexões, todas `active`, o
  gargalo é o pool, não o banco. Não existe variável `PG_POOL_MAX`: o teto só muda no
  código (ver §5). `PG_POOL_IDLE_TIMEOUT_MS` (padrão 2 min) é a única configuração do pool
  lida do ambiente.
- **Erro sem latência alta** indica falha de auth ou de rota. Leia a tabela de erros mais
  frequentes antes de concluir qualquer coisa.
- **Taxa de erro não é o único critério.** Um estágio com 0% de erro e p95 acima do SLO
  continua reprovado.

---

## 3. Resultados de carga

**Medido em 2026-11-19, commit `a27c9ca`** (main), com o `scripts/load-test.mjs` desta
mudança (o mesmo laço de requisições, mais as linhas de primeiro token).

**Ambiente:** uma instalação de teste descartável (app e service principal próprios,
apagados depois da execução) num workspace interno de teste na AWS, região us-west-2 ·
Lakebase: um branch descartável do projeto da instalação, autoscaling 0,5–16 CU, **warm**
(endpoint ativo, smoke logo antes) · dados: um banco vazio, recém-migrado (versão 0007) ·
o gerador de carga rodou num notebook **fora da região**.

**Configuração:** `--duration 60 --think 1000 --timeout 30000 --chat --chat-every 10
--model databricks-claude-haiku-5-5`, um estágio por invocação, `enabledTools: []`, uma
identidade para todos os usuários virtuais, `RATE_LIMIT_API_PER_MIN=0` e
`RATE_LIMIT_TURNS_PER_MIN=0` na instalação de teste (§2.2). Tráfego de chat no total:
4 estágios × 60 s.

**Piso de latência.** As mesmas consultas medidas dentro do banco levam 0,4 ms, e cerca de
195 ms a partir do notebook (§4.7); então uns 200 ms de cada número abaixo são a rede entre
o gerador de carga e a região. Rode de dentro da região para tirá-los.

### 3.1 Todas as requisições, por estágio

| Usuários | Requisições | Erros | Taxa de erro | Throughput (req/s) | p50 (ms) | p95 (ms) | p99 (ms) |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 40 | 0 | 0,00% | 0,66 | 208 | 1698 | 3661 |
| 5 | 211 | 0 | 0,00% | 3,45 | 203 | 1705 | 3314 |
| 20 | 853 | 0 | 0,00% | 13,99 | 205 | 1938 | 2257 |
| 50 | 2071 | 0 | 0,00% | 33,27 | 210 | 1767 | 3851 |

O p95/p99 do estágio são os turnos de chat (uma requisição em onze); as leituras estão na §3.2.

### 3.2 Leituras, por endpoint

| Usuários | Endpoint | Requisições | Erros | p50 (ms) | p95 (ms) | p99 (ms) |
|---:|---|---:|---:|---:|---:|---:|
| 1 | `GET /api/me` | 12 | 0 | 198 | 903 | 903 |
| 1 | `GET /api/models` | 12 | 0 | 199 | 214 | 214 |
| 1 | `GET /api/sessions` | 12 | 0 | 212 | 221 | 221 |
| 5 | `GET /api/me` | 65 | 0 | 197 | 213 | 871 |
| 5 | `GET /api/models` | 63 | 0 | 199 | 225 | 845 |
| 5 | `GET /api/sessions` | 63 | 0 | 216 | 242 | 860 |
| 20 | `GET /api/me` | 257 | 0 | 197 | 235 | 861 |
| 20 | `GET /api/models` | 259 | 0 | 198 | 258 | 841 |
| 20 | `GET /api/sessions` | 257 | 0 | 214 | 265 | 891 |
| 50 | `GET /api/me` | 627 | 0 | 198 | 344 | 871 |
| 50 | `GET /api/models` | 620 | 0 | 200 | 341 | 867 |
| 50 | `GET /api/sessions` | 624 | 0 | 218 | 334 | 877 |

Com 12 amostras, o p95 e o p99 de 1 usuário são a amostra mais lenta (o primeiro `/api/me`).

### 3.3 Turnos de chat (`--chat`)

| Usuários | Turnos | Erros | Turno p50 / p95 / p99 (ms) | Envio → 1º token p50 / p95 / p99 (ms) | `meta` → 1º token p50 / p95 / p99 (ms) |
|---:|---:|---:|---|---|---|
| 1 | 4 | 0 | 1698 / 3661 / 3661 | 1055 / 1179 / 1179 | 800 / 919 / 919 |
| 5 | 20 | 0 | 1705 / 3647 / 4304 | 1099 / 2751 / 3722 | 808 / 2499 / 2798 |
| 20 | 80 | 0 | 1948 / 2369 / 2863 | 1376 / 1751 / 2299 | 849 / 1197 / 2047 |
| 50 | 200 | 0 | 1805 / 4023 / 4225 | 1208 / 2024 / 3108 | 875 / 1615 / 2805 |

O tempo do turno vai até o evento `done`. Com 4 e 20 amostras, os percentis de 1 e 5
usuários ficam perto do máximo.

### 3.4 Custo por estágio (delta do `usage_ledger`)

| Usuários | Linhas do ledger | USD | Tokens de prompt | Tokens de resposta | Dos quais: títulos | chat | embeddings |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 16 | 0,001186 | 15.774 | 91 | 0,001015 | 0,000171 | 0,000000 |
| 5 | 80 | 0,005774 | 78.961 | 460 | 0,004892 | 0,000879 | 0,000003 |
| 20 | 320 | 0,023358 | 315.546 | 1.934 | 0,019810 | 0,003532 | 0,000016 |
| 50 | 800 | 0,058276 | 789.104 | 4.309 | 0,049737 | 0,008539 | 0,000000 |
| **Total** | **1.216** | **0,088594** | | | | | |

Cada turno gravou 4 linhas no ledger (chat, título, 2 embeddings); nenhuma ficou sem
preço. Cerca de US$ 0,0003 por turno. **Os títulos são 85% do custo** porque o teste de
carga abre uma sessão nova por turno, e toda sessão nova paga um título. Um usuário real
paga um título por conversa. Mais de 99% dos tokens de prompt do chat foram leituras do
cache de prompt.

### 3.5 Recursos durante o teste

| Usuários | Conexões do SP (máx.) | Ativas na amostra (máx.) | Warehouse | Observações |
|---:|---:|---:|---|---|
| 1 | 4 | 0 | não usado | |
| 5 | 6 | 0 | não usado | |
| 20 | 8 | 1 | não usado | o pool chegou ao teto de 8 |
| 50 | 8 | 2 | não usado | no teto, mas o p95 das leituras ficou em 334–344 ms |

As conexões foram amostradas do `pg_stat_activity` a cada ~3,6 s (17 amostras por
estágio). O CU não foi registrado.

### 3.6 Veredictos

| SLO | Alvo | Medido | Veredicto |
|---|---|---|---|
| S2 | p95 ≤ 800 ms em `/api/me`, `/api/models`, `/api/sessions`, 20 usuários, app warm | 235 / 258 / 265 ms (50 usuários: 344 / 341 / 334 ms) | **Aprovado**, com uns 200 ms de rede incluídos |
| S3 | `meta` → 1º token p95 ≤ 4 s, modelo rápido, Lakebase warm | 1197 ms com 20 usuários, 1615 ms com 50 (Haiku 5.5) | **Aprovado** |
| S4 | ≥ 98% dos turnos sem evento `error` | 304 de 304 turnos | Aprovado (uma execução, não uma janela de 7 dias) |

O que esta execução **não** prova: volume de dados (a carga rodou num banco vazio; o custo
do volume está na §4.6), cold start (S5), ferramentas (nenhuma UC Function, Genie ou busca
na web nos turnos), usuários reais espalhados por várias identidades e um cliente dentro
da região.

---

## 4. Consultas críticas

As consultas vêm de `server/db.js`. O `scripts/bench/explain.sql` roda cada uma com
`EXPLAIN (ANALYZE, BUFFERS)` exatamente como o app a envia hoje (parâmetros como
literais), dentro de uma transação que carrega a identidade de quem chama, para que as
políticas de segurança por linha façam parte do plano, como para o app. Tudo é desfeito
(rollback). Rode com `psql` contra um banco de teste, com a identidade que faz o deploy e
uma credencial de banco recém-gerada, nunca com credenciais guardadas no repositório:

```bash
psql -X -v uemail=carga-teste@example.com -f scripts/bench/explain.sql
# opcional: -v sid=<id da sessão> (padrão: a maior sessão do usuário)
```

| ID | Consulta | Chamada por | Frequência esperada |
|---|---|---|---|
| Q1 | Lista de sessões (`listSessions`) | `GET /api/sessions` | Abertura da barra lateral |
| Q2 | Mensagens da sessão (`fetchActiveMessages`) | `GET /api/sessions/:id/messages`, a cada turno | Abertura de conversa e cada turno |
| Q3 | Tool calls da sessão (`fetchActiveMessages`, `chat_tool_calls`) | Junto com Q2 | Idem |
| Q4 | Recuperação de histórico por embedding (`retrieveRelevantMessages`) | Cada turno, com `HISTORY_RETRIEVAL` ativo | Cada turno |
| Q5 | Busca semântica entre sessões (`searchSessionsByVector`) | `GET /api/search` | Digitação na busca |
| Q6 | Uso do mês (`usageTotals`, mês) | `GET /api/usage/summary` | Início da sessão, troca de conversa e fim de cada turno (o medidor não faz polling) |
| Q7 | Uso da sessão (`usageTotals`, por tipo) | Idem, com `sessionId` | Idem |

Os índices relevantes (das migrações): `idx_chat_sessions_user (user_email, updated_at
DESC)`, `idx_chat_messages_session (session_id, id)`, `idx_chat_tool_calls_message
(message_id, seq)`, `idx_msg_emb_session (session_id)`, `idx_msg_emb_hnsw` (HNSW,
`vector_cosine_ops`), `idx_usage_ledger_user_time (user_email, created_at)` e
`idx_usage_ledger_session (session_id)`.

### 4.1 Q1: lista de sessões

Um `LATERAL` lê as mensagens de cada sessão listada para juntar os nomes de anexo; então o
custo cresce com as mensagens das 100 sessões listadas, não só com o número de sessões.

### 4.2 Q2 e Q3: mensagens e tool calls de uma sessão

A Q2 liga as mensagens de volta à sessão delas (a checagem de dono). A Q3 recebe os ids
lidos pela Q2 (`WHERE message_id = ANY($1)`).

### 4.3 Q4: recuperação de histórico por embedding

A consulta filtra por uma sessão (`e.session_id = $1`), numera as linhas com
`ROW_NUMBER() OVER (ORDER BY m.id DESC)`, descarta as 6 mais recentes e ordena pela
similaridade numa consulta externa. Por causa da função de janela, **o índice HNSW não
pode atendê-la**: a distância é calculada para cada embedding da sessão, o que torna o
resultado exato.

### 4.4 Q5: busca semântica entre sessões

A consulta agrupa por sessão com `MAX` e filtra com `HAVING`, o que também impede o índice
HNSW. O plano lê todos os embeddings da tabela, de todos os usuários, e só depois os cruza
com as sessões de quem chama (medido na §4.6). O custo cresce com os embeddings da
instalação, não com os do usuário.

### 4.5 Q6 e Q7: uso (medidor)

Espera-se que a Q6 use `idx_usage_ledger_user_time` e a Q7, `idx_usage_ledger_session`.
As duas usam.

### 4.6 Resultados de EXPLAIN

**Medido em 2026-11-19, commit `a27c9ca`**, `scripts/bench/explain.sql`, no mesmo branch
descartável (PostgreSQL 17, pgvector 0.8.0), dados sintéticos da §2.1:

- **Volume A:** 250 sessões (200 do usuário medido) / 10.000 mensagens / 10.000
  embeddings / 6.240 linhas de ledger.
- **Volume B:** 2.500 sessões (2.000 do usuário medido) / 100.000 mensagens / 100.000
  embeddings / 51.240 linhas de ledger.

A sessão medida tem 40 mensagens. O tempo do B é a primeira execução depois da carga e,
em seguida, uma segunda execução no mesmo schema.

| ID | Volume | Tempo de execução (ms) | Buffers (hit/read) | Varredura e índice | Observações |
|---|---|---:|---|---|---|
| Q1 | A | 2,9 | 4.201 / 0 | Index Scan `idx_chat_sessions_user`; Bitmap Index Scan `idx_chat_messages_session` × 100 | |
| Q1 | B | 8,5 / 20,2 | 3.992 / 400 | Index Scan `idx_chat_sessions_user`; Index Scan `idx_chat_messages_session` × 100 | Cresce com as 100 sessões listadas, como esperado |
| Q2 | A | 0,34 | 47 / 0 | Bitmap Index Scan `idx_chat_messages_session`; `chat_sessions_pkey` | |
| Q2 | B | 0,18 / 0,16 | 46 / 0 | Index Scan `idx_chat_messages_session`; `chat_sessions_pkey` | Não depende do volume |
| Q3 | A | 0,14 | 9 / 0 | Bitmap Index Scan `idx_chat_tool_calls_message` | Sessão sem tool calls |
| Q3 | B | 0,36 | 68 / 28 | Index Scan `idx_chat_tool_calls_message` | Sessão com 40 tool calls |
| Q4 | A | 0,71 | 344 / 0 | Index Scan `idx_msg_emb_session`; `chat_messages_pkey`; `chat_sessions_pkey` | Sem HNSW (§4.3) |
| Q4 | B | 1,7 / 2,7 | 403 / 21 | Idem | Não depende do volume |
| Q5 | A | 27,8 | 26.767 / 0 | **Seq Scan** `chat_message_embeddings` (10.000 linhas, todos os usuários); Hash Join; Seq Scan `chat_sessions` | Lê também os 2.000 embeddings do outro usuário |
| Q5 | B | **554,6 / 426,4** | 293.169 / 54.501 | **Seq Scan** `chat_message_embeddings` (100.000 linhas); Hash Join; Bitmap Index Scan `idx_chat_sessions_user` | **Lacuna**: linear nos embeddings da instalação (§5) |
| Q6 | A | 0,36 | 75 / 0 | Bitmap Index Scan `idx_usage_ledger_user_time` (844 linhas no mês) | |
| Q6 | B | 4,1 / 4,6 | 0 / 596 | Idem (8.444 linhas no mês) | Cresce com as linhas do usuário no mês |
| Q7 | A | 0,17 | 22 / 0 | Bitmap Index Scan `idx_usage_ledger_session`, filtro `user_email` | |
| Q7 | B | 0,53 / 0,18 | 20 / 2 | Index Scan `idx_usage_ledger_session`, filtro `user_email` | |

**Antes e depois de um índice.** Nenhum plano mostrou falta de índice: toda busca usa um
índice existente, e o Seq Scan da Q5 vem da forma da consulta (a distância até cada vetor
do usuário precisa ser calculada, e o `idx_msg_emb_session` existe, mas não ajuda quando o
usuário é dono da maior parte das linhas). Nenhum índice foi criado, então não há migração
`0008_indexes`; o segundo tempo do B é o "depois", no mesmo schema.

### 4.7 HNSW: recall e latência

**Medido em 2026-11-19, commit `a27c9ca`**, mesmo branch, 50 consultas por volume. Cada
vetor de consulta é uma perturbação de uma mensagem de uma sessão sorteada do usuário
medido (uma "pergunta relacionada"). Verdade de referência: para a Q4, calculada fora do
banco a partir dos vetores brutos, com as mesmas regras de `retrieveRelevantMessages`
(exclui as 6 mais recentes, similaridade ≥ 0,35, top 6); para a consulta HNSW direta, a
mesma consulta com as varreduras por índice desligadas. Os tempos são o tempo de execução
no banco (`EXPLAIN ANALYZE`). A partir do notebook, cada consulta levou uns 195 ms a mais.

| Volume | Consulta | Recall (média / mín.) | Execução p50 / p95 (ms) | Exata p50 / p95 (ms) | Usa HNSW |
|---|---|---|---|---|---|
| 10k | Q4 `retrieveRelevantMessages` (top 6) | 1,000 / 1,000 | 0,40 / 0,44 | — | 0 de 50 |
| 10k | Top 10 direto, tabela inteira, `ef_search` 40 | 1,000 / 1,000 | 0,40 / 0,45 | 30,0 / 32,9 | 50 de 50 |
| 10k | Top 10 direto, sessões do usuário, `ef_search` 40 | 0,998 / 0,900 | 0,41 / 0,47 | 25,7 / 28,3 | 50 de 50 |
| 100k | Q4 `retrieveRelevantMessages` (top 6) | 1,000 / 1,000 | 0,45 / 0,49 | — | 0 de 50 |
| 100k | Top 10 direto, tabela inteira, `ef_search` 40 | 0,850 / 0,000 | 0,88 / 1,00 | 478 / 495 | 50 de 50 |
| 100k | Top 10 direto, tabela inteira, `ef_search` 100 | 0,912 / 0,000 | 1,25 / 1,46 | 475 / 515 | 50 de 50 |
| 100k | Top 10 direto, sessões do usuário, `ef_search` 40 | 0,852 / 0,000 | 0,93 / 1,00 | 400 / 418 | 50 de 50 |
| 100k | Idem, `ef_search` 40, `iterative_scan = relaxed_order` | 0,852 / 0,000 | 0,94 / 1,08 | 395 / 416 | 50 de 50 |

Varredura de `ef_search` em 100k (outras 50 consultas, tabela inteira, top 10):

| `hnsw.ef_search` | Recall médio | Consultas com recall 0 | Consultas abaixo de 0,9 | Execução p50 / p95 (ms) |
|---:|---:|---:|---:|---|
| 40 (padrão) | 0,894 | 3 | 6 | 0,90 / 1,00 |
| 100 | 0,936 | 2 | 3 | 1,35 / 1,61 |
| 200 | 0,938 | 2 | 3 | 1,69 / 1,94 |
| 400 | 0,960 | 1 | 1 | 2,10 / 3,24 |

Construção do índice (`CREATE INDEX ... USING hnsw`, configuração padrão): 3,2 s em 10k,
**4 min 28 s em 100k**. O grafo deixou de caber no `maintenance_work_mem` depois de 13.925
linhas.

Como ler os números:

- **A recuperação por turno do app (Q4) é exata e rápida nos dois volumes**: ela lê só os
  embeddings de uma sessão e nunca usa o índice HNSW.
- **Nenhuma consulta do app usa o `idx_msg_emb_hnsw` hoje**: a Q4 e a Q5 passam por fora
  dele. O índice custa tempo de escrita a cada embedding e minutos para reconstruir.
- Em 100k, as falhas do HNSW direto são **bimodais**: uma consulta ou acha os vizinhos do
  cluster dela ou não acha nenhum. É a falha conhecida do HNSW em clusters bem separados,
  e clusters sintéticos são mais separados que embeddings reais. Meça o recall com
  embeddings reais antes de ajustar o `ef_search` ou os parâmetros de construção.

---

## 5. Próximos passos depois da medição

- **Q5 (a lacuna).** Reescrever a `searchSessionsByVector` para que o banco pegue um
  conjunto de candidatos do HNSW restrito às sessões do usuário e o agrupe por sessão, em
  vez de calcular a distância até todos os vetores. Um protótipo no volume B, com
  `ef_search = 400`, `iterative_scan = relaxed_order` e 400 candidatos, foi de 397 / 414 ms
  para **5,6 / 7,6 ms** (p50 / p95, 20 consultas), com 95% das 20 melhores sessões em comum
  com a consulta exata. Isso muda código do app e resultados da busca, então é uma tarefa
  separada: confira o recall com dados reais e ponha atrás de uma flag. Até lá, a Q5 custa
  uns 3 a 5 ms por 1.000 embeddings na instalação.
- **`idx_msg_emb_hnsw`.** Ou a reescrita da Q5 passa a usá-lo, ou ele pode ser removido
  (não atende nenhuma consulta hoje). Se mantiver, dê à construção do índice um
  `maintenance_work_mem` maior para tabelas grandes.
- **O pool.** Com 50 usuários deste perfil, o pool do SP segurou as 8 conexões, mas com no
  máximo 2 ativas por amostra e a latência das leituras estável, ele não é o gargalo. Não
  existe `PG_POOL_MAX`: o teto é o `max: 8` do `POOL_OPTS` (`server/db/pool.js`). Crie uma
  variável de ambiente só depois que uma medição mostrar 8 conexões ativas por um tempo
  sustentado enquanto o p95 das leituras cresce, e leve em conta o limite de conexões do
  Lakebase.
- **O gateway.** A latência do modelo não é do app. Mostre o dado de
  `system.ai_gateway.usage` (dashboard `ai-ops`) no relatório.
- Repita o teste de dentro da região, com ferramentas ligadas e com mais de uma
  identidade, e depois de cada mudança relevante, com o mesmo `--think` e a mesma duração.
