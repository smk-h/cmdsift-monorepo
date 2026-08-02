<!-- more -->

## 一、 概述

`cmdsift-monorepo` 是 [cmdsift](https://github.com/smk-h/cmdsift) 命令行工具的 npm 分发仓库。cmdsift 是一个用 Rust 编写的跨平台命令行工具，本 monorepo 将其预编译二进制文件通过 npm 分发，使得 Node.js 项目可以通过 `npm install` 直接获取对应平台的可执行文件，无需手动下载或编译。

本项目的设计参考了 [@vscode/ripgrep](https://github.com/microsoft/vscode-ripgrep) 的 npm 分发方案。

### 1. 包结构

本 monorepo 使用 npm workspaces 管理 3 个子包。根包 `cmdsift-monorepo` 为 `private: true`，不发布到 npm，仅用于本地管理和构建。

| 包名 | 类型 | 内容 | 是否发布到 npm | 原因 |
|------|------|------|----------------|------|
| `@smai-kit/cmdsift` | 入口包 | 纯 JavaScript，不含二进制，仅负责路径解析 | 是 | 用户 `npm install` 时直接安装的包，必须发布 |
| `@smai-kit/cmdsift-win32-x64` | 平台子包 | Windows x64 二进制文件 (`bin/cmdsift.exe`) | 是 | 入口包通过 `optionalDependencies` 引用，npm 按平台自动安装；不发布则找不到二进制 |
| `@smai-kit/cmdsift-linux-x64` | 平台子包 | Linux x64 二进制文件 (`bin/cmdsift`) | 是 | 同上，Linux 平台必须发布 |

两个平台子包都必须发布到 npm registry，原因如下：

- 入口包的 `package.json` 中通过 `optionalDependencies` 声明了对平台子包的依赖
- 用户执行 `npm install @smai-kit/cmdsift` 时，npm 会根据当前操作系统的 `os` 和 `cpu` 字段自动安装匹配的平台子包
- 如果平台子包未发布到 npm，npm 安装时将无法找到对应平台的二进制文件，入口包的路径解析逻辑会抛出 `Could not find` 错误

## 二、 工作原理

### 1. 整体架构

本模块采用 **预编译二进制 + npm optionalDependencies 按平台分发** 的方案，完整链路分为四个阶段：

（1）**构建阶段**：cmdsift 项目通过 GitHub Actions 编译 Rust 源码，产出 Windows 和 Linux 两个平台的二进制压缩包，上传至 GitHub Release 页面
（2）**发布阶段**：本 monorepo 的 `build/prepare-binaries.js` 从 GitHub Release 下载二进制文件，经 SHA256 校验后放入各平台子包的 `bin/` 目录，随后发布到 npm registry
（3）**安装阶段**：用户执行 `npm install @smai-kit/cmdsift` 时，npm 根据平台子包 `package.json` 中的 `os` 和 `cpu` 字段，自动只安装匹配当前操作系统的子包，其余平台子包被跳过
（4）**运行阶段**：`lib/index.js` 通过 `process.platform` 和 `process.arch` 拼接出当前平台对应的子包名，再使用 `require.resolve` 解析出二进制文件的绝对路径并导出

### 2. npm 按平台筛选机制

每个平台子包的 `package.json` 中声明了 `os` 和 `cpu` 字段：

```json
{
  "os": ["linux"],
  "cpu": ["x64"]
}
```

当 npm 安装入口包时，会遍历其 `optionalDependencies` 列表，根据当前系统的 `process.platform` 和 `process.arch` 自动筛选：

- 当前系统匹配时，npm 下载并安装该平台子包
- 当前系统不匹配时，npm 自动跳过该平台子包

整个过程由 npm 原生机制完成，无需任何 `postinstall` 脚本或运行时网络请求。

### 3. 运行时路径解析

入口包 `@smai-kit/cmdsift` 的 `lib/index.js` 中通过以下逻辑定位二进制文件：

```js
// packages/cmdsift/lib/index.js
const arch = process.env.npm_config_arch || process.arch;
const binaryName = process.platform === 'win32' ? 'cmdsift.exe' : 'cmdsift';
const platformPkg = `@smai-kit/cmdsift-${process.platform}-${arch}`;

resolved = require.resolve(`${platformPkg}/bin/${binaryName}`);
```

各平台的解析结果示例：

| 平台 | 拼接的包名 | 解析路径示例 |
|------|-----------|-------------|
| Windows x64 | `@smai-kit/cmdsift-win32-x64` | `node_modules/@smai-kit/cmdsift-win32-x64/bin/cmdsift.exe` |
| Linux x64 | `@smai-kit/cmdsift-linux-x64` | `node_modules/@smai-kit/cmdsift-linux-x64/bin/cmdsift` |

该路径即为导出的 `cmdsiftPath`，调用方通过 `child_process.execFile(cmdsiftPath, ...)` 执行 cmdsift。

### 4. 二进制文件管理

#### 4.1 发布时：必须包含

平台子包的 `package.json` 中声明了 `"files": ["bin/"]`，表示 `bin/` 目录下的文件会被打包进 npm tarball 并发布到 npm registry。

发布前，通过 monorepo 根目录的构建脚本将二进制文件填充到 `bin/` 目录：

```bash
npm run prepare-binaries
```

该脚本会从 cmdsift 的 GitHub Release 页面下载对应平台的二进制压缩包，经 SHA256 校验后解压到各平台子包的 `bin/` 目录。

#### 4.2 Git 仓库中：不包含

`bin/` 目录已被 `.gitignore` 忽略，二进制文件不纳入版本控制。原因如下：

- 二进制文件体积较大，不适合存放在 Git 仓库中
- 二进制文件是构建产物，可随时通过 `prepare-binaries.js` 从 GitHub Release 重新下载
- 避免仓库膨胀，保持 clone 和 pull 操作的效率

#### 4.3 发布时的 tarball 结构

以 Linux x64 平台子包为例，发布到 npm 时 tarball 内容如下：

```
@smai-kit/cmdsift-linux-x64/
├── package.json
├── README.md
├── LICENSE
└── bin/
    └── cmdsift        ← 预编译的二进制文件
```

### 5. 关键特性

- **无 `postinstall` 脚本**：二进制在发布时已预打包进 npm tarball，安装时无需执行任何脚本
- **无运行时网络访问**：所有文件在 `npm install` 阶段已就绪，运行时仅做本地路径解析
- **SHA256 完整性校验**：`binaries.lock.json` 记录每个平台二进制的哈希值，发布前强制校验，防止篡改和损坏
- **支持交叉安装**：运行时优先读取 `npm_config_arch` 环境变量，支持 `npm install --arch=arm64` 等交叉安装场景

## 三、 安装与使用

### 1. 安装

```bash
npm install @smai-kit/cmdsift
```

npm 会根据当前系统的 `os` 和 `cpu` 自动只安装匹配的平台子包，无需手动指定平台。

### 2. 多平台部署

默认的 `npm install @smai-kit/cmdsift` 只会安装当前主机平台的二进制。当需要将同一份项目部署到不同平台的服务器，或在构建机上同时准备多个平台的二进制时，可以显式安装目标平台的子包。

#### 2.1 部署到指定平台服务器

在每个目标服务器上，额外安装该平台的子包（入口包会自动安装主机平台包，此处为补充确保目标平台二进制就位）：

```bash
# 部署到 Linux x64 服务器
npm install @smai-kit/cmdsift-linux-x64 --force --no-save

# 部署到 Windows x64 服务器
npm install @smai-kit/cmdsift-win32-x64 --force --no-save
```

两个关键参数的作用：

- `--force`：绕过平台子包的 `os`/`cpu` 约束，否则非主机平台包会被 npm 以 `EBADPLATFORM` 拦截
- `--no-save`：不把平台子包写入 `package.json` 的 `dependencies`，因为它只是部署时的运行依赖，不应污染项目的依赖声明

#### 2.2 运行时自动选择当前平台

无论安装了几个平台子包，运行时入口包的 `cmdsiftPath` 都会根据 `process.platform` 自动选择当前平台对应的二进制，无需在代码中做任何平台判断。例如在 Linux 服务器上会自动使用 `cmdsift-linux-x64/bin/cmdsift`，在 Windows 服务器上自动使用 `cmdsift-win32-x64/bin/cmdsift.exe`。

### 3. ESM 导入

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

### 4. CommonJS 导入

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

### 5. API

#### 5.1 cmdsiftPath()

cmdsift 可执行文件的绝对路径（`string`），该变量在 `packages/cmdsift/lib/index.js` 文件中导出：

```js
export const cmdsiftPath = resolved;
```

【**函数作用**】

根据当前运行平台的 `process.platform` 和 `process.arch` 自动解析出 cmdsift 可执行文件的绝对路径

【**参数含义**】

无参数，自动从 `process.platform`、`process.arch` 和 `npm_config_arch` 环境变量获取当前平台信息

【**返回值**】

返回 cmdsift 可执行文件的绝对路径字符串，将该路径传给 `child_process.execFile` 或 `child_process.spawn` 即可调用 cmdsift

### 6. 支持的平台

| 操作系统 | CPU 架构 | Rust Target | 二进制文件名 | 链接方式 |
|----------|----------|-------------|-------------|----------|
| Windows | x64 | `x86_64-pc-windows-msvc` | `cmdsift.exe` | MSVC |
| Linux | x64 | `x86_64-unknown-linux-musl` | `cmdsift` | musl 静态链接 |

Linux 版本使用 musl 静态链接，可在任意 Linux 发行版上直接运行，无需担心 glibc 版本兼容性。

## 四、 构建与版本管理

### 1. 构建脚本

| 命令 | 作用 |
|------|------|
| `npm run sync-packages` | 根据根版本号和平台列表同步所有子包的 `package.json`、`README.md` 和 `LICENSE`，并重写 `package-lock.json` |
| `npm run prepare-binaries` | 下载所有平台缺失的二进制文件，用 `binaries.lock.json` 校验 SHA256，不匹配则报错 |
| `npm run prepare-binaries:win32-x64` | 只下载 Windows x64 平台的二进制并校验 |
| `npm run prepare-binaries:linux-x64` | 只下载 Linux x64 平台的二进制并校验 |
| `npm run prepare-binaries -- --force` | 强制重新下载所有平台的二进制文件（仍会校验） |
| `npm run update-lock` | cmdsift 版本升级后，重新下载所有平台二进制并刷新 `binaries.lock.json` 中的 SHA256 哈希 |
| `npm run update-lock:win32-x64` | 只刷新 Windows x64 平台的 SHA256 锁 |
| `npm run update-lock:linux-x64` | 只刷新 Linux x64 平台的 SHA256 锁 |

下载时设置 `GITHUB_TOKEN` 环境变量可避免 GitHub 匿名 API 限流。

### 2. prepare-binaries 与 update-lock 的区别

| | `prepare-binaries` | `update-lock` |
|---|---|---|
| **SHA256 校验** | 下载后用 `binaries.lock.json` 中的哈希校验，不匹配则报错 | 下载后跳过校验，直接把新哈希写入 `binaries.lock.json` |
| **用途** | 发布前准备二进制（日常使用） | cmdsift 升级版本后刷新锁文件 |
| **场景** | 二进制已在锁文件中登记，确认没被篡改 | 二进制是全新版本，锁文件还没有记录 |

简单说：`update-lock` 是"登记新指纹"，`prepare-binaries` 是"用已有指纹验身"。

### 3. 更新 cmdsift 版本

当 cmdsift 发布新版本时，按以下步骤更新本模块：

1. 编辑 `build/platforms.js` 中的 `VERSION` 常量
2. 运行 `npm run update-lock`，重新下载所有平台的二进制文件并更新 `binaries.lock.json` 中的 SHA256 哈希
3. 提交 `build/platforms.js` 和 `binaries.lock.json` 的变更

### 4. 相关项目

- [cmdsift](https://github.com/smk-h/cmdsift) — Rust 源码项目，通过 GitHub Actions 发布二进制到 Release 页面
- [vscode-ripgrep](https://github.com/microsoft/vscode-ripgrep) — 本项目的设计参考，ripgrep 的 npm 分发方案

## 五、 License

MIT

---
*本文档由 markdowncli 技能辅助生成*
