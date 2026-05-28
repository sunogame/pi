# Runtime Attach 使用说明

这篇文档说明如何把 agent runtime 作为独立本地进程运行，并用 TUI attach 上去调试和操作。

核心模型是：

```text
runtime 进程拥有 session / transcript / tools / current run
attach TUI 只是 view/controller
```

退出 attach TUI 只是从 runtime detach。除非这个 TUI 自己启动了一个 child runtime，否则退出 TUI 不会停止 runtime。

## 快速开始

启动一个具名 runtime：

```sh
pi runtime start backend --cwd ./backend --model sonnet --tools read,bash
```

attach 一个 TUI：

```sh
pi --mode attach-ipc --attach backend
```

在 attach TUI 内可用：

```text
/runtimes          显示已注册 runtime
/attach backend    attach 到指定 runtime
/switch qa         /attach qa 的别名
/next              切到下一个已注册 runtime
/prev              切到上一个已注册 runtime
/broadcast ...     给所有已注册 runtime 发送同一个 prompt
/exit              detach 当前 TUI
```

停止 runtime：

```sh
pi runtime stop backend
```

## 基本概念

### Runtime

runtime 是一个用 `--mode runtime-ipc` 启动的长进程 `pi`。它拥有：

- session 文件和 transcript；
- 当前 prompt/run 状态；
- tool calls 和 active tools；
- queued messages；
- runtime slash commands；
- model/cwd/tools/system prompt 配置。

### Attach TUI

attach TUI 用 `--mode attach-ipc` 启动。它连接到某个 runtime，先拉取 snapshot，然后持续接收 runtime events。

正常退出 attach TUI 的语义是 detach：

- `/exit` 是 detach；
- `Ctrl-D` 是 detach；
- 关闭 TUI 是 detach；
- runtime 会继续运行。

### Registry

具名 runtime 会注册到：

```text
~/.pi/agent/runtimes/<id>.json
~/.pi/agent/runtimes/<id>.sock
```

JSON 文件会记录 pid、socket path、cwd、session id、status、protocol version、capabilities 和时间戳。它只是发现 runtime
用的辅助信息，不是真正的状态源。attach 后 runtime snapshot 才是权威状态。

## 启动 Runtime

用 lifecycle command 启动 runtime：

```sh
pi runtime start <id> [--cwd <dir>] [--runtime-socket <path>] [runtime flags...]
```

例子：

```sh
pi runtime start backend --cwd ./backend --model sonnet --tools read,bash
pi runtime start frontend --cwd ./frontend --model gpt-4o
pi runtime start qa --cwd ./qa --no-skills
```

`id` 后面的 runtime flags 会透传给底层 runtime 进程。常见 flags：

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

`pi runtime start` 会启动一个 detached process，并等待它完成 registry 注册。

也可以直接启动底层 runtime 进程：

```sh
pi --mode runtime-ipc --runtime-id backend
```

这个终端不是 TUI。它只是 runtime server。你在这个终端里按 `Ctrl-C`，会停止该 runtime。

## 查看与检查

列出当前 live registered runtimes：

```sh
pi runtime list
```

检查某个 runtime：

```sh
pi runtime inspect backend
```

`inspect` 会输出 registry entry；如果 socket 可连接，也会输出当前 runtime snapshot。

当 lookup/list 检测到 pid 已死或 socket 不存在时，stale registry entry 会被自动删除。

## Attach

按 runtime id attach：

```sh
pi --mode attach-ipc --attach backend
```

按 socket path 直接 attach：

```sh
pi --mode attach-ipc --runtime-socket ~/.pi/agent/runtimes/backend.sock
```

如果不指定 attach target：

```sh
pi --mode attach-ipc
```

pi 会保留兼容行为：自动 spawn 一个 child `runtime-ipc` 进程，并由这个 TUI 拥有 child runtime 生命周期。在这种模式下，退出
TUI 会终止 child runtime。

如果你想要长期运行的具名 runtime，推荐：

```sh
pi runtime start backend
pi --mode attach-ipc --attach backend
```

## 在 Attach TUI 内切换 Runtime

attach TUI 会从 registry 渲染一个简洁的 runtime strip。当前 runtime 会高亮。

命令：

```text
/runtimes
/attach <id>
/switch <id>
/next
/prev
/broadcast <message>
```

切换流程：

1. 从当前 runtime detach；
2. 连接目标 runtime socket；
3. 请求新的 snapshot；
4. 用目标 snapshot 重建 transcript/status/footer；
5. 继续接收目标 runtime events。

如果目标 runtime 正在跑 prompt，TUI 会根据它的 snapshot/events 显示当前 status、streaming message 和 active tools。

## Broadcast

在 attach TUI 内，给所有 live registered runtimes 发送同一个 prompt：

```text
/broadcast 请都汇报一下当前状态
```

当前 broadcast 语义很简单，是 fire-and-forget：

- 从 registry 枚举 live runtimes；
- 连接每个 runtime socket；
- 调 Runtime IPC `prompt`；
- prompt 被接受后关闭临时 client；
- 在当前 TUI 显示 delivered/failed runtime ids；
- 不等待所有 runtime 回复完成。

每个 runtime 的回复会留在自己的 transcript 里。用 `/attach <id>`、`/next` 或 `/prev` 查看各自回复。

## 停止 Runtime

优雅停止 runtime：

```sh
pi runtime stop backend
```

这个命令会连接 runtime socket，并发送 Runtime IPC `shutdown` method。runtime 会关闭 socket，dispose session，并删除 registry
entry。

如果你是前台手动启动的 runtime：

```sh
pi --mode runtime-ipc --runtime-id backend
```

也可以在那个终端里按 `Ctrl-C` 停止。

如果 runtime 已不可用，`pi runtime stop <id>` 会删除 stale registry entry，并报告连接失败。

## Supervisor Config

多 runtime 项目可以创建 `.pi/runtimes.json`：

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

启动所有配置的 runtimes：

```sh
pi supervisor start
```

查看状态：

```sh
pi supervisor status
```

使用自定义 config path：

```sh
pi supervisor start --config ./runtimes.json
pi supervisor status --config ./runtimes.json
```

`pi org start` 是 `pi supervisor start` 的别名。

当前 supervisor 是有意做轻的：它负责按配置启动 runtime processes，并依赖 registry 做发现。它还不是最终的长驻 supervisor
service。

## 推荐工作流

本地 multi-agent 项目可以这样用：

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

然后在 TUI 内用 `/next`、`/prev` 或 `/attach <id>` 切换。

## 当前限制

attach mode 目前支持 IPC-safe core：

- prompt；
- abort；
- runtime 宣告的 slash commands；
- transcript/status/footer rendering；
- event replay 和 snapshot resync；
- extension events。

一些 local-only interactive features 还没接 serializable APIs，所以 attach mode 暂时禁用：

- model/auth pickers；
- session tree navigation；
- attach TUI 内的 fork/import/resume flows；
- legacy extension UI surfaces；
- raw bash UI callbacks；
- full remote tool definition inspection。

多个 TUI clients 可以 attach 到同一个 runtime，但目前还没有 write ownership lock。实际使用时，把一个 TUI 当 active writer。

pi-ent integration 还不属于这一层。它是未来 Phase 5h 的工作。

## 排查问题

### 没有已注册 runtime

```sh
pi runtime list
```

如果没有任何 runtime，先启动一个：

```sh
pi runtime start backend
```

### Attach 提示 runtime unavailable

registry entry 可能已经 stale。运行：

```sh
pi runtime list
```

lookup 会自动删除 stale entries。然后重新启动 runtime。

### Runtime 没有完成注册

先检查 cwd 是否存在，以及普通 pi startup 是否能在那个目录工作：

```sh
cd ./backend
pi --mode runtime-ipc --runtime-id backend
```

如果启动后立即退出，修复该进程显示的 model/auth/settings 问题。

### Socket 路径

默认 socket path：

```text
~/.pi/agent/runtimes/<id>.sock
```

显式指定 socket path：

```sh
pi runtime start backend --runtime-socket /tmp/pi-backend.sock
pi --mode attach-ipc --runtime-socket /tmp/pi-backend.sock
```

### 停止 config 里的所有 runtime

目前还没有 `supervisor stop`。现在先逐个停止：

```sh
pi runtime list
pi runtime stop backend
pi runtime stop frontend
pi runtime stop qa
```
