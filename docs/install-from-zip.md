# Install AI Prism from a ZIP

**English** · [Português (Brasil)](pt-BR/install-from-zip.md) · [Español](es/install-from-zip.md)

For people who receive AI Prism as a file instead of cloning the repository. The ZIP holds
the app already built, so the person installing it needs no git and no Node build: the
Workspace notebook can do the whole installation, or you can run `deploy.sh` /
`deploy.ps1` from a terminal. Either way, a **folder guard** checks that the folder is
exactly what the ZIP contained before anything is sent to your workspace.

## What the ZIP is

`ai-prism-<version>.zip` is built by maintainers with
`scripts/build-customer-zip.sh`. It contains:

- the committed source of that version plus a **fresh** `server-dist/` and `client/dist/`
  (the artifacts the App runs), from an explicit allow-list: the bundle, `app.yaml`,
  `deploy.sh`, `deploy.ps1`, the installer notebook, `bundle/`, `dashboards/`, `server/`,
  `shared/`, `docs/`, the READMEs, `CHANGELOG.md` and `LICENSE`. No tests, no
  `node_modules`, no hidden files other than `.npmrc` and `.nvmrc`;
- everything inside one root folder, **`ai-prism/`**, so unzipping never scatters files in
  the current directory. Every folder has its own entry in the ZIP and comes before its
  content: the Workspace importer needs that, or it fails on the first file;
- `package-lock.json` pointing at the public npm registry;
- `ai-prism-manifest.txt`: the version, the commit, and one `<sha256>  <file>` line per
  file (format 2).

The ZIP is **reproducible**: the same commit gives the same file, byte for byte, in any
time zone and with any umask (every entry carries the commit date, or
`SOURCE_DATE_EPOCH`). Compare the sha256 of the file with the one the maintainers publish.

## Option A: install from the Workspace (one upload)

1. In the Workspace, create a **new, empty** folder.
2. Open the folder menu (**⋮**) and choose **Import → File**, then pick
   `ai-prism-<version>.zip`. Databricks unpacks it into `ai-prism/`.
3. Open `ai-prism/Install AI Prism` and leave the **source** field empty: the notebook
   finds the project by itself and prints the **package version** it found.
4. Attach a classic cluster with **Dedicated / Single user** access mode, fill in the
   **catalog**, and run with **action = `check`**. It creates nothing, and it runs the
   same folder guard as the deploy, so a folder that mixes versions is refused here.
5. Switch **action** to `install` and run again. The first installation takes 10 to 15
   minutes.

The other fields (serverless, Lakebase sleep, usage policy, tags) are described in the
notebook and in [onboarding-deployment.md](onboarding-deployment.md). If you prefer, upload
the ZIP to a Unity Catalog **Volume** and put its path in **source**.

## Option B: install from a terminal

```bash
unzip ai-prism-<version>.zip          # creates the ai-prism/ folder
cd ai-prism
./deploy.sh --check-tree              # optional: only checks the folder
npm ci --include=dev                  # once: the database steps of the deploy use `pg`
./deploy.sh <PROFILE> [CATALOG]       # Windows: .\deploy.ps1 <PROFILE> [CATALOG]
```

In a ZIP folder the deploy **skips the build** (the artifacts come built, and the manifest
pins their hash), so it needs no build tools. See
[onboarding-deployment.md](onboarding-deployment.md) for the options and for what the
deploy does step by step.

## Updating

Import (or unzip) every new version into a **new, empty folder**, or delete the old folder
first. Importing a ZIP over an `ai-prism/` folder that already exists **merges** the files
and can keep the ones from the old version, so the guard refuses such a folder. The state
of the installation lives in your workspace, not in that folder, so a new folder updates
the same installation.

## The folder guard

`bundle deploy` uploads the **whole** folder to the workspace and to the App, and in a
folder without git it does not apply `.gitignore`. A ZIP unpacked into Downloads or the
home folder would upload PDFs, keys and `~/.databrickscfg`. So `deploy.sh` and
`deploy.ps1` check the folder first, before any workspace call and with no way to turn it
off. The deploy stops, and changes nothing, when:

- the folder is your home folder or the disk root;
- outside a git checkout: `ai-prism-manifest.txt` is missing, is not format 2, or the
  folder has a file it does not list (or a linked folder), or a listed file is missing or
  its sha256 differs. Two files only need to exist: `app.yaml` (the deploy rewrites it)
  and `models.json` if the version ships one. The installer notebook is optional: the
  Workspace converts it on import;
- inside a git checkout: there is an untracked file that `.gitignore` and the sync excludes
  of `databricks.yml` do not cover (a key, `credentials.json`, a PDF). Developers who know
  what they are doing can set `AI_PRISM_ALLOW_UNTRACKED=1`.

The first line the scripts print is `==> AI Prism <version> commit <sha>`.

`./deploy.sh --check-tree` (`.\deploy.ps1 -CheckTree`) runs only this guard, prints the
package version and exits: no CLI, no profile, no network, nothing written or deleted.

Outside a git checkout the deploy also deletes the CLI's local `sync-snapshots` before it
starts, so the sync is complete: the ZIP stamps its files with the commit date, and an older
ZIP unpacked over a deployed folder would otherwise leave the new code out of the App. It
never follows a symlink while doing so: if any part of `.databricks/bundle/<target>/sync-snapshots`
is a link, the deploy stops without deleting anything.

## Troubleshooting

| Message or symptom | Cause | What to do |
|---|---|---|
| `this folder mixes versions of AI Prism` | A ZIP was imported over an older `ai-prism/` folder | Import into a new, empty folder, or delete the old one first |
| `file(s) that are not part of AI Prism` | A file the ZIP does not have (a copy of a key, a PDF, a link) | Move or delete it; it would be uploaded to the workspace |
| `ai-prism-manifest.txt is missing` | The folder is not a git checkout and not the ZIP tree | Unzip into an empty folder and run from inside `ai-prism/` |
| `UNTRACKED file(s) outside .gitignore` | A git checkout with files the sync would upload | Track it, ignore it, move it, or set `AI_PRISM_ALLOW_UNTRACKED=1` |
| `Error importing ai-prism-<version>.zip` | A ZIP without folder entries | Use the ZIP built by `scripts/build-customer-zip.sh` |

## For maintainers: building the ZIP

```bash
npm ci --include=dev                    # once: the .npmrc omits devDependencies, where vite and esbuild live
./scripts/build-customer-zip.sh         # writes dist/ai-prism-<version>.zip (dist/ is not tracked)
```

The script reads the **committed** tree (`git archive HEAD`), so uncommitted changes do not
go in (it warns). It builds `server-dist/` and `client/dist/` in a temporary folder and has no
`--skip-build`. At the end it checks that nothing development-only (tests, `node_modules`,
`.git`, `.github`, hidden files, logs, zips) got into the package and that every folder has
its entry. `tests/customerZip.test.mjs` runs all of this, including a real
`databricks bundle sync --dry-run` in a folder without git and in a git checkout.
