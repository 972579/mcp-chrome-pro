/**
 * HTTP Server - Core server implementation.
 *
 * Responsibilities:
 * - Fastify instance management
 * - Plugin registration (CORS, etc.)
 * - Route delegation to specialized modules
 * - MCP transport handling
 * - Server lifecycle management
 */
import Fastify, { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import {
  NATIVE_SERVER_PORT,
  TIMEOUTS,
  SERVER_CONFIG,
  HTTP_STATUS,
  ERROR_MESSAGES,
} from '../constant';
import { NativeMessagingHost } from '../native-messaging-host';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { randomUUID } from 'node:crypto';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { Server as McpSdkServer } from '@modelcontextprotocol/sdk/server/index.js';
import { createMcpServer } from '../mcp/mcp-server';
import { NativeMessageType } from 'chrome-mcp-shared';
import { AgentStreamManager } from '../agent/stream-manager';
import { AgentChatService } from '../agent/chat-service';
import { CodexEngine } from '../agent/engines/codex';
import { ClaudeEngine } from '../agent/engines/claude';
import { closeDb } from '../agent/db';
import { registerAgentRoutes } from './routes';
import { isOriginAllowed } from './cors-origin';

// ============================================================
// Types
// ============================================================

interface ExtensionRequestPayload {
  data?: unknown;
}

type McpTransport = StreamableHTTPServerTransport | SSEServerTransport;

interface McpSession {
  transport: McpTransport;
  server: McpSdkServer;
}

function sendRawJsonError(reply: FastifyReply, statusCode: number, message: string): void {
  if (!reply.raw.headersSent) {
    reply.raw.writeHead(statusCode, { 'Content-Type': 'application/json' });
  }
  if (!reply.raw.writableEnded) {
    reply.raw.end(JSON.stringify({ error: message }));
  }
}

// ============================================================
// Server Class
// ============================================================

export class Server {
  private fastify: FastifyInstance;
  public isRunning = false;
  private nativeHost: NativeMessagingHost | null = null;
  private sessionsMap = new Map<string, McpSession>();
  private agentStreamManager: AgentStreamManager;
  private agentChatService: AgentChatService;

  constructor() {
    this.fastify = Fastify({ logger: SERVER_CONFIG.LOGGER_ENABLED });
    this.agentStreamManager = new AgentStreamManager();
    this.agentChatService = new AgentChatService({
      engines: [new CodexEngine(), new ClaudeEngine()],
      streamManager: this.agentStreamManager,
    });
    this.setupPlugins();
    this.setupRoutes();
  }

  /**
   * Associate NativeMessagingHost instance.
   */
  public setNativeHost(nativeHost: NativeMessagingHost): void {
    this.nativeHost = nativeHost;
  }

  private async setupPlugins(): Promise<void> {
    await this.fastify.register(cors, {
      origin: (origin, cb) => cb(null, isOriginAllowed(origin)),
      methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
      credentials: true,
    });
  }

  private setupRoutes(): void {
    // Health check
    this.setupHealthRoutes();

    // Extension communication
    this.setupExtensionRoutes();

    // Agent routes (delegated to separate module)
    registerAgentRoutes(this.fastify, {
      streamManager: this.agentStreamManager,
      chatService: this.agentChatService,
    });

    // MCP routes
    this.setupMcpRoutes();
  }

  // ============================================================
  // Health Routes
  // ============================================================

  private setupHealthRoutes(): void {
    this.fastify.get('/ping', async (_request: FastifyRequest, reply: FastifyReply) => {
      if (!this.nativeHost) {
        return reply.status(HTTP_STATUS.SERVICE_UNAVAILABLE).send({
          status: 'error',
          message: 'Extension bridge not available',
          extensionConnected: false,
        });
      }

      try {
        await this.nativeHost.sendRequestToExtensionAndWait(
          { ping: true },
          NativeMessageType.PROCESS_DATA,
          1500,
        );
        return reply.status(HTTP_STATUS.OK).send({
          status: 'ok',
          message: 'pong',
          extensionConnected: true,
        });
      } catch {
        return reply.status(HTTP_STATUS.SERVICE_UNAVAILABLE).send({
          status: 'error',
          message: 'Chrome extension not connected',
          extensionConnected: false,
        });
      }
    });
  }

  // ============================================================
  // Extension Routes
  // ============================================================

  private setupExtensionRoutes(): void {
    this.fastify.get(
      '/ask-extension',
      async (request: FastifyRequest<{ Body: ExtensionRequestPayload }>, reply: FastifyReply) => {
        if (!this.nativeHost) {
          return reply
            .status(HTTP_STATUS.INTERNAL_SERVER_ERROR)
            .send({ error: ERROR_MESSAGES.NATIVE_HOST_NOT_AVAILABLE });
        }
        if (!this.isRunning) {
          return reply
            .status(HTTP_STATUS.INTERNAL_SERVER_ERROR)
            .send({ error: ERROR_MESSAGES.SERVER_NOT_RUNNING });
        }

        try {
          const extensionResponse = await this.nativeHost.sendRequestToExtensionAndWait(
            request.query,
            'process_data',
            TIMEOUTS.EXTENSION_REQUEST_TIMEOUT,
          );
          return reply.status(HTTP_STATUS.OK).send({ status: 'success', data: extensionResponse });
        } catch (error: unknown) {
          const err = error as Error;
          if (err.message.includes('timed out')) {
            return reply
              .status(HTTP_STATUS.GATEWAY_TIMEOUT)
              .send({ status: 'error', message: ERROR_MESSAGES.REQUEST_TIMEOUT });
          } else {
            return reply.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).send({
              status: 'error',
              message: `Failed to get response from extension: ${err.message}`,
            });
          }
        }
      },
    );
  }

  // ============================================================
  // MCP Routes
  // ============================================================

  private async closeMcpSession(sessionId: string, expected?: McpSession): Promise<void> {
    const session = this.sessionsMap.get(sessionId);
    if (!session || (expected && session !== expected)) return;
    this.sessionsMap.delete(sessionId);

    await session.server.close().catch(() => undefined);
    await session.transport.close().catch(() => undefined);
  }

  private setupMcpRoutes(): void {
    // SSE endpoint
    this.fastify.get('/sse', async (_, reply) => {
      reply.hijack();
      const transport = new SSEServerTransport('/messages', reply.raw);
      const server = createMcpServer();
      const session: McpSession = { transport, server };
      const { sessionId } = transport;

      transport.onclose = () => {
        void this.closeMcpSession(sessionId, session);
      };
      this.sessionsMap.set(sessionId, session);

      try {
        await server.connect(transport);
        reply.raw.write(':\n\n');
      } catch (error) {
        await this.closeMcpSession(sessionId, session);
        sendRawJsonError(
          reply,
          HTTP_STATUS.INTERNAL_SERVER_ERROR,
          ERROR_MESSAGES.INTERNAL_SERVER_ERROR,
        );
      }
    });

    // SSE messages endpoint
    this.fastify.post('/messages', async (req, reply) => {
      const { sessionId } = req.query as { sessionId?: string };
      const session = sessionId ? this.sessionsMap.get(sessionId) : undefined;
      if (!sessionId || !session || !(session.transport instanceof SSEServerTransport)) {
        return reply.code(HTTP_STATUS.BAD_REQUEST).send('No transport found for sessionId');
      }

      reply.hijack();
      try {
        await session.transport.handlePostMessage(req.raw, reply.raw, req.body);
      } catch (error) {
        sendRawJsonError(
          reply,
          HTTP_STATUS.INTERNAL_SERVER_ERROR,
          ERROR_MESSAGES.INTERNAL_SERVER_ERROR,
        );
      }
    });

    // MCP POST endpoint
    this.fastify.post('/mcp', async (request, reply) => {
      const sessionId = request.headers['mcp-session-id'] as string | undefined;
      let session = sessionId ? this.sessionsMap.get(sessionId) : undefined;

      if (
        sessionId &&
        (!session || !(session.transport instanceof StreamableHTTPServerTransport))
      ) {
        return reply.code(HTTP_STATUS.NOT_FOUND).send({ error: ERROR_MESSAGES.INVALID_SESSION_ID });
      }

      if (!session && !sessionId && isInitializeRequest(request.body)) {
        const newSessionId = randomUUID();
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => newSessionId,
          onsessioninitialized: (initializedSessionId) => {
            if (initializedSessionId === newSessionId && session) {
              this.sessionsMap.set(initializedSessionId, session);
            }
          },
        });
        const server = createMcpServer();
        session = { transport, server };
        transport.onclose = () => {
          void this.closeMcpSession(newSessionId, session);
        };
        await server.connect(transport);
      } else if (!session) {
        return reply
          .code(HTTP_STATUS.BAD_REQUEST)
          .send({ error: ERROR_MESSAGES.INVALID_MCP_REQUEST });
      }

      reply.hijack();
      try {
        await (session.transport as StreamableHTTPServerTransport).handleRequest(
          request.raw,
          reply.raw,
          request.body,
        );
        if (!sessionId && !session.transport.sessionId) {
          await session.server.close().catch(() => undefined);
          await session.transport.close().catch(() => undefined);
        }
      } catch (error) {
        if (!sessionId) {
          await session.server.close().catch(() => undefined);
          await session.transport.close().catch(() => undefined);
        }
        sendRawJsonError(
          reply,
          HTTP_STATUS.INTERNAL_SERVER_ERROR,
          ERROR_MESSAGES.MCP_REQUEST_PROCESSING_ERROR,
        );
      }
    });

    // MCP GET endpoint (SSE stream)
    this.fastify.get('/mcp', async (request, reply) => {
      const sessionId = request.headers['mcp-session-id'] as string | undefined;
      if (!sessionId) {
        return reply
          .code(HTTP_STATUS.BAD_REQUEST)
          .send({ error: ERROR_MESSAGES.INVALID_SSE_SESSION });
      }
      const session = this.sessionsMap.get(sessionId);
      if (!session || !(session.transport instanceof StreamableHTTPServerTransport)) {
        return reply
          .code(HTTP_STATUS.NOT_FOUND)
          .send({ error: ERROR_MESSAGES.INVALID_SSE_SESSION });
      }

      reply.hijack();
      try {
        await session.transport.handleRequest(request.raw, reply.raw);
      } catch (error) {
        if (!reply.raw.writableEnded) {
          reply.raw.end();
        }
      }

      request.socket.on('close', () => {
        request.log.info(`SSE client disconnected for session: ${sessionId}`);
      });
    });

    // MCP DELETE endpoint
    this.fastify.delete('/mcp', async (request, reply) => {
      const sessionId = request.headers['mcp-session-id'] as string | undefined;
      if (!sessionId) {
        return reply
          .code(HTTP_STATUS.BAD_REQUEST)
          .send({ error: ERROR_MESSAGES.INVALID_SESSION_ID });
      }
      const session = this.sessionsMap.get(sessionId);
      if (!session || !(session.transport instanceof StreamableHTTPServerTransport)) {
        return reply.code(HTTP_STATUS.NOT_FOUND).send({ error: ERROR_MESSAGES.INVALID_SESSION_ID });
      }

      reply.hijack();
      try {
        await session.transport.handleRequest(request.raw, reply.raw);
      } catch (error) {
        sendRawJsonError(
          reply,
          HTTP_STATUS.INTERNAL_SERVER_ERROR,
          ERROR_MESSAGES.MCP_SESSION_DELETION_ERROR,
        );
      }
    });
  }

  // ============================================================
  // Server Lifecycle
  // ============================================================

  public async start(port = NATIVE_SERVER_PORT, nativeHost: NativeMessagingHost): Promise<void> {
    if (!this.nativeHost) {
      this.nativeHost = nativeHost;
    } else if (this.nativeHost !== nativeHost) {
      this.nativeHost = nativeHost;
    }

    if (this.isRunning) {
      return;
    }

    try {
      await this.fastify.listen({ port, host: SERVER_CONFIG.HOST });

      // Set port environment variables after successful listen for Chrome MCP URL resolution
      process.env.CHROME_MCP_PORT = String(port);
      process.env.MCP_HTTP_PORT = String(port);

      this.isRunning = true;
    } catch (err) {
      this.isRunning = false;
      throw err;
    }
  }

  public async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    try {
      await Promise.allSettled(
        [...this.sessionsMap.keys()].map((sessionId) => this.closeMcpSession(sessionId)),
      );
      await this.fastify.close();
      closeDb();
      this.isRunning = false;
    } catch (err) {
      this.isRunning = false;
      closeDb();
      throw err;
    }
  }

  public getInstance(): FastifyInstance {
    return this.fastify;
  }
}

const serverInstance = new Server();
export default serverInstance;
