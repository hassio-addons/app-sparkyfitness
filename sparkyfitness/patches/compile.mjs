/*
 * Compiles the SparkyFitness server from TypeScript to JavaScript, once, at
 * build time.
 *
 * Upstream runs the server from its TypeScript sources through tsx, which
 * compiles every file again on every start, in memory. That takes the server
 * to well over half a gigabyte before it has served a single request, which
 * is more than a Home Assistant box with a gigabyte or two to share can
 * spare: the kernel kills it before it gets going. Compiled beforehand, the
 * server runs on plain Node.js and needs a fraction of that.
 *
 * The files are compiled the way tsx compiles them, since tsx is esbuild's
 * transform applied per file, with the server's own tsconfig. So the result
 * is the same JavaScript tsx would have run, just written to disk. Imports
 * are then pointed at the compiled files: most of the server already imports
 * its own files as .js, as NodeNext wants, but a few name the .ts file, which
 * tsx resolves and Node.js does not.
 *
 * The API documentation SparkyFitness serves is read out of the comments in
 * its TypeScript sources, by swagger-jsdoc, on every start. That is the
 * single most expensive thing the server does before listening: a second of
 * work, and well over a hundred megabytes of memory it grows into and then
 * holds on to. What it produces never changes between starts, so it is made
 * once, here, and the module that made it is replaced by the result. After
 * that, nothing reads the sources anymore, and they go.
 *
 * esbuild is not a dependency of the server itself, but of tsx, which is
 * where it is borrowed from.
 */
import { execFileSync } from 'node:child_process';
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const server = path.resolve(process.argv[2] ?? '.');
const fromServer = createRequire(path.join(server, 'package.json'));
const fromTsx = createRequire(fromServer.resolve('tsx/package.json'));
const { transform } = fromTsx('esbuild');

// Only the code the server runs. Tests, their fixtures and the tooling
// configuration are not compiled, and go. The dependencies are left alone.
const DEPENDENCIES = 'node_modules';
const TEST_DIRECTORIES = new Set(['tests', '__tests__', '__mocks__']);
const SKIPPED_FILES = /(\.test\.ts|\.spec\.ts|\.d\.ts|^vitest\.config\.ts)$/;

// A relative import or export of a .ts file, as NodeNext lets TypeScript
// write it with allowImportingTsExtensions.
const TS_SPECIFIER = /((?:from|import)\s*\(?\s*)(['"])(\.{1,2}\/[^'"]+)\.ts\2/g;

async function sources(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === DEPENDENCIES) {
        continue;
      }
      if (TEST_DIRECTORIES.has(entry.name)) {
        await rm(full, { recursive: true, force: true });
      } else {
        found.push(...(await sources(full)));
      }
    } else if (entry.name.endsWith('.ts')) {
      if (SKIPPED_FILES.test(entry.name)) {
        await rm(full);
      } else {
        found.push(full);
      }
    }
  }
  return found;
}

async function compile(root, tsconfigRaw) {
  const files = await sources(root);
  for (const file of files) {
    const result = await transform(await readFile(file, 'utf8'), {
      loader: 'ts',
      format: 'esm',
      target: `node${process.versions.node}`,
      sourcefile: file,
      tsconfigRaw,
    });
    const code = result.code.replace(TS_SPECIFIER, '$1$2$3.js$2');
    const leftover = code.match(
      /(?:from|import)\s*\(?\s*['"]\.{1,2}\/[^'"]+\.ts['"]/
    );
    if (leftover) {
      throw new Error(`${file} still imports ${leftover[0]}`);
    }
    await writeFile(file.replace(/\.ts$/, '.js'), code);
  }
  return files;
}

async function bakeApiDocumentation() {
  const module = path.join(server, 'config', 'swagger.js');

  // In a Node.js of its own, which has not seen the shared package with its
  // old entry point yet, and so imports the compiled one.
  const baked = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `const exported = await import(${JSON.stringify(module)});
       if (Object.keys(exported).join() !== 'default') process.exit(3);
       process.stdout.write(JSON.stringify(exported.default));`,
    ],
    { cwd: server, maxBuffer: 256 * 2 ** 20 }
  ).toString();

  const paths = Object.keys(JSON.parse(baked).paths ?? {}).length;
  if (paths < 100) {
    throw new Error(`the API spec only documents ${paths} paths`);
  }
  await writeFile(path.join(server, 'config', 'swagger.json'), baked);
  await writeFile(
    module,
    "import specs from './swagger.json' with { type: 'json' };\n" +
      'export default specs;\n'
  );
  return paths;
}

const tsconfigRaw = JSON.parse(
  await readFile(path.join(server, 'tsconfig.json'), 'utf8')
);

const serverFiles = await compile(server, tsconfigRaw);

// The shared workspace package, which pnpm injected into the deployment as a
// copy of its sources, and which names its TypeScript entry as its main.
const shared = path.dirname(
  fromServer.resolve('@workspace/shared/package.json')
);
const sharedFiles = await compile(path.join(shared, 'src'), tsconfigRaw);
const manifestPath = path.join(shared, 'package.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
if (manifest.main !== 'src/index.ts') {
  throw new Error(`@workspace/shared has an unexpected main: ${manifest.main}`);
}
manifest.main = 'src/index.js';
delete manifest.types;
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

const documentedPaths = await bakeApiDocumentation();

for (const file of [...serverFiles, ...sharedFiles]) {
  await rm(file);
}

console.log(
  `Compiled the SparkyFitness server: ${serverFiles.length} files, ` +
    `and ${sharedFiles.length} of @workspace/shared`
);
console.log(`  API documentation baked in: ${documentedPaths} paths`);
