"""Generates the AI Prism installer notebook ("Install AI Prism.py").

Usage (from the project root):
    python3 scripts/build-installer-notebook.py "Install AI Prism.py"

The generated file is in the Databricks notebook source format (`# Databricks
notebook source`, cells separated by `# COMMAND ----------`, markdown in
`# MAGIC`), which the Workspace imports as a notebook. The content lives here,
not hand-edited in the .py, so install changes go through a single place.
Re-run whenever this script changes and commit the generated .py with it.
"""

import sys

cells = []  # (kind, text) — kind: "md" | "code"


def md(text):
    cells.append(("md", text))


def code(text):
    cells.append(("code", text))


md(r"""# Install AI Prism from a notebook

This notebook installs or updates the **AI Prism** app in this workspace, without a terminal.

**1. Put the project in the workspace** (either option):
- **Import `ai-prism.zip`** from the Workspace screen (*Import*). Databricks unpacks it into an `ai-prism` folder, and this notebook sits inside it.
- Or upload the `.zip` to a Unity Catalog **Volume** and enter its path in the **source** field (e.g. `/Volumes/main/default/files/ai-prism.zip`).

**2. Compute:** a **classic** cluster with **Dedicated / Single user** access mode (in *Standard/Shared* mode the notebook cannot use your credential), Databricks Runtime **13.3 LTS or newer**. Keep the cluster running during the installation: without serverless, the final configuration runs on it.

**3. Fill in the fields at the top** and click **Run all**:
- **catalog**: the Unity Catalog catalog where you can create schemas (e.g. `main`). AI Prism uses its `default` schema for the Python UDF and the image volume.
- **action**: start with `check` (creates nothing). If everything passes, switch to `install` and run again.
- **source**: leave empty to find the project automatically, or enter the project folder/zip.
- **cli_zip**: only for clusters without internet access (see below).
- **serverless**: `yes` (default) creates the app's SQL Warehouse as **serverless** and runs the final configuration in the bundle job. Use `no` only in workspaces without serverless; in that mode the warehouse is classic Pro and the final configuration runs on this cluster.
- **lakebase_minutes_until_sleep** (optional): idle minutes before the app's database (Lakebase) goes to sleep, from 1 to 10080. Empty keeps the bundle default. The first request after sleep takes a few seconds longer.
- **usage_policy_id** (optional): id of a serverless usage policy that already exists in the account (an admin creates it under *Settings → Compute → Serverless usage policies*). It attributes the serverless consumption of the App and of the install job to that policy. Empty assigns nothing. The installer never creates the policy.
- **tags** (optional): resource tags as `key=value`, comma-separated (e.g. `cost_center=1234,area=finance`), applied to every resource the installation creates and, in the app, to what it consumes (AI Gateway, SQL). The built-in tag `ai_prism_app=ai-prism` is always added and cannot be overridden. Key/value: only letters, digits, space and `+ - = . : / @` (up to 255 characters), up to 24 tags. See `docs/tags.md`.

The first installation takes 10 to 15 minutes. You can run it again whenever you like: the process is idempotent.

**No internet on the cluster?** The notebook downloads the Databricks CLI from GitHub. If the cluster has no outbound internet access, download
`https://github.com/databricks/cli/releases/download/v1.17.0/databricks_cli_1.17.0_linux_amd64.zip`
on your computer, upload that file to the same folder as this notebook (or to a Volume) and enter its path in the **cli_zip** field.""")

code(r'''dbutils.widgets.text("catalog", "ai_prism", "1. Unity Catalog catalog")
dbutils.widgets.dropdown("action", "check", ["check", "install"], "2. Action")
dbutils.widgets.text("source", "", "3. Project folder or .zip (optional)")
dbutils.widgets.text("cli_zip", "", "4. CLI zip (offline clusters only)")
dbutils.widgets.dropdown("serverless", "yes", ["yes", "no"], "5. Workspace has serverless?")
dbutils.widgets.text("lakebase_minutes_until_sleep", "", "6. Lakebase: idle minutes before sleep (optional)")
dbutils.widgets.text("usage_policy_id", "", "7. Serverless usage policy id (optional)")
dbutils.widgets.text("tags", "", "8. Resource tags (key=value, comma-separated)")''')

code(r'''# Setup: this session's credential and helper functions
import os, glob, json, zipfile, shutil, subprocess, platform, urllib.request, re, requests

CATALOG = dbutils.widgets.get("catalog").strip()
ACTION = dbutils.widgets.get("action")
SOURCE = dbutils.widgets.get("source").strip()
CLI_ZIP = dbutils.widgets.get("cli_zip").strip()
SERVERLESS = dbutils.widgets.get("serverless") == "yes"
LAKEBASE_SUSPEND_MINUTES = dbutils.widgets.get("lakebase_minutes_until_sleep").strip()
USAGE_POLICY_ID = dbutils.widgets.get("usage_policy_id").strip()
TAGS = dbutils.widgets.get("tags").strip()
assert CATALOG, "Fill in the 'catalog' field."
assert not LAKEBASE_SUSPEND_MINUTES or (LAKEBASE_SUSPEND_MINUTES.isdigit() and 1 <= int(LAKEBASE_SUSPEND_MINUTES) <= 10080), \
    "'lakebase_minutes_until_sleep' must be a number from 1 to 10080 (or empty)."
assert not USAGE_POLICY_ID or re.fullmatch(r"[A-Za-z0-9_-]{1,128}", USAGE_POLICY_ID), \
    "'usage_policy_id' has invalid characters; paste only the policy id."

ctx = dbutils.notebook.entry_point.getDbutils().notebook().getContext()
HOST = "https://" + spark.conf.get("spark.databricks.workspaceUrl")
try:
    TOKEN = ctx.apiToken().get()
except Exception as e:
    raise RuntimeError(
        "Could not use your credential on this cluster. Use a cluster with 'Dedicated' "
        "(Single user) access mode and run again."
    ) from e
NB_DIR = "/Workspace" + os.path.dirname(ctx.notebookPath().get())
ME = ctx.userName().get()

API = requests.Session()
API.headers["Authorization"] = f"Bearer {TOKEN}"

def ws_path(p):
    p = p.strip()
    if p.startswith("dbfs:/Volumes/"): p = p[5:]
    if p.startswith("/Volumes/") or p.startswith("/Workspace/"): return p
    return "/Workspace" + (p if p.startswith("/") else "/" + p)

print("workspace:", HOST)
print("user:", ME)
print("notebook at:", NB_DIR)''')

code(r'''# 1) Build a copy of the project on the cluster's local disk (/tmp/ai-prism)
PROJ = "/tmp/ai-prism"
PROFILE = "ai-prism"
EXT = {"PYTHON": ".py", "SQL": ".sql", "SCALA": ".scala", "R": ".r"}
REQUIRED = ["databricks.yml", "deploy.sh", "app.yaml", "bundle/auto_config.py", "bundle/python_udf_ddl.py",
            "dashboards/ai-costs.lvdash.json",
            "server-dist/index.cjs", "client/dist/index.html"]
# This installer must never be copied into the bundle: skip it under its current
# name and under the legacy Portuguese name (older zips still carry that one).
INSTALLER_NOTEBOOK_PREFIXES = ("Install AI Prism", "Instalar AI Prism")
def is_installer_notebook(name): return name.startswith(INSTALLER_NOTEBOOK_PREFIXES)

def api_get(endpoint, **params):
    r = API.get(f"{HOST}/api/2.0/workspace/{endpoint}", params=params, timeout=120)
    r.raise_for_status()
    return r

def ws_list(path):
    return api_get("list", path=path[len("/Workspace"):] if path.startswith("/Workspace") else path).json().get("objects", [])

SEARCH_ERRORS = []
def is_project_folder(path):
    if all(os.path.exists(os.path.join(path, f)) for f in ("databricks.yml", "deploy.sh")):
        return True
    try:
        names = {os.path.basename(o["path"]) for o in ws_list(path)}
    except Exception as e:
        SEARCH_ERRORS.append(f"{path}: {e}")
        return False
    return {"databricks.yml", "deploy.sh"} <= names

def export_folder(src, dst):
    # Workspace folder -> local disk. Importing the zip turns
    # bundle/auto_config.py into a NOTEBOOK; here it becomes a .py file again.
    n = 0
    for o in ws_list(src):
        p = o["path"]; name = os.path.basename(p); t = o.get("object_type")
        if t == "DIRECTORY":
            n += export_folder("/Workspace" + p if not p.startswith("/Workspace") else p, os.path.join(dst, name))
            continue
        if t == "NOTEBOOK":
            if is_installer_notebook(name): continue
            data = api_get("export", path=p, format="SOURCE", direct_download="true").content
            name = name + EXT.get(o.get("language"), ".py")
        elif t == "FILE":
            data = api_get("export", path=p, format="AUTO", direct_download="true").content
        elif t == "DASHBOARD":
            # importing the zip also turns the .lvdash.json into a dashboard
            data = api_get("export", path=p, format="SOURCE", direct_download="true").content
            if not name.endswith(".lvdash.json"): name += ".lvdash.json"
        else:
            continue
        os.makedirs(dst, exist_ok=True)
        with open(os.path.join(dst, name), "wb") as f:
            f.write(data)
        n += 1
    return n

def extract_zip(zpath, dst):
    tmp = dst + "-zip"
    shutil.rmtree(tmp, ignore_errors=True)
    with zipfile.ZipFile(zpath) as z:
        z.extractall(tmp)
    root = tmp
    for dirpath, dirs, files in os.walk(tmp):
        if "databricks.yml" in files and "deploy.sh" in files:
            root = dirpath; break
    shutil.move(root, dst)
    shutil.rmtree(tmp, ignore_errors=True)

# where is the project?
src = None
if SOURCE:
    src = ws_path(SOURCE)
else:
    home = f"/Workspace/Users/{ME}"
    candidates = [NB_DIR, os.path.join(NB_DIR, "ai-prism"), os.path.join(home, "ai-prism")]
    src = next((c for c in candidates if is_project_folder(c)), None)
    if not src:
        zips = sorted(glob.glob(os.path.join(NB_DIR, "*.zip")))
        src = zips[0] if zips else None
if not src and SEARCH_ERRORS:
    print("diagnostics:\n" + "\n".join(SEARCH_ERRORS))
assert src, ("Could not find the project. Import ai-prism.zip into the workspace (it becomes the "
             "'ai-prism' folder) or enter the project folder/zip in the 'source' field.")

shutil.rmtree(PROJ, ignore_errors=True)
if src.lower().endswith(".zip"):
    print("extracting", src)
    extract_zip(src, PROJ)
elif src.startswith("/Volumes/"):
    shutil.copytree(src, PROJ)
else:
    print("copying the workspace folder", src, "(takes about 1 minute)")
    print(export_folder(src, PROJ), "files")

missing = [f for f in REQUIRED if not os.path.exists(os.path.join(PROJ, f))]
assert not missing, f"The project at {src} is incomplete; missing: {missing}"
os.chmod(os.path.join(PROJ, "deploy.sh"), 0o755)
print("project ready at", PROJ)''')

code(r'''# 2) Databricks CLI
CLI_VERSION = "1.17.0"
BIN = "/tmp/databricks-cli"
CLI = os.path.join(BIN, "databricks")
if not os.path.exists(CLI):
    os.makedirs(BIN, exist_ok=True)
    zp = os.path.join(BIN, "cli.zip")
    if CLI_ZIP:
        shutil.copy(ws_path(CLI_ZIP), zp)
    else:
        arch = "arm64" if platform.machine() in ("aarch64", "arm64") else "amd64"
        url = f"https://github.com/databricks/cli/releases/download/v{CLI_VERSION}/databricks_cli_{CLI_VERSION}_linux_{arch}.zip"
        try:
            urllib.request.urlretrieve(url, zp)
        except Exception as e:
            raise RuntimeError(
                "Could not download the Databricks CLI (the cluster seems to have no internet access). "
                f"Download {url} on your computer, upload the file to this notebook's folder or to a "
                "Volume, and enter its path in the 'cli_zip' field."
            ) from e
    with zipfile.ZipFile(zp) as z:
        z.extractall(BIN)
    os.chmod(CLI, 0o755)

# "ai-prism" profile with this session's credential (kept in /tmp only)
CFG = "/tmp/ai-prism.databrickscfg"
with open(CFG, "w") as f:
    f.write(f"[{PROFILE}]\nhost = {HOST}\ntoken = {TOKEN}\n")
os.chmod(CFG, 0o600)
ENV = {k: v for k, v in os.environ.items() if not k.startswith("DATABRICKS_")}
ENV.update({"PATH": BIN + ":" + ENV.get("PATH", "/usr/bin:/bin"), "DATABRICKS_CONFIG_FILE": CFG, "HOME": "/tmp"})
# without serverless: the app's SQL Warehouse is created as classic Pro and the final
# configuration (auto-config) runs ON THIS cluster (see deploy.sh)
EXTRA_VARS = []
if not SERVERLESS:
    ENV["CLASSIC_CLUSTER_ID"] = spark.conf.get("spark.databricks.clusterUsageTags.clusterId")
    EXTRA_VARS = ["--var", "warehouse_serverless=false"]
    print("non-serverless mode: auto-config on this cluster", ENV["CLASSIC_CLUSTER_ID"])
# optional: deploy.sh reads these environment variables (same as its --... options)
if LAKEBASE_SUSPEND_MINUTES: ENV["LAKEBASE_SUSPEND_MINUTES"] = str(int(LAKEBASE_SUSPEND_MINUTES))
if USAGE_POLICY_ID: ENV["SERVERLESS_USAGE_POLICY_ID"] = USAGE_POLICY_ID
print("Lakebase sleeps after:", (LAKEBASE_SUSPEND_MINUTES + " min") if LAKEBASE_SUSPEND_MINUTES else "bundle default")
print("usage policy:", USAGE_POLICY_ID or "(none)")
# Resource tags: deploy.sh reads TAGS (key=value, comma-separated) and always
# adds the built-in ai_prism_app tag; see docs/tags.md.
if TAGS: ENV["TAGS"] = TAGS
print("resource tags:", TAGS or "(none; only the built-in ai_prism_app tag)")

def run(cmd, check=True, quiet=False):
    if not quiet: print("$", " ".join(cmd), flush=True)
    p = subprocess.Popen(cmd, cwd=PROJ, env=ENV, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    out = []
    for line in p.stdout:
        out.append(line)
        if not quiet: print(line, end="", flush=True)
    code = p.wait()
    if check and code != 0:
        raise RuntimeError(f"the command failed (exit code {code}) — see the output above")
    return code, "".join(out)

run(["databricks", "-v"])
run(["databricks", "current-user", "me", "-p", PROFILE, "-o", "json"], quiet=True)
print("credential ok")''')

code(r'''# 3) Checks (creates nothing)
# The same checks as deploy.sh (which also looks for a soft-deleted Lakebase project
# before the real deploy): catalog, tags, usage policy and bundle validation.
problems = []

def cli(args):
    return subprocess.run(["databricks", *args, "-p", PROFILE], cwd=PROJ, env=ENV, capture_output=True, text=True)

code, _ = run(["databricks", "catalogs", "get", CATALOG, "-p", PROFILE], check=False, quiet=True)
print(("ok      " if code == 0 else "MISSING ") + "catalog " + CATALOG)
if code != 0: problems.append(f"catalog '{CATALOG}' does not exist or you do not have access to it")

# Resource tags: same rules as server/resourceTags.js (and deploy.sh/deploy.ps1).
# Key/value: only letters, digits, space and + - = . : / @ (up to 255 characters);
# ai_prism_app is built in and cannot be overridden (not even by a key that differs
# from it only by case); up to 24 operator tags (+ the built-in one = 25, the Jobs API maximum).
TAG_RE = re.compile(r"^[\w+\-=.:/@ ]{1,255}$")
_MAX_OPERATOR_TAGS = 24
_seen_tags = {}
_n_tags_ok = 0
for pair in [p for p in TAGS.split(",") if p.strip()]:
    if "=" not in pair:
        problems.append(f"invalid tag (use key=value): {pair!r}"); continue
    k, v = (x.strip() for x in pair.split("=", 1))
    k_lower = k.lower()
    if k_lower == "ai_prism_app":
        print("WARNING the ai_prism_app tag is built in and cannot be overridden; the value you gave is ignored"); continue
    if k_lower == "application":
        print("WARNING the 'application' tag is reserved (used to attribute cost to AI Prism); the value you gave is ignored"); continue
    if not TAG_RE.match(k):
        problems.append(f"invalid tag key {k!r}: use only letters, digits, space and + - = . : / @ (up to 255 characters)"); continue
    if v and not TAG_RE.match(v):
        problems.append(f"invalid tag value for {k!r} ({v!r}): use only letters, digits, space and + - = . : / @ (up to 255 characters)"); continue
    if k_lower in _seen_tags:
        problems.append(f"tag {k!r} differs from {_seen_tags[k_lower]!r} only by case; use a single spelling"); continue
    if _n_tags_ok >= _MAX_OPERATOR_TAGS:
        problems.append(f"more than {_MAX_OPERATOR_TAGS} operator tags (Jobs API limit: 25 in total, including the built-in ai_prism_app tag)"); continue
    _seen_tags[k_lower] = k
    _n_tags_ok += 1
print(("ok      " if TAGS else "ok      (no tags given; only the built-in tag)") + " resource tags")

# Usage policy: it is an ACCOUNT object, which this installer does not look up; a wrong
# id only shows up at install time. So this is just a warning to double-check the id.
if USAGE_POLICY_ID:
    print("WARNING usage policy " + USAGE_POLICY_ID + " is not verified here (account object): "
          "check the id under Settings → Compute → Serverless usage policies")

# Lakebase (soft-delete left by a previously destroyed install): deploy.sh runs the same
# check before installing; here it only warns early, during 'check'. NEVER purges.
_get = cli(["postgres", "get-project", "projects/ai-prism", "-o", "json"])
_lakebase_ok = True
if _get.returncode == 0:
    try:
        _proj = json.loads(_get.stdout)
    except Exception:
        _proj = {}
    _list = cli(["postgres", "list-projects", "-o", "json"])
    try:
        _active = {p.get("project_id") for p in json.loads(_list.stdout)} if _list.returncode == 0 else None
    except Exception:
        _active = None
    if _active is not None and "ai-prism" not in _active:
        _lakebase_ok = False
        _delete_time = _proj.get("delete_time") or (_proj.get("status") or {}).get("delete_time") or ""
        problems.append(
            "the Lakebase project 'projects/ai-prism' is soft-deleted"
            + (f" (delete_time={_delete_time})" if _delete_time else "")
            + " — probably from a previously destroyed install — and still reserves that name; "
              "'install' will fail trying to recreate it. From a terminal (CLI), choose: "
              "'databricks postgres undelete-project projects/ai-prism' (restores the data; NOT destructive) "
              "or 'databricks postgres delete-project projects/ai-prism --purge' (deletes for good; DESTRUCTIVE, "
              "only run it if you are sure). See docs/onboarding-deployment.md (Troubleshooting)."
        )
print(("ok      " if _lakebase_ok else "FAILED  ") + "Lakebase project (soft-delete from a previous install)")

code, out = run(["databricks", "bundle", "validate", "-p", PROFILE, "-t", "dev",
                 "--var", f"tools_catalog={CATALOG}", "--var", f"image_volume_catalog={CATALOG}", *EXTRA_VARS], check=False, quiet=True)
print(("ok      " if code == 0 else "FAILED  ") + "bundle configuration")
if code != 0:
    print(out); problems.append("bundle validation failed (output above)")
assert not problems, "Fix these before installing:\n- " + "\n- ".join(problems)
print("\nAll good." + (" Switch 'action' to 'install' and run again." if ACTION == "check" else ""))''')

code(r'''# 4) Install: Lakebase, SQL Warehouse, dashboard, job and app → code → auto-config
if ACTION != "install":
    dbutils.notebook.exit("'check' mode: nothing was created. Switch 'action' to 'install' and run again.")
run(["bash", "deploy.sh", PROFILE, CATALOG])''')

code(r'''# 5) Next steps
_, out = run(["databricks", "apps", "get", "ai-prism", "-p", PROFILE, "-o", "json"], quiet=True)
url = json.loads(out).get("url", "")
displayHTML(f"""<h3>AI Prism installed</h3>
<p><a href="{url}" target="_blank">{url}</a></p>
<ol>
<li>Open the app: the user who installed it is already the administrator.</li>
<li>Under <b>Compute → Apps → ai-prism → Permissions</b>, grant <b>Can Use</b> to the users and groups who will use the app.</li>
</ol>""")''')


def to_source(kind, text):
    """Renderiza uma célula no formato-fonte do Databricks."""
    if kind == "md":
        lines = text.split("\n")
        return "\n".join("# MAGIC" if not ln.strip() else f"# MAGIC {ln}" for ln in lines)
    return text.strip("\n")


def build():
    parts = ["# Databricks notebook source"]
    for kind, text in cells:
        parts.append("# COMMAND ----------")
        parts.append(to_source(kind, text))
    return "\n\n".join(parts) + "\n"


if __name__ == "__main__":
    out_path = sys.argv[1] if len(sys.argv) > 1 else "Install AI Prism.py"
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(build())
    print("ok", out_path)
