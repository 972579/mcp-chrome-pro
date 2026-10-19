import { describe, expect, jest, test } from '@jest/globals';
import { Response } from 'node-fetch';
import {
  createPinnedLookup,
  downloadPublicUrl,
  isPublicIpAddress,
  resolvePublicAddresses,
  ResolvedAddress,
} from './network-security';

describe('public address validation', () => {
  test.each(['8.8.8.8', '93.184.216.34', '1.1.1.1', '2606:4700:4700::1111'])(
    'allows public address %s',
    (address) => expect(isPublicIpAddress(address)).toBe(true),
  );

  test.each([
    '0.0.0.0',
    '10.0.0.1',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.1.1',
    '172.16.0.1',
    '192.168.1.1',
    '198.18.0.1',
    '224.0.0.1',
    '240.0.0.1',
    '::',
    '::1',
    '::ffff:127.0.0.1',
    'fc00::1',
    'fe80::1',
    'ff02::1',
    '2001:db8::1',
  ])('rejects non-public address %s', (address) => {
    expect(isPublicIpAddress(address)).toBe(false);
  });

  test('rejects mixed public and private DNS answers', async () => {
    await expect(
      resolvePublicAddresses(new URL('https://example.test/file'), async () => [
        { address: '2606:4700:4700::1111', family: 6 },
        { address: '10.0.0.8', family: 4 },
      ]),
    ).rejects.toThrow('non-public address');
  });

  test.each(['file:///etc/passwd', 'ftp://example.test/file', 'http://127.0.0.1/a'])(
    'rejects unsafe URL %s',
    async (url) => {
      await expect(resolvePublicAddresses(new URL(url))).rejects.toThrow();
    },
  );
});

describe('pinned downloads', () => {
  test('pins the socket lookup to the address that was validated', async () => {
    let requestAgent: any;
    const fetchMock = jest.fn(async (_url: string, init?: any) => {
      requestAgent = init?.agent;
      return new Response('downloaded', { status: 200 });
    });
    const resolver = jest.fn(
      async (): Promise<ResolvedAddress[]> => [{ address: '93.184.216.34', family: 4 }],
    );

    await expect(
      downloadPublicUrl('https://example.test/file', {
        resolver,
        fetch: fetchMock as any,
      }),
    ).resolves.toEqual(Buffer.from('downloaded'));

    const lookup = requestAgent.options.lookup;
    const result = await new Promise<ResolvedAddress>((resolve, reject) => {
      lookup('example.test', {}, (error: Error | null, address: string, family: 4 | 6) => {
        if (error) reject(error);
        else resolve({ address, family });
      });
    });
    expect(result).toEqual({ address: '93.184.216.34', family: 4 });
    expect(resolver).toHaveBeenCalledTimes(1);
  });

  test('revalidates redirects and blocks a redirect to a private target', async () => {
    const fetchMock = jest.fn(
      async () =>
        new Response('', { status: 302, headers: { location: 'http://internal.test/secret' } }),
    );
    const resolver = async (hostname: string): Promise<ResolvedAddress[]> =>
      hostname === 'public.test'
        ? [{ address: '93.184.216.34', family: 4 }]
        : [{ address: '192.168.1.10', family: 4 }];

    await expect(
      downloadPublicUrl('https://public.test/file', { resolver, fetch: fetchMock as any }),
    ).rejects.toThrow('non-public address');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('stops after five redirects', async () => {
    const fetchMock = jest.fn(
      async (_url: string) => new Response('', { status: 302, headers: { location: '/next' } }),
    );
    const resolver = async (): Promise<ResolvedAddress[]> => [
      { address: '93.184.216.34', family: 4 },
    ];

    await expect(
      downloadPublicUrl('https://public.test/file', { resolver, fetch: fetchMock as any }),
    ).rejects.toThrow('exceeded 5 redirects');
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  test('pinned lookup rejects a different hostname', () => {
    const lookup = createPinnedLookup('example.test', { address: '93.184.216.34', family: 4 });
    expect(() =>
      lookup('attacker.test', {}, (error: Error | null) => {
        if (error) throw error;
      }),
    ).toThrow('Unexpected DNS lookup');
  });
});
