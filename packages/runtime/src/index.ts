/**
 * `@browsermind/runtime` — worker management, extension bridge and MCP.
 */
export { BrowserAIRuntime, type BrowserAIRuntimeOptions, type SendMessageRequest, type GetResponseRequest } from './runtime.js';
export { ExtensionBridge, type ExtensionBridgeOptions, type ExtensionClient } from './extension-bridge.js';
export { createSimulatorProvider, type SimulatorHandle } from './simulator.js';
export { createRuntimeApi, httpErrorPayload, type RuntimeApi, type RpcParams } from './rpc-api.js';
export { createMcpServer, type McpServerHandle, type McpServerOptions } from './mcp/server.js';
export { startHttpServer, type HttpServerHandle } from './http.js';
export { BRAND, TOOL_NAMES, toolCatalog } from './tool-catalog.js';
export { runDemo, type DemoReport } from './demo.js';
