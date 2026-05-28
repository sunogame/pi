# Local A2A Runtimes

pi's local runtime supervisor can expose a small A2A-style collaboration
surface between local runtime processes. This is intentionally close to A2A's
Agent Card, Message, and Task model, but it uses pi runtime IPC locally instead
of HTTP JSON-RPC.

## Agent Cards

Each runtime may declare its local Agent Card in the frontmatter of its
`AGENTS.md`:

```md
---
name: backend
description: Backend agent. Handles APIs, database schema, persistence bugs, and server integration questions.
---

# Backend Agent
...
```

`name` is the routing key. In supervisor mode it should match the runtime id in
`.pi/runtimes.json`:

```json
{
  "runtimes": [
    { "id": "backend", "cwd": "./backend" },
    { "id": "frontend", "cwd": "./frontend" },
    { "id": "qa", "cwd": "./qa" }
  ]
}
```

If `name` is omitted, pi uses the runtime id. If `name` is present, it must
match the runtime id; pi fails fast on mismatches so model-visible routing names
cannot drift from registry ids. `description` is deliberately free-form; it
should tell peers when this agent is the right target.

pi also parses these A2A-style fields when present, but the default prompt only
discloses the fields the model needs for routing:

- `name`
- `description`
- `defaultInputModes` or `inputModes` (defaults to `["text/plain"]`)
- `defaultOutputModes` or `outputModes` (defaults to `["text/plain"]`)
- `capabilities` (kept in the card object, not emphasized in the prompt)
- `url` (kept for future HTTP A2A adapters, not disclosed in the model prompt)

A2A `skills` are intentionally not used in this phase. They are easy to confuse
with pi/Claude-style local skills, and a plain `description` is enough for
initial routing.

## Prompt Disclosure

When `pi supervisor start` launches runtimes, it passes the supervisor config to
each runtime. The runtime reads all configured `AGENTS.md` frontmatter blocks
and appends a concise discovery section to the system prompt:

```xml
<a2a_rules>
Peer agents are available through A2A-style tools.
Use Agent Cards to choose the right peer. Peer agents are opaque, so include the needed context in every message.
a2a_send_message creates a peer-owned A2A Task. Non-terminal tasks are watched automatically and later produce <a2a-task-notification> runtime notifications.
<receiving>
When you receive an <a2a-message>, answer it directly in the current turn. That assistant response completes the peer-owned Task.
</receiving>
<notifications>
An <a2a-task-notification> is a runtime notification, not a human message.
</notifications>
</a2a_rules>

<available_peer_agents>
  <agent_card name="backend">
    <description>Backend agent. Handles APIs, database schema, persistence bugs, and server integration questions.</description>
    <default_input_modes>text/plain</default_input_modes>
    <default_output_modes>text/plain</default_output_modes>
  </agent_card>
</available_peer_agents>
```

This mirrors pi's existing skill disclosure style: the model gets a short rule
block plus machine-readable XML.

## Tools

When a runtime is started with `--team-config`, pi adds these tools:

- `a2a_list_agent_cards`
- `a2a_send_message`
- `a2a_get_task`
- `a2a_cancel_task`

`a2a_send_message` is the main entry point. It sends a text `Message` to a peer
runtime and returns an A2A `Task` owned by the receiving runtime. In v1, each
receiving runtime executes A2A tasks serially against its single `AgentSession`.
If the runtime is currently handling a normal user prompt, the task remains
queued until the session becomes idle.

By default, `a2a_send_message` is asynchronous and returns quickly with a
submitted or working task. This avoids peer-to-peer deadlocks when multiple
agents message each other at once. With `blocking: true`, the tool waits only
when the receiving runtime can start this specific task immediately. If the
task is queued behind another prompt or A2A task, the call still returns
immediately with `submitted`; the caller should wait for the automatic
`a2a-task-notification` or use `a2a_get_task` for an immediate status refresh.
Do not start a shell `monitor` for A2A tasks. If an immediate task runs longer than `timeoutMs` (default
300000), the tool returns the current task state and the caller should continue
waiting for the automatic notification or fetch status with `a2a_get_task`.

When `a2a_send_message` returns a non-terminal task, pi automatically starts a
A2A task watcher in the sender runtime. The tool result includes
`autoWatcher.status: "started"`, and the sender later receives an
`a2a-task-notification` custom message when the peer task reaches a terminal
state or the watcher times out. This notification triggers a normal follow-up
turn, so the sender model can react without remembering to poll manually.
The watcher attaches to the peer runtime and listens for task-scoped
`a2a_task_changed` events; it does not infer task completion from generic
runtime idle/running state.

Use `a2a_get_task` with `{ agent, taskId }` only for immediate status refreshes
or recovery by id. The task is owned by the receiving runtime, not by the
sender. A task id should be displayed or remembered together with its owner,
for example `qa/<taskId>`.

Use `a2a_cancel_task` only when work should stop. Completion is controlled by
the receiving runtime; callers do not mark peer tasks as done.

Incoming A2A messages are persisted as `custom_message` entries with
`customType: "a2a-message"` and are shown to the receiving model as structured
`<a2a-message>` content. The TUI renders them as peer messages instead of raw
XML, so the receiving transcript can distinguish peer traffic from direct human
input. The receiver should answer directly in the current turn; that assistant
response completes the peer-owned Task and is returned to the sender. The
receiver should not call `a2a_send_message` back to the sender unless it is
starting a separate new task.

## Current Limits

This transport is IPC-based, not a full HTTP A2A server. It currently
supports text messages and text artifacts. `message/stream`, `tasks/resubscribe`,
`tasks/list`, task continuation by `taskId`, structured `input-required`, push
notifications, auth-required flows, and remote HTTP Agent Cards are future
extensions. Task history currently contains the submitted user message plus
status messages and final text artifacts, not the full underlying pi transcript.
Task records are in-memory in the receiving runtime process in this first
version; restarting that runtime clears its task records, while the underlying
transcript remains in the normal pi session history.
