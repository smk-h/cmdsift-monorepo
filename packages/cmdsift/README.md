# @smai-kit/cmdsift

在 Node.js 项目中使用 [cmdsift](https://github.com/smk-h/cmdsift) 命令行工具的 npm 模块。

## 简介

`@smai-kit/cmdsift` 是 [cmdsift](https://github.com/smk-h/cmdsift) 的 npm 包装包。cmdsift 是一个用 Rust 编写的跨平台命令行工具，本模块将其预编译二进制文件通过 npm 分发，使得 Node.js 项目可以通过 `npm install` 直接获取对应平台的可执行文件，无需手动下载或编译。

## 工作原理

本模块采用 **预编译二进制 + npm optionalDependencies 按平台分发** 的方案，与 [@vscode/ripgrep](https://github.com/microsoft/vscode-ripgrep) 的设计完全一致：

### 包结构

| 包名 | 类型 | 内容 |
|------|------|------|
| `@smai-kit/cmdsift` | 入口包 | 纯 JavaScript，不含二进制，仅负责路径解析 |
| `@smai-kit/cmdsift-win32-x64` | 平台子包 | Windows x64 二进制文件 (`bin/cmdsift.exe`) |
| `@smai-kit/cmdsift-linux-x64` | 平台子包 | Linux x64 二进制文件 (`bin/cmdsift`) |

### 分发机制

1. **构建阶段**：cmdsift 项目通过 GitHub Actions 编译 Rust 源码，产出 Windows 和 Linux 两个平台的二进制压缩包，上传至 GitHub Release 页面
2. **发布阶段**：本 monorepo 的 `build/prepare-binaries.js` 从 GitHub Release 下载二进制文件，经 SHA256 校验后放入各平台子包的 `bin/` 目录，随后发布到 npm registry
3. **安装阶段**：用户执行 `npm install @smai-kit/cmdsift` 时，npm 根据平台子包 `package.json` 中的 `os` 和 `cpu` 字段，**自动只安装匹配当前操作系统的子包**，其余平台子包被跳过
4. **运行阶段**：`lib/index.js` 通过 `process.platform` 和 `process.arch` 拼接出当前平台对应的子包名，再使用 `require.resolve` 解析出二进制文件的绝对路径并导出

### 关键特性

- **无 `postinstall` 脚本**：二进制在发布时已预打包进 npm tarball，安装时无需执行任何脚本
- **无运行时网络访问**：所有文件在 `npm install` 阶段已就绪，运行时仅做本地路径解析
- **SHA256 完整性校验**：`binaries.lock.json` 记录每个平台二进制的哈希值，发布前强制校验，防止篡改和损坏
- **支持交叉安装**：运行时优先读取 `npm_config_arch` 环境变量，支持 `npm install --arch=arm64` 等交叉安装场景

## 安装

```bash
npm install @smai-kit/cmdsift
```

## 使用示例

### ESM 导入

```js
import { cmdsiftPath } from '@smai-kit/cmdsift';
import { execFile } from 'node:child_process';

execFile(cmdsiftPath, ['--help'], (error, stdout, stderr) => {
  if (error) {
    console.error(error);
    return;
  }
  console.log(stdout);
});
```

### CommonJS 导入

```js
const { cmdsiftPath } = require('@smai-kit/cmdsift');
const { execFile } = require('node:child_process');

execFile(cmdsiftPath, ['--help'], (error, stdout, stderr) => {
  if (error) {
    console.error(error);
    return;
  }
  console.log(stdout);
});
```

## API

### `cmdsiftPath`

cmdsift 可执行文件的绝对路径（`string`）。

根据当前运行平台的 `process.platform` 和 `process.arch` 自动解析：

| 平台 | 解析路径示例 |
|------|-------------|
| Windows x64 | `node_modules/@smai-kit/cmdsift-win32-x64/bin/cmdsift.exe` |
| Linux x64 | `node_modules/@smai-kit/cmdsift-linux-x64/bin/cmdsift` |

将该路径传给 `child_process.execFile` 或 `child_process.spawn` 即可调用 cmdsift。

## 支持的平台

| 操作系统 | CPU 架构 | Rust Target | 二进制格式 |
|----------|----------|-------------|-----------|
| Windows | x64 | `x86_64-pc-windows-msvc` | `.exe` (MSVC) |
| Linux | x64 | `x86_64-unknown-linux-musl` | ELF (musl 静态链接) |

Linux 版本使用 musl 静态链接，可在任意 Linux 发行版上直接运行，无需担心 glibc 版本兼容性。

## 更新 cmdsift 版本

当 cmdsift 发布新版本时，按以下步骤更新本模块：

1. 编辑 `build/platforms.js` 中的 `VERSION` 常量
2. 运行 `npm run update-lock`，重新下载所有平台的二进制文件并更新 `binaries.lock.json` 中的 SHA256 哈希
3. 提交 `build/platforms.js` 和 `binaries.lock.json` 的变更

## 本地构建

- `npm run prepare-binaries` — 下载缺失的二进制文件并校验 SHA256，校验失败会报错退出
- `npm run prepare-binaries -- --force` — 强制重新下载所有二进制文件（仍会校验）
- `npm run update-lock` — cmdsift 版本升级后刷新 `binaries.lock.json`
- `npm run sync-packages` — 根据根版本号和平台列表同步所有子包的 `package.json`

下载时设置 `GITHUB_TOKEN` 环境变量可避免 GitHub 匿名 API 限流。

## 相关项目

- [cmdsift](https://github.com/smk-h/cmdsift) — Rust 源码项目，通过 GitHub Actions 发布二进制到 Release 页面
- [cmdsift-monorepo](https://github.com/smk-h/cmdsift-monorepo) — 本模块所属的 monorepo，管理入口包和各平台子包
- [vscode-ripgrep](https://github.com/microsoft/vscode-ripgrep) — 本项目的设计参考，ripgrep 的 npm 分发方案

## License

MIT
