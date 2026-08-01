import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const arch = process.env.npm_config_arch || process.arch;
const binaryName = process.platform === 'win32' ? 'cmdsift.exe' : 'cmdsift';
const platformPkg = `@smai-kit/cmdsift-${process.platform}-${arch}`;

let resolved;
try {
  resolved = require.resolve(`${platformPkg}/bin/${binaryName}`);
} catch {
  throw new Error(
    `Could not find ${platformPkg}. ` +
    `Ensure optionalDependencies are installed for this platform (${process.platform}-${arch}).`
  );
}

export const cmdsiftPath = resolved;
