// @ts-check
'use strict';

/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : prepare-binaries.js
 * Author     : sumu
 * Date       : 2026/08/01
 * Version    : 0.1.0
 * Description: 从 cmdsift 的 GitHub Release 下载预编译二进制文件，
 *              经 SHA256 校验后解压到各平台子包的 bin/ 目录
 * ======================================================
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { execSync } = require('child_process');
const { platforms, packageNameFor, binaryNameFor, REPO } = require('./platforms');

const ROOT = path.join(__dirname, '..');
const PACKAGES_DIR = path.join(ROOT, 'packages');
const LOCK_PATH = path.join(ROOT, 'binaries.lock.json');

const argv = process.argv.slice(2);
const FORCE = argv.includes('--force');
const UPDATE_LOCK = argv.includes('--update-lock');
const targetIdx = argv.indexOf('--target');
const ONLY_TARGET = targetIdx !== -1 ? argv[targetIdx + 1] : undefined;

/**
 * 通过 HTTPS 下载文件到本地，支持 301/302 重定向
 * @param {string} url - 下载 URL
 * @param {string} dest - 本地目标路径
 * @param {Record<string, string>} headers - 请求头
 * @returns {Promise<void>}
 */
function downloadToFile(url, dest, headers) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'user-agent': 'cmdsift-monorepo', ...headers } }, res => {
      const { statusCode, headers: resHeaders } = res;
      const location = /** @type {string | undefined} */ (resHeaders.location);
      if ((statusCode === 301 || statusCode === 302) && location) {
        res.resume();
        return downloadToFile(location, dest, headers).then(resolve, reject);
      }
      if (statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${statusCode} for ${url}`));
      }
      const out = fs.createWriteStream(dest);
      res.pipe(out);
      out.on('finish', () => out.close(() => resolve()));
      out.on('error', reject);
    }).on('error', reject);
  });
}

/**
 * 计算文件的 SHA256 哈希值
 * @param {string} filePath - 文件路径
 * @returns {Promise<string>} 十六进制哈希字符串
 */
function sha256OfFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', d => hash.update(d));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/**
 * 读取 binaries.lock.json 锁文件
 * @returns {Record<string, { version: string; sha256: string }>} 锁文件内容
 */
function readLockfile() {
  if (!fs.existsSync(LOCK_PATH)) {
    return {};
  }
  return JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8'));
}

/**
 * 写入 binaries.lock.json 锁文件，按键名排序
 * @param {Record<string, { version: string; sha256: string }>} lock - 锁文件内容
 */
function writeLockfile(lock) {
  const sorted = Object.fromEntries(Object.keys(lock).sort().map(k => [k, lock[k]]));
  fs.writeFileSync(LOCK_PATH, JSON.stringify(sorted, null, 2) + '\n');
}

async function main() {
  const selected = ONLY_TARGET
    ? platforms.filter(p => p.target === ONLY_TARGET)
    : platforms;

  if (ONLY_TARGET && selected.length === 0) {
    console.error(`Unknown --target ${ONLY_TARGET}. Known targets:`);
    for (const p of platforms) console.error(`  ${p.target}`);
    process.exit(1);
  }

  // 设置 GITHUB_TOKEN 避免匿名 API 限流
  const token = process.env.GITHUB_TOKEN;
  /** @type {Record<string, string>} */
  const headers = token ? { authorization: `token ${token}` } : {};

  const lock = readLockfile();
  /** @type {Record<string, { version: string; sha256: string }>} */
  const newLock = ONLY_TARGET ? { ...lock } : {};
  let mismatch = false;

  for (const platform of selected) {
    const isWindows = platform.os === 'win32';
    const ext = isWindows ? '.zip' : '.tar.gz';
    const assetName = `cmdsift-${platform.version}-${platform.target}${ext}`;
    const binaryName = binaryNameFor(platform);
    const pkgShortName = packageNameFor(platform).replace('@smai-kit/', '');
    const binDir = path.join(PACKAGES_DIR, pkgShortName, 'bin');
    const binaryPath = path.join(binDir, binaryName);

    // 强制模式或更新锁模式时，先清理已有的 bin 目录
    if ((FORCE || UPDATE_LOCK) && fs.existsSync(binDir)) {
      fs.rmSync(binDir, { recursive: true });
    }

    // 已存在且非强制模式时跳过
    if (!FORCE && !UPDATE_LOCK && fs.existsSync(binaryPath)) {
      console.log(`[skip] ${platform.target}: already present`);
      newLock[platform.target] = lock[platform.target];
      continue;
    }

    console.log(`[fetch] ${platform.target} (${platform.version})`);
    fs.mkdirSync(binDir, { recursive: true });

    // 下载压缩包
    const archive = path.join(binDir, assetName);
    const url = `https://github.com/${REPO}/releases/download/${platform.version}/${assetName}`;
    await downloadToFile(url, archive, headers);

    // 计算 SHA256 并校验
    const archiveSha = await sha256OfFile(archive);
    const expected = lock[platform.target];

    if (UPDATE_LOCK) {
      newLock[platform.target] = { version: platform.version, sha256: archiveSha };
      console.log(`        sha256=${archiveSha}`);
    } else if (!expected) {
      console.error(`[fail] ${platform.target}: no entry in binaries.lock.json. ` +
        `Run \`npm run update-lock\` to populate it.`);
      mismatch = true;
      fs.unlinkSync(archive);
      continue;
    } else if (expected.version !== platform.version || expected.sha256 !== archiveSha) {
      console.error(`[fail] ${platform.target}: lockfile mismatch.\n` +
        `        expected version=${expected.version} sha256=${expected.sha256}\n` +
        `        got      version=${platform.version} sha256=${archiveSha}`);
      mismatch = true;
      fs.unlinkSync(archive);
      continue;
    } else {
      newLock[platform.target] = expected;
    }

    // 解压二进制文件
    // cmdsift 压缩包内有一个同名目录，如 cmdsift-v0.1.0-x86_64-unknown-linux-musl/cmdsift
    // 策略：先完整解压到临时目录，再只把二进制文件移动到 bin/
    const tmpDir = path.join(binDir, '.tmp');
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });

    if (isWindows) {
      // Windows .zip：POSIX 主机用 unzip，Windows 主机用 tar -xf
      if (process.platform === 'win32') {
        execSync(`tar -xf "${archive}" -C "${tmpDir}"`, { stdio: 'inherit' });
      } else {
        execSync(`unzip -o "${archive}" -d "${tmpDir}"`, { stdio: 'inherit' });
      }
    } else {
      // Linux .tar.gz
      execSync(`tar -xzf "${archive}" -C "${tmpDir}"`, { stdio: 'inherit' });
    }

    // 从解压后的目录中找到二进制文件并移动到 bin/
    const entries = fs.readdirSync(tmpDir);
    const extractedDir = entries.find(e => fs.statSync(path.join(tmpDir, e)).isDirectory());
    if (!extractedDir) {
      throw new Error(`Could not find extracted directory in ${tmpDir}`);
    }
    const extractedBinary = path.join(tmpDir, extractedDir, binaryName);
    if (!fs.existsSync(extractedBinary)) {
      throw new Error(`Could not find ${binaryName} in ${extractedDir}`);
    }
    fs.copyFileSync(extractedBinary, binaryPath);
    if (!isWindows) {
      fs.chmodSync(binaryPath, 0o755);
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.unlinkSync(archive);

    console.log(`[ok]    ${platform.target} -> ${path.relative(ROOT, binaryPath)}`);
  }

  if (mismatch) {
    process.exit(1);
  }

  if (UPDATE_LOCK) {
    writeLockfile(newLock);
    console.log(`\nLockfile updated: ${LOCK_PATH}`);
  } else {
    console.log(`\nAll selected binaries verified and prepared.`);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
