# 0001 — Clean-start public release

## Context

corral was developed in a private repository whose history and working
documents referenced the author's personal machine layout and environment
names. The project is now published for public use and contribution.

## Decision

Publish as a new repository with a single initial commit of the cleaned tree.
The private repository is kept as an archive. Working documents (plans,
discovery notes, brainstorm outputs) are gitignored; durable decisions are
recorded as ADRs in this directory, and every PR must state what/why in its
description.

## Rationale

- A fresh history is hermetic by construction — no rewrite tooling, no risk of
  a missed reference surviving in an old blob. GitHub also retains
  force-pushed objects by SHA, so an in-place rewrite would not have been safe.
- Working docs are scaffolding: verbose, environment-specific, and stale the
  moment they merge. ADRs + PR descriptions carry the decision history in a
  form contributors can actually read.

## Rejected alternatives

- **History rewrite (git-filter-repo):** preserves commit granularity but
  every missed pattern leaks permanently; verification cost outweighed the
  value of pre-release history.
- **Committing all working docs publicly:** high genericization effort, low
  reader value.
