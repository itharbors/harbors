import { readFileSync as readFile } from 'node:fs';
import path from 'node:path';
import semver from 'semver';

function validVersion(value) {
  return typeof value === 'string' && semver.valid(value) === value;
}

export function resolveDesktopVersion({
  isPackaged,
  packagedVersion,
  repositoryRoot,
  readFileSync = readFile,
} = {}) {
  let version = packagedVersion;
  if (!isPackaged) {
    let desktopPackage;
    try {
      desktopPackage = JSON.parse(readFileSync(
        path.join(repositoryRoot, 'packages', 'desktop', 'package.json'),
        'utf8',
      ));
    } catch (error) {
      throw new Error('Unable to read desktop application version', { cause: error });
    }
    version = desktopPackage?.version;
  }
  if (!validVersion(version)) throw new Error('Desktop application version is invalid');
  return version;
}
