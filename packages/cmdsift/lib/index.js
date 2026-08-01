/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : index.js
 * Author     : sumu
 * Date       : 2026/08/01
 * Version    : 0.1.0
 * Description: cmdsift 二进制路径解析模块，根据当前平台解析对应的
 *              cmdsift 可执行文件绝对路径
 * ======================================================
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// 优先取 npm_config_arch 以支持交叉安装场景（如 --arch=arm64）
const arch = process.env.npm_config_arch || process.arch;
// Windows 平台二进制文件名带 .exe 后缀
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

/** cmdsift 可执行文件的绝对路径 */
export const cmdsiftPath = resolved;
