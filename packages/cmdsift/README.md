# @smai-kit/cmdsift

This is an npm module for using [cmdsift](https://github.com/smk-h/cmdsift) in a Node project.

## How it works

- Cmdsift is built in [smk-h/cmdsift](https://github.com/smk-h/cmdsift) and published as release assets for each tag.
- At publish time, the binaries for every supported platform are downloaded by `build/prepare-binaries.js`, verified against `binaries.lock.json` (SHA256), and placed under `bin/cmdsift[.exe]`. They ship inside the npm tarball.
- At runtime, `lib/index.js` resolves `cmdsiftPath` from `process.platform`/`process.arch` to the correct `bin/<binary>`.
- There is no `postinstall` step and no runtime network access.

### Usage example

```js
import { cmdsiftPath } from '@smai-kit/cmdsift';
import { execFile } from 'node:child_process';

execFile(cmdsiftPath, ['--help'], (error, stdout, stderr) => {
  console.log(stdout);
});
```

### Updating cmdsift

1. Edit the `VERSION` constant in `build/platforms.js`.
2. Run `npm run update-lock`. This re-downloads every platform's archive and rewrites `binaries.lock.json` with the fresh SHA256 hashes.
3. Commit the updated `build/platforms.js` and `binaries.lock.json`.

### Building locally

- `npm run prepare-binaries` — downloads any missing binaries and verifies them against `binaries.lock.json`. Fails on hash mismatch.
- `npm run prepare-binaries -- --force` — forces a clean re-download (still verifies).
- `npm run update-lock` — refreshes `binaries.lock.json` after a version bump.

Set `GITHUB_TOKEN` to avoid GitHub's anonymous API rate limit during downloads.
