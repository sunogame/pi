# Extension Placement 2c

This document defines the extension split required before the runtime/TUI
boundary can move out of process.

## Goal

2c separates extension code by process ownership:

- runtime extensions run with the agent runtime and may use runtime internals;
- TUI extensions run with the interactive client and may render local UI;
- split extensions use a narrow event channel between their two halves.

The split should make `InteractiveMode` stop depending on `AgentSession` and
raw extension runtime objects. It should not introduce supervisor features,
hot reload changes, or remote transport negotiation.

## Placements

Extensions have one placement:

```ts
type ExtensionPlacement = "runtime" | "tui" | "both" | "legacy";
```

- `runtime`: loaded by the agent runtime. Can register tools, runtime
  commands, provider/session hooks, and runtime message render metadata.
- `tui`: loaded by the TUI. Can register widgets, local commands, key/input
  handlers, and local renderers.
- `both`: has one runtime half and one TUI half. The two halves communicate
  through `extension_event` and snapshot state only.
- `legacy`: compatibility mode for extensions that do not declare placement.
  Legacy extensions keep the current in-process behavior and emit migration
  warnings when they use placement-specific APIs. Legacy UI factory APIs are
  not supported across IPC.

`legacy` is a migration bridge, not a target architecture. New extensions
should declare `runtime`, `tui`, or `both`.

## API Shape

Use namespaced APIs rather than flagged calls:

```ts
pi.runtime.registerTool(tool);
pi.runtime.registerCommand(name, options);
pi.runtime.on("session_start", handler);

pi.tui.registerCommand(name, options);
pi.tui.on("input", handler);
pi.tui.setWidget(key, factoryOrLines, options);
```

The old API remains available during migration:

```ts
pi.registerTool(tool);       // deprecated alias for pi.runtime.registerTool
pi.registerCommand(name, options); // deprecated legacy/runtime command
pi.on(event, handler);       // deprecated legacy/runtime hook
```

Deprecation behavior:

- old runtime-safe APIs warn once per extension and keep working;
- old TUI-only APIs warn once per extension and require `legacy` in-process
  mode until the extension declares `tui` or `both`;
- stage 2 IPC must fail loudly for legacy TUI factory APIs instead of silently
  dropping them.

## Contexts

Runtime and TUI handlers receive different contexts.

```ts
interface RuntimeExtensionContext {
  cwd: string;
  sessionManager: SessionManager;
  modelRegistry: ModelRegistry;
  model: Model<any> | undefined;
  signal: AbortSignal;
  isIdle(): boolean;
  getContextUsage(): ContextUsage;
  getSystemPrompt(): string;
  ui: RuntimeExtensionUI;
}

interface RuntimeExtensionUI {
  notify(message: string): void;
  setStatus(message: string): void;
}
```

Runtime extensions do not get widget factories or terminal input APIs. Any UI
operation exposed to runtime code must be serializable and routeable over the
runtime attach protocol.

```ts
interface TuiExtensionContext {
  ui: ExtensionUIContext;
  runtime: RuntimeClient;
  snapshot: AgentRuntimeSnapshot;
}
```

TUI extensions do not get `AgentSession`, `SessionManager`, `ModelRegistry`,
raw model objects, or raw agent events. Runtime mutation goes through
`RuntimeClient`.

## Event Hooks

Runtime hooks are raw runtime/session/model hooks:

- `resources_discover`
- `session_start`, `session_shutdown`
- `session_before_switch`, `session_before_fork`
- `session_before_compact`, `session_compact`
- `session_before_tree`, `session_tree`
- `context`
- `before_provider_request`, `after_provider_response`
- `before_agent_start`, `agent_start`, `agent_end`
- `turn_start`, `turn_end`
- `message_start`, `message_update`, `message_end`
- `tool_execution_start`, `tool_execution_update`, `tool_execution_end`
- `model_select`, `thinking_level_select`
- `tool_call`, `tool_result`
- `user_bash`

TUI hooks are client-side hooks:

- raw terminal input and keypresses;
- view/widget lifecycle;
- local command execution;
- projected runtime events from `AgentRuntimeEvent`.

If a UI feature needs runtime-only data, implement a `both` extension. The
runtime half listens to runtime hooks and emits semantic `extension_event`
payloads. The TUI half listens to those events and renders UI.

## Extension Events

`extension_event` is the only built-in channel between split extension halves:

```ts
pi.runtime.emitExtensionEvent("prompt-url", {
  url,
  title,
  author,
});

pi.tui.on("extension_event", (event, ctx) => {
  if (event.namespace !== "prompt-url") return;
  ctx.ui.setWidget("prompt-url", (_tui, theme) => renderWidget(event.payload, theme));
});
```

Rules:

- payloads must be structured-cloneable JSON-compatible data;
- namespaces are owned by the extension;
- the runtime half must not pass TUI component factories through the event;
- the TUI half must tolerate missing events and rebuild from snapshot where
  possible.

## Commands

Command registration is split:

```ts
pi.runtime.registerCommand("compact", runtimeHandler);
pi.tui.registerCommand("theme", tuiHandler);
```

Runtime commands mutate runtime/session state and run in the runtime process.
TUI commands perform local UI flows and run in the TUI process.

Command discovery should become protocol state:

```ts
interface RuntimeCommandSnapshot {
  name: string;
  description?: string;
  source: "runtime" | "tui";
  placement: "runtime" | "tui";
}
```

The TUI autocomplete merges local TUI commands with runtime commands from the
snapshot. When a user invokes a runtime command, the TUI calls
`RuntimeClient.executeCommand(name, args)`. TUI commands execute locally.

`RuntimeClient.executeCommand` is part of 2c command routing, not the first
type-only step.

## Widget Factories

`setWidget(key, factory)` is TUI-only. Runtime code cannot construct TUI
components, because the runtime may run in another process or host.

Runtime code that wants to affect a widget must emit a semantic event:

```text
runtime hook -> extension_event(namespace, payload) -> TUI widget update
```

String-array widgets may be serializable, but they still belong to TUI
placement unless a future protocol explicitly promotes declarative widgets.
2c does not introduce declarative widgets.

## Supervisor Boundary

`RuntimeClient` attaches to one runtime and controls one transcript/session.

A future `SupervisorClient` should be separate. It can list agents, attach and
detach runtimes, dispatch tasks, and expose task state. It should not be mixed
into `RuntimeClient`.

This matters for multi-agent extensions:

- runtime tools such as `ask_colleague` run against a runtime/supervisor side;
- TUI commands such as attach/focus commands talk to a supervisor client;
- one extension may be `both`, but the client protocols stay separate.

## Migration Order

1. Type layer:
   - add `RuntimeExtensionAPI` and `TuiExtensionAPI`;
   - add `RuntimeExtensionContext` and `TuiExtensionContext`;
   - mark `ExtensionAPI` and `ExtensionContext` legacy/deprecated.
2. Loader placement:
   - classify extensions as `runtime`, `tui`, `both`, or `legacy`;
   - keep runtime extensions on the existing runner;
   - introduce a TUI-side extension runner without runtime internals.
3. Command split:
   - add `pi.runtime.registerCommand` and `pi.tui.registerCommand`;
   - keep old `pi.registerCommand` as deprecated legacy/runtime behavior;
   - add command snapshot and `RuntimeClient.executeCommand`.
4. Extension event test:
   - add a minimal `both` extension fixture;
   - verify runtime event emission reaches the TUI half.
5. Built-in migrations:
   - migrate UI/widget extensions first;
   - migrate multi-agent extensions only after the core API is stable.

## Non-Goals

2c must not add:

- extension hot reload redesign;
- capability negotiation;
- declarative widget protocol;
- supervisor/runtime multi-agent implementation;
- pi-ent migration as part of the first API split;
- model/auth IPC redesign.

Those are later stages.

## Completion Criteria

2c is complete when:

- `InteractiveMode` no longer imports `AgentSession`;
- TUI extension code cannot access `AgentSession`, `SessionManager`,
  `ModelRegistry`, or raw agent events through its typed context;
- runtime extensions cannot call TUI-only widget factory APIs through their
  typed context;
- old extension APIs still work in legacy in-process mode with warnings;
- at least one integration test proves runtime placement, TUI placement, and a
  split `both` extension are routed correctly.
