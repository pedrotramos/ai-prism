"""Gera o notebook instalador do AI Prism ("Instalar AI Prism.py").

Uso (da raiz do projeto):
    python3 scripts/build-installer-notebook.py "Instalar AI Prism.py"

O arquivo gerado está no formato-fonte de notebook do Databricks (`# Databricks
notebook source`, células separadas por `# COMMAND ----------`, markdown em
`# MAGIC`), que o Workspace importa como notebook. O conteúdo fica aqui, e não
editado à mão no .py, para que as mudanças de instalação passem por um único lugar.
Rode de novo sempre que este script mudar e commite o .py gerado junto.
"""

import sys

cells = []  # (kind, text) — kind: "md" | "code"


def md(text):
    cells.append(("md", text))


def code(text):
    cells.append(("code", text))


md(r"""# Instalar o AI Prism pelo notebook

Este notebook instala ou atualiza o app **AI Prism** neste workspace, sem terminal.

**1. Coloque o projeto no workspace** (qualquer uma das opções):
- **Importar o `ai-prism.zip`** pela tela do Workspace (*Import*). O Databricks descompacta numa pasta `ai-prism`, e este notebook fica dentro dela.
- Ou envie o `.zip` para um **Volume** do Unity Catalog e informe o caminho no campo **origem** (ex.: `/Volumes/main/default/arquivos/ai-prism.zip`).

**2. Compute:** um cluster **clássico** com modo de acesso **Dedicado / Single user** (no modo *Standard/Shared* o notebook não consegue usar sua credencial), Databricks Runtime **13.3 LTS ou mais novo**. Deixe o cluster ligado durante a instalação: no modo sem serverless a configuração final roda nele.

**3. Preencha os campos no topo** e clique em **Run all**:
- **catalogo**: catálogo do Unity Catalog onde você pode criar schemas (ex.: `main`). O AI Prism usa o schema `default` dele para a UDF Python e o volume de imagens.
- **acao**: comece com `verificar` (não cria nada). Se tudo der certo, troque para `instalar` e rode de novo.
- **origem**: deixe vazio para achar o projeto sozinho; ou informe a pasta/zip do projeto.
- **cli_zip**: só para clusters sem internet (ver abaixo).
- **serverless**: `sim` (padrão) cria o SQL Warehouse do app como **serverless** e roda a configuração final no job do bundle. Use `não` apenas em workspaces sem serverless; nesse modo, o warehouse é Pro clássico e a configuração final roda neste cluster.
- **lakebase_minutos_ate_dormir** (opcional): minutos sem uso até o banco do app (Lakebase) dormir, de 1 a 10080. Em branco, vale o padrão do bundle. A primeira requisição depois de dormir leva alguns segundos a mais.
- **usage_policy_id** (opcional): id de uma serverless usage policy que já existe na conta (um admin cria em *Settings → Compute → Serverless usage policies*). Atribui o consumo serverless do App e do job de instalação a ela. Em branco, nada é atribuído. O instalador nunca cria a policy.
- **tags** (opcional): tags de recurso no formato `chave=valor`, separadas por vírgula (ex.: `cost_center=1234,area=financeiro`), aplicadas a todo recurso criado pela instalação e, no app, ao que ele consome (AI Gateway, SQL). A tag embutida `ai_prism_app=ai-prism` é sempre adicionada e não pode ser sobrescrita. Chave/valor: só letras, números, espaço e `+ - = . : / @` (até 255 caracteres), até 24 tags. Ver `docs/tags.md`.

A primeira instalação leva de 10 a 15 minutos. Pode rodar de novo quando quiser: o processo é idempotente.

**Sem internet no cluster?** O notebook baixa a Databricks CLI do GitHub. Se o cluster não tiver saída para a internet, baixe no seu computador
`https://github.com/databricks/cli/releases/download/v1.17.0/databricks_cli_1.17.0_linux_amd64.zip`,
envie esse arquivo para a mesma pasta deste notebook (ou para um Volume) e informe o caminho no campo **cli_zip**.""")

code(r'''dbutils.widgets.text("catalogo", "ai_prism", "1. Catálogo UC")
dbutils.widgets.dropdown("acao", "verificar", ["verificar", "instalar"], "2. Ação")
dbutils.widgets.text("origem", "", "3. Pasta ou .zip do projeto (opcional)")
dbutils.widgets.text("cli_zip", "", "4. Zip da CLI (só sem internet)")
dbutils.widgets.dropdown("serverless", "sim", ["sim", "não"], "5. Workspace tem serverless?")
dbutils.widgets.text("lakebase_minutos_ate_dormir", "", "6. Lakebase: minutos sem uso até dormir (opcional)")
dbutils.widgets.text("usage_policy_id", "", "7. Serverless usage policy id (opcional)")
dbutils.widgets.text("tags", "", "8. Tags de recurso (chave=valor, separados por vírgula)")''')

code(r'''# Preparação: credencial desta sessão e funções auxiliares
import os, glob, json, zipfile, shutil, subprocess, platform, urllib.request, re, requests

CATALOGO = dbutils.widgets.get("catalogo").strip()
ACAO = dbutils.widgets.get("acao")
ORIGEM = dbutils.widgets.get("origem").strip()
CLI_ZIP = dbutils.widgets.get("cli_zip").strip()
SERVERLESS = dbutils.widgets.get("serverless") == "sim"
LAKEBASE_SUSPEND_MINUTES = dbutils.widgets.get("lakebase_minutos_ate_dormir").strip()
USAGE_POLICY_ID = dbutils.widgets.get("usage_policy_id").strip()
TAGS = dbutils.widgets.get("tags").strip()
assert CATALOGO, "Preencha o campo 'catalogo'."
assert not LAKEBASE_SUSPEND_MINUTES or (LAKEBASE_SUSPEND_MINUTES.isdigit() and 1 <= int(LAKEBASE_SUSPEND_MINUTES) <= 10080), \
    "'lakebase_minutos_ate_dormir' precisa ser um número de 1 a 10080 (ou ficar em branco)."
assert not USAGE_POLICY_ID or re.fullmatch(r"[A-Za-z0-9_-]{1,128}", USAGE_POLICY_ID), \
    "'usage_policy_id' tem caracteres inválidos; cole só o id da policy."

ctx = dbutils.notebook.entry_point.getDbutils().notebook().getContext()
HOST = "https://" + spark.conf.get("spark.databricks.workspaceUrl")
try:
    TOKEN = ctx.apiToken().get()
except Exception as e:
    raise RuntimeError(
        "Não consegui usar a sua credencial neste cluster. Use um cluster com modo de acesso "
        "'Dedicado' (Single user) e rode de novo."
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
print("usuário:", ME)
print("notebook em:", NB_DIR)''')

code(r'''# 1) Montar uma cópia do projeto no disco local do cluster (/tmp/ai-prism)
PROJ = "/tmp/ai-prism"
PROFILE = "ai-prism"
EXT = {"PYTHON": ".py", "SQL": ".sql", "SCALA": ".scala", "R": ".r"}
REQUIRED = ["databricks.yml", "deploy.sh", "app.yaml", "bundle/auto_config.py", "bundle/python_udf_ddl.py",
            "dashboards/ai-costs.lvdash.json",
            "server-dist/index.cjs", "client/dist/index.html"]

def api_get(endpoint, **params):
    r = API.get(f"{HOST}/api/2.0/workspace/{endpoint}", params=params, timeout=120)
    r.raise_for_status()
    return r

def ws_list(path):
    return api_get("list", path=path[len("/Workspace"):] if path.startswith("/Workspace") else path).json().get("objects", [])

ERROS_BUSCA = []
def is_project_folder(path):
    if all(os.path.exists(os.path.join(path, f)) for f in ("databricks.yml", "deploy.sh")):
        return True
    try:
        names = {os.path.basename(o["path"]) for o in ws_list(path)}
    except Exception as e:
        ERROS_BUSCA.append(f"{path}: {e}")
        return False
    return {"databricks.yml", "deploy.sh"} <= names

def export_folder(src, dst):
    # Pasta do workspace -> disco local. O import do zip transforma
    # bundle/auto_config.py em NOTEBOOK; aqui ele volta a ser arquivo .py.
    n = 0
    for o in ws_list(src):
        p = o["path"]; name = os.path.basename(p); t = o.get("object_type")
        if t == "DIRECTORY":
            n += export_folder("/Workspace" + p if not p.startswith("/Workspace") else p, os.path.join(dst, name))
            continue
        if t == "NOTEBOOK":
            if name.startswith("Instalar AI Prism"): continue
            data = api_get("export", path=p, format="SOURCE", direct_download="true").content
            name = name + EXT.get(o.get("language"), ".py")
        elif t == "FILE":
            data = api_get("export", path=p, format="AUTO", direct_download="true").content
        elif t == "DASHBOARD":
            # o import do zip também transforma o .lvdash.json num dashboard
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

# onde está o projeto?
src = None
if ORIGEM:
    src = ws_path(ORIGEM)
else:
    home = f"/Workspace/Users/{ME}"
    candidatos = [NB_DIR, os.path.join(NB_DIR, "ai-prism"), os.path.join(home, "ai-prism")]
    src = next((c for c in candidatos if is_project_folder(c)), None)
    if not src:
        zips = sorted(glob.glob(os.path.join(NB_DIR, "*.zip")))
        src = zips[0] if zips else None
if not src and ERROS_BUSCA:
    print("diagnóstico:\n" + "\n".join(ERROS_BUSCA))
assert src, ("Não encontrei o projeto. Importe o ai-prism.zip no workspace (ele vira a pasta "
             "'ai-prism') ou informe a pasta/zip no campo 'origem'.")

shutil.rmtree(PROJ, ignore_errors=True)
if src.lower().endswith(".zip"):
    print("extraindo", src)
    extract_zip(src, PROJ)
elif src.startswith("/Volumes/"):
    shutil.copytree(src, PROJ)
else:
    print("copiando a pasta do workspace", src, "(leva cerca de 1 minuto)")
    print(export_folder(src, PROJ), "arquivos")

faltando = [f for f in REQUIRED if not os.path.exists(os.path.join(PROJ, f))]
assert not faltando, f"O projeto em {src} está incompleto; faltam: {faltando}"
os.chmod(os.path.join(PROJ, "deploy.sh"), 0o755)
print("projeto pronto em", PROJ)''')

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
                "Não consegui baixar a Databricks CLI (o cluster parece não ter internet). Baixe no seu "
                f"computador {url}, envie o arquivo para a pasta deste notebook ou para um Volume e "
                "informe o caminho no campo 'cli_zip'."
            ) from e
    with zipfile.ZipFile(zp) as z:
        z.extractall(BIN)
    os.chmod(CLI, 0o755)

# perfil "ai-prism" com a credencial desta sessão (só em /tmp)
CFG = "/tmp/ai-prism.databrickscfg"
with open(CFG, "w") as f:
    f.write(f"[{PROFILE}]\nhost = {HOST}\ntoken = {TOKEN}\n")
os.chmod(CFG, 0o600)
ENV = {k: v for k, v in os.environ.items() if not k.startswith("DATABRICKS_")}
ENV.update({"PATH": BIN + ":" + ENV.get("PATH", "/usr/bin:/bin"), "DATABRICKS_CONFIG_FILE": CFG, "HOME": "/tmp"})
# sem serverless: o SQL Warehouse do app é criado como Pro clássico e a
# configuração final (auto-config) roda NESTE cluster (ver deploy.sh)
EXTRA_VARS = []
if not SERVERLESS:
    ENV["CLASSIC_CLUSTER_ID"] = spark.conf.get("spark.databricks.clusterUsageTags.clusterId")
    EXTRA_VARS = ["--var", "warehouse_serverless=false"]
    print("modo sem serverless: auto-config neste cluster", ENV["CLASSIC_CLUSTER_ID"])
# opcionais: deploy.sh lê estas variáveis de ambiente (as mesmas das opções --...)
if LAKEBASE_SUSPEND_MINUTES: ENV["LAKEBASE_SUSPEND_MINUTES"] = str(int(LAKEBASE_SUSPEND_MINUTES))
if USAGE_POLICY_ID: ENV["SERVERLESS_USAGE_POLICY_ID"] = USAGE_POLICY_ID
print("Lakebase dorme após:", (LAKEBASE_SUSPEND_MINUTES + " min") if LAKEBASE_SUSPEND_MINUTES else "padrão do bundle")
print("usage policy:", USAGE_POLICY_ID or "(nenhuma)")
# Tags de recurso: deploy.sh lê TAGS (chave=valor, separadas por vírgula) e sempre
# adiciona a tag embutida ai_prism_app; ver docs/tags.md.
if TAGS: ENV["TAGS"] = TAGS
print("tags de recurso:", TAGS or "(nenhuma; só a tag embutida ai_prism_app)")

def run(cmd, check=True, quiet=False):
    if not quiet: print("$", " ".join(cmd), flush=True)
    p = subprocess.Popen(cmd, cwd=PROJ, env=ENV, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    out = []
    for line in p.stdout:
        out.append(line)
        if not quiet: print(line, end="", flush=True)
    code = p.wait()
    if check and code != 0:
        raise RuntimeError(f"o comando falhou (código {code}) — veja a saída acima")
    return code, "".join(out)

run(["databricks", "-v"])
run(["databricks", "current-user", "me", "-p", PROFILE, "-o", "json"], quiet=True)
print("credencial ok")''')

code(r'''# 3) Verificações (não cria nada)
# As mesmas checagens do deploy.sh (que também confere o projeto Lakebase soft-deleted
# antes do deploy real): catálogo, tags, usage policy e a validação do bundle.
problemas = []

def cli(args):
    return subprocess.run(["databricks", *args, "-p", PROFILE], cwd=PROJ, env=ENV, capture_output=True, text=True)

code, _ = run(["databricks", "catalogs", "get", CATALOGO, "-p", PROFILE], check=False, quiet=True)
print(("ok     " if code == 0 else "FALTA  ") + "catálogo " + CATALOGO)
if code != 0: problemas.append(f"catálogo '{CATALOGO}' não existe ou você não tem acesso")

# Tags de recurso: mesmas regras de server/resourceTags.js (e de deploy.sh/deploy.ps1).
# Chave/valor só com letras, números, espaço e + - = . : / @ (até 255 caracteres);
# ai_prism_app é embutida e não pode ser sobrescrita (nem por uma chave que só difere
# dela pela caixa); até 24 tags de operador (+ a embutida = 25, o máximo da Jobs API).
TAG_RE = re.compile(r"^[\w+\-=.:/@ ]{1,255}$")
_MAX_OPERATOR_TAGS = 24
_tags_vistas = {}
_n_tags_ok = 0
for par in [p for p in TAGS.split(",") if p.strip()]:
    if "=" not in par:
        problemas.append(f"tag inválida (use chave=valor): {par!r}"); continue
    k, v = (x.strip() for x in par.split("=", 1))
    k_lower = k.lower()
    if k_lower == "ai_prism_app":
        print("AVISO  a tag ai_prism_app é embutida e não pode ser sobrescrita; valor informado ignorado"); continue
    if k_lower == "application":
        print("AVISO  a tag 'application' é reservada (usada para atribuir o custo ao AI Prism); valor informado ignorado"); continue
    if not TAG_RE.match(k):
        problemas.append(f"chave de tag inválida {k!r}: use só letras, números, espaço e + - = . : / @ (até 255 caracteres)"); continue
    if v and not TAG_RE.match(v):
        problemas.append(f"valor de tag inválido para {k!r} ({v!r}): use só letras, números, espaço e + - = . : / @ (até 255 caracteres)"); continue
    if k_lower in _tags_vistas:
        problemas.append(f"tag {k!r} difere de {_tags_vistas[k_lower]!r} só pela caixa (maiúsculas/minúsculas); use só uma grafia"); continue
    if _n_tags_ok >= _MAX_OPERATOR_TAGS:
        problemas.append(f"mais de {_MAX_OPERATOR_TAGS} tags de operador (limite da Jobs API: 25 no total, incluindo a tag embutida ai_prism_app)"); continue
    _tags_vistas[k_lower] = k
    _n_tags_ok += 1
print(("ok     " if TAGS else "ok     (nenhuma tag informada; só a tag embutida)") + " tags de recurso")

# Usage policy: é um objeto da CONTA, que este instalador não consulta; um id errado
# só aparece na instalação. Por isso aqui é só um aviso para conferir o id.
if USAGE_POLICY_ID:
    print("AVISO  a usage policy " + USAGE_POLICY_ID + " não é conferida aqui (objeto da conta): "
          "confira o id em Settings → Compute → Serverless usage policies")

# Lakebase (soft-delete de uma instalação anterior destruída): o deploy.sh faz a mesma
# checagem antes de instalar; aqui é só para avisar já na 'verificar'. NUNCA purga.
_get = cli(["postgres", "get-project", "projects/ai-prism", "-o", "json"])
_lakebase_ok = True
if _get.returncode == 0:
    try:
        _proj = json.loads(_get.stdout)
    except Exception:
        _proj = {}
    _list = cli(["postgres", "list-projects", "-o", "json"])
    try:
        _ativos = {p.get("project_id") for p in json.loads(_list.stdout)} if _list.returncode == 0 else None
    except Exception:
        _ativos = None
    if _ativos is not None and "ai-prism" not in _ativos:
        _lakebase_ok = False
        _delete_time = _proj.get("delete_time") or (_proj.get("status") or {}).get("delete_time") or ""
        problemas.append(
            "o projeto Lakebase 'projects/ai-prism' está soft-deleted"
            + (f" (delete_time={_delete_time})" if _delete_time else "")
            + " — provavelmente de uma instalação anterior destruída — e ainda reserva esse nome; "
              "'instalar' vai falhar tentando recriá-lo. Pelo terminal (CLI), escolha: "
              "'databricks postgres undelete-project projects/ai-prism' (restaura os dados; NÃO destrutivo) "
              "ou 'databricks postgres delete-project projects/ai-prism --purge' (apaga de vez; DESTRUTIVO, "
              "só rode se tiver certeza). Ver docs/onboarding-deployment.md (Resolvendo problemas comuns)."
        )
print(("ok     " if _lakebase_ok else "FALHA  ") + "projeto Lakebase (soft-delete de instalação anterior)")

code, out = run(["databricks", "bundle", "validate", "-p", PROFILE, "-t", "dev",
                 "--var", f"tools_catalog={CATALOGO}", "--var", f"image_volume_catalog={CATALOGO}", *EXTRA_VARS], check=False, quiet=True)
print(("ok     " if code == 0 else "FALHA  ") + "configuração do bundle")
if code != 0:
    print(out); problemas.append("a validação do bundle falhou (saída acima)")
assert not problemas, "Corrija antes de instalar:\n- " + "\n- ".join(problemas)
print("\nTudo certo." + (" Troque 'acao' para 'instalar' e rode de novo." if ACAO == "verificar" else ""))''')

code(r'''# 4) Instalação: Lakebase, SQL Warehouse, dashboard, job e app → código → auto-config
if ACAO != "instalar":
    dbutils.notebook.exit("Modo 'verificar': nada foi criado. Troque 'acao' para 'instalar' e rode de novo.")
run(["bash", "deploy.sh", PROFILE, CATALOGO])''')

code(r'''# 5) Próximos passos
_, out = run(["databricks", "apps", "get", "ai-prism", "-p", PROFILE, "-o", "json"], quiet=True)
url = json.loads(out).get("url", "")
displayHTML(f"""<h3>AI Prism instalado</h3>
<p><a href="{url}" target="_blank">{url}</a></p>
<ol>
<li>Abra o app: o usuário que instalou já é o administrador.</li>
<li>Em <b>Compute → Apps → ai-prism → Permissions</b>, dê <b>Can Use</b> aos usuários e grupos que vão usar o app.</li>
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
    out_path = sys.argv[1] if len(sys.argv) > 1 else "Instalar AI Prism.py"
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(build())
    print("ok", out_path)
