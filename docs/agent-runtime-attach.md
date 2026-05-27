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
runtime -> TUI: snapshot
runtime -> TUI: ordered events after the snapshot
```

When `lastSeenEventId` is supported, the runtime may replay missed events. The
first implementation can omit replay and always send a full snapshot.

## Snapshot

Snapshot data is semantic state, not rendered TUI components.

```ts
interface AgentRuntimeSnapshot {
  protocolVersion: 1;
  agent: {
    agentId: string;
    name?: string;
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
    retryAttempt: number;
    pendingUserMessages: Array<{
      kind: "steering" | "follow_up";
      text: string;
    }>;
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
}
```

The current `AgentSession` already owns most of this. The missing piece is a
stable projection that collects event-derived state such as active tool
executions.

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
  | { id: number; type: "compaction_start"; reason: string }
  | { id: number; type: "compaction_end"; reason: string; aborted: boolean }
  | { id: number; type: "error"; message: string };
```

The first implementation should map existing `AgentSessionEvent`s into this
shape without changing the model loop.

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
