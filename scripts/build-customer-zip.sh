#!/usr/bin/env bash
# Builds the ZIP that goes to the customer: dist/ai-prism-<version>.zip.
#
#   ./scripts/build-customer-zip.sh [--out <folder>]
#
# What goes in is the COMMITTED tree (git archive HEAD) plus the server-dist/ and client/dist/
# built on the spot from it (npm run bundle, in a temporary folder: your working tree is not
# touched; it needs `npm ci --include=dev` once, because the .npmrc omits the
# devDependencies, which is where vite and esbuild live). Uncommitted changes do NOT go in:
# the script warns when there are some. There is no --skip-build on purpose: it would ship a
# stale server-dist/ from the working tree.
#
# Everything sits inside ONE root folder, `ai-prism/`: an `unzip` in a terminal creates that
# folder instead of scattering files into the current directory (from a folder such as
# Downloads or $HOME, the deploy would upload whatever is there to the workspace and to the
# App). The Workspace ZIP import and the installer notebook find the project (databricks.yml +
# deploy.sh) with or without that folder. Next to it goes ai-prism-manifest.txt (the files of
# the ZIP with the sha256 of each one): outside a git, deploy.sh/deploy.ps1 only run in a
# folder that matches it, file by file (--check-tree runs just that check).
#
# The list of what the customer needs is EXPLICIT (an allow-list), not "everything minus what
# I remembered to remove": a new file in the repository only reaches the customer if someone
# adds it to KEEP, and at the end the script checks that nothing dev-only (tests,
# node_modules, .git, .github, .claude, __pycache__, .DS_Store, .env*, scratch, logs, zips...)
# got out. package-lock.json leaves with the `resolved` URLs of the internal Databricks npm
# proxy swapped for the public registry. The ZIP is reproducible byte for byte (same commit,
# same sha256, any time zone and umask) and is not tracked by git (/dist/ is in .gitignore).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

ROOT_NAME=ai-prism   # root folder inside the ZIP (the docs say `cd ai-prism`)
OUT_DIR="$ROOT/dist"
while [ $# -gt 0 ]; do
  case "$1" in
    --out) shift; OUT_DIR="$(mkdir -p "${1:?--out needs a folder}" && cd "$1" && pwd)" ;;
    -h|--help) sed -n '2,25p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1 (use --out <folder>)" >&2; exit 2 ;;
  esac
  shift
done

# What the customer needs (paths at the repository root). Each item is here for a reason:
KEEP=(
  databricks.yml        # the bundle (App, job, Lakebase, warehouse, dashboards)
  app.yaml              # the App's command and scopes
  package.json          # the Apps platform reads package.json (build/start script, Node >= 22)
  package-lock.json
  .npmrc                # omit=dev: the App installs no packages on start
  .nvmrc
  deploy.sh             # install (macOS/Linux)
  deploy.ps1            # install (Windows)
  "Install AI Prism.py" # install from the Workspace (the Workspace turns it into a notebook)
  bundle                # auto-config job (auto_config.py, python_udf_ddl.py)
  dashboards            # cost and operations dashboards of the bundle
  server                # server code: migrations and the deploy-time database steps use it (what runs is server-dist)
  shared                # modules used by the server and the client
  docs
  README.md
  README.pt-BR.md
  README.es.md
  CHANGELOG.md
  LICENSE
  SECURITY.md
  scripts/migrate.mjs   # deploy.sh runs it (owner hand-off, migrations, grants)
  scripts/smoke.mjs     # deploy.sh runs it (npm run smoke) against the deployed app
)
# Built (server-dist/ is tracked but stale on feature branches; client/dist/ too; both are rebuilt here):
BUILT=(server-dist client/dist)

# None of this may appear in the ZIP (checked at the end, at any level).
FORBIDDEN_RE='(^|/)(node_modules|\.git|\.github|\.claude|\.isaac|\.vscode|\.idea|\.databricks|tests|test|e2e|coverage|scratch|scratch-decks|logs|__pycache__|__fixtures__|i18n-pending)(/|$)|\.pyc$|(^|/)\.DS_Store$|(^|/)\.env|\.log$|\.zip$|\.tar\.gz$|\.tgz$|\.test\.[cm]?[jt]sx?$|\.patch$|(^|/)client/(src|dev|public)(/|$)|(^|/)\.llm-prompt\.md$'

VERSION="$(node -e "console.log(JSON.parse(require('fs').readFileSync('package.json','utf8')).version)")"
ZIP_NAME="${ROOT_NAME}-${VERSION}.zip"

git rev-parse --git-dir >/dev/null 2>&1 || { echo "run inside the git repository (the ZIP comes from git archive HEAD)" >&2; exit 1; }
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "WARNING: there are uncommitted changes; they do NOT go into the ZIP (only what is in HEAD, $(git rev-parse --short HEAD))." >&2
fi

STAGE="$(mktemp -d "${TMPDIR:-/tmp}/ai-prism-zip.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT
SRC="$STAGE/src"; OUTER="$STAGE/pkg"; PKG="$OUTER/$ROOT_NAME"
mkdir -p "$SRC" "$PKG"

echo "==> committed tree ($(git rev-parse --short HEAD)) -> temporary folder"
git archive HEAD | tar -x -C "$SRC"

# .npmrc has omit=dev and the build tools (vite, esbuild) are devDependencies: a plain `npm ci` does not install them
for tool in vite esbuild; do
  [ -x "$ROOT/node_modules/.bin/$tool" ] || { echo "$tool is missing from node_modules (run \`npm ci --include=dev\` once: the .npmrc omits the devDependencies, where the build tools live); without it server-dist/ and client/dist/ cannot be built" >&2; exit 1; }
done
ln -s "$ROOT/node_modules" "$SRC/node_modules"
echo "==> building server-dist/ and client/dist/ (npm run bundle)"
if ! (cd "$SRC" && npm run bundle >"$STAGE/build.log" 2>&1); then
  tail -n 40 "$STAGE/build.log" >&2
  echo "the build failed (log above)" >&2
  exit 1
fi
tail -n 3 "$STAGE/build.log" | sed 's/^/    /'
rm -f "$SRC/node_modules"

for b in "${BUILT[@]}"; do
  [ -d "$SRC/$b" ] || { echo "$b is missing after the build" >&2; exit 1; }
done

echo "==> assembling the package"
for item in "${KEEP[@]}" "${BUILT[@]}"; do
  [ -e "$SRC/$item" ] || { echo "expected item does not exist in the repository: $item" >&2; exit 1; }
  mkdir -p "$PKG/$(dirname "$item")"
  cp -R "$SRC/$item" "$PKG/$item"
done
# Inside the folders that do go, what is development only: tests and their fixtures, the docs translation
# workflow (hidden prompts, pending drafts).
find "$PKG" -type f \( -name '*.test.*' -o -name '.llm-prompt.md' \) -delete
rm -rf "$PKG/server/__fixtures__" "$PKG/server/webSearch/fixtures" "$PKG/docs/i18n-pending"
# The repository's package-lock.json has `resolved` URLs of the internal Databricks npm proxy
# (npm-proxy.cloud.databricks.com): outside the Databricks network that host does not resolve and
# `npm ci` fails. It is the same package (the integrity does not change); it becomes the public registry.
sed -i.bak 's#https://npm-proxy\.cloud\.databricks\.com/#https://registry.npmjs.org/#g' "$PKG/package-lock.json" && rm -f "$PKG/package-lock.json.bak"
! grep -q 'npm-proxy' "$PKG/package-lock.json" || { echo "an internal proxy URL is left in package-lock.json" >&2; exit 1; }
# Leftovers of any kind that came inside the copied folders.
find "$PKG" \( -name __pycache__ -o -name node_modules \) -type d -prune -exec rm -rf {} + 2>/dev/null || true
find "$PKG" \( -name '*.pyc' -o -name .DS_Store -o -name '*.log' \) -type f -delete

# Checks: the minimum to install, and nothing dev-only.
for must in databricks.yml deploy.sh deploy.ps1 app.yaml package.json "Install AI Prism.py" \
            bundle/auto_config.py bundle/python_udf_ddl.py dashboards/ai-costs.lvdash.json server-dist/index.cjs \
            client/dist/index.html scripts/migrate.mjs scripts/smoke.mjs server/migrations/0001_baseline.up.sql \
            LICENSE CHANGELOG.md README.md; do
  [ -f "$PKG/$must" ] || { echo "missing from the package: $must" >&2; exit 1; }
done
[ -x "$PKG/deploy.sh" ] || chmod +x "$PKG/deploy.sh"
if (cd "$PKG" && find . -mindepth 1 | sed 's#^\./##' | grep -E "$FORBIDDEN_RE" >/dev/null); then
  echo "files that must not go to the customer showed up in the package:" >&2
  (cd "$PKG" && find . -mindepth 1 | sed 's#^\./##' | grep -E "$FORBIDDEN_RE") >&2
  exit 1
fi
# Hidden items: only .npmrc and .nvmrc (at the root) are allowed.
HIDDEN="$(cd "$PKG" && find . -mindepth 1 -name '.*' | sed 's#^\./##' | grep -vxE '\.npmrc|\.nvmrc' || true)"
[ -z "$HIDDEN" ] || { echo "unexpected hidden items in the package:" >&2; echo "$HIDDEN" >&2; exit 1; }

# ai-prism-manifest.txt (format 2): one "<sha256>  <path>" line per file of the package (except itself). Outside a git,
# deploy.sh/deploy.ps1 only run in a folder whose files (except what the deploy itself generates: .databricks/, node_modules/,
# .DS_Store...) are all listed here AND have exactly these hashes (the installer notebook is "optional": the Workspace converts
# it on import): a Workspace import over an old folder, which mixes files of different versions, is refused. (app.yaml is the
# exception in the check: the deploy rewrites it.)
MANIFEST="$PKG/ai-prism-manifest.txt"
{
  echo "# ai-prism-manifest 2"
  echo "# version ${VERSION} commit $(git rev-parse --short HEAD)"
  python3 -I - "$PKG" <<'PY'
import hashlib, os, sys
root = sys.argv[1]
# The Workspace import turns the installer notebook into a NOTEBOOK object, and the installer's own export skips it: it goes in the
# ZIP but stays OUTSIDE the deploy's check (no hash; the folder may or may not have it). The deploy does not need it.
OPTIONAL = ['Install AI Prism.py']
rels = []
for d, _dirs, files in os.walk(root):
    for f in files:
        rel = os.path.relpath(os.path.join(d, f), root).replace(os.sep, '/')
        if rel != 'ai-prism-manifest.txt' and rel not in OPTIONAL:
            rels.append(rel)
for rel in OPTIONAL:
    assert os.path.isfile(os.path.join(root, rel)), rel
    print(f'# optional {rel}')
for rel in sorted(rels, key=lambda r: r.encode('utf-8')):
    h = hashlib.sha256()
    with open(os.path.join(root, rel), 'rb') as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b''):
            h.update(chunk)
    print(f'{h.hexdigest()}  {rel}')
PY
} > "$MANIFEST"

# Byte-for-byte reproducible: two builds of the same commit give the same ZIP (same sha256), in any time zone and with any umask.
# Every entry (file and folder) gets the commit date (or SOURCE_DATE_EPOCH, if set; rounded DOWN to an even second) instead of the
# build time, and zip runs in UTC (the ZIP stores local time).
EPOCH="${SOURCE_DATE_EPOCH:-$(git log -1 --format=%ct)}"
case "$EPOCH" in ''|*[!0-9]*) echo "invalid SOURCE_DATE_EPOCH: $EPOCH" >&2; exit 1 ;; esac
[ "$EPOCH" -ge 315532800 ] || EPOCH=315532800   # a ZIP cannot store dates before 1980
EPOCH=$((EPOCH - EPOCH % 2))                    # the ZIP (DOS) date has 2 s resolution: an even second, so nothing is rounded later
STAMP="$(date -u -r "$EPOCH" +%Y%m%d%H%M.%S 2>/dev/null || date -u -d "@$EPOCH" +%Y%m%d%H%M.%S)"   # BSD (macOS) or GNU (Linux)
# The modes (rwxr-xr-x / rw-r--r--, plus the execute bit the file already has) do not depend on the builder's umask either.
chmod -R u=rwX,go=rX "$OUTER"
find "$OUTER" -exec env TZ=UTC touch -h -t "$STAMP" {} +

mkdir -p "$OUT_DIR"
OUT="$OUT_DIR/$ZIP_NAME"
rm -f "$OUT"
# The ZIP also carries one entry for every FOLDER (find without `-type f`; sorted, so a folder comes before what is inside it).
# The Workspace ZIP import creates the entries in order and requires the parent folder to exist already: without folder entries
# it fails on the first file (404 on ai-prism/.npmrc, "Error importing ai-prism-<version>.zip").
(cd "$OUTER" && find "$ROOT_NAME" | LC_ALL=C sort | TZ=UTC zip -X -q "$OUT" -@)
python3 -I - "$OUT" <<'PY' || { echo "the ZIP lacks the folder entries the Workspace import needs (above)" >&2; exit 1; }
import sys, zipfile
names = zipfile.ZipFile(sys.argv[1]).namelist()
dirs = {n for n in names if n.endswith('/')}
need = {'/'.join(n.rstrip('/').split('/')[:i]) + '/' for n in names for i in range(1, len(n.rstrip('/').split('/')))}
missing = sorted(need - dirs)
if missing:
    sys.exit('zip without folder entries: ' + ', '.join(missing[:5]) + (f' (+{len(missing) - 5})' if len(missing) > 5 else ''))
# and every parent entry must come BEFORE its content
seen = set()
for n in names:
    parent = '/'.join(n.rstrip('/').split('/')[:-1])
    if parent and parent + '/' not in seen:
        sys.exit(f'zip entry {n} comes before its parent folder {parent}/')
    seen.add(n)
PY

echo "==> $OUT"
echo "    files:"
unzip -Z1 "$OUT" | grep -v '/$' | LC_ALL=C sort | sed 's/^/      /'
COUNT="$(unzip -Z1 "$OUT" | grep -vc '/$' || true)"
NDIRS="$(unzip -Z1 "$OUT" | grep -c '/$' || true)"
SIZE="$(du -h "$OUT" | cut -f1)"
echo "    $COUNT files (+ $NDIRS folder entries), $SIZE ($(wc -c <"$OUT" | tr -d ' ') bytes) — $ZIP_NAME"
echo "    top-level folders:"
unzip -Z1 "$OUT" | grep -v '/$' | awk -F/ -v r="$ROOT_NAME" 'NF>2{c[$2]++} NF==2{c["(root of " r "/)"]++} END{for(k in c) printf "      %-16s %d\n", k, c[k]}' | LC_ALL=C sort
