import { describe, expect, jest, test } from '@jest/globals';
import { EventEmitter } from 'node:events';
import { registerShutdownHandlers } from './mcp-server-stdio';
import { HttpConnection, StdioClientManager } from './stdio-client-manager';

function mockConnection(
  options: {
    sessionId?: string;
    ping?: () => Promise<unknown>;
    callTool?: () => Promise<unknown>;
  } = {},
) {
  const client = {
    ping: jest.fn(options.ping ?? (async () => ({}))),
    callTool: jest.fn(options.callTool ?? (async () => ({ content: [] }))),
    close: jest.fn(async () => undefined),
  };
  const transport = {
    sessionId: options.sessionId,
    close: jest.fn(async () => undefined),
  };
  return { connection: { client, transport } as HttpConnection, client, transport };
}

describe('StdioClientManager', () => {
  test('serializes concurrent client creation and reuses one connection', async () => {
    const first = mockConnection();
    const connect = jest.fn(async () => first.connection);
    const manager = new StdioClientManager({
      loadUrl: () => 'http://127.0.0.1:12306/mcp',
      connect,
    });

    const clients = await Promise.all([
      manager.ensureMcpClient(),
      manager.ensureMcpClient(),
      manager.ensureMcpClient(),
    ]);

    expect(connect).toHaveBeenCalledTimes(1);
    expect(clients[0]).toBe(clients[1]);
    expect(clients[1]).toBe(clients[2]);
  });

  test('rebuilds the client after a failed ping', async () => {
    const stale = mockConnection({
      ping: async () => Promise.reject(new Error('connection closed')),
    });
    const fresh = mockConnection();
    const connect = jest
      .fn<() => Promise<HttpConnection>>()
      .mockResolvedValueOnce(stale.connection)
      .mockResolvedValueOnce(fresh.connection);
    const manager = new StdioClientManager({
      loadUrl: () => 'http://127.0.0.1:12306/mcp',
      connect,
    });

    await manager.ensureMcpClient();
    await expect(manager.ensureMcpClient()).resolves.toBe(fresh.client);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(stale.client.close).toHaveBeenCalledTimes(1);
    expect(stale.transport.close).toHaveBeenCalledTimes(1);
  });

  test('reconnects and retries a connection failure exactly once', async () => {
    const stale = mockConnection({
      callTool: async () => Promise.reject(new Error('connection closed: EOF')),
    });
    const fresh = mockConnection({
      callTool: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    });
    const connect = jest
      .fn<() => Promise<HttpConnection>>()
      .mockResolvedValueOnce(stale.connection)
      .mockResolvedValueOnce(fresh.connection);
    const manager = new StdioClientManager({
      loadUrl: () => 'http://127.0.0.1:12306/mcp',
      connect,
    });

    await expect(manager.callTool('get_windows_and_tabs', {})).resolves.toMatchObject({
      content: [{ text: 'ok' }],
    });
    expect(connect).toHaveBeenCalledTimes(2);
    expect(stale.client.callTool).toHaveBeenCalledTimes(1);
    expect(fresh.client.callTool).toHaveBeenCalledTimes(1);
  });

  test('stops after one retry when the rebuilt connection also fails', async () => {
    const first = mockConnection({
      callTool: async () => Promise.reject(new Error('connection closed: EOF')),
    });
    const second = mockConnection({
      callTool: async () =>
        Promise.reject(Object.assign(new Error('socket reset'), { code: 'ECONNRESET' })),
    });
    const connect = jest
      .fn<() => Promise<HttpConnection>>()
      .mockResolvedValueOnce(first.connection)
      .mockResolvedValueOnce(second.connection);
    const manager = new StdioClientManager({
      loadUrl: () => 'http://127.0.0.1:12306/mcp',
      connect,
    });

    await expect(manager.callTool('get_windows_and_tabs', {})).resolves.toMatchObject({
      isError: true,
    });
    expect(connect).toHaveBeenCalledTimes(2);
    expect(first.client.callTool).toHaveBeenCalledTimes(1);
    expect(second.client.callTool).toHaveBeenCalledTimes(1);
  });

  test('does not retry a tool business error', async () => {
    const connection = mockConnection({
      callTool: async () => Promise.reject(new Error('Invalid tool arguments')),
    });
    const connect = jest.fn(async () => connection.connection);
    const manager = new StdioClientManager({
      loadUrl: () => 'http://127.0.0.1:12306/mcp',
      connect,
    });

    await expect(manager.callTool('tool', {})).resolves.toMatchObject({ isError: true });
    expect(connect).toHaveBeenCalledTimes(1);
    expect(connection.client.callTool).toHaveBeenCalledTimes(1);
  });

  test('cleanup sends one bounded DELETE and closes client and transport once', async () => {
    const connection = mockConnection({ sessionId: 'session-123' });
    const fetchMock = jest.fn(async () => new Response(null, { status: 204 }));
    const manager = new StdioClientManager({
      loadUrl: () => 'http://127.0.0.1:12306/mcp',
      connect: async () => connection.connection,
      fetch: fetchMock as typeof fetch,
      deleteTimeoutMs: 3000,
    });
    await manager.ensureMcpClient();

    await Promise.all([manager.cleanup(), manager.cleanup()]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:12306/mcp',
      expect.objectContaining({
        method: 'DELETE',
        headers: { 'Mcp-Session-Id': 'session-123' },
        signal: expect.any(AbortSignal),
      }),
    );
    expect(connection.client.close).toHaveBeenCalledTimes(1);
    expect(connection.transport.close).toHaveBeenCalledTimes(1);
  });
});

describe('stdio shutdown handlers', () => {
  test('stdin end and close trigger cleanup and exit only once', async () => {
    const stdin = new EventEmitter();
    const processEvents = new EventEmitter() as EventEmitter & {
      ppid: number;
      kill: (pid: number, signal: 0) => true;
    };
    processEvents.ppid = 123;
    processEvents.kill = () => true;
    const cleanup = jest.fn(async () => undefined);
    const exit = jest.fn();

    const watchdog = registerShutdownHandlers({
      stdin,
      process: processEvents,
      cleanup,
      exit,
      watchdogIntervalMs: 60_000,
    });
    stdin.emit('end');
    stdin.emit('close');
    await new Promise((resolve) => setImmediate(resolve));

    clearInterval(watchdog);
    expect(watchdog.hasRef()).toBe(false);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  test('parent process disappearance triggers cleanup', async () => {
    const stdin = new EventEmitter();
    const processEvents = new EventEmitter() as EventEmitter & {
      ppid: number;
      kill: (pid: number, signal: 0) => true;
    };
    processEvents.ppid = 456;
    processEvents.kill = () => {
      throw Object.assign(new Error('No such process'), { code: 'ESRCH' });
    };
    const cleanup = jest.fn(async () => undefined);
    const exit = jest.fn();

    const watchdog = registerShutdownHandlers({
      stdin,
      process: processEvents,
      cleanup,
      exit,
      watchdogIntervalMs: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    clearInterval(watchdog);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });
});
