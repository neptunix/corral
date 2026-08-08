---
name: corral
description: Use when this session runs under corral (the corral_* MCP tools exist) and the task is more than a single tool call — reading its own assignment, logging progress to its card, handing work to a fresh session before context runs out, or triaging other sessions. Triggers include "what am I working on", "which session am I", "bind me to a card", "update the card", "log progress", "what else is running", "who needs attention", "hand this off", "write a handoff", "spawn a continuation", "I'm running out of context", "close this session".
---

# corral

## What the tools do not expose

- **Environments carry no board data.** An environment is a machine; a board is work. `corral_whoami`
  lists environments as `id`, `label`, `kind`, `reachable` — no boards, no cards, no columns.
- **Column ids exist only on the bound card.** An unbound session sees none, and they are per board,
  not global — so a status value cannot be guessed before binding.
- **There is no "list all boards" tool.** `corral_task_bind` with no arguments is the only listing,
  and it hides cards in closed columns. A card you cannot see there cannot be bound to.
- **`corral_whoami`'s description counts are a heuristic, not proof.** An edit that preserves both the
  length and the line count is invisible in the preview, and the write path has no concurrency check.
  Use the counts to skip a redundant re-read; never to license a full-replacement write.
- **Missing metrics are usually not a broken session.** Right after a pane starts, `session id`,
  `model`, `ctx` and `cost` may all be `—` while identity, cwd and the card are already correct — call
  again later. Still empty minutes in means the herdr Claude integration is not installed on that
  machine: report it instead of retrying, and know that `ctx` cannot be used to judge context pressure
  there.
- **`corral_fleet` grants nothing over the sessions it shows.** There is no way to send another
  session a message. Report what is stuck; let the operator act.

## Starting up

1. `corral_whoami`.
2. **Bound** → the card is the assignment. `corral_task_read` for its description: the running log of
   what earlier sessions on this card did. Start from it, not from zero.
3. **Unbound** → `corral_task_bind` with no arguments, then bind to the card this work belongs to. If
   nothing fits, say so and ask — the tools cannot create a card.

## Keeping the card current

Write at real boundaries — a decision made, a phase finished, a blocker hit — not on a timer and not
per file edited. Move `status` when the work actually changes state; the operator reads column
position before reading anything else.

`corral_task_read` in the same turn you write, and edit around what it returned rather than retyping
the log from memory.

## Handing off before context runs out

Available, not obligatory — and never silent. `corral_whoami` reports this session's own context
usage, so you can notice pressure the operator cannot see and say so:

> Context is at 78%. I can write the card and hand off to a fresh session on it — want me to?

**Wait for the answer.** If the operator has their own handoff skill or file convention, use it to
compose the text and let this procedure carry it. Once they agree:

1. **Write the card first** — everything the next session needs that is not already in git: decisions
   and their reasons, what was ruled out, what is verified versus assumed.
2. **Compose the brief** (below) and `corral_spawn` it. The new session lands on the same card, in a
   tab beside this one, and starts from that text.
3. **Verify it arrived** — `corral_whoami` again; the new session appears in the card's session list.
   If the brief failed to deliver, the new session says so on its first turn.
4. **`corral_session_close` last, and only if asked.** Leaving both sessions running is a valid
   outcome.

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
  not running; possibly it is on a different port than this session was told. Report the address and
  stop; it is the operator's to fix.
- **`[server_too_old]`** — the corral server predates these MCP routes. It needs restarting, which
  only the operator can do.
- **`[bad_response]`** — corral answered with something these tools could not parse. Report it
  verbatim; retrying will not help.
- **`[unresolved]`** — corral checked the machine and found no such pane. Retry once in case the pane
  was created this instant, then report it.
- **A write refused as unbound** — bind, then retry. Every write re-reads identity, so a bind from a
  moment ago is already visible.
