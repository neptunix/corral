# Contributing to corral

## Setup

```bash
npm install        # node-pty is native — compiles against your Node ABI (Node ≥ 20.11)
npm run dev        # UI on :5173, API on :8787
```

You need [herdr](https://github.com/ogulcancelik/herdr) ≥ 0.7.1 and an
`environments.json` (see README Quick start) to run against real sessions; the
test suite runs without either.

## The gate

Every PR must pass:

```bash
npm run check      # typecheck + lint + tests
```

## Conventions

Enforced by ESLint + tsconfig — the gate fails otherwise:

- No `any`. Type external data with Zod and infer (`z.infer`).
- No type assertions (`as`) — only `as const`. Narrow with guards or
  discriminated unions.
- No non-null assertions (`!`) outside `test/`.
- `import type` for type-only imports; named exports only; `??` over `||`;
  `===` always.

Convention, not enforced by tooling:

- Every boundary is Zod-validated. herdr CLI JSON is parsed in `server/herdr.ts`; the SSE/REST
  payload shapes shared between server and web live in `shared/schema.ts` and
  `shared/board-schema.ts`, so both sides agree on the same shape; server-only request bodies
  are validated in `server/api.ts`.
- `readonly` on data-shape interfaces.
- Files under ~400 lines, one responsibility.

Tests are Vitest in `test/<name>.test.ts`.

`CLAUDE.md` carries the same rules for agent-assisted contributions.

## Non-negotiable integration rules

- `pane run` only to send commands — never `agent send`.
- `HERDR_SOCKET_PATH` is the only routing mechanism.
- All herdr/SSH calls use `execFile` with arg arrays — never string
  interpolation into a shell.
- The server binds `127.0.0.1` only. Environments come from trusted startup
  config and must never become editable via the API.

## PRs and decisions

- Every PR description must say **what** changed and **why** (the template
  asks). A PR whose motivation can't be stated in two sentences is usually
  two PRs.
- Decisions that outlive a PR (architecture, security posture, protocol
  shapes) get an ADR in `docs/adr/` — see its README for the format.
