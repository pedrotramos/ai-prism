### Added

- **Fail-closed `bundle plan` gate before any workspace write** (`deploy.sh`, `deploy.ps1`): the deploy runs
  `databricks bundle plan -o json` first and aborts, with nothing written to the workspace, when the plan cannot be
  obtained (the CLI stderr is shown), is not JSON, has an unexpected shape, has a `plan_version` that is not a supported
  number (`2`), contains any `delete` or `recreate`, or contains **any action outside an allowlist** (`create`, `skip`,
  `update` and the in-place `update_id` and `resize`; an empty, unknown, differently-cased or newer-CLI action stops the
  deploy and is listed). There is no opt-out and the scripts never use `--auto-approve` or `--force`. The checked plan is
  the one applied: the saved JSON goes to `bundle deploy --plan`, with no re-planning. When the gate stops, the message
  prints the exact `databricks bundle plan` command (same target, profile and `--var`) to review the refused plan. A plan
  without `plan_version` (state still on Terraform) aborts and prints the complete `databricks bundle deployment migrate`
  command with the same `--var` of the deploy. The CLI must have `bundle plan` and `bundle deploy --plan` (>= 1.17, the
  version the installer notebook pins); this is checked at the start, before any workspace call. In `deploy.ps1` every
  captured CLI output is decoded as UTF-8. `bundle deploy` still prunes the files it synchronises. Documented in
  `docs/onboarding-deployment.md` ("The plan gate").
- **Cold Lakebase wake and one retry** (`deploy.sh`, `deploy.ps1`): before `bundle deploy`, an existing Lakebase
  endpoint that is not `ACTIVE` is woken (one authenticated Postgres handshake with your own OAuth credential, no SQL,
  no write) and awaited, best effort. The whole wake (every CLI call, the TCP connect, the TLS handshake, every read and
  the polling) shares one monotonic deadline, `AI_PRISM_LAKEBASE_WAKE_TIMEOUT` seconds (default 120); a stalled API or peer
  is cut at that deadline, which warns and goes on. If the deploy still fails with the exact `Failed to grant permissions
  ... deadline exceeded` error, the script wakes the database again, redoes the plan **and the gate**, and retries once with
  the new checked plan; any other error or a second failure aborts, and the retry message never claims that nothing was
  changed.
- **The Python UDF is only replaced when this deployment owns it** (`bundle/auto_config.py`, `bundle/python_udf_ddl.py`,
  `scripts/gen-python-udf-ddl.mjs`, `databricks.yml`): the auto-config job runs `CREATE FUNCTION` when
  `ai_prism_python_exec` does not exist and records the owner at the end of the function's `COMMENT`
  (`[ai-prism-owner v1 app=... target=... install=<random id> fn=<catalog.schema.name>]`); it runs `CREATE OR REPLACE` only
  when that record names exactly this app, bundle target and function. The descriptive text of the `COMMENT` is never
  trusted (a fork ships the same one). A function without a record, from an earlier release, is adopted only when its
  signature and the sha256 of its body match a definition AI Prism has shipped; anything else, including a function
  recorded for another deployment, fails the job with the function id, owner and the decision to take, and nothing is
  changed. The direct grants of the function are read first and re-applied after a replace (`GRANT` only, never `REVOKE`);
  if they cannot be read the function is not replaced. New job parameter `bundle_target`.
- **Tests** (`tests/neverDelete.test.mjs`, `tests/pythonUdfOwnership.test.mjs`, `tests/deployWrappers.test.mjs`): fixture
  plans with `delete`/`recreate`, unknown, empty or differently-cased actions, mixed valid/invalid entries and invalid
  `plan_version` values must abort with no workspace command, and a clean plan proceeds (the `deploy.sh` gate is executed
  for real against a fake CLI; `deploy.sh` and `deploy.ps1` are both run end to end in the wrapper suite); the
  cold-Lakebase retry goes through the gate again; a stalled CLI call or Postgres peer is cut by the wake deadline in both
  shells; and the UDF ownership guard runs for real against a fake `spark` and a fake SDK (another deployment's function
  with the same comment is not replaced).

### Changed

- **The app no longer creates or replaces the Python UDF at runtime** (`server/tools.ts`): the first turn used to run
  `CREATE OR REPLACE FUNCTION` with the user's token, which bypassed the ownership guard and could drop the function's
  grants on every restart. `ensureBuiltinPythonTool` now only checks that the function exists (`DESCRIBE FUNCTION`) and,
  if it does not, reports that the auto-config job has to run (`./deploy.sh` again). The deploy job is the only writer.

### Deploy notes

- `deploy.sh`/`deploy.ps1` now need Databricks CLI >= 1.17 and stop when `bundle plan` reports any `delete`/`recreate`.
  A CLI < 1.20 with Terraform state: run the `databricks bundle deployment migrate ...` command the script prints, then
  deploy again (CLI >= 1.20 migrates the state by itself).
- A function named `ai_prism_python_exec` that this deployment did not create now fails the auto-config job instead of
  being overwritten: `DROP FUNCTION` it yourself if you do not need it, or deploy with another catalog/schema. A function
  created by an earlier AI Prism release is adopted automatically (its body is recognised). The app no longer creates the
  function: if it is missing, run `./deploy.sh` again.
