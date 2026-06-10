# Claude Plugin Work

## Project Overview

This is a Claude Code plugin (Node.js, CommonJS only). It provides deterministic workflows for ticket-to-PR delivery via `/work`, `/check`, `/work-implement`, and `/work-pr` commands.

See **[AGENTS.md](./AGENTS.md)** for the agent catalog. See **[docs/README.md](./docs/README.md)** for full architecture documentation.

## Development Rules

### Language & Runtime
- **CommonJS only** — `require`/`module.exports`. No ES modules, no `.mjs`, no bundlers.
- **Plain JavaScript** — No TypeScript. No transpilation. Runs directly under Node.js.
- **Node built-in test runner** — `node:test` + `node:assert/strict`. No Jest, Vitest, or Mocha.
- **Zero runtime dependencies** — Runtime dependencies must stay zero (the plugin is installed by users; their install size matters). devDependencies for lint/build/format tooling are permitted: `@biomejs/biome` (format + cognitive-complexity), `eslint` (4 quality rules), `jscpd` (duplicate-block detection). These do not ship to consumers.

### Testing
- Run tests: `pnpm test`
- Run specific test: `node --test scripts/workflows/work/__tests__/transition-step.test.js`
- Tests spawn hook scripts with `child_process.spawn` to test exit codes — this is the established pattern.
- Temp directories use `fs.mkdtempSync` + `rmSync({ recursive: true, force: true })` in `after`/`afterEach`.

### Code Conventions
- `process.exit(0/1/2)` in hooks is intentional — 0=allow, 2=block.
- Fail-open: hooks `catch` errors and exit 0 (allow). Only intentional blocks use exit 2.
- `logHookError(__filename, err)` is the logging convention. Not `console.error`.
- `Object.create(null)` prevents prototype pollution — intentional.
- Config via `scripts/workflows/lib/config.js` — never duplicate its logic elsewhere.
- `getConfig('TASKS_BASE')` / `getConfig.orExit(...)` are the canonical config accessors.

### File Organization
- `scripts/workflows/` — Core engine, per-workflow definitions, hooks, scripts
- `scripts/workflows/lib/` — Shared utilities (config, enforcement, validation, policies)
- `scripts/workflows/lib/hooks/policies/` — Pure decision functions (testable, no side effects)
- `agents/` — Agent definitions (markdown instruction files)
- `skills/` — Slash command definitions (SKILL.md per command)
- `hooks/hooks.json` — Hook registration (matchers, commands, timeouts)

### State Machine
- 18 steps: `ticket → bootstrap → brief → brief_gate → spec → spec_gate → tasks → implement → commit → task_review → check → pr → ready → follow_up → ci → cleanup → reports → complete`
- Step IDs are in `scripts/workflows/work/step-registry.js` — decoupled from ordering.
- Transitions validated by `workflowCanTransition()` — only declared edges are allowed.
- `transition-step.js` handles state persistence, artifact archival, and TDD gates.

### TDD Enforcement
- `implement` step is TDD-gated: must record RED → GREEN cycle before transitioning out.
- `tdd-phase-state.js` is the ONLY way to record evidence — agents cannot self-report.
- Phase gating hook (`work-implement-enforce.js`) blocks file edits by phase:
  - RED: only `.test.*`/`.spec.*` files
  - GREEN: only source files + test helpers
  - REFACTOR: all files
- `exception` mode for config-only changes — overwrites state directly, not via transition graph.

### Security
- All ticket-ID-to-path conversions validated against directory traversal.
- `protect-state-files.js` guards `.work-state.json` etc. from direct edits.
- `protect-artifact-files.js` enforces step+agent authorization for report files.
- Agent-gated scripts require both correct agent identity AND correct workflow step.
- `protect-task-scope.js` blocks edits outside the active task's `### Files in scope`. The env-var escape hatch is ONE-SHOT and requires BOTH `PROTECT_TASK_SCOPE_BYPASS_REASON="<reason>"` AND `PROTECT_TASK_SCOPE_BYPASS_TARGET="<exact-rel-path-or-glob>"` to be set; the bypass only fires when the actual write target matches `BYPASS_TARGET` (exact or glob). REASON alone never opens the gate. Each fired bypass appends a `scope-bypass` row to `.work-actions.json` recording both the configured target and the actual write path.

### Feature Flags

- `WORK_TEST_STRATEGY_VALIDATOR` (default `0`) — gates the GH-590 tasks-draft
  Test Strategy validator (enum-driven `### Test Strategy` blocks, command-
  existence dispatcher, and TDD-ownership graph). Set to `1` to enable the new
  draft-time validators in `work-tasks` draft phase; leave at `0` (the default)
  to preserve the legacy `### Test Command` path so in-flight `tasks.md` files
  are not blocked mid-stream. Read via `getConfig('WORK_TEST_STRATEGY_VALIDATOR')`.

### Ticket Providers
- Configured via `TICKET_PROVIDER` env var: `jira`, `linear`, `github`, `none`.
- GitHub issues use `#N` IDs, sanitized to `GH-N` for filesystem paths.
- `ticket-provider.js` handles all provider-specific logic.

### Formatting
- `pnpm format` — biome formatter
- `pnpm format:check` — check only

### Static Code Quality Gate

A deterministic gate enforces six static-code rules across the repo. It is wired
into CI (`.github/workflows/ci.yml` → `quality` job) and is required for merge.

**Runner:** `scripts/workflows/lib/scripts/quality/quality.js`

**Local usage:**
- `pnpm quality` — full-repo scan; exits non-zero on any non-allowlisted violation
- `pnpm quality:changed` — scan only files changed against `main` (fast inner loop)

**Rules and default thresholds:**
| Rule ID | Threshold | What it catches |
|---|---|---|
| `max-lines` | 400 lines / file | Oversized modules |
| `max-lines-per-function` | 80 lines / function | Bloated functions |
| `cyclomatic-complexity` | 10 | Tangled branching (ESLint `complexity`) |
| `max-depth` | 4 | Deeply-nested blocks (ESLint `max-depth`) |
| `duplicate-blocks` | 50-token blocks across files | Copy-paste drift (jscpd) |
| `cognitive-complexity` | 15 / function | Cognitively complex functions (Biome `noExcessiveCognitiveComplexity`) |

The runner shells out to three tools and folds their diagnostics into a single
violation shape: ESLint owns the first four rules (`complexity`, `max-depth`,
`max-lines`, `max-lines-per-function` — config in
`scripts/workflows/lib/scripts/quality/configs/quality-lint-rules.js`), jscpd
owns `duplicate-blocks`, and `rules/biome-bridge.js` shells out to Biome for
`cognitive-complexity`.

**Allowlist (`.quality-exceptions` at repo root):**
- Captures the current set of pre-existing violations so the gate can flip on
  without a mass-refactor PR.
- **Burn-down policy: new PRs may only shrink, never grow, the allowlist.** Any
  PR that introduces a new entry is rejected by the gate; entries should be
  removed as code is cleaned up.
- File format: one relative path per line; blank lines and `#`-prefixed comments
  are ignored. Absolute paths and `..` traversal are rejected.

**When the gate fails:**
1. Read the runner output — each violation prints `file:line  rule (value) in function`.
2. Fix the violation (preferred) or, if the change is genuinely pre-existing
   and out of scope, leave it allowlisted and address in a follow-up.
3. Re-run `pnpm quality` locally before pushing.
