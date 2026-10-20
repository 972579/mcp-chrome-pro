#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { TOOL_SCHEMAS } from 'chrome-mcp-shared';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { StdioClientManager } from './stdio-client-manager';

let stdioMcpServer: Server | null = null;

export const loadConfig = (): { url: string } => {
  try {
    const configPath = path.join(__dirname, 'stdio-config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as { url?: unknown };
    if (typeof config.url !== 'string') throw new Error('url must be a string');
    return { url: config.url };
  } catch (error) {
    console.error('Failed to load stdio-config.json:', error);
    throw new Error('Configuration file stdio-config.json not found or invalid');
  }
};

const clientManager = new StdioClientManager({ loadUrl: () => loadConfig().url });

export const ensureMcpClient = (forceNew = false) => clientManager.ensureMcpClient(forceNew);

export const setupTools = (server: Server, manager = clientManager): void => {
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_SCHEMAS }));
  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    manager.callTool(request.params.name, request.params.arguments || {}),
  );
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [] }));
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: [] }));
};

export const getStdioMcpServer = (): Server => {
  if (stdioMcpServer) return stdioMcpServer;
  stdioMcpServer = new Server(
    { name: 'StdioChromeMcpServer', version: '1.0.0' },
    { capabilities: { tools: {}, resources: {}, prompts: {} } },
  );
  setupTools(stdioMcpServer);
  return stdioMcpServer;
};

export function cleanupOnce(cleanup: () => Promise<void>): () => Promise<void> {
  let cleanupPromise: Promise<void> | null = null;
  return () => {
    cleanupPromise ??= cleanup();
    return cleanupPromise;
  };
}

interface ShutdownProcess {
  on(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  kill(pid: number, signal: 0): true;
  ppid: number;
}

interface ShutdownInput {
  on(event: 'end' | 'close', listener: () => void): unknown;
}

export function registerShutdownHandlers(options: {
  stdin: ShutdownInput;
  process: ShutdownProcess;
  cleanup: () => Promise<void>;
  exit: (code: number) => void;
  watchdogIntervalMs?: number;
}): NodeJS.Timeout {
  const shutdown = cleanupOnce(async () => {
    try {
      await options.cleanup();
    } finally {
      options.exit(0);
    }
  });
  const requestShutdown = () => void shutdown();

  options.stdin.on('end', requestShutdown);
  options.stdin.on('close', requestShutdown);
  options.process.on('SIGINT', requestShutdown);
  options.process.on('SIGTERM', requestShutdown);

  const parentPid = options.process.ppid;
  const watchdog = setInterval(() => {
    try {
      options.process.kill(parentPid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
        clearInterval(watchdog);
        requestShutdown();
      }
    }
  }, options.watchdogIntervalMs ?? 10_000);
  watchdog.unref();
  return watchdog;
}

export async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  const server = getStdioMcpServer();
  await server.connect(transport);

  registerShutdownHandlers({
    stdin: process.stdin,
    process,
    cleanup: async () => {
      await clientManager.cleanup();
      await server.close().catch(() => undefined);
      await transport.close().catch(() => undefined);
    },
    exit: (code) => process.exit(code),
  });
}

if (require.main === module) {
  main().catch((error) => {
    console.error('Fatal error Chrome MCP Server main():', error);
    process.exit(1);
  });
}
