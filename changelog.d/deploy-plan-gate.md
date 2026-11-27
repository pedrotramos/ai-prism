### Added

- **Fail-closed `bundle plan` gate before any workspace write** (`deploy.sh`, `deploy.ps1`): the deploy runs
  `databricks bundle plan -o json` first and aborts, with nothing written to the workspace, when the plan cannot be
  obtained (the CLI stderr is shown), is not JSON, has an unexpected shape, or contains any `delete` or `recreate`.
  There is no opt-out and the scripts never use `--auto-approve` or `--force`. The checked plan is the one applied:
  the saved JSON goes to `bundle deploy --plan`, with no re-planning. A plan without `plan_version` (state still on
  Terraform) aborts and prints the complete `databricks bundle deployment migrate` command with the same `--var` of
  the deploy. The CLI must have `bundle plan` and `bundle deploy --plan` (>= 1.17, the version the installer notebook
  pins); this is checked at the start, before any workspace call. In `deploy.ps1` every captured CLI output is decoded
  as UTF-8. Documented in `docs/onboarding-deployment.md` ("The plan gate").
- **Cold Lakebase wake and one retry** (`deploy.sh`, `deploy.ps1`): before `bundle deploy`, an existing Lakebase
  endpoint that is not `ACTIVE` is woken (one authenticated Postgres handshake with your own OAuth credential, no SQL,
  no write) and awaited, best effort, up to `AI_PRISM_LAKEBASE_WAKE_TIMEOUT` seconds (default 120). If the deploy still
  fails with the exact `Failed to grant permissions ... deadline exceeded` error, the script wakes the database again,
  redoes the plan **and the gate**, and retries once with the new checked plan; any other error or a second failure
  aborts, and the retry message never claims that nothing was changed.
- **The Python UDF is only replaced when it is AI Prism's** (`bundle/auto_config.py`, `bundle/python_udf_ddl.py`,
  `scripts/gen-python-udf-ddl.mjs`): the auto-config job runs `CREATE FUNCTION` when `ai_prism_python_exec` does not
  exist, and `CREATE OR REPLACE` only when its `COMMENT` carries the AI Prism ownership marker (the head of the `COMMENT`
  every deploy writes, so a function from an earlier release is recognised). A same-named function without the marker
  fails the job with a clear message and nothing is changed. The direct grants of the function are read first and
  re-applied after a replace (`GRANT` only, never `REVOKE`); if they cannot be read the function is not replaced.
- **Tests** (`tests/neverDelete.test.mjs`, `tests/pythonUdfOwnership.test.mjs`, `tests/deployWrappers.test.mjs`): fixture
  plans with `delete`/`recreate` must abort and a clean plan proceeds (the `deploy.sh` gate is executed for real against a
  fake CLI; `deploy.sh` and `deploy.ps1` are both run end to end in the wrapper suite), the cold-Lakebase retry goes through
  the gate again, and the UDF ownership guard runs for real against a fake `spark`.

### Deploy notes

- `deploy.sh`/`deploy.ps1` now need Databricks CLI >= 1.17 and stop when `bundle plan` reports any `delete`/`recreate`.
  A CLI < 1.20 with Terraform state: run the `databricks bundle deployment migrate ...` command the script prints, then
  deploy again (CLI >= 1.20 migrates the state by itself).
- A function named `ai_prism_python_exec` that AI Prism did not create now fails the auto-config job instead of being
  overwritten: rename or remove it, or deploy with another catalog/schema.
