# ADR 0018: Unattended agent runs: SP identity, leaderless claim with per-run leases

- **Status:** Accepted
- **Date:** 2026-11-22
- **Scope:** `server/scheduler/index.ts`, `server/scheduler/run.ts`, `server/db/agentScheduler.ts`,
  `server/agents/events.ts`, `server/index.js` (boot), `app.yaml`

## Context

ADR-0017 makes an agent runnable only after an admin approved its exact definition. This ADR is about the
other half: what actually runs it, on a schedule, with nobody at the keyboard, in an app that has more than one
process (several replicas, or the old and the new container during a redeploy). The requirements are that an
occurrence runs at most once whatever the number of processes, that a process that dies mid-run leaves nothing
stuck and nothing run twice, and that none of it adds a service or a dependency: Postgres is already the
coordination point of the app, and `server/retention.ts` already runs a periodic job on it.

## Decision

**One timer per process, a leaderless claim in Postgres, a lease per run.** Every process (when
`AGENTS_ENABLED=1`) runs `startAgentScheduler()`. A tick does one short claim transaction and commits before
anything executes:

1. `set_config('app.scheduler', 'on', true)` (transaction-local; the only module that writes it is
   `server/db/agentScheduler.ts`, pinned by a lint test) and `pg_try_advisory_xact_lock(0x41505234)` ("APR4").
   It is the transaction-level lock: COMMIT or ROLLBACK releases it, so a crashed claimer cannot leave it held
   on a pooled socket, and a second claimer is told `locked` and never waits.
2. Runs whose lease has expired become `failed/lease_expired` and count as a transient failure of their agent.
3. Queued manual runs ("run now") are taken, then due agents are claimed with `FOR UPDATE SKIP LOCKED`: one
   `agent_runs` row per occurrence in status `running`, with `lease_owner` and a 120 s lease, and
   `agents.next_run_at` advanced to the next occurrence counted from now.

`UNIQUE (agent_id, slot_at) WHERE trigger = 'schedule'` makes a second row for an occurrence impossible, and the
lock only keeps the claimers from doing the work twice: the constraint is the guarantee. The run then executes
through `executeAgentRun` (the service principal for the model and tools, the owner's identity for the data it
writes), with a heartbeat that renews the lease every 30 s as the owner. Two missed renewals abort the run as
`lease_lost`. The outcome is written by `finishRun`, as the owner and guarded by `lease_owner`, so a holder whose
lease was recovered cannot overwrite the recovered row. Then `recordRunOutcome` applies the agent's bookkeeping.

**Time is the database's.** Every statement takes an optional `$now` and compares against
`COALESCE($now, now())`. The process clock only arms timers; what is due, late or expired is decided in SQL, so
clock skew between replicas cannot cause a double or a missed run, and tests drive the whole machine by passing
`now`.

**Missed occurrences collapse.** An occurrence missed by more than the grace (60 min) is one `skipped/missed`
row and the schedule continues from now; one missed by at most the grace runs once, so N missed slots never
become N runs. A due agent whose previous run is still active is `skipped/overlap`.

**Failures are codes.** `error_code`, `disabled_reason` and the audit rows (`agent.run.start`, `.finish`,
`.skip`, written as the `system` actor) hold codes and ids, never a message or a prompt. Permanent codes
(`approval_expired`, `approval_changed`, `tool_not_admitted`, `model_not_allowed`, `sp_model_denied`,
`sp_no_user_credentials`, `sp_permission_denied`) disable the schedule at once. Transient codes (`sp_unavailable`,
`gateway_error`, `timeout`, `lease_lost`, `lease_expired`, `db_error`) count, and the third in a row disables it.
`cost_cap` and `shutdown` count for nothing. A success resets the counter. A schedule the code cannot compute is
disabled as `invalid_schedule`.

**A run that did not finish is never re-run.** Re-running would repeat spend and partial artifacts. The row is
failed as `lease_expired` by the next tick of any process and the next occurrence runs normally.

**Switches.** `AGENTS_ENABLED=1` (operator, `app.yaml`) starts the scheduler; `app_settings.agents_enabled`
(admin) is read at each tick, so an admin turning it on needs no restart and turning it off stops new claims.
With the env off, the scheduler is `null`: no timer and no SQL. The timers are `unref`'d.

## Consequences

- The cost while on is a look at the database at most every 6 h (`AI_PRISM_SCHEDULER_MAX_SLEEP_MS`; it was 15 min
  in earlier releases) plus a lease heartbeat per running run. The timer
  sleeps until the earliest of the next `next_run_at`, a queued manual run and a live lease, so a run-now starts
  within a second and a dead holder is recovered one tick after its lease **if this process is the one that was
  awake**; a replica that learns of nothing sooner sees a dead holder at its own next wake-up, which request
  activity (below) brings within about 5 minutes while the app is in use and the max sleep brings otherwise.
  Nothing queries the database in between, which is what lets the Lakebase pool drain and the instance scale to zero.
- Defaults: concurrency 2 per process (`AGENTS_MAX_CONCURRENT_RUNS`), 4 running across all processes, run
  timeout 10 min (`AGENT_RUN_TIMEOUT_MS`), lease 120 s, heartbeat 30 s, grace 60 min, 3 failures.
- `kick()` and the in-process `notifyAgentsChanged()` signal only re-arm the timer; they never claim. A tick that
  was running when a signal landed does not arm its own fixed sleep over the timer the signal armed: a poke counter
  makes it plan again from the database (found in review: enabling agents mid-tick could mean a 6 h sleep).
- Another replica finds a change through request activity (Natura's `ACTIVITY_REPLAN_MS`): every authenticated
  request tells the scheduler (`noteAgentsActivity`, from `auth`), and a scheduler that has not looked at the
  database for 5 minutes re-plans. While the app is in use the database is awake anyway, so this costs one read per
  5 minutes per replica and a slot saved on a replica that then stops is seen by another well inside the 60-minute
  grace. **The guarantee is conditional on use**: with nobody using the app nothing wakes the other replicas sooner
  than their own next due run, the 6-hour check or their start, and a slot saved just before the last replica that
  knew of it stopped can be claimed late (`skipped/missed` past the grace). That is the price of letting Lakebase
  scale to zero; lowering `AI_PRISM_SCHEDULER_MAX_SLEEP_MS` trades it back.
- A schedule may be a preset or a 5-field cron ("Custom (advanced)", `shared/cron.ts`): validated and
  canonicalised when saved (a cron equal to a preset becomes the preset; otherwise numbers only, sorted, runs as
  ranges, so the common respellings share one approval hash; a day list that starts with `*` and is not a plain step,
  such as `*/2,MON`, keeps its own spelling, so an equivalent respelling of it counts as an edit, the safe side), never more often than hourly, and part of the
  approved definition like the presets, so editing it goes back to approval (ADR 0017). Validation, the hourly floor
  and the occurrence search share one exact walk over a Gregorian cycle (400 years), so a saved cron always has a next
  occurrence. A DST gap follows the presets: the missing time runs at the first valid instant, so the hourly floor is
  a wall-clock rule that can be 30 minutes on that one day.
- The boot has no shutdown hook, so `stop()` (which cancels in-flight runs as `cancelled/shutdown`, bounded to
  10 s) is not wired to SIGTERM. A run cut off by a redeploy is failed as `lease_expired` by a surviving
  process. Wiring `stop()` to a shutdown hook is a follow-up when the boot gets one.
- The claim reads `approved_snapshot`, never the live row; the scheduler identity can see approved agents only,
  so a revoked agent's queued manual run is closed as `skipped/approval_changed` instead of blocking it.

## Rejected

- **A leader lease (one elected scheduler).** A third table, an election loop and a failover delay on exactly the
  redeploys where Apps restarts containers. Revisit if replicas grow past a handful and the claim lock becomes
  contended (claims skipped as `locked` above half of all claims over a day).
- **A platform scheduler (a Lakeflow Job per agent calling an app endpoint).** Per-agent workspace objects, a new
  grant model and a second place where "what runs" is decided. Revisit if customers ask for job-level SLAs.
- **A session-level advisory lock.** It would stay held on a pooled socket after a crash.
- **Re-running a run whose holder died.** Spend and partial artifacts are not idempotent.

## Rollback

Admin setting off (soft: no new claims), then remove `AGENTS_ENABLED` and redeploy (hard: no timer, no SQL).
Neither touches the schema.
