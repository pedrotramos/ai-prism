# Documentation

**English** · [Português (Brasil)](pt-BR/README.md) · [Español](es/README.md)

Every guide for AI Prism, by task. English is the reference text; the
[translation status](i18n-status.md) shows which pages exist in Portuguese and
Spanish and whether they are up to date. Some pages are still written in
Portuguese only; they are marked below and get their English text in the next
phase.

## Deploy and run

- [Onboarding and deployment](onboarding-deployment.md): from an empty workspace to a running app in a few commands (`bundle deploy` + `apps deploy` + `bundle run`).
- [Costs and positioning](costs-and-positioning.md): which Databricks resources AI Prism consumes and why the model pays off.
- [Operations](operations.md): health, logs, proposed SLOs and the runbook for deploy, rollback and diagnosis.
- [Resource tags and cost attribution](tags.md) (Portuguese for now): how the app tags what it creates in the workspace.
- [Fleet governance](fleet-governance.md) (Portuguese for now): owner, naming, guardrails, cost attribution and retirement across several installations.
- [Cost and operations dashboards (AI/BI)](../dashboards/README.md): AI cost audit, usage volume and gateway latency from the system tables.

## Security

- [Security policy](../SECURITY.md): how to report a vulnerability and which controls the app has.
- [Security FAQ](security-faq.md): answers to the usual review objections, split between what the app does and what the platform does.
- [Threat model](security-threat-model.md) (Portuguese for now): assets, actors, trust boundaries, controls and declared gaps.

## Integrations

- [Connecting MCP servers](mcp-connections.md) (Portuguese for now): register an MCP Service in Unity AI Gateway, publish it in the app's MCP catalog and connect it inside AI Prism.
- [Microsoft 365 through Microsoft Graph](mcp-microsoft-graph.md) (Portuguese for now): email and calendar without a Copilot Studio Pro license, through your own MCP server over Graph.
- [Web search and reading](web-search.md) (Portuguese for now): the two native web tools and how to turn them off.

## Develop

- [Contributing](../CONTRIBUTING.md): development flow, tests and QA, commit conventions and pull requests.
- [Performance and load](performance.md) (Portuguese for now): how `npm run loadtest` works and the `EXPLAIN` of the critical queries.
- [Architecture decision records](adr/README.md) (Portuguese for now): one file per decision. ADRs are not translated; they move to English in a later phase.
- [Glossary](glossary.md): the app's own words in English, Portuguese and Spanish, generated from the UI catalogs.

## Translations

English is canonical. A translation mirrors the English path under
`docs/<locale>/` (`docs/pt-BR/operations.md` translates `docs/operations.md`;
`SECURITY.md` and `CONTRIBUTING.md` become `docs/<locale>/SECURITY.md` and
`docs/<locale>/CONTRIBUTING.md`). The root README is the exception:
`README.pt-BR.md` and `README.es.md`. The list of translated pages and the pages
still pending live in [i18n.json](i18n.json).

Line 1 of each translation records the English version it matches:

```md
<!-- i18n: source=docs/operations.md source-hash=<git blob sha of the English file> status=current -->
```

- `current`: matches that English version.
- `outdated`: English changed and the translation was flagged on purpose; the page shows a banner that points to English.
- `machine`: machine-assisted translation waiting for a native review; also shows a banner.
- `stub`: a short placeholder that points to English.

`scripts/check-docs-i18n.mjs` fails when English changes and a translation still says
`current`, when headings, tables or code blocks diverge, when a code block differs
in anything other than comments, when a relative link or anchor breaks, or when the
language switcher under the title is missing. When you change an English page:

```bash
node scripts/check-docs-i18n.mjs                     # what is out of sync
node scripts/check-docs-i18n.mjs --stamp docs/pt-BR/operations.md                    # after updating the translation
node scripts/check-docs-i18n.mjs --stamp docs/es/operations.md --status outdated     # when you could not update it
node scripts/check-docs-i18n.mjs --report            # regenerate docs/i18n-status.md
node scripts/check-docs-i18n.mjs --glossary          # regenerate docs/glossary.md after a UI copy change
```

Code blocks stay byte-identical across languages: translate only the comments.
When a block holds prose that must be translated (a diagram's labels, for example),
put `<!-- i18n: code-translated -->` on the line above its opening fence in every
language. For machine-assisted drafts, use the style guide of the language
([pt-BR](pt-BR/.llm-prompt.md), [es](es/.llm-prompt.md)) together with the
[glossary](glossary.md), and have a native speaker review before the status
becomes `current`.
