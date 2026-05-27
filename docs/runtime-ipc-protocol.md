# Runtime IPC Protocol

This document defines the Phase 3 single-runtime IPC baseline. It is narrower
than the in-process `LocalRuntimeClient`: the first remote client should attach
to one runtime, render its state, send prompts, abort runs, and execute runtime
commands. Model/auth management and legacy extension surfaces remain local
until they get explicit serializable APIs.

## Transport

Phase 3 uses a line-oriented JSON transport. Stdio and Unix sockets should both
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

The IPC `attach` response cannot include an `unsubscribe` function. The client
detaches by sending `detach` or closing the transport.

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
