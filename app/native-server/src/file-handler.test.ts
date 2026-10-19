import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { assertSinglePathSegment, FileHandler } from './file-handler';

describe('FileHandler path boundaries', () => {
  let root: string;
  let uploadDir: string;
  let handler: FileHandler;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-file-handler-'));
    uploadDir = path.join(root, 'uploads');
    handler = new FileHandler(uploadDir);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test.each([
    '../secret.txt',
    '..\\secret.txt',
    '/tmp/secret.txt',
    'C:\\secret.txt',
    'safe.txt:alternate-stream',
    'nested/file.txt',
    'nested\\file.txt',
    'bad\0name.txt',
    '.',
    '..',
  ])('rejects unsafe filename %p', (fileName) => {
    expect(() => assertSinglePathSegment(fileName)).toThrow('single path segment');
  });

  test('writes, reads and removes a managed base64 file', async () => {
    const created = await handler.handleFileRequest({
      action: 'prepareFile',
      base64Data: Buffer.from('safe').toString('base64'),
      fileName: 'safe.txt',
    });
    expect(created).toMatchObject({ success: true, fileName: 'safe.txt', size: 4 });

    const read = await handler.handleFileRequest({
      action: 'readBase64File',
      filePath: created.filePath,
    });
    expect(read).toMatchObject({
      success: true,
      base64Data: Buffer.from('safe').toString('base64'),
    });

    await expect(
      handler.handleFileRequest({ action: 'cleanupFile', filePath: created.filePath }),
    ).resolves.toMatchObject({ success: true });
    expect(fs.existsSync(created.filePath)).toBe(false);
  });

  test('does not create a file for a traversal filename', async () => {
    const result = await handler.handleFileRequest({
      action: 'prepareFile',
      base64Data: Buffer.from('secret').toString('base64'),
      fileName: '../escaped.txt',
    });
    expect(result).toMatchObject({ success: false });
    expect(fs.existsSync(path.join(root, 'escaped.txt'))).toBe(false);
  });

  test('rejects arbitrary reads and prefix-sibling cleanup', async () => {
    const outside = path.join(root, 'outside.txt');
    fs.writeFileSync(outside, 'outside');
    await expect(
      handler.handleFileRequest({ action: 'readBase64File', filePath: outside }),
    ).resolves.toMatchObject({ success: false });

    const sibling = path.join(root, 'uploads-evil.txt');
    fs.writeFileSync(sibling, 'keep');
    await expect(
      handler.handleFileRequest({ action: 'cleanupFile', filePath: sibling }),
    ).resolves.toMatchObject({ success: false });
    expect(fs.existsSync(sibling)).toBe(true);
  });

  test('rejects a symlink inside the upload directory', async () => {
    const outside = path.join(root, 'outside.txt');
    const link = path.join(uploadDir, 'link.txt');
    fs.writeFileSync(outside, 'outside');
    fs.symlinkSync(outside, link);
    await expect(
      handler.handleFileRequest({ action: 'readBase64File', filePath: link }),
    ).resolves.toMatchObject({ success: false });
  });
});
