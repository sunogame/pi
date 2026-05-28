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

If `name` is omitted, pi uses the runtime id. `description` is deliberately
free-form; it should tell peers when this agent is the right target.

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
Peer agents are available through local A2A-style tools.
Use Agent Cards to choose the right peer agent for a question or task.
Peer agents are opaque: they do not share your private memory, filesystem, or tools. Include necessary context in your message.
Use a2a_send_message to contact a peer. It returns an A2A Task; use a2a_get_task with the peer name and task id to check status and results. Leave blocking unset for normal peer messages, especially broadcasts. Set blocking=true only when you need to wait for one specific peer before continuing. Use a2a_cancel_task only when the remote task is no longer needed or should stop.

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
immediately with `submitted`; the caller should observe it with `a2a_get_task`
or a monitor. If an immediate task runs longer than `timeoutMs` (default
300000), the tool returns the current task state and the caller should continue
polling with `a2a_get_task`.

Use `a2a_get_task` with `{ agent, taskId }` to fetch status and artifacts. The
task is owned by the receiving runtime, not by the sender. A task id should be
displayed or remembered together with its owner, for example `qa/<taskId>`.

Use `a2a_cancel_task` only when work should stop. Completion is controlled by
the receiving runtime; callers do not mark peer tasks as done.

Incoming A2A messages are wrapped before they are shown to the receiving model,
for example `[A2A message from peer agent "backend"]`, so the receiving
transcript can distinguish peer traffic from direct human input.

## Current Limits

This is a local IPC implementation, not a full HTTP A2A server. It currently
supports text messages and text artifacts. `message/stream`, `tasks/resubscribe`,
`tasks/list`, push notifications, auth-required flows, and remote HTTP Agent
Cards are future extensions. Task history currently contains the submitted user
message plus status messages and final text artifacts, not the full underlying
pi transcript. Task records are in-memory in the receiving runtime process in
this first version; restarting that runtime clears its local task records, while
the underlying transcript remains in the normal pi session history.
