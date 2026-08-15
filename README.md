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
data yet" — and corral's own self-diagnostics report a missing `jq` as a fatal verdict. corral
appends `--name` (and, when chosen, `--model` / `--remote-control`) to every
non-resume launch; this has only been verified against Claude Code 2.1.232 — an older CLI
lacking one of these flags will fail the launch visibly in the pane. The cross-session messaging
the corral skill describes was verified on that same build; per the Claude Code changelog it landed
in 2.1.224, which is older than anything available here to check against.

```bash
# 0. prerequisite check — without jq the metrics capture silently does nothing
command -v jq >/dev/null || echo "install jq first — the live metrics need it"

# 1. herdr's Claude integration (per machine) — REQUIRED: recaps, live metrics and live session state
herdr integration install claude

# 2. configure your environments
mkdir -p ~/.corral
cp environments.example.json ~/.corral/environments.json
$EDITOR ~/.corral/environments.json

# 3. one herdr server per session named in environments.json — see "Running herdr" below.
#    Without them the board comes up empty. Each session gets its own socket, so each
#    environment points at its own; repeat the line per session, or run just one.
#    nohup matters: herdr server dies on SIGHUP, i.e. when you close the window.
nohup herdr --session work server >/dev/null 2>&1 &
nohup herdr --session personal server >/dev/null 2>&1 &

# 4. run — from a terminal OUTSIDE Claude Code (see "Launching corral" below)
npm install          # node-pty is native — compiles against your Node ABI
npm run dev          # Vite (http://127.0.0.1:5173) + API (http://127.0.0.1:8787), proxied
# production:
npm run build && npm start   # serves API + built UI on http://127.0.0.1:8787

# 5. per-config-dir helper files — needed for the live metrics (and the optional theme).
#    Skip this and roughly half of each card's information is simply not wired up.
D=~/.claude          # repeat for every ~/.claude* dir you want surfaced, on every machine
cp scripts/corral-status-capture.sh "$D/corral-status-capture.sh"
cp scripts/statusline-command.sh    "$D/statusline-command.sh"   # skip if you have your own
chmod +x "$D/corral-status-capture.sh" "$D/statusline-command.sh"
#    ...then register the statusline in "$D/settings.json" — see the full section below for
#    that snippet, the optional theme, remote boxes and multiple config dirs.
```

That gets you the board, attention feed, live terminal and recap — plus the live Claude metrics,
which are what step 5 buys. Step 5 is summarised above and documented in full under
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

## Running herdr

corral is a client: it talks to a herdr *server* over a unix socket and never starts one for you, so
that server's lifetime is yours to manage. Verified against herdr 0.7.1 on macOS and 0.7.5 on Linux.

### Start it headless

The TUI is optional — corral needs the server, not the terminal UI:

```bash
nohup herdr --session work server >/dev/null 2>&1 &
```

One server per session, and each `local` environment in `environments.json` points at one of them —
so if you keep separate sessions for separate Claude accounts, you run one of these per session. The
session is created on first start; there is no `herdr session create` and nothing to set up
beforehand. Run it from a terminal outside Claude Code, for the same reason corral itself refuses to
start there (see [Launching corral](#launching-corral)).

**Recommended on macOS: skip the hand-started form above and go straight to a LaunchAgent per
session** ([Keep it running](#keep-it-running), below). A hand-started server does not survive
logout or reboot; a LaunchAgent does, starts clean (never inherits a Claude Code session's
environment), and is what shows up as an ordinary entry under System Settings → General → Login
Items & Extensions — one entry per session, matching the one-server-per-session model above.

Use the `--session <name>` **flag**, not the `HERDR_SESSION` environment variable. Every herdr pane
exports `HERDR_SOCKET_PATH`, and that variable silently outranks `HERDR_SESSION` — run
`HERDR_SESSION=work herdr server` from inside a pane and it reports `herdr server is already running`
against whichever session that pane belongs to, which is not a session you named. The flag wins over
the ambient variable, so it works from anywhere.

`nohup` is not decoration: `herdr server` is an ordinary child of your shell and dies on `SIGHUP`, so
a bare `herdr --session work server &` goes down when you close the terminal window. (The TUI form,
`herdr --session work`, forks a detached daemon instead and does survive — that is why servers started
that way outlive their tab.) A supervisor, below, removes the question entirely.

That command puts the socket at `~/.config/herdr/sessions/work/herdr.sock`, and **that exact path is
what the environment's `socket` must contain** in `environments.json`. Pin it explicitly rather than
leaving `socket` out: a `local` environment with no `socket` inherits the launching shell's ambient
`HERDR_SOCKET_PATH`, and once servers start from a launchd agent or a systemd unit there is no such
variable to inherit.

`herdr --session work` with no `server` argument **attaches** to a server that is already up. Run it
when nothing is up and it starts one inside your terminal tab — that works, and Terminal.app's close
dialog will list your whole fleet, but closing the tab does not end the session.

### Keep it running

A hand-started server does not survive a reboot. Give it a supervisor. **One service per session**,
named so you can find it later.

Check first — herdr will not let two servers share a session (the second exits with `herdr server is
already running` and the first is untouched), but the supervisor then keeps retrying a job that cannot
succeed:

```bash
herdr session list                                   # already serving this session by hand?
launchctl print gui/$UID/dev.corral.herdr.work       # macOS: non-zero exit means not installed
systemctl --user list-unit-files 'corral-herdr*'     # Linux: same question
```

**macOS** — `~/Library/LaunchAgents/dev.corral.herdr.work.plist`. `ProgramArguments[0]` **must be an
absolute path**: launchd gives an agent a minimal `PATH`, and a bare `herdr` fails with `EX_CONFIG`
before it ever runs. The agent panes themselves need no `PATH` entry — the pane's shell supplies that.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>dev.corral.herdr.work</string>
    <key>ProgramArguments</key>
    <array>
        <string>/opt/homebrew/bin/herdr</string>  <!-- substitute $(command -v herdr) -->
        <string>--session</string>
        <string>work</string>
        <string>server</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/dev.corral.herdr.work.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/dev.corral.herdr.work.log</string>
</dict>
</plist>
```

```bash
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/dev.corral.herdr.work.plist
```

launchd does not re-read a plist you have edited — `launchctl bootout gui/$UID/dev.corral.herdr.work`
and bootstrap it again.

Two macOS-only things to expect. A LaunchAgent belongs to the GUI login session, so the server comes
back **when you log in** — not while the machine sits at the login window; a Mac used as an unattended
host wants something else. And macOS raises a "herdr can run in the background" notification and adds
an entry under System Settings → General → Login Items & Extensions, marked *Item from unidentified
developer*. That entry is named after the binary, so it reads `herdr` regardless of the `Label` — and
if anyone turns its toggle off, the server stops starting at login and nothing says so.

**Linux** — `~/.config/systemd/user/corral-herdr-work.service`:

```ini
[Unit]
Description=herdr server (work)

[Service]
Type=simple
ExecStart=%h/.local/bin/herdr --session work server
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now corral-herdr-work.service
loginctl enable-linger "$USER"        # survive logout, come up at boot
```

**Did it work?** `herdr session list` shows the session `running`, and the server's own log is at
`~/.config/herdr/sessions/work/herdr-server.log`. If the session never appears, the server never ran,
so that log will not exist — look at the supervisor instead: `launchctl print
gui/$UID/dev.corral.herdr.work` and read `last exit code` (plus `/tmp/dev.corral.herdr.work.log`), or
`journalctl --user -u corral-herdr-work.service`. The two supervisors give up differently: launchd
retries indefinitely, while systemd stops after a burst of restarts and parks the unit in `failed`.
Once you have fixed the cause, `systemctl --user start corral-herdr-work.service` brings it back.

**Stopping it.** `herdr server stop` on its own will not keep it down — the supervisor replaces the
process within seconds — and it acts on whichever server your shell's socket points at, not on a
session by name. Stop the service, then the session:

```bash
launchctl bootout gui/$UID/dev.corral.herdr.work    # macOS
systemctl --user stop corral-herdr-work.service     # Linux
herdr session stop work
```

That is also the herdr-upgrade sequence; start the service again afterwards (on macOS, bootstrap it
again — `bootout` only lasts until the next login). To remove supervision for good, delete the plist
or `systemctl --user disable corral-herdr-work.service`.

What supervision buys is precise: the server comes back on its own, and the workspace/tab/pane layout
comes back with it — but **the processes inside those panes do not**. A restarted server hands you the
same panes running fresh shells. For agent panes, herdr's `[session] resume_agents_on_restore` is what
relaunches the agent into its conversation session.

### The TUI and the live terminal

Do not keep herdr's TUI and corral's in-browser terminal attached to the same pane at once. The pane's
geometry follows whichever client was active last, so moving between them resizes it and rendering
tears. herdr has no setting that pins pane size, so the fix is to use one at a time: `ctrl+b` then `q`
detaches the TUI and leaves the server and every agent running.

Attaching the TUI to an already-headless server is otherwise fine.

**Already started one inside a tab?** It cannot be moved out without stopping it, and stopping it
takes the agents with it. Adopt the recipe above at your next reboot or planned restart.

**Scroll speed.** A pane running a TUI — every Claude Code session — gets at most one wheel report per
wheel event, and a trackpad flick or a finger drag already reaches that ceiling, so xterm's own
`scrollSensitivity` has no headroom left to give there. The gear in the top right of the board header
sets how many wheel events corral emits per real one (1–10, default 3), which does cross it. It acts on
pixel-mode wheel input — Chrome, Safari, trackpads, touch — and leaves Firefox's line-mode wheel alone.
Stored per browser in `localStorage`, so a laptop and a phone keep independent values, and it applies to
sessions opened after the change.

### herdr's Claude integration

```bash
herdr integration install claude
```

installs herdr's own Claude Code hook, **once per machine** — not per config dir, not per
session. It is what makes a Claude-launched pane's agent record carry `source: "herdr:claude"`
and a live agent status (working / blocked / idle) alongside the Claude session UUID that record
is contributed to; without it, a pane herdr owns is indistinguishable from an ordinary shell.

`herdr integration status` reports one of `current`, `outdated`, or `not installed` **per Claude
config dir** — run it after every herdr upgrade, the same way you'd check the [helper
files](#upgrading) after a `git pull`, since the two can drift out of sync independently of each
other.

**What stops working without it: the attention feed never fires.** corral detects a session
**blocking** or **finishing** entirely from herdr's own agent status — there is no second source
for that state, and a remote environment has no local fallback to read it from instead. An
environment with the integration missing or outdated still renders a board, still spawns
sessions, and still shows a live terminal; its cards simply never transition, which looks exactly
like a quiet fleet until you notice nothing has moved in hours.

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

**After a reboot**, herdr servers must be up before `npm run dev` — automatically if you followed
[Running herdr](#running-herdr), by hand otherwise. Then open the UI. corral
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

**`git pull` does not touch your installed copies.** `corral-status-capture.sh`,
`corral-claude-hook.sh`, and `skills/corral/` are copied into `~/.claude*` — outside this
checkout — by the per-config-dir install step (see [Installing the Claude helper
files](#installing-the-claude-helper-files-per-config-dir)), so an upgrade that changes any of
them leaves the installed copy running the old version until you re-copy it (`cp` locally,
`scp` again for a remote config dir). Symlink them once instead and this stops being a step:
`ln -s "$(pwd)/scripts/corral-claude-hook.sh" "$D/corral-claude-hook.sh"` makes the installed
file follow the checkout across every future `git pull` — local only, since there is no `scp`
equivalent of a symlink for a remote config dir.

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
  An unreachable environment keeps its last-good snapshot and its cards stop changing. The 🛟 health
  panel in the right-hand rail flags it — `env-reachable` turns amber there with the reason — and the
  server records it in the log as well; corral also names a missing `herdr`/`ssh` at startup.
- `spawnCommand` — what corral runs to start a new agent session in this environment.
  Defaults to `claude`. One hard constraint: it must be a **single token** — no spaces and no
  arguments, which the config schema rejects outright, so wrap any flags in a script. It does not
  have to be an executable file: corral types the launch line into the pane with `herdr pane run`,
  and that pane runs an interactive shell, so a function or alias from your `.zshrc` / `.bashrc`
  resolves there just as an executable on `PATH` does. Put it in the interactive rc file, not
  `.zprofile` / `.bash_profile` — herdr's `[terminal] shell_mode` defaults to a login shell only on
  macOS. A script is still the more portable choice, and it is what the *Multiple Claude accounts*
  example below uses.
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
expanded on the remote shell. A repo you didn't list can't be spawned into by name; you can still
spawn into an already-open herdr workspace instead. See `environments.example.json` for
complete local and remote entries.

The names are also what `corral_spawn`'s `repo` argument takes, and a name that isn't configured
comes back as a refusal **listing the ones that are** — from the UI you pick from a menu, and an
agent gets the same menu the moment it guesses wrong. One workspace per repository is the
convention corral spawns by: naming a repo lands the session in that repository's workspace,
joining it if it already exists and creating it at the configured path otherwise, and the new tab
starts at that configured path either way.

## Multiple Claude accounts

If you keep separate Claude accounts (say, work and personal), give each one its own config dir
and a tiny wrapper **script** on `PATH`. A shell function works too (see `spawnCommand` above), but a
script is portable across shells and across remote environments, and it is the form the
argument-forwarding example below depends on.

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
`socket` they route to the same herdr instance and show the same sessions twice. Give each
account its own named herdr session — `herdr --session work server`,
`herdr --session personal server`, one supervised service each (see
[Running herdr](#running-herdr)) — and point that environment's `socket` at the session's own
`~/.config/herdr/sessions/<name>/herdr.sock`. Only one `local` environment should omit `socket` — the
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

## Claude context-pressure hook

**Recommended** — a session that cannot see its own context pressure has to guess when to hand
off, and a late guess costs more than an early one. corral can tell a session about its own
context-window pressure before it asks — a
`UserPromptSubmit` hook injects a short `[corral] ctx {pct}% (notice|nudge|urgent)` signal once
context crosses 30/40/60%, and a `SessionStart` hook primes the protocol for what to do about it
once per session (and again after `/compact`). Both read the same
`corral-status/<session_id>.json` the statusline capture already writes — this hook reads the
file `corral-status-capture.sh` writes, so that script must already be installed and wired into
your statusline command (see above) — without it this hook silently does nothing (best-effort,
same contract as the capture script).

Thresholds are configurable in `~/.corral/config.json` (falls back to `30/40/60` if absent or
malformed):

```json
{ "hooks": { "ctxThresholds": [30, 40, 60] } }
```

Requires `jq` and the `skills/corral/` skill installed in the same config dir (see the table
below) — the hook reads its context-pressure protocol out of `SKILL.md` rather than duplicating
the text.

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
| `corral-claude-hook.sh` | `scripts/corral-claude-hook.sh` | recommended — proactive context-pressure signal |

**Local** (default `~/.claude`; repeat for each extra dir such as `~/.claude-work`):

```bash
D=~/.claude
cp scripts/corral-status-capture.sh "$D/corral-status-capture.sh"
cp scripts/statusline-command.sh    "$D/statusline-command.sh"    # skip if you have your own
cp scripts/corral-claude-hook.sh   "$D/corral-claude-hook.sh"    # recommended — context-pressure hook
chmod +x "$D/corral-status-capture.sh" "$D/statusline-command.sh" "$D/corral-claude-hook.sh"
mkdir -p "$D/themes" && cp themes/corral.json "$D/themes/corral.json"   # optional theme
mkdir -p "$D/skills" && cp -R skills/corral "$D/skills/corral"          # recommended with the MCP server
echo "corral-status/" >> "$D/.gitignore"    # if the config dir is version-controlled
```

Locally, you can `ln -s "$(pwd)/scripts/corral-claude-hook.sh" "$D/corral-claude-hook.sh"`
instead of `cp` if you don't want to re-copy after every `git pull` — there's no equivalent for
the remote `scp` step below.

**Remote** (over SSH — `H` is the environment's `sshHost`, `D` its config dir, e.g.
`/home/me/.claude`):

```bash
H=my-ssh-host; D=/home/me/.claude
scp scripts/corral-status-capture.sh "$H:$D/corral-status-capture.sh"
scp scripts/statusline-command.sh    "$H:$D/statusline-command.sh"     # skip if it has its own
scp scripts/corral-claude-hook.sh    "$H:$D/corral-claude-hook.sh"      # recommended — context-pressure hook
ssh "$H" "chmod +x $D/corral-status-capture.sh $D/statusline-command.sh $D/corral-claude-hook.sh && mkdir -p $D/themes"
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

If you installed the context-pressure hook, register it under both events in the same
`settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      { "matcher": "startup|resume|clear|compact",
        "hooks": [{ "type": "command", "command": "/absolute/path/to/corral-claude-hook.sh" }] }
    ],
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "/absolute/path/to/corral-claude-hook.sh" }] }
    ]
  }
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
`RECAP_ENABLED` (true) · `STATUSLINE_ENABLED` (true) · `FOCUS_TRANSLATION_ENABLED` (true — corral
focuses a session's herdr tab when you open its terminal and restores the previously focused tab when
you close it, so the pane goes through a real focus-out and Claude *can* write its own recap again. Note
that Claude also refuses to write one unless the account's rate-limit status is exactly `allowed`, which
corral cannot see or change — see `docs/adr/0005`; set to `false` to leave herdr's focus untouched) · `CORRAL_ALLOW_UNDER_CLAUDE` (unset — set to
exactly `1` to start anyway from inside a Claude Code session; see Launching corral).

WebSocket attach: `WS_MAX_CONCURRENT` (3) · `WS_RATE_PER_WINDOW` (10) / `WS_RATE_WINDOW_MS`
(10000) · `WS_HEARTBEAT_MS` (30000) · `WS_KILL_GRACE_MS` (2000) · `WS_PROBE_GRACE_MS` (2000).

Zombie-tab reaper (closes the shell-only tab left when Claude exits; logs each reap as
`zombie_reaped`): `ZOMBIE_REAP_ENABLED` (true) · `ZOMBIE_REAP_GRACE_MS` (180000 — clamped up at boot
to a floor derived from `HERDR_DASH_POLL_MS`; to disable, use the flag, never a short grace).

Self-diagnostics sweep: `DIAGNOSTICS_INTERVAL_MS` (60000 — set to `0` to turn the background sweep
off entirely; `POST /api/diagnostics/refresh` still runs one on demand) · `DIAGNOSTICS_VERSION_TTL_MS`
(600000, floor 1000 — how long a herdr/Claude version probe is cached before the sweep re-runs it).
It also reads `$CORRAL_HOME/config.json` for `hooks.ctxThresholds` — see [Claude context-pressure
hook](#claude-context-pressure-hook).

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

It also gates the board's live session state: a pane with no session id has nothing to join Claude's
own registry record to, so its row reads **"starting"** — permanently, on a machine where the
integration is missing.

The same is true of a pane herdr's hook never saw, integration or not: the hook reports nothing unless
`HERDR_ENV`, `HERDR_SOCKET_PATH` and `HERDR_PANE_ID` are all set in that pane, so a session started by
hand rather than through herdr reads "starting" for its whole life. Start sessions through herdr (or
corral) and this does not arise.

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
- `corral_spawn` — start a new session on this session's card, with a brief as its first message; `repo` says which project it lands in.
- `corral_session_close` — stop this session or one on the same card; suspend, not destroy.

The server registers **no tools outside herdr** — launched with `HERDR_ENV`/`HERDR_PANE_ID` unset,
it connects but declares no tool capability at all, so a non-herdr session sees no corral tools and
pays nothing for the connection. (Because the capability is absent rather than empty, a `tools/list`
sent anyway comes back `Method not found` — expected, not a fault.) Installing it at user scope is
therefore safe for any non-herdr session too. A spawn brief is available for **local environments only**, and the audit
trail it leaves records coordinates and size, never contents. Where the new session lands is the
caller's to state: omit `repo` and it **joins the caller's own workspace** (a new tab beside it, so
a worktree checkout stays visible); pass `repo` and it lands in **that repository's workspace**, at
its configured path. There is no inferred default — a spawn with neither (a cross-environment
handoff, say, where the caller has no workspace over there) is refused with the target
environment's configured repository names, rather than guessed at. Phase 1 has no path to write into another
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

### Letting sessions talk to each other (recommended)

Messaging between sessions is Claude Code's own (`SendMessage` / `ListAgents`), not
corral's — but corral supplies the address: `corral_fleet` prints the name each session actually
answers to, which is not always the label on its card. The skill documents how to use it and where
the reach ends; two things are worth setting up once, on each machine:

**`crossSessionInbound`.** A message is held for the receiving operator's hand approval when the two
sessions' permission modes differ — and corral panes typically run in bypass mode while an ordinary
terminal session does not, so a pane messaging a hand-started session is held by default. The sender
is told it was held and to carry on, so nothing hangs; the message waits for an approval that may
never come, and expires if it does not. Set this in the `settings.json` of every config dir you
registered corral's MCP server in:

```json
{ "crossSessionInbound": "accept" }
```

Values are `accept` / `hold` / `refuse`. The setting is checked before any permission-mode comparison,
so it decides outright. `accept` means messages from your other sessions reach this one unreviewed — treat their content as untrusted input, which is the same rule that already applies
to recaps and card text. Managed (organization) settings and a repository's own `settings.json` can
only tighten this, never loosen it.

**Remote Control**, if you run corral across machines. A session on another machine is addressable by
name only over Remote Control — and it only becomes visible to you if the session doing the
addressing has Remote Control on too: with it off locally, no other machine appears in `ListAgents`. `corral_fleet` marks a remote-environment session that has it off as
`rc: off`. Without it, a cross-machine session is still visible in corral and still spawnable; it
just cannot be messaged.

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
