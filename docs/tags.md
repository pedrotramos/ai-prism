# Resource tags and cost attribution

**English** · [Português (Brasil)](pt-BR/tags.md) · [Español](es/tags.md)

This guide explains how AI Prism tags the resources it creates in the workspace and the
usage it generates on them, how to pass the tags at deploy, how to read the cost from the
system tables, and when to use a serverless usage policy.

## Overview

A **resource tag** is a `key=value` pair that Databricks writes on the resource and that
shows up in the cost and query history system tables. With it, the cost of AI Prism can be
split by cost center, area, or any other criteria your company uses, without depending on
who made the call.

The operator passes the tags **once, at deploy**. AI Prism then:

1. **tags the resources the bundle creates** (SQL Warehouse, Lakebase, auto-config job,
   and, through the job, the catalog, schema, volume and Python function of the installation);
2. **loads the same tags into the app runtime** and sends them on every call the app
   makes: in the `usage_context` of every AI Gateway call and in the `query_tags` of every
   statement on the SQL Warehouse.

## Built-in tag: `ai_prism_app`

Every installation has the built-in tag **`ai_prism_app=<app name>`** (by default,
`ai_prism_app=ai-prism`). It:

- is always added and appears last in the tag lists;
- **cannot be overridden**: an operator tag with that name (in any case, `AI_PRISM_APP`
  included) is ignored with a warning;
- is the key that separates this installation from others in the same workspace: the cost
  dashboard and the queries below filter by it.

The key `application` is also **reserved**. AI Prism uses it internally to attribute AI calls
to the app itself (`usage_context['application'] = 'ai-prism'`). If the operator passes
`application`, it is ignored with a warning.

## How to pass the tags at deploy

You can pass the tags in four ways. All of them go through the same validation.

| Where | How |
|---|---|
| `deploy.sh` (Linux/macOS) | `--tag cost_center=1234 --tag area=Finanças` (repeatable) |
| `deploy.sh` (environment) | `TAGS="cost_center=1234,area=Finanças" ./deploy.sh DEV` |
| `deploy.ps1` (Windows) | `-Tag 'cost_center=1234','area=Finanças'` or `-Tag "cost_center=1234,area=Finanças"` |
| Installer notebook | field **8. Tags de recurso** (the notebook label is in Portuguese): `cost_center=1234,area=Finanças` |

Example:

```bash
./deploy.sh --tag cost_center=1234 --tag area=Finanças DEV ai_prism
```

### Key and value rules

- Key and value: 1 to 255 characters (the value may be empty), using only **letters**
  (accented letters included), **numbers**, spaces, and the symbols `_ + - = . : / @`.
- No quotes, commas, semicolons, backslashes, parentheses, and the like.
- **At most 24 operator tags**, plus the built-in one, for a total of 25. This is the Jobs
  API limit, which receives the tags of the auto-config job. `deploy.sh` and the notebook
  reject a longer list before they touch any resource.
- Keys that differ only in case (`Area` and `area`) are rejected, because PowerShell treats
  them as the same key.
- The SQL Warehouse accepts at most **20** `query_tags` per statement. The runtime reserves
  room for the built-in tag and drops (with a log warning) the operator tags that exceed
  this limit.

The validations are the same in `deploy.sh`, `deploy.ps1`, the notebook, and the runtime
(`server/resourceTags.js`). They are covered by the tests in `tests/resourceTags.test.mjs`.

## Where each tag goes

| Resource or usage | Mechanism | Where it appears |
|---|---|---|
| SQL Warehouse | `tags.custom_tags` (bundle) | `system.billing.usage.custom_tags` |
| Lakebase (project) | `custom_tags` (bundle, beta; covers all branches and endpoints) | Lakebase billing |
| Auto-config job | `tags` (bundle) | `system.billing.usage.custom_tags` |
| Catalog, schema, volume and Python function created by the installation | `ALTER ... SET TAGS` / `SET TAG ON FUNCTION`, run by the auto-config job | `information_schema.*_tags` |
| AI Gateway calls (chat, embeddings, images, transcription) | `usage_context` on every call, set at runtime | `system.serving.endpoint_usage.usage_context` |
| SQL Warehouse statements (UC tools, UDF, app queries) | `query_tags` on every call, set at runtime | `system.query.history.query_tags` |
| App (Databricks App) | has no `tags` field; only a **serverless usage policy** (below) | `system.billing.usage` (`usage_metadata.usage_policy_id`) |

Notes:

- The **catalog** is tagged only when the installation creates it. A pre-existing, shared
  catalog (the typical case in a demo workspace, where the deployer only has permission on
  the catalog that already exists) is **not touched**: its tags belong to other teams.
- UC objects are **reconciled on every deploy**. The current value of each operator tag is
  set again, and a key that was removed from the configuration is dropped (`UNSET TAG`).
- If a workspace has a **tag policy** that rejects a value, only that tag is left out of that
  object. The others (the built-in one included) are still applied.
- Tagging functions requires Databricks Runtime 18.1 or later. On runtimes that do not support
  the operation, the auto-config **warns and continues** (it does not fail the deploy).

## Reading the cost from the system tables

The examples assume the tags were passed as `cost_center` and `area`. To see the exact names
in your workspace, run `DESCRIBE TABLE system.billing.usage` or
`DESCRIBE TABLE system.serving.endpoint_usage`.

**Infrastructure cost (SQL Warehouse, Lakebase, job) by tag.** The rows for the installation
are the ones that have `ai_prism_app`:

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

**AI tokens and calls by tag.** `usage_context` is a MAP. The filter on
`application = 'ai-prism'` separates AI Prism from the rest of the workspace's serving traffic:

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

**App SQL statements by tag.** `query_tags` is an array of `{key, value}`. The exact shape of
the column can vary between versions, so check it with `DESCRIBE TABLE
system.query.history` before you build the dashboard:

```sql
SELECT t.value AS cost_center, COUNT(*) AS statements
FROM system.query.history h
LATERAL VIEW EXPLODE(h.query_tags) q AS t
WHERE q.key = 'ai_prism_app' AND q.value = 'ai-prism'
  AND t.key = 'cost_center'
GROUP BY 1;
```

The AI Prism cost dashboard (`dashboards/ai-costs.lvdash.json`, published by the auto-config
job) reads the same sources: `system.serving.endpoint_usage` filtered by
`usage_context['application'] = 'ai-prism'`, and `system.billing.usage`.

> **Lag:** the billing system tables arrive a few hours late, and today is always incomplete.
> New tags only appear in the rows after the deploy.

## Serverless usage policy

A **serverless usage policy** is an **account-level** object that assigns serverless usage to
a set of tags, with an optional budget. The bundle **never creates** the policy. It is shared
across workspaces, so an admin creates it once and AI Prism only receives the ID.

1. An account admin creates the policy in **Settings → Compute → Serverless usage
   policies → Manage** (in the workspace, or in the account console), with the cost tags you
   want.
2. Pass the ID to the installer:
   ```bash
   ./deploy.sh --usage-policy-id <id> DEV ai_prism
   ```
   (on Windows, `-UsagePolicyId <id>`; in the notebook, field **7. Serverless usage policy id**,
   label in Portuguese).
3. Without the ID, nothing is assigned. An invalid ID shows up in `bundle deploy`.

The policy covers the **App** and the **auto-config job**. The SQL Warehouse and Lakebase
receive their tags through their own fields, described above.

## Native bundle path (without the deploy script)

`databricks bundle deploy` alone, without `deploy.sh`, `deploy.ps1` or the notebook, works,
with one difference:

- the **resource tags** (warehouse, Lakebase, job, UC objects) are applied as usual, because
  they come from the bundle variables (`resource_tags`, `resource_tags_list`);
- the **tags in the app runtime** (`usage_context` and `query_tags`) only change when
  `AI_PRISM_RESOURCE_TAGS` in `app.yaml` is updated. The wrappers do this. On the native path
  you must edit `app.yaml` with the JSON that the auto-config job prints at the end of its log
  (the line `AVISO IMPORTANTE — tags de recurso no runtime do app`, printed in Portuguese),
  and run `databricks apps deploy` again.

Until this is done, the app keeps using only the built-in tag in the AI Gateway and the SQL
Warehouse. The job cannot make this change by itself, because it requires a new deploy of the
app code.

## Changing the tags after installation

Run the deploy again with the new tags (the process is idempotent):

```bash
./deploy.sh --tag cost_center=5678 DEV ai_prism
```

- Tags that are added or get a new value apply to **new usage**. The cost history keeps the tag
  that was valid at the time.
- A tag removed from the list is no longer sent. For UC objects, the auto-config removes it
  (`UNSET TAG`). For bundle resources, it goes away on the next update.

## References

- Deploy and installation: [docs/onboarding-deployment.md](onboarding-deployment.md)
- Runtime: `server/resourceTags.js` (rules, `usageContext`, `queryTagsFor`)
- Tests: `tests/resourceTags.test.mjs` (`node --test tests/resourceTags.test.mjs`)
- Bundle variables: `databricks.yml` (`resource_tags`, `resource_tags_list`,
  `resource_tags_json`, `serverless_usage_policy_id`, `warehouse_serverless`)
Seeded violation (W2-10 RED): English changed without updating translations.
