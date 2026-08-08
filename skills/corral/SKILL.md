---
name: corral
description: Use when this session runs under corral (the corral_* MCP tools exist) and the task is more than a single tool call — reading its own assignment, logging progress to its card, handing work to a fresh session before context runs out, or triaging other sessions. Triggers include "what am I working on", "which session am I", "bind me to a card", "update the card", "log progress", "what else is running", "who needs attention", "hand this off", "write a handoff", "spawn a continuation", "I'm running out of context", "close this session".
---

# corral

The corral MCP server supplies its own short orientation — what corral is, the vocabulary, and that
`corral_whoami` comes first — and each tool describes itself. This skill deliberately does not repeat
either. It covers what neither can: what the tools do *not* expose, the workflows that span several
of them, and how to hand work over without losing it.

## What the tools expose, and what they don't

- **Environments carry no board data.** An environment is a machine. A board is work. `corral_whoami`
  lists environments with only `id`, `label`, `kind`, `reachable` — no boards, no cards, no columns.
- **Column ids come only from the bound card**, as `task.columns`. An unbound session sees none, so
  `corral_task_update`'s `status` cannot be guessed before binding — and column ids are per board, not
  global.
- **`corral_whoami` shows the description as a preview, not the value.** One line, plus its line and
  character counts. `corral_task_read` is the full text. The counts are the useful part on a repeat
  call: unchanged counts mean the log has not moved since you last read it.
- **There is no "list all boards" tool.** `corral_task_bind` with no arguments is the only listing,
  and it hides cards in closed columns. A card you cannot see there cannot be bound to.
- **Metrics can be legitimately absent.** Right after a pane starts, `session id`, `model`, `ctx` and
  `cost` may all be `—` because herdr has not registered the agent yet; identity, cwd and the card are
  already correct. Call again later rather than reporting a broken session. If they are *still* empty
  minutes in, the herdr Claude integration is probably not installed on that machine — that is an
  operator fix, so report it instead of retrying, and know that context-pressure handoff cannot be
  judged from `ctx` on that machine.
- **`corral_fleet` is read-only in every sense.** It shows other sessions; it grants nothing over
  them. There is no way to send another session a message. Report what is stuck; let the operator act.

## Workflows

### Starting up

1. `corral_whoami`.
2. **Bound** → the card is the assignment. `corral_task_read` for its description — the running log of
   what earlier sessions on this card did. Start from it, not from zero.
3. **Unbound** → `corral_task_bind` with no arguments, then bind to the card this work belongs to. If
   nothing fits, say so and ask — the tools cannot create a card.

### Keeping the card current

Write at real boundaries — a decision made, a phase finished, a blocker hit — not on a timer and not
per file edited. Move `status` when the work actually changes state; the operator reads column
position before reading anything else.

`corral_task_update` replaces `description` wholesale. The practice that makes that safe:
`corral_task_read` in the same turn you write, and append around what it returned rather than
retyping the log from memory. `corral_whoami`'s preview is not enough to write back from — that is
what it means by PREVIEW. Note that `corral_task_read` indents each line with a `  | ` gutter of its
own; strip it before writing back, or the card grows four characters per line every handoff.

### Handing off before context runs out

Available, not obligatory — and never silent. `corral_whoami` reports this session's own context
usage, so you can notice pressure the operator cannot see and say so:

> Context is at 78%. I can write the card and hand off to a fresh session on it — want me to?

**Wait for the answer.** `corral_spawn` starts a real session that spends tokens and
`corral_session_close` ends this one; neither is yours to decide. If the operator has their own
handoff skill or file convention, use it to compose the text and let this procedure carry it.

Once they agree:

1. **Write the card first** — `corral_task_update`. Everything the next session needs that is not
   already in git: decisions and their reasons, what was ruled out, what is verified versus assumed.
2. **Compose the brief** (below) and `corral_spawn` it. The new session lands on the same card, in a
   tab beside this one, and starts from that text.
3. **Verify it arrived** — `corral_whoami` again; the new session appears in the card's session list.
   If the brief failed to deliver, the new session says so on its first turn.
4. **`corral_session_close` last, and only if asked.** Closing yourself ends this session mid-turn;
   anything not already on the card is gone. Leaving both sessions running is a valid outcome.

Wrong order loses exactly the context the handoff existed to carry.

### Triaging the fleet

`corral_fleet` answers questions about *other* sessions — a standup, or finding who is stuck.
`filter: "needs-attention"` is the useful default: blocked sessions plus recently finished ones.

## Writing a brief

The brief is the new session's entire starting context. It gets no transcript, no scrollback, and no
memory of this conversation — only these words plus whatever `corral_whoami` then tells it.

Write it for a competent stranger who has the repo but not the last hour:

- **The goal**, in one line, and how you will know it is met.
- **State** — what is done, what is in flight, what is committed versus only edited.
- **Knowledge the code does not show** — what you tried that failed, why an obvious approach is
  wrong, which assumption is load-bearing and unverified.
- **The next concrete action**, not a direction.
- **Hazards** — what not to touch, and why.

Point at files, commits, and card fields rather than pasting them. A brief that reads like a title
("continue the auth work") wastes the spawn.

## When something is wrong

- **No `corral_*` tools** — this session is not inside corral. Say so; do not improvise a substitute.
- **`[unreachable]`** — nothing answered at the address in the message. Usually the corral server is
  not running; possibly it is on a different port than this session was told. Operator's to fix:
  report the address and stop.
- **`[server_too_old]`** — the corral server predates these MCP routes. It needs restarting; only the
  operator can do that.
- **`[unresolved]`** — corral checked the machine and found no such pane. Retry once in case the pane
  was created this instant, then report it.
- **A write refused as unbound** — bind, then retry. Every write re-reads identity, so a bind from a
  moment ago is already visible.
