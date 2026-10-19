import { RELEASE_EXTENSION_ID } from '../constant';

const RELEASE_EXTENSION_ORIGIN = `chrome-extension://${RELEASE_EXTENSION_ID}`;

/**
 * Only the published extension and explicit loopback development origins may
 * access the local HTTP API from a browser. Requests without Origin are local
 * non-browser MCP clients and remain supported.
 */
export function isOriginAllowed(origin?: string): boolean {
  if (!origin) {
    return true;
  }

  if (origin === RELEASE_EXTENSION_ORIGIN) {
    return true;
  }

  try {
    const parsed = new URL(origin);
    if (
      parsed.protocol !== 'http:' ||
      parsed.hostname !== '127.0.0.1' ||
      !parsed.port ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash
    ) {
      return false;
    }

    const port = Number(parsed.port);
    return Number.isInteger(port) && port >= 1 && port <= 65535 && parsed.origin === origin;
  } catch {
    return false;
  }
}
