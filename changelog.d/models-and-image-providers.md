### Added

- **Deploy-time `models.json`**: a documented file at the project root lists the chat models of the picker (order, label, price) and, optionally, the image models. The first admin request after a deploy that changed it applies it to the model catalog; the admin *Models* tab keeps working, and a deployment without the file behaves as before. A catalog an admin already curated is only extended the first time, so nothing is switched off by the upgrade. `./deploy.sh --models-file FILE` (`deploy.ps1 -ModelsFile`, `AI_PRISM_MODELS_FILE`) deploys your own copy.
- **Models file validator**: `scripts/validate-models-config.mjs` checks the file (shape, duplicates, model ids) and, with a profile, that each image model exists in the workspace. `deploy.sh` and `deploy.ps1` run it before they write or deploy anything, and the unit tests run it too.
- **Image models from a Unity Catalog Model Provider Service**: an `imageModels` item `{ provider, model, label }` is called through the AI Gateway native Gemini route (`/ai-gateway/gemini/...`) with the user's token, and carries the cost tags in the `Databricks-Ai-Gateway-Request-Tags` header. Serving-endpoint image models keep working, and both kinds can share the list.
- **Image availability check**: the app probes each image model (serving endpoint state or provider targets) with its service principal every 10 minutes. A model it cannot confirm stays visible, a 404 on a real call takes it out until restart, and `imageModels: []` or `IMAGE_GENERATION=off` turns image generation off.

### Changed

- **Titles, intent, memory extraction and design-asset labels run on the conversation's model** (at low reasoning, with headroom for reasoning models) instead of a hard-coded `claude-haiku-4-5`, so they work in workspaces without that endpoint and the cost lands under the model the user chose.

### Removed

- **Claude Haiku 4.5 as a built-in default**: it is no longer in the curated list or used for helper calls. It still works as a custom endpoint if an admin enables it.

### Deploy notes

- No database migration. The applied `models.json` hash is kept in `app_settings`.
- For a Model Provider Service image model, users need `USE CATALOG`, `USE SCHEMA` and `EXECUTE ON MODEL PROVIDER SERVICE`; list the allowed targets with `databricks ai-gateway get-model-provider-service model-provider-services/<provider> -p <PROFILE>`.
