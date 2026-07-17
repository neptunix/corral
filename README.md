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
machine (and on any remote box you add), `jq` for the optional statusline capture.

```bash
# 1. herdr's Claude integration (per machine) — enables session recaps
herdr integration install claude

# 2. configure your environments
mkdir -p ~/.corral
cp environments.example.json ~/.corral/environments.json
$EDITOR ~/.corral/environments.json

# 3. run
npm install          # node-pty is native — compiles against your Node ABI
npm run dev          # Vite (http://127.0.0.1:5173) + API (http://127.0.0.1:8787), proxied
# production:
npm run build && npm start   # serves API + built UI on http://127.0.0.1:8787
```

That gets you the board, attention feed, and live terminal. **Live Claude metrics
(model / context % / cost / rate-limit windows) and the optional TUI theme need one more
per-config-dir step** — see [Claude statusline](#claude-statusline-live-metrics) and
[Installing the Claude helper files](#installing-the-claude-helper-files-per-config-dir) below.

The server binds `127.0.0.1` only and refuses other hosts. There is no auth — corral trusts
whoever can reach the loopback interface. On a single-user machine that's just you; on a shared
or multi-user box, any other local user or process that can reach `127.0.0.1` has the same
access, including the session-attach endpoint.

## Environments

Environments live in a JSON config file, **not** in source — everyone runs their own boxes.
Default path `~/.corral/environments.json` (override with `$CORRAL_CONFIG`; the data
home `~/.corral` is `$CORRAL_HOME`). Loaded and Zod-validated once at startup; the
server fails fast with a clear message if missing. **Environments are never editable via the
API** — a runtime-set `sshHost` would turn the server into an SSH relay.

- `kind: "local"` — talks to a herdr socket on this machine. With no `socket` it inherits
  the ambient `HERDR_SOCKET_PATH` (launch corral from the right herdr context or set it).
- `kind: "remote"` — talks to a box over SSH (`sshHost`, `socket`, `herdrBin` required).
  Unreachable environments show "offline" and keep their last-good snapshot.
- `spawnCommand` — what corral runs to start a new agent session in this environment.
  Defaults to `claude`.
- `repos` — a name → path map used by spawn to pick the working directory.

## Multiple Claude accounts

If you keep separate Claude accounts (say, work and personal), give each one its own config
dir and a tiny shell wrapper:

```bash
# ~/.zshrc
claude-work()     { CLAUDE_CONFIG_DIR=~/.claude-work     command claude "$@"; }
claude-personal() { CLAUDE_CONFIG_DIR=~/.claude-personal command claude "$@"; }
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
want surfaced, on every machine (each `local` and `remote` environment's `claudeConfigDirs`).
Local and remote are the *same files in the same place*; only the copy command differs (`cp`
vs `scp` + `ssh`). Into each config dir:

| File | Source in this repo | When you need it |
|------|---------------------|------------------|
| `corral-status-capture.sh` | `scripts/corral-status-capture.sh` | always (it writes the metrics file) |
| `statusline-command.sh` | `scripts/statusline-command.sh` | only if you have **no** statusline script of your own |
| `themes/corral.json` | `themes/corral.json` | only for the optional theme |

**Local** (default `~/.claude`; repeat for each extra dir such as `~/.claude-work`):

```bash
D=~/.claude
cp scripts/corral-status-capture.sh "$D/corral-status-capture.sh"
cp scripts/statusline-command.sh    "$D/statusline-command.sh"    # skip if you have your own
chmod +x "$D/corral-status-capture.sh" "$D/statusline-command.sh"
mkdir -p "$D/themes" && cp themes/corral.json "$D/themes/corral.json"   # optional theme
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
`RECAP_ENABLED` (true) · `STATUSLINE_ENABLED` (true).

WebSocket attach: `WS_MAX_CONCURRENT` (3) · `WS_RATE_PER_WINDOW` (10) / `WS_RATE_WINDOW_MS`
(10000) · `WS_HEARTBEAT_MS` (30000) · `WS_KILL_GRACE_MS` (2000) · `WS_PROBE_GRACE_MS` (2000).

For deeper live scrollback set `pane_history = true` in `~/.config/herdr/config.toml`.

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
