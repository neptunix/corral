# 5. The recap reads a ladder, and corral translates focus

## Context

corral shows one line per session answering "what is this session doing". It came from exactly one
transcript record: `{"type":"system","subtype":"away_summary"}`. Reading the shipped Claude Code binary
establishes when that record is written — every gate must hold at once:

| Gate | Value |
|---|---|
| Terminal focus state | `blurred` |
| Since the last turn ended | ≥180 s (remote-config constant; matches the measured 185 s median) |
| Real user messages in the session | ≥3 |
| New user messages since the previous summary | ≥2 |
| A turn running | no |
| Recaps enabled (`/config` → "Session recap") | yes (the default) |

Two consequences dominate everything below:

- **The focus state starts at `unknown` and is set ONLY by terminal focus-report escape sequences**
  (`\x1B[?1004h`, CSI I, CSI O). `unknown` is not `blurred`. A pane nothing ever focused can never reach
  `blurred`, so it can never produce a recap — however long the session runs.
- **`/recap` writes no such record.** It returns text into the session and lands as a
  `system/local_command`, so a manual recap is invisible to corral.

A real record's `content` is never blank (measured 200–349 characters), so an empty recap always meant
*the record is absent*, never *the record is empty*.

A focus probe (enable DECSET 1004, dump raw stdin, switch away, return) reported **no focus events at
all** — neither in a bare host-terminal window nor inside a herdr pane. Switching panes *within* herdr
is internal to herdr: the host terminal never loses focus and reports nothing. So the only producer of
focus-out for a Claude pane on that machine is herdr itself, driven by a tab switch — and the operator's
move from switching herdr tabs to watching the corral board removed the last producer. **corral
de-energized its own recap source.**

Measured across every local Claude config directory:

| Measurement | Value |
|---|---|
| Transcripts carrying an `away_summary` | 60 of 1142 (5.3%) |
| Last `away_summary` anywhere | 2026-07-31 |
| August sessions with one | 0 of ~645 (≈11 expected under the pooled rate, p ≈ 2e-5) |
| Transcripts with exactly one record | 32 of 60 |

Not a CLI-version effect: the same version emitted in July and not in August. And nothing in the UI
distinguished "no recap yet" from "the read is failing", which is how this hid for a month.

Coverage of candidate records inside the tail corral **already** reads, over 1004 transcripts modified
in the preceding 30 days:

| Record | Coverage | What it says |
|---|---|---|
| `system/away_summary` | 1.7% | what the session is doing and what is next — Claude on its own work |
| `ai-title` | 23% | the topic Claude generated for the session |
| `last-prompt` | 100% | what the operator asked for — not what came of it |
| `custom-title` / `agent-name` | 19% | the session's name |

## Decision

**1. `readRecap` climbs a ladder, by priority and not by file position.** `away_summary` → `ai-title` →
`last-prompt`; the last record of the first rung yielding a non-blank string wins. Claude rewrites
`last-prompt` on every turn, so it is all but always the last candidate present — ordering by recency
would bury every `away_summary` that exists. A rung whose payload is missing, non-string or blank is not
a dead end; the ladder keeps descending. This fills the line for 994 of 1004 sessions (99%).

`custom-title` / `agent-name` are NOT rungs: they hold the session name, which corral already renders as
the tab label and in the statusline. `ai-title` and `custom-title` were never equal in any of the 59
transcripts carrying both, so the topic adds information rather than echoing the label.

**2. The source travels with the text.** `recapSource` (`away-summary` | `ai-title` | `last-prompt` |
null) rides beside `recap` in `SessionRow` and `LiveSessionData`, and is cached with it — so a failed
read that keeps the last good recap keeps the label describing it. `recapStatus` stays what it was: the
health of the read. The web prints one muted word (`recap` / `topic` / `prompt`); the MCP fleet row
prints the same vocabulary. All three rungs are labelled, the best one included.

**3. corral translates focus so the real summary can exist again.** `herdr tab focus <tab>` makes herdr
deliver genuine CSI I / CSI O to the pane — confirmed with a herdr client attached, and, via a temporary
headless server with no client at all, without one. Focus is server state. Nothing is written into the
pane, so this is a control command of the same class as `tab rename` / `tab close` that corral already
issues.

Two properties shape the mechanism: herdr focuses exactly **one** tab at a time, so focusing X blurs
everything else at once; and `blurred` is **sticky**, so focus needs no maintaining — each pane needs one
focus-in/focus-out cycle, ever.

Opening a session's web terminal focuses that session's tab; closing it focuses back the tab the operator
had. The pane completes the cycle and is `blurred`; the operator's view ends exactly where it started.
Calls are fire-and-forget and best-effort — the terminal never waits on herdr, and a failure is logged,
not surfaced.

**The saved tab and the operation chain are per ENVIRONMENT, not per pane**, because herdr's focus is a
single slot per server. Keeping them per pane was wrong in both directions: a second attach on the same
pane overwrote the saved tab with the pane's own, and two attaches on different panes each restored what
*they* displaced — so the first close yanked focus off a terminal still open, and the last landed on a tab
nobody was watching. Either way the operator's real tab was lost and a pane was left focused. So corral
remembers the operator's tab when an environment's attach count goes 0→1 and restores it when the count
returns to 0. Serialization per environment also keeps a fast open→close from restoring *before* the focus
it undoes.

`tab create` passes its focus flag **explicitly** instead of relying on herdr's undocumented default, so a
spawned pane cannot be stranded in `unknown`. Unlike the attach path this one moves the operator's view
and does **not** restore it — including on a spawn another Claude session requested over MCP. That is
forced by the mechanism, not an oversight: at create time the pane holds a shell, and a focus-out
delivered immediately would reach the shell and be discarded, leaving the Claude that starts moments later
back at `unknown`. The tab must KEEP focus until a later focus event blurs it, and that event is what puts
Claude in `blurred`.

`FOCUS_TRANSLATION_ENABLED=false` leaves herdr's focus strictly alone.

**4. The line states its reason instead of going blank, and never shifts the layout.** Both header rows
render unconditionally; an empty recap prints why (`transcript not found`, `recap read failed`, `no
Claude session on this pane`, `no recap yet`, `recap not read yet`). `LiveSessionData` carried neither
`recapStatus` nor `recapSource` before this, so for a board-linked session the web could not tell
"nothing to show" from "the read is broken". The metrics row above used to appear only once the first
statusline capture landed, inserting a row and shoving the terminal down on every open.

## Rationale

The ladder and the focus translation are not alternatives; they fix different halves.

Focus translation restores a *real* summary only where the §Context gates hold. It cannot help a session
with fewer than 3 operator messages (an autonomous session handed one brief never qualifies, however
long it works), a session that is currently working (the ≥180 s idle gate needs quiet), or the first
three minutes after the terminal closes. The ladder is therefore the floor: it covers the autonomous,
the busy and the never-opened, and depends on neither herdr nor focus nor the operator's habits. Focus
translation raises quality where a conversation happened; the ladder guarantees the line is never blank.

Labelling every rung, rather than only the fallbacks, follows from who reads the fleet row: a triaging
Claude session. An unlabelled quote must be *remembered* as a real summary, and a reader that forgets
takes the operator's own prompt for the session's report on its own work.

Focus moves only where an action of the operator's or an agent's already does — opening a terminal,
spawning a session — never on a background sweep, because corral cannot tell whether a herdr client is
watching (the socket snapshot reports no client count) and a periodic yank of the view would be
indistinguishable from a bug.

**The top rung's own health is counted, not assumed.** The ladder fills the recap line for nearly every
session, which means it also masks whether `away_summary` still arrives at all: focus translation could
stop working entirely and every line would still read fine. So the sweep counts recaps by source and logs
the summary whenever the away-summary count crosses zero in either direction. Without that, this PR would
have removed the only symptom by which the original month-long silence became visible — and the evidence
for the causal story is mechanism-level (herdr delivers the escape sequences, verified) rather than
outcome-level (a record observed after a corral-driven cycle, not yet observed). If the causal story is
wrong, the counter is what says so.

The principle behind all of it: do not build observability on a signal produced by the user's attention
when the product's whole purpose is to spare the user that attention.

## Rejected alternatives

- **Writing focus-report bytes into the pane.** corral holds a real pty while the terminal is attached,
  so it could inject CSI O directly. Rejected: writing into another agent's pane is exactly what
  ADR-0002 closes off, and `herdr tab focus` reaches the same state through a supported control command.
- **A background focus sweep to keep the fleet blurred.** Unnecessary — `blurred` is sticky, one cycle
  per pane suffices — and it would move the operator's view with no action of theirs to explain it.
- **`custom-title` / `agent-name` as ladder rungs.** They carry the session name corral already shows
  twice; the rung would echo the tab label back as if it were news.
- **Folding provenance into `recapStatus`.** It would make `ok` mean both "the read succeeded" and "this
  is a real summary", and the status exists precisely to keep read health separate from content.
- **Storing recap history.** No material: 32 of the 60 transcripts that ever produced a record produced
  exactly one.
- **Scanning older records on a rung whose newest payload is blank.** Measured over 1034 transcripts: the
  newest record was blank only on `last-prompt` (10 files) — the bottom rung, with nothing to demote to —
  and in none of them did an older usable record on the same rung exist. The extra scan would change no
  outcome that has ever occurred.
- **Restoring focus right after `tab create`.** It would look symmetric with the attach path and would
  silently break the prime: the focus-out would land on the pane's shell before Claude starts.
- **Leaving `tab create` on herdr's default.** The default is undocumented, and the cost of it being
  `--no-focus` is a session that can never write a recap at all — a silent, permanent loss.
