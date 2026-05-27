# Agent Runtime Attach

This document describes the target split between long-running agent runtimes
and the TUI clients that attach to them.

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
    status: "idle" | "running" | "waiting_input" | "compacting" | "error";
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
  | { id: number; type: "approval_requested"; approval: PendingApprovalSnapshot }
  | { id: number; type: "approval_resolved"; approvalId: string }
  | { id: number; type: "input_required"; input: InputRequiredSnapshot }
  | { id: number; type: "input_resolved"; inputId: string }
  | { id: number; type: "extension_event"; namespace: string; payload: unknown }
  | { id: number; type: "compaction_start"; reason: string }
  | { id: number; type: "compaction_end"; reason: string; aborted: boolean }
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

RuntimeClient command surface includes prompt control and session lifecycle:

```ts
interface RuntimeClient {
  attach(options?: { lastSeenEventId?: number }): Promise<AttachResult>;
  prompt(text: string, options?: unknown): Promise<void>;
  abort(): Promise<void>;
  waitForIdle(): Promise<void>;
  newSession(options?: unknown): Promise<{ cancelled: boolean }>;
  switchSession(path: string, options?: unknown): Promise<{ cancelled: boolean }>;
  fork(entryId: string, options?: unknown): Promise<{ cancelled: boolean; selectedText?: string }>;
  importFromJsonl(path: string, cwdOverride?: string): Promise<{ cancelled: boolean }>;
}
```

The first implementation is `InProcessRuntimeClient`, which delegates to the
current `AgentSessionRuntime`. The later `IpcRuntimeClient` uses the same
interface over a transport.

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
