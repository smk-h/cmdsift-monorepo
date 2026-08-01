<!-- more -->

## 一、 本地测试原理

`local-verify.mjs` 是一个**端到端本地验证脚本**，用于在每次修改 `packages/cmdsift/lib/` 或子包结构后，无需发布到 npm 即可验证「发布出去后真实用户能否正常使用」。

### 1. 核心机制：npm pack + 隔离安装

整个验证基于 npm 原生的 `npm pack` 能力，模拟真实发布的完整链路：

- 对入口包和当前平台子包分别执行 `npm pack`，把 `packages/` 目录打成标准 tarball（与发布到 registry 的产物完全一致）
- 在隔离的临时消费项目里执行 `npm install <tarball>`，复现真实用户安装行为
- 对安装结果、路径解析、二进制可执行性逐项断言

### 2. 为什么用 npm pack 而非 workspace 软链

monorepo 内部用 `npm install` 会建立 workspace 软链（`node_modules/@smai-kit/cmdsift -> packages/cmdsift`），这种方式有两个问题：

- 软链绕过了 `files` 字段的打包过滤，**无法发现 `files` 配置错误**（比如漏配 `lib/` 或 `bin/`）
- 软链不经过 tarball 解包，**无法验证发布产物的真实结构**

`npm pack` 严格按 `package.json` 的 `files` 字段打包，是发布前最接近真实的本地验证手段。

### 3. 临时目录的位置与保留策略

临时产物生成在 [`test/tmp/`](.) 下（已加入根 `.gitignore`），每次运行用时间戳唯一命名：

```
test/tmp/verify-2026-08-01T02-58-39-341Z/
├── pack-XXXXXX/      ← npm pack 产出的 tarball
└── consumer-XXXXXX/  ← 模拟消费项目的 node_modules
```

【**注意**】

临时目录**不会被清理**，保留以便事后排查安装产物。如需清理，手动删除 [`test/tmp/`](.) 即可。

## 二、 与真实安装的区别

理解本地验证与真实用户安装的差异，是正确使用本脚本的前提。

### 1. 真实用户安装：依赖 optionalDependencies 自动分发

当用户在自己的项目里执行：

```sh
npm install @smai-kit/cmdsift
```

npm 的行为分为两个层面：

- **声明层**：只在用户的 `package.json` 的 `dependencies` 中写入 `@smai-kit/cmdsift` 一项，因为用户只显式安装了入口包
- **安装层**：npm 解析入口包的 `optionalDependencies`，按当前系统的 `os` 和 `cpu` 自动筛选并安装匹配的平台子包（Linux 上装 `@smai-kit/cmdsift-linux-x64`，跳过 win32 包）

因此真实安装时，`dependencies` 只有一个包，但 `node_modules` 里会有两个包（入口包加一个平台子包）。

### 2. 本地验证脚本：同时安装两个 tarball

本脚本在临时项目里执行的是：

```js
npm install <入口包.tgz> <平台子包.tgz> --force
```

这里**显式同时安装两个 tarball**，导致临时项目的 `package.json` 的 `dependencies` 里会出现两项：

```json
"dependencies": {
  "@smai-kit/cmdsift": "file:.../smai-kit-cmdsift-0.1.0.tgz",
  "@smai-kit/cmdsift-linux-x64": "file:.../smai-kit-cmdsift-linux-x64-0.1.0.tgz"
}
```

### 3. 为什么本地脚本要显式装两个 tarball

| 维度 | 真实安装 | 本地验证 |
|------|---------|---------|
| 平台子包来源 | 入口包 `optionalDependencies` 自动从 registry 拉取 | 本地 tarball 手动喂给 npm |
| `dependencies` 内容 | 只有入口包 | 入口包加平台子包两项 |
| 是否依赖 registry | 是 | 否 |

本地脚本显式安装平台子包 tarball，是为了**完全脱离 npm registry 运行**——即使包尚未发布、或处于离线环境，验证依然能跑通。这是「本地修改后立即验证」的核心诉求，代价是 `dependencies` 里多出一项（属于验证脚本的正常现象，不影响结论）。

## 三、 使用方法

### 1. 运行验证

```sh
npm run verify
```

该命令对应 [`package.json`](../package.json) 中的 `verify` script，实际执行 `node ./test/local-verify.mjs`。

### 2. 前置条件

脚本运行前需要满足两个条件，否则会提示并退出（不会误报失败）：

- 入口包源码存在：[`packages/cmdsift/lib/index.js`](../packages/cmdsift/lib/index.js)
- 当前平台子包二进制已填充：`packages/cmdsift-<os>-<cpu>/bin/cmdsift`（`bin/` 是构建产物，由 `prepare-binaries` 生成，已 gitignore）

若二进制未填充，先执行对应平台的准备命令：

```sh
npm run prepare-binaries:linux-x64   # Linux 主机
npm run prepare-binaries:win32-x64   # Windows 主机
```

### 3. 适用场景

- 修改 [`packages/cmdsift/lib/index.js`](../packages/cmdsift/lib/index.js) 的路径解析逻辑后验证
- 调整子包 `package.json` 的 `files`、`exports`、`main` 等字段后验证
- 升级二进制版本后回归验证

## 四、 测试用例说明

脚本共 9 个用例，覆盖从打包到执行的完整链路。

### 1. 打包阶段（用例 1-3）

- 用例 1：入口包 `npm pack` 成 tarball
- 用例 2：当前平台子包 `npm pack` 成 tarball
- 用例 3：tarball 内容包含 `lib/index.js` 与 `bin/cmdsift`

此阶段验证 `files` 字段配置正确，能抓到「包发空了」「二进制没打进 tarball」等问题。

### 2. 安装阶段（用例 4-6）

- 用例 4：消费项目 `npm install` 本地 tarball 成功
- 用例 5：入口包与平台子包均进入 `node_modules`
- 用例 6：平台子包 `bin/` 二进制存在且非空

此阶段验证安装链路畅通，能抓到「依赖解析失败」「版本不匹配」等问题。

### 3. 运行阶段（用例 7-9）

- 用例 7：入口包 `cmdsiftPath` 解析到平台子包的二进制路径
- 用例 8：通过 `child_process` 执行二进制，有 stdout 输出且退出码为 0
- 用例 9：ESM 与 CJS 双模导入均返回 `cmdsiftPath`

此阶段验证入口包逻辑与模块系统兼容性，能抓到「路径解析 bug」「`exports` 只支持一种模块系统」等问题。

---
*本文档由 markdowncli 技能辅助生成*
