import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const [baseVsix, nodeModulesDir, outputVsix] = process.argv.slice(2);

if (!baseVsix || !nodeModulesDir || !outputVsix) {
  console.error('Usage: node scripts/build-local-vsix.mjs <base.vsix> <node_modules> <output.vsix>');
  process.exit(1);
}

const root = process.cwd();
const yauzl = requirePnpmPackage('yauzl');
const yazl = requirePnpmPackage('yazl');

const baseEntries = await readZipEntries(path.resolve(root, baseVsix));
const outputPath = path.resolve(root, outputVsix);
const tempOutputPath = `${outputPath}.tmp`;

await writeVsix(baseEntries, path.resolve(nodeModulesDir), tempOutputPath);
fs.renameSync(tempOutputPath, outputPath);

function requirePnpmPackage(packageName) {
  const encodedName = packageName.replace('/', '+');
  const pnpmDir = path.join(root, 'node_modules', '.pnpm');
  const match = fs
    .readdirSync(pnpmDir)
    .filter((entry) => entry.startsWith(`${encodedName}@`))
    .sort()
    .at(-1);

  if (!match) {
    throw new Error(`Could not find ${packageName} in ${pnpmDir}.`);
  }

  return require(path.join(pnpmDir, match, 'node_modules', packageName));
}

function readZipEntries(zipPath) {
  return new Promise((resolve, reject) => {
    const entries = [];

    yauzl.open(zipPath, { lazyEntries: true }, (openError, zip) => {
      if (openError || !zip) {
        reject(openError);
        return;
      }

      zip.readEntry();

      zip.on('entry', (entry) => {
        if (entry.fileName.endsWith('/')) {
          zip.readEntry();
          return;
        }

        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            reject(streamError);
            return;
          }

          const chunks = [];
          stream.on('data', (chunk) => chunks.push(chunk));
          stream.on('error', reject);
          stream.on('end', () => {
            entries.push({
              name: entry.fileName,
              buffer: Buffer.concat(chunks),
              mode: entry.externalFileAttributes >>> 16,
            });
            zip.readEntry();
          });
        });
      });

      zip.on('end', () => resolve(entries));
      zip.on('error', reject);
    });
  });
}

function writeVsix(baseEntries, productionNodeModulesDir, outputPath) {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    const output = fs.createWriteStream(outputPath);

    output.on('close', resolve);
    output.on('error', reject);
    zip.outputStream.on('error', reject);
    zip.outputStream.pipe(output);

    for (const entry of baseEntries) {
      if (!entry.name.startsWith('extension/node_modules/')) {
        zip.addBuffer(entry.buffer, entry.name, { mode: entry.mode || 0o100644 });
      }
    }

    addFlatNodeModulesToZip(zip, productionNodeModulesDir, 'extension/node_modules');
    zip.end();
  });
}

function addFlatNodeModulesToZip(zip, nodeModulesDir, archiveRoot) {
  const packagePaths = collectFlatPackages(nodeModulesDir);

  for (const [packageName, packagePath] of packagePaths) {
    addPackageDirectoryToZip(zip, packagePath, `${archiveRoot}/${packageName}`);
  }
}

function collectFlatPackages(nodeModulesDir) {
  const packagePaths = new Map();
  collectPackagesFromDirectory(packagePaths, nodeModulesDir);
  collectPackagesFromDirectory(packagePaths, path.join(nodeModulesDir, '.pnpm', 'node_modules'));
  return packagePaths;
}

function collectPackagesFromDirectory(packagePaths, directory) {
  if (!fs.existsSync(directory)) {
    return;
  }

  for (const entryName of fs.readdirSync(directory)) {
    const absolutePath = path.join(directory, entryName);

    if (entryName.startsWith('.')) {
      continue;
    }

    if (entryName.startsWith('@')) {
      for (const scopedEntryName of fs.readdirSync(absolutePath)) {
        addFlatPackage(packagePaths, `${entryName}/${scopedEntryName}`, path.join(absolutePath, scopedEntryName));
      }
      continue;
    }

    addFlatPackage(packagePaths, entryName, absolutePath);
  }
}

function addFlatPackage(packagePaths, packageName, packagePath) {
  const realPackagePath = fs.realpathSync(packagePath);

  if (fs.statSync(realPackagePath).isDirectory() && !packagePaths.has(packageName)) {
    packagePaths.set(packageName, realPackagePath);
  }
}

function addPackageDirectoryToZip(zip, directory, archiveRoot) {
  for (const entryName of fs.readdirSync(directory)) {
    if (entryName === 'node_modules') {
      continue;
    }

    const absolutePath = path.join(directory, entryName);
    const archivePath = `${archiveRoot}/${entryName}`;
    const stat = fs.statSync(absolutePath);

    if (stat.isDirectory()) {
      addPackageDirectoryToZip(zip, absolutePath, archivePath);
    } else if (stat.isFile()) {
      zip.addFile(absolutePath, archivePath, { mode: stat.mode });
    }
  }
}
