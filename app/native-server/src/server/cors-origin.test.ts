import { describe, expect, test } from '@jest/globals';
import { isOriginAllowed } from './cors-origin';

describe('isOriginAllowed', () => {
  test.each([
    undefined,
    'chrome-extension://hbdgbgagpkpjffpklnamcljpakneikee',
    'http://127.0.0.1:12306',
    'http://127.0.0.1:5173',
  ])('allows trusted origin %p', (origin) => {
    expect(isOriginAllowed(origin)).toBe(true);
  });

  test.each([
    'http://127.0.0.1.evil.example:12306',
    'http://127.0.0.1:12306.evil.example',
    'http://127.0.0.1',
    'https://127.0.0.1:12306',
    'http://localhost:12306',
    'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'moz-extension://hbdgbgagpkpjffpklnamcljpakneikee',
    'chrome-extension://hbdgbgagpkpjffpklnamcljpakneikee.evil.example',
    'null',
    'not a valid origin',
    'http://127.0.0.1:12306/path',
  ])('rejects untrusted origin %p', (origin) => {
    expect(isOriginAllowed(origin)).toBe(false);
  });
});
