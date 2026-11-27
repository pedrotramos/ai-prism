### Added

- **Reproducible customer ZIP** (`scripts/build-customer-zip.sh`): builds `dist/ai-prism-<version>.zip`
  from the committed tree (`git archive HEAD`) plus a freshly built `server-dist/` and `client/dist/`
  (there is no skip-build option), from an explicit allow-list, and fails if anything development-only
  (tests, `node_modules`, hidden files, logs, zips) got into the package. Everything sits in one root
  folder, `ai-prism/`, with a folder entry for every directory ahead of its content (the Workspace
  ZIP import fails with a 404 on the first file without them; the build fails if a parent is missing).
  Reproducible byte for byte: every entry carries the commit date (or `SOURCE_DATE_EPOCH`, rounded to
  an even second), the modes are normalized and `zip` runs in UTC. `package-lock.json` leaves with the
  public npm registry instead of the internal proxy URLs. `ai-prism-manifest.txt` (format 2) lists
  `<sha256>  <file>` for every file, with the installer notebook as `# optional`. `dist/` is ignored by git.
- **Folder guard in `deploy.sh` / `deploy.ps1`** (no opt-out, before any workspace call): refuses the
  home folder and the disk root; outside a git checkout it only goes on in the exact tree of the ZIP
  (manifest present and in format 2, no extra file or linked folder, every file with the manifest's
  sha256; `app.yaml` only has to exist, the installer notebook is optional); inside a git checkout it
  refuses untracked files that `.gitignore` and the sync excludes do not cover
  (`AI_PRISM_ALLOW_UNTRACKED=1` for developers). A new ZIP imported over an old folder is refused file
  by file. The first line printed is `==> AI Prism <version> commit <sha>`.
- **`--check-tree` / `-CheckTree`**: runs the same guard, prints the package version and exits, with no
  CLI, no profile, no network and nothing written or deleted.
- **`sync.exclude` in `databricks.yml`** for folders without git: `node_modules`, caches, logs, `*.zip`,
  the manifest and every hidden item at any depth except the root `.npmrc` and `.nvmrc`. Verified with
  a real `bundle sync --dry-run` in a folder without git and in a git checkout; `server-dist/` and
  `client/dist/` still upload.
- **Install from the Workspace in one upload**: `Install AI Prism.py` shows the package version, its
  `check` action runs `deploy.sh --check-tree`, and the instructions say to import the ZIP into a new,
  empty folder, open `ai-prism/Install AI Prism`, leave **source** empty, then run `check` and `install`.
- Docs in English, Português (Brasil) and Español: [Install from a ZIP](docs/install-from-zip.md).

### Changed

- Outside a git checkout `deploy.sh` / `deploy.ps1` skip the build (the ZIP ships the built artifacts and
  the manifest pins their hash) and delete the CLI's local `sync-snapshots` before the deploy, so the
  sync is complete even when an older ZIP is unpacked over a deployed folder. The cleanup never follows a
  symlink on any component of the path: if one is a link, the deploy stops without deleting anything.
- `.gitignore` ignores `/dist/`.

### Deploy notes

- No database migration. Stacked on #184 (deploy plan gate, with #183) and #186 (slim bundle and PDF fix).
