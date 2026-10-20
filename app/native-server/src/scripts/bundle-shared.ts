import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const packageDir = path.resolve(__dirname, '../..');
const distDir = path.join(packageDir, 'dist');
const sharedEntry = require.resolve('chrome-mcp-shared');

function findSharedConsumers(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return findSharedConsumers(entryPath);
    if (!entry.name.endsWith('.js')) return [];
    return /require\(["']chrome-mcp-shared["']\)/.test(fs.readFileSync(entryPath, 'utf8'))
      ? [entryPath]
      : [];
  });
}

async function main(): Promise<void> {
  const consumers = findSharedConsumers(distDir);
  if (consumers.length === 0) throw new Error('No compiled chrome-mcp-shared consumers found');

  await Promise.all(
    consumers.map((entryPoint) =>
      build({
        entryPoints: [entryPoint],
        outfile: entryPoint,
        allowOverwrite: true,
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'node20',
        sourcemap: true,
        plugins: [
          {
            name: 'bundle-workspace-shared',
            setup(builder) {
              builder.onResolve({ filter: /.*/ }, (args) => {
                if (args.kind === 'entry-point') return;
                if (args.path === 'chrome-mcp-shared') return { path: sharedEntry };
                // Keep local modules in place: their __dirname paths are used by
                // Native Messaging wrappers, configuration and diagnostics.
                return { path: args.path, external: true };
              });
            },
          },
        ],
      }),
    ),
  );

  if (findSharedConsumers(distDir).length > 0) {
    throw new Error('Published JavaScript still depends on chrome-mcp-shared');
  }
  console.log(`Bundled workspace shared code into ${consumers.length} runtime modules`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
