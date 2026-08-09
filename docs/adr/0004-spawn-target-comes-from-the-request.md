# 4. The spawn target comes from the request, and a workspace is a repository

## Context

A card carried a `repo` field from the first design, where it was a spawn default:
"if the task's `repo` matches an existing workspace, add a tab there, else create the
workspace." Its sibling `defaultEnv` was removed from the schema; `repo` was not.

Since then the field lost every client. Task creation sends title and status only; the
edit modal's free-text Repo input was removed and the field is excluded from its save
patch; the `from-session` route accepts it but no client sends it; and the spawn route
never writes the chosen repo back to the card. The HTTP API still accepts and persists
it — three request schemas feeding three writes — so the field is live server-side and
dead client-side, and every card created through the UI has `repo: null`.

The UI does not notice, because target selection moved into the request: its picker
sends either an existing workspace id (join) or a repository name to create a new space
from, and the spawn route prefers the request over the card.

`corral_spawn` never got the equivalent parameter. A same-environment spawn joins the
caller's own workspace and needs no path, so the gap stayed invisible until the first
cross-environment handoff, which takes the create branch, finds `task.repo` null, and
fails with `no path configured for repo ""`.

Underneath the field is a modelling error. A herdr session is a machine and a Claude
profile; a workspace is a repository; a tab is one session, i.e. one piece of work. A
card cuts *across* that hierarchy — the sessions on one card may sit in several
workspaces, hence several repositories. A card therefore cannot own a repository.

## Decision

1. **`corral_spawn` takes an optional `repo`.** Omitted means "continue where I am":
   land beside the caller, inheriting the surrounding directory, so a worktree checkout
   stays visible. Given, it means "work in project X".

2. **The target workspace field carries three states, and the route reads all three.**
   A workspace id joins it; an explicit `null` creates a new space at the repository's
   configured path; an absent key together with `repo` resolves that repository to its
   workspace, joining an existing one or creating it. An absent key with no `repo` is no
   target at all and is refused.

   The route's schema already parses an omitted field and an explicit `null` into
   different values and then discards the difference; keeping it is what makes this
   rule expressible. An earlier draft asserted the opposite — that the route could not
   tell them apart — and moved the precedence into the MCP tool to compensate. That was
   simply wrong about the code, and two review rounds reasoned from it.

   Keeping "create a new space" as something a client *states* rather than something
   inferred from a missing field is the point: the browser keeps its existing meaning
   untouched, and only the new absent-key shape carries the resolve-by-repository
   behaviour. The price is a contract that distinguishes an absent key from a null one,
   which is easy to break silently — so it is documented at the schema and all three
   shapes are tested.

   The tool still omits the target id whenever it passes `repo`, and still decides the
   no-target refusal itself, because only it knows whether the caller has a workspace to
   continue in.

3. **`repo` resolves to the workspace of that repository.** The configured-path lookup
   runs first, on both branches; only then is a workspace with that label sought
   (case-insensitively) and joined, or created if absent. **When `repo` is given**, the
   tab's directory comes from the configured path, never from the neighbouring panes;
   when it is omitted the directory still comes from the neighbours, which is what makes
   "continue where I am" keep a worktree visible. The name selects the workspace; the
   configuration selects the directory. A workspace renamed by hand can group a session
   oddly — it cannot place a newly created tab anywhere but the repository root.

   The rule governs tabs this design creates. On the idempotent rejoin no tab is created
   at all: an already-running session is adopted and keeps its own directory. The spawn
   reply says which case happened, so the caller is never told a session was started when
   an existing one was adopted.

4. **A missing or unknown target is refused, never inferred, and the refusal lists the
   valid names** for that environment. Both cases refuse: no target at all, and a name
   that is not configured. The refusal reaches the caller as a returned value from the
   MCP tool rather than a thrown server error — including the unknown-name case, which
   the route rejects under a **dedicated error code of its own** so the tool can
   re-render that case and no other. The refusal is built by the digest module beside the
   existing column-id refusal, and the names are read, only on that path, from the
   spawn-target route the browser's picker already uses.

5. **`Task.repo` is removed** from the schema, the three request schemas, their writes,
   and the resume path that used it as a workspace-label fallback.

## Rationale

Point 3 is the load-bearing one. Splitting "which workspace" from "which directory"
across two sources — a client-supplied name and trusted configuration — is what makes
joining an existing space safe. Every earlier attempt to reconcile the two in one value
produced a silent mislanding: a session handed off from a worktree would land in the
main checkout, carrying a brief that describes the worktree's work.

Point 2 earns its complexity twice. Without the tool omitting the target id, a
same-environment spawn carrying `repo` lands beside the caller with the parameter
silently discarded — the single most likely use of the new parameter, silently broken.
And without the third state, "create a new space" has to be inferred from a missing
field, which is what forced an earlier draft to change the browser's meaning to make room
for the agent's. Reading the state the client actually sent costs one line and leaves both
clients saying what they mean.

The lesson worth keeping: that draft was not wrong because the reasoning was sloppy, but
because a claim about the code was never checked against the code. It then survived two
review rounds, each of which built on it.

Point 4 keeps discovery free. A refusal is needed regardless, because a mistyped name
must produce a usable answer; making it carry the valid names means nothing is paid
until something goes wrong. Returning it from the tool rather than throwing it matters
concretely: thrown errors are collapsed and truncated on the way out, so an appended
list is exactly what gets cut, and a server-side refusal would also surface in the
browser, where a message naming an agent-only concept is noise. This is why the
unknown-name case cannot simply be left to the route: the route is where the name is
resolved, but its error would be the truncated kind, so the tool has to catch it and
render the listing itself.

Point 5 follows from the model rather than from disuse. "Nobody writes it" would justify
deleting the field; "a card spans several repositories" is why it should never have
existed.

## Rejected alternatives

**Backfill the card's `repo`.** Revives a field with no writer, and the next card breaks
the same way. Treats the symptom.

**Infer the target from the caller's workspace label.** An exact key lookup proves the
resolved path is trusted, not that it is the caller's path. Where a workspace id fails to
resolve the label is a placeholder that matches nothing, so the inference does not even
cover the case that motivated it.

**Always create a new workspace when `repo` is given.** Loses the idempotent rejoin of a
timed-out spawn and accumulates duplicate same-named spaces, breaking the one-workspace-
per-repository convention this record is built on.

**A catalog tool listing every environment's repositories.** An extra tool costs its
description in every session's context, including sessions that never spawn, and needs a
rule for environments that cannot be spawned into, plus documentation updates. It would
sit *on top of* the refusal, which is required anyway. The server surface is *not* part
of the cost — the route the browser's picker uses already exposes the names, and the
refusal path reads them from it. What is being declined is the standing per-session
description, not the endpoint. Worth revisiting only if agents are seen choosing among
projects rather than naming one they already know.

**Listing repository names in `corral_whoami`.** The catalog is a cross-product of
environments and repositories that grows with every machine, charged to the one call
every session repeats. This is the trade the card-description preview already rejected.
