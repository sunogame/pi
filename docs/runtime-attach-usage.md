# Runtime Attach Usage

This guide covers the user-facing workflow for running agent runtimes as
separate local processes and attaching a TUI to them.

The model is:

```text
runtime process owns session/transcript/tools/current run
attach TUI is only a view/controller
```

Exiting the attach TUI detaches from the runtime. It does not stop the runtime
unless the TUI started that runtime as its own child process.

## Quick Start

Start one named runtime:

```sh
pi runtime start backend --cwd ./backend --model sonnet --tools read,bash
```

Attach a TUI to it:

```sh
pi --mode attach-ipc --attach backend
```

Inside the attach TUI:

```text
/runtimes          show registered runtimes
/attach backend    attach a specific runtime
/switch qa         alias for /attach qa
/next              cycle to the next registered runtime
/prev              cycle to the previous registered runtime
/broadcast ...     send one prompt to all registered runtimes
/exit              detach this TUI
```

Stop the runtime:

```sh
pi runtime stop backend
```

## Concepts

### Runtime

A runtime is a long-running `pi` process started with `--mode runtime-ipc`.
It owns:

- the session file and transcript;
- current prompt/run state;
- tool calls and active tools;
- queued messages;
- runtime slash commands;
- model/cwd/tools/system prompt configuration.

### Attach TUI

An attach TUI is started with `--mode attach-ipc`. It connects to a runtime,
loads a snapshot, then follows runtime events.

Normal attach exit is detach-only:

- `/exit` detaches;
- `Ctrl-D` detaches;
- closing the TUI detaches;
- the runtime keeps running.

### Registry

Named runtimes register themselves under:

```text
~/.pi/agent/runtimes/<id>.json
~/.pi/agent/runtimes/<id>.sock
```

The JSON file records pid, socket path, cwd, session id, status, protocol
version, capabilities, and timestamps. It is a discovery aid, not the source
of truth. The runtime snapshot is authoritative after attach.

## Starting Runtimes

Start a runtime with the lifecycle command:

```sh
pi runtime start <id> [--cwd <dir>] [--runtime-socket <path>] [runtime flags...]
```

Examples:

```sh
pi runtime start backend --cwd ./backend --model sonnet --tools read,bash
pi runtime start frontend --cwd ./frontend --model gpt-4o
pi runtime start qa --cwd ./qa --no-skills
```

Runtime flags after the id are passed through to the underlying runtime
process. Common flags include:

```sh
--model <model>
--provider <provider>
--tools read,bash,edit
--no-tools
--no-skills
--no-prompt-templates
--no-themes
--extension <path>
--session <path-or-id>
--resume
--continue
```

The command starts a detached process and waits for it to register.

You can still start the low-level runtime process directly:

```sh
pi --mode runtime-ipc --runtime-id backend
```

That terminal is not a TUI. It is the runtime server. Pressing `Ctrl-C` in
that terminal stops the runtime.

## Listing And Inspecting

List live registered runtimes:

```sh
pi runtime list
```

Inspect a runtime:

```sh
pi runtime inspect backend
```

`inspect` prints the registry entry and, when the socket is reachable, the
current runtime snapshot.

Stale registry entries are removed when lookup/list detects that the pid is
dead or the socket is missing.

## Attaching

Attach by runtime id:

```sh
pi --mode attach-ipc --attach backend
```

Attach directly by socket path:

```sh
pi --mode attach-ipc --runtime-socket ~/.pi/agent/runtimes/backend.sock
```

If you run attach mode without a target:

```sh
pi --mode attach-ipc
```

pi keeps the compatibility behavior: it spawns a child `runtime-ipc` process
and owns that child. In this mode, exiting the TUI terminates the child
runtime.

For long-running named runtimes, prefer:

```sh
pi runtime start backend
pi --mode attach-ipc --attach backend
```

## Switching Inside Attach TUI

The attach TUI shows a compact runtime strip from the registry. The current
runtime is highlighted.

Commands:

```text
/runtimes
/attach <id>
/switch <id>
/next
/prev
/broadcast <message>
```

Switching does this:

1. detach from the current runtime;
2. connect to the target runtime socket;
3. request a fresh snapshot;
4. rebuild transcript/status/footer from the target snapshot;
5. continue following target runtime events.

If the target runtime is running a prompt, the TUI shows the target runtime's
current status, streaming message, and active tools from its snapshot/events.

## Broadcasting

From attach TUI, send one prompt to every live registered runtime:

```text
/broadcast Please report your current status.
```

Broadcast currently has simple fire-and-forget semantics:

- enumerate live runtimes from the registry;
- connect to each runtime socket;
- call Runtime IPC `prompt`;
- close the temporary client after the prompt is accepted;
- show delivered/failed runtime ids in the current TUI;
- do not wait for all replies.

Each runtime's reply stays in its own transcript. Use `/attach <id>`, `/next`,
or `/prev` to inspect individual replies.

## Stopping Runtimes

Stop a runtime gracefully:

```sh
pi runtime stop backend
```

This connects to the runtime socket and sends the Runtime IPC `shutdown`
method. The runtime closes its socket, disposes the session, and removes its
registry entry.

If you started the runtime manually in a foreground terminal:

```sh
pi --mode runtime-ipc --runtime-id backend
```

you can also stop it with `Ctrl-C` in that terminal.

If a runtime is unavailable, `pi runtime stop <id>` removes the stale registry
entry and reports the connection failure.

## Supervisor Config

For multiple runtimes, create `.pi/runtimes.json`:

```json
{
  "runtimes": [
    {
      "id": "backend",
      "cwd": "./backend",
      "model": "sonnet",
      "tools": ["read", "bash", "edit"]
    },
    {
      "id": "frontend",
      "cwd": "./frontend",
      "model": "gpt-4o",
      "tools": ["read", "bash", "edit", "write"]
    },
    {
      "id": "qa",
      "cwd": "./qa",
      "args": ["--no-skills"]
    }
  ]
}
```

Start all configured runtimes:

```sh
pi supervisor start
```

Check status:

```sh
pi supervisor status
```

Use a custom config path:

```sh
pi supervisor start --config ./runtimes.json
pi supervisor status --config ./runtimes.json
```

`pi org start` is an alias for `pi supervisor start`.

The current supervisor is intentionally lightweight: it starts configured
runtime processes and relies on the registry for discovery. It is not yet the
final long-running supervisor service.

## Recommended Workflow

For a local multi-agent project:

```sh
mkdir -p .pi
cat > .pi/runtimes.json <<'JSON'
{
  "runtimes": [
    { "id": "backend", "cwd": "./backend", "model": "sonnet", "tools": ["read", "bash", "edit"] },
    { "id": "frontend", "cwd": "./frontend", "model": "sonnet", "tools": ["read", "bash", "edit"] },
    { "id": "qa", "cwd": ".", "model": "sonnet", "tools": ["read", "bash"] }
  ]
}
JSON

pi supervisor start
pi runtime list
pi --mode attach-ipc --attach backend
```

Then use `/next`, `/prev`, or `/attach <id>` inside the TUI.

## Current Limitations

Attach mode currently supports the IPC-safe core:

- prompt;
- abort;
- runtime slash commands advertised by the runtime;
- transcript/status/footer rendering;
- event replay and snapshot resync;
- extension events.

Some local-only interactive features remain disabled until they get
serializable APIs:

- model/auth pickers;
- session tree navigation;
- fork/import/resume flows from the attach TUI;
- legacy extension UI surfaces;
- raw bash UI callbacks;
- full remote tool definition inspection.

Multiple TUI clients can attach to the same runtime, but write ownership is
not locked yet. Treat one TUI as the active writer.

pi-ent integration is not part of this layer yet. That remains the future
Phase 5h work.

## Troubleshooting

### No registered runtimes

```sh
pi runtime list
```

If it prints no runtimes, start one:

```sh
pi runtime start backend
```

### Attach says runtime is unavailable

The registry entry may be stale. Run:

```sh
pi runtime list
```

Lookup removes stale entries automatically. Then start the runtime again.

### Runtime did not register

Check that the cwd exists and that normal pi startup works there:

```sh
cd ./backend
pi --mode runtime-ipc --runtime-id backend
```

If startup exits immediately, fix the model/auth/settings issue shown by that
process.

### Socket path

Default socket path:

```text
~/.pi/agent/runtimes/<id>.sock
```

Explicit socket path:

```sh
pi runtime start backend --runtime-socket /tmp/pi-backend.sock
pi --mode attach-ipc --runtime-socket /tmp/pi-backend.sock
```

### Stop everything from a config

There is not yet a `supervisor stop` command. For now:

```sh
pi runtime list
pi runtime stop backend
pi runtime stop frontend
pi runtime stop qa
```
