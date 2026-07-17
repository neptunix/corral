# herdr-dashboard — Design Spec

**Date:** 2026-06-18
**Status:** Approved design — **v1.3 (attention feed + live terminal)**

> **v1.1 changelog** — revised after a 4-persona review panel (Architect, Backend, Security,
> AI Engineer). Added: problem statement (§1), phased build order (§2.1), command-injection &
> bind-address hardening (§4, §5, §11, §13), per-file mutex concurrency model (§6.3),
> pane-output snapshot into attention records (§10), `pane get` in the adapter + `cwd`/JSON
> notes (§5), spawn idempotency & `from-session` claim race & server-assigned `author` &
> comment idempotency (§7, §9), poll-overlap guard & SSH command timeout & focus mechanism
> (§8), `poller.ts` split & `CLAUDE.md` & agent-stub (§15, §17), git guardrails (§6.2).
>
> **v1.2 changelog** — frontend base chosen after a template-research pass. Adopt **Kibo UI
> `kanban`** (MIT, copy-in/vendored) on **React 18 + Vite + Tailwind + shadcn/ui** with
> **`@dnd-kit/core` 6.3.1 + `@dnd-kit/sortable` 10.0.0** for drag (NOT the experimental
> `@dnd-kit/react` 0.5.0). Replaces the prior vanilla-TS + SortableJS choice (which the review
> flagged). Backend (Hono + JSON + herdr) unchanged. See §11, §15, §16.
>
> **v1.3 changelog** — designed and built: a deterministic **attention feed** (pure
> transition detector → poller-owned attention map riding the `BoardState` SSE payload) and a
> **live session terminal** (`@xterm/xterm` ↔ WebSocket ↔ `node-pty` ↔ `herdr agent attach
> --takeover`), with the WS attach hardened against the loopback-≠-CSRF and untrusted-output-into-
> emulator surfaces.

---

## 1. Purpose & Problem

### Problem
The operator runs ~15 concurrent Claude/herdr sessions across 3–4 environments (e.g. work-local,
personal-local, work-remote, personal-remote). Without a dashboard the only view is ad-hoc scripting
(in the herdr skill) that prints a flat table. That table answers "what's running" but **not**:
1. *Which session is working on which piece of the operator's work?* — there is no task ↔ session
   mapping.
2. *What just changed that the operator needs to react to?* — a session finishing or blocking
   scrolls past unnoticed; there's no durable "needs attention" surface.
3. *Create/track work without leaving the terminal* — no place to capture tasks (human- or
   agent-created) and tie them to the sessions doing them.

### Solution
A localhost web app (later remote-deployable) that is a **deterministic state + view + control
substrate** over herdr: a Kanban board of **tasks** linked to **sessions** (herdr panes), with
live pane output, command input, and a deterministic **attention feed** of session transitions.
The UI, a thin CLI, and a *future* agent all consume the same API — the agent is never embedded.

### Why not just extend the ad-hoc script / an existing tool
The script is read-only and stateless (no task linkage, no attention persistence). Existing
AI-kanban tools (Vibe Kanban, Claude Squad, Crystal, Sculptor) are all built to *be* the
orchestrator (spawn agent + own git worktree + own PTY); herdr already owns that, and none has
an "attach to externally-owned session" seam — extending them means rewriting their core. Hence
a thin app over herdr's CLI.

---

## 2. Goals & Non-Goals

### v1 Goals
- Multiple **boards** (projects): Personal / Work / Client … with a switcher. One file per board.
- **Tasks** with title, description (markdown), status (column), order, **priority** (P0–P3
  badge + sort), **comments** (server-assigned `author`), and attached **sessions**.
- Full **herdr session layer**: Unassigned pool, attach/detach, spawn-from-task, live output,
  send command, bidirectional auto-link.
- **Tiered live polling** across 4 (config-driven, extensible) environments.
- **Deterministic attention feed** from session status transitions (no LLM), with a snapshot
  of the session's last output lines captured at transition time.
- **REST API + SSE** + a thin **`herdr-board` CLI** for Claude-side task creation.
- **Git-backed storage** in a dedicated local repo; debounced commits; per-file write mutex.
- **v1 security hardening**: loopback bind, command-arg safety, input sanitization, XSS-safe render.
- **Responsive / mobile-friendly** layout baked in (not actively tuned in v1).

### Non-Goals (v1) — model accommodates, not built
- The LLM **agent** (watches sessions, summarizes, prioritizes, writes action items). Deferred;
  plugs into the same API. A tiny **agent stub** (§17) ships only to exercise the seam.
- **Real authentication** (token / mTLS). Deferred to the remote-deploy phase; v1 is loopback-only.
- **Typed/configurable custom-field schemas** (a free `custom` map is stored, minimally surfaced).
- **Labels/tags**, **per-board column customization UI**, **MCP server**.

### 2.1 Build order (validate the core loop first)
1. **Read-only spine:** environments config + adapter + parser + poller + `/api/state`
   + SSE; UI shows sessions and live status across envs (replaces the ad-hoc scripting).
2. **Tasks & linkage:** boards/tasks storage + mutex + git; Kanban UI; Unassigned pool;
   attach/detach. Validates "see status → link to task."
3. **Attention & control:** transition detection + snapshot + attention feed + ack;
   `pane run` command input; spawn-from-task. Validates "ack what needs me."
4. **Ergonomics:** priority, comments, `herdr-board` CLI, agent stub.

---

## 3. Architecture

```
┌─ Browser (React 18 + Vite + Tailwind + shadcn/ui) ──────────────────┐
│  Board switcher · Kibo UI kanban (dnd-kit) · Task cards              │
│  Expandable sessions: <pre>+ansi_up live output · command input      │
│  Attention feed · EventSource(/api/stream) · POST /api/focus         │
└───────────────▲────────────────────────────────┬───────────────────┘
          SSE /api/stream                  REST: boards, tasks, comments,
                │                           attach/detach, spawn, run, focus
┌───────────────┴────────────────────────────────▼───────────────────┐
│  Hono server (TypeScript, Node) — binds 127.0.0.1 only in v1        │
│   • api.ts        REST + SSE  (input validation at the boundary)    │
│   • scheduler.ts  tiered poll loop, per-env overlap guard           │
│   • transition.ts status-diff → attention records (+ output snap)   │
│   • poller.ts     orchestrates scheduler+transition, holds snapshot │
│   • storage.ts    boards/*.json + attention.json (atomic + mutex)   │
│   • git.ts        debounced local commit (no remote, no push)       │
│   • herdr.ts      ADAPTER (execFile arg-arrays; per-env routing)    │
│   • parser.ts     ctx% / model / session-name regex (pure, tested)  │
└───────────────────────────┬─────────────────────────────────────────┘
                            │ child_process.execFile (arg arrays, timeouts)
        ┌───────────────────┼─────────────────────┬──────────────────┐
   work-local          personal-local      work-remote           personal-remote
  (direct sock)  (HERDR_SOCKET_PATH)  (ssh work-box + env)    (ssh personal-box + env)
```

### Module responsibilities (each ≤ ~400 lines; agent-friendly slices)
- **`herdr.ts`** — environment descriptors → herdr command execution. `listSessions()`,
  `readPane(paneId)`, `getPane(paneId)`, `run(paneId, text)`, `spawn(opts)`. No task/board knowledge.
- **`parser.ts`** — pure: pane-read blob → `{ ctxPct, model, sessionName }`. Unit-tested vs fixtures.
- **`storage.ts`** — read/write board files + `attention.json`; atomic writes; per-file mutex; no git.
- **`git.ts`** — debounced local autocommit. Decoupled from `storage.ts`.
- **`scheduler.ts`** — tiered intervals, per-env dispatch, overlap guard.
- **`transition.ts`** — status diff vs previous snapshot → attention-record updates (+ output snapshot).
- **`poller.ts`** — thin orchestrator: drives scheduler, applies transition results, pushes SSE.
- **`api.ts`** — Hono routes; the seam for UI / CLI / future agent.

---

## 4. Environments (operator config file, loaded at startup)

Environments are defined in a **trusted operator config file** (JSON), loaded **once at startup**
and **Zod-validated** by `environments.ts` into the `HerdrEnv` discriminated union. Path is
`$CORRAL_CONFIG` (default `$CORRAL_HOME/environments.json`, where `$CORRAL_HOME` defaults to
`~/.corral`). A template `environments.example.json` ships in the repo; the real file is
git-ignored. Adding a box = one entry in that file — so the project is **shareable**: another person
writes their own config without touching source.

**Security boundary (unchanged).** The config file is **trusted local operator input** — same trust
level as the source code (whoever runs the server owns the file). It is read **only at startup** and
is **never mutable through the web API/UI**: runtime environment addition remains out of scope,
because an attacker-set `sshHost` would turn the server into an SSH relay. Moving the *source* of
environments into a file does **not** move the trust boundary to the network — that is the invariant.

```jsonc
// environments.example.json → copy to $CORRAL_HOME/environments.json and edit
{
  "environments": [
    { "id": "local", "label": "Local", "kind": "local", "repos": { "corral": "~/code/corral" } },
    { "id": "work", "label": "Work", "kind": "local", "socket": "~/.config/herdr/sessions/work/herdr.sock", "spawnCommand": "claude-work", "claudeConfigDirs": ["~/.claude-work"], "repos": { "my-app": "~/code/my-app" } },
    { "id": "personal", "label": "Personal", "kind": "local", "socket": "~/.config/herdr/sessions/personal/herdr.sock", "spawnCommand": "claude-personal", "claudeConfigDirs": ["~/.claude-personal"] },
    { "id": "local-alt", "label": "Local (other socket)", "kind": "local", "socket": "~/.config/herdr/sessions/alt/herdr.sock" },
    { "id": "remote", "label": "Remote", "kind": "remote", "sshHost": "my-ssh-host", "socket": "~/.config/herdr/sessions/remote/herdr.sock", "herdrBin": "~/.local/bin/herdr", "repos": { "svc": "/home/me/svc" } }
  ]
}
```

Three more per-environment fields appear above:
- `spawnCommand` — what corral runs to start a new agent session in that environment (default `claude`).
- `claudeConfigDirs` — which Claude config dirs corral scans for that environment's recap/metrics, so
  separate Claude accounts surface independently. A `local` entry defaults to `~/.claude`; a `remote`
  entry has no default (omit it and nothing is scanned) and its paths must be absolute, since `~` is
  not expanded on the remote shell.
- `repos` — a name → path map that spawn uses to pick the working directory; local paths get
  `~` expanded, remote paths must be absolute (a leading `~` is rejected — it isn't expanded on
  the remote shell).

**Command execution — argument arrays only, never shell-string interpolation:**
- `local` (no socket): `execFile("herdr", [...args])`
- `local` (socket): `execFile("herdr", [...args], { env: { ...process.env, HERDR_SOCKET_PATH: socket } })`
- `remote`: `execFile("ssh", ["-o","ConnectTimeout=8", sshHost, remoteCmd], …)` where `remoteCmd`
  is built by **shell-quoting** each token (`shell-quote`/`shescape`), so a paneId or command text
  containing quotes/`;`/`$()`/newlines cannot break out. The `HERDR_SOCKET_PATH=… herdrBin args`
  inner string is assembled from quoted tokens, not raw interpolation.
- SSH-noise filter regex applied to remote stdout: `^(bind|channel_setup|Could not|Warning: remote port).*`.

There is no `--socket`/`--session` flag — `HERDR_SOCKET_PATH` is the only routing mechanism.

**Boundary validation:** `:env` is validated against `ENVIRONMENTS` ids; `:paneId` against a strict
regex (e.g. `^[A-Za-z0-9:_\-]+$`) at the route handler before reaching the adapter.

---

## 5. herdr Adapter

### Command surface used
- `herdr workspace list` / `tab list` / `agent list` — JSON (`result.{workspaces,tabs,agents}`),
  joined into session rows. (Do **not** conflate with `session list`, which has a different,
  unwrapped JSON shape — not used here.)
- `herdr pane read <paneId> --source recent --lines <N>` → **raw terminal text, NOT JSON**.
  `parser.ts` operates on this text; never `JSON.parse` it.
- `herdr pane get <paneId>` → JSON incl. `cwd` (stable, pane launch dir) and `foreground_cwd`
  (volatile). Used at attach/spawn time to populate `cwdSnapshot` — record **`cwd`**, not `foreground_cwd`.
- `herdr pane run <paneId> "<text>"` → sends command **with Enter**. **`pane run` only** — never
  `agent send` (no Enter; leaves text staged, and a later `pane run` then submits staged+new
  concatenated → garbled). The adapter exposes only `run`.
- `herdr agent start <name> --workspace <id> -- claude` → spawn.
- `herdr tab create --workspace <id> --cwd <path> --label <text>` → new tab in a repo's workspace.

### Execution safety & timeouts
- All calls via `execFile` with argument arrays (see §4). `text` (from API) and `paneId` (from URL)
  are untrusted at the process boundary.
- Each call gets an explicit **total-command timeout** (`{ timeout }`), independent of SSH
  `ConnectTimeout=8`: e.g. ~15s for list/cheap calls, ~30s for `pane read`. A connected-but-hung
  remote must not block forever.
- Calls run async (off the event loop). Per-environment last-good snapshot cached; on error the
  env is marked unreachable (§13) and the stale snapshot retained.

### `/rename` dependency note
The spawn auto-name step (§9) uses `pane run <paneId> "/rename <slug>"`, which types into the pane;
it only works if **Claude Code is running in that pane** (it processes `/rename`). If the pane is a
plain shell, the slash command is just shell input — document this; spawn always launches `claude`,
so the precondition holds for spawned sessions.

### Parser (`parser.ts`, from the herdr skill)
- **Status bar:** `ctx ░░ 19% (190K) … | Sonnet 1M` → `ctxPct`, `model` (Opus / Sonnet 1M /
  Sonnet / Haiku).
- **Session-name bar:** long line (>60 chars, >60% `─`) ending `── name ──` → `sessionName`.

---

## 6. Data Model & Storage

### 6.1 Layout (dedicated local git repo)
- Data lives in a **new, dedicated git repo** (NOT the dev source repo), path from env
  `BOARD_DATA_DIR` (default `$CORRAL_HOME` = `~/.corral`). `$CORRAL_HOME` is the **operator
  runtime+data home**: it holds `environments.json` (read-only, loaded once at startup) and
  the board/attention data below (read-write).
- ```
  $BOARD_DATA_DIR/
    boards/personal.json · work.json · client.json
    attention.json
  ```

### 6.2 Git: versioning, not locking, and local-only
- Persistence is plain JSON via **atomic temp-file + rename**. Git adds *versioning* (history,
  undo, hand-editable) on top — it is **not** the correctness mechanism (the mutex in §6.3 is).
- **Commits are debounced: a commit check runs at most once every 10 seconds**, committing only if
  files changed. Live status/poll data is never written, so it never triggers commits.
- **Guardrails (Security):** the data repo MUST have **no `git remote` and is never auto-pushed** —
  task descriptions/comments/`custom` may contain secrets a Claude agent wrote; local commits only.
  First run does `git init` if empty and sets a local `user.name`/`user.email` for the repo.
- A write landing during a debounce `git add`/`commit` may fall in the current or next commit —
  harmless given atomic renames; noted for debuggability.

### 6.3 Concurrency model (per-file async mutex)
UI + CLI + poller can mutate the same file. Node's single thread does **not** serialize the
read-modify-write cycle (multiple async suspension points → lost update). Therefore every
read-modify-write of a board file or `attention.json` is wrapped in a **per-file async mutex**
(`async-mutex`, keyed by file path). `attention.json` writes (poller transitions + `/ack`) go
through the same mutex. This makes the "server serializes mutations" guarantee real.

### 6.4 Board file (`boards/<id>.json`)
```jsonc
{
  "id": "work", "label": "Work", "defaultEnv": "work-local",
  "columns": [ {"id":"todo","label":"Todo"}, {"id":"doing","label":"Doing"},
               {"id":"blocked","label":"Blocked"}, {"id":"done","label":"Done"} ],  // shared default set
  "tasks": [{
    "id":"t_k3f9",                              // nanoid (8 char); collision negligible < 10K tasks
    "title":"Fix board sync",
    "description":"…markdown…",
    "status":"doing", "order":0,
    "priority":"p1",                            // p0|p1|p2|p3|null — badge + sort
    "custom":{},
    "comments":[ {"id":"c1","author":"alice","ts":1718700000,"body":"…",
                  "idemKey":null} ],            // author SERVER-ASSIGNED (§7); idemKey dedupes agent writes
    "sessions":[ {"env":"work-local","paneId":"w653..-1","name":"task-42-a","cwdSnapshot":"…/demo-api"} ],
    "repo":"demo-api", "defaultEnv":"work-local",
    "createdAt":1718700000, "updatedAt":1718700500
  }]
}
```
- **Session link key = `(env, paneId)`.** `name` + `cwdSnapshot` (= `cwd` from `pane get`) stored for
  display + soft re-link after pane_id churn (§9).
- Live data (status / ctxPct / model / output) is **never persisted** — rebuilt each poll, merged at read.

### 6.5 `attention.json` (bounded; one record per session; carries an output snapshot)
```jsonc
{
  "work-local:w653..-1": {
    "state":"blocked", "since":1718700800, "acked":false,
    "lastLines":"…last N lines of pane output captured at transition…",  // self-sufficient for agent + UI
    "agentCommentId":null                                                 // set when the future agent comments
  }
}
```
- On a transition (→ `blocked` / `finished`) the poller **overwrites** that session's entry (new
  `since`, `acked:false`) and snapshots the session's last N output lines into `lastLines` — so a
  finished session's final output survives even though the rolling buffer may scroll away before the
  next poll (esp. remote 30s tier). On ack → `acked:true`. Entry pruned when the session disappears;
  a prune pass also runs on server startup against the live list (so entries don't orphan while the
  poller was offline).
- Bounded by *number of live sessions*, never by time. Full transition history → git.

### 6.6 `agent_status` enum (drives transitions)
Valid values (from herdr): `working`, `idle`, `done`, `blocked`, `unknown`. Attention transitions
fire on `working → blocked` and `working → done|idle` ("finished"). `unknown` is treated as "no change."

---

## 7. API Surface (Hono)

| Method | Route | Purpose / notes |
|---|---|---|
| `GET` | `/api/state?board=<id>` | board + tasks enriched w/ live session **metadata** (status, ctxPct, model) + Unassigned pool + env reachability + attention feed. **Pane buffers NOT included here.** |
| `GET` | `/api/stream?board=<id>` | **SSE** — pushes the enriched **metadata** snapshot each tick (JSON-encoded). Client auto-reconnects; server is stateless across reconnects (full snapshot each push). |
| `GET` | `/api/sessions/:env/:paneId/read?lines=N` | fetch a pane's text buffer on demand (card expand). Buffer is **not** in the SSE firehose. |
| `POST` | `/api/focus` | `{env,paneId}|null` — frontend tells server which card is expanded → boosts that pane to the fast poll tier. In-memory, not persisted. |
| `GET`/`POST`/`PATCH`/`DELETE` | `/api/boards[/:bid]` | board CRUD. Delete detaches sessions back to pool (does not kill herdr sessions). |
| `POST`/`PATCH`/`DELETE` | `/api/boards/:bid/tasks[/:tid]` | task create / edit+move (status, order, priority) / delete. |
| `POST` | `/api/boards/:bid/tasks/:tid/comments` | add comment. **`author` is server-assigned** (request body `author` rejected); optional `idemKey` dedupes (e.g. agent re-trigger on same `since`). |
| `POST` | `/api/boards/:bid/tasks/:tid/attach` · `/detach` | move pooled session `{env,paneId}` onto / off a task. |
| `POST` | `/api/boards/:bid/tasks/:tid/spawn` | spawn (§9). **Idempotent:** pre-checks `agent list` for the intended name; attaches if already present instead of double-spawning. |
| `POST` | `/api/boards/:bid/tasks/from-session` | create task from a pooled session. **Claim-checked:** verifies `(env,paneId)` is still unassigned at write time, else `409 Conflict`. |
| `POST` | `/api/sessions/:env/:paneId/run` | `herdr pane run` (text + Enter). Validates env/paneId; logs to audit file (§13). |
| `POST` | `/api/attention/:env/:paneId/ack` | mark attention item acked. |

**Error envelope:** all errors return `{ error: { code, message } }` with machine-readable `code`
(`env_offline` · `herdr_error` · `already_attached` · `conflict` · `validation`) so CLI/agent can branch.

---

## 8. Polling Strategy (tiered, overlap-guarded)

- **Cheap tier (~3s):** per env, `workspace list` + `tab list` + `agent list` → session list +
  `agent_status` (drives badges, transitions, attention).
- **Expensive tier (configurable; default ~30s remote, faster local):** `pane read` for the
  **focused** session (from `/api/focus`) at ~2s; others only as needed. **At most one focused
  pane** gets the fast tier (cap N=1) to bound SSH load.
- **Overlap guard:** a per-environment `isPolling` flag; if the previous tick for an env is still
  in flight (slow SSH), skip the next tick and log a warning. Prevents concurrent SSH storms and
  out-of-order snapshots.
- Transition detection (`transition.ts`): compare each session's `agent_status` to the previous
  snapshot; on a qualifying transition update `attention.json` and snapshot `lastLines`.
- SSE pushes the latest merged **metadata** snapshot (no pane buffers).

---

## 9. Session Lifecycle

### Unassigned pool
Any live session (all envs) not referenced by any task's `sessions[]` → **Unassigned pool** drawer.
Manually-created herdr sessions land here.

### Attach / detach
Drag a pooled session onto a task (or API) → stored by `(env,paneId)`. Detach → back to pool.

### Bidirectional auto-link
- **Create task from session** (`from-session`, claim-checked) → new task with that session attached.
- **Spawn session from task** (idempotent) → new herdr session auto-attached.

### Spawn (rules-based)
1. **Local vs remote:** prompt, defaulting to **local**.
2. **Idempotency pre-check:** look in `agent list` for a session named `<task-slug>-<a|b|c>`; if
   present, attach it and stop (handles retry after a timed-out spawn).
3. **Workspace by repo:** if the task's `repo` matches an existing workspace (by label/cwd),
   `herdr tab create` a new tab there; else create the workspace.
4. **Spawn:** `herdr agent start <name> --workspace <id> -- claude`.
5. **Auto-name:** `herdr pane run <paneId> "/rename <slug>-<a|b|c>"`. **`slug` is sanitized** (§13):
   `title.toLowerCase().replace(/[^a-z0-9]/g,'-').slice(0,32)`, must match `^[a-z0-9][a-z0-9\-]{0,31}$`.
6. **Auto-attach** `(env,paneId)` + capture `cwdSnapshot` via `pane get`.

### Send command
`POST /api/sessions/:env/:paneId/run` → `herdr pane run` (Enter included). `pane run` only.

### pane_id churn (named operational hazard)
A herdr **restart changes all pane_ids in that env at once** → every task on that env flips to
**detached** simultaneously. v1 mitigations: (a) cards show detached sessions (not vanished) with
their stored `name`; (b) a **bulk "re-link by name"** action matches detached `name`s against
current pool sessions in that env and re-attaches. Stable pane identifiers don't exist in herdr —
this limitation is explicit, not hidden.

---

## 10. Attention Layer (deterministic; agent-ready seam)

- Built purely from `agent_status` transitions in the cheap tier — **no LLM**.
- Each transition snapshots the session's last output lines into the attention record (§6.5), so
  the feed (and a future agent) can show/summarize *what happened* without relying on the volatile
  rolling buffer (`pane_history` defaults false in herdr — see §13).
- Surfaced as an **Attention feed** of ackable items ("`task-42-a` went blocked" / "just finished").
  Acked items don't re-surface until a *new* transition (different `since`).
- **Future-agent seam:** the agent reads attention records (incl. `lastLines`) + board state via the
  API, summarizes/prioritizes, and writes comments (with `idemKey` = `env:paneId:since` to avoid
  double-writes; its `agentCommentId` is recorded on the record). The feed UI is unchanged; the
  deterministic version is the fallback when the agent is off.
- **Eval signal (cheap, built now):** record time-to-ack on attention records. An item acked in
  <~30s with no resulting task/comment is a proxy for "not actionable" — a lightweight quality
  signal for the future agent without UX changes.

---

## 11. Frontend

- **Stack:** **React 18 + Vite + TypeScript + Tailwind + shadcn/ui.** Board UI = **Kibo UI
  `kanban`** component, installed **copy-in** (`npx kibo-ui add kanban`) and **vendored** into
  `web/components/kanban/` — we own/edit the source, no runtime npm lock. (Runner-up base if
  preferred: clone Georgegriff/react-dnd-kit-tailwind-shadcn-ui wholesale — same stack.)
- **Drag engine:** **`@dnd-kit/core` 6.3.1 + `@dnd-kit/sortable` 10.0.0** (the stable production
  line — **NOT** the experimental `@dnd-kit/react` 0.5.0). Configure `PointerSensor`/`TouchSensor`
  with an activation delay/distance so card-drag doesn't fight vertical scroll on mobile (Kibo
  does not set this).
- **Layout:** board switcher · Kibo kanban columns from the board's `columns` · task cards (title,
  priority badge, session-status dots, comment count) · Unassigned pool drawer · Attention feed panel.
- **Drag persistence:** on dnd-kit `onDragEnd`, optimistically update local state and
  `PATCH …/tasks/:tid` (new status + order); the SSE snapshot is the source of truth that reconciles.
- **Card expand:** description, comments, and each attached **session** with a `<pre>` live-output
  buffer + command input. Buffer fetched via `GET /api/sessions/:env/:paneId/read` on expand (not
  the SSE firehose) and on the focused fast tier; `POST /api/focus` on expand/collapse.
- **Render safety (Security):**
  - Pane output: **ansi_up with `escape_html: true`** (explicit; pinned version). Pane output is untrusted.
  - Task title / description / comment bodies: rendered via **DOMPurify + marked** (markdown) or
    `textContent` (plain), never raw `innerHTML`. Documented per field.
- **Live updates:** a `useEventSource` hook subscribes once to `/api/stream?board=…` (auto-reconnect);
  the metadata snapshot drives a board-state store (e.g. Zustand or React context) → React re-renders
  (keyed by task id). Optimistic local edits are overwritten by the next server snapshot.
- **Mobile:** responsive columns (horizontal scroll / stack on narrow) via Tailwind. Baked in; not tuned in v1.

---

## 12. `herdr-board` CLI

Thin wrapper over the REST API so any Claude session can create/update tasks:
```
herdr-board add --board work "Fix board sync" --priority p1 --desc "…"
herdr-board comment <taskId> "Finished migration; needs review"   # author server-assigned
herdr-board move <taskId> --status done
```
Talks to `127.0.0.1:<port>`. **The `author` field cannot be set by the caller** — the server stamps
it. (An MCP server is the eventual clean path; CLI suffices for v1.)

---

## 13. Security (v1 hardening) & Edge Cases

### v1 security (loopback-only; real auth deferred)
- **Bind `127.0.0.1` only** (never Hono's default `0.0.0.0`). Startup aborts/warns if the configured
  host is non-loopback. Comment in code: "remove only after auth exists."
- **Command-arg safety:** every herdr/SSH call uses `execFile` + argument arrays / shell-quoted
  tokens (§4, §5). No `exec` with string interpolation anywhere. `paneId`/`env` validated against
  allowlists/regex at the route boundary; `text` treated as untrusted.
- **Slug sanitization** before `pane run "/rename …"` (§9 step 5).
- **XSS-safe render** (§11): ansi_up `escape_html:true`; DOMPurify/marked or `textContent` for user fields.
- **Server-assigned `author`** on comments (§7) — a Claude agent cannot forge `"author":"alice"`.
- **Audit log:** append every `run` call to a local file `{ts, env, paneId, text}` for forensics.
- **Git guardrails** (§6.2): no remote, no auto-push.
- *Deferred to remote-deploy phase:* bearer token / mTLS auth, CORS policy, rate limiting on `run`.

### Other edge cases
- **Env unreachable** (VPN off, remote host down, missing socket): mark env offline in `/api/state`,
  gray out its sessions, keep last-good snapshot; never crash the poll loop. (Remote environments may
  sit behind a VPN.)
- **SSE newline framing:** JSON-encode every payload.
- **herdr `pane_history` defaults false** / scrollback not persisted across restarts: v1 shows the
  rolling snapshot for live view, but the **attention record's `lastLines` snapshot (§6.5) captures
  finished/blocked output at transition time** so it survives. README recommends `pane_history = true`
  in `~/.config/herdr/config.toml` for deeper live scrollback.
- **Port already in use:** uncaught `EADDRINUSE` from Node's `http` server — no custom handling.
- **Concurrent writes:** per-file mutex (§6.3); git is after-the-fact, not a lock.

---

## 14. Testing Strategy

- **`parser.ts`** — unit tests vs captured `pane read` fixtures (status-bar variants, session-bar
  present/absent, missing fields). The fragile piece.
- **`herdr.ts`** — mocked `child_process`: assert `execFile` arg arrays per env kind, SSH quoting of
  hostile tokens (quotes/`;`/`$()`/newlines), env routing, SSH-noise filtering, timeout wiring.
- **`transition.ts`** — fake snapshots: status sequences → expected `attention.json` updates incl.
  overwrite, `lastLines` capture, prune, and startup prune.
- **`storage.ts`** — round-trip + atomic-write + **mutex** tests (concurrent read-modify-write must
  not lose updates). **`git.ts`** — debounce behavior.
- **`api.ts`** — input validation (bad env/paneId rejected), spawn idempotency pre-check,
  `from-session` 409 claim race, server-assigned author, comment idemKey dedupe.
- Frontend: manual verification in v1.

---

## 15. Project Structure

```
corral/  (repo root)
  package.json  tsconfig.json  vite.config.ts
  CLAUDE.md               # critical herdr rules for coding agents (pane-run-only, HERDR_SOCKET_PATH
                          #   routing, no --socket flag, SSH noise filter, execFile arg-arrays)
  environments.ts         # loads + Zod-validates the operator env config file at startup
  environments.example.json  # template; copy to $CORRAL_HOME/environments.json (real file git-ignored)
  config.ts               # poll intervals, port, host=127.0.0.1, CORRAL_HOME, env config path, BOARD_DATA_DIR
  server/
    index.ts  api.ts  herdr.ts  parser.ts
    scheduler.ts  transition.ts  poller.ts   # poller split per review
    storage.ts  git.ts  audit.ts
  web/                    # React + Vite app
    index.html  main.tsx  App.tsx  index.css   # Tailwind entry
    components/
      kanban/             # VENDORED Kibo UI kanban (copy-in via `npx kibo-ui add kanban`)
      Board.tsx  TaskCard.tsx  SessionPane.tsx  AttentionFeed.tsx  UnassignedPool.tsx
    hooks/
      useEventSource.ts   # SSE subscription → board-state store
    lib/
      api.ts  terminal.tsx  # REST client; ansi_up <pre> render (escape_html:true)
  cli/
    herdr-board.ts
  agent-stub/
    stub.ts               # ~50-line seam exerciser (§17)
  test/
    parser.test.ts  herdr.test.ts  transition.test.ts  storage.test.ts  api.test.ts
  README.md
```

---

## 16. Build & Run

- `npm install` → `npm run build` (Vite builds `web/`) → `npm start` (Hono serves API + assets on
  `127.0.0.1:<port>`). The dev source repo (`~/code/corral`) is where you build/run;
  `$CORRAL_HOME` (`~/.corral`) is the operator runtime+data home (config + board/attention data).
- **First run:** copy `environments.example.json` → `$CORRAL_HOME/environments.json` and edit it
  (the server reads this at startup and fails fast with a clear message if it is missing).
- `BOARD_DATA_DIR` (default `$CORRAL_HOME`) points at the dedicated data repo; first run `git init`s
  it if empty and sets a local git identity. **No remote is configured; nothing is pushed.**
- Dev: `npm run dev` (Vite dev server + server watch).

---

## 17. Future / Deferred (seams already in place)

- **LLM agent** — API client; reads attention records (`lastLines`) + board state, summarizes,
  prioritizes, writes comments (idemKey-deduped). Feed UI unchanged.
- **Agent stub (ships in v1):** `agent-stub/stub.ts`, ~50 lines — polls `attention.json`, reads one
  finished session's `lastLines`, posts a comment as `author:"agent-stub"`. Purpose: exercise the
  full API/attention seam with a *real consumer* so interface gaps surface before they're baked in.
  Not the real agent; no LLM.
- **Real auth + remote deploy** (token/mTLS, CORS, rate limiting) — the gate for non-loopback bind.
- **Typed custom-field schemas**, **labels/tags**, **per-board column editing UI**, **MCP server**.
- **Agent eval** — use the time-to-ack signal (§10) + outcome labels to measure prioritization quality.
