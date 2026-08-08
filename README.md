# corral

A localhost dashboard and control surface for [herdr](https://github.com/ogulcancelik/herdr)
terminal sessions. herdr manages a *herd* of AI agent sessions; **corral** is where you pen
and control them — a Kanban board over your sessions with live pane output, an attention
feed, and a real in-browser terminal.

Running many concurrent agent sessions has a specific shape: almost all of the time nothing
needs you, and then two things do — a session **blocks** waiting on your input, or a long
delegated task **finishes**. corral surfaces exactly those transitions across every machine
you work on, and lets you respond in place.

## What you get

- **Kanban board over live sessions** — group sessions into boards and task cards; every
  card shows real-time status (working / blocked / idle), the session's recap, and Claude
  metrics (model, context %, cost, account rate-limit windows).
- **Attention feed** — a deterministic transition detector (no LLM, no polling races) that
  tells you which session blocked or finished, with a tail of its output.
- **Live terminal** — click a card, get a fully bidirectional xterm.js terminal attached to
  the real session over WebSocket; close the modal and control returns to your own terminal.
- **Spawn** — launch new agent sessions into a chosen environment and repo from the UI.
- **Multi-environment** — local sockets and remote boxes over SSH, in one view.
- **Multi-account Claude** — work and personal Claude accounts side by side, each with its
  own rate-limit windows (see below).

## Quick start

Prerequisites: Node ≥ 20.11, [herdr ≥ 0.7.1](https://github.com/ogulcancelik/herdr) on this
machine (and on any remote box you add), Claude Code on every machine you spawn sessions on,
and `jq` — **required** if you want the live Claude metrics (model / context % / cost /
rate-limit windows). The metrics *capture* is optional; `jq` is not optional *for* it. Both
helper scripts hard-depend on `jq` and are deliberately best-effort, so without it they write
nothing and log nothing: the cards just show no metrics, which is indistinguishable from "no
data yet". corral appends `--name` (and, when chosen, `--model` / `--remote-control`) to every
non-resume launch; this has only been verified against Claude Code 2.1.226 — an older CLI
lacking one of these flags will fail the launch visibly in the pane.

```bash
# 0. prerequisite check — without jq the metrics capture silently does nothing
command -v jq >/dev/null || echo "install jq first — the live metrics need it"

# 1. herdr's Claude integration (per machine) — enables session recaps
herdr integration install claude

# 2. configure your environments
mkdir -p ~/.corral
cp environments.example.json ~/.corral/environments.json
$EDITOR ~/.corral/environments.json

# 3. run — from a terminal OUTSIDE Claude Code (see "Launching corral" below)
npm install          # node-pty is native — compiles against your Node ABI
npm run dev          # Vite (http://127.0.0.1:5173) + API (http://127.0.0.1:8787), proxied
# production:
npm run build && npm start   # serves API + built UI on http://127.0.0.1:8787

# 4. per-config-dir helper files — needed for the live metrics (and the optional theme).
#    Skip this and roughly half of each card's information is simply not wired up.
D=~/.claude          # repeat for every ~/.claude* dir you want surfaced, on every machine
cp scripts/corral-status-capture.sh "$D/corral-status-capture.sh"
cp scripts/statusline-command.sh    "$D/statusline-command.sh"   # skip if you have your own
chmod +x "$D/corral-status-capture.sh" "$D/statusline-command.sh"
#    ...then register the statusline in "$D/settings.json" — see the full section below for
#    that snippet, the optional theme, remote boxes and multiple config dirs.
```

That gets you the board, attention feed, live terminal and recap — plus the live Claude metrics,
which are what step 4 buys. Step 4 is summarised above and documented in full under
[Claude statusline](#claude-statusline-live-metrics) and
[Installing the Claude helper files](#installing-the-claude-helper-files-per-config-dir) below.

The server binds `127.0.0.1` only and refuses other hosts. There is no auth — corral trusts
whoever can reach the loopback interface. On a single-user machine that's just you; on a shared
or multi-user box, any other local user or process that can reach `127.0.0.1` has the same
access, including the session-attach endpoint.

**Putting a reverse proxy in front of corral removes that protection, and the proxy must
therefore do the authenticating itself.** The loopback bind is the whole access control, so
anything the proxy can reach, its callers can reach: spawning sessions, closing and resuming
them, killing a pane, reading pane contents, writing theme files. Do not expect corral's
non-loopback `Host` rejection to catch this — a default `proxy_pass` sends the loopback upstream
as the `Host`, so the check passes. Note also that the live terminal will **not** work through a
proxy: its WebSocket Origin allowlist is loopback-only by design.

## Launching corral

**Launch from a normal terminal, never from inside a Claude Code session.** corral refuses to start
there, and prints why:

```
corral preflight
  ✗ launched from inside a Claude Code session
```

Two things go wrong when it does. corral passes its whole environment to every child process, so every
`herdr` call and every live-terminal attach carries that Claude session's variables. And any `local`
environment without an explicit `socket` inherits `HERDR_SOCKET_PATH` from the pane — so corral talks
to *that* pane's herdr and shows you a real, healthy fleet belonging to the wrong machine. Nothing on
the board looks wrong, which is what makes it worth refusing.

To override for a single launch:

```bash
CORRAL_ALLOW_UNDER_CLAUDE=1 npm run dev
```

Prefer that to exporting it in your shell profile: exported, the guard is off everywhere and you stop
noticing. While the override is active every start prints a reminder that it is disabled.

**What the check cannot see:** an herdr *server* that was itself started from a Claude session. That
process's environment is not readable on macOS. If sessions behave oddly and corral is clean, relaunch
your herdr session servers from a terminal outside Claude Code too.

**A missing or invalid `environments.json` now stops the launch too**, with the validation error
rendered inside the preflight report instead of a stack trace — `npm run dev` aborts before Vite
starts rather than serving a page over a dead API.

**After a reboot**, in order: start the herdr session servers → `npm run dev` → open the UI. corral
renders the board from persisted state, so it comes up looking healthy whether or not herdr is
running; the cards simply stop changing.

**Create sessions from the corral UI**, not by typing `claude` into a pane yourself — the UI uses the
environment's `spawnCommand` (e.g. a profile-specific `claude-work`).

## Upgrading

```bash
# If package-lock.json is the only dirty file and the diff is `libc` / `hasInstallScript` churn,
# that is your npm version rewriting it — discard it, `npm install` regenerates it below.
git checkout -- package-lock.json

git pull --ff-only
npm install      # node-pty is native — it may need a rebuild across Node versions
npm run build    # production only
npm run check    # optional and fast: typecheck + lint + tests
```

Then restart — and signal the process that **actually holds the port**, not the `npm` wrapper.
`npm start` is `sh -c` → `tsx` → `node`, and killing the top of that chain leaves the `node`
grandchild listening, so the next start fails with `EADDRINUSE` for no visible reason:

```bash
# Linux
kill "$(ss -ltnp 2>/dev/null | awk -F'pid=' '/127.0.0.1:8787/{split($2,a,","); print a[1]}')"
# macOS
kill "$(lsof -nP -iTCP:8787 -sTCP:LISTEN -t)"
```

Install the theme only **after** upgrading to ≥ v0.3.2 — the theme-sync-on-mount fix landed
there, so installing it against an older build means testing the old behaviour.

## Environments

Environments live in a JSON config file, **not** in source — everyone runs their own boxes.
Default path `~/.corral/environments.json` (override with `$CORRAL_CONFIG`; the data
home `~/.corral` is `$CORRAL_HOME`). Loaded and Zod-validated once at startup; the
server fails fast with a clear message if missing. **Environments are never editable via the
API** — a runtime-set `sshHost` would turn the server into an SSH relay.

Each entry describes one place corral can see and spawn sessions into:

- `id` / `label` — `id` is the stable, URL-safe key corral routes on (letters, digits, `.`,
  `_`, `-`); `label` is the human name shown in the UI. Both required.
- `kind: "local"` — talks to a herdr socket on this machine. With no `socket` it inherits
  the ambient `HERDR_SOCKET_PATH` (launch corral from the right herdr context or set it).
- `kind: "remote"` — talks to a box over SSH (`sshHost`, `socket`, `herdrBin` required).
  An unreachable environment keeps its last-good snapshot and is **not** flagged anywhere in the
  UI yet — its cards simply stop changing. The server records the reason, so the server log is
  where you find out; corral also names a missing `herdr`/`ssh` at startup.
- `spawnCommand` — what corral runs to start a new agent session in this environment.
  Defaults to `claude`. Two hard constraints: it must be a **single token** — no spaces and no
  arguments, which the config schema rejects outright, so wrap any flags in a script; and it must
  be an **executable file on `PATH`**, never a shell function or alias, because sessions are
  spawned into a non-interactive shell that never reads your `.bashrc`/`.zshrc`.
  corral now appends `--name <session-name>` — plus `--model <model>` and `--remote-control
  <session-name>` when those are chosen — to every launch except `--resume`, so the command **must
  forward its arguments**. The `exec … claude "$@"` wrapper shown under *Multiple Claude accounts* below
  already does. One that hard-codes its arguments drops the flags: the session starts, but with Claude's
  auto-generated name, the last-used model and no Remote Control.
- `claudeConfigDirs` — which `~/.claude*` dirs corral scans on this box for recap and the
  statusline metrics (local defaults to `~/.claude`; set it for profile-split or remote — see
  the statusline section).
- `repos` — the repositories you can spawn sessions into on this environment (details below).

### Repositories & spawning sessions

`repos` maps a short **name → directory**, and the UI's **Spawn** button offers those names.
It's **per environment** — list a repo under the env you want to launch it in, pointing the name
at the directory the session should start in:

```json
{
  "id": "local", "label": "Local", "kind": "local",
  "repos": { "corral": "~/code/corral", "api": "~/code/my-api" }
}
```

When you spawn, corral opens a fresh herdr workspace/tab **in that directory** and runs the
environment's `spawnCommand` there — so each path must be a real directory on that
environment's machine. Path rules follow the shell that `cd`s into them: **local** paths may
use `~` (`~/code/corral`); **remote** paths must be **absolute** (`/home/me/svc`) — `~` is not
expanded on the remote shell. A repo you didn't list can't be spawned into by name (corral
errors *"no path configured for repo … — add it to environments.json `repos`"*); you can still
spawn into an already-open herdr workspace instead. See `environments.example.json` for
complete local and remote entries.

## Multiple Claude accounts

If you keep separate Claude accounts (say, work and personal), give each one its own config dir
and a tiny wrapper **script**. It has to be a real executable on `PATH`: corral spawns sessions
non-interactively, so the same wrappers written as shell functions in `.zshrc` work in your own
terminal but are invisible to `spawnCommand` — the most common way this trips people up.

```bash
# ~/bin/claude-work — and ~/bin/claude-personal alongside it, with ~/bin on PATH
#!/bin/sh
exec env CLAUDE_CONFIG_DIR="$HOME/.claude-work" claude "$@"
```

```bash
chmod +x ~/bin/claude-work ~/bin/claude-personal
```

Each account also needs its own herdr socket. A `local` environment with no `socket` inherits
whatever `HERDR_SOCKET_PATH` corral itself was launched under — so if two environments both omit
`socket` they route to the same herdr instance and show the same sessions twice. Run each
account in its own named herdr session (`herdr --session work`, `herdr --session personal` —
each gets its own socket at `~/.config/herdr/sessions/<name>/herdr.sock`) and point that
environment's `socket` at it. Only one `local` environment should omit `socket` — the
zero-config one that inherits whichever session you launched corral from.

Then wire each account to an environment in `environments.json`: `spawnCommand` says which
wrapper launches sessions there, and `claudeConfigDirs` tells corral which config dirs to
scan. Recap, model, context %, cost, and the account-wide 5h/7d rate-limit windows are
surfaced **per account** — you can see one account approaching its window while the other is
fresh. The `work` / `personal` entries in `environments.example.json` show the full pattern.

## Claude statusline (live metrics)

Recap needs only the herdr integration above. The live metrics on each card — model,
context %, cost, and the account-wide 5h/7d rate-limit windows — come from your Claude
**statusline**.

**How it works.** Claude Code runs a statusline command on every refresh (debounced ~300 ms)
and pipes it a JSON blob — model, cost, context window, session id — on **stdin**; whatever
the command prints becomes your statusline. You register that command per config dir in
`settings.json`:

```json
{ "statusLine": { "type": "command", "command": "~/.claude/statusline-command.sh" } }
```

corral's `scripts/corral-status-capture.sh` reads that **same** stdin JSON, maps it to corral's
schema, and writes `<configDir>/corral-status/<session_id>.json` — which corral reads (locally
or over SSH) and never persists. It hooks in via one non-blocking line that tees stdin to the
capture script:

```bash
printf '%s' "$input" | "$CONFIG_DIR/corral-status-capture.sh" "$CONFIG_DIR" >/dev/null 2>&1 &
```

**Which script do you point `command` at?**

- **You already run your own statusline script** — keep it. Add just the inject line above,
  after your script has read stdin into `$input` and resolved `$CONFIG_DIR` (the config dir,
  e.g. `${CLAUDE_CONFIG_DIR:-$HOME/.claude}`). Do **not** also install corral's
  `statusline-command.sh`.
- **You don't have one** — use corral's ready-made `scripts/statusline-command.sh`. It reads
  stdin, resolves the config dir, renders a compact `model · dir · ctx% · cost` line, and runs
  the inject for you — a working statusline *and* corral metrics in a single file.

Requires `jq`. Best-effort: the inject is backgrounded, so it never delays or breaks the
statusline (Claude cancels a slow statusline mid-run). The 5h/7d windows appear only for
Pro/Max accounts, after the first API response.

## Claude theme (optional)

corral can live-flip the light/dark **base** of a Claude custom theme from the web theme
toggle — it rewrites only the `base` field of `<configDir>/themes/corral.json`, and Claude Code
hot-reloads it so the TUI follows. It never creates that file, and the toggle syncs **local**
config dirs only (a remote box keeps whatever base is in its own copy). Once the file is in
place, set `"theme": "custom:corral"` in that dir's `settings.json` (or run `/theme` and pick
`corral`). Edit `overrides` in the preset to taste; only `base` is machine-managed.

## Installing the Claude helper files (per config dir)

The statusline and theme pieces live **per Claude config dir** — every `~/.claude*` dir you
want surfaced, on every machine. Local and remote are the *same files in the same place*; only
the copy command differs (`cp` vs `scp` + `ssh`). Into each config dir:

| File | Source in this repo | When you need it |
|------|---------------------|------------------|
| `corral-status-capture.sh` | `scripts/corral-status-capture.sh` | always (it writes the metrics file) |
| `statusline-command.sh` | `scripts/statusline-command.sh` | only if you have **no** statusline script of your own |
| `themes/corral.json` | `themes/corral.json` | only for the optional theme |
| `skills/corral/` | `skills/corral/` | recommended with the [MCP server](#mcp-server); only on the machine running corral |

**Local** (default `~/.claude`; repeat for each extra dir such as `~/.claude-work`):

```bash
D=~/.claude
cp scripts/corral-status-capture.sh "$D/corral-status-capture.sh"
cp scripts/statusline-command.sh    "$D/statusline-command.sh"    # skip if you have your own
chmod +x "$D/corral-status-capture.sh" "$D/statusline-command.sh"
mkdir -p "$D/themes" && cp themes/corral.json "$D/themes/corral.json"   # optional theme
mkdir -p "$D/skills" && cp -R skills/corral "$D/skills/corral"          # recommended with the MCP server
echo "corral-status/" >> "$D/.gitignore"    # if the config dir is version-controlled
```

**Remote** (over SSH — `H` is the environment's `sshHost`, `D` its config dir, e.g.
`/home/me/.claude`):

```bash
H=my-ssh-host; D=/home/me/.claude
scp scripts/corral-status-capture.sh "$H:$D/corral-status-capture.sh"
scp scripts/statusline-command.sh    "$H:$D/statusline-command.sh"     # skip if it has its own
ssh "$H" "chmod +x $D/corral-status-capture.sh $D/statusline-command.sh && mkdir -p $D/themes"
scp themes/corral.json "$H:$D/themes/corral.json"                      # optional theme
```

Then, in **each** config dir's `settings.json` (edit it on the box where the dir lives), point
the statusline at the script and — if you copied the theme — select it:

```json
{
  "statusLine": { "type": "command", "command": "/absolute/path/to/statusline-command.sh" },
  "theme": "custom:corral"
}
```

The dirs you install into must match each environment's `claudeConfigDirs` in
`environments.json` — that's exactly where corral looks for the metrics file.

## Security model

- **Loopback only** — the server binds `127.0.0.1` and refuses anything else; there is no
  auth layer to get wrong.
- **Anti-DNS-rebinding `Host` check** — every REST request must carry a loopback `Host`
  (`127.0.0.1`, `::1`, or `localhost`), or none at all. This is what actually enforces the
  loopback boundary in-app: a page whose DNS has rebound to `127.0.0.1` becomes same-origin
  and would otherwise reach the whole API despite the bind.
- **The attach endpoint is the highest-privilege surface** (`GET
  /api/sessions/:env/:paneId/attach`, WebSocket): Origin allowlist (WebSockets bypass
  same-origin policy — this is the CSRF guard), a spawn cap + token-bucket rate limit,
  heartbeat + pty reaping, and an audit log at `$CORRAL_HOME/attach-audit.log` (keystroke
  content deliberately not logged — it would capture operator secrets).
- **xterm output is untrusted** — clipboard-write (OSC 52), web links, and window
  report/response sequences are all disabled, so hostile pane output can't inject synthetic
  keystrokes into a live agent.
- **Upload endpoint** (`POST /api/envs/:env/uploads`, the drag-to-attach file surface) —
  local environments only. The `Host` check above applies here too, but multipart is a
  CORS-simple content type, so it is not sufficient on its own: the route adds an Origin
  allowlist and a 25 MB body-size cap.
- **All herdr/SSH calls use `execFile` with argument arrays** — no shell string
  interpolation; remote commands quote user tokens with `shell-quote`.
- **Environments are trusted startup config** — never writable through the API.

## Configuration (env vars)

`HERDR_DASH_PORT` (8787) · `HERDR_DASH_HOST` (127.0.0.1) · `HERDR_DASH_POLL_MS` (30000 — the
cheap poll driving the attention feed) · `ATTENTION_MIN_WORK_MS` (600000 — a delegated task
must run ≥10 min for its finish to count) · `CORRAL_HOME` (`~/.corral`) ·
`CORRAL_CONFIG` (`$CORRAL_HOME/environments.json`) · `BOARD_DATA_DIR` (defaults to
`$CORRAL_HOME` — see Architecture for why this must be a fresh directory) ·
`RECAP_ENABLED` (true) · `STATUSLINE_ENABLED` (true) · `CORRAL_ALLOW_UNDER_CLAUDE` (unset — set to
exactly `1` to start anyway from inside a Claude Code session; see Launching corral).

WebSocket attach: `WS_MAX_CONCURRENT` (3) · `WS_RATE_PER_WINDOW` (10) / `WS_RATE_WINDOW_MS`
(10000) · `WS_HEARTBEAT_MS` (30000) · `WS_KILL_GRACE_MS` (2000) · `WS_PROBE_GRACE_MS` (2000).

Zombie-tab reaper (closes the shell-only tab left when Claude exits; logs each reap as
`zombie_reaped`): `ZOMBIE_REAP_ENABLED` (true) · `ZOMBIE_REAP_GRACE_MS` (180000 — clamped up at boot
to a floor derived from `HERDR_DASH_POLL_MS`; to disable, use the flag, never a short grace).

[MCP server](#mcp-server): `CORRAL_URL` (defaults to `http://127.0.0.1:$HERDR_DASH_PORT` — read by
the MCP process, see the note there) · `BRIEF_MAX_BYTES` (16384) · `BRIEF_CLEANUP_DELAY_MS` (600000
— backstop only; a brief is normally deleted by the launch command that reads it).

For deeper live scrollback set `pane_history = true` in `~/.config/herdr/config.toml`.

## MCP server

corral also ships an MCP server (`mcp/index.ts`) so a Claude session running inside a herdr pane
can see its own assignment and drive its own lifecycle instead of an operator retyping it by hand
— see [ADR 0002](docs/adr/0002-mcp-server-as-the-agent-seam.md) for why. Register it with absolute
paths, so it resolves from whatever directory a session happens to start in:

```bash
claude mcp add --scope user corral -- /path/to/corral/node_modules/.bin/tsx /path/to/corral/mcp/index.ts
```

**Once per Claude config dir, not once per machine.** `--scope user` writes into the config dir
that is active when you run it, so a session started under a different one simply has no corral
tools — no error, just nothing there. If you run the split-account setup above, repeat it for each:

```bash
CLAUDE_CONFIG_DIR=~/.claude-work claude mcp add --scope user corral -- /path/to/corral/node_modules/.bin/tsx /path/to/corral/mcp/index.ts
```

Register it only in config dirs **on the machine running corral**. The MCP process talks to the
corral server over that machine's loopback, so a session on a remote environment has nothing to
reach — its tools would report `unreachable`.

**The Claude integration is a prerequisite here, not just for recaps.** corral discovers sessions by
running `herdr agent list`, which comes in two halves. herdr itself reports each pane's coordinates
and agent status — enough for `corral_whoami` to identify the caller and find its card. But the
*Claude session UUID* is contributed by the integration (herdr labels it `source: "herdr:claude"`),
and that UUID is the key corral uses to find a session's transcript and its statusline file. So
without `herdr integration install claude`, `corral_whoami` reports `session id: not registered yet`
permanently and leaves `model`, `ctx` and `cost` empty — which removes exactly the signal a session
watches to notice its own context pressure and hand off in time.

It resolves that address from **its own** environment (`CORRAL_URL`, else
`http://127.0.0.1:$HERDR_DASH_PORT`), and it inherits the pane's shell, not the corral server's. So
if you run corral on a non-default port, either export `HERDR_DASH_PORT` where Claude starts or pin
it at registration with `--env CORRAL_URL=http://127.0.0.1:<port>` — otherwise every tool reports
`unreachable` against port 8787 while the server is running perfectly well somewhere else.

The seven tools:

- `corral_whoami` — this session's pane/tab/workspace, Claude session id, model/context/cost, and its bound task card; call it first.
- `corral_fleet` — one bounded line per session across every environment, for cross-session triage.
- `corral_task_bind` — link this session to an existing task card (no card creation).
- `corral_task_read` — the bound card's full description. `corral_whoami` renders it as a one-line preview, because that call is repeated many times a session and a long progress log would be re-inlined on every one; this is the opt-in full read, and the one to call before rewriting the description.
- `corral_task_update` — update the bound card's title, description, status, or priority.
- `corral_spawn` — start a new session on this session's card, with a brief as its first message.
- `corral_session_close` — stop this session or one on the same card; suspend, not destroy.

The server registers **no tools outside herdr** — launched with `HERDR_ENV`/`HERDR_PANE_ID` unset,
it connects but declares no tool capability at all, so a non-herdr session sees no corral tools and
pays nothing for the connection. (Because the capability is absent rather than empty, a `tools/list`
sent anyway comes back `Method not found` — expected, not a fault.) Installing it at user scope is
therefore safe for any non-herdr session too. A spawn brief is available for **local environments only**, and the audit
trail it leaves records coordinates and size, never contents. A same-environment spawn **joins the
caller's own workspace** (a new tab beside it); a cross-environment spawn **roots a new workspace**
at that environment's configured repo path instead. Phase 1 has no path to write into another
*existing* session's pane — the spawn brief is the only agent-authored text that reaches a pane at
all, and that pane is always brand-new. `corral_spawn` and `corral_session_close` carry MCP's
`destructiveHint` annotation (and say so in their descriptions); `corral_whoami`, `corral_fleet` and
`corral_task_read` carry `readOnlyHint`. Those are hints for the harness, not enforcement — nothing in the server
requires confirmation. The actual control is the operator's Claude Code permission configuration:
simply don't allowlist the two destructive tools, same as any other destructive tool call.

### Teaching a session what corral is

A tool description explains its own tool. None of them can carry the vocabulary they all assume —
board, card, link, detached — or the orderings that span several tools, and getting one of those
wrong loses work: a handoff that closes the session before writing the card arrives empty. Two
pieces cover that, and they are not alternatives.

**Automatic, nothing to install.** The server sends a short orientation as MCP `instructions`, which
the client puts in the session's context before it does anything. That is what makes a *spawned*
session work at all: it learns that `corral_whoami` exists in time to call it. Like the tools, this
is sent only inside herdr, so a non-herdr session pays nothing.

**Recommended, and you should install it.** The orientation is deliberately minimal — it is context
cost in every corral session, so it carries only the vocabulary and the hazardous orderings. The
skill carries the rest: the workflows, how to write a brief worth handing over, what the tools do
*not* expose, and what each failure means. A session without it works from the summary alone and will
get the details wrong. Copy it into each config dir you registered the server in (see
[the helper-file table](#installing-the-claude-helper-files-per-config-dir)):

```bash
mkdir -p ~/.claude/skills && cp -R skills/corral ~/.claude/skills/corral
```

It loads only when a session actually reaches for corral, so it costs nothing the rest of the time.

## Architecture (short version)

TypeScript end-to-end. Backend: Hono + SSE, shelling out to the herdr CLI via `execFile`
(never a string shell). Frontend: React + Vite + Tailwind + dnd-kit. Storage: JSON files in a
dedicated git repo under `$BOARD_DATA_DIR` (defaults to `$CORRAL_HOME`) that corral `git init`s
and auto-commits every 10s — point it at a fresh directory, never inside an existing repo. A
deterministic state + view + control substrate with a clean API — a future LLM agent is just
another API client, never embedded.

Full design: [`docs/specs/design-spec.md`](docs/specs/design-spec.md). Durable decisions:
[`docs/adr/`](docs/adr/).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The short version: strict TypeScript conventions —
no `any`, no type assertions (enforced by ESLint), Zod at every boundary (convention) — Vitest,
and one gate: `npm run check`. PRs must say what changed and why. Security reports go through
[SECURITY.md](SECURITY.md), not public issues.

## License

[MIT](LICENSE)
