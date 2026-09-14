# 8. The restore freeze is scoped to records, not environments

## Context

Killing the herdr server kills every pane, so corral keeps a mirror of the live fleet and can bulk-
resume it (§18). The mirror has two write policies. A steady `reachable → reachable` poll
**replaces** an environment's record set, which is what drops sessions the operator closed. An
environment back after a gap, or observed for the first time by this process, is **merged**,
dropping nothing, so a fleet that has not come back yet is not mistaken for a fleet that was closed.

What selects between the two policies was one flag per environment, set when records were missing
on return and cleared only when **every** one of them was observed live again. A session the
operator deliberately closes is never observed live again. One such session holds the flag
permanently, the environment never returns to replacing, and from then on every close is invisible
to the mirror: the set only grows, and each restore resurrects all of it. Nothing bounds how long
that lasts.

A permanently merging environment also cannot be emptied by a bad listing — a partial listing or a
transport hiccup that reaches the mirror as a successful poll. Any rule that lets the environment
replace again has to provide that protection on its own.

## Decision

**The freeze is a property of records, not of environments.** The mirror holds the identities that
are awaiting restore — those missing when the environment came back — and keeps each one until it is
observed live again, however long the restore takes. A record that is not among them follows the
replacing policy even while others are still pending, so a session that returned, ran, and was then
closed is dropped like any other.

A replaced record leaves the mirror only after being absent from **two consecutive polls of its own
environment**. A single bad listing can no longer empty a mirror. This does not cover a herdr restart
that loses its state and completes between two polls: those sessions are still absent on the next
poll, and that remains a residual risk of §18.

The first observation by a process, and an environment returning after a gap, keep merging and keep
pinning everything missing. corral may restart while herdr is down, and that is what stops the mirror
being wiped when it does. A session closed while its environment could not be observed is pinned
with the rest; corral cannot tell that close from a crash.

**The persisted file changes additively, and both directions must keep reading it.** corral moves a
mirror it cannot parse aside and starts empty — right for corruption and catastrophic for a format
change, because an operator most often upgrades or rolls back while recovering. Neither an upgrade
nor a rollback may reach that path.

This decision is about which records the mirror protects, not what it is told. After a restart that
leaves herdr's own persisted state intact, panes are dormant until something opens them, and corral
reads a dormant pane as a running session. That is a separate decision.

## Rationale

Both write policies already exist. What this decision changes is only what selects between them: a
flag describing a whole environment, or the identities of the records themselves.

A boolean cannot express what the mirror needs to know. "Something here is unfinished" and "this
particular session is unfinished" are different facts, and only the second can be retired: it
retires when that session comes back. Collapsing them into one flag made the retirement condition
depend on sessions that will never come back, which is why the freeze had no exit. Keeping the
identities is not extra state — it is the state the flag already implied, made addressable, and it
lets a report say how many records are held rather than that something is.

Making the freeze per-record also removes the reason the flag was dangerous to clear. A force-clear
switch asks the operator to decide, under time pressure and with no way to check, whether the
sessions still held are ones they closed or ones that have not come back. The per-record rule answers
that from what corral already observed.

Two consecutive misses rather than one is a deliberate asymmetry. Dropping a record that should have
been kept costs a session that cannot be bulk-restored. Keeping a record one poll longer than
necessary costs at most a closed session resumed by a restore run inside that one poll. Where the two
errors are that unequal, the rule should fail toward keeping. Counting polls of the environment
itself, rather than any update that carries its last listing, is what makes the second miss a second
observation.

The additive file change is load-bearing for the same reason. The failure it avoids is not a parse
error on an unusual day; it is an empty mirror on the specific day the mirror is the only record of
what was running.

## Rejected alternatives

**Marking the session at the moment corral closes it.** corral knows when a close it initiates is
deliberate, so it could record that. It covers only closes corral initiates — a session ended inside
its own pane is indistinguishable to corral from a crash — and it races the poller, since a close
whose kill is deferred leaves the session live in the next observation, which puts the record
straight back. Making that safe needs a timed tombstone, which is more machinery than the rule it was
meant to avoid, for a subset of the cases the rule already covers.

**A force-clear switch.** It moves an unanswerable question to the operator at the worst moment (see
Rationale). What remains is a documented recovery — stop corral, delete the mirror, start it — which
is honest about discarding everything not currently live, and is the remedy for a mirror that already
holds closed sessions.

**Detecting a herdr restart by watching its identifiers change.** It would also close the
unobserved-restart risk, but herdr persists its workspace and tab state and restores its counters from
it, so a restart with that state intact preserves every workspace, tab and pane identifier. There is
no change to detect.

**Taking liveness from Claude's own session registry rather than from herdr's listing.** Claude writes
a record per process carrying its own process identity, which would be a direct check where everything
else here is inference — and it invites the conclusion that reliable liveness removes the need for any
freeze at all. It does not. The mirror's question is not whether a session is running but whether it
was meant to stop, and the two cases it exists to separate — the operator closed it, the server was
killed — leave a dead process either way. A liveness signal cannot name the cause of an absence, so it
improves the input to this decision without replacing it.

**Prompting the operator in the UI when an environment's herdr returns.** A restore that must be typed
into a terminal is a real gap, but the prompt needs a reliable "herdr restarted" signal, and corral
does not have one; the identifier test above was the candidate and it cannot work.
