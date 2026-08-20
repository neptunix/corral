# Architecture Decision Records

Durable decisions live here as short numbered records: what was decided, why,
and what was rejected. Working documents (brainstorms, implementation plans)
are deliberately not committed — an ADR is the distilled, reviewable artifact
that survives them.

Format per record: **Context → Decision → Rationale → Rejected alternatives.**
One decision per file, numbered sequentially: `NNNN-short-slug.md`. An ADR is
immutable once merged; a reversal is a new ADR that supersedes it.

## When a decision earns a record

The test is the original one — [Nygard's "architecturally
significant"](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions):
a decision that affects structure, a non-functional property, a dependency, an
interface, or a construction technique. Concretely, at least one of these is
true:

- **Reversing it is expensive.** The cost falls on operators, on data already
  written, or on somebody's fork — not just on us editing our own code.
- **It crosses a boundary.** More than one component, or a contract someone
  outside this repo relies on: the wire shape, the config file, an environment
  variable, an endpoint.
- **It sets a trust, privacy, or safety property.** Where corral connects, what
  leaves the machine, what it will execute, what it refuses by default.
- **It is a first of its kind here, or it has burned us before.** There is no
  precedent to point at, so the next person re-litigates it otherwise.

Skip the record when a decision is narrow in scope **and** cheap to undo **and**
already covered — by an existing ADR, by the README, or by a convention the code
already demonstrates. A helper's shape, a file layout, a library swapped behind
an interface: those live in the code and the PR body.

Being unsure is itself informative. A decision nobody can argue for in four
short sections was probably not architecturally significant.

## At what altitude

Record the trade-off that was resolved, never how it was built. Mechanism —
guard order, cache layout, the shape of a URL, the wording on screen — belongs
in code comments and the PR description, which are free to change as the code
does.

This is what makes immutability affordable. **If a routine implementation change
would force an edit to a record that is supposed to be immutable, the record was
written too low** — the fix is to raise it, not to edit it in place. A record
that also serves as a design guide will not survive its own implementation.
