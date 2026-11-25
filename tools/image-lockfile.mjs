#!/usr/bin/env node
// Writes an image’s lockfile from the workspace’s, so the image installs the
// versions the workspace was tested with. Run in a staged `dist-docker/`
// (docs/decisions/0015).
//
//   image-lockfile.mjs relocate   rewrite the workspace lockfile to the staged layout
//   image-lockfile.mjs verify     fail on a version the workspace lockfile does not hold
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const LOCKFILE = 'package-lock.json';
const STAGED_MODULES = 'workspace_modules';
const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const commands = { relocate, verify };
const command = commands[process.argv[2]];
if (command === undefined) {
  console.error(`Usage: image-lockfile.mjs ${Object.keys(commands).join('|')}`);
  process.exit(2);
}
command();

/**
 * Moves every workspace package’s entries to where the staged image holds
 * that package. Nx’s pruning falls back to the workspace lockfile as it is,
 * keyed by `packages/<directory>`; npm finds nothing at those paths in the
 * image and would resolve each staged module’s dependencies afresh, taking
 * whatever the registry serves that day.
 */
function relocate() {
  const lockfile = readLockfile(LOCKFILE);
  const workspaceLockfile = readLockfile(join(workspaceRoot, LOCKFILE));
  if (lockfile.name !== workspaceLockfile.name) {
    return; // Nx pruned it: the paths are the image’s already.
  }

  const imageDirectory = dirname(relative(workspaceRoot, process.cwd()));
  const stagedPath = (path) => {
    if (path === imageDirectory) {
      return '';
    }
    if (path.startsWith(`${imageDirectory}/`)) {
      return path.slice(imageDirectory.length + 1);
    }
    const [directory, ...rest] = path.split('/node_modules/');
    const name = lockfile.packages[directory]?.name;
    if (name === undefined || !existsSync(join(STAGED_MODULES, name))) {
      return path;
    }
    return [`${STAGED_MODULES}/${name}`, ...rest].join('/node_modules/');
  };

  const packages = {};
  for (const [path, entry] of Object.entries(lockfile.packages)) {
    if (path === '' || (entry.link && entry.resolved === imageDirectory)) {
      continue; // The workspace root and its link to the image’s own package.
    }
    packages[stagedPath(path)] = entry.link
      ? { ...entry, resolved: stagedPath(entry.resolved) }
      : entry;
  }
  const imagePackage = JSON.parse(readFileSync('package.json', 'utf8'));
  lockfile.name = imagePackage.name;
  lockfile.version = imagePackage.version;
  lockfile.packages = packages;
  writeFileSync(LOCKFILE, `${JSON.stringify(lockfile, null, 2)}\n`);
}

/**
 * Fails when the image lockfile holds a package version the workspace
 * lockfile does not: npm resolved it from the registry, so no test ran
 * against it.
 */
function verify() {
  const tested = new Set(registryPackages(join(workspaceRoot, LOCKFILE)));
  const untested = registryPackages(LOCKFILE).filter(
    (identity) => !tested.has(identity),
  );
  if (untested.length > 0) {
    console.error(
      `The image lockfile holds versions the workspace lockfile does not:\n${[
        ...new Set(untested),
      ]
        .sort()
        .map((identity) => `- ${identity}`)
        .join('\n')}`,
    );
    process.exit(1);
  }
}

function readLockfile(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** The tarballs a lockfile installs; links and workspace packages have none. */
function registryPackages(path) {
  return Object.values(readLockfile(path).packages)
    .filter((entry) => !entry.link && entry.resolved !== undefined)
    .map((entry) => entry.resolved);
}
