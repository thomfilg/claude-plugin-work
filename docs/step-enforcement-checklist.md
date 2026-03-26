# Step Enforcement Checklist

Checklist for verifying /work workflow enforcement at each step. Every step must pass ALL applicable checks before the enforcement is considered complete.

## Per-Step Verification

### 1. State Setup
- [ ] Init state with `work-state.js init TICKET`
- [ ] Transition into the step with `work-orchestrator.js transition TICKET <step>`
- [ ] Verify `stepStatus.<step>` = `in_progress`, all others correct

### 2. Rule 4: CLI Bypass Prevention (MUST ALL BLOCK)
- [ ] `work-state.js set-step` → exit 2
- [ ] `work-state.js set-check` → exit 2
- [ ] `work-state.js add-error` → exit 2
- [ ] `work-state.js set-test-enhancement` → exit 2
- [ ] Chained commands (benign + mutating) → exit 2
- [ ] Blocked message includes "Direct state mutation" and transition hint
- [ ] `.work-actions.json` logs the blocked attempt with `{ rule: 4 }`

Allowed (read-only / setup):
- [ ] `get`, `resume-info`, `init`, `init-subtask`, `complete-subtask`, `active-subtask` → exit 0

### 3. Rule 5: Output File Protection
- [ ] Write to files NOT owned by current step → exit 2
- [ ] Write to files owned by current step → exit 0
- [ ] Blocked message includes owning step name and transition hint

Protected files and their owning steps:

| File | Owning Step |
|------|-------------|
| `brief.md` | brief |
| `spec.md` | spec |
| `tests.check.md` | check |
| `code-review.check.md` | check |
| `completion.check.md` | check |
| `tests-feedback.jsonl` | test_enhancement |

### 4. Rule 3: State File Protection (regression check)
- [ ] Write to `.work-state.json` → exit 2
- [ ] Write to `.step-evidence.json` → exit 2
- [ ] Write to `.work-actions.json` → exit 2
- [ ] Bash redirect to state files → exit 2

### 5. Rule 1: Step Command Matching
- [ ] Commands mapped to THIS step → exit 0
- [ ] Commands mapped to OTHER steps → exit 2

Step-to-command mappings:

| Step | Tool | Pattern |
|------|------|---------|
| ticket | Task/Agent | description: `^ticket\b` |
| bootstrap | Skill | skill: `^bootstrap$` |
| bootstrap | Task/Agent | description: `^bootstrap\b` |
| brief | Task/Agent | subagent_type: `brief-writer` |
| brief | Task/Agent | description: `^brief\b` |
| spec | Task/Agent | subagent_type: `spec-writer` |
| spec | Task/Agent | description: `^spec\b` |
| implement | Skill | skill: `^work-implement$` |
| quality | Task/Agent | subagent_type: `quality-checker` |
| quality | Task/Agent | description: `^quality\b` |
| quality | Bash | `pnpm dev:check` |
| commit | Task/Agent | subagent_type: `commit-writer` |
| check | Skill | skill: `^check$` |
| test_enhancement | Skill | skill: `^test-coordination$` |
| follow_up | Skill | skill: `^follow-up-pr$` |
| pr | Skill | skill: `^work-pr$` |
| ready | Task/Agent | description: `^ready\b` |
| ci | Task/Agent | description: `^ci\b` |
| cleanup | Task/Agent | description: `^cleanup\b` |
| reports | Task/Agent | description: `^reports\b` |
| complete | Task/Agent | description: `^complete\b` |
| complete | Bash | `work-state.js complete(\s|$)` |

### 6. PostToolUse: Evidence Recording
- [ ] After executing step command → `.step-evidence.json` updated
- [ ] Evidence entry: `{ [step]: { executed: true, command, tool, timestamp } }`
- [ ] Only the current step gets evidence (no leakage to other steps)

### 7. Transition Validation

| Step Type | Evidence Required | Output Files Required | Sub-workflow Required |
|-----------|------------------|-----------------------|---------------------|
| Soft (ticket, ready, reports) | No | No | No |
| Hard (most steps) | Yes | If in expectedOutputs | If in subWorkflowValidation |
| brief | Yes | `brief.md` | No |
| spec | Yes | `spec.md` | No |
| check | Yes | `tests.check.md`, `code-review.check.md`, `completion.check.md` | No (outputs ARE the validation) |
| pr | Yes | No | work-pr must be `completed` |
| implement | Yes | No | TDD-gated (if WORK_TDD_ENFORCE=1) |
| test_enhancement | Yes | No | TDD-gated (if WORK_TDD_ENFORCE=1) |

### 8. Post-Transition State
- [ ] Previous step = `completed`
- [ ] Current step = `in_progress`
- [ ] Evidence file preserved
- [ ] `.work-actions.json` updated

### 9. Invalid Transitions (blocked by orchestrator)
- [ ] Transition to step not in the step's `targets` → blocked with error listing valid targets

### 10. Edge Cases
- [ ] No `.work-state.json` → fail-open (exit 0)
- [ ] Corrupt state JSON → fail-open
- [ ] Empty `ENFORCE_HOOK_TICKET_ID` → skip all checks
- [ ] Git branch without ticket pattern → skip all checks

## Step Transition Graph

```
ticket            → bootstrap
bootstrap         → brief, spec, implement, quality, commit, check
brief             → spec, implement
spec              → implement
implement         → quality
quality           → commit, implement
commit            → check, quality
check             → test_enhancement, implement, quality
test_enhancement  → pr, commit, quality, implement
pr                → ready, ci
ready             → follow_up, ci
follow_up         → ci, cleanup, implement, test_enhancement
ci                → cleanup, implement, test_enhancement
cleanup           → reports
reports           → complete
```
