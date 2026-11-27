### Added

- **Custom (advanced) schedule for agents**: next to the five presets (every hour, day, weekdays, week, month), the
  agent editor offers a standard five-field cron (`0 9,17 * * 1-5`, `0 8 * * 1,3,5`, `0 6 1,15 * *`) with a time
  zone and the next three runs previewed by the server as you type. Names (`MON`, `JAN`), lists, ranges, steps and
  `@daily`-style shortcuts work; a cron that never matches a real date, is malformed or would run more often than
  once an hour is refused with a specific message (`cron_invalid`, `cron_fields`, `cron_never`,
  `schedule_too_frequent`). A cron that one of the presets covers is saved as that preset, and any other is saved in one
  canonical spelling (`MON-FRI` is stored as `1-5`), so the common spellings (names, `7` for Sunday, order, ranges) share one approval hash. A day list that starts with `*` and is not a plain step (`*/2,MON`) keeps its own spelling, so an equivalent respelling of it is a new definition and asks for approval again (the safe side). The
  administrator's review card shows the same description and next three runs the owner saw, with a notice when both
  day fields are set (they mean "either"). Validation and the next-run search share one exact calendar walk, so
  rare dates such as a leap-day Sunday (`0 0 29 2 */7`) are accepted and previewed instead of failing. The cron and the time zone are part of the approval scope: editing either sends the
  agent back to administrator approval (ADR 0017). `shared/cron.ts`, `server/agents/schedule.ts`.
- **Costs page: per-day and per-agent views**: **By day** splits every day of the period by resource type (Model
  Serving, SQL Warehouse, App, database, jobs) with a line chart; **By agent** splits the AI model cost by scheduled
  agent (from the `ai_prism_agent_id` of the run's usage context), with chat and other interactive use as the
  remaining row so the rows add up to the whole AI spend. Both views are in the CSV export; in the by-agent file the interactive and deleted-agent rows carry the page's
  label in the UI language instead of an empty cell.
  `GET /api/costs?by=day|agent`.

### Changed

- **The scheduler sleeps until the next due run**: the longest it waits between database checks goes from 15 minutes
  to 6 hours (`AI_PRISM_SCHEDULER_MAX_SLEEP_MS`, 1 s to 24 h; the old `AGENT_SCHEDULER_MAX_SLEEP_MS` is still read).
  It wakes for the next due run, a queued manual run or the end of a run's lease; for a change it handled itself
  (approve, enable, disable, delete, run now); and 15 s after the app starts (was 60 s). With no query in between,
  the connection pool closes and Lakebase can scale to zero between runs. Several replicas still share the work
  through the same locks.

### Deploy notes

- Nothing to migrate: the schedule is stored in the agent definition and the new per-agent cost view reads the usage
  context the runs already stamp (migration number 0021 is reserved and not used).
- A change made on one replica reaches the others through use of the app: every signed-in request lets a replica that
  has not looked at the schedules for 5 minutes look again, so while the app is in use a schedule saved on a replica
  that then stops is claimed by another well inside the 60-minute grace. With the app idle, nothing wakes the others
  sooner than their next due run, the 6-hour check or their start, so a slot saved just before the last replica that
  knew of it stopped can be recorded `missed`, and a run whose app died can stay `running` until a replica next wakes
  (up to 6 hours by default). Lower `AI_PRISM_SCHEDULER_MAX_SLEEP_MS` if that matters more than idle Lakebase time.
- A signal that lands while a scheduler tick is running (an admin turning agents on) is no longer overwritten by that
  tick's own sleep.
