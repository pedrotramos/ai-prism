# AI Prism fleet governance across several installations

**English** · [Português (Brasil)](pt-BR/fleet-governance.md) · [Español](es/fleet-governance.md)

When the same organization runs AI Prism in more than one workspace (or in more than one
environment, or for more than one team), each installation is independent. It has its own app,
its own Lakebase, its own warehouse, its own catalog, and its own admins. This document defines
how to keep that set under control: who owns each installation, how to name and label the
resources, which guardrails are in the bundle, how to attribute cost, and how to retire an
installation without leaving orphan resources.

For the threat model of each installation, see [security-threat-model.md](security-threat-model.md).
For day-to-day operation, see [operations.md](operations.md).

---

## 1. Model

- **One installation = one workspace (or one environment) + one `databricks.yml` + one CLI profile.**
  No database, catalog, or admin is shared between installations.
- The bundle is **cloud-agnostic**: no host is in the file. The installation is chosen by
  `-p <PROFILE>` and `-t <target>` (`dev` or `prod`, defined in `databricks.yml`).
- The code is the same in every installation (committed artifacts). Differences between
  installations should come only from bundle variables (`--var`) and workspace resources.

---

## 2. Owner and responsible people

Each installation needs a record with these fields, kept outside the repository (a spreadsheet,
a wiki, or the organization's own resource inventory):

| Field | Expected value | Why it matters |
|---|---|---|
| Technical owner | Person who runs `bundle deploy` and receives the alerts | Answers for the rollout and the smoke test |
| Bootstrap admin | Email written to `app_admins` by the auto-config job (`ai_prism_auto_config`) | First admin; the others are added by an existing admin |
| Cost owner | Person or cost center that pays for the workspace | Receives the cost report (§5) |
| Workspace and profile | Real host and profile name | Avoids deploying to the wrong workspace |
| Deployed version | Commit SHA of the artifacts | See §3.5 |

**Owner (`APP_OWNER_EMAIL`).** The bundle does not set this variable, and `app.yaml` does not
either. Without it, no user has the owner role (`isOwner` in `server/authz.js` is false; the
function also reads `DATABRICKS_USER_EMAIL`, a local-development variable that the Apps runtime
does not set for the app). Admins come from
`app_admins`. This is a design choice of the project, not a bug, but you need to know it before
you design an approval process.

---

## 3. Names, labels and inventory

### 3.1 Names the bundle creates

| Resource | Name (target `dev`/`prod`) | Note |
|---|---|---|
| Bundle | `ai-prism` | Bundle name; the `dev` deploy uses the CLI's own development prefix |
| App | `ai-prism` | App name in the workspace; the target of `apps deploy` |
| Lakebase project | `ai-prism` (branch `production`, endpoint `primary`) | One project per installation |
| SQL Warehouse | `ai-prism` | 2X-Small, serverless |
| Auto-config job | `ai-prism-auto-config` | Runs with `bundle run` |
| Dashboards | `AI Prism — AI costs per user` and `AI Prism — Operations` | Declared in `databricks.yml` (`ai_prism_costs`, `ai_prism_ops`) |
| Catalog | `ai_prism` (default of `image_volume_catalog` and `tools_catalog`) | Shared by the UDF and the Volume inside the installation |
| Image volume | `ai_prism.default.ai_prism_images` | Bundle default |

For several installations **in the same metastore**, the `ai_prism` catalog is a conflict: a
second installation cannot create it. Set `image_volume_catalog` and `tools_catalog` to one name
per installation (for example, `ai_prism_<team>`) and pass them with `--var`.

### 3.2 Tags

The bundle tags what it creates, and the app tags its own usage. The operator passes the tags
once at deploy (`resource_tags`, `resource_tags_list`, `resource_tags_json` in `databricks.yml`;
`deploy.sh --tag k=v`). The complete guide, with the validation rules and the SQL to read the
cost by tag, is [tags.md](tags.md). In short:

| Resource or usage | Mechanism |
|---|---|
| SQL Warehouse, Lakebase project, auto-config job | tags in the bundle |
| Catalog, schema, volume, Python function of the installation | set by the auto-config job |
| AI Gateway calls | `usage_context` on every call (`server/llm.js`, `server/resourceTags.js`) |
| SQL Warehouse statements | `query_tags` on every call |
| The App itself | has no `tags` field; use a serverless usage policy ([§8](#8-databricks-app-spaces-beta)) |

Every installation carries the built-in tag `ai_prism_app=<app name>`, which cannot be
overridden, and the key `application` is reserved. Suggested keys for a fleet (they are only a
convention; the app accepts any valid key): `instance` (short name of the installation),
`environment` (`dev` or `prod`), `owner_team` (chargeback).

### 3.3 Inventory

For each installation, keep the list of resources that the bundle and the operator created.
It is the basis for decommissioning (§7). Items to record besides the table above:

- Schemas and volumes created outside the bundle (for example, the image catalog when the
  auto-config has no permission and an admin creates it by hand).
- Dashboards published by hand, with the version ID in production.
- MCP connections and MCP catalogs published by admins.

### 3.4 Versions

`GET /api/health` (behind the same authentication as the rest of `/api`) answers
`{ status, db, version, commit, uptime_s }` (`server/routes/health.js`, `server/version.js`):
`version` is the `package.json` version stamped at build time. Record the commit SHA in the
inventory (§3.3) on every `apps deploy` as well, because `version` changes only on a release.

### 3.5 Comparing installations

With the SHA recorded, `git diff <sha-A> <sha-B> -- server-dist client/dist` shows whether two
installations run the same artifact. Identical artifacts guarantee the same code, not the same
bundle configuration.

---

## 4. Bundle guardrails

The limits below are in `databricks.yml`. They are the cost and surface floor of each
installation. Changing them requires review.

| Guardrail | Value | Effect |
|---|---|---|
| Lakebase autoscaling | 0.5 to 16 CU | Capacity and cost ceiling |
| Lakebase suspension | 1800 s without use | Stops charging for idle compute |
| SQL Warehouse | 2X-Small, `max_num_clusters: 1`, auto-stop 10 min | Cost ceiling for the UDF and the UC Functions |
| OBO scopes | `user_api_scopes`, with a reason per scope | Least privilege for the APIs used |
| Access resources | `CAN_USE` on the warehouse, `CAN_CONNECT_AND_CREATE` on Lakebase | Only the app accesses these resources |
| Deploy mode | `dev` with `mode: development`; `prod` with `mode: production` | Distinguishes the production environment |
| Web search | Only with `WEB_SEARCH_CONNECTION` configured | Off by default |
| Transcription | `TRANSCRIBE_DISABLED=1` turns the feature off | Cost and data control |

**Guardrail gaps:**

- There is no per-user spend limit in the app (G4 in the threat model). Use the workspace's
  native budgets.
- The bundle never creates a serverless usage policy (it is an account-level object shared
  across workspaces). To attach an existing one to the App and the auto-config job, pass its id in
  the `serverless_usage_policy_id` variable (`deploy.sh --usage-policy-id <id>`; see
  [tags.md](tags.md#serverless-usage-policy)). Empty by default: no policy assigned.
- There is no policy on who can become admin beyond the `app_admins` table.

---

## 5. Cost attribution

Three sources, with different purposes:

| Source | What it measures | Granularity | Limitation |
|---|---|---|---|
| `system.serving.endpoint_usage` filtered by `usage_context['application']='ai-prism'` | Tokens and calls by user and endpoint | User × endpoint × day | Team attribution needs the operator's resource tags (`usage_context['<key>']`, [tags.md](tags.md)); calls made before the tags were deployed carry only the built-in ones |
| `system.billing.usage` × `list_prices` (cost dashboard) | Billed endpoint cost, split by the user's tokens | Endpoint × day, and user by approximation | The split cost is an estimate; the total is real |
| `usage_ledger` (Lakebase, per call) | Cost per call and per session, in the cost meter | Call | Stays in the app's database; does not appear in `system.*` |

**Rule for the monthly report:** the total comes from `system.billing.usage` (billed). The split
by user comes from the cost dashboard and is labeled as an allocation. Do not add `usage_ledger`
to the billed total: they are different views of the same spend.

**Infrastructure resources** (Lakebase, warehouse, job) are billed separately and carry the
operator's tags in `system.billing.usage.custom_tags` (query in [tags.md](tags.md)); the App is
attributed through its serverless usage policy (`usage_metadata.usage_policy_id`). The split by
user does not apply to them.

---

## 6. Fleet operations

- **Update:** the same sequence (bundle deploy, apps deploy, auto-config, smoke) on each
  installation, with the smoke test as a gate. Do not update all of them at once: start with a
  test installation.
- **Version drift:** compare the SHAs in the inventory (§3.4). Drift that lasts a long time is
  operational debt.
- **Incident:** the installation's owner follows the runbook in
  [operations.md](operations.md#6-runbook). Security incidents follow the
  [SECURITY.md](../SECURITY.md).
- **Admin change:** made through the UI or through `POST /api/admins`, always by an existing
  admin. Record the change in the inventory too. The app writes every admin change, and the
  deploy's first-admin grant, to its own append-only `admin_audit` trail (G8, closed in the
  [threat model](security-threat-model.md#7-declared-gaps)): `server/migrations/0007_settings_audit.up.sql:46`
  (table) and `:103-106` (RLS: only admins read, no UPDATE/DELETE policy), `server/audit.js:104`
  (`recordAdminAction`, in the mutation's transaction) and `:137` (`recordBootstrapAdminSeeds`,
  called at `server/db.js:88`), read by admins through `GET /api/admin/audit`
  (`server/db/admin.js:92`). The actor is a hash (`auditHash`, `server/audit.js:43`), never the e-mail;
  wire `APP_AUDIT_HASH_KEY` so the hash cannot be reversed by dictionary. With the key, the
  audit hash differs from the `user_hash` in the logs on purpose; to look up one person in both
  see [security-threat-model.md §6.1](security-threat-model.md#61-correlating-the-audit-trail-with-the-logs).
  Use the same key in every installation only if you need to compare trails; a different key per
  installation limits what a leaked key exposes.

---

## 7. Decommissioning

Recommended order. Items marked **(irreversible)** have no undo.

1. **Communicate** to users and set a cutoff date. There is no bulk export of conversations in the
   app: anyone who needs to keep content must do so beforehand.
2. **Freeze access:** stop the app (`databricks apps stop ai-prism -p <PROFILE>`) and confirm that
   it no longer responds.
3. **Revoke admins:** remove the `app_admins` entries (or the access of the associated groups) so
   that no administrative access survives.
4. **Export what needs to stay** before the irreversible steps: the cost ledger (`usage_ledger`),
   dashboards, and any artifact the team wants to keep.
5. **Remove the dashboard** from the workspace (and the object in the trash, if the name needs to be
   reused). The Lakeview API only has `trash`, with no restore.
6. **Remove the auto-config job and the warehouse** (`ai-prism`). Confirm that no run is in progress.
7. **Delete the Lakebase project** `ai-prism`. **(irreversible)** Deletes conversations, artifacts,
   embeddings, and the ledger. Check the platform's backup policy first.
8. **Delete the data resources:** the Volume `ai_prism_images` (with the images) and, if they were
   created only for this installation, the schema and the `ai_prism_*` catalog. **(irreversible)**
   Confirm that the catalog is not shared with another installation.
9. **Delete the app** `ai-prism` and the Python UDF (`ai_prism_python_exec`) from the schema.
10. **Confirm the cleanup:** list the bundle's resources and verify that nothing is left
    (`databricks apps list`, the Lakebase console, warehouses, and catalogs).
11. **Revoke credentials:** tokens and secrets used in the deploy, and the access of the test SP, if
    there is one.
12. **Update the inventory** and record the date and the owner of the decommissioning.
13. **Check the billing:** in `system.billing.usage`, the installation's cost should drop to zero
    after the last day of use.

*Warning:* steps 7 and 8 cannot be reversed. Do them only after confirming with the cost owner and
the data owner.

---

## 8. Databricks App Spaces (Beta)

App Spaces are a Databricks feature, in **Beta**, for governing who builds apps in a workspace
and under which limits. Everything in the first list below comes from the official
documentation: [App Spaces](https://docs.databricks.com/aws/en/dev-tools/databricks-apps/app-spaces),
[App authorization](https://docs.databricks.com/aws/en/dev-tools/databricks-apps/auth) and
[Serverless usage policies](https://docs.databricks.com/aws/en/admin/usage/budget-policies).
Beta behavior can change; read the current pages before you rely on it.

**What the documentation says**

- A workspace admin must enable **Governed agentic app-building** on the Previews page, and only
  a workspace admin can create an App Space.
- Space permissions: `CAN CREATE APP` (develop apps in the space), `CAN MANAGE` (change the
  space settings) and `CAN READ` (see the space without creating apps). The space name cannot be
  changed after creation.
- The admin sets which user-authorization (on-behalf-of) scopes the apps in the space may
  request (a new space starts from the "Data + AI" preset), and can restrict apps to a role. Role
  restrictions use account groups and need RBAC enabled at the account and workspace levels; a
  role does not grant new permissions.
- Apps in a space run under a serverless usage policy, whose tags reach
  `system.billing.usage.custom_tags`.
- Each Databricks app automatically receives its own dedicated service principal.

**How to use it with AI Prism** (our recommendation, not a platform rule)

| Question | Convention |
|---|---|
| Who creates apps? | Grant `CAN CREATE APP` on the space only to the group that operates AI Prism; everyone else gets `CAN READ` or nothing. |
| How many installations per space? | One AI Prism per space, so the space's scopes and spend policy describe exactly one installation. |
| Which identity does it run as? | The app's own service principal (one per app); never share an SP between installations. Lakebase access, the Volume and the UC grants are given to that SP only. |
| Which scopes? | Make the space's allowed scopes a superset of `user_api_scopes` in `databricks.yml` and no wider; a scope the space does not allow cannot be requested by the app. Check this after each change to either list. |
| Which spend policy? | One serverless usage policy per installation or per cost owner, passed to the bundle as `serverless_usage_policy_id` ([tags.md](tags.md#serverless-usage-policy)). Tags: [tags.md](tags.md). |
| What is not verified here? | How an app is placed into a given space by `bundle deploy` (the documentation page does not describe an assignment step) and whether the space's scope list interacts with the scopes the bundle applies. Test both in a non-production workspace before you rely on them. |

Updates to this section need a re-read of the three pages above, since the feature is in Beta.
