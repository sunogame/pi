# Agent Runtime Attach

This document describes the target split between long-running agent runtimes
and the TUI clients that attach to them.

For user-facing commands and workflows, see
[Runtime Attach Usage](./runtime-attach-usage.md) or
[Runtime Attach 使用说明](./runtime-attach-usage-zh.md).

## Goal

`pi` currently runs one `AgentSession` inside one interactive TUI process. That
works for a single local session, but it makes multi-agent supervision awkward:
the TUI owns the session it renders.

The target model is closer to `tmux`:

- each agent runtime owns its session, transcript, tools, current run, and
  approvals;
- the TUI is a client that can attach, detach, and switch between runtimes;
- attach first transfers a snapshot, then streams ordered events;
- the same protocol should work in-process, over a local socket, and later over
  a remote transport.

## Phase Map

- **Phase 1 - Runtime Attach Core:** complete. Defines runtime snapshots,
  ordered runtime events, attach/replay semantics, the projector, and the
  in-process runtime client/store.
- **Phase 2 - Extension Boundary:** complete. Splits extensions into
  `runtime`, `tui`, `both`, and `legacy` placement so TUI component factories
  and runtime internals do not cross the future IPC boundary. See
  [Phase 2 Extension Boundary](./phase-2-extension-boundary.md).
- **Phase 3 - Single Runtime IPC:** complete for the baseline. Runs one agent
  runtime outside the TUI process, attaches a minimal TUI client to it with
  `--mode attach-ipc`, and validates reconnect/buffer-overflow replay behavior.
  The protocol baseline is defined in
  [Runtime IPC Protocol](./runtime-ipc-protocol.md).
- **Phase 4 - Full TUI Attach:** complete. Replaces the minimal
  `--mode attach-ipc` debug UI with the normal pi transcript/editor/status
  experience backed by `IpcRuntimeClient`. Local-only capabilities such as
  model/auth pickers and legacy extension surfaces stay hidden or disabled
  until they have serializable APIs.
- **Phase 5 - Supervisor / Multi Runtime:** in progress. Phase 5a adds a
  local runtime process registry. Phase 5b adds Unix socket transport for the
  existing Runtime IPC protocol. Phase 5c adds runtime lifecycle commands.
  Phase 5d/5f add attach-mode runtime switching and a multi-runtime status
  strip. Phase 5e/5g add a lightweight supervisor config that can start a set
  of local runtimes. pi-ent integration remains future Phase 5h work.

## Process Model

Local mode can start with all runtimes in one process:

```text
pi org
  supervisor
    agent-runtime backend
    agent-runtime frontend
    agent-runtime qa
  tui
```

The protocol should not depend on that shape. The same runtime should later be
able to run as a process or service:

```text
pi-agent-runtime backend   <->   pi tui
pi-agent-runtime frontend  <->   pi tui
```

## Ownership

The runtime is the source of truth for:

- session file and session tree;
- transcript entries;
- current model, cwd, system prompt, thinking level, and active tools;
- current run state;
- streaming assistant draft;
- active tool executions;
- queued user messages;
- pending approvals and input-required states.

The TUI owns only view state:

- scroll position;
- selected panel/tab;
- local filter/search text;
- terminal dimensions;
- cosmetic expansion state for tool outputs.

The TUI must be able to crash and reattach without corrupting the runtime.

## Attach Flow

```text
TUI -> runtime: attach({ agentId, lastSeenEventId? })
runtime -> TUI: snapshot(eventCursor)
runtime -> TUI: ordered events after eventCursor
```

When `lastSeenEventId` is supplied, the runtime may replay missed events. If
the requested cursor is older than the runtime's retained event buffer, the
client must request a fresh snapshot.

## Snapshot

The snapshot is the authoritative representation of runtime state at the
moment it was taken. It reflects all durable state from `session.jsonl` plus
current run-time state such as the streaming assistant message, active tool
executions, and queued user messages. A client can always rebuild its full
local view from a fresh snapshot, regardless of event buffer availability.

The event stream is an incremental optimization layered on top: events let a
client maintain its view without re-snapshotting on every change. Events are
not the source of truth; the snapshot is.

Snapshot data is semantic state, not rendered TUI components.

```ts
interface AgentRuntimeSnapshot {
  protocolVersion: 1;
  capabilities: string[];
  eventCursor: number;
  agent: {
    agentId: string;
    agentLabel?: string;
    cwd: string;
    model: {
      provider?: string;
      modelId?: string;
      displayName?: string;
    };
    thinkingLevel: string;
    status: "idle" | "running" | "retrying" | "waiting_input" | "compacting" | "error";
  };
  session: {
    sessionId: string;
    sessionFile?: string;
    sessionName?: string;
    sessionDir: string;
    parentSession?: string;
    currentLeafId: string | null;
    createdAt?: string;
  };
  transcript: {
    entries: SessionEntry[];
    currentLeafId: string | null;
  };
  run: {
    runId?: string;
    isStreaming: boolean;
    isBashRunning: boolean;
    streamingMessage?: AgentMessage;
    retryAttempt: number;
    lastError?: string;
    pendingUserMessages: Array<{
      kind: "steering" | "follow_up";
      text: string;
    }>;
    pendingApprovals: Array<{
      approvalId: string;
      toolCallId?: string;
      toolName?: string;
      title?: string;
      message: string;
      details?: unknown;
    }>;
    inputRequired?: {
      inputId: string;
      question: string;
      details?: unknown;
    };
    activeToolExecutions: Array<{
      toolCallId: string;
      toolName: string;
      input?: unknown;
      status: "pending" | "running" | "completed" | "error" | "aborted";
      outputPreview?: string;
      result?: unknown;
      isError?: boolean;
    }>;
  };
  tools: {
    active: string[];
    available: ToolInfo[];
  };
  resources: {
    skills: Array<{ name: string; description: string; filePath: string }>;
    promptTemplates: Array<{ name: string; description: string; filePath: string }>;
    themes: Array<{ name?: string; sourcePath?: string }>;
    extensions: Array<{ path: string; resolvedPath: string }>;
    agentsFiles: Array<{ path: string }>;
  };
  modelRegistry: {
    available: Array<{ provider?: string; modelId?: string; displayName?: string }>;
    error?: string;
  };
  diagnostics: {
    resources: Array<{ type: string; message: string; path?: string }>;
    extensions: Array<{ path: string; error: string }>;
  };
  config: {
    autoCompaction: boolean;
    steeringMode: "all" | "one-at-a-time";
    followUpMode: "all" | "one-at-a-time";
    scopedModels: Array<{ model: AgentRuntimeModelSnapshot; thinkingLevel?: string }>;
  };
}
```

The current `AgentSession` already owns most of this. The projector must expose
enough state for the TUI to satisfy synchronous reads from a local store instead
of reaching into `AgentSession` directly.

## Events

Events are ordered and identified. They are designed to be transported as
JSON-RPC notifications, JSONL, WebSocket messages, or an in-process callback.

```ts
type AgentRuntimeEvent =
  | { id: number; type: "status_changed"; status: AgentStatus }
  | { id: number; type: "session_changed"; session: SessionSnapshot }
  | { id: number; type: "message_start"; message: AgentMessage }
  | { id: number; type: "message_delta"; message: AgentMessage }
  | { id: number; type: "message_end"; message: AgentMessage }
  | { id: number; type: "tool_start"; tool: ToolExecutionSnapshot }
  | { id: number; type: "tool_update"; toolCallId: string; patch: Partial<ToolExecutionSnapshot> }
  | { id: number; type: "tool_end"; tool: ToolExecutionSnapshot }
  | { id: number; type: "queue_changed"; pendingUserMessages: PendingUserMessage[] }
  | { id: number; type: "commands_changed"; commands: RuntimeCommandSnapshot[] }
  | { id: number; type: "approval_requested"; approval: PendingApprovalSnapshot }
  | { id: number; type: "approval_resolved"; approvalId: string }
  | { id: number; type: "input_required"; input: InputRequiredSnapshot }
  | { id: number; type: "input_resolved"; inputId: string }
  | { id: number; type: "a2a_task_changed"; task: A2ATaskStatusSnapshot }
  | { id: number; type: "extension_event"; namespace: string; payload: unknown }
  | { id: number; type: "compaction_start"; reason: string }
  | {
      id: number;
      type: "compaction_end";
      reason: string;
      result?: CompactionResult;
      aborted: boolean;
      willRetry: boolean;
      errorMessage?: string;
    }
  | { id: number; type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
  | { id: number; type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
  | { id: number; type: "transcript_changed"; reason: "append" | "compaction" | "fork" | "import" }
  | { id: number; type: "error"; message: string };
```

The first implementation should map existing `AgentSessionEvent`s into this
shape without changing the model loop.

`extension_event` is the only protocol-level channel for split extensions.
Runtime extension code emits it with a namespace owned by that extension, and
the TUI half listens for the same namespace. Split extensions should not create
their own sockets or FIFOs.

`session_changed` means the attached session changed, such as `/new`, `/fork`,
or importing a different transcript. `transcript_changed` means the same
session remains attached but the transcript entry sequence changed. v1
producers include appended transcript entries and successful compaction.

## Extension Placement

Extensions must declare where they run:

```ts
type ExtensionPlacement = "runtime" | "tui" | "both";
```

- `runtime` extensions can register tools, modify runtime/provider behavior,
  observe raw runtime hooks, and emit namespaced `extension_event`s.
- `tui` extensions can register widgets, themes, renderers, key handling, and
  TUI-local commands. They consume `AgentRuntimeSnapshot` and
  `AgentRuntimeEvent`; they do not import `AgentSession` or raw agent events.
- `both` extensions are split into a runtime half and a TUI half. The runtime
  half communicates with the TUI half only through namespaced
  `extension_event`s and snapshot state.

Command registration must be split by placement:

```ts
pi.runtime.registerCommand(name, runtimeHandler);
pi.tui.registerCommand(name, tuiHandler);
```

The existing single `registerCommand` shape is ambiguous across a process
boundary. Runtime commands mutate runtime/session state. TUI commands run local
UI flows. Commands that need both sides should be implemented as a TUI command
that calls a runtime command through `RuntimeClient`, or as a runtime command
that emits `extension_event`s for UI updates.

Event hooks also have placement:

- runtime hooks: `before_agent_start`, `agent_end`, `tool_call`,
  `tool_result`, `before_provider_request`, `session_start`,
  `session_shutdown`, `session_before_compact`, and other model/session hooks;
- TUI hooks: raw terminal input, keypresses, view/widget updates, and other
  local UI events.

If a TUI extension needs a low-level runtime hook, it should be split and the
runtime half should forward semantic updates with `extension_event`.

See [Phase 2 Extension Boundary](./phase-2-extension-boundary.md) for the migration
plan, compatibility policy, and completion criteria.

## Runtime Client

The TUI should talk to a `RuntimeClient`, not directly to `AgentSessionRuntime`
or `AgentSession`.

The client has two pieces:

- a local synchronous store derived from the latest snapshot and runtime events;
- asynchronous commands that mutate runtime state.

The store must cover all current TUI synchronous reads:

- `agent`, `session`, `transcript`, `run`, and `tools`;
- `resources` for skills, prompt templates, themes, extensions, and context
  files;
- `modelRegistry` for available models and model loading errors;
- `diagnostics` for resource and extension load issues;
- `config` for queue modes, auto-compaction, and scoped models.

The IPC-safe `RuntimeClient` baseline is intentionally small:

```ts
interface RuntimeClient {
  attach(options?: { lastSeenEventId?: number }): Promise<AttachResult>;
  prompt(text: string, options?: unknown): Promise<void>;
  abort(): Promise<void>;
  waitForIdle(): Promise<void>;
  executeCommand(name: string, args: string): Promise<boolean>;
}
```

`LocalRuntimeClient` extends this with process-local controls such as `bindUI`,
raw `Model<any>` selection, `Transport` object mutation, legacy extension
command context injection, and full tool definitions. Phase 3 IPC clients must
not pretend to support those methods until protocol-specific serializable APIs
exist.

## Phase 4 Full TUI Attach

Phase 4 makes `--mode attach-ipc` use the normal pi TUI instead of the minimal
debug transcript. The target split is:

- `InteractiveMode` owns terminal layout, editor behavior, keybindings,
  markdown/message/tool rendering, and local view state;
- `RuntimeClient` owns runtime state through `snapshot`, ordered events, and
  IPC-safe commands;
- local interactive mode uses `InProcessRuntimeClient`;
- attach mode uses `IpcRuntimeClient`.

Phase 4 is complete when `./pi-test.sh --mode attach-ipc` renders the same
transcript components as normal pi for user messages, assistant streaming,
tool calls, tool results, errors, compaction summaries, and active tool
executions. Any entry point that still requires local-only protocol gaps must
be hidden, disabled, or explicitly marked unsupported rather than reaching
into `AgentSession`.

The Phase 4 attach TUI supports only IPC-safe capabilities:

- `prompt` / `abort` for the main run loop;
- `runtime_commands` for slash commands advertised in `snapshot.commands`;
- `event_replay` for attach/reconnect state repair;
- `extension_events` as the split-extension communication channel.

The following full interactive features remain disabled in attach mode until
their protocol capabilities exist: model/auth pickers, raw bash UI callbacks,
legacy extension shortcuts and message renderers, direct tool definition
inspection, session tree navigation, fork/import/resume flows, and
process-local transport/model mutation.

Phase 4 does not include multi-agent discovery or attach switching. Those are
Phase 5 supervisor responsibilities.

Phase 5a/5b introduce a lower-level process discovery and socket attach path:

```sh
pi --mode runtime-ipc --runtime-id backend
pi --mode attach-ipc --attach backend
```

The first command starts one long-running runtime, listens on a Unix socket,
and writes a registry entry under the agent config directory. The second
command looks up the registry entry and attaches a TUI client to that existing
runtime. `--runtime-socket <path>` can be used on either side to bypass the
default socket path or registry lookup.

The registry is not the supervisor. It is a local discovery aid containing
runtime id, pid, socket path, cwd, session id, protocol version, capabilities,
and current status. Stale entries are removed when lookup finds a dead pid or
missing socket. TUI exit detaches from socket-attached runtimes and does not
shut them down; child-spawn attach mode still owns and terminates its child
runtime.

Phase 5c adds lifecycle commands:

```sh
pi runtime list
pi runtime inspect backend
pi runtime start backend --cwd ./backend --model sonnet --tools read,bash
pi runtime stop backend
```

`runtime start` is a small local process manager: it starts a detached
`--mode runtime-ipc --runtime-id <id>` process, waits for registry
registration, and returns. `runtime stop` connects to the runtime socket and
sends the IPC `shutdown` method.

Phase 5d/5f make attach mode multi-runtime aware:

```text
/runtimes          show registered runtimes
/attach backend    detach current runtime and attach backend
```

`Alt+Right` and `Alt+Left` cycle between registered runtimes.

The attach TUI renders a compact runtime strip from the registry. Switching
rebuilds the local snapshot/store from the newly attached runtime. Existing
runtime processes keep running when the TUI exits.

Phase 5e/5g add a lightweight supervisor config, intentionally separate from
pi-ent:

```json
{
  "runtimes": [
    { "id": "backend", "cwd": "./backend", "model": "sonnet", "tools": ["read", "bash"] },
    { "id": "qa", "cwd": "./qa", "args": ["--no-skills"] }
  ]
}
```

The default path is `.pi/runtimes.json`:

```sh
pi supervisor start
pi supervisor status
pi supervisor start --config ./runtimes.json
```

This is not yet the final long-running supervisor service. It is the first
local supervisor layer: specs turn into detached runtime processes, registry
entries remain the discovery mechanism, and attach-mode TUI can switch among
those runtimes.

## Import Boundary

TUI-side code should import runtime protocol types from
`@earendil-works/pi-coding-agent` only. The coding-agent package re-exports
types such as `AgentMessage`, `SessionEntry`, `ToolInfo`, and runtime snapshot
types. TUI-side code should not directly import `@earendil-works/pi-agent-core`
or `@earendil-works/pi-ai`.

## Transport

IPC should be layered behind a small line-oriented transport:

```ts
interface RuntimeTransport {
  send(line: string): Promise<void>;
  onLine(cb: (line: string) => void): () => void;
  close(): void;
}
```

Stdio and Unix socket implementations should share the same client protocol.
`IpcRuntimeClient` must not assume stdio.

## Threading And Ordering

- Runtime events are totally ordered per runtime and every event has a
  monotonically increasing `id`.
- `attach({ lastSeenEventId })` returns one snapshot plus `initialEvents`. The
  snapshot's `eventCursor` is the last event included in the snapshot state.
- `initialEvents` contains retained events after `lastSeenEventId` and up to
  `snapshot.eventCursor`.
- If `initialEventsComplete` is false, the client must discard local state and
  use the returned snapshot as authoritative.
- Live events delivered after attach have `id > snapshot.eventCursor`.
- A client must ignore duplicate events with `id <= lastAppliedEventId`.

### Reference Attach Pattern

A correct client implementation must dedupe events that arrive both through
`initialEvents` and the live listener because both are delivered around the
attach call:

```ts
const inbox: AgentRuntimeEvent[] = [];
const result = await client.attach({
  lastSeenEventId: lastApplied,
  listener: (event) => inbox.push(event),
});

if (!result.initialEventsComplete) {
  store.replaceFrom(result.snapshot);
  lastApplied = result.snapshot.eventCursor;
} else {
  for (const event of result.initialEvents) {
    if (event.id > lastApplied) {
      store.apply(event);
      lastApplied = event.id;
    }
  }
}

for (const event of inbox) {
  if (event.id > lastApplied) {
    store.apply(event);
    lastApplied = event.id;
  }
}
inbox.length = 0;
```

The `InProcessRuntimeClient` and `IpcRuntimeClient` shipped with pi should
encapsulate this pattern. Users implementing alternative clients must follow
the same dedupe rule.

## Versioning

- `protocolVersion: 1` identifies the snapshot/event contract.
- `capabilities` advertises optional features such as `approval`,
  `input_required`, and `extension_events`. A client must check capabilities
  before enabling optional UI.
- New snapshot fields should be optional unless the protocol version changes.
- Clients must ignore unknown event types and unknown fields.
- Incompatible semantic changes require a new protocol version.
- Future capability negotiation should live under a server/runtime capabilities
  object instead of relying on event probing.

### Capabilities

Each capability defines a specific feature beyond the v1 baseline.

#### `event_replay`

The runtime maintains a bounded in-memory ring buffer of recent runtime events.
Clients may pass `lastSeenEventId` on attach to receive events that occurred
after that cursor without re-applying the full snapshot.

The buffer size is implementation-defined and bounded. Replay is not required
for protocol correctness: a fresh snapshot always reflects the full durable
state. Clients must check `initialEventsComplete` and treat `false` as "buffer
did not cover my cursor; rebuild from snapshot".

Events are not persisted across runtime restarts. After a runtime restart,
`lastSeenEventId` values issued by the previous incarnation are invalid;
clients must attach without `lastSeenEventId` and rebuild from snapshot.

A minimal runtime may omit this capability entirely. In that case clients must
always attach without `lastSeenEventId` and rebuild from snapshot on every
reconnect.

#### `extension_events`

The runtime accepts `emitExtensionRuntimeEvent(namespace, payload)` from
runtime-side extensions and projects them as `extension_event` entries in the
event stream. This is the only sanctioned channel for split (`both`) extensions
to communicate between their runtime half and TUI half.

#### `approval` (future)

Reserved for runtime-level tool approval flows. v1 does not implement this;
`pendingApprovals` is always empty and `approval_*` events never fire.

#### `input_required` (future)

Reserved for runtime-level "needs human input" pauses, such as an agent asking
a clarifying question and stopping. v1 does not implement this;
`inputRequired` is always undefined and `input_*` events never fire.

## TUI Rebuild

On attach, the TUI discards agent-specific render state and rebuilds from the
snapshot:

- render transcript entries into `chatContainer`;
- render active tool executions into pending/tool panels;
- render queued user messages;
- render status/spinner from `agent.status` and `run.isStreaming`;
- start consuming events for incremental updates.

This removes the requirement that a TUI and runtime are born together.

The migration has three sub-stages:

1. `RuntimeClient` and in-process store: route attach and high-level commands
   through a client boundary while behavior remains local.
2. TUI read/write migration: replace direct `AgentSession` reads and writes
   with snapshot/store reads and `RuntimeClient` commands. APIs that currently
   accept rich in-process objects, such as `setModel(Model<any>)`, are local
   adapter APIs only; IPC clients must send stable model references instead.
3. Imperative event handling migration: replace the remaining raw
   `AgentSession.subscribe(handleEvent)` path with a store/runtime-event
   listener so IPC mode does not depend on in-process `AgentSessionEvent`s.

Large derived views should stay lazy. For example, the session tree is fetched
through a `RuntimeClient.getSessionTree()` command instead of being embedded in
every snapshot.

## Transport Stages

1. In-process adapter: `AgentSessionRuntime.getSnapshot()` and
   `AgentSessionRuntime.subscribeRuntimeEvents()`.
2. Local IPC: expose the same protocol over a Unix domain socket or named pipe.
3. Remote transport: expose the same attach protocol over an authenticated
   network channel.
4. Supervisor/service discovery: discover local or remote runtimes and let the
   TUI attach to any runtime.

## Non-goals For The First Cut

- full remote authentication;
- event replay after disconnect;
- multiple concurrent writers to the same runtime;
- remote filesystem sandboxing.

Those are protocol-level concerns, but they should not block the first local
attach refactor.
