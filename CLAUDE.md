# herdr-dashboard — agent rules (read before writing any code)

## Conventions (gate: `npm run check` = typecheck + lint + test)
Enforced by `eslint.config.js` + `tsconfig.json` — the gate fails otherwise:
- **No `any`** (`no-explicit-any`). Type external data with **Zod** and infer (`z.infer`).
- **No type assertions** (`consistent-type-assertions: 'never'`) — only `as const`. Narrow with
  guards / discriminated unions instead of `as`.
- **No non-null assertions (`!`)** in `server/`/`web/`/`shared/` — narrow explicitly (`!` only in `test/`).
- **`import type`** for type-only imports (`verbatimModuleSyntax` + `consistent-type-imports`).
- **Named exports only** (no `export default`) (`import-x/no-default-export`).
- Prefer `??` over `||`; `===` always.
- Strict tsconfig: `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noUnusedLocals/Parameters`.
- `catch (err)` → narrow with `err instanceof Error ? err.message : String(err)`. Never cast.

Convention, not enforced by tooling:
- **`readonly`** on data-shape interfaces.
- **Every boundary must be Zod-validated.** herdr CLI JSON is parsed in `server/herdr.ts`; the
  SSE/REST payload shapes shared by server + web live in `shared/schema.ts` +
  `shared/board-schema.ts`; server-only request bodies are validated in `server/api.ts`.
- Files under ~400 lines, one responsibility.

Tests are Vitest, `test/<name>.test.ts`.

## Critical herdr-integration rules
- **`pane run` only** to send commands (appends Enter). Never `agent send` (staged-text garble).
- **`HERDR_SOCKET_PATH` is the ONLY routing mechanism** — no `--socket`/`--session` flag.
- **`pane read` returns RAW TEXT, never JSON.** Only `workspace/tab/agent list` are JSON (Zod-validated).
- **All herdr/SSH calls use `execFile` with arg arrays** (`server/herdr.ts`); remote quotes user
  tokens with `shell-quote`; never `exec` with string interpolation.
- **Remote = `ssh <host> 'HERDR_SOCKET_PATH=<sock> <bin> <args>'`** + `-o ConnectTimeout=8` +
  per-command `timeout`; strip SSH-noise lines; do NOT blanket-`.trim()` pane text.
- **Server binds `127.0.0.1` only** (`assertLoopback`). No auth.
- **Environments come from a trusted startup config file** (`$CORRAL_CONFIG`, default
  `$CORRAL_HOME/environments.json`) — Zod-validated, loaded once. NEVER add/edit envs via the API (SSH-relay risk).
- `poller.ts` orchestrates; scheduling is in `scheduler.ts`.

## Public repo — keep PRs, issues, and commits clean
This repo is public. Outward-facing text (PR titles/bodies, issue text, commit messages, code
comments) must carry NO local/private data — scrub before publishing:
- No absolute home paths — use repo-relative paths or a `~/…` / `<CORRAL_HOME>` placeholder, never
  `/Users/<name>/…` or `/home/<name>/…`.
- No real hostnames, SSH targets, IPs, tokens, emails, or other personal identifiers.
- No private env / board / repo names pulled from runtime config (`environments.json`,
  `$CORRAL_HOME/boards/`) — redact to `<env>` / `<board>` / `<repo>`.
- Bug repros use placeholder ids (`w1:p1`, `<uuid>`, `/repo/path`), never a real session or
  transcript dump.

Full design: `docs/specs/design-spec.md`.
