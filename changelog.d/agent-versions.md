### Added

- **Immutable agent versions with history, diff, restore and duplicate.** Every save of an agent is now a numbered
  version that can never change afterwards (the database refuses it). *Versions* on an agent card lists the history
  and shows what changed since the previous version: a line diff of instructions and prompt, tools added or removed,
  and the model, effort, schedule, language, name and description. *Restore* saves an old version again as the newest
  one; *Duplicate* copies a version into a new draft agent.
- **Sharing an agent with people, groups or the whole app, approved per version.** Owners pin an audience to one
  version and submit it; an administrator approves each version in the review queue (with the diff against the last
  approved version), and a share counts only from an approved version. Recipients see the agent under *Shared with
  you*, can try it in a chat or copy it, and never run the owner's agent. Revoking an approval unshares at once.
  Decisions are audited as `agent.version.approve|reject|revoke`. Design: `docs/adr/0020-agent-versions.md`; the
  scheduling approval of ADR 0017 is unchanged.
- **New endpoints** under `/api/agents/:id/versions`, `/shares`, `/duplicate`, `/api/agents/shared-with-me` and
  `/api/admin/agent-versions`; interface strings in English, Portuguese and Spanish; documentation in the three
  languages (`docs/agents.md`).

### Deploy notes

- **Migration `0017_agent_versions`** adds the `agent_versions` and `agent_shares` tables with row-level security
  (nine policies) and a guard trigger. It is additive: the previous release ignores it. Agents saved before it get
  their first version row the first time the owner opens the history or saves.
