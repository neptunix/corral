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

Six decisions fix its shape:

1. **stdio transport, not an MCP HTTP transport mounted on the existing
   server.** A child process inherits the pane's environment, so "which session
   am I" is a lookup rather than a heuristic.
2. **The MCP process is the token firewall.** It fetches full payloads over
   loopback for free and returns bounded digests; only the digest reaches the
   model's context.
3. **Phase one has no path to write into another session's pane.** Cross-session
   injection, and the full audit log it requires, arrive together in a later
   phase or not at all. The one exception is the spawn brief: the sole
   agent-authored text that reaches a pane at all, and that pane is always
   brand-new, never an existing session's — so it needs no pane-write audit log,
   only a bounded trace of its own (coordinates and size, never contents).
4. **Identity hints from the caller are hints.** The caller passes its pane id,
   working directory, and socket path; the server resolves them against the
   poller snapshot and the trusted startup config. The socket value is used only
   to disambiguate *which configured environment* the caller sits in, never to
   route a call — routing always keys on the resolved id from that config.

   Identity must also resolve *immediately*, which the cached snapshot alone
   cannot do: the cheap poll runs every 30s, and the caller is by definition
   asking about a pane that exists right now — often one created seconds ago,
   since a spawned session is told to call `corral_whoami` before anything else.
   The route therefore re-polls the local environments once on a miss and
   re-resolves before answering. Bounded by construction: only on the miss path,
   at most once per request, and each environment's refresh shares that
   environment's existing poll guard, so it collapses into a tick already in
   flight rather than racing it.
5. **Brief delivery is file indirection, and that is now verified, not
   assumed.** The launch command reads the brief through the pane's own shell
   (`<spawnCommand> "$(cat <path>; rm -f <path>)"`) rather than embedding it in a
   command string, which is exactly what confines a brief to local environments —
   there is no host to `cat` a file on for a remote pane. This was verified
   empirically in a live herdr pane before relying on it: the probe session
   received the file's contents as its first message and stayed interactive,
   rather than running headless (`claude --help` documents `--print` as the flag
   for a headless run; this path does not pass it). The `rm` sits inside the same
   substitution deliberately: `herdr pane run` returns once the command reaches
   the pty, not once the shell has run it, so deletion has to be *caused* by the
   read rather than scheduled near it — a timer short enough to bound disk is
   also short enough to lose against a slow shell startup and hand the new
   session an empty brief while the spawn reported success. The server-side
   unlink remains only as a backstop for a pane that never ran the command.
6. **Close and rebind are tool-thin policy over state the board already owns,
   not new MCP-side authorization.** `corral_session_close` accepts any target
   attached to the caller's bound card — card membership the board already
   persists, so the right survives an MCP restart with no process-local
   allowlist; off-card close stays phase 2, and close is suspend (the link
   stays, `--resume` restores), not destroy. Self-close passes the close
   route's `?deferred=1` so the tool's response leaves before its own pane
   dies; every other close stays synchronous so a failure surfaces to the
   caller. `corral_task_bind`'s rebind refusal leans on the same existing
   state: the attach endpoint claim-checks only within the target task, by the
   dashboard's own design — adequate for a single-operator tool, and any race
   resolves visibly on the board rather than behind new locking. `corral_spawn`
   and `corral_session_close` also still pass through the operator's harness
   permission prompt, which is Phase 1's authorization for a destructive call,
   not a mechanism this ADR introduces.

One thing is deliberately absent: there is **no acknowledge operation for the
attention feed**. Attention records are derived, cleared automatically when a
session resumes work or its pane disappears, so an ack would introduce state
that fights the existing auto-clear.

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
  and dependent on harness behavior. Identity was the point.
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
