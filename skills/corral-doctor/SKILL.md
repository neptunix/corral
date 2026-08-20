---
name: corral-doctor
description: Use when fixing corral's own install health — a "Fix issues" spawn brief from the 🛟 Health panel, or a direct ask like "why is corral's health panel red", "corral won't show metrics", "fix corral", "corral doctor", "corral is missing X". Also use for general corral configuration, management and upgrade questions — environments.json, running/upgrading the server, the per-config-dir helper files. Not for the corral MCP tools (binding to a card, handoffs, messaging sessions) — that is the `corral` skill.
---

# corral-doctor

corral (the dashboard) diagnoses its own install continuously — `GET /api/diagnostics` and the 🛟
Health panel — and every row already names where the fix lives: `doc.title` / `doc.anchor` point at
one section of this repo's `README.md`. This skill is the loop that turns those rows into fixes; it
does not duplicate the catalog. **If a row's remedy is not in the README section it names, that is
a corral bug — fix the doc or the check, do not invent a workaround here.**

## The loop, per problem row

1. Read the row: `title`, `detail` (the specifics — a path, a version, an SSH error), `severity`
   (`fatal`/`warning`/`info`), and `scope` (`global`, or one `env`/config-dir — which machine and
   which `~/.claude*` dir this is about).
2. Open the README section `doc.title` names and read it in full before touching anything — most
   fixes are exactly the command shown there, but a couple require judgment (below).
3. Apply it. Prefer the least invasive fix that section actually recommends over a from-scratch
   reinstall.
4. Recheck: `POST /api/diagnostics/refresh` (or the Health panel's Recheck button) and confirm this
   specific row now reads `ok` before moving to the next one. A silent "should be fixed now" is not
   verification.
5. If a row's fix is ambiguous, destructive, or touches something you were not told to change —
   stop and ask rather than guess. See "Never" below for the standing refusals.

Work fatal rows before warning before info. A row scoped to an unreachable remote `env` may resolve
on its own once that box is reachable again — say so rather than chasing it.

## corral's configuration surface (orientation, not a copy of the README)

- **`environments.json`** (default `~/.corral/environments.json`, override `$CORRAL_CONFIG`; data
  home `$CORRAL_HOME`, default `~/.corral`) — one entry per machine corral can reach: `id`/`label`,
  `kind: "local"|"remote"`, `spawnCommand`, `claudeConfigDirs`, `repos`. See README → *Environments*.
- **Per-config-dir helper files** — the capture script and statusline registration that feed live
  metrics, installed once per `~/.claude*` dir. See README → *Installing the Claude helper files
  (per config dir)*. `helper-drift` rows report the installed copy **differs** from this checkout,
  not which direction is stale — read the row's detail before re-copying.
- **Env vars** — `DIAGNOSTICS_INTERVAL_MS`, `REMOTE_PROBE_ENABLED`, `UPDATE_CHECK_ENABLED`, and the
  rest are process-level, set where `npm start` runs. See README → *Configuration (env vars)*.
- **Upgrading** — `npm install` + a version bump, see README → *Upgrading*. `helper-drift` and the
  `update-check` row both point here.

## Never

These are corral's own hard limits, not a courtesy:

- **Never start, stop, or reload the herdr server yourself** — not `nohup`, not `disown`, not
  `HERDR_SOCKET_PATH=... herdr server &`. A server launched from inside a Claude Code session passes
  its own `CLAUDE_CODE_CHILD_SESSION` to every pane that server later spawns, silently breaking
  transcript persistence fleet-wide. Hand the exact command to the operator (README → *Running
  herdr*) and wait.
- **Never add, remove, or edit an environment through the API or by scripting a POST** —
  `environments.json` is trusted startup config specifically because it is not runtime-editable; a
  writable `sshHost` would turn the server into an SSH relay. Edit the file directly and tell the
  operator it needs a server restart to take effect — never try to make the change live without one.
- **The server has no auth by design** (loopback bind, no auth layer) — do not "fix" this by adding
  one; it is documented behavior (README → *Security model*), not a gap.
- **A `problem` on an unreachable remote `env`** may just mean the box is down. Don't SSH around a
  failed check to force an answer; report the environment as unreachable and stop there.

## When you are done

Summarize per row: fixed and reverified, could not fix (why, and what the operator needs to do), or
not actually broken (false positive — say why, and consider it worth a corral bug report). If this
session was spawned from a card (`corral_whoami` succeeds), write that summary there; otherwise say
it directly.
