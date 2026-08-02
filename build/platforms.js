// @ts-check
'use strict';

/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : platforms.js
 * Author     : sumu
 * Date       : 2026/08/01
 * Version    : 0.1.0
 * Description: 平台映射配置，作为 prepare-binaries.js 和 sync-packages.js
 *              的唯一真相源，定义 cmdsift 各平台的 Rust Target 和版本号
 * ======================================================
 */

/**
 * cmdsift 的 GitHub Release 版本标签
 * 对应 cmdsift 仓库 Cargo.toml 中的 version，格式为 v<x.y.z>
 */
const VERSION = 'v1.1.0';

/**
 * cmdsift 的 GitHub 仓库（owner/repo 格式）
 */
const REPO = 'smk-h/cmdsift';

/**
 * 平台映射列表
 * @type {Array<{ os: NodeJS.Platform; cpu: string; target: string; version: string }>}
 */
const platforms = [
  { os: 'win32', cpu: 'x64', target: 'x86_64-pc-windows-msvc', version: VERSION },
  { os: 'linux', cpu: 'x64', target: 'x86_64-unknown-linux-musl', version: VERSION },
];

/**
 * 根据平台信息拼接 npm 包名
 * @param {{ os: string; cpu: string }} p - 平台信息
 * @returns {string} npm 包名，如 @smai-kit/cmdsift-linux-x64
 */
function packageNameFor(p) {
  return `@smai-kit/cmdsift-${p.os}-${p.cpu}`;
}

/**
 * 根据平台信息拼接二进制文件名
 * @param {{ os: string }} p - 平台信息
 * @returns {string} 二进制文件名，如 cmdsift 或 cmdsift.exe
 */
function binaryNameFor(p) {
  return p.os === 'win32' ? 'cmdsift.exe' : 'cmdsift';
}

module.exports = { platforms, packageNameFor, binaryNameFor, VERSION, REPO };
