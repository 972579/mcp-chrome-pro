import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export interface HttpMcpClient {
  ping(): Promise<unknown>;
  callTool(request: any, schema?: any, options?: any): Promise<unknown>;
  close(): Promise<void>;
}

export interface HttpMcpTransport {
  readonly sessionId?: string;
  close(): Promise<void>;
}

export interface HttpConnection {
  client: HttpMcpClient;
  transport: HttpMcpTransport;
}

export interface StdioClientManagerOptions {
  loadUrl: () => string;
  connect?: (url: URL) => Promise<HttpConnection>;
  fetch?: typeof fetch;
  log?: (message: string, error?: unknown) => void;
  deleteTimeoutMs?: number;
}

const DEFAULT_CALL_TIMEOUT_MS = 2 * 60 * 1000;

async function connectHttpClient(url: URL): Promise<HttpConnection> {
  const client = new Client({ name: 'Mcp Chrome Proxy', version: '1.0.0' }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(url, {});
  try {
    await client.connect(transport);
    return { client, transport };
  } catch (error) {
    await Promise.allSettled([client.close(), transport.close()]);
    throw error;
  }
}

function errorChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  let current = error;
  for (let depth = 0; current && depth < 5; depth += 1) {
    chain.push(current);
    current = typeof current === 'object' ? (current as { cause?: unknown }).cause : undefined;
  }
  return chain;
}

export function isConnectionError(error: unknown): boolean {
  const chain = errorChain(error);
  const connectionCodes = new Set([
    'ECONNREFUSED',
    'ECONNRESET',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'EPIPE',
    'ETIMEDOUT',
  ]);

  return chain.some((entry) => {
    if (typeof entry !== 'object' || entry === null) return false;
    const code = (entry as { code?: unknown }).code;
    if (typeof code === 'number' && code === 404) return true;
    if (typeof code === 'string' && connectionCodes.has(code.toUpperCase())) return true;
    const message = String((entry as { message?: unknown }).message ?? '');
    return /\bEOF\b|connection (?:is )?closed|client is closing|fetch failed|socket hang up|invalid (?:or missing )?session|session not found/i.test(
      message,
    );
  });
}

function toolError(error: unknown): CallToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: 'text', text: `Error calling tool: ${message}` }],
    isError: true,
  };
}

export class StdioClientManager {
  private readonly loadUrl: () => string;
  private readonly connectClient: (url: URL) => Promise<HttpConnection>;
  private readonly fetchImpl: typeof fetch;
  private readonly log: (message: string, error?: unknown) => void;
  private readonly deleteTimeoutMs: number;
  private connection: HttpConnection | null = null;
  private operationQueue: Promise<void> = Promise.resolve();
  private cleanupPromise: Promise<void> | null = null;
  private cleaningUp = false;

  constructor(options: StdioClientManagerOptions) {
    this.loadUrl = options.loadUrl;
    this.connectClient = options.connect ?? connectHttpClient;
    this.fetchImpl = options.fetch ?? fetch;
    this.log = options.log ?? ((message, error) => console.error(message, error ?? ''));
    this.deleteTimeoutMs = options.deleteTimeoutMs ?? 3000;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation, operation);
    this.operationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async closeConnection(connection: HttpConnection | null): Promise<void> {
    if (!connection) return;
    await connection.client.close().catch(() => undefined);
    await connection.transport.close().catch(() => undefined);
  }

  private async ensureMcpClientLocked(forceNew: boolean): Promise<HttpMcpClient> {
    if (this.cleaningUp) throw new Error('Stdio MCP proxy is shutting down');

    if (this.connection && !forceNew) {
      try {
        await this.connection.client.ping();
        return this.connection.client;
      } catch (error) {
        this.log('[chrome-mcp-stdio] Ping failed, rebuilding HTTP client', error);
      }
    }

    const staleConnection = this.connection;
    this.connection = null;
    await this.closeConnection(staleConnection);

    const url = new URL(this.loadUrl());
    const newConnection = await this.connectClient(url);
    if (this.cleaningUp) {
      await this.closeConnection(newConnection);
      throw new Error('Stdio MCP proxy is shutting down');
    }
    this.connection = newConnection;
    return newConnection.client;
  }

  ensureMcpClient(forceNew = false): Promise<HttpMcpClient> {
    return this.enqueue(() => this.ensureMcpClientLocked(forceNew));
  }

  async callTool(name: string, args: unknown): Promise<CallToolResult> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const client = await this.ensureMcpClient(attempt > 0);
        return (await client.callTool({ name, arguments: args }, undefined, {
          timeout: DEFAULT_CALL_TIMEOUT_MS,
        })) as CallToolResult;
      } catch (error) {
        if (attempt === 0 && isConnectionError(error)) {
          this.log('[chrome-mcp-stdio] Connection failed, retrying once', error);
          continue;
        }
        return toolError(error);
      }
    }
    return toolError(new Error('Connection retry exhausted'));
  }

  cleanup(): Promise<void> {
    if (this.cleanupPromise) return this.cleanupPromise;
    this.cleaningUp = true;
    this.cleanupPromise = this.enqueue(async () => {
      const connection = this.connection;
      this.connection = null;
      const sessionId = connection?.transport.sessionId;

      if (sessionId) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.deleteTimeoutMs);
        timeout.unref?.();
        try {
          const response = await this.fetchImpl(this.loadUrl(), {
            method: 'DELETE',
            headers: { 'Mcp-Session-Id': sessionId },
            signal: controller.signal,
          });
          await response.body?.cancel();
        } catch (error) {
          this.log('[chrome-mcp-stdio] Failed to terminate HTTP session', error);
        } finally {
          clearTimeout(timeout);
        }
      }

      await this.closeConnection(connection);
    });
    return this.cleanupPromise;
  }
}
