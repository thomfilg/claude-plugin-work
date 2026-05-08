---
name: work2
description: Script-driven orchestrated workflow (v2) with auto-advance
argument-hint: <TICKET_ID or description> [--rework]
user-invocable: true
allowed-tools: Task, Bash, Read, Skill, TodoWrite
---

# /work2

Run the driver script. Execute what it says. Do not improvise.

## Start

```bash
node ${CLAUDE_PLUGIN_ROOT}/workflows/work2/work-next.js "$ARGUMENTS" --init
```

## Loop

1. Parse JSON output
2. Execute the `delegate` block exactly as described below
3. After delegation, the auto-advance hook outputs the next instruction
4. If no hook output appears, re-run: `node ${CLAUDE_PLUGIN_ROOT}/workflows/work2/work-next.js <TICKET_ID>`
5. Repeat until `action: "complete"`

## How to execute `delegate`

| delegate.type | Do this |
|---------------|---------|
| `bash` | Run the `command` field with Bash. Nothing else. |
| `task` | `Task(agentType)` with the `prompt` field. Do NOT read files yourself. |
| `parallel_tasks` | Launch ALL agents in `agents[]` array as parallel Task() calls. |
| `skill` | `Skill(name)` with the `prompt` field. |

## Rules

- **Do NOT** read brief/spec/tasks files before delegating — the agent reads them.
- **Do NOT** reinterpret or improvise on instructions. Execute exactly what the script says.
- **Do NOT** stop until `action: "complete"`.
- If `action: "blocked"` → follow the `suggestion` field, then re-run work-next.js.
