# 0002 — An MCP server is the agent seam

## Context

corral polls every configured environment and already holds, per Claude
session, the stable session UUID, a transcript-derived recap, and statusline
data (model, context-window usage, cost, rate-limit windows, account) — plus
the attention feed and the task ↔ session graph.

A Claude session running inside one of those panes can see none of it. It does
not know which pane it occupies, cannot read its own context-window usage
(the statusline is rendered outside the model's context), and cannot read the
task card it was spawned from — so an operator retypes the assignment into the
pane by hand. Cross-session triage means shelling out to the herdr CLI and
parsing its output ad hoc, re-deriving socket routing and re-fanning out over
SSH from inside a session, duplicating work corral has already done.

The original design spec deferred an MCP server while listing an "LLM agent
that plugs into the same API" as future work. Those are the same thing: a
session holding these tools *is* that agent.

## Decision

Expose corral's existing state and control surface to sessions through an MCP
server shipped in this repository, as a **stdio child process** of the Claude
process, speaking HTTP to the already-running corral server on loopback. It
holds no state of its own and never calls herdr directly.

Four decisions fix its shape:

1. **stdio transport, not an MCP HTTP transport mounted on the existing
   server.** A child process inherits the pane's environment, so "which session
   am I" is a lookup rather than a heuristic.
2. **The MCP process is the token firewall.** It fetches full payloads over
   loopback for free and returns bounded digests; only the digest reaches the
   model's context.
3. **Phase one has no path to write into another session's pane.** Cross-session
   injection, and the audit log it requires, arrive together in a later phase or
   not at all.
4. **Identity hints from the caller are hints.** The caller passes its pane id,
   working directory, and socket path; the server resolves them against the
   poller snapshot and the trusted startup config. The socket value is used only
   to disambiguate *which configured environment* the caller sits in, never to
   route a call — routing always keys on the resolved id from that config.

Two things are deliberately absent. There is **no acknowledge operation for the
attention feed**: attention records are derived, cleared automatically when a
session resumes work or its pane disappears, so an ack would introduce state
that fights the existing auto-clear. And the mechanism for delivering an initial
prompt to a spawned session is **not recorded here**, because it rests on an
assumption about launch behaviour that implementation must verify first; an ADR
is immutable, so it should not encode an unverified premise.

## Rationale

- Identity is the unlock. Without it the tools reduce to a thinner wrapper over
  a CLI the agent could already call; with it, a session can read its own
  assignment, notice its own context pressure, and hand off deliberately.
- Resolving identity server-side keeps the trusted-configuration invariant
  intact. Environments come from a startup file at the same trust level as
  source code; a forged hint can at worst fail to resolve, never widen reach.
- Withholding the pane-write surface makes the first increment reviewable on its
  own: with no injection path there is no injection audit obligation, no
  agent-to-agent message loop to bound, and a much smaller blast radius while
  the seam proves itself.
- Bounded digests are not merely an efficiency concern. An unbounded snapshot
  crowds out the session's actual work, and a summary the server can cap is
  cheaper to reason about than one the model must skim.

## Rejected alternatives

- **MCP HTTP transport inside the existing server.** No extra process and direct
  access to in-memory state, but it cannot identify its caller: identity would
  have to be smuggled through per-session header substitution, which is fragile
  and dependent on harness behaviour. Identity was the point.
- **An MCP server calling herdr directly, bypassing corral.** Works without the
  corral server running, but discards every enrichment corral maintains —
  session UUIDs, recaps, statusline data, attention state, card bindings — which
  is most of the value.
- **A thin CLI instead of MCP.** The earlier design spec's stopgap. Every
  invocation re-pays process startup and returns text a model must re-parse,
  and hard-won operational rules stay prose an agent may skip rather than
  branches in code.
- **Shipping cross-session read and write in the first increment.** Highest
  immediate utility, but it front-loads the injection-loop and untrusted-output
  surfaces into the change that also introduces the seam itself.
