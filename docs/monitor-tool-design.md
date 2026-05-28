# Monitor Tool Design

This document defines the first pi implementation of a Claude Code style
Monitor tool: a background command whose stdout lines become runtime
notifications that can wake the agent without blocking the active turn.

The design intentionally starts with the interactive/runtime primitive. Plugin
monitors, persistent monitors, and A2A task monitors should build on this later
instead of defining separate notification paths.

## References

- Claude Code tools reference:
  https://code.claude.com/docs/en/tools-reference#monitor-tool
- Claude Code plugins reference, monitor component:
  https://code.claude.com/docs/en/plugins-reference
- Piebald-AI prompt dump for Claude Code Monitor:
  https://github.com/Piebald-AI/claude-code-system-prompts/blob/main/system-prompts/tool-description-background-monitor-streaming-events.md
- MindStudio article on file-based signaling patterns:
  https://www.mindstudio.ai/blog/claude-code-monitor-tool-background-processes

Useful reference points:

- Claude Code describes Monitor as a command that runs in the background and
  feeds each output line back to Claude so it can react mid-conversation.
- Plugin monitors use the same mechanism, run as shell commands for the session
  lifetime, and deliver every stdout line as a notification.
- The Monitor tool prompt treats stdout as the event stream, one line as one
  event, process exit as the end of the watch, and stderr as non-notifying output
  unless the script explicitly redirects it into stdout.

## User Semantics

`monitor` starts a background watch and returns immediately.

```ts
monitor({
  command: string,
  description: string,
  persistent?: boolean,
  timeoutSeconds?: number
})
```

Initial return:

```json
{
  "monitorId": "m_...",
  "status": "running",
  "description": "deployment errors",
  "outputFile": "/tmp/pi-monitor-m_....log"
}
```

The command runs with the same cwd, shell, env, and permission model as Bash.
Each stdout line is an event. Events are batched briefly, then delivered as
notifications. The current conversation keeps going while the monitor runs.

Stopping is not part of the Monitor tool call. It should use the shared task
control surface:

- `task_stop` / `/tasks` once pi has general background tasks.
- A temporary `/monitor-stop <id>` command is acceptable during the first
  implementation if the shared task surface does not exist yet.

## Choosing Monitor vs Bash

In Claude Code, Bash can be run in the background for a single final
completion notification. pi does not currently expose a Bash
`run_in_background` parameter, so the first pi implementation should use
Monitor for both one-shot waits and continuous watches. If pi later adds
background Bash tasks, use Bash for one final notification:

```sh
until grep -q "Ready in" dev.log; do sleep 0.5; done
```

This is a command that exits when the condition is met. With future background
Bash support, it should produce one completion notification.

Use Monitor for one notification per occurrence:

```sh
tail -F logs/app.log | grep --line-buffered -E "ERROR|Traceback|FAILED"
```

Use Monitor for repeated events until a known end:

```sh
while true; do
  status="$(gh pr checks 123 --json name,bucket)"
  echo "$status" | jq -r '.[] | select(.bucket!="pending") | "\(.name): \(.bucket)"'
  echo "$status" | jq -e 'all(.bucket!="pending")' >/dev/null && break
  sleep 30
done
```

Do not use an unbounded command for a single event. A command like `tail -f`
does not naturally exit after the first useful line, so the monitor remains
armed after the event.

## Script Quality Rules

These rules should appear in the tool description because they strongly affect
model behavior.

- stdout is the event stream. Emit only lines the agent should act on.
- stderr is written to the output file and does not notify. Use `2>&1` if stderr
  must be part of the event stream.
- Use `grep --line-buffered` in pipelines. Default pipe buffering can delay
  events.
- Cover terminal states. Silence is not success. Filters for jobs or tests must
  include failure, timeout, cancellation, crash, and success markers.
- Poll remote APIs slowly, usually 30 seconds or more. Local checks can use
  shorter intervals such as 0.5 to 1 second.
- Handle transient network failures in loops, for example with `curl ... || true`.
- Keep output volume low. Raw logs should be filtered. Monitors that emit too
  many events should be auto-stopped.
- Write specific descriptions. The description is shown in notifications and in
  task lists.

## Notification Semantics

Notifications are not user replies. They are system/runtime events delivered
into the agent context.

Use XML-like text because pi already uses text-based prompt disclosure and it is
easy for models to distinguish from normal prose:

```xml
<monitor-notification>
<monitor-id>m_abc123</monitor-id>
<status>event</status>
<description>deployment errors</description>
<output-file>/tmp/pi-monitor-m_abc123.log</output-file>
<event>
ERROR failed to connect to database
</event>
</monitor-notification>
```

Process completion should also notify:

```xml
<monitor-notification>
<monitor-id>m_abc123</monitor-id>
<status>completed</status>
<description>deployment errors</description>
<exit-code>0</exit-code>
<output-file>/tmp/pi-monitor-m_abc123.log</output-file>
</monitor-notification>
```

Failure and stop use `failed` and `stopped`.

Notification delivery rules:

- Notifications are not user messages. Do not model the API as
  `sendUserMessage(notification.text)`.
- Add a dedicated implementation path such as
  `injectRuntimeNotification(notification)`. It may internally reuse parts of
  prompt execution, but it must preserve a distinct notification origin so UI,
  transcript filters, and model instructions can distinguish notifications from
  human input.
- If the agent is idle, the notification can trigger a new turn through this
  notification path.
- If the agent is running, queue the notification and inject it before the next
  model step or after the current turn ends.
- User input has higher priority than monitor notifications.
- A notification is delivered at most once. Once consumed from the runtime queue,
  it is removed and must not be injected again.

## Batching and Rate Limits

Claude Code's prompt dump mentions 200 ms batching. pi should start with the
same rule:

- collect stdout lines for 200 ms;
- combine them into one notification;
- keep original line boundaries inside `<event>`.

Default safety limits:

- `maxLineBytes`: 4096 bytes after sanitization;
- `maxBatchLines`: 20 lines per notification;
- `maxEventsPerMinute`: 60 notifications;
- `maxTotalEvents`: 200 notifications for non-persistent monitors;
- `maxRuntimeMs`: `timeoutSeconds` or 10 minutes for non-persistent monitors;
- `persistent: true`: no runtime timeout and no `maxTotalEvents` cap, but still
  subject to `maxLineBytes`, `maxBatchLines`, `maxEventsPerMinute`, and session
  shutdown cleanup.

These defaults intentionally cap notification count, not total lines. At the
default limits a noisy monitor can still inject up to 1200 lines per minute
(`60 notifications * 20 lines`). That is too much for normal use, so tool
guidance should strongly favor selective filters and the implementation should
leave room for lower default limits after real testing.

When a monitor exceeds output limits, stop it and enqueue a final failed
notification explaining that output volume was too high.

## Runtime Data Model

```ts
type MonitorStatus = "running" | "completed" | "failed" | "stopped";

interface MonitorTask {
  id: string;
  command: string;
  description: string;
  persistent: boolean;
  status: MonitorStatus;
  startedAt: number;
  endedAt?: number;
  exitCode?: number;
  outputFile: string;
  lineCount: number;
  notificationCount: number;
  lastEvent?: string;
  error?: string;
}

interface RuntimeNotification {
  id: string;
  kind: "monitor";
  createdAt: number;
  targetAgentId?: string;
  text: string;
  source: {
    monitorId: string;
  };
}
```

Snapshot additions:

```ts
snapshot.monitors = {
  active: MonitorTask[],
  recent: MonitorTask[]
}

snapshot.run.pendingNotifications = RuntimeNotification[]
```

Runtime events:

```ts
| { type: "monitor_started"; monitor: MonitorTask }
| { type: "monitor_output"; monitorId: string; lineCount: number; preview: string }
| { type: "monitor_ended"; monitor: MonitorTask }
| { type: "notification_queued"; notification: RuntimeNotification }
| { type: "notification_delivered"; notificationId: string }
```

`monitor_output.preview` is for UI only. It should be a truncated preview of the
batched stdout lines that produced the notification, not the monitor's full
output.

## Implementation Plan

### 1. Notification Queue

Add a runtime-owned notification queue before adding the tool.

Files likely involved:

- `packages/coding-agent/src/core/agent-session.ts`
- `packages/coding-agent/src/core/agent-runtime-snapshot.ts`
- `packages/coding-agent/src/core/runtime-client.ts`
- `packages/coding-agent/src/core/runtime-ipc.ts`
- `packages/coding-agent/src/core/ipc-runtime-client.ts`
- `packages/coding-agent/src/modes/runtime-attach-mode.ts`

Required behavior:

- `enqueueRuntimeNotification(notification)` appends to queue.
- `injectRuntimeNotification(notification)` is the only path that delivers a
  notification into the model context. It must tag the injected content as a
  runtime notification rather than human input.
- If idle, the notification drain may trigger `injectRuntimeNotification`.
- If running, it waits.
- Queue draining must not recurse infinitely if a notification-triggered turn
  creates another notification.
- Snapshot and attach TUI expose pending notifications.

### 2. Monitor Manager

Create `packages/coding-agent/src/core/monitor-manager.ts`.

Responsibilities:

- spawn shell commands using the same shell config/env/cwd as Bash;
- write stdout and stderr to `outputFile`;
- split stdout into lines;
- batch lines for 200 ms;
- construct the monitor notification XML text;
- enqueue monitor notifications;
- enforce output/rate/time limits;
- stop one monitor or all monitors;
- dispose all monitors on session shutdown.

Reuse from existing code where possible:

- `createLocalBashOperations`
- `getShellConfig`
- `getShellEnv`
- `killProcessTree`
- `sanitizeBinaryOutput`
- `stripAnsi`
- `waitForChildProcess`

### 3. Built-in Monitor Tool

Add `createMonitorToolDefinition(cwd, monitorManager)` under
`packages/coding-agent/src/core/tools/monitor.ts`.

Register it with built-in tools:

- include in `ToolName`;
- include in `createAllToolDefinitions`;
- make `--tools monitor` selectable;
- consider whether `createCodingToolDefinitions` should include it by default.

Tool description should include:

- stdout line equals event;
- notifications are not user replies;
- choose Bash for one completion notification;
- choose Monitor for per-occurrence events;
- use line-buffered filters;
- cover terminal states;
- keep output selective;
- use `persistent: true` for session-length watches.

### 4. Task Control

If general task tools are not ready, add temporary commands:

- `/monitors`
- `/monitor-stop <id>`

Do not overbuild this if general background tasks are imminent. The long-term
shape should be shared with `task_list` and `task_stop`.

### 5. Attach TUI

Attach mode should render monitor state from snapshot:

- show active monitor count in status;
- show pending notification count;
- preserve monitor state when switching attached runtime;
- allow stopping monitors through the runtime command surface.

### 6. Tests

Unit tests:

- stdout lines create queued notifications;
- 200 ms batching groups multiple lines;
- stderr writes to output file but does not notify;
- `2>&1` style merged output notifies because it is stdout;
- process exit emits completed/failed notification;
- output volume limit auto-stops;
- `stopMonitor` kills process and emits stopped notification;
- session dispose stops all monitors.

Integration tests:

- model calls monitor tool and receives monitor id immediately;
- notification is queued while the agent is busy;
- notification is injected when idle;
- attach snapshot shows active monitors;
- IPC attach sees monitor events.

Manual smoke tests:

```sh
monitor({
  command: "for i in 1 2 3; do echo event-$i; sleep 0.1; done",
  description: "three test events"
})
```

Expected:

- tool returns immediately;
- one or more batched notifications arrive;
- final completed notification arrives.

```sh
monitor({
  command: "tail -F logs/app.log | grep --line-buffered -E 'ERROR|Traceback|FAILED'",
  description: "application errors",
  persistent: true
})
```

Expected:

- monitor remains running;
- matching lines notify;
- non-matching lines do not notify;
- `/monitor-stop <id>` stops it.

## First Milestone Acceptance

The first implementation is complete when:

- `monitor` is callable as a built-in tool;
- it starts a background command and returns immediately;
- stdout lines become runtime notifications;
- notifications do not interrupt an active turn;
- notifications are eventually injected into the agent context;
- monitor state is visible in snapshot/attach mode;
- monitors can be stopped;
- tests cover line batching, stop, exit, rate limiting, and notification
  delivery.

Do not connect A2A to Monitor until this milestone is stable.
