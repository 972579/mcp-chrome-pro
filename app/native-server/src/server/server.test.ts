import { afterAll, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import supertest from 'supertest';
import { NativeMessagingHost } from '../native-messaging-host';
import { Server } from './index';

describe('native HTTP health and CORS', () => {
  const bridgeRequest = jest.fn<NativeMessagingHost['sendRequestToExtensionAndWait']>();
  const bridge = { sendRequestToExtensionAndWait: bridgeRequest } as unknown as NativeMessagingHost;
  const server = new Server();

  beforeAll(async () => {
    server.setNativeHost(bridge);
    await server.getInstance().ready();
  });

  beforeEach(() => {
    bridgeRequest.mockReset();
    bridgeRequest.mockResolvedValue({ status: 'success' });
  });

  afterAll(async () => {
    await server.getInstance().close();
  });

  test('GET /ping reports a responsive extension', async () => {
    const response = await supertest(server.getInstance().server).get('/ping').expect(200);
    expect(response.body).toEqual({
      status: 'ok',
      message: 'pong',
      extensionConnected: true,
    });
    expect(bridgeRequest).toHaveBeenCalledWith({ ping: true }, 'process_data', 1500);
  });

  test('GET /ping returns 503 when the extension does not respond', async () => {
    bridgeRequest.mockRejectedValueOnce(new Error('Request timed out after 1500ms'));
    const response = await supertest(server.getInstance().server).get('/ping').expect(503);
    expect(response.body).toEqual({
      status: 'error',
      message: 'Chrome extension not connected',
      extensionConnected: false,
    });
  });

  test('GET /ping returns 503 when no native bridge is attached', async () => {
    const isolatedServer = new Server();
    await isolatedServer.getInstance().ready();
    try {
      const response = await supertest(isolatedServer.getInstance().server)
        .get('/ping')
        .expect(503);
      expect(response.body).toMatchObject({ extensionConnected: false });
    } finally {
      await isolatedServer.getInstance().close();
    }
  });

  test('allows the release extension and exact loopback origins', async () => {
    for (const origin of [
      'chrome-extension://hbdgbgagpkpjffpklnamcljpakneikee',
      'http://127.0.0.1:5173',
    ]) {
      const response = await supertest(server.getInstance().server)
        .get('/ping')
        .set('Origin', origin)
        .expect(200);
      expect(response.headers['access-control-allow-origin']).toBe(origin);
    }
  });

  test('does not grant CORS to a loopback-prefix attacker origin', async () => {
    const response = await supertest(server.getInstance().server)
      .get('/ping')
      .set('Origin', 'http://127.0.0.1.evil.example:12306')
      .expect(200);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });
});
