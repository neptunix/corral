# 3. Reap identity is anchored on the pane, verified against a live pane list

## Context

The zombie reaper closes the herdr tab a corral session left behind when its Claude
exited. It decided what to close from two different sources: a link was a reap
candidate when its stored **tab** id still appeared in `herdr tab list`, but the
close it then issued was `herdr pane close <paneId>` — a **pane**. Nothing verified
that the stored pane still existed, or that it still belonged to the stored tab.

A tab can outlive the pane recorded on the link. When the pane inside a tab is
replaced (the original closes, a new one is created in the same tab, and corral
renames the tab to the new session), the link's tab id still resolves while its
pane id names nothing. The reaper then issued `pane close` against a pane herdr had
never heard of, on **every poll tick, forever**:

```
[zombie-reaper] pane close failed env=<env> pane=w1:p2: Command failed: herdr pane close w1:p2
{"error":{"code":"pane_not_found","message":"pane w1:p2 not found"},"id":"cli:pane:close"}
```

Nothing retired the candidate and nothing reset its grace timer, so `now - first >=
graceMs` stayed true and the failure repeated indefinitely. The log flood was the
benign symptom. The unfixed hazard behind it was that identity rested on
coordinates nothing re-verified, so a close could in principle land on a pane that
was never ours.

### What herdr actually guarantees about ids

Read from the herdr source (Apache-2.0, `github.com/herdrdev/herdr`; verified
identical in v0.7.1 and v0.8.0), because the fix's safety depends on it:

- Ids are bijective base-32 over `123456789ABCDEFGHJKMNPQRSTVWXYZ0` — 32 symbols,
  no `I/L/O/U` (`src/workspace.rs`). Three independent counters: `w<n>`,
  `w<n>:t<m>`, `w<n>:p<k>`.
- All three counters only ever move **forward**. Workspace ids come from a
  process-global `AtomicU64`; tab and pane numbers from per-workspace counters
  advanced as `next = max(next, number + 1)`. Closing a pane unregisters it from
  the public-number map and **never returns its number to the pool**. herdr asserts
  this at runtime (`next_public_tab_number > max_tab_number`, the pane equivalent,
  and a duplicate-number assert).
- The counters survive a herdr restart: on restore they are recomputed as
  `max(persisted numbers) + 1` (`src/persist/restore.rs`).
- herdr asserts that its public pane map exactly matches its live panes, so
  `pane list` is authoritative: a pane absent from it is absent from herdr's state.

Two consequences. A pane id is a **stable identity for the lifetime of the herdr
session's persisted state** — a pane that has disappeared can never be re-created
under the same id. And a pane missing from `pane list` is gone permanently, not
gone temporarily.

## Decision

The board decides which links are *detached*; herdr decides what is *safe to
close*, and it is asked about the pane, not the tab.

Per tick, for each reachable environment holding detached candidates, the reaper
fetches one global `herdr pane list` and reaps a candidate only when a pane exists
that satisfies **all** of:

- `pane_id` equals the link's `paneId`,
- `tab_id` and `workspace_id` equal the link's,
- **no agent is registered on it** (an agent means a live session, ours or a
  stranger's — either way not a zombie).

Anything else — pane absent, pane now in a different tab, pane occupied — is
skipped silently, seeds no grace timer, and issues no herdr command. The grace
clock is keyed on `env:paneId`, the identity that is actually unique.

`pane list` replaces the `tab list` call one-for-one, so the per-tick cost is
unchanged. It also carries agent state directly, making it fresher evidence than
the poller snapshot (up to one poll interval stale) that the previous code
consulted.

A close that still fails is retried at most **3 times per pane**, after which the
candidate is abandoned for the process lifetime.

## Rationale

The bug was one symptom of a single structural fault: the reaper verified one
entity and mutated another. Anchoring both on the pane removes the class, not the
instance — pane gone, pane moved, pane occupied and tab id no longer ours all
collapse into one predicate evaluated against fresh state.

The missing-pane case now exits before any herdr command, so the observed loop
cannot form: there is no call, therefore no failure, therefore no log line. Because
pane numbers are never reused, dropping a vanished pane permanently is a
consequence of herdr's id model rather than a heuristic.

The attempt cap covers what the model cannot promise. The precheck's guarantee is
conditional on `pane list` and `pane close` agreeing inside the daemon; that
assumption is well-supported but unverified. The cap makes the property
unconditional: no cause, known or unknown, can produce an unbounded retry loop.
Three attempts still tolerate a transient failure (a remote SSH timeout) without
abandoning a genuine zombie on the first stumble.

Verifying the pane makes three older guards redundant, and they are removed: the
`tab list` fetch and its `TabInfo` shape, the pre-filter that consulted the poller
snapshot for a live agent at the pane, and the post-await re-read of that same
snapshot. All three inferred from staler data what one fresh `pane list` states
directly.

**Residual risk, accepted.** If a herdr session's persisted state is lost or
replaced, its counters restart at 1 and old links holding low ids can name new
panes. The agent check and the grace window cover the realistic form: a freshly
spawned Claude registers within seconds, so only a pane that is agentless at
exactly the recycled coordinates for longer than the grace is exposed.

## Rejected alternatives

**Store the pane's `terminal_id` on the link and require it to match.** herdr's
`terminal_id` is not drawn from a recycled counter, so this would close the
residual risk above completely. Rejected: it costs a board-schema field, a backfill
path for existing links, and changes to the spawn and attach paths — to defend
against id reuse that herdr's monotonic counters already make impossible while the
session's state survives. Reconsider only if state loss is observed to cause a
mis-target in practice.

**Treat `pane_not_found` as terminal and drop the candidate, changing nothing
else.** Rejected as a symptom fix: it silences the log flood while leaving the
reaper deciding from unverified coordinates, so a close could still land on a pane
that was never ours.

**Compare the stored tab label as extra evidence.** Rejected: corral renames herdr
tabs to the Claude session name, so a stored label goes stale by design. Comparing
it would leave every renamed session's genuine zombie uncollected — the reason the
original code deliberately omitted the check.
