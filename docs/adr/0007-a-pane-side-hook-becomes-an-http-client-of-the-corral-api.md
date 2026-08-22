# 7. A pane-side hook becomes an HTTP client of the corral API

## Context

An empty card is only visible to whoever reads the board, and nothing prompts a session to notice
its own card is blank before it ends. ADR 0002 made the MCP server the agent seam: every agent-facing
read of the corral server has gone through it, and a tool's response arrives only when a session
chooses to call that tool. A card-empty signal has to arrive independently of what the session
calls — on `UserPromptSubmit`, the same event the context-pressure hook already rides.

The context-pressure hook is not new as a second agent seam; it already reads corral-written state
outside the MCP boundary, from a file (`corral-status/<session_id>.json`). What is new here is
different: `corral-claude-hook.sh` making an HTTP request to corral's own API.

## Decision

The hook gains a second, independent signal, `card_signal`, alongside the existing `ctx_signal`.
On `UserPromptSubmit` it calls `GET /api/card-signal?paneId=&cwd=&socket=` — the same request shape
`/api/whoami` accepts, deliberately without an `env` parameter, since the pane does not know
corral's environment ids. The route resolves the caller the same way `/api/whoami` does and answers
`{ "empty": boolean }`: `true` only when the pane resolves to a bound card whose description is
blank; every other case — unresolvable pane, no card, a non-blank description — answers `false`,
deliberately conflated, since the hook has exactly two behaviours and a distinction it cannot act on
invites wrong handling.

The two signals share one script but no state: each has its own marker pair in `SKILL.md`
(`ctx-signal` / `card-signal`), and a session missing one skill installation still gets the other.
The client is narrow by construction — one read-only GET, a 1-second timeout, and no behaviour in
corral depends on the answer.

## Rationale

**Why HTTP and not the MCP seam.** A tool call happens when a session decides to make it; this
signal has to reach a session that never thought to ask. The alternative — teaching every session to
poll a tool for its own card state — reintroduces exactly the "remembers to check" failure mode the
signal exists to remove.

**Why the request carries no `env`.** The pane has no way to know corral's environment ids; asking
it to supply one would either be guesswork or a second lookup this signal does not need. Resolving
the caller by pane coordinates, the way `/api/whoami` already does, needs nothing else.

**Why `false` covers every non-empty case.** The hook can only do two things: stay silent, or print
one line. A response that distinguished "not bound" from "bound but not empty" from "board
unreadable" would just be discarded three different ways at the call site.

**Why no diagnostics check.** The signal's failure is harmless — nothing in corral depends on it —
and the health panel already hands its problems to spawned fix sessions, so a row that could never
clear itself would manufacture work over a nudge that simply did not fire. The existing
`corral-skill-installed` diagnostic already content-hashes `SKILL.md`, including both marker pairs.

## Rejected alternatives

- **Route the check through the MCP server.** Rejected for the reason above: a tool's answer only
  ever comes when the session asks, and this signal has to arrive without being asked for.
- **A single merged marker block for both signals.** Renaming `ctx-signal` into a combined block
  would silence the working context-pressure signal on every existing install until the skill file
  is reinstalled. Two independent pairs mean either can be added, or go missing, without touching
  the other.
- **A diagnostics check for the card-empty signal.** The server cannot observe a pane's shell, so it
  cannot tell "the signal is correctly silent because the card isn't empty" from "the signal is
  broken" — the same reasoning ADR 0006 applies to its own failure states.
