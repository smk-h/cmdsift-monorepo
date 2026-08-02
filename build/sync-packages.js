// @ts-check
'use strict';

/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : sync-packages.js
 * Author     : sumu
 * Date       : 2026/08/01
 * Version    : 0.1.0
 * Description: 根据根版本号和平台列表同步所有子包的 package.json，
 *              确保版本号和 optionalDependencies 保持一致；
 *              最后同步重写 package-lock.json，保证 CI npm ci 通过
 * ======================================================
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { platforms, packageNameFor } = require('./platforms');

const ROOT = path.join(__dirname, '..');
const PACKAGES_DIR = path.join(ROOT, 'packages');
const ROOT_PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION = ROOT_PKG.version;
const LICENSE = fs.readFileSync(path.join(ROOT, 'LICENSE'), 'utf8');

/**
 * 仅当内容变化时才写入文件，避免不必要的文件修改
 * @param {string} target - 目标文件路径
 * @param {string} content - 文件内容
 * @returns {boolean} 是否发生了写入
 */
function writeIfChanged(target, content) {
  if (fs.existsSync(target) && fs.readFileSync(target, 'utf8') === content) {
    return false;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return true;
}

/**
 * 生成平台子包的 README.md 内容
 * @param {string} name - npm 包名
 * @param {{ os: string; cpu: string; target: string }} p - 平台信息
 * @returns {string} README.md 文件内容
 */
function generatePlatformReadme(name, p) {
  const osName = p.os === 'win32' ? 'Windows' : 'Linux';
  const linkStyle = p.os === 'win32' ? 'MSVC' : 'musl 静态链接';
  const binaryName = p.os === 'win32' ? 'cmdsift.exe' : 'cmdsift';
  const compatibility = p.os === 'win32'
    ? '适用于 Windows 10 及以上版本的 x64 系统'
    : '可在任意 Linux 发行版上直接运行，无需依赖特定 glibc 版本';
  return `<!-- more -->

## 一、 概述

\`${name}\` 是 cmdsift 的 \`${p.os}-${p.cpu}\` 平台二进制包，对应 Rust 编译目标 \`${p.target}\`。

本包是 [\`@smai-kit/cmdsift\`](https://www.npmjs.com/package/@smai-kit/cmdsift) 的内部依赖，不应直接安装。

## 二、 平台信息

| 属性 | 值 |
|------|------|
| 操作系统 | ${osName} |
| CPU 架构 | ${p.cpu} |
| Rust Target | \`${p.target}\` |
| 二进制文件名 | \`${binaryName}\` |
| 链接方式 | ${linkStyle} |
| 兼容性 | ${compatibility} |

## 三、 更多信息

关于包的发布机制、分发原理、使用方式等内容，请参阅 [cmdsift-monorepo README](https://github.com/smk-h/cmdsift-monorepo#readme)。

---
*本文档由 markdowncli 技能辅助生成*
`;
}

/**
 * 同步各平台子包的 package.json、README.md 和 LICENSE
 * @returns {number} 发生变更的文件数量
 */
function syncPlatformPackages() {
  let changed = 0;
  for (const p of platforms) {
    const name = packageNameFor(p);
    const shortName = name.replace('@smai-kit/', '');
    const pkgDir = path.join(PACKAGES_DIR, shortName);

    const pkgJson = {
      name,
      version: VERSION,
      description: `cmdsift binary for ${p.os}-${p.cpu}. Used by @smai-kit/cmdsift.`,
      repository: {
        type: 'git',
        url: 'https://github.com/smk-h/cmdsift-monorepo',
      },
      license: 'MIT',
      os: [p.os],
      cpu: [p.cpu],
      files: ['bin/'],
    };
    const json = JSON.stringify(pkgJson, null, 2) + '\n';
    if (writeIfChanged(path.join(pkgDir, 'package.json'), json)) changed++;

    const readme = generatePlatformReadme(name, p);
    if (writeIfChanged(path.join(pkgDir, 'README.md'), readme)) changed++;

    if (writeIfChanged(path.join(pkgDir, 'LICENSE'), LICENSE)) changed++;
  }
  return changed;
}

/**
 * 同步入口包的版本号和 optionalDependencies
 * @returns {number} 发生变更的文件数量（0 或 1）
 */
function syncWrapperPackage() {
  const wrapperPkgPath = path.join(PACKAGES_DIR, 'cmdsift', 'package.json');
  const wrapperPkg = JSON.parse(fs.readFileSync(wrapperPkgPath, 'utf8'));
  wrapperPkg.version = VERSION;
  /** @type {Record<string, string>} */
  const optionalDeps = {};
  for (const p of platforms) {
    optionalDeps[packageNameFor(p)] = VERSION;
  }
  wrapperPkg.optionalDependencies = optionalDeps;
  const json = JSON.stringify(wrapperPkg, null, 2) + '\n';
  return writeIfChanged(wrapperPkgPath, json) ? 1 : 0;
}

/**
 * 同步重写 package-lock.json，使其与各 package.json 的版本/依赖声明一致
 *
 * 版本号或 optionalDependencies 变化后，lockfile 中仍记录旧规格，
 * 会导致 CI 的 npm ci 校验失败（out of sync）。
 * --package-lock-only 只重写 lockfile、不动 node_modules；
 * --force 用于跳过非宿主平台子包的 os/cpu 校验（EBADPLATFORM）。
 */
function syncPackageLock() {
  execSync('npm install --package-lock-only --force --no-audit --no-fund', {
    cwd: ROOT,
    stdio: 'pipe',
  });
}

function main() {
  const platformChanges = syncPlatformPackages();
  const wrapperChanges = syncWrapperPackage();
  const total = platformChanges + wrapperChanges;
  if (total === 0) {
    console.log('All package manifests up to date.');
  } else {
    console.log(`Updated ${total} file(s) across packages/`);
  }

  syncPackageLock();
  console.log('package-lock.json synced.');
}

main();
