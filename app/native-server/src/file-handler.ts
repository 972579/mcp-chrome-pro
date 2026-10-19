import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { downloadPublicUrl } from './network-security';

export function assertSinglePathSegment(fileName: string): string {
  if (
    !fileName ||
    fileName === '.' ||
    fileName === '..' ||
    fileName.includes('\0') ||
    fileName.includes('/') ||
    fileName.includes('\\') ||
    fileName.includes(':') ||
    path.isAbsolute(fileName) ||
    path.win32.isAbsolute(fileName) ||
    path.basename(fileName) !== fileName ||
    path.win32.basename(fileName) !== fileName
  ) {
    throw new Error('fileName must be a single path segment');
  }
  return fileName;
}

/** File handler for uploads passing through the native messaging host. */
export class FileHandler {
  private readonly tempDir: string;

  constructor(tempDir = path.join(os.tmpdir(), 'chrome-mcp-uploads')) {
    const requestedDir = path.resolve(tempDir);
    fs.mkdirSync(requestedDir, { recursive: true, mode: 0o700 });
    const stats = fs.lstatSync(requestedDir);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error('Upload directory must be a real directory');
    }
    this.tempDir = fs.realpathSync(requestedDir);
  }

  async handleFileRequest(request: any): Promise<any> {
    const { action, fileUrl, base64Data, fileName, filePath, traceFilePath, insightName } = request;

    try {
      switch (action) {
        case 'prepareFile':
          if (fileUrl) return await this.downloadFile(fileUrl, fileName);
          if (base64Data) return await this.saveBase64File(base64Data, fileName);
          if (filePath) return await this.verifyFile(filePath);
          break;
        case 'readBase64File':
          if (!filePath) return { success: false, error: 'filePath is required' };
          return await this.readBase64File(filePath);
        case 'cleanupFile':
          if (!filePath) return { success: false, error: 'filePath is required' };
          return await this.cleanupFile(filePath);
        case 'analyzeTrace': {
          const targetPath = traceFilePath || filePath;
          if (!targetPath) return { success: false, error: 'traceFilePath is required' };
          try {
            const { analyzeTraceFile } = await import('./trace-analyzer.js');
            return { success: true, ...(await analyzeTraceFile(targetPath, insightName)) };
          } catch (error: any) {
            return { success: false, error: error?.message || String(error) };
          }
        }
        default:
          return { success: false, error: `Unknown file action: ${action}` };
      }

      return { success: false, error: 'No file source was provided' };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private resolveNewFile(fileName: string): string {
    const safeName = assertSinglePathSegment(fileName);
    const resolved = path.resolve(this.tempDir, safeName);
    if (path.dirname(resolved) !== this.tempDir) {
      throw new Error('Resolved file path escapes the upload directory');
    }
    return resolved;
  }

  private resolveExistingFile(filePath: string): string {
    const resolved = path.isAbsolute(filePath)
      ? path.resolve(filePath)
      : path.resolve(this.tempDir, filePath);
    if (path.dirname(resolved) !== this.tempDir) {
      throw new Error('File path must refer to a file in the upload directory');
    }

    const stats = fs.lstatSync(resolved);
    if (stats.isSymbolicLink()) throw new Error('Symbolic links are not allowed');
    const realPath = fs.realpathSync(resolved);
    if (path.dirname(realPath) !== fs.realpathSync(this.tempDir)) {
      throw new Error('Resolved file path escapes the upload directory');
    }
    return realPath;
  }

  private writeManagedFile(fileName: string, buffer: Buffer): string {
    const filePath = this.resolveNewFile(fileName);
    fs.writeFileSync(filePath, buffer, { flag: 'wx', mode: 0o600 });
    return filePath;
  }

  private async downloadFile(fileUrl: string, fileName?: string): Promise<any> {
    try {
      const finalFileName = fileName
        ? assertSinglePathSegment(fileName)
        : this.generateFileName(fileUrl);
      const buffer = await downloadPublicUrl(fileUrl);
      const filePath = this.writeManagedFile(finalFileName, buffer);
      return { success: true, filePath, fileName: finalFileName, size: buffer.length };
    } catch (error) {
      throw new Error(
        `Failed to download file from URL: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async saveBase64File(base64Data: string, fileName?: string): Promise<any> {
    try {
      const base64Content = base64Data.replace(/^data:.*?;base64,/, '');
      const buffer = Buffer.from(base64Content, 'base64');
      const finalFileName = assertSinglePathSegment(
        fileName || `upload-${crypto.randomBytes(8).toString('hex')}.bin`,
      );
      const filePath = this.writeManagedFile(finalFileName, buffer);
      return { success: true, filePath, fileName: finalFileName, size: buffer.length };
    } catch (error) {
      throw new Error(
        `Failed to save base64 file: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async verifyFile(filePath: string): Promise<any> {
    try {
      const resolved = this.resolveExistingFile(filePath);
      const stats = fs.statSync(resolved);
      if (!stats.isFile()) throw new Error(`Path is not a file: ${filePath}`);
      fs.accessSync(resolved, fs.constants.R_OK);
      return {
        success: true,
        filePath: resolved,
        fileName: path.basename(resolved),
        size: stats.size,
      };
    } catch (error) {
      throw new Error(
        `Failed to verify file: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async readBase64File(filePath: string): Promise<any> {
    try {
      const resolved = this.resolveExistingFile(filePath);
      const stats = fs.statSync(resolved);
      if (!stats.isFile()) throw new Error(`Path is not a file: ${filePath}`);
      const buffer = fs.readFileSync(resolved);
      return {
        success: true,
        filePath: resolved,
        fileName: path.basename(resolved),
        size: stats.size,
        base64Data: buffer.toString('base64'),
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to read file: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  private async cleanupFile(filePath: string): Promise<any> {
    try {
      const resolved = this.resolveExistingFile(filePath);
      fs.unlinkSync(resolved);
      return { success: true, message: 'File cleaned up successfully' };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { success: true, message: 'File already absent' };
      }
      return {
        success: false,
        error: `Failed to cleanup file: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  private generateFileName(url: string): string {
    try {
      const encodedName = path.posix.basename(new URL(url).pathname);
      const decodedName = decodeURIComponent(encodedName);
      if (decodedName && decodedName !== '/') {
        assertSinglePathSegment(decodedName);
        const extension = path.extname(decodedName);
        const stem = path.basename(decodedName, extension);
        return `${stem}-${crypto.randomBytes(4).toString('hex')}${extension}`;
      }
    } catch {
      // Unsafe or missing URL path names deliberately fall back to a random name.
    }
    return `upload-${crypto.randomBytes(8).toString('hex')}.bin`;
  }

  cleanupOldFiles(): void {
    try {
      const cutoff = Date.now() - 60 * 60 * 1000;
      for (const fileName of fs.readdirSync(this.tempDir)) {
        try {
          const filePath = this.resolveExistingFile(fileName);
          const stats = fs.statSync(filePath);
          if (stats.isFile() && stats.mtimeMs < cutoff) {
            fs.unlinkSync(filePath);
            console.error(`Cleaned up old temp file: ${fileName}`);
          }
        } catch (error) {
          console.error(`Skipped unsafe temp entry ${fileName}:`, error);
        }
      }
    } catch (error) {
      console.error('Error cleaning up old files:', error);
    }
  }
}

export default new FileHandler();
