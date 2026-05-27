/**
 * Core modules shared between all run modes.
 */

export {
	AgentSession,
	type AgentSessionConfig,
	type AgentSessionEvent,
	type AgentSessionEventListener,
	type ExtensionBindings,
	type ModelCycleResult,
	type PromptOptions,
	type SessionStats,
} from "./agent-session.ts";
export {
	AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	type CreateAgentSessionRuntimeResult,
	createAgentSessionRuntime,
} from "./agent-session-runtime.ts";
export {
	type AgentSessionRuntimeDiagnostic,
	type AgentSessionServices,
	type CreateAgentSessionFromServicesOptions,
	type CreateAgentSessionServicesOptions,
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "./agent-session-services.ts";
export { type BashExecutorOptions, type BashResult, executeBashWithOperations } from "./bash-executor.ts";
export type { CompactionResult } from "./compaction/index.ts";
export { createEventBus, type EventBus, type EventBusController } from "./event-bus.ts";
// Extensions system
export {
	type AgentEndEvent,
	type AgentStartEvent,
	type AgentToolResult,
	type AgentToolUpdateCallback,
	type BeforeAgentStartEvent,
	type BeforeAgentStartEventResult,
	type BuildSystemPromptOptions,
	type ContextEvent,
	defineTool,
	discoverAndLoadExtensions,
	type ExecOptions,
	type ExecResult,
	type Extension,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type ExtensionError,
	type ExtensionEvent,
	type ExtensionFactory,
	type ExtensionFlag,
	type ExtensionHandler,
	type ExtensionManifest,
	type ExtensionPlacement,
	ExtensionRunner,
	type ExtensionShortcut,
	type ExtensionUIContext,
	type LoadExtensionsResult,
	type MessageRenderer,
	type RegisteredCommand,
	type RuntimeExtensionAPI,
	type RuntimeExtensionCommandContext,
	type RuntimeExtensionContext,
	type RuntimeExtensionFactory,
	type RuntimeExtensionHandler,
	type RuntimeExtensionUI,
	type SessionBeforeCompactEvent,
	type SessionBeforeForkEvent,
	type SessionBeforeSwitchEvent,
	type SessionBeforeTreeEvent,
	type SessionCompactEvent,
	type SessionShutdownEvent,
	type SessionStartEvent,
	type SessionTreeEvent,
	type ToolCallEvent,
	type ToolCallEventResult,
	type ToolDefinition,
	type ToolRenderResultOptions,
	type ToolResultEvent,
	type TuiExtensionAPI,
	type TuiExtensionCommandContext,
	type TuiExtensionContext,
	type TuiExtensionFactory,
	type TuiExtensionHandler,
	type TurnEndEvent,
	type TurnStartEvent,
	type WorkingIndicatorOptions,
} from "./extensions/index.ts";
export { createIpcRuntimeClient, IpcRuntimeClient } from "./ipc-runtime-client.ts";
export { attachJsonlLineReader, serializeJsonLine } from "./jsonl.ts";
export {
	AgentRuntimeStore,
	type AgentRuntimeStoreListener,
	createInProcessRuntimeClient,
	InProcessRuntimeClient,
	type LocalRuntimeClient,
	type RuntimeClient,
	type RuntimeClientAttachOptions,
	type RuntimeForkOptions,
	type RuntimeNavigateTreeOptions,
	type RuntimeNavigateTreeResult,
	type RuntimeNewSessionOptions,
	type RuntimeQueueMode,
	type RuntimeSwitchSessionOptions,
} from "./runtime-client.ts";
export {
	type RuntimeIpcAttachResult,
	type RuntimeIpcError,
	type RuntimeIpcErrorCode,
	RuntimeIpcErrorResponse,
	type RuntimeIpcMethod,
	type RuntimeIpcNotification,
	type RuntimeIpcRequest,
	type RuntimeIpcRequestParams,
	type RuntimeIpcResponse,
	type RuntimeIpcResult,
} from "./runtime-ipc.ts";
export { createRuntimeIpcServer, RuntimeIpcServer } from "./runtime-ipc-server.ts";
export {
	createStreamRuntimeTransport,
	type RuntimeTransport,
	RuntimeTransportClosedError,
	StreamRuntimeTransport,
} from "./runtime-transport.ts";
export { createSyntheticSourceInfo } from "./source-info.ts";
