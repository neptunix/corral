# 3. Reap identity is anchored on the pane, verified against a live pane list

## Context

The zombie reaper closes the herdr pane a corral session left behind when its Claude
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
- **nothing is registered on it** — an agent means a live session, ours or a
  stranger's, and either way not a zombie. Absence is decided by the poller's
  `agent list` index, with the pane list's own agent fields as a secondary skip
  signal; see the guard note below for why the pane list alone cannot answer this.

Anything else — pane absent, pane now in a different tab, pane occupied — is
skipped silently, seeds no grace timer, and issues no herdr command. The grace
clock is keyed on `env:paneId`, the identity that is actually unique.

`pane list` replaces the `tab list` call one-for-one, so the call *count* per tick
is unchanged; the payload is not. Global `pane list` returns `cwd`, `foreground_cwd`,
`terminal_id`, `revision`, `focused` and labels for every pane on the host (26 on the
machine this was measured on), where `tab list` returned three fields per tab.
Immaterial in practice, but it crosses SSH on remote environments. It also carries
agent state directly, making it fresher evidence than the poller snapshot (up to one
poll interval stale) that the previous code consulted.

A close that still fails is retried at most **3 times per grace window**: on the
third failure the candidate's grace timer is dropped, so it must age through a full
grace again before another attempt. The cap is never permanent.

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
Scoping it to a grace window rather than the process keeps that bound while
tolerating transient failure — three SSH timeouts in a row must not strand a real
zombie until restart, and a cap that persisted for the process could also suppress
a *later* pane that inherits the same id after state loss.

Only one older guard becomes redundant and is removed: the `tab list` fetch and its
`TabInfo` shape, which the pane list now subsumes.

Two guards that read the poller snapshot are deliberately **kept**, both consulted
in the original design of this change and restored after review:

- The pre-filter that skips a link whose pane already holds a live agent. This one
  is load-bearing, not redundant: `pane list` cannot see every agent. Verified
  against a live herdr, an agent started as a bare shell
  (`herdr agent start <name> -- bash`) appears there byte-identically to a free pane
  — no `agent`, no `agent_session`, `agent_status: "unknown"`. `agent list` does
  list it, because a missing `agent` string defaults to `""`. So the two calls carry
  different authority: `pane list` decides **identity**, `agent list` decides
  **occupancy**, and the reap needs both.
- The re-read of the snapshot immediately before closing. The tempting argument for
  deleting it — that a fresh `pane list` is strictly newer evidence — is false:
  response *arrival* order is not state order. A `pane list` reply can be generated
  from herdr state before an agent registers and arrive after a newer poll snapshot
  that already shows it, which is reachable on a remote environment where the list
  crosses SSH. The existing TOCTOU test covers exactly this.

**Residual risk, accepted (state loss).** If a herdr session's persisted state is
lost or replaced, its counters restart at 1 and old links holding low ids can name
new panes. The agent check and the grace window cover the realistic form: a freshly
spawned Claude registers within seconds, so only a pane that is agentless at
exactly the recycled coordinates for longer than the grace is exposed.

**Residual risk, pre-existing and unchanged (unregistered agent).** herdr reports a
pane as agentless until it registers the Claude running in it, and no field in
`pane list` distinguishes "shell at a prompt" from "Claude starting". So a link that
has already aged past its grace can be reaped in the seconds between a user
re-running `claude` in the lingering pane and herdr registering it. Both liveness
sources in the current code derive from `agent list` and share this blindness, so
the fault predates this decision and neither the pane anchor nor the guards above
close it. Closing it would need herdr to expose pane process state, or corral to
observe the re-run some other way. The grace window is what bounds the exposure
today: it is the reap tick landing inside the registration window.

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
