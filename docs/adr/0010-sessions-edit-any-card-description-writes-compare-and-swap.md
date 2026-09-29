# 10. Sessions edit any card; description writes are compare-and-swap

## Context

The MCP tools let a session change only the card it is bound to; on any other card it could add — a
log entry, a new card, an executor — but never modify. The reason was that a card's `description` is
a full-replacement field with no concurrency check: two sessions rewriting one description silently
destroy each other's work, and "only your own card" kept the writers to one.

That rule does not survive an orchestrating session. A session coordinating several cards needs to
state the task on the cards it coordinates, and the only way to do that was to bind to each in turn.
Its missing reach also turned mistakes silent: the MCP SDK drops arguments a tool schema does not
declare, so a `{boardId, taskId}` passed to the update tool vanished and the write landed on the
caller's own card, overwriting it.

## Decision

- A session may modify the title, status, priority and description of **any** card, addressed by
  `{boardId, taskId}`.
- A description write from a session is **compare-and-swap**: it names the revision it read, and the
  server refuses it if the stored text — or the card's address — has changed since. A read that
  showed the description truncated yields no revision, so a partial view cannot back a rewrite.
- Title, status and priority stay last-write-wins, on other cards too.
- A session may not move **another** card into a closing column.
- Close rights are unchanged: they follow card membership only. A session can alter its own
  membership, so membership alone would be self-granting.
- Every tool rejects an argument its schema does not declare.

The web UI's description save stays last-write-wins, and so do sessions whose MCP process predates
this change until they restart.

## Rationale

The own-card rule protected one property: two writers never silently lose each other's text.
Compare-and-swap protects the same property without limiting who may write, which is what the
orchestrating session needs. The revision covers the card's address as well as its text, so a
revision read from one card cannot validate a write to another, and empty cards do not share one.

Title, status and priority are single values with nothing to merge; guarding them would add refusals
without saving any work. Moving another card into a closing column is the exception because closing
ends a card that other sessions may be working on, and deciding that is the operator's call.

A server that predates the guarded write path must refuse before writing, not after: a check made
after the write has already lost the text it exists to protect.

## Rejected alternatives

- **Keep the own-card rule and only reject unknown arguments.** Fixes the silent mis-write, leaves
  the orchestrating session unable to state a task on the cards it coordinates.
- **Allow cross-card writes without a guard.** Reintroduces the lost-update the own-card rule
  existed to prevent, now across every card on the machine.
- **Allow cross-card writes only on cards with no session.** Covers a freshly created card and
  nothing else; the guard is needed anyway the moment a session joins.
- **A revision over the text alone.** Every empty card would share one revision, and a revision read
  from one card would validate a write to another.
