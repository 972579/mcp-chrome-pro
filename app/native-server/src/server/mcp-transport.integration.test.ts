import { afterAll, beforeAll, describe, expect, jest, test } from '@jest/globals';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import nativeMessagingHostInstance from '../native-messaging-host';
import { Server } from './index';

interface TestClient {
  client: Client;
  transport: StreamableHTTPClientTransport;
}

describe('Streamable HTTP MCP sessions', () => {
  const server = new Server();
  let endpoint: string;
  const extensionRequest = jest.spyOn(nativeMessagingHostInstance, 'sendRequestToExtensionAndWait');
  const clients: TestClient[] = [];

  beforeAll(async () => {
    extensionRequest.mockImplementation(async (payload: any, messageType?: string) => {
      if (messageType === 'rr_list_published_flows') {
        return { status: 'success', items: [] };
      }
      return {
        status: 'success',
        data: {
          content: [{ type: 'text', text: `called:${payload?.name ?? 'unknown'}` }],
        },
      };
    });
    await server.start(0, nativeMessagingHostInstance);
    const address = server.getInstance().server.address();
    if (!address || typeof address === 'string') throw new Error('Server did not bind a TCP port');
    endpoint = `http://127.0.0.1:${address.port}/mcp`;
  });

  afterAll(async () => {
    await Promise.allSettled(
      clients.map(async ({ client, transport }) => {
        await transport.terminateSession().catch(() => undefined);
        await client.close().catch(() => undefined);
      }),
    );
    await server.stop();
    extensionRequest.mockRestore();
  });

  async function connectClient(index: number): Promise<TestClient> {
    const transport = new StreamableHTTPClientTransport(new URL(endpoint));
    const client = new Client(
      { name: `integration-client-${index}`, version: '1.0.0' },
      { capabilities: {} },
    );
    await client.connect(transport);
    const connected = { client, transport };
    clients.push(connected);
    return connected;
  }

  test('three concurrent clients initialize, list tools and call tools independently', async () => {
    const connected = await Promise.all([connectClient(1), connectClient(2), connectClient(3)]);

    const toolLists = await Promise.all(connected.map(({ client }) => client.listTools()));
    for (const tools of toolLists) {
      expect(tools.tools.length).toBeGreaterThan(0);
    }

    const results = await Promise.all(
      connected.map(({ client }) =>
        client.callTool({ name: 'get_windows_and_tabs', arguments: {} }),
      ),
    );
    for (const result of results) {
      expect(result).toMatchObject({
        content: [{ type: 'text', text: 'called:get_windows_and_tabs' }],
      });
    }

    // A later request on the first session proves later connects did not steal
    // its SDK Server transport.
    await expect(connected[0].client.listTools()).resolves.toMatchObject({
      tools: expect.any(Array),
    });
  });

  test.each([
    ['POST', { jsonrpc: '2.0', id: 1, method: 'tools/list' }],
    ['GET', undefined],
    ['DELETE', undefined],
  ])('%s with an unknown session returns 404', async (method, body) => {
    const headers: Record<string, string> = {
      Accept: 'application/json, text/event-stream',
      'Mcp-Session-Id': 'unknown-session',
    };
    if (body) headers['Content-Type'] = 'application/json';
    const response = await fetch(endpoint, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    expect(response.status).toBe(404);
  });

  test('a non-initialize POST without a session remains a 400', async () => {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(response.status).toBe(400);
  });

  test('a known session supports GET SSE and DELETE without duplicate responses', async () => {
    const initializeResponse = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'raw-integration-client', version: '1.0.0' },
        },
      }),
    });
    expect(initializeResponse.status).toBe(200);
    await initializeResponse.text();

    const sessionId = initializeResponse.headers.get('mcp-session-id');
    expect(sessionId).toBeTruthy();
    if (!sessionId) throw new Error('Initialization did not return an MCP session ID');

    const commonHeaders = {
      Accept: 'text/event-stream',
      'Mcp-Protocol-Version': '2025-06-18',
      'Mcp-Session-Id': sessionId,
    };
    const streamResponse = await fetch(endpoint, { headers: commonHeaders });
    expect(streamResponse.status).toBe(200);
    expect(streamResponse.headers.get('content-type')).toContain('text/event-stream');

    const deleteResponse = await fetch(endpoint, {
      method: 'DELETE',
      headers: commonHeaders,
    });
    expect(deleteResponse.status).toBe(200);
    await deleteResponse.body?.cancel();
    await streamResponse.body?.cancel().catch(() => undefined);

    const staleResponse = await fetch(endpoint, {
      method: 'POST',
      headers: {
        ...commonHeaders,
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });
    expect(staleResponse.status).toBe(404);
  });

  test('tool timeouts identify an unresponsive extension', async () => {
    const client = clients[0].client;
    extensionRequest.mockRejectedValueOnce(new Error('Request timed out after 120000ms'));
    const result = await client.callTool({ name: 'get_windows_and_tabs', arguments: {} });
    expect(result).toMatchObject({
      isError: true,
      content: [
        {
          type: 'text',
          text: expect.stringContaining('Chrome extension did not respond before the timeout'),
        },
      ],
    });
  });
});
