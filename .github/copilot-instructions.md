# Copilot Code Review Instructions

## Stale Comment Resolution

- Before flagging an issue, check if it was already fixed in a later commit in the same PR.
- If your previous comment was addressed by a subsequent push, resolve the thread — do not repeat it.
- Only comment on code that exists in the latest commit of the PR, not on removed or replaced lines.
- When re-reviewing after a push, focus on new/changed code, not previously reviewed lines.

## Comment Severity Classification

Every review comment MUST include a severity tag at the start:

- `[critical]` — Security vulnerability, data loss, or breaking production. Must fix.
- `[high]` — Bug, incorrect logic, or missing error handling. Must fix.
- `[medium]` — Code quality or suboptimal pattern. Should fix.
- `[low]` — Minor improvement. Nice to have.
- `[nitpick]` — Stylistic/cosmetic. Can ignore.

## Review Focus

When reviewing pull requests in this repository:

1. Focus on correctness, security, and maintainability
2. This is a Claude Code plugin (Node.js, no TypeScript) — hooks and scripts run as CLI processes
3. Fail-open patterns in hooks are intentional — do not suggest fail-closed alternatives
4. Exit codes `process.exit(0/1/2)` are intentional in hook scripts — do not suggest throwing errors instead
5. `lib/config.js` is the centralized config module — do not suggest duplicating its logic elsewhere
6. `getBaseBranch()` in config.js is reused by reference across hooks — this is intentional DRY
7. `WEB_APPS` is loaded from the repo `.env` file — do not flag it as hardcoded

## Enforcement System (GH-89)

When reviewing changes to `enforce-step-workflow.js` or related hooks, verify against the enforcement checklist at `docs/step-enforcement-checklist.md`. Key rules:

- **Rule 1**: Step commands must match the current `in_progress` step via commandMap
- **Rule 2**: Transitions require evidence (agent execution + output files for brief/spec/check)
- **Rule 3**: State files (`.work-state.json`, `.step-evidence.json`, etc.) are write-protected
- **Rule 4**: CLI state mutations (`set-step`, `set-check`, `add-error`, `set-test-enhancement`) are always blocked
- **Rule 5**: Output files (`brief.md`, `spec.md`, `*.check.md`) can only be written at their owning step
- Sub-workflow validation: `pr` step requires work-pr sub-workflow to be `completed`
- `brief` and `spec` are NOT soft steps — they require evidence + output files

## Do NOT Flag

- Missing TypeScript types — this project uses plain JavaScript intentionally
- Missing JSDoc on every function — only flag genuinely unclear APIs
- `Object.create(null)` — used intentionally to prevent prototype pollution
- `Set` instead of `Array` for deduplication — it is the correct choice
- Shell command string interpolation when values come from git commands (not user input)
- Config values imported from `lib/config.js` — they are centralized by design
