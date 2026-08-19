# 6. corral asks GitHub for its own latest release

## Context

corral's health panel carries an "Update available" plate, wired to the diagnostics snapshot's
`self.latest`. Nothing filled that field: it was a seam with no producer, so the plate was inert by
construction and an operator running a months-old checkout had no way to learn it from corral.

Filling it means talking to a third party. corral already makes outbound connections — `ssh` to the
remote environments named in the operator's own configuration — and the README's security model has
always said so. What it has never done is reach a host the operator did not name.

## Decision

corral asks `api.github.com` for the latest release of the repository named in its own
`package.json`, behind an on-disk cache, and reports the answer as one diagnostics row in a
`network` class. `UPDATE_CHECK_ENABLED=false` stops it entirely.

The cache holds an answer for six hours and a failure for fifteen minutes, so a repository GitHub
answers costs four requests a day and one it cannot answer for — a fork with no releases yet, whose
`releases/latest` is a 404 — costs about a hundred. Both numbers are the operator-facing promise,
and the README states both.

Specifically:

- **Owner and repository come from `package.json`'s `repository` field**, not a constant, so a fork
  reports its own releases rather than the upstream's. A field naming a non-GitHub host, or naming
  nothing usable, means no request at all.
- **The request is bounded in every dimension.** A `User-Agent`, because GitHub refuses requests
  without one. `redirect: "manual"`, because this endpoint has no legitimate cross-host redirect.
  A response byte cap read off the stream, because a socket timeout does not stop a slow-drip body.
  One deadline covering the whole response rather than the headers alone. A Zod parse over the two
  fields actually used.
- **Nothing about the fleet leaves the machine.** The request carries no body, no query and no
  identifier. GitHub learns that some corral asked, and the source IP — the same as a `git fetch`.
- **Every failure is `n/a`, never red.** GitHub being unreachable, rate-limited, or answering
  something unexpected is not a problem with the operator's installation, and must not colour a
  panel whose whole job is telling real problems apart from noise. Each failure names itself in the
  row's title, because a folded row shows the title and nothing else.
- **An available update is a recommendation, not an alarm.** The row is `problem`/`info`, which the
  rail's badge digit — fatal and warning only — ignores, leaving the muted dot. A routine version
  bump must not light the same indicator as a broken install.
- **The release link is composed, not accepted.** The response's `html_url` is never read. The link
  is built from the slug and tag corral already validated — `https://github.com/<owner>/<repo>/releases#release-<tag>`
  — so no string GitHub sends can reach an `href`. It points at the releases index rather than the
  single-release page because an operator several versions behind needs every release between their
  build and the latest one; `#release-<tag>` is GitHub's own anchor there. The shared wire schema
  still coerces a non-conforming value to `null` instead of rejecting it, and the panel checks once
  more before it renders an `href`.
- **A tag that is not a plain version yields `n/a`**, decided before the version comparison rather
  than inside it.

## Rationale

**Why on by default.** A diagnostics panel that reports what is broken today but never that the
operator is running code with a fixed bug in it answers half the question it exists for. The cost is
a handful of requests a day to a host that already serves this repository.

**Why the link is composed rather than validated.** Validating a URL from the response was the
earlier design, and composing one is strictly better: there is no untrusted string left to get the
rules wrong about. It also removes the reason the check had to live at the producer in the first
place — the shared schema ships in the browser bundle, cannot read `package.json`, and so could
never have expressed the owner/repository rule itself. The schema's guard stays, but only as a sink
check: it coerces rather than rejects, because a rejection there discards the entire frame —
sessions, environments, attention and the board — rather than the one bad field, and the response
that seeds a board's first render is not schema-parsed at all.

**Why the tag is filtered before the comparison.** The version comparison deliberately drops a
prerelease suffix and coerces a non-numeric segment to zero, which is right for the `--version`
banners it was written for. Fed a release tag, that leniency reads `0.8.0-rc.1` as equal to `0.8.0`
and a word tag as older than everything. Since the tag is also rendered as the link's own text, the
same constraint closes a second gap: a tag of `999.0.0 — install from evil.example` would otherwise
become operator-facing copy attached to a legitimate github.com link.

**Why the cache is stricter than corral's existing atomic writer.** That writer is safe in its
current use mainly because the filenames it writes are unguessable, so their temp siblings are too.
A cache path is fixed by definition — it has to be found again after a restart — so it cannot borrow
that protection. This cache gets a per-uid directory that is `lstat`ed rather than trusted, a
filename hashed per repository, and a temp file opened with a flag that fails on an existing path
and never follows a symlink. It lives in the system temp directory and not under `$CORRAL_HOME`,
which corral commits to a git repository every ten seconds.

**Why failures are cached too.** Without that, a GitHub outage turns every sweep tick into a request
and exhausts the unauthenticated hourly budget, after which the row is stuck at `n/a` by corral's
own doing.

## Rejected alternatives

- **A hardcoded owner and repository.** Cheaper, and wrong for every fork: it would report the
  upstream's releases as if they were the operator's own.
- **Off by default.** A check nobody enables reports nothing, and the operator most likely to be far
  behind is the one least likely to go looking for the switch.
- **Linking the single-release page (the response's `html_url`).** It shows one release, and the
  operator who needs the link is behind by several. It also means trusting and then validating a
  string from the response, where composing one needs neither.
- **Following redirects.** The release endpoint has no legitimate cross-host redirect, and following
  one silently is how an intercepted endpoint reaches past the single host this check will talk to.
- **A manual recheck that bypasses the cache.** The refresh route is unauthenticated and throttled
  only by a two-second floor; thirty requests a minute would exhaust the hourly budget and leave the
  row stuck at `n/a`.
- **Honouring `Retry-After` as given.** Every other external input here is bounded; an unbounded one
  would let the far side set corral's schedule with a value that outlives the process reading it.
- **Reporting an available update as a warning.** It is not a defect in the operator's install, and
  a panel that raises the same alarm for "you are one release behind" as for "your hook is not
  installed" teaches operators to ignore both.
