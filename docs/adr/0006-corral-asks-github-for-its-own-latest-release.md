# 6. corral asks GitHub for its own latest release

## Context

corral's health panel carries an "Update available" plate wired to the diagnostics snapshot, and
nothing filled it: an operator running a months-old checkout had no way to learn that from corral.

Filling it means talking to a third party. corral already makes outbound connections — `ssh` to
the remote environments named in the operator's own configuration, and the README's security model
has always said so. What it has never done is reach a host the operator did not name.

## Decision

corral asks `api.github.com` for the latest release of the repository named in its own
`package.json`, behind a cache, and reports the answer as one diagnostics row. It is **on by
default**; `UPDATE_CHECK_ENABLED=false` stops it entirely.

The terms of that request are the operator-facing promise, and the README states them:

- **Nothing about the fleet leaves the machine.** No body, no query, no identifier. GitHub learns
  that some corral asked, and the source IP — the same as a `git fetch`.
- **Bounded frequency.** Six hours after an answer, fifteen minutes after a failure.
- **Owner and repository come from `package.json`**, not a constant, so a fork reports its own
  releases. A field naming a non-GitHub host means no request at all.
- **Never follows a redirect.** `api.github.com` is the only host corral is willing to talk to for
  this; an intercepted or misbehaving endpoint does not get a second hop to reach further.
- **Every failure is `n/a`, never red**, and names itself in the row.
- **An available update is a recommendation, not an alarm** — it lights the rail's muted dot,
  never the problem count.

## Rationale

**Why on by default.** A diagnostics panel that reports what is broken today but never that the
operator is running code with a fixed bug in it answers half the question it exists for. The cost is
a handful of requests a day to a host that already serves this repository, and the operator who is
most likely to be far behind is the least likely to go looking for a switch to turn on.

**Why it is a recommendation and not a problem.** A routine version bump must not light the same
indicator as a broken install. A panel that raises one alarm for "you are one release behind" and
for "your hook is not installed" teaches operators to ignore both.

**Why a failure is never red.** GitHub being unreachable, rate-limited, or answering something
unexpected is not a defect in the operator's installation, and a panel whose whole job is telling
real problems apart from noise must not colour it as one.

## Rejected alternatives

- **A hardcoded owner and repository.** Cheaper, and wrong for every fork: it would report the
  upstream's releases as if they were the operator's own.
- **Off by default.** A check nobody enables reports nothing.
- **Reporting an available update as a warning.** It is not a defect in the operator's install.
