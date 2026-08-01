<!-- more -->

## 一、 概述

`@smai-kit/cmdsift-linux-x64` 是 cmdsift 的 `linux-x64` 平台二进制包，对应 Rust 编译目标 `x86_64-unknown-linux-musl`。

本包是 [`@smai-kit/cmdsift`](https://www.npmjs.com/package/@smai-kit/cmdsift) 的内部依赖，不应直接安装。

## 二、 是否需要发布到 npm

【**需要**】

本包必须发布到 npm registry。原因如下：

- 入口包 `@smai-kit/cmdsift` 的 `package.json` 中通过 `optionalDependencies` 声明了对本包的依赖
- 用户执行 `npm install @smai-kit/cmdsift` 时，npm 会根据当前操作系统的 `os` 和 `cpu` 字段自动安装匹配的平台子包
- 如果本包未发布到 npm，npm 安装时将无法找到对应平台的二进制文件，入口包的路径解析逻辑会抛出 `Could not find` 错误

## 三、 如何被入口包使用

### 1. 安装时：npm 自动按平台筛选

本包的 `package.json` 中声明了以下字段：

```json
{
  "os": ["linux"],
  "cpu": ["x64"]
}
```

当 npm 安装入口包 `@smai-kit/cmdsift` 时，会遍历其 `optionalDependencies` 列表：

- 当前系统为 `linux-x64` 时，npm 下载并安装本包到 `node_modules/@smai-kit/cmdsift-linux-x64/`
- 当前系统为 `win32-x64` 时，npm 自动跳过本包，转而安装 `@smai-kit/cmdsift-win32-x64`
- 其他不匹配的平台同样被跳过

整个过程由 npm 原生的 `os`/`cpu` 过滤机制完成，无需任何 `postinstall` 脚本或运行时网络请求。

### 2. 运行时：require.resolve 解析路径

入口包 `@smai-kit/cmdsift` 的 `lib/index.js` 中通过以下逻辑定位二进制文件：

```js
// packages/cmdsift/lib/index.js
const arch = process.env.npm_config_arch || process.arch;
const binaryName = process.platform === 'win32' ? 'cmdsift.exe' : 'cmdsift';
const platformPkg = `@smai-kit/cmdsift-${process.platform}-${arch}`;

resolved = require.resolve(`${platformPkg}/bin/${binaryName}`);
```

在 Linux x64 环境下，`process.platform` 为 `linux`，`process.arch` 为 `x64`，拼接出的包名为 `@smai-kit/cmdsift-linux-x64`，最终解析出的路径类似于：

```
node_modules/@smai-kit/cmdsift-linux-x64/bin/cmdsift
```

该路径即为导出的 `cmdsiftPath`，调用方通过 `child_process.execFile(cmdsiftPath, ...)` 执行 cmdsift。

## 四、 是否需要放入二进制文件

### 1. 发布时：必须包含

本包的 `package.json` 中声明了 `"files": ["bin/"]`，表示 `bin/` 目录下的文件会被打包进 npm tarball 并发布到 npm registry。

发布前，需要通过 monorepo 根目录的构建脚本将二进制文件填充到 `bin/` 目录：

```bash
npm run prepare-binaries
```

该脚本会从 cmdsift 的 GitHub Release 页面下载 `x86_64-unknown-linux-musl` 平台的二进制压缩包，经 SHA256 校验后解压到 `packages/cmdsift-linux-x64/bin/cmdsift`。

### 2. Git 仓库中：不包含

`bin/` 目录已被 `.gitignore` 忽略，二进制文件不纳入版本控制。原因如下：

- 二进制文件体积较大，不适合存放在 Git 仓库中
- 二进制文件是构建产物，可随时通过 `prepare-binaries.js` 从 GitHub Release 重新下载
- 避免仓库膨胀，保持 clone 和 pull 操作的效率

### 3. 目录结构

发布到 npm 时，本包的 tarball 内容如下：

```
@smai-kit/cmdsift-linux-x64/
├── package.json
├── README.md
├── LICENSE
└── bin/
    └── cmdsift        ← 预编译的 Linux x64 二进制文件（musl 静态链接）
```

## 五、 平台信息

| 属性 | 值 |
|------|------|
| 操作系统 | Linux |
| CPU 架构 | x64 |
| Rust Target | `x86_64-unknown-linux-musl` |
| 二进制文件名 | `cmdsift` |
| 链接方式 | musl 静态链接 |
| 兼容性 | 可在任意 Linux 发行版上直接运行，无需依赖特定 glibc 版本 |

## 六、 相关项目

- [cmdsift](https://github.com/smk-h/cmdsift) — Rust 源码项目，通过 GitHub Actions 发布二进制到 Release 页面
- [cmdsift-monorepo](https://github.com/smk-h/cmdsift-monorepo) — 本包所属的 monorepo，管理入口包和各平台子包
- [@smai-kit/cmdsift](https://www.npmjs.com/package/@smai-kit/cmdsift) — 入口包，负责运行时路径解析

---
*本文档由 markdowncli 技能辅助生成*
