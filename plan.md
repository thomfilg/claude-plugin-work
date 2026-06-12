# Runtime Adapter Refactor Plan

## Goal

Make the plugins runtime-agnostic so the core plugin logic does not know whether it is running under Claude, Codex, or another agent runtime.

The target shape is not `codex.getWritePatterns()` scattered through the plugin. The target is an injected runtime adapter:

```ts
const runtime = RuntimeAdapter.current();
const writeTargets = runtime.tools.extractWriteTargets(event.toolCall);
```

Then Claude, Codex, and future runtimes provide their own implementations for hooks, tool names, transcripts, sessions, storage, and delegation.

## Current State

The repo has two plugin trees:

- `plugins/*`: Claude-source plugins with `.claude-plugin/plugin.json`, Claude hooks, Claude skill frontmatter, Claude tool names, and `.claude` storage paths.
- `codex-plugins/*`: generated Codex packages with `.codex-plugin/plugin.json` and converted skills/agents, but many runtime scripts still expect Claude-shaped hooks, env vars, transcripts, and tool payloads.

There is also source data at:

- `/home/thomfilg/p/w-claude-plugin/claude-plugin-work/codex-plugins`
- `/home/thomfilg/p/w-claude-plugin/claude-plugin-work/scripts/claude-to-codex.js`

This checkout's `package.json` still references `scripts/claude-to-codex.js`, but that file is not present in this adapter checkout. The converter currently lives in the sibling source repo above.

## Startup Error Triage

The startup errors are mixed:

- Bubblewrap missing on `PATH`: environment issue, not plugin architecture. Codex is falling back to bundled bubblewrap.
- `linear` not logged in: connector login issue, not plugin architecture.
- `cortex` and `playwright_headed` MCP startup failures: runtime/tool availability issue. The adapter should expose `runtime.tools.hasCapability(name)` and avoid hard-failing when optional tools are unavailable.
- Invalid `SKILL.md` YAML: plugin packaging issue. This is in scope.

The invalid skill YAML is caused by Codex loading Claude-source packages from `.claude-plugin/marketplace.json`, which points at `./plugins/*`:

- `.claude-plugin/marketplace.json:14` -> `./plugins/work`
- `.claude-plugin/marketplace.json:27` -> `./plugins/synapsys`
- `.claude-plugin/marketplace.json:40` -> `./plugins/maestro`
- `.claude-plugin/marketplace.json:54` -> `./plugins/heimdall`

Those source packages contain Claude frontmatter such as:

- `plugins/heimdall/skills/protect/SKILL.md`: unquoted description contains `{ protect: [paths], unlockPhrase }`.
- `plugins/synapsys/skills/list/SKILL.md`: unquoted `argument-hint: [--store=<kind>] [--event=<EventName>] [--json]`.
- `plugins/work/skills/create-design-doc/SKILL.md`: unquoted `|` in `argument-hint`.

The generated `codex-plugins/*` packages mostly repair this by quoting strings and stripping some Claude-only fields, but the marketplace/cache path is not consistently installing those generated packages.

Immediate packaging fix:

1. Point Codex marketplace/package installation at `codex-plugins/*`, not `plugins/*`.
2. Ensure installed packages contain `.codex-plugin/plugin.json`.
3. Validate installed `SKILL.md` files with a real YAML parser or Codex's strict parser.
4. Treat raw `plugins/*` as Claude source only.

## Core Design

Introduce a shared adapter boundary, for example:

```ts
interface RuntimeAdapter {
  name(): 'claude' | 'codex' | string;

  paths: RuntimePaths;
  hooks: RuntimeHooks;
  tools: RuntimeTools;
  transcripts: RuntimeTranscripts;
  sessions: RuntimeSessions;
  delegation: RuntimeDelegation;
  storage: RuntimeStorage;
  packaging: RuntimePackaging;
  llm?: RuntimeLlm;
}

interface RuntimeTools {
  toCanonicalToolCall(nativeCall: unknown): CanonicalToolCall;
  classify(call: CanonicalToolCall): ToolKind;
  serializeInput(call: CanonicalToolCall): string;
  extractWriteTargets(call: CanonicalToolCall): WriteTarget[];
  extractWriteContent(call: CanonicalToolCall): string[];
  extractShellCommand(call: CanonicalToolCall): string | null;
  getWritePatterns(): WritePattern[];
  matchesToolSpec(spec: string, call: CanonicalToolCall): boolean;
  hasCapability(name: string): boolean;
  resolveCapability(name: string): string | null;
}

interface RuntimeHooks {
  normalizeEvent(nativePayload: unknown, env: NodeJS.ProcessEnv): CanonicalEvent;
  allow(): RuntimeResult;
  block(message: string): RuntimeResult;
  injectContext(markdown: string): RuntimeResult;
  registerHooks(spec: HookSpec): RuntimeHookManifest;
}

interface RuntimeTranscripts {
  recentUserMessages(ctx: RuntimeContext, opts: { count: number; authoredOnly?: boolean }): string[];
  lastAssistantText(ctx: RuntimeContext): string;
  iterEvents(opts: TranscriptQuery): Iterable<CanonicalEvent>;
  stripRuntimeInjectedText(text: string): string;
}

interface RuntimeDelegation {
  dispatchAgent(spec: AgentDelegate): RuntimeAction;
  dispatchSkill(spec: SkillDelegate): RuntimeAction;
  runShell(spec: ShellDelegate): RuntimeAction;
  askUser(spec: QuestionSpec): RuntimeAction;
  supportsParallelDelegates(): boolean;
}

interface RuntimeStorage {
  storeDirs(plugin: string, cwd: string): StoreDir[];
  stateDir(plugin: string, component?: string): string;
  telemetryDir(plugin: string): string;
  sessionDir(plugin: string): string;
  transcriptRoot(): string;
  projectIdentity(cwd: string): string;
}
```

`codex.getWritePatterns()` is useful as adapter metadata, but the more important method is:

```ts
runtime.tools.extractWriteTargets(call)
```

That lets Heimdall, workflow gates, and Synapsys content matching work against canonical write operations instead of Claude `Edit|Write|MultiEdit` or Codex `apply_patch|exec_command`.

## Canonical Event Model

Create a runtime-neutral event shape:

```ts
type CanonicalEvent = {
  event: 'session_start' | 'user_prompt' | 'pre_tool' | 'post_tool' | 'pre_compact' | 'stop';
  cwd: string;
  sessionId: string | null;
  transcriptId?: string | null;
  userPrompt?: string;
  toolCall?: CanonicalToolCall;
  toolResult?: unknown;
  stopMessage?: string;
  currentAgent?: AgentContext | null;
  native: unknown;
};

type CanonicalToolCall = {
  runtimeName: string;
  canonicalName: string;
  kind: 'read' | 'write' | 'shell' | 'delegate_agent' | 'delegate_skill' | 'question' | 'mcp' | 'other';
  input: unknown;
  rawInputText: string;
};

type WriteTarget = {
  path: string;
  operation: 'create' | 'modify' | 'delete' | 'patch' | 'unknown';
  source: string;
};
```

Claude adapter maps:

- `UserPromptSubmit` -> `user_prompt`
- `PreToolUse` -> `pre_tool`
- `PostToolUse` -> `post_tool`
- `PreCompact` -> `pre_compact`
- `Stop` -> `stop`
- `Edit|Write|MultiEdit|NotebookEdit` -> `write`
- `Bash` -> `shell`
- `Task|Agent` -> `delegate_agent`
- `Skill` -> `delegate_skill`
- `AskUserQuestion` -> `question`

Codex adapter maps:

- `functions.apply_patch` -> `write` with parsed patch targets
- `functions.exec_command` -> `shell`, and optionally `write` when command writes files
- `multi_agent_v1.spawn_agent` -> `delegate_agent`
- skill invocation -> `delegate_skill`
- user-input tool -> `question`

## Plugin-by-Plugin Refactor

### Heimdall

Keep:

- Lock config format.
- Guard entry building.
- Path matching.
- Bash command write detection, once it accepts canonical shell commands.
- Unlock phrase policy.

Move behind adapter:

- Hook stdin parsing in `plugins/heimdall/hooks/heimdall.js`.
- Blocking via stderr + exit code `2`.
- `tool_name`, `tool_input`, and `transcript_path`.
- Claude tool handlers in `plugins/heimdall/lib/guard/evaluate.js`.
- Transcript JSONL parsing in `plugins/heimdall/lib/guard/transcript.js`.
- `.claude/heimdall` store paths in `plugins/heimdall/lib/lock-store.js`.

Target flow:

```ts
const event = runtime.hooks.normalizeEvent(stdinJson, process.env);
const stores = runtime.storage.storeDirs('heimdall', event.cwd);
const unlocked = runtime.transcripts.recentUserMessages(event, { count: 20, authoredOnly: true });
const result = heimdall.evaluate({
  call: event.toolCall,
  writeTargets: runtime.tools.extractWriteTargets(event.toolCall),
  shellCommand: runtime.tools.extractShellCommand(event.toolCall),
  userMessages: unlocked,
  entries,
});
return result.blocked ? runtime.hooks.block(result.message) : runtime.hooks.allow();
```

Why first: it is the smallest high-value proof. It directly tests the `getWritePatterns` / `extractWriteTargets` concept.

### Synapsys

Keep:

- Memory file model.
- Trigger matching semantics.
- Domain/sticky logic.
- Injection rendering and ledger rules.
- Replay reporting concepts.

Move behind adapter:

- Hook events and stdout injection in `plugins/synapsys/hooks/synapsys.js`.
- `payload.tool_name` and `payload.tool_input` in `plugins/synapsys/lib/matcher.js`.
- Content extraction from Claude edit payloads in `plugins/synapsys/lib/matcher-content.js`.
- Claude transcript scan in `plugins/synapsys/lib/replay-events.js`.
- Stop response extraction in `plugins/synapsys/lib/cite-scan.js`.
- `.claude/synapsys`, telemetry, sticky, and session paths.
- Anthropic-specific replay judge.

Replace `trigger_pretool` matching with canonical tool specs. The memory syntax can stay stable if the adapter maps runtime tool names to canonical names:

```yaml
events: [PreToolUse]
trigger_pretool: [Write:package.json, Shell:pnpm test]
trigger_pretool_content: [useMutation]
```

The Claude adapter maps `Write` to canonical `Write`. The Codex adapter maps `apply_patch` to canonical `Write` and `exec_command` to canonical `Shell`.

### Work Workflow

Keep:

- Deterministic state machine.
- `work-next.js` JSON instruction contract.
- Step registry.
- Task state files.
- Gate policy logic, once inputs are canonical.

Move behind adapter:

- Slash-command interception through `CLAUDE_USER_PROMPT` in `plugins/work/hooks/work-hook.js`.
- Plan/context injection by printing to stdout.
- Hook lifecycle and `CLAUDE_HOOK_TYPE`.
- `tool_name`, `tool_input`, `transcript_path`, and `CLAUDE_CURRENT_AGENT`.
- Agent identity detection via Claude transcripts.
- Per-agent hook emulation caused by Claude stripping frontmatter hooks.
- `Task(...)`, `Skill(...)`, `AskUserQuestion`, `Monitor`, and `BashOutput` instructions in skills and generated prompts.
- MCP tool names such as `mcp__playwright__...`, `mcp__claude-in-chrome__...`, and Jira/Linear names.
- Auto-advance relying on `PostToolUse` output being visible to the model.

The existing Codex shim in `plugins/work/scripts/codex/work-adapter.js` is useful but should become an adapter implementation, not the core architecture. It currently parses Claude textual delegates after the fact. The workflow should instead emit structured delegates directly:

```json
{
  "action": "execute",
  "delegate": {
    "type": "agent",
    "agent": "developer-react-senior",
    "description": "Implement task 2",
    "prompt": "..."
  }
}
```

Adapters render or dispatch that differently:

- Claude: render `Task(...)`, `Skill(...)`, or shell instructions when needed.
- Codex: call subagent/skill APIs or return a structured `dispatch_agent` / `dispatch_skill` action.

### Maestro

Maestro is not only a hook/tool adapter problem. It is a runtime session manager.

Move behind a `RuntimeSessionManager`:

- `claude --dangerously-skip-permissions '/work <TICKET>'`.
- `CLAUDE_BIN`.
- tmux launch/restart assumptions.
- Pane capture and `tmux send-keys` as the interaction channel.
- `/tmp/claude-agent-inbox`.
- Session naming and restart behavior tied to `/work`.

Suggested interface:

```ts
interface RuntimeSessionManager {
  spawnSession(spec: { cwd: string; prompt: string; name: string }): SessionHandle;
  restartSession(handle: SessionHandle): void;
  stopSession(handle: SessionHandle): void;
  captureSession(handle: SessionHandle): string;
  sendInput(handle: SessionHandle, text: string): void;
  listSessions(filter: SessionFilter): SessionHandle[];
}
```

Claude implementation can keep tmux + `claude`. Codex may need a different session primitive, or may only support a limited conductor mode until Codex exposes equivalent long-running session APIs.

## Packaging Refactor

Current converter behavior:

- Copies runtime folders wholesale.
- Converts agents to TOML.
- Rewrites `CLAUDE_PLUGIN_ROOT` only in skills/agents.
- Leaves hook commands unchanged because `normalizeHookCommand()` is a no-op.
- Generates `setup-env.sh` that exports both `CODEX_PLUGIN_ROOT` and `CLAUDE_PLUGIN_ROOT`.
- Drops only `allowed-tools`, `user-invocable`, and `argument-hint`; underscore variants can survive.
- Uses hand-rolled frontmatter parsing instead of real YAML.

Required changes:

1. Move converter into this adapter repo or update `package.json` to point to the real converter location.
2. Add runtime profiles:
   - `--runtime claude`
   - `--runtime codex`
   - later `--runtime <other>`
3. Parse source frontmatter with a real YAML parser.
4. Emit Codex frontmatter using block scalars for long descriptions:

   ```yaml
   ---
   name: protect
   description: |
     Add a Heimdall lock block...
   ---
   ```

5. Normalize and drop all Claude-only fields:
   - `allowed-tools`
   - `allowed_tools`
   - `user-invocable`
   - `user_invocable`
   - `argument-hint`
   - `argument_hint`
6. Strengthen `validate-codex-plugin.js` to reject unknown skill frontmatter keys.
7. Include required runtime modules. Generated `codex-plugins/heimdall` and `codex-plugins/synapsys` currently copy hooks/scripts but not `lib/`, while hooks require `../lib/...`.
8. Generate hook manifests from adapter metadata, not by blind-copying Claude `hooks.json`.
9. Make `CLAUDE_PLUGIN_ROOT` a private backward-compat alias only. Runtime code should call `runtime.paths.pluginRoot()`.

## Source Layout Proposal

Add:

```text
plugins/shared/runtime/
  index.js
  canonical-event.js
  canonical-tool.js
  adapters/
    claude.js
    codex.js

plugins/shared/storage/
  stores.js

plugins/shared/packaging/
  convert.js
  schema.js
```

Then migrate plugins incrementally:

```text
plugins/heimdall/lib/guard/evaluate.js
  receives canonical tool/write data

plugins/synapsys/lib/matcher.js
  receives canonical event/tool data

plugins/work/scripts/workflows/*
  emits structured delegates

plugins/maestro/scripts/*
  uses RuntimeSessionManager
```

## Migration Order

1. Fix packaging installation path.
   Point Codex installs to `codex-plugins/*`, not `plugins/*`, and validate generated packages. This addresses the immediate invalid `SKILL.md` startup errors.

2. Add the shared adapter types and a `ClaudeAdapter`.
   The first adapter should preserve existing behavior so current Claude plugin behavior remains stable.

3. Add `CodexAdapter.tools.extractWriteTargets()`.
   Support `apply_patch`, `exec_command`, and any Codex-native edit surface. This proves the `codex.getWritePatterns()` concept.

4. Port Heimdall to canonical events.
   This creates the first real runtime-agnostic enforcement path.

5. Port Synapsys hook dispatch and tool-content matching.
   Replace `payload.tool_name` / `payload.tool_input` usage with canonical event access.

6. Port workflow hook boundaries.
   Normalize `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, and `PreCompact`. Replace stdout injection with `runtime.hooks.injectContext()`.

7. Make work delegates structured at the source.
   Stop emitting/parsing `Task(...)` and `Skill(...)` in core workflow logic. Keep a Claude renderer and a Codex dispatcher.

8. Move tool/MCP names into capability mapping.
   Prompts and validators should ask for capabilities like `browser.screenshot`, `jira.getIssue`, `linear.getIssue`, not concrete runtime tool names.

9. Port session identity and transcript logic.
   Replace `CLAUDE_CURRENT_AGENT`, `CLAUDE_CODE_SESSION_ID`, `/subagents/`, and Claude JSONL assumptions with adapter methods.

10. Refactor Maestro last.
    It needs runtime session orchestration, not just event/tool normalization.

## Decision Points

1. Should runtime-agnostic storage use `.agent/`, `.work-workflow/`, `.codex/`, or continue reading `.claude/` as a compatibility tier?

   Recommendation: read existing `.claude` stores for backward compatibility, but write new runtime-neutral stores under a configurable root returned by `runtime.storage.storeDirs()`.

2. Should memory trigger syntax keep Claude names?

   Recommendation: keep existing syntax as aliases, but normalize to canonical tool kinds internally. For example, `Edit`, `Write`, `MultiEdit`, and Codex `apply_patch` all become canonical `Write`.

3. Should Codex packages include hooks before they are fully ported?

   Recommendation: only include hooks that have a working Codex adapter implementation. Unsupported hooks should be documented but not installed as active hooks.

4. Should `CLAUDE_PLUGIN_ROOT` remain?

   Recommendation: keep it temporarily as an internal alias in `ClaudeAdapter.compatEnv()` and `CodexAdapter.compatEnv()`, but remove it from generated docs, skills, and new code.

## Success Criteria

- Codex startup loads all generated skills without YAML errors.
- Generated Codex packages have `.codex-plugin/plugin.json` and include all required runtime modules.
- Heimdall blocks Codex `apply_patch` edits to protected files the same way it blocks Claude `Write/Edit/MultiEdit`.
- Synapsys can trigger on Codex write/shell events without direct references to `tool_name` or `tool_input`.
- Work workflow emits structured delegates independent of `Task(...)` / `Skill(...)`.
- Claude behavior remains unchanged through `ClaudeAdapter`.
- Runtime-specific strings are isolated to adapter implementations and packaging profiles.
