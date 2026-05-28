# Runtime IPC Protocol

This document defines the Phase 3 single-runtime IPC baseline. It is narrower
than the in-process `LocalRuntimeClient`: the first remote client should attach
to one runtime, render its state, send prompts, abort runs, and execute runtime
commands. Model/auth management and legacy extension surfaces remain local
until they get explicit serializable APIs.

The baseline CLI implementation has two process roles:

- `--mode runtime-ipc` starts a runtime process that speaks this JSONL
  protocol on stdio.
- `--mode attach-ipc` starts an IPC-backed TUI client process, spawns a child
  `--mode runtime-ipc` process with the same runtime flags, attaches through an
  `IpcRuntimeClient`, renders the normal pi transcript/editor/footer
  components where protocol data is available, and sends prompts, aborts, and
  runtime commands over IPC.

Phase 5a/5b add a local registry and Unix socket transport without changing the
JSONL method/event protocol:

- `--mode runtime-ipc --runtime-id <id>` starts a long-running runtime socket
  server and registers it under `<agentDir>/runtimes/<id>.json`.
- `--mode runtime-ipc --runtime-id <id> --runtime-socket <path>` uses an
  explicit socket path instead of the default registry path.
- `--mode attach-ipc --attach <id>` looks up the registry entry and connects
  to the existing runtime over its Unix socket.
- `--mode attach-ipc --runtime-socket <path>` connects directly to a socket
  and bypasses registry lookup.
- `--mode attach-ipc` with no attach target keeps the Phase 3 behavior:
  spawn a child stdio runtime and own its lifetime.

`--mode attach-ipc` is intentionally capability-gated: model/auth pickers,
legacy extension UI, and local-only callbacks stay out of the IPC path until
they have explicit serializable APIs.

## Transport

The protocol uses a line-oriented JSON transport. Stdio and Unix sockets both
implement the same abstraction:

```ts
interface RuntimeTransport {
  send(line: string): Promise<void>;
  onLine(cb: (line: string) => void): () => void;
  close(): void;
}
```

Every line is one JSON object. Requests and responses are correlated by `id`;
runtime events are notifications without request-response correlation.

```ts
type RuntimeIpcRequest = {
  id: string;
  method: RuntimeIpcMethod;
  params?: unknown;
};

type RuntimeIpcResponse =
  | { id: string; ok: true; result?: unknown }
  | { id: string; ok: false; error: RuntimeIpcError };

type RuntimeIpcNotification =
  | { type: "runtime_event"; event: AgentRuntimeEvent }
  | { type: "shutdown"; reason?: string };
```

Socket attach is detach-only from the TUI side: closing the client transport
does not shut down the runtime process. Child-spawn attach mode is different:
the TUI owns the child stdio runtime and terminates it when the TUI exits.

## Runtime Registry

The local registry is an implementation detail for discovery. A registry entry
is a JSON file keyed by runtime id:

```ts
type RuntimeRegistryEntry = {
  agentId: string;
  socketPath: string;
  pid: number;
  cwd: string;
  sessionId: string;
  sessionName?: string;
  status: AgentRuntimeStatus;
  protocolVersion: number;
  capabilities: string[];
  createdAt: string;
  updatedAt: string;
};
```

Lookup must treat the entry as stale if the pid is no longer alive or the
socket path is missing, remove it, and report the runtime as unavailable. The
registry is not authoritative runtime state; the attached snapshot remains the
source of truth.

## Baseline Methods

These methods are the Phase 3 IPC-safe `RuntimeClient` surface:

| Method | Params | Result |
| --- | --- | --- |
| `attach` | `{ lastSeenEventId?: number }` | `AgentRuntimeAttachResult` without function fields |
| `detach` | none | `{}` |
| `prompt` | `{ text: string; options?: PromptOptions }` | `{}` |
| `abort` | none | `{}` |
| `waitForIdle` | none | `{}` |
| `executeCommand` | `{ name: string; args: string }` | `{ handled: boolean }` |
| `getSnapshot` | none | `{ snapshot: AgentRuntimeSnapshot }` |
| `shutdown` | none | `{}` |

The IPC `attach` response cannot include an `unsubscribe` function. The client
detaches by sending `detach` or closing the transport.

`getSnapshot` is primarily an internal resynchronization primitive. Clients use
it after events such as `transcript_changed`, where the event identifies that a
fresh authoritative snapshot is required but does not carry the full
transcript.

`shutdown` asks the runtime process to terminate gracefully. Attach-mode TUI
does not call it on normal exit; lifecycle commands such as
`pi runtime stop <id>` do.

## Capabilities

The server advertises feature capabilities through `snapshot.capabilities`.
Phase 3 baseline capabilities:

- `event_replay`: server keeps a bounded event buffer and can replay events
  after `lastSeenEventId`.
- `extension_events`: runtime extensions can emit namespaced
  `extension_event` notifications.
- `runtime_commands`: `snapshot.commands`, `commands_changed`, and
  `executeCommand` are available.
- `prompt`: `prompt` is available.
- `abort`: `abort` is available.
- `a2a`: A2A message/task methods are available on the runtime IPC server.

Reserved future capabilities:

- `session_lifecycle`: remote `newSession`, `switchSession`, `fork`,
  `importFromJsonl`.
- `model_auth`: remote model selection, provider login/logout, scoped models,
  and auth status.
- `legacy_extensions`: remote support for legacy shortcuts, message renderers,
  `user_bash`, and command context injection.
- `bash`: remote interactive bash execution.
- `tool_definitions`: full remote tool definitions for custom rendering.

Clients must hide or disable UI that requires a missing capability.

## Events

`AgentRuntimeEvent` is the event payload. Clients must ignore unknown event
types and unknown fields.

Command list changes are first-class:

```ts
{ id: number; type: "commands_changed"; commands: RuntimeCommandSnapshot[] }
```

`RuntimeCommandSnapshot.placement` distinguishes `runtime` from `legacy`.
Remote clients may show `legacy` commands as unavailable unless
`legacy_extensions` is advertised.

A2A task status changes are task-scoped runtime events:

```ts
{
  id: number;
  type: "a2a_task_changed";
  task: {
    id: string;
    contextId: string;
    owner?: string;
    state: "submitted" | "working" | "completed" | "failed" | "canceled" | string;
    timestamp?: string;
  };
}
```

Clients must match by `task.id`; runtime `status_changed: "idle"` is not a
valid substitute for task completion.

## Attach Replay

`attach({ lastSeenEventId })` returns:

```ts
{
  snapshot: AgentRuntimeSnapshot;
  initialEvents: AgentRuntimeEvent[];
  initialEventsComplete: boolean;
}
```

If `initialEventsComplete` is false, the client must discard local state and
rebuild from `snapshot`. If it is true, the client may apply `initialEvents`
after its last applied event. In both cases, live events must be deduped by
event id.

Phase 3f must test both:

- reconnect with a retained cursor and complete replay;
- reconnect with a cursor older than the buffer and
  `initialEventsComplete: false`.

## Errors

Errors are structured and stable:

```ts
type RuntimeIpcError = {
  code:
    | "unknown_method"
    | "invalid_params"
    | "unsupported"
    | "busy"
    | "aborted"
    | "runtime_error";
  message: string;
  details?: unknown;
};
```

Unsupported local-only methods must return `unsupported`, not silently no-op.

## Local-Only APIs

These remain on `LocalRuntimeClient` and are not part of Phase 3 IPC:

- `bindUI` / `unbindUI` and `commandContextActions` injection;
- `setModel(Model<any>)`, model selector internals, auth storage, login/logout,
  and scoped model resolution;
- `setTransport(Transport)`;
- legacy extension shortcuts, message renderers, and `user_bash`;
- full `ToolDefinition` access and custom tool rendering;
- callback-heavy bash execution APIs.

Runtime extensions that need TUI action should emit `extension_event`; their
TUI half can then call the IPC-safe `RuntimeClient`.
