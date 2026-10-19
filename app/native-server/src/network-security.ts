import { promises as dns } from 'node:dns';
import * as http from 'node:http';
import * as https from 'node:https';
import { isIP } from 'node:net';
import fetch, { RequestInit, Response } from 'node-fetch';

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export type AddressResolver = (hostname: string) => Promise<ResolvedAddress[]>;
export type FetchImplementation = (url: string, init?: RequestInit) => Promise<Response>;

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;

function parseIpv4(address: string): number[] | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  const bytes = parts.map((part) => {
    if (!/^\d{1,3}$/.test(part)) return -1;
    const value = Number(part);
    return value >= 0 && value <= 255 ? value : -1;
  });
  return bytes.every((value) => value >= 0) ? bytes : null;
}

function parseIpv6(address: string): number[] | null {
  let normalized = address.toLowerCase();
  if (normalized.startsWith('[') && normalized.endsWith(']')) normalized = normalized.slice(1, -1);
  const zoneIndex = normalized.indexOf('%');
  if (zoneIndex !== -1) normalized = normalized.slice(0, zoneIndex);

  if (normalized.includes('.')) {
    const lastColon = normalized.lastIndexOf(':');
    const ipv4 = parseIpv4(normalized.slice(lastColon + 1));
    if (lastColon === -1 || !ipv4) return null;
    normalized = `${normalized.slice(0, lastColon)}:${((ipv4[0] << 8) | ipv4[1]).toString(16)}:${((ipv4[2] << 8) | ipv4[3]).toString(16)}`;
  }

  const halves = normalized.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if (halves.length === 1 && left.length !== 8) return null;
  if (halves.length === 2 && left.length + right.length >= 8) return null;

  const groups = [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) {
    return null;
  }
  return groups.flatMap((group) => {
    const value = Number.parseInt(group, 16);
    return [value >> 8, value & 0xff];
  });
}

function matchesPrefix(address: number[], prefix: number[], prefixLength: number): boolean {
  const fullBytes = Math.floor(prefixLength / 8);
  for (let index = 0; index < fullBytes; index += 1) {
    if (address[index] !== prefix[index]) return false;
  }
  const remainingBits = prefixLength % 8;
  if (remainingBits === 0) return true;
  const mask = (0xff << (8 - remainingBits)) & 0xff;
  return (address[fullBytes] & mask) === (prefix[fullBytes] & mask);
}

function isPublicIpv4(address: string): boolean {
  const bytes = parseIpv4(address);
  if (!bytes) return false;
  const blocked: Array<[number[], number]> = [
    [[0, 0, 0, 0], 8],
    [[10, 0, 0, 0], 8],
    [[100, 64, 0, 0], 10],
    [[127, 0, 0, 0], 8],
    [[169, 254, 0, 0], 16],
    [[172, 16, 0, 0], 12],
    [[192, 0, 0, 0], 24],
    [[192, 0, 2, 0], 24],
    [[192, 88, 99, 0], 24],
    [[192, 168, 0, 0], 16],
    [[198, 18, 0, 0], 15],
    [[198, 51, 100, 0], 24],
    [[203, 0, 113, 0], 24],
    [[224, 0, 0, 0], 3],
  ];
  return !blocked.some(([prefix, length]) => matchesPrefix(bytes, prefix, length));
}

function isPublicIpv6(address: string): boolean {
  const bytes = parseIpv6(address);
  if (!bytes) return false;
  const isMappedIpv4 =
    bytes.slice(0, 10).every((value) => value === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  if (isMappedIpv4) return isPublicIpv4(bytes.slice(12).join('.'));

  // Only currently allocated global-unicast space is eligible. This rejects
  // loopback, unspecified, ULA, link-local, multicast and other reserved space.
  if ((bytes[0] & 0xe0) !== 0x20) return false;
  const blocked: Array<[number[], number]> = [
    [parseIpv6('2001::')!, 32],
    [parseIpv6('2001:2::')!, 48],
    [parseIpv6('2001:10::')!, 28],
    [parseIpv6('2001:20::')!, 28],
    [parseIpv6('2001:db8::')!, 32],
    [parseIpv6('2002::')!, 16],
    [parseIpv6('3fff::')!, 20],
  ];
  return !blocked.some(([prefix, length]) => matchesPrefix(bytes, prefix, length));
}

export function isPublicIpAddress(address: string): boolean {
  const normalized = address.replace(/^\[|\]$/g, '');
  const family = isIP(normalized);
  if (family === 4) return isPublicIpv4(normalized);
  if (family === 6) return isPublicIpv6(normalized);
  return false;
}

function normalizeHostname(hostname: string): string {
  return hostname
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase();
}

export const resolveAddresses: AddressResolver = async (hostname) => {
  const normalizedHostname = normalizeHostname(hostname);
  const literalFamily = isIP(normalizedHostname);
  if (literalFamily === 4 || literalFamily === 6) {
    return [{ address: normalizedHostname, family: literalFamily }];
  }
  const records = await dns.lookup(normalizedHostname, { all: true, verbatim: true });
  return records.map((record) => ({ address: record.address, family: record.family as 4 | 6 }));
};

export async function resolvePublicAddresses(
  url: URL,
  resolver: AddressResolver = resolveAddresses,
): Promise<ResolvedAddress[]> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only HTTP and HTTPS file URLs are allowed');
  }
  if (url.username || url.password) throw new Error('Credentials are not allowed in file URLs');

  const hostname = normalizeHostname(url.hostname);
  const addresses = await resolver(hostname);
  if (addresses.length === 0) throw new Error(`No IP addresses resolved for ${hostname}`);
  for (const resolved of addresses) {
    if (isIP(resolved.address) !== resolved.family || !isPublicIpAddress(resolved.address)) {
      throw new Error(`File URL resolves to a non-public address: ${resolved.address}`);
    }
  }
  return addresses;
}

export function createPinnedLookup(hostname: string, resolved: ResolvedAddress) {
  const expectedHostname = normalizeHostname(hostname);
  return (lookupHostname: string, options: any, callback: any): void => {
    if (normalizeHostname(lookupHostname) !== expectedHostname) {
      callback(new Error(`Unexpected DNS lookup for ${lookupHostname}`));
      return;
    }
    if (options && typeof options === 'object' && options.all) {
      callback(null, [resolved]);
      return;
    }
    callback(null, resolved.address, resolved.family);
  };
}

function createPinnedAgent(url: URL, resolved: ResolvedAddress): http.Agent | https.Agent {
  const options = { lookup: createPinnedLookup(url.hostname, resolved) };
  return url.protocol === 'https:' ? new https.Agent(options) : new http.Agent(options);
}

function discardResponseBody(response: Response): void {
  const body = response.body as
    | (NodeJS.ReadableStream & { destroy?: () => void; cancel?: () => Promise<void> })
    | null;
  if (typeof body?.destroy === 'function') body.destroy();
  else if (typeof body?.cancel === 'function') void body.cancel();
}

export async function downloadPublicUrl(
  fileUrl: string,
  dependencies: { resolver?: AddressResolver; fetch?: FetchImplementation } = {},
): Promise<Buffer> {
  const resolver = dependencies.resolver ?? resolveAddresses;
  const fetchImpl = dependencies.fetch ?? fetch;
  let currentUrl: URL;
  try {
    currentUrl = new URL(fileUrl);
  } catch {
    throw new Error('Invalid file URL');
  }

  for (let redirects = 0; ; redirects += 1) {
    const addresses = await resolvePublicAddresses(currentUrl, resolver);
    const agent = createPinnedAgent(currentUrl, addresses[0]);
    try {
      const response = await fetchImpl(currentUrl.toString(), { redirect: 'manual', agent });
      if (REDIRECT_STATUS.has(response.status)) {
        discardResponseBody(response);
        const location = response.headers.get('location');
        if (!location) throw new Error('File download redirect did not include a Location header');
        if (redirects >= MAX_REDIRECTS) {
          throw new Error(`File download exceeded ${MAX_REDIRECTS} redirects`);
        }
        currentUrl = new URL(location, currentUrl);
        continue;
      }
      if (!response.ok) {
        discardResponseBody(response);
        throw new Error(`Failed to download file: ${response.status} ${response.statusText}`);
      }
      return await response.buffer();
    } finally {
      agent.destroy();
    }
  }
}
