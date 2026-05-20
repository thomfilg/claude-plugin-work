---
name: qa
description: Orchestrated QA testing — discovers impacted apps and dispatches per-appType QA agents in parallel (web → /check-qa, api → qa-api-tester, cli → skip)
argument-hint: <TICKET_ID> [--apps app1,app2]
user-invocable: true
allowed-tools: Bash, Read, Glob, Grep, Task, Skill
---

# /qa — Orchestrated QA Testing

Top-level QA orchestrator. Discovers which apps are impacted by the current change, then dispatches the appropriate QA agent per app in parallel.

This is what the deleted `/check` Agent 3.x logic used to do. It's now a standalone skill so it can be invoked from `/check2`'s phase1-agents step (or directly by a human for ad-hoc QA).

## Usage

```bash
/qa <TICKET_ID>                          # Discover apps automatically
/qa <TICKET_ID> --apps status-site,api   # Test specific apps only
```

## What it does

1. **Resolve tasks dir + report folder** from TICKET_ID using `resolveTasksBaseWithFallback`.
2. **Discover impacted apps** by combining:
   - The `WEB_APPS` env var (JSON manifest: `[{"name":"...","defaultPort":N,"type":"next","appType":"web"|"api"|"cli"}]`)
   - Changed files in the current PR vs base branch
   - Falls back to "all apps in `WEB_APPS`" if change detection is empty
3. **Route per appType:**
   - `web` apps → invoke `Skill("check-qa", args: <APP_NAME> <JSON_PARAMS>)` — browser-based QA
   - `api` apps → dispatch `Task(subagent_type: 'qa-api-tester', ...)` — HTTP/curl testing
   - `cli` apps → skip (covered by `quality-checker` automated tests)
4. **Dispatch in parallel** — all per-app QA runs as a single multi-tool-use block.
5. **Aggregate reports** — each per-app QA writes to `${REPORT_FOLDER}/qa-<app>.check.md`. After all return, summarize the verdicts.

## Resolve config

```bash
# Tasks dir
node -e "const { resolveTasksBaseWithFallback } = require('${CLAUDE_PLUGIN_ROOT}/scripts/workflows/lib/ticket-validation'); console.log(resolveTasksBaseWithFallback());"

# Web apps manifest (from .envrc)
echo "$WEB_APPS" | jq .
```

If `WEB_APPS` is unset OR empty after parse, exit with a config error: `"WEB_APPS env var not set. Define apps in the worktree's .envrc (JSON array of {name, defaultPort, type, appType})."`

## App discovery

Read `WEB_APPS` JSON:

```javascript
const apps = JSON.parse(process.env.WEB_APPS || '[]');
// Each entry: {name, defaultPort, type, appType}
```

Filter to impacted apps:
1. If `--apps app1,app2` provided → use the explicit list (intersected with WEB_APPS).
2. Else if `affected-tests` artifact present at `${TASKS_DIR}/affected.json` → use the apps it lists.
3. Else → run on ALL apps in WEB_APPS (safe default; matches the deleted `/check`'s behavior when change detection couldn't narrow).

For each impacted app, compute:
- `appUrl` = `http://host.docker.internal:${defaultPort}` (or `http://localhost:${defaultPort}` outside docker)
- `reportPath` = `${TASKS_DIR}/qa-<app>.check.md`
- `screenshotsFolder` = `${TASKS_DIR}/screenshots/<app>/`

## Dispatch logic

For each impacted app, build the dispatch by appType:

### Web apps → `/check-qa`

```javascript
const qaParams = {
  ticketId: TICKET_ID,
  reportPath: `${TASKS_DIR}/qa-${app.name}.check.md`,
  changesHash: CHANGES_HASH,
  appUrl: `http://localhost:${app.defaultPort}`,
  screenshotsFolder: `${TASKS_DIR}/screenshots/${app.name}/`,
  affectedFiles: AFFECTED_FILES[app.name] || [],
  affectedPackages: AFFECTED_PACKAGES || [],
  qaDocs: QA_DOCS || '',
  e2eDocs: E2E_DOCS || ''
};
Skill("check-qa", args: `${app.name} ${JSON.stringify(qaParams)}`);
```

### API apps → `qa-api-tester` agent

```javascript
Task(
  subagent_type: 'qa-api-tester',
  description: `QA API tests for ${app.name}`,
  prompt: `Test the ${app.name} API at http://localhost:${app.defaultPort}. ` +
          `Verify HTTP responses, schemas, and side-effects for the changes in this PR. ` +
          `Write report to ${TASKS_DIR}/qa-${app.name}.check.md. ` +
          `Affected files: ${JSON.stringify(AFFECTED_FILES[app.name] || [])}`
);
```

### CLI apps → skip

Log "Skipping QA for CLI app <name> (covered by quality-checker)" and continue.

## Parallelization (CRITICAL)

ALL per-app dispatches MUST run in parallel — a single message with one `Skill` or `Task` call per app. Sequential runs are forbidden because dev environments are shared across apps and serial runs waste minutes.

## Aggregation

After all dispatches return:
1. Read each `${TASKS_DIR}/qa-<app>.check.md` report.
2. Parse the verdict (`Status: APPROVED` / `Status: NEEDS_WORK` / `Status: FAIL`).
3. Aggregate: if any app reports NEEDS_WORK or FAIL, the overall `/qa` verdict is NEEDS_WORK.
4. Emit a summary table:
   ```
   | App | Verdict | Report |
   |---|---|---|
   | status-site | APPROVED | qa-status-site.check.md |
   | api-server | NEEDS_WORK | qa-api-server.check.md |
   ```

## Invocation contexts

- **From `/check2`** (the primary path) — `phase1-agents.js` dispatches `/qa` alongside code-checker + completion-checker. The dev environment is already up (start-env step ran earlier).
- **Standalone (ad-hoc)** — user runs `/qa <TICKET>` directly. In this mode, `/check-qa` (the dispatched skill) starts the dev environment itself via `$DEV_COMMAND`. Idempotent — does nothing if already running.

## Exit behavior

- All apps APPROVED → exit 0
- Any app NEEDS_WORK or FAIL → exit 0 with summary table (the caller's gate decides what to do with the verdicts)
- Config error (no WEB_APPS, no apps after filter, etc.) → exit 1 with descriptive message

## Reuse (do NOT re-implement)

- `scripts/workflows/lib/ticket-validation.js::resolveTasksBaseWithFallback` — TASKS_BASE resolution
- `/check-qa` skill — per-app web QA (don't inline the logic)
- `qa-api-tester` agent — API testing (don't inline)
- The deleted `/check`'s Agent 3.x discovery+routing logic was the reference — port the routing without re-creating the orchestrator monolith.

## Failure modes

- Dev environment not running and not started by `/check-qa` — surfaces as the per-app QA report's failure. `/qa` aggregates and reports.
- A single app fails — other apps continue (parallel, no fail-fast). Aggregated verdict reflects all results.
- `WEB_APPS` malformed JSON — exit with the parse error and the raw value for debugging.
