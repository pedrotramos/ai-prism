### Added

- **Immutable agent versions with history, diff, restore and duplicate.** Every save of an agent is now a numbered
  version that can never change afterwards (the database refuses it). *Versions* on an agent card lists the history
  and shows what changed since the previous version: a line diff of instructions and prompt, tools added or removed,
  and the model, effort, schedule, language, name and description. *Restore* saves an old version again as the newest
  one; *Duplicate* copies a version into a new draft agent. The version payload is an open document: restore,
  duplicate, a copy of a shared version and an edit of the recipe fields keep keys they do not know (a later flow
  graph), and the screens show a payload without a recipe instead of failing.
- **Sharing an agent with people, groups or the whole app, approved per version and per audience.** Owners submit a
  version for sharing approval and ask to share it with an audience; an administrator approves the content of the
  version and, separately, each audience pinned to it (`agent.version.*` and `agent.share.*` audit rows; the review
  queue is filtered and paged on the server, requests first, with the diff against the last approved version).
  Nothing is live until both are approved, so an owner cannot widen the audience of an approved version without a new
  decision; moving an approved audience to another approved version needs none. Recipients see the agent under
  *Shared with you*, can try it in a chat or copy it, and never run the owner's agent. Revoking either approval
  unshares at once. An administrator who owns the agent may approve it (single-administrator installs); the card and the
  audit record say it is a self-approval. Design: `docs/adr/0020-agent-versions.md`.
- **New endpoints** under `/api/agents/:id/versions`, `/shares`, `/duplicate`, `/api/agents/shared-with-me`,
  `/api/admin/agent-versions` and `/api/admin/agent-shares`; interface strings in English, Portuguese and Spanish;
  documentation in the three languages (`docs/agents.md`).

### Changed

- **Scheduling and sharing are separate approvals.** Submitting or approving an agent for scheduled runs (ADR 0017,
  unchanged) never approves a version for sharing, and approving a version never approves the agent.

### Deploy notes

- **Migration `0017_agent_versions`** adds the `agent_versions` and `agent_shares` tables with row-level security (ten
  policies) and two guard triggers. It is additive: the previous release ignores it. Agents saved before it get their
  first version row the first time the owner opens the history or saves, as a version that is **not submitted**: an agent
  that was waiting or approved for scheduling needs its current version submitted once before it can be shared.
