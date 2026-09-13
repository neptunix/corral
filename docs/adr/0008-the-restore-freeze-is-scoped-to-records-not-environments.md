# 8. The restore freeze is scoped to records, not environments

## Context

Killing the herdr server kills every pane, so corral keeps a mirror of the live fleet and can bulk-
resume it (§18). The mirror has two write policies, and one flag chooses between them: a steady
`reachable → reachable` poll **replaces** the environment's record set, which is what drops sessions
the operator closed; anything else — an environment back after a gap, the first observation of a
process, or a `pendingRestore` already set — **merges**, dropping nothing, so a fleet that has not
come back yet is not mistaken for a fleet that was closed.

`pendingRestore` is one boolean per environment, and it clears only when **every** previously
mirrored record for that environment is observed live again. A session the operator deliberately
closes is never observed live again. So a single such session pins the flag permanently, the
environment never returns to the replacing policy, and from that moment **every** close is invisible
to the mirror. The set only grows, and each restore resurrects all of it.

This was shipped knowingly: §18 lists "Pending-window resurrection" among its residual risks, with
"there is no force-clear switch yet — hand-edit the mirror file if needed". The window was expected
to be short. In practice it is not bounded by anything: on one environment it stayed open for ten
days across an operator's ordinary work, and a restore then resumed 82 sessions from a mirror of 84,
some thirty to forty of which had been closed by hand, one at a time, while herdr was healthy
throughout.

The flag also does work nobody designed it for. Because a pinned environment never replaces its set,
it cannot be emptied by a single bad observation — and a herdr restart that completes between two
polls is exactly that: the environment never appears unreachable, the listing succeeds, and a
replacing policy would overwrite the mirror with whatever that one poll returned. Removing the
permanent freeze removes that accidental protection along with it.

## Decision

**The freeze is a property of records, not of environments.** The mirror holds the identities that
are actually awaiting restore — those missing when the environment came back — and protects those.
A record that is not among them follows the ordinary replacing policy even while others are still
pending, so a session that returned, ran, and was then closed is dropped like any other.

A record leaves the mirror only after being absent from **two consecutive observations** of a
reachable environment. One anomalous poll — a restart between ticks, a partial listing, a transport
hiccup — can no longer empty a mirror, which is the protection the permanent freeze was providing by
accident. The cost is that a closed session lingers for one further poll, which changes nothing:
restore skips whatever is already alive.

The first observation of a process keeps merging and keeps pinning everything missing. corral may
restart while herdr is down, and that branch is what stops the mirror being wiped when it does.

**The persisted file changes additively, and both directions must keep reading it.** corral moves a
mirror it cannot parse aside and starts empty — behaviour that is right for corruption and
catastrophic for a format change, because the moment an operator upgrades is most often the moment
they are recovering. Neither an upgrade nor a rollback may reach that path.

This decision is about which records the mirror protects. It does not address what the mirror is
told: after a restart that leaves herdr's own persisted state intact, panes are dormant until
something opens them, and corral reads a dormant pane as a running session. That is a separate
decision and its measurements are not in.

## Rationale

Both write policies already exist and neither is being added here. What this decision changes is only what selects between them: a flag describing a whole environment, or the identities of the records themselves.

A boolean cannot express what the mirror needs to know. "Something here is unfinished" and "this
particular session is unfinished" are different facts, and only the second one can be retired: it
retires when that session comes back. Collapsing them into one flag made the retirement condition
depend on sessions that will never come back, which is why the freeze had no exit. Keeping the
identities is not extra state — it is the state that was already implied, made addressable, and it
is what lets a report say how many records are held rather than that something is.

Making the freeze per-record also removes the reason the flag was dangerous to clear. A force-clear
switch was the obvious remedy and it is the wrong one: it asks the operator to decide, under time
pressure and with no way to check, whether the sessions still held are ones they closed or ones that
have not come back. The per-record rule answers that from what corral already observed.

Two consecutive misses rather than one is a deliberate asymmetry. Dropping a record that should have
been kept costs a session that cannot be bulk-restored; keeping a record one poll longer than
necessary costs nothing at all, because restore skips live sessions anyway. Where the two errors are
that unequal, the rule should fail toward keeping.

The additive file change is load-bearing for the same reason. The failure it avoids is not a parse
error on an unusual day; it is an empty mirror on the specific day the mirror is the only record of
what was running.

## Rejected alternatives

**Marking the session at the moment corral closes it.** The intuitive fix, and the one the operator
proposed: corral knows exactly when a close is deliberate, so record it. It covers only closes corral
initiates — a session ended inside its own pane is indistinguishable to corral from a crash — and it
races the poller, since a close whose kill is deferred leaves the session live in the next
observation, which puts the record straight back. Making that safe needs a timed tombstone, which is
more machinery than the rule it was meant to avoid, for a subset of the cases the rule already
covers.

**A force-clear switch.** Rejected above: it moves an unanswerable question to the operator at the
worst moment. It survives in a documented recovery — stop corral, delete the mirror, start it — which
is honest about discarding everything not currently live, and is the remedy for a mirror already
poisoned by this bug.

**Detecting a herdr restart by watching its identifiers change.** Attractive because it would also
close the unobserved-restart risk, and false: herdr persists its workspace and tab state and restores
the counters from it, so a restart with that state intact preserves every identifier. Measured
directly — workspace, tab and pane identifiers were unchanged across a restart — after the code
comment that suggested otherwise was found to mean only that a stored identifier no longer names a
usable target.

**Taking liveness from Claude's own session registry rather than from herdr's listing.** Claude writes
a record per process carrying its own process identity, which would be a direct check where everything
else here is inference — and it invites the conclusion that reliable liveness removes the need for any
freeze at all. It does not. The mirror's question is not whether a session is running but whether it was
meant to stop, and the two cases it exists to separate — the operator closed it, the server was killed —
leave a dead process either way. A liveness signal cannot name the cause of an absence, so it improves
the input to this decision without replacing it. It is the strongest candidate for the dormant-pane
question named above, and whoever builds it there should know that a resumed session routinely leaves a
stale record beside its live one: liveness has to be resolved across every record for a session, never
the most recent.

**Prompting the operator in the UI when an environment's herdr returns.** A restore that must be
typed into a terminal is a real gap, but the prompt needs a reliable "herdr restarted" signal, and
that signal is precisely what corral does not have; the identifier test above was the candidate and
it failed. Deferred until the dormant-pane question above is settled, which is where that signal will
come from if it exists.
