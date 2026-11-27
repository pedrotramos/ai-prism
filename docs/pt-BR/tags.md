<!-- i18n: source=docs/tags.md source-hash=695bcd7ef88753de042ef8be6f60e7c2c97c0281 status=current -->
# Tags de recurso e atribuição de custo

[English](../tags.md) · **Português (Brasil)** · [Español](../es/tags.md)

Este guia explica como o AI Prism marca os recursos que cria no workspace e o
consumo que faz deles, como passar as tags no deploy, como ler o custo pelas system
tables e quando usar uma serverless usage policy.

## Visão geral

Uma **tag de recurso** é um par `chave=valor` que o Databricks grava no recurso e
que aparece nas tabelas de sistema de custo e de histórico de consultas. Com ela,
o custo do AI Prism pode ser separado por centro de custo, área ou qualquer
critério que a sua empresa use, sem depender de quem fez a chamada.

O operador informa as tags **uma vez, no deploy**. O AI Prism então:

1. **marca os recursos que o bundle cria** (SQL Warehouse, Lakebase, job de auto-config,
   e, pelo job, o catálogo, o schema, o volume e a função Python da instalação);
2. **carrega as mesmas tags no runtime do app** e as envia em cada chamada que o app
   faz: no `usage_context` de toda chamada ao AI Gateway e nas `query_tags` de todo
   statement no SQL Warehouse.

## Tag embutida: `ai_prism_app`

Toda instalação tem a tag embutida **`ai_prism_app=<nome do app>`** (por padrão,
`ai_prism_app=ai-prism`). Ela:

- é sempre adicionada e aparece por último nas listas de tags;
- **não pode ser sobrescrita**: uma tag do operador com esse nome (em qualquer
  caixa, `AI_PRISM_APP` inclusive) é ignorada com um aviso;
- é a chave que separa a instalação de outras no mesmo workspace: o painel de custo
  e as consultas abaixo filtram por ela.

Também é **reservada** a chave `application`, que o AI Prism usa internamente para
atribuir as chamadas de IA ao próprio app (`usage_context['application'] = 'ai-prism'`).
Se o operador passar `application`, ela é ignorada com um aviso.

## Como passar as tags no deploy

Você pode passar as tags de quatro jeitos. Todos caem na mesma validação.

| Onde | Como |
|---|---|
| `deploy.sh` (Linux/macOS) | `--tag cost_center=1234 --tag area=Finanças` (repetível) |
| `deploy.sh` (ambiente) | `TAGS="cost_center=1234,area=Finanças" ./deploy.sh DEV` |
| `deploy.ps1` (Windows) | `-Tag 'cost_center=1234','area=Finanças'` ou `-Tag "cost_center=1234,area=Finanças"` |
| Notebook instalador | campo **8. Tags de recurso**: `cost_center=1234,area=Finanças` |

Exemplo:

```bash
./deploy.sh --tag cost_center=1234 --tag area=Finanças DEV ai_prism
```

### Regras de chave e valor

- Chave e valor: de 1 a 255 caracteres (o valor pode ser vazio), só com **letras**
  (inclusive acentuadas), **números**, espaço, e os símbolos `_ + - = . : / @`.
- Sem aspas, vírgula, ponto e vírgula, barra invertida, parênteses e similares.
- **No máximo 24 tags do operador**, mais a embutida, totalizando 25: é o limite da
  Jobs API, que recebe as tags do job de auto-config. O `deploy.sh` e o notebook
  recusam uma lista maior antes de tocar em qualquer recurso.
- Chaves que diferem só pela caixa (`Area` e `area`) são recusadas: o PowerShell trata
  as duas como a mesma chave.
- O SQL Warehouse aceita no máximo **20** `query_tags` por statement. O runtime reserva
  o espaço da tag embutida e descarta (com aviso no log) as tags de operador que
  excederem esse limite.

As validações valem igual no `deploy.sh`, no `deploy.ps1`, no notebook e no runtime
(`server/resourceTags.ts`), e são cobertas pelos testes em `tests/resourceTags.test.mjs`.

## Onde cada tag vai

| Recurso ou consumo | Mecanismo | Onde aparece |
|---|---|---|
| SQL Warehouse | `tags.custom_tags` (bundle) | `system.billing.usage.custom_tags` |
| Lakebase (projeto) | `custom_tags` (bundle, beta; cobre todos os branches e endpoints) | faturamento do Lakebase |
| Job de auto-config | `tags` (bundle) | `system.billing.usage.custom_tags` |
| Catálogo, schema, volume e função Python criados pela instalação | `ALTER ... SET TAGS` / `SET TAG ON FUNCTION`, feito pelo job de auto-config | `information_schema.*_tags` |
| Chamadas ao AI Gateway (chat, embeddings, imagens, transcrição) | `usage_context` em toda chamada, no runtime | `system.serving.endpoint_usage.usage_context` |
| Chamadas de imagem por um Model Provider Service do Unity Catalog | as mesmas tags, no header de requisição `Databricks-Ai-Gateway-Request-Tags`, no runtime | `system.ai_gateway.usage.request_tags` |
| Statements do SQL Warehouse (ferramentas UC, UDF, consultas do app) | `query_tags` em toda chamada, no runtime | `system.query.history.query_tags` |
| App (Databricks App) | não tem campo `tags`; só uma **serverless usage policy** (abaixo) | `system.billing.usage` (`usage_metadata.usage_policy_id`) |

Observações:

- O **catálogo** só é marcado quando a própria instalação o cria. Um catálogo
  pré-existente e compartilhado (o caso típico de um workspace de demonstração, em que
  o deployer só tem permissão no catálogo que já existe) **não é tocado**: as tags
  dele pertencem a outros times.
- Os objetos UC são **reconciliados em cada deploy**: o valor atual de cada tag do
  operador é reimposto, e uma chave que saiu da configuração é removida (`UNSET TAG`).
- Se um workspace tiver uma **tag policy** que rejeite um valor, só essa tag fica de
  fora daquele objeto; as outras (inclusive a embutida) seguem aplicadas.
- Marcar funções exige Databricks Runtime 18.1 ou mais novo. Em runtimes que não suportam
  a operação, o auto-config **avisa e segue** (não derruba o deploy).

## Ler o custo pelas system tables

Os exemplos supõem que as tags foram passadas como `cost_center` e `area`. Para ver os
nomes exatos no seu workspace, rode `DESCRIBE TABLE system.billing.usage` ou
`DESCRIBE TABLE system.serving.endpoint_usage`.

**Custo de infraestrutura (SQL Warehouse, Lakebase, job) por tag** — as linhas da
instalação são as que têm `ai_prism_app`:

```sql
SELECT
  custom_tags['cost_center']                 AS cost_center,
  sku_name,
  SUM(usage_quantity)                        AS dbus
FROM system.billing.usage
WHERE custom_tags['ai_prism_app'] = 'ai-prism'
  AND usage_date >= date_sub(current_date(), 30)
GROUP BY 1, 2
ORDER BY dbus DESC;
```

**Tokens e chamadas de IA por tag** — `usage_context` é um MAP; o filtro por
`application = 'ai-prism'` separa o AI Prism do restante do tráfego de serving do
workspace:

```sql
SELECT
  usage_context['cost_center']               AS cost_center,
  endpoint_name,
  SUM(input_token_count)                     AS tokens_in,
  SUM(output_token_count)                    AS tokens_out,
  COUNT(*)                                   AS chamadas
FROM system.serving.endpoint_usage
WHERE usage_context['application'] = 'ai-prism'
  AND usage_context['ai_prism_app'] = 'ai-prism'
  AND request_time >= date_sub(current_date(), 30)
GROUP BY 1, 2;
```

**Consultas SQL do app por tag** — `query_tags` é um array de `{key, value}`; a forma
exata da coluna pode variar entre versões, então confira com `DESCRIBE TABLE
system.query.history` antes de montar o painel:

```sql
SELECT t.value AS cost_center, COUNT(*) AS statements
FROM system.query.history h
LATERAL VIEW EXPLODE(h.query_tags) q AS t
WHERE q.key = 'ai_prism_app' AND q.value = 'ai-prism'
  AND t.key = 'cost_center'
GROUP BY 1;
```

O painel de custos do AI Prism (`dashboards/ai-costs.lvdash.json`, publicado pelo
job de auto-config) lê as mesmas fontes: `system.serving.endpoint_usage` filtrado por
`usage_context['application'] = 'ai-prism'` e `system.billing.usage`.

> **Atraso:** as system tables de billing chegam com algumas horas de atraso, e o dia
> de hoje sempre está incompleto. Tags novas só aparecem nas linhas posteriores ao
> deploy.

## Serverless usage policy

Uma **serverless usage policy** é um objeto **da conta** que atribui o consumo
serverless a um conjunto de tags, com um orçamento opcional. O bundle **nunca cria**
a policy: ela é compartilhada entre workspaces, então um admin cria uma vez e o AI
Prism só recebe o id.

1. Um admin da conta cria a policy em **Settings → Compute → Serverless usage
   policies → Manage** (no workspace, ou no console da conta), com as tags de custo
   desejadas.
2. Passe o id ao instalador:
   ```bash
   ./deploy.sh --usage-policy-id <id> DEV ai_prism
   ```
   (no Windows, `-UsagePolicyId <id>`; no notebook, o campo **7. Serverless usage policy id**).
3. Sem o id, nada é atribuído. Um id inválido aparece no `bundle deploy`.

A policy cobre o **App** e o **job de auto-config**. O SQL Warehouse e o Lakebase
recebem as tags pelos campos próprios, descritos acima.

## Caminho nativo do bundle (sem o script de deploy)

`databricks bundle deploy` direto, sem `deploy.sh`/`deploy.ps1`/o notebook, funciona,
mas com uma diferença:

- as **tags dos recursos** (warehouse, Lakebase, job, objetos UC) são aplicadas
  normalmente, porque vêm das variáveis do bundle (`resource_tags`, `resource_tags_list`);
- as **tags no runtime do app** (`usage_context` e `query_tags`) só mudam quando
  `AI_PRISM_RESOURCE_TAGS` no `app.yaml` é atualizado. Os wrappers fazem isso; no
  caminho nativo você precisa editar o `app.yaml`, com o JSON que o job de auto-config
  imprime no fim do log (`AVISO IMPORTANTE — tags de recurso no runtime do app`), e
  rodar `databricks apps deploy` de novo.

Enquanto isso não for feito, o app segue usando só a tag embutida no AI Gateway e no
SQL Warehouse. O job não consegue fazer essa alteração sozinho, porque ela exige um
novo deploy do código do app.

## Mudar as tags depois da instalação

Rode o deploy de novo com as tags novas (o processo é idempotente):

```bash
./deploy.sh --tag cost_center=5678 DEV ai_prism
```

- Tags adicionadas ou com valor novo passam a valer para **consumo novo**; o histórico
  de custo guarda a tag que estava válida na época.
- Uma tag removida da lista deixa de ser enviada. Nos objetos UC, o auto-config a
  remove (`UNSET TAG`); nos recursos do bundle, ela sai na próxima atualização.

## Referências

- Deploy e instalação: [docs/onboarding-deployment.md](onboarding-deployment.md)
- Runtime: `server/resourceTags.ts` (regras, `usageContext`, `queryTagsFor`)
- Testes: `tests/resourceTags.test.mjs` (`node --test tests/resourceTags.test.mjs`)
- Variáveis do bundle: `databricks.yml` (`resource_tags`, `resource_tags_list`,
  `resource_tags_json`, `serverless_usage_policy_id`, `warehouse_serverless`)
