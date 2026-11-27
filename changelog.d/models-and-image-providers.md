### Added

- **Optional models file**: `models.example.json` lists the curated chat models; copy it, edit it and deploy with `./deploy.sh --models-file my-models.json` (`deploy.ps1 -ModelsFile`, `AI_PRISM_MODELS_FILE`) to say which chat models (order, label, price) and image models the app offers. Nothing is shipped active: a deploy without the option behaves exactly as before. The validated copy is staged at the git-ignored `deploy-config/models.json` (never over a tracked file); the first admin visit to *Settings → Models* after a deploy that changed it applies it. The first apply on an already curated catalog only adds missing models, disabled; later applies keep a price, name or description the file omits.
- **Models file validator**: `scripts/validate-models-config.mjs` checks the file (shape, duplicates, model ids) and, with a profile, that each image model exists in the workspace (a check that cannot run is a warning). `deploy.sh` and `deploy.ps1` run it before they write or deploy anything, and the unit tests run it too.
- **Image models from a Unity Catalog Model Provider Service**: an `imageModels` item `{ provider, model, label }` is called through the AI Gateway native Gemini route (`/ai-gateway/gemini/...`) with the user's token, and carries the cost tags in the `Databricks-Ai-Gateway-Request-Tags` header (`system.ai_gateway.usage.request_tags`). Serving-endpoint image models keep working, and both kinds can share the list.
- **Image availability check**: the app probes each enabled image model (serving endpoint state or provider targets) with its service principal every 10 minutes. A model it cannot confirm stays visible, a user's own 403/404 is never cached for others, a 404 on a real call takes the model out until restart, and `generate_image` is offered only when an enabled, ready model exists. Switching every image model off in the *Models* tab, `imageModels: []` or `IMAGE_GENERATION=off` turns image generation off.

### Changed

- **Titles, intent, memory extraction and design-asset labels run on the conversation's model** (at low reasoning, with headroom for every model) instead of a hard-coded `claude-haiku-4-5`, so they work in workspaces without that endpoint. Their cost lands in the cost ledger under the model the user chose (not shown per message yet).
- **Asset labeling** (`/api/deck-templates/label-assets`) only uses a model that is enabled in the catalog.

### Removed

- **Claude Haiku 4.5 as a built-in default**: it is no longer in the curated list or used for helper calls.

### Deploy notes

- No database migration. The applied models-file hash is kept in `app_settings`.
- For a Model Provider Service image model, users need `USE CATALOG`, `USE SCHEMA` and `EXECUTE ON MODEL PROVIDER SERVICE`; list the allowed targets with `databricks ai-gateway get-model-provider-service model-provider-services/<provider> -p <PROFILE>`.
