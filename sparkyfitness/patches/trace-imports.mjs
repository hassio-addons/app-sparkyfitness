/*
 * Lists the packages the SparkyFitness server imports, directly or through
 * other packages, by the name of the directory pnpm keeps each of them in.
 *
 * esbuild follows every import from the server's entry point the way it would
 * to bundle it, which is every import that can be known without running the
 * code. Nothing is bundled or written: each file it loads is noted on the way,
 * and the build itself is allowed to fail afterwards, which it does, over the
 * way a few of the server's modules export themselves.
 *
 * An import it cannot resolve does fail this, since that is a package the
 * server needs and does not have, and prune.py relies on this list being
 * complete.
 *
 * esbuild is not a dependency of the server itself, but of tsx, which is
 * where it is borrowed from.
 */
import { createRequire } from 'node:module';
import path from 'node:path';

const server = path.resolve(process.argv[2] ?? '.');
const fromServer = createRequire(path.join(server, 'package.json'));
const fromTsx = createRequire(fromServer.resolve('tsx/package.json'));
const { build } = fromTsx('esbuild');

const loaded = new Set();
let unresolved = [];

try {
  await build({
    absWorkingDir: server,
    entryPoints: [path.join(server, 'index.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    outdir: path.join(server, '.trace'),
    logLevel: 'silent',
    loader: { '.node': 'empty' },
    plugins: [
      {
        name: 'trace',
        setup(pluginBuild) {
          pluginBuild.onLoad({ filter: /.*/ }, (args) => {
            loaded.add(args.path);
            return undefined;
          });
        },
      },
    ],
  });
} catch (err) {
  unresolved = (err.errors ?? [])
    .filter((error) => error.text.startsWith('Could not resolve'))
    .map((error) => `${error.location?.file}: ${error.text}`);
}

if (unresolved.length) {
  console.error(`Unresolved imports:\n${unresolved.join('\n')}`);
  process.exit(1);
}

const packages = new Set();
for (const file of loaded) {
  const match = /node_modules\/\.pnpm\/([^/]+)\//.exec(file);
  if (match) {
    packages.add(match[1]);
  }
}

if (!packages.size) {
  console.error('No packages traced; the layout is not what this expects.');
  process.exit(1);
}

console.log([...packages].sort().join('\n'));
