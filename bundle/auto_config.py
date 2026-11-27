# Databricks notebook source
# AI Prism — post-deploy auto-configuration.
#
# Runs as a bundle job task right after `databricks bundle deploy`. Its job is to
# make a fresh workspace "just work" with zero manual infra steps:
#
#   1. Discover the deploying user's email (the job runs as them) and the
#      workspace host — these become APP_OWNER_EMAIL (bootstrap admin) and the
#      base URL, so no one has to hand-edit app.yaml.
#   2. Provision the built-in Python UDF (ai_prism_python_exec) in the configured
#      catalog/schema, so the "execute_python" tool works on the very first turn
#      instead of being created lazily. The DDL comes from bundle/python_udf_ddl.py,
#      generated from shared/pythonUdf.js. A function with that name that this
#      deployment does not own (no ownership record for this app + target, and not
#      an AI Prism definition) is never replaced: the job fails. The app does not
#      create or replace it at runtime; this job is the only writer.
#   3. Tag the Unity Catalog objects this job creates (catalog/schema/volume/
#      UDF) with the operator's resource tags, and keep them in sync on redeploy.
#   4. Print a summary of the resolved config (warehouse id, Lakebase host/db)
#      that the operator can paste if they ever need to inspect it.
#
# Everything here is idempotent — safe to re-run on every deploy.

# COMMAND ----------

dbutils.widgets.text("catalog", "main", "Tools catalog")
dbutils.widgets.text("schema", "default", "Tools schema")
dbutils.widgets.text("warehouse_id", "", "SQL Warehouse id")
dbutils.widgets.text("lakebase_host", "", "Lakebase read/write host")
dbutils.widgets.text("lakebase_db", "databricks_postgres", "Lakebase database")
dbutils.widgets.text("app_name", "ai-prism", "Databricks App name")
dbutils.widgets.text("bundle_target", "default", "Bundle target (deployment id, part of the UDF ownership record)")
dbutils.widgets.text("dashboard_id", "", "AI/BI cost dashboard id")
dbutils.widgets.text("image_volume_catalog", "ai_prism", "Image store catalog")
dbutils.widgets.text("image_volume_schema", "default", "Image store schema")
dbutils.widgets.text("image_volume_name", "ai_prism_images", "Image store volume")
dbutils.widgets.text("app_sp_client_id", "", "App service principal client id")
dbutils.widgets.text("lakebase_port", "5432", "Lakebase port")
dbutils.widgets.text("lakebase_endpoint", "", "Lakebase endpoint path (projects/../branches/../endpoints/..)")
dbutils.widgets.text("resource_tags_json", "{}", "Resource tags (JSON)")

catalog = dbutils.widgets.get("catalog").strip() or "main"
schema = dbutils.widgets.get("schema").strip() or "default"
warehouse_id = dbutils.widgets.get("warehouse_id").strip()
lakebase_host = dbutils.widgets.get("lakebase_host").strip()
lakebase_db = dbutils.widgets.get("lakebase_db").strip() or "databricks_postgres"
app_name = dbutils.widgets.get("app_name").strip() or "ai-prism"
bundle_target = dbutils.widgets.get("bundle_target").strip() or "default"
dashboard_id = dbutils.widgets.get("dashboard_id").strip()
image_catalog = dbutils.widgets.get("image_volume_catalog").strip() or "ai_prism"
image_schema = dbutils.widgets.get("image_volume_schema").strip() or "default"
image_volume = dbutils.widgets.get("image_volume_name").strip() or "ai_prism_images"
app_sp_client_id = dbutils.widgets.get("app_sp_client_id").strip()
lakebase_port = dbutils.widgets.get("lakebase_port").strip() or "5432"
lakebase_endpoint = dbutils.widgets.get("lakebase_endpoint").strip()

# Resource tags, JSON (a notebook parameter is always a string; databricks.yml
# explains why resource_tags is not passed directly). Always carries the built-in
# ai_prism_app tag — see server/resourceTags.js for the same rule at app runtime.
#
# This job is the one place EVERY deploy passes through (native `bundle deploy`
# or the deploy.sh/deploy.ps1/notebook wrappers), so validation lives here too:
# same charset as server/resourceTags.js (Unicode letters/digits, _, + - = . : / @,
# spaces; up to 255 chars), at most 24 operator tags (+ ai_prism_app = 25, the
# Jobs API limit), and ai_prism_app is always re-imposed AFTER the operator tags.
import json as _json
import re as _re
import uuid as _uuid

_TAG_RE = _re.compile(r"^[\w+\-=.:/@ ]{1,255}$", _re.UNICODE)
_MAX_RESOURCE_TAGS = 24
_RESERVED_TAG_KEY = "ai_prism_app"


def _normalize_resource_tags(raw, app_tag_value, max_tags=_MAX_RESOURCE_TAGS):
    tags = {}
    seen_lower = set()
    if isinstance(raw, dict):
        for k, v in raw.items():
            if not isinstance(k, str):
                print(f"AVISO: chave de tag não-texto ignorada: {k!r}.")
                continue
            # Case-insensitive comparison: the PowerShell wrapper treats hashtable
            # keys case-insensitively, so "AI_PRISM_APP" must not slip through as a
            # normal tag here and collide with the built-in one on Windows.
            lower = k.lower()
            sv = "" if v is None else str(v)
            if lower == _RESERVED_TAG_KEY:
                # The wrappers always write ai_prism_app=<app name> here; that is
                # the normal mechanism, not an override attempt, so only warn when
                # the value actually differs.
                if sv != app_tag_value:
                    print(f"AVISO: a tag {k!r} é reservada (ai_prism_app, embutida) e não pode ser sobrescrita; valor informado ignorado.")
                continue
            if not _TAG_RE.match(k):
                print(f"AVISO: chave de tag inválida {k!r} ignorada: use só letras, números, espaço e + - = . : / @ (até 255 caracteres).")
                continue
            if sv and not _TAG_RE.match(sv):
                print(f"AVISO: valor de tag inválido para {k!r} ({sv!r}) ignorado: use só letras, números, espaço e + - = . : / @ (até 255 caracteres).")
                continue
            if lower in seen_lower:
                print(f"AVISO: chave de tag {k!r} difere de outra tag já aceita só pela caixa (maiúsculas/minúsculas); mantendo só a primeira.")
                continue
            if len(tags) >= max_tags:
                print(f"AVISO: mais de {max_tags} tags de operador; {k!r} e as seguintes foram ignoradas.")
                break
            tags[k] = sv
            seen_lower.add(lower)
    else:
        print("AVISO: resource_tags_json não é um objeto JSON; seguindo sem tags do operador.")
    tags[_RESERVED_TAG_KEY] = app_tag_value
    return tags


try:
    _raw_resource_tags = _json.loads(dbutils.widgets.get("resource_tags_json").strip() or "{}")
except Exception as e:
    print(f"AVISO: resource_tags_json inválido ({e}); seguindo sem tags do operador.")
    _raw_resource_tags = {}
resource_tags = _normalize_resource_tags(_raw_resource_tags, app_name)


def _sql_quote_literal(s):
    """Escapes a SQL string literal ('...'): doubles single quotes."""
    return str(s).replace("'", "''")


def _sql_quote_ident(s):
    """Escapes an identifier between backticks (`...`): doubles backticks."""
    return str(s).replace("`", "``")


def _mask_email(email):
    """The job-log form of an e-mail (W2-17, AC-3): first character of the local
    part + '***@' + the domain, e.g. 'd***@example.com', so the deployer still
    recognizes themselves without the address landing in clear in the job output
    (the app's logs drop e-mails entirely: server/log.js redact())."""
    e = str(email or "").strip()
    if not e:
        return "(unknown)"
    local, sep, domain = e.partition("@")
    if not sep:
        return (local[:1] or "?") + "***"
    return (local[:1] or "?") + "***@" + domain

# COMMAND ----------

# The deploying user — the job runs on-behalf-of whoever ran `bundle deploy`.
deployer_email = (
    spark.sql("SELECT current_user() AS u").collect()[0]["u"] or ""
).strip().lower()

workspace_host = (
    spark.conf.get("spark.databricks.workspaceUrl", "") or ""
).strip()
if workspace_host and not workspace_host.startswith("http"):
    workspace_host = "https://" + workspace_host

# every print of the deployer uses this masked form, never deployer_email itself
# (tests/autoConfigSeedLog.test.mjs)
deployer_display = _mask_email(deployer_email)

print(f"Deployer (bootstrap admin): {deployer_display}")
print(f"Workspace host:             {workspace_host}")
print(f"Tools catalog.schema:       {catalog}.{schema}")
print(f"SQL Warehouse id:           {warehouse_id or '(not provided)'}")
print(f"Lakebase host / db:         {lakebase_host or '(not provided)'} / {lakebase_db}")

# COMMAND ----------

def ensure_catalog(cat, comment=None):
    """Make sure catalog `cat` exists, tolerating a deployer WITHOUT metastore
    CREATE CATALOG. `CREATE CATALOG IF NOT EXISTS` still checks that privilege
    even when the catalog already exists, which fails on shared metastores (e.g.
    an FE Vending Machine workspace, where the deployer only owns a pre-created
    catalog). So: if the catalog is already there, skip the CREATE entirely and
    just use it (the schema/volume DDL below only needs privileges ON the
    catalog, which the owner has). Only attempt CREATE when it's genuinely
    missing — there a real permission error should surface loudly.

    Returns True iff THIS call created the catalog. The caller only tags a catalog
    it created: a pre-existing shared catalog (e.g. "main", or the FEVM
    vendinha_do_seu_ze_catalog) belongs to other teams and is never tagged here."""
    exists = spark.sql(f"SHOW CATALOGS LIKE '{cat}'").count() > 0
    if exists:
        print(f"Catalog {cat} already exists — using it (skipping CREATE CATALOG)")
        return False
    ddl = f"CREATE CATALOG IF NOT EXISTS `{cat}`"
    if comment:
        ddl += f" COMMENT '{comment}'"
    spark.sql(ddl)
    print(f"Created catalog {cat}")
    return True


# Resource tags on the UC objects this job creates or touches. Best-effort and
# IDEMPOTENT on purpose: a shared catalog can belong to someone else (no APPLY TAG
# -> 403), and that must NEVER fail the deploy, only warn.
#
# `owned=True` (the default, the only mode used today) re-imposes the CURRENT value
# of every operator tag (never keeps an old value, even one this same job set on a
# previous deploy) and UNSETs every key that existed before but has left the
# operator's config. `owned=False` keeps the conservative behaviour for an object
# that is not ours: never overwrite a different existing value, never remove.
#
# Each key goes in its own ALTER: a workspace tag policy that rejects one value
# (e.g. cost_center restricted to an allow-list) would otherwise reject the WHOLE
# statement, including the built-in ai_prism_app tag. The built-in tag is tried
# first and isolated from the rest.
_TAG_VIEW = {
    "CATALOG": ("catalog_tags", ["catalog_name"]),
    "SCHEMA": ("schema_tags", ["catalog_name", "schema_name"]),
    "VOLUME": ("volume_tags", ["catalog_name", "schema_name", "volume_name"]),
}


def _existing_tags(view, where_cols):
    try:
        catalog_for_scope = where_cols[0][1]
        clause = " AND ".join(f"{col} = '{_sql_quote_literal(val)}'" for col, val in where_cols)
        rows = spark.sql(
            f"SELECT tag_name, tag_value FROM `{catalog_for_scope}`.information_schema.{view} WHERE {clause}"
        ).collect()
        return {r["tag_name"]: r["tag_value"] for r in rows}
    except Exception:
        return {}


def _filter_conflicting_tags(existing, tags, label):
    safe = {}
    for k, v in tags.items():
        old = existing.get(k)
        if old is not None and old != v:
            print(f"AVISO: {label} já tem a tag {k!r}={old!r} (valor diferente, provavelmente de outro time/ferramenta); "
                  f"mantendo o valor existente, NÃO sobrescrevendo com {v!r}.")
            continue
        safe[k] = v
    return safe


def tag_object(kind, parts, tags, owned=True):
    if not tags and owned is False:
        return
    fq_name = ".".join(f"`{p}`" for p in parts)
    label = f"{kind} {'.'.join(parts)}"
    view, cols = _TAG_VIEW[kind]
    existing = _existing_tags(view, list(zip(cols, parts)))
    if owned:
        safe_tags = dict(tags)
        stale_keys = [k for k in existing if k not in tags]
    else:
        safe_tags = _filter_conflicting_tags(existing, tags, label)
        stale_keys = []
    if not safe_tags and not stale_keys:
        return
    ordered_keys = ([_RESERVED_TAG_KEY] if _RESERVED_TAG_KEY in safe_tags else []) + [
        k for k in safe_tags if k != _RESERVED_TAG_KEY
    ]
    ok = {}
    for k in ordered_keys:
        v = safe_tags[k]
        clause = f"'{_sql_quote_literal(k)}' = '{_sql_quote_literal(v)}'"
        try:
            spark.sql(f"ALTER {kind} {fq_name} SET TAGS ({clause})")
            ok[k] = v
        except Exception as e:
            print(f"AVISO: não foi possível marcar a tag {k!r}={v!r} em {kind} {fq_name} ({e}); "
                  "seguindo sem ela (dono diferente, falta de APPLY TAG, tag policy do workspace "
                  "não permitindo esse valor, ou runtime sem suporte) — as outras tags deste objeto não são afetadas.")
    removed = []
    for k in stale_keys:
        qk = _sql_quote_ident(k)
        try:
            spark.sql(f"UNSET TAG ON {kind} {fq_name} `{qk}`")
            removed.append(k)
        except Exception as e:
            print(f"AVISO: não foi possível remover a tag {k!r} (saiu da config do operador) de {kind} {fq_name} "
                  f"({e}); requer Databricks Runtime 16.1+ e APPLY TAG — a tag antiga pode ter ficado no objeto.")
    if ok:
        print(f"Tags aplicadas em {kind} {fq_name}: {ok}")
    if removed:
        print(f"Tags removidas (saíram da config do operador) em {kind} {fq_name}: {removed}")


# Function tagging uses a DIFFERENT syntax (SET TAG ON FUNCTION, one tag per
# statement, backticked identifiers) and needs Databricks Runtime 18.1+; older
# workspaces simply lack it. Same posture: warn, don't fail.
#
# UNSET before SET: SET TAG ON FUNCTION fails if the key is already set, so a
# redeploy that changes a value would otherwise keep the old one.
def tag_function(fq_name, tags, catalog=None, schema=None, owned=True):
    if not tags and owned is False:
        return
    existing = {}
    if catalog and schema:
        try:
            rows = spark.sql(
                f"SELECT tag_name, tag_value FROM `{catalog}`.information_schema.routine_tags "
                f"WHERE specific_schema = '{_sql_quote_literal(schema)}' "
                f"AND specific_name = '{_sql_quote_literal(fq_name.rsplit('.', 1)[-1])}'"
            ).collect()
            existing = {r["tag_name"]: r["tag_value"] for r in rows}
        except Exception:
            existing = {}
    if owned:
        safe_tags = dict(tags)
        stale_keys = [k for k in existing if k not in tags]
    else:
        safe_tags = _filter_conflicting_tags(existing, tags, f"FUNCTION {fq_name}")
        stale_keys = []
    ok = []
    for k, v in safe_tags.items():
        qk, qv = _sql_quote_ident(k), _sql_quote_ident(v)
        try:
            spark.sql(f"UNSET TAG ON FUNCTION {fq_name} `{qk}`")
        except Exception:
            pass  # tag did not exist on this function yet — SET below creates it
        try:
            spark.sql(f"SET TAG ON FUNCTION {fq_name} `{qk}` = `{qv}`")
            ok.append(k)
        except Exception as e:
            print(f"AVISO: não foi possível marcar a tag {k!r} na function {fq_name} ({e}); "
                  "requer Databricks Runtime 18.1+ e APPLY TAG na function.")
    removed = []
    for k in stale_keys:
        qk = _sql_quote_ident(k)
        try:
            spark.sql(f"UNSET TAG ON FUNCTION {fq_name} `{qk}`")
            removed.append(k)
        except Exception as e:
            print(f"AVISO: não foi possível remover a tag {k!r} (saiu da config do operador) da function "
                  f"{fq_name} ({e}).")
    if ok:
        print(f"Tags aplicadas em FUNCTION {fq_name}: {ok}")
    if removed:
        print(f"Tags removidas (saíram da config do operador) em FUNCTION {fq_name}: {removed}")

# COMMAND ----------

# Provision the built-in Python UDF. The DDL is generated from the single source
# of truth (shared/pythonUdf.js) into bundle/python_udf_ddl.py, so what is deployed
# here is exactly what the tests pin. The app does NOT create or replace it at
# runtime (server/tools.ts only checks that it exists): this job is the only writer.
from python_udf_ddl import (  # noqa: E402
    python_udf_ddl, body_sha256, KNOWN_BODY_SHA256, UDF_SIGNATURE,
)

# Deploy rule: never replace what is not ours. "Ours" is a RECORD of this deployment
# kept with the function: the COMMENT ends with
#     [ai-prism-owner v1 app=<app> target=<bundle target> install=<random id> fn=<catalog.schema.name>]
# written by the CREATE/REPLACE below, compared EXACTLY (app, target and the function's
# own Unity Catalog name) before any replace; the random install id is generated when the
# deployment first creates the function and reused on every replace. The descriptive part
# of the COMMENT proves nothing and is never consulted (another project, e.g. a fork, ships
# the same text under the same function name).
# A function WITHOUT a record (created by an earlier AI Prism, or by someone else) is
# adopted only when its signature AND its body (sha256, whitespace-normalised) are one
# AI Prism has shipped. Anything else, and any function recorded for another deployment,
# FAILS the job with the decision the operator has to take; nothing is changed.
_OWNER_TAG_RE = _re.compile(
    r"\[ai-prism-owner v1 app=([A-Za-z0-9_.-]+) target=([A-Za-z0-9_.-]+) install=([0-9a-f]{32}) fn=([A-Za-z0-9_.-]+)\]\s*$"
)
_OWNER_FIELD_RE = _re.compile(r"^[A-Za-z0-9_.-]+$")


def _owner_tag(app, target, install, fq_name):
    for label, value in (("app name", app), ("bundle target", target), ("function name", fq_name)):
        if not _OWNER_FIELD_RE.match(value or ""):
            raise RuntimeError(
                f"cannot record the ownership of {fq_name}: the {label} {value!r} has characters outside "
                "[A-Za-z0-9_.-]. Use plain names for the app, the bundle target and the catalog/schema."
            )
    return f"[ai-prism-owner v1 app={app} target={target} install={install} fn={fq_name}]"


def _enum_text(value):
    return str(getattr(value, "value", value) or "")


def _matches_known_definition(info):
    """True when the function has AI Prism's signature AND one of the bodies AI Prism has shipped."""
    params = [(str(p.name), str(p.type_text or "").lower())
              for p in ((getattr(info.input_params, "parameters", None) or []) if info.input_params else [])]
    if tuple(params) != UDF_SIGNATURE or _enum_text(info.data_type).upper() != "STRING":
        return False
    if _enum_text(info.external_language).upper() != "PYTHON":
        return False
    return bool(info.routine_definition) and body_sha256(info.routine_definition) in KNOWN_BODY_SHA256


def _refuse_udf(fq_name, info, why):
    raise RuntimeError(
        f"a function {fq_name} already exists and {why}. The deploy never replaces what is not its own, so "
        f"nothing was changed (function_id {getattr(info, 'function_id', '?')}, owner {getattr(info, 'owner', '?')}, "
        f"created by {getattr(info, 'created_by', '?')}). Decide what that function is: if it is not needed, run "
        f"`DROP FUNCTION {fq_name}` yourself and deploy again (it will be created and recorded for this "
        "deployment); if another deployment or project uses it, point this one to another schema "
        "(tools_schema / TOOLS_SCHEMA) and deploy again."
    )


def _udf_direct_grants(fq_name):
    """(principal, privilege) of the direct grants on the function (no OWN: the owner does not grant itself)."""
    out = set()
    for r in spark.sql(f"SHOW GRANTS ON FUNCTION {fq_name}").collect():
        principal, action = str(r[0]), str(r[1])
        object_type = str(r[2]).upper() if len(r) > 2 else "FUNCTION"
        if object_type == "FUNCTION" and action.upper() not in ("OWN", "OWNERSHIP"):
            out.add((principal, action))
    return out


def provision_python_udf(fq_name, app, target, workspace_client=None):
    """Create the UDF if it does not exist; replace it only if this deployment owns it (see above); else raise RuntimeError."""
    from databricks.sdk import WorkspaceClient
    from databricks.sdk.errors import NotFound
    w = workspace_client or WorkspaceClient()
    try:
        info = w.functions.get(name=fq_name)
    except NotFound:
        info = None  # any other error (permission, network) stops the job: absence is never assumed
    if info is None:
        tag = _owner_tag(app, target, _uuid.uuid4().hex, fq_name)
        spark.sql(python_udf_ddl(fq_name, replace=False, owner_tag=tag))
        print(f"Created UDF: {fq_name}")
        return
    recorded = _OWNER_TAG_RE.search(info.comment or "")
    if recorded:
        r_app, r_target, install, r_fn = recorded.groups()
        if (r_app, r_target, r_fn.lower()) != (app, target, fq_name.lower()):
            _refuse_udf(fq_name, info, f"is recorded as belonging to another deployment (app {r_app}, target {r_target}, "
                                      f"function {r_fn}, install {install})")
    elif _matches_known_definition(info):
        install = _uuid.uuid4().hex
        print(f"Adopting {fq_name}: it has no ownership record, but its signature and body are AI Prism's own.")
    else:
        _refuse_udf(fq_name, info, "has no AI Prism ownership record and its signature or body is not one AI Prism has shipped")
    tag = _owner_tag(app, target, install, fq_name)
    # CREATE OR REPLACE FUNCTION may drop the function's direct grants (e.g. a GRANT EXECUTE an
    # admin gave a group). Read them first and re-apply them afterwards: GRANT only, never REVOKE.
    # If they cannot be read, do NOT replace (fail).
    before = _udf_direct_grants(fq_name)
    spark.sql(python_udf_ddl(fq_name, replace=True, owner_tag=tag))
    print(f"Updated UDF (owned by this deployment, install {install}): {fq_name}")
    missing = before - _udf_direct_grants(fq_name)
    for principal, action in sorted(missing):
        try:
            spark.sql(f"GRANT {action} ON FUNCTION {fq_name} TO `{principal.replace(chr(96), chr(96) * 2)}`")
            print(f"Re-granted {action} on {fq_name} to {principal}")
        except Exception as e:
            print(f"WARNING: could not re-apply {action} on {fq_name} for {principal} ({e}); re-apply it by hand.")


fq_name = f"{catalog}.{schema}.ai_prism_python_exec"
catalog_created = ensure_catalog(catalog)
spark.sql(f"CREATE SCHEMA IF NOT EXISTS {catalog}.{schema}")
provision_python_udf(fq_name, app_name, bundle_target)
print(f"Provisioned UDF: {fq_name}")

# Smoke-test it so a broken deploy fails loudly here, not on a user's first turn.
check = spark.sql(
    f"SELECT {fq_name}('result = 6 * 7') AS out"
).collect()[0]["out"]
assert check.strip() == "42", f"UDF smoke test failed: got {check!r}"
print(f"UDF smoke test OK (6*7 = {check.strip()})")

# Tag the objects this job owns. The catalog is tagged only when this run created
# it; a pre-existing catalog (e.g. a shared one on an FEVM workspace) is left alone.
if catalog_created:
    tag_object("CATALOG", (catalog,), resource_tags, owned=True)
else:
    print(f"Catalog {catalog} already existed before this deploy — not tagging it (only catalogs we create get tags).")
tag_object("SCHEMA", (catalog, schema), resource_tags, owned=True)
tag_function(fq_name, resource_tags, catalog=catalog, schema=schema, owned=True)

# COMMAND ----------

# Provision the DEDICATED image store (own catalog, kept separate from the tools
# catalog so AI Prism's generated images never mix with other workspace assets)
# and grant the app service principal the volume privileges it needs. The app
# writes/reads image bytes as its SP (not per-user OBO), so it must hold
# READ/WRITE VOLUME here; per-user isolation stays app-level (user_email).
# Idempotent — safe on every deploy.
image_catalog_created = ensure_catalog(image_catalog, comment="AI Prism app-owned storage (generated images, etc.)")
spark.sql(f"CREATE SCHEMA IF NOT EXISTS `{image_catalog}`.`{image_schema}`")
spark.sql(f"CREATE VOLUME IF NOT EXISTS `{image_catalog}`.`{image_schema}`.`{image_volume}`")
print(f"Provisioned image volume: {image_catalog}.{image_schema}.{image_volume}")

if image_catalog_created:
    tag_object("CATALOG", (image_catalog,), resource_tags, owned=True)
else:
    print(f"Catalog {image_catalog} already existed before this deploy — not tagging it.")
tag_object("SCHEMA", (image_catalog, image_schema), resource_tags, owned=True)
tag_object("VOLUME", (image_catalog, image_schema, image_volume), resource_tags, owned=True)

if app_sp_client_id:
    spark.sql(f"GRANT USE CATALOG ON CATALOG `{image_catalog}` TO `{app_sp_client_id}`")
    spark.sql(f"GRANT USE SCHEMA, CREATE VOLUME, READ VOLUME, WRITE VOLUME "
              f"ON SCHEMA `{image_catalog}`.`{image_schema}` TO `{app_sp_client_id}`")
    print(f"Granted image-store privileges to app SP {app_sp_client_id}")
else:
    print("WARNING: no app_sp_client_id provided — grant READ/WRITE VOLUME on "
          f"{image_catalog}.{image_schema} to the app service principal manually.")

# COMMAND ----------

# Provision the Lakebase Postgres ROLE for the app's service principal, so the
# app can connect to Lakebase as itself (app authorization — the app uses its SP
# OAuth token as the PG password; per-user isolation stays app-level via the
# user_email WHERE clauses). WITHOUT this role the app's SP has no PG login and
# the whole schema never gets created (0 tables) — and because ensureSchema runs
# on the first request, EVERY authenticated call fails at the DB with SQLSTATE
# 28000, surfaced to the user as "External authorization failed".
#
# This runs as the DEPLOYER. The Lakebase "Autoscaling" product
# (projects/branches/endpoints) has no REST roles API; the supported mechanism is
# the `databricks_auth` extension's `databricks_create_role(identity, type)`
# function, run over SQL. The app SP's table GRANTs are applied by the deploying
# identity (`node scripts/migrate.mjs grants`, run by deploy.sh/deploy.ps1 after
# the smoke), and they only work once this role exists — so we create it here,
# idempotently, and prepare the owner hand-off right after.
# Kept byte-identical to PREPARE_HANDOFF_SQL in server/db/grants.js (checked by
# server/schemaAiPrism.test.js): change both or neither.
_OWNER_ROLE = "ai_prism_owner"
PREPARE_HANDOFF_SQL = r"""
DO $prepare$
DECLARE
  owner_role text := coalesce(nullif(current_setting('ai_prism.owner_role', true), ''), 'ai_prism_owner');
  app_role text := nullif(current_setting('ai_prism.app_role', true), '');
  app_tables text[] := ARRAY['app_admins', 'app_mcp_catalog', 'app_tool_policy', 'chat_compactions', 'chat_decks',
    'chat_documents', 'chat_genie_conversations', 'chat_images', 'chat_message_embeddings', 'chat_messages',
    'chat_sessions', 'chat_spreadsheets', 'chat_tool_calls', 'deck_templates', 'model_catalog_overrides',
    'schema_migrations', 'skills', 'usage_ledger', 'user_image_model_selection', 'user_mcp_connections',
    'user_template_selection'];
  t record;
BEGIN
  IF app_role IS NULL OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app_role) THEN
    RAISE EXCEPTION 'prepare: the app role % does not exist (create it first: databricks_create_role)', coalesce(app_role, '(unset)')
      USING ERRCODE = '42704';
  END IF;
  IF app_role = current_user THEN
    RAISE EXCEPTION 'prepare: run it as the database owner, not as the app role %', app_role USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = owner_role) THEN
    EXECUTE format('CREATE ROLE %I NOLOGIN', owner_role);
  END IF;
  EXECUTE format('GRANT %I TO CURRENT_USER WITH INHERIT TRUE, SET TRUE', owner_role);
  EXECUTE format('GRANT CREATE ON DATABASE %I TO %I', current_database(), owner_role);
  EXECUTE format('GRANT USAGE, CREATE ON SCHEMA public TO %I', owner_role);
  FOR t IN
    SELECT n.nspname, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind IN ('r', 'p') AND n.nspname IN ('public', 'ai_prism') AND c.relname = ANY (app_tables)
       AND c.relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
  LOOP
    EXECUTE format('ALTER TABLE %I.%I OWNER TO %I', t.nspname, t.relname, owner_role);
  END LOOP;
  -- the SP's membership is opened only by the deploy wrapper (migrate.mjs prepare),
  -- which also closes it; the auto-config job sets ai_prism.open_handoff = off
  IF coalesce(nullif(current_setting('ai_prism.open_handoff', true), ''), 'on') = 'on' THEN
    EXECUTE format('GRANT %I TO %I WITH INHERIT TRUE, SET TRUE', owner_role, app_role);
  END IF;
END
$prepare$;
"""

if lakebase_host and app_sp_client_id and lakebase_endpoint:
    # psycopg2-binary is pinned. On this job's serverless task it is pre-installed by
    # the job Environment (databricks.yml, resources.jobs.*.environments), so no
    # runtime pip call happens. A runtime `pip install` without a pin SIGABRT'd on
    # import in some serverless runs (a libpq/wheel mismatch that a retry masked), so
    # the classic-cluster path (deploy.sh/deploy.ps1 CLASSIC_CLUSTER_ID, which submits
    # the task without environment_key) keeps a runtime fallback with the SAME pin,
    # retried once for an ordinary pip failure.
    _PSYCOPG2_PIN = "psycopg2-binary==2.9.10"
    try:
        import psycopg2  # pre-installed: serverless (job Environment) or classic (cluster library)
    except ImportError:
        import subprocess, sys as _sys
        _last_err = None
        for _attempt in (1, 2):
            try:
                subprocess.check_call([_sys.executable, "-m", "pip", "install", "-q", _PSYCOPG2_PIN])
                import psycopg2
                _last_err = None
                break
            except Exception as _e:
                _last_err = _e
        if _last_err is not None:
            raise RuntimeError(
                f"could not install/import {_PSYCOPG2_PIN} after 2 attempts: {_last_err}"
            ) from _last_err

    # Lakebase requires an OAuth JWT as the PG password. The notebook's runtime
    # auth can't mint one directly (config.oauth_token() isn't available under
    # runtime auth), so we use the Lakebase credentials API, which returns a
    # short-lived JWT scoped to the endpoint — connecting as the deployer, whose
    # identity-federated PG login auto-exists on first connect.
    from databricks.sdk import WorkspaceClient
    _w = WorkspaceClient()
    _cred = _w.api_client.do(
        "POST", "/api/2.0/postgres/credentials",
        body={"endpoint": lakebase_endpoint},
    )
    pg_token = _cred["token"]

    conn = psycopg2.connect(
        host=lakebase_host,
        port=int(lakebase_port),
        dbname=lakebase_db,
        user=deployer_email,
        password=pg_token,
        sslmode="require",
        connect_timeout=30,
    )
    conn.autocommit = True
    try:
        with conn.cursor() as cur:
            cur.execute("CREATE EXTENSION IF NOT EXISTS databricks_auth")
            # role name = SP client id. Idempotent: skip if it already exists.
            cur.execute("SELECT 1 FROM pg_roles WHERE rolname = %s", (app_sp_client_id,))
            if cur.fetchone():
                print(f"Lakebase role for app SP already exists: {app_sp_client_id}")
            else:
                cur.execute(
                    "SELECT databricks_create_role(%s, %s)",
                    (app_sp_client_id, "SERVICE_PRINCIPAL"),
                )
                print(f"Created Lakebase role for app SP: {app_sp_client_id}")
            # Owner hand-off, table half (W1-5, server/db/grants.js step 1): the app
            # tables this identity owns go to a neutral NOLOGIN role (_OWNER_ROLE),
            # of which this identity becomes a member. The app SP's TEMPORARY
            # membership is NOT opened here (ai_prism.open_handoff = off): the
            # deploy wrapper opens it right before publishing the code
            # (`migrate.mjs prepare`) and closes it on every path after that
            # (`migrate.mjs up --role <sp>`), so a job run alone never leaves the
            # SP able to act as the table owner.
            # The SP no longer gets CREATE on public or on the database.
            cur.execute("BEGIN")
            cur.execute(
                "SELECT set_config('ai_prism.app_role', %s, true), set_config('ai_prism.owner_role', %s, true),"
                " set_config('ai_prism.open_handoff', 'off', true)",
                (app_sp_client_id, _OWNER_ROLE),
            )
            cur.execute(PREPARE_HANDOFF_SQL)
            cur.execute("COMMIT")
            print(f"Owner hand-off prepared: {_OWNER_ROLE} owns this identity's app tables (the deploy wrapper opens and closes the SP's part).")

            # Seed the deployer as the bootstrap ADMIN. The app reads admins from
            # this table (server/authz.js) — a persistent, redeploy-safe source of
            # truth. We do this here (not via APP_OWNER_EMAIL) because the bundle's
            # config.env does NOT reach the running app; only app.yaml + resource
            # injections do, and app.yaml can't carry the (dynamic) deployer email.
            # Create the table if the app hasn't booted yet (same shape as db.js);
            # idempotent upsert so re-deploys are safe.
            # Audit (W2-17, threat model G8): this job does NOT write admin_audit.
            # It runs before the app is published, so on a first install neither
            # the ai_prism schema nor admin_audit (migration 0007) exist yet, and
            # it does not hold APP_AUDIT_HASH_KEY. The app records this grant
            # right after its migrations (server/audit.js
            # recordBootstrapAdminSeeds, called by ensureSchema), keyed on
            # added_by = 'auto-config' below: keep that literal in step with
            # BOOTSTRAP_ADDED_BY (server/auditHash.test.js checks it).
            if deployer_email:
                # same resolution as the app: ai_prism once migration 0002 ran,
                # public before it (0002 then moves it); created as the owner role
                cur.execute("SET search_path TO ai_prism, public")
                cur.execute(f'SET ROLE "{_OWNER_ROLE}"')
                cur.execute(
                    "CREATE TABLE IF NOT EXISTS app_admins ("
                    " principal TEXT PRIMARY KEY,"
                    " kind TEXT NOT NULL DEFAULT 'user',"
                    " added_by TEXT NOT NULL,"
                    " created_at TIMESTAMPTZ DEFAULT NOW())"
                )
                cur.execute("RESET ROLE")
                # row-level security (W2-1, migration 0003): app_admins is an
                # admin table under FORCE ROW LEVEL SECURITY, which binds its
                # owner too; a write needs app.is_admin = 'on'. Set for this
                # one insert only (a no-op before 0003 exists), reset after.
                cur.execute("SELECT set_config('app.is_admin', 'on', false)")
                cur.execute(
                    "INSERT INTO app_admins (principal, kind, added_by) VALUES (%s,'user','auto-config')"
                    " ON CONFLICT (principal) DO NOTHING",
                    (deployer_email,),
                )
                cur.execute("RESET app.is_admin")
                # DML for the app SP (the grants step re-applies it on ai_prism)
                cur.execute(f'GRANT SELECT, INSERT, UPDATE, DELETE ON app_admins TO "{app_sp_client_id}"')
                print(f"Seeded bootstrap admin: {deployer_display}")
    finally:
        conn.close()
else:
    print("WARNING: lakebase_host / app_sp_client_id / lakebase_endpoint missing — "
          "skipping SP role provisioning. The app SP won't be able to connect to "
          "Lakebase; create the role manually with "
          "databricks_create_role(<client_id>,'SERVICE_PRINCIPAL').")

# COMMAND ----------

# Grant the app's own service principal CAN_MANAGE on the app, so it can READ the
# app's permission ACL (GET /permissions/apps/<name>) at runtime. That ACL is the
# universe of admin candidates for the Settings → Administrators autocomplete AND
# the source of truth for the server-side "only principals with app access can be
# promoted" check (server/authz.js). Neither the signed-in user's OBO token (it's
# downscoped out of the access-management API family) nor an SP that isn't in its
# own ACL can read it — reading app permissions requires CAN_MANAGE on the app.
# Idempotent: PATCH is additive and re-granting the same level is a no-op. The SP
# is filtered out of the suggestions in code, so this only enables the read.
if app_name and app_sp_client_id:
    import json
    import urllib.request

    _ctx = dbutils.notebook.entry_point.getDbutils().notebook().getContext()
    _host = workspace_host or ("https://" + _ctx.browserHostName().get())
    _token = _ctx.apiToken().get()
    _req = urllib.request.Request(
        f"{_host}/api/2.0/permissions/apps/{app_name}",
        data=json.dumps({
            "access_control_list": [
                {"service_principal_name": app_sp_client_id, "permission_level": "CAN_MANAGE"}
            ]
        }).encode(),
        headers={"Authorization": f"Bearer {_token}", "Content-Type": "application/json"},
        method="PATCH",
    )
    try:
        with urllib.request.urlopen(_req) as resp:
            resp.read()
        print(f"Granted CAN_MANAGE on app '{app_name}' to app SP {app_sp_client_id} "
              "(enables ACL read for admin autocomplete + access check).")
    except Exception as e:  # non-fatal: autocomplete degrades to free-text
        print(f"WARNING: could not grant app SP CAN_MANAGE on '{app_name}': {e}")
        print("Admin autocomplete will be empty until the app SP can read the app ACL.")
else:
    print("app_name / app_sp_client_id missing — skipping app SP ACL grant.")

# COMMAND ----------

# Publish the AI/BI cost dashboard. `bundle deploy` creates/updates it as a DRAFT;
# publishing makes it viewable by other admins right after deploy (no manual step).
# Idempotent — re-publishing on every deploy just refreshes the published version.
if dashboard_id:
    import json
    import urllib.request

    ctx = dbutils.notebook.entry_point.getDbutils().notebook().getContext()
    _host = workspace_host or ("https://" + ctx.browserHostName().get())
    _token = ctx.apiToken().get()
    req = urllib.request.Request(
        f"{_host}/api/2.0/lakeview/dashboards/{dashboard_id}/published",
        data=json.dumps({"embed_credentials": False}).encode(),
        headers={"Authorization": f"Bearer {_token}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req) as resp:
            body = json.loads(resp.read().decode() or "{}")
        print(f"Published cost dashboard {dashboard_id} "
              f"(revision {body.get('revision_create_time', 'n/a')}).")
    except Exception as e:  # non-fatal: the dashboard still exists as a draft
        print(f"WARNING: could not publish dashboard {dashboard_id}: {e}")
        print("Open it in the workspace and click Publish manually.")
else:
    print("No dashboard_id provided; skipping publish (deploy leaves it as a draft).")

# COMMAND ----------

# Surface the resolved config. APP_OWNER_EMAIL / SQL_WAREHOUSE_ID / PGHOST etc.
# are wired into the app via the bundle's app resource env, but printing them
# here gives the operator a single place to confirm what the deploy resolved.
print("=== AI Prism resolved configuration ===")
print(f"APP_OWNER_EMAIL   = {deployer_display}")
print(f"DATABRICKS_APP_NAME = {app_name}")
print(f"SQL_WAREHOUSE_ID  = {warehouse_id}")
print(f"TOOLS_CATALOG     = {catalog}")
print(f"TOOLS_SCHEMA      = {schema}")
print(f"IMAGE_VOLUME      = {image_catalog}.{image_schema}.{image_volume}")
print(f"PGHOST            = {lakebase_host}")
print(f"PGDATABASE        = {lakebase_db}")
print(f"COST_DASHBOARD_ID = {dashboard_id or '(not provided)'}")
print(f"RESOURCE_TAGS     = {resource_tags}")

# AI_PRISM_RESOURCE_TAGS (read by the app at runtime — see server/resourceTags.js)
# is written into app.yaml ONLY by the wrappers (deploy.sh / deploy.ps1 / the
# notebook), BEFORE `bundle deploy`. Someone running the native path directly
# (`databricks bundle deploy` + `databricks apps deploy`) never touches app.yaml, so
# the app keeps the default there and the tags resolved here do not reach the AI
# Gateway / SQL usage tags. Nothing in this job can rewrite a running app's env
# without a redeploy, so the warning is explicit.
if any(k != "ai_prism_app" for k in resource_tags):
    _expected_env_json = _json.dumps(resource_tags, ensure_ascii=False)
    print("")
    print("AVISO IMPORTANTE — tags de recurso no runtime do app:")
    print("  Se este deploy NÃO passou por deploy.sh/deploy.ps1/o notebook instalador,")
    print("  edite app.yaml e defina AI_PRISM_RESOURCE_TAGS = '" + _expected_env_json + "'")
    print("  e rode 'databricks apps deploy' de novo — senão o app usa só a tag embutida")
    print("  ai_prism_app no AI Gateway e no SQL Warehouse. Ver docs/tags.md.")

print("Auto-config complete.")
