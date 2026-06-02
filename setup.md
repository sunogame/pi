# Pi A2A Team Setup Guide

This guide is for an AI coding agent that needs to initialize a local pi A2A team for a workspace.

The goal is to turn a user's team description into a runnable pi supervisor setup:

- a workspace-level `.pi/runtimes.json`
- one runtime per role
- one `AGENTS.md` Agent Card per runtime
- enough role instructions for each agent to collaborate through A2A

This is a general setup guide. Examples are illustrative; adapt ids, paths, models, and descriptions to the user's actual project.

## Core Concepts

pi A2A teams are local multi-agent runtimes.

- A runtime is one long-running pi agent process.
- The attach TUI is only a debugger/viewer; it can attach to any live runtime.
- `pi supervisor start` starts all configured runtimes.
- Each runtime owns its own session, transcript, tools, cwd, model, and context.
- Agents discover teammates from Agent Cards in each runtime's `AGENTS.md`.
- Agents communicate with A2A tools such as `a2a_send_message`, returning peer-owned tasks.

Current convention: create one runtime per role, and give each runtime its own `cwd`. Do not configure multiple runtimes with the same `cwd`; use a separate checkout or worktree if the user needs separate identities over the same codebase.

## Inputs To Collect

Before writing files, extract or ask for:

- workspace root
- team members / roles
- each member's `cwd`
- each member's model
- which member, if any, coordinates the team
- peer-facing routing description for each member

Use sensible defaults only when they are obvious. If a required `cwd` or role is ambiguous, ask before creating files.

## Output Files

Create these files:

```text
<workspace>/.pi/runtimes.json
<workspace>/<member-cwd>/AGENTS.md
```

If a runtime `cwd` directory does not exist, create it only if that matches the user's intent. In a real codebase, missing directories usually mean the path was typed wrong, so confirm first.

Do not overwrite meaningful existing `AGENTS.md` content. If an `AGENTS.md` already exists:

- preserve its existing body
- add or update only the YAML frontmatter Agent Card fields
- keep project-specific instructions intact

## Runtime IDs And Agent Card Names

Choose stable ASCII ids. These ids are the routing names used by A2A tools and the generated Agent Card names.

Good ids:

```text
coordinator
frontend
backend
qa
game-dev
data
ops
docs
```

Avoid display names, spaces, emoji, and localized labels as ids. Put natural names and responsibilities in `description`, not in the id.

Terminology:

- In `.pi/runtimes.json`, the field is `id`.
- pi uses that `id` as the Agent Card `name` shown to peer agents.
- `AGENTS.md` frontmatter `name`, `id`, and `role` are ignored for local routing.

Example:

```json
{ "id": "backend", "cwd": "./server", "model": "deepseek-v4-pro" }
```

The matching `server/AGENTS.md` only needs a routing description:

```md
---
description: Backend engineer for the server workspace. Contact for API design, persistence, data models, server-side integration, config, production defects, and questions that require reading or changing backend code. Not the owner for client UI or test planning unless backend behavior is involved.
---
```

Use `id` when configuring, attaching, or sending A2A messages. Do not ask users to keep a second `name` field in `AGENTS.md` synchronized.

## Supervisor Config

Create `.pi/runtimes.json` at the workspace root.

General shape:

```json
{
  "runtimes": [
    {
      "id": "coordinator",
      "cwd": "./docs",
      "model": "model-name"
    },
    {
      "id": "frontend",
      "cwd": "./frontend",
      "model": "model-name"
    },
    {
      "id": "backend",
      "cwd": "./backend",
      "model": "model-name"
    },
    {
      "id": "qa",
      "cwd": "./qa",
      "model": "model-name"
    }
  ]
}
```

Rules:

- `id` is the A2A routing key.
- `cwd` is relative to the workspace root.
- Do not configure multiple runtimes with the same `cwd`; use a separate checkout or worktree if you need separate identities.
- `model` is passed to pi as `--model <model>`.
- If a model name may be ambiguous, use a provider-qualified reference from `pi --list-models`.
- Do not add `tools` unless the user explicitly asks for tool restrictions.
- Do not add custom `args` unless needed for session behavior or the user asks for it.

Supervisor-started runtimes restore the last known session when possible, then fall back to `--continue`.

## Agent Cards

Each runtime's `AGENTS.md` should start with YAML frontmatter:

```md
---
description: Frontend engineer for the client workspace. Contact for UI behavior, screens, interaction flows, client state, assets, protocol integration, and bugs that require reading or changing frontend code. Ask backend for server contracts and QA for test strategy.
---

# Frontend Engineer

You are the frontend engineer for this project.

Describe the role, what this agent should focus on, and which teammates it should contact for common cross-role questions.
```

Required fields:

- `description`: free-form routing description for peer agents

The `description` is the most important Agent Card field. Peer agents read it to decide when to send A2A tasks to this runtime. Write it as a compact routing card, not as a slogan.

A good `description` should usually include:

- role identity: what this agent is
- workspace scope: which codebase, product area, or domain it owns
- positive routing signals: tasks that should be sent to this agent
- project-specific signals: directories, systems, APIs, workflows, or domain terms discovered from existing instructions
- boundaries: common tasks that should go to another teammate instead

Keep it one paragraph, normally 2-4 sentences. It should be specific enough that another agent can choose between teammates without opening the target workspace. Avoid vague descriptions like "handles frontend work" unless the team is so small that no ambiguity exists.

Good examples:

```md
description: Backend engineer for the payment service. Contact for payment APIs, database schema, settlement jobs, provider integration, server config, and production defects rooted in backend behavior. Ask frontend for checkout UI issues and QA for regression planning.
```

```md
description: QA engineer for fake-client and release validation. Contact for test plans, regression coverage, contract checks, reproduction steps, risk assessment, and validation using the fake-client workspace. Ask backend/frontend owners for code changes unless the task is test implementation.
```

Weak examples:

```md
description: Backend agent.
description: Handles code.
description: Responsible for tests.
```

Avoid over-structuring role metadata. Usually `description` is enough. Do not invent fields such as `responsibilities`, `handoff`, or `notes` unless the project already uses them.

### Updating Existing `AGENTS.md`

Always read an existing `AGENTS.md` before editing it.

When an `AGENTS.md` already exists, derive the `description` from its current content instead of replacing it with a generic role sentence. Look for:

- declared role or project ownership
- important directories, commands, services, protocols, or test workflows
- warnings, constraints, or quality bars that affect handoff
- references to other teams or responsibilities that imply routing boundaries

Do not copy the whole instruction body into `description`. Summarize only the parts a peer needs to route work correctly. Preserve detailed operating instructions in the body below the frontmatter.

If it already has YAML frontmatter, update or add only these fields:

```md
---
description: Backend engineer for the server workspace. Contact for server APIs, persistence, integration endpoints, configuration, and production-side bugs. Ask frontend for client UI work and QA for validation planning.
---
```

Preserve any other existing frontmatter fields. Existing `name`, `id`, or `role` fields do not affect local pi A2A routing.

If it has no frontmatter, insert a new frontmatter block at the very top of the file, then keep the existing body below it:

```md
---
description: Backend engineer for the server workspace. Contact for server APIs, persistence, integration endpoints, configuration, and production-side bugs. Ask frontend for client UI work and QA for validation planning.
---

# Existing Project Instructions

...
```

Do not duplicate frontmatter blocks. There should be exactly one YAML frontmatter block at the start of the file.

## Role Instruction Body

After the frontmatter, write normal role instructions.

Good role body content:

- role identity
- scope of ownership
- project-specific directories or workflows
- when to contact each teammate
- quality bar or constraints specific to that role

Keep it practical. The goal is not to write a full employee handbook; the goal is to make each runtime useful and routeable.

## Coordinator Pattern

If the user names a coordinating role, make that runtime the default attach target for team-level work.

The coordinator should:

- break down cross-role tasks
- ask the right peer for focused work
- collect peer responses
- summarize progress for the user
- avoid doing specialist work when another runtime owns it

The coordinator is still a normal runtime. It communicates through A2A like everyone else.

## Commands

From the workspace root:

```sh
pi supervisor start
pi supervisor status
pi --mode attach-ipc --attach <runtime-id>
```

Common attach-mode commands:

```text
/attach <runtime-id>
/runtimes
/broadcast <message>
/load-more
/model
/new
/new-all
/quit
```

Useful validation prompt after attaching to the coordinator:

```text
Ask every teammate to report their current status.
```

The coordinator should use A2A to contact the other live runtimes.

## Validation Checklist

After setup:

1. Check that every runtime `cwd` exists.
2. Check `.pi/runtimes.json` is valid JSON.
3. Check every `AGENTS.md` has frontmatter.
4. Check every runtime `id` is unique and stable.
5. Run `pi supervisor start`.
6. Run `pi supervisor status`.
7. Attach to the coordinator or any target runtime.
8. Ask a team-level test question and confirm A2A messages are sent to peers.

## Example: Four-Role Game Project

User request:

```text
Use setup.md to create a team under superwar-workspace.

The team has four roles: frontend, backend, QA, and game development expert.
The game development expert coordinates the team, cwd is superwar-workspace/doc, model is lw-opus-4.8.
Frontend cwd is superwar-workspace/sw_client, model is deepseek-v4-pro.
Backend cwd is superwar-workspace/super_war, model is deepseek-v4-pro.
QA cwd is superwar-workspace/fake-client, model is deepseek-v4-pro.
```

A good `.pi/runtimes.json` for that request:

```json
{
  "runtimes": [
    {
      "id": "game-dev",
      "cwd": "./doc",
      "model": "lw-opus-4.8"
    },
    {
      "id": "frontend",
      "cwd": "./sw_client",
      "model": "deepseek-v4-pro"
    },
    {
      "id": "backend",
      "cwd": "./super_war",
      "model": "deepseek-v4-pro"
    },
    {
      "id": "qa",
      "cwd": "./fake-client",
      "model": "deepseek-v4-pro"
    }
  ]
}
```

Example Agent Cards:

```md
---
description: Game development expert and team coordinator for the design/doc workspace. Contact for gameplay rules, combat logic, tuning, feature breakdown, product intent, and cross-role coordination across frontend, backend, and QA. Routes implementation details to specialist peers when code ownership is clearer elsewhere.
---
```

```md
---
description: Frontend client engineer for the sw_client workspace. Contact for screens, UI behavior, interaction flows, assets, client state, protocol integration, and frontend bugs. Ask backend for server contract changes and QA for validation strategy.
---
```

```md
---
description: Backend engineer for the super_war workspace. Contact for server logic, APIs, data structures, persistence, configuration, integration endpoints, and server stability issues. Ask frontend for client presentation work and QA for regression coverage.
---
```

```md
---
description: QA engineer for the fake-client workspace. Contact for test planning, regression verification, fake-client validation, API contract checks, test data, reproduction steps, and quality risk feedback. Ask implementation owners for product code changes unless the task is test code.
---
```

These are examples, not fixed templates. Adapt descriptions to the actual team and project.
