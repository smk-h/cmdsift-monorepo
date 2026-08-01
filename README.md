<!-- more -->

## 一、 概述

`cmdsift-monorepo` 是 [cmdsift](https://github.com/smk-h/cmdsift) 命令行工具的 npm 分发仓库。cmdsift 是一个用 Rust 编写的跨平台命令行工具，本 monorepo 将其预编译二进制文件通过 npm 分发，使得 Node.js 项目可以通过 `npm install` 直接获取对应平台的可执行文件，无需手动下载或编译。

本项目的设计参考了 [@vscode/ripgrep](https://github.com/microsoft/vscode-ripgrep) 的 npm 分发方案。

## 二、 包结构

本 monorepo 使用 npm workspaces 管理 3 个子包：

| 包名 | 类型 | 内容 | 是否发布到 npm |
|------|------|------|----------------|
| `@smai-kit/cmdsift` | 入口包 | 纯 JavaScript，不含二进制，仅负责路径解析 | 是 |
| `@smai-kit/cmdsift-win32-x64` | 平台子包 | Windows x64 二进制文件 (`bin/cmdsift.exe`) | 是 |
| `@smai-kit/cmdsift-linux-x64` | 平台子包 | Linux x64 二进制文件 (`bin/cmdsift`) | 是 |

根包 `cmdsift-monorepo` 为 `private: true`，不发布到 npm。

## 三、 是否需要发布到 npm

### 1. 入口包：需要发布

入口包 `@smai-kit/cmdsift` 必须发布到 npm，这是用户 `npm install` 时直接安装的包。它本身不含二进制文件，仅包含路径解析逻辑。

### 2. 平台子包：需要发布

两个平台子包都必须发布到 npm registry。原因如下：

- 入口包的 `package.json` 中通过 `optionalDependencies` 声明了对平台子包的依赖
- 用户执行 `npm install @smai-kit/cmdsift` 时，npm 会根据当前操作系统的 `os` 和 `cpu` 字段自动安装匹配的平台子包
- 如果平台子包未发布到 npm，npm 安装时将无法找到对应平台的二进制文件，入口包的路径解析逻辑会抛出 `Could not find` 错误

### 3. 根包：不发布

根包 `cmdsift-monorepo` 设置了 `"private": true`，永远不会发布到 npm。它仅用于本地管理和构建。

## 四、 工作原理

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

## 五、 安装与使用

### 1. 安装

```bash
npm install @smai-kit/cmdsift
```

### 2. ESM 导入

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

### 3. CommonJS 导入

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

### 4. API

#### 4.1 cmdsiftPath()

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

## 六、 支持的平台

| 操作系统 | CPU 架构 | Rust Target | 二进制文件名 | 链接方式 |
|----------|----------|-------------|-------------|----------|
| Windows | x64 | `x86_64-pc-windows-msvc` | `cmdsift.exe` | MSVC |
| Linux | x64 | `x86_64-unknown-linux-musl` | `cmdsift` | musl 静态链接 |

Linux 版本使用 musl 静态链接，可在任意 Linux 发行版上直接运行，无需担心 glibc 版本兼容性。

## 七、 本地构建

- `npm run prepare-binaries` — 下载缺失的二进制文件并校验 SHA256，校验失败会报错退出
- `npm run prepare-binaries -- --force` — 强制重新下载所有二进制文件（仍会校验）
- `npm run update-lock` — cmdsift 版本升级后刷新 `binaries.lock.json`
- `npm run sync-packages` — 根据根版本号和平台列表同步所有子包的 `package.json`

下载时设置 `GITHUB_TOKEN` 环境变量可避免 GitHub 匿名 API 限流。

## 八、 更新 cmdsift 版本

当 cmdsift 发布新版本时，按以下步骤更新本模块：

1. 编辑 `build/platforms.js` 中的 `VERSION` 常量
2. 运行 `npm run update-lock`，重新下载所有平台的二进制文件并更新 `binaries.lock.json` 中的 SHA256 哈希
3. 提交 `build/platforms.js` 和 `binaries.lock.json` 的变更

## 九、 相关项目

- [cmdsift](https://github.com/smk-h/cmdsift) — Rust 源码项目，通过 GitHub Actions 发布二进制到 Release 页面
- [vscode-ripgrep](https://github.com/microsoft/vscode-ripgrep) — 本项目的设计参考，ripgrep 的 npm 分发方案

## 十、 License

MIT

---
*本文档由 markdowncli 技能辅助生成*
