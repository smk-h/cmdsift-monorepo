// @ts-check
'use strict';

/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : pack-offline.js
 * Author     : sumu
 * Date       : 2026/08/02
 * Version    : 0.1.0
 * Description: 构建 cmdsift 离线安装包
 *
 *              把入口包 @smai-kit/cmdsift（lib/）、当前平台子包
 *              @smai-kit/cmdsift-<os>-<cpu>（bin/ 二进制）以及
 *              scripts/offline-install.sh 组装成一个扁平结构的
 *              tar.gz，供无网络/内网环境全局安装。
 *
 *              【离线包结构】
 *              cmdsift-offline-<pkgVersion>-bin<binVersion>-<os>-<cpu>/
 *              ├── offline-install.sh
 *              ├── cmdsift/
 *              │   ├── package.json
 *              │   ├── lib/
 *              │   ├── LICENSE
 *              │   └── README.md
 *              └── cmdsift-<os>-<cpu>/
 *                  ├── package.json
 *                  ├── bin/
 *                  │   └── cmdsift(.exe)
 *                  ├── LICENSE
 *                  └── README.md
 *
 *              【用法】
 *                node build/pack-offline.js                     # 当前平台
 *                node build/pack-offline.js --target linux-x64  # 指定平台
 *                node build/pack-offline.js --target win32-x64
 *                node build/pack-offline.js --all               # 所有平台各打一个包
 *
 *              【前提】
 *                对应平台的二进制已通过 prepare-binaries 填充到
 *                packages/cmdsift-<os>-<cpu>/bin/ 下。
 * ======================================================
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { platforms, VERSION } = require('./platforms');

const ROOT = path.join(__dirname, '..');
const PACKAGES_DIR = path.join(ROOT, 'packages');
const SCRIPTS_DIR = path.join(ROOT, 'scripts');
const DIST_DIR = path.join(ROOT, 'dist');

const argv = process.argv.slice(2);
const ALL = argv.includes('--all');
const targetIdx = argv.indexOf('--target');
const ONLY_TARGET = targetIdx !== -1 ? argv[targetIdx + 1] : undefined;

/**
 * 平台 shortName（cmdsift-<os>-<cpu>）转 (os, cpu)
 * @param {string} shortName 如 cmdsift-linux-x64
 * @returns {{os: string, cpu: string} | null}
 */
function parseShortName(shortName) {
  const m = shortName.match(/^cmdsift-(\w+)-(\w+)$/);
  return m ? { os: m[1], cpu: m[2] } : null;
}

/**
 * 根据 --target 参数筛选平台
 * @returns {typeof platforms}
 */
function selectPlatforms() {
  if (ALL) {
    return platforms;
  }

  if (!ONLY_TARGET) {
    // 默认只打包当前宿主平台
    const host = platforms.find(
      p => p.os === process.platform && p.cpu === process.arch
    );
    if (!host) {
      console.error(`当前宿主平台 ${process.platform}-${process.arch} 不在支持列表中`);
      process.exit(1);
    }
    return [host];
  }

  // --target 格式为 <os>-<cpu>，如 linux-x64 / win32-x64
  const selected = platforms.filter(p => `${p.os}-${p.cpu}` === ONLY_TARGET);
  if (selected.length === 0) {
    console.error(`Unknown --target ${ONLY_TARGET}. Known targets:`);
    for (const p of platforms) console.error(`  ${p.os}-${p.cpu}`);
    process.exit(1);
  }
  return selected;
}

/**
 * 递归复制目录（使用 cp -a 保证权限）
 * @param {string} src 源
 * @param {string} dest 目标
 */
function copyDir(src, dest) {
  execSync(`cp -a "${src}/." "${dest}/"`, { stdio: 'pipe' });
}

/**
 * 只复制 package.json 中 files 字段声明的条目（外加 package.json/LICENSE/README）
 * 模拟 npm pack 的过滤行为，确保离线包内容与发布到 npm 的 tarball 一致
 * @param {string} srcPkgDir 源包目录
 * @param {string} destPkgDir 目标包目录
 */
function copyPackageFiles(srcPkgDir, destPkgDir) {
  const pkgJson = JSON.parse(fs.readFileSync(path.join(srcPkgDir, 'package.json'), 'utf8'));
  /** @type {string[]} */
  const files = pkgJson.files || [];
  // package.json / LICENSE / README.md 默认包含（npm 行为）
  const entries = new Set(['package.json', ...files]);
  // npm 默认会包含 LICENSE / README（不区分大小写），此处补上
  for (const f of fs.readdirSync(srcPkgDir)) {
    if (/^(license|readme)(\..*)?$/i.test(f)) {
      entries.add(f);
    }
  }

  fs.mkdirSync(destPkgDir, { recursive: true });
  for (const entry of entries) {
    const src = path.join(srcPkgDir, entry);
    if (!fs.existsSync(src)) continue;
    const dest = path.join(destPkgDir, entry);
    if (fs.statSync(src).isDirectory()) {
      copyDir(src, dest);
    } else {
      fs.copyFileSync(src, dest);
    }
  }
}

/**
 * 构建单个平台的离线包
 * @param {{ os: string; cpu: string; target: string }} platform
 * @returns {string} 生成的 tarball 绝对路径
 */
function buildOfflinePackage(platform) {
  const { os, cpu } = platform;
  const shortName = `cmdsift-${os}-${cpu}`;
  // 版本号取自入口包 @smai-kit/cmdsift 自身的 package.json，
  // 确保离线包名准确体现 cmdsift 的发布版本
  const entryPkg = JSON.parse(
    fs.readFileSync(path.join(PACKAGES_DIR, 'cmdsift', 'package.json'), 'utf8')
  );
  const version = entryPkg.version;
  // 二进制版本（上游 cmdsift 的 GitHub Release tag，如 v1.1.0）
  const binVersion = VERSION.replace(/^v/, '');

  console.log(`\n━━━ 构建 ${shortName} 离线包 (pkg v${version} / bin v${binVersion}) ━━━`);

  // 源目录
  const entrySrc = path.join(PACKAGES_DIR, 'cmdsift');
  const platformSrc = path.join(PACKAGES_DIR, shortName);

  // 校验源目录存在
  if (!fs.existsSync(path.join(entrySrc, 'package.json'))) {
    throw new Error(`入口包目录不存在: ${entrySrc}`);
  }
  if (!fs.existsSync(path.join(platformSrc, 'package.json'))) {
    throw new Error(`平台子包目录不存在: ${platformSrc}`);
  }

  // 校验二进制已填充
  const binaryName = os === 'win32' ? 'cmdsift.exe' : 'cmdsift';
  const binaryPath = path.join(platformSrc, 'bin', binaryName);
  if (!fs.existsSync(binaryPath)) {
    throw new Error(
      `平台子包二进制未填充: ${path.relative(ROOT, binaryPath)}\n` +
      `请先运行: npm run prepare-binaries:${os}-${cpu}`
    );
  }

  // 准备临时构建目录
  // 包名同时体现 npm 分发包版本与 cmdsift 二进制版本，便于区分不同二进制构建
  const pkgName = `cmdsift-offline-${version}-bin${binVersion}-${os}-${cpu}`;
  const buildDir = path.join(DIST_DIR, pkgName);
  // 清理旧产物
  fs.rmSync(buildDir, { recursive: true, force: true });
  fs.mkdirSync(buildDir, { recursive: true });

  console.log(`  [copy] 入口包 cmdsift/`);
  copyPackageFiles(entrySrc, path.join(buildDir, 'cmdsift'));

  console.log(`  [copy] 平台子包 ${shortName}/`);
  copyPackageFiles(platformSrc, path.join(buildDir, shortName));

  // 复制安装脚本
  const installScriptSrc = path.join(SCRIPTS_DIR, 'offline-install.sh');
  if (!fs.existsSync(installScriptSrc)) {
    throw new Error(`安装脚本不存在: ${installScriptSrc}`);
  }
  fs.copyFileSync(installScriptSrc, path.join(buildDir, 'offline-install.sh'));
  fs.chmodSync(path.join(buildDir, 'offline-install.sh'), 0o755);
  console.log(`  [copy] offline-install.sh`);

  // 打 tar.gz（扁平结构，外层包一层目录名）
  const tarball = path.join(DIST_DIR, `${pkgName}.tar.gz`);
  fs.rmSync(tarball, { force: true });
  execSync(`tar -czf "${tarball}" -C "${DIST_DIR}" "${pkgName}"`, { stdio: 'pipe' });

  // 清理临时目录
  fs.rmSync(buildDir, { recursive: true, force: true });

  const sizeKB = Math.round(fs.statSync(tarball).size / 1024);
  console.log(`  [ok]   ${path.relative(ROOT, tarball)} (${sizeKB} KB)`);

  return tarball;
}

function main() {
  fs.mkdirSync(DIST_DIR, { recursive: true });

  const selected = selectPlatforms();
  /** @type {string[]} */
  const tarballs = [];

  for (const platform of selected) {
    try {
      tarballs.push(buildOfflinePackage(platform));
    } catch (err) {
      console.error(`\n❌ 构建 ${platform.os}-${platform.cpu} 失败: ${err.message}`);
      process.exit(1);
    }
  }

  console.log(`\n✅ 离线包构建完成，共 ${tarballs.length} 个:`);
  for (const t of tarballs) {
    console.log(`   ${path.relative(ROOT, t)}`);
  }
  console.log(`\n使用方法：`);
  console.log(`   1. 将 tarball 传到目标机器`);
  console.log(`   2. tar -xzf <tarball>`);
  console.log(`   3. cd <解压目录> && bash offline-install.sh`);
}

main();
