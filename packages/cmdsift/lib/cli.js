#!/usr/bin/env node
/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : cli.js
 * Author     : sumu
 * Date       : 2026/08/02
 * Version    : 0.1.0
 * Description: cmdsift CLI 封装脚本，将命令行参数透传给当前平台
 *              对应的 cmdsift 原生二进制文件
 * ======================================================
 */

import { spawn } from 'node:child_process';
import { cmdsiftPath } from './index.js';

const child = spawn(cmdsiftPath, process.argv.slice(2), {
  stdio: 'inherit',
  windowsHide: false,
});

child.on('error', (err) => {
  console.error(err);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
  } else {
    process.exit(code ?? 0);
  }
});
