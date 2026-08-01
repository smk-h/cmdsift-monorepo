<!-- more -->

## 一、 概述

本 monorepo 以 lockstep 方式发布 3 个 npm 包，它们共享同一个 npm 包版本号（取自根 [`package.json`](package.json) 的 `version`）：

- `@smai-kit/cmdsift` —— 入口包（JS 路径解析器，位于 [`packages/cmdsift/`](packages/cmdsift/)）
- `@smai-kit/cmdsift-<os>-<cpu>` —— 各平台二进制子包（位于 [`packages/`](packages/)）

二进制文件不在本仓库内，发布时由 [`build/prepare-binaries.js`](build/prepare-binaries.js) 从上游 [`smk-h/cmdsift`](https://github.com/smk-h/cmdsift) 的 GitHub Release 下载并做 SHA256 校验。

### 1. 两个独立的版本号

本仓库存在两个**相互独立**的版本号，切勿混淆：

| 版本号 | 位置 | 含义 | 变更时机 |
|--------|------|------|---------|
| 上游二进制版本 | [`build/platforms.js`](build/platforms.js) 的 `VERSION` 常量 | 上游 cmdsift 的 release tag（如 `v0.1.0`）| 上游 cmdsift 发布新二进制 |
| npm 包版本 | 根 [`package.json`](package.json) 的 `version` 字段 | 本仓库发布到 npm 的版本号（如 `0.1.0`）| 本仓库任何改动需要发版时 |

两者数值互不绑死（vscode-ripgrep 的 npm 版本 `1.18.0` 与上游 ripgrep `v15.0.1` 即是如此），但「上游发新版 → 下游必发新版」——因为二进制行为变了，用户必须能通过 npm 拿到新二进制。

【**注意**】

哈希锁与子包清单全部由脚本自动生成，**禁止手填**。版本变更时只需动上述两个真相源之一（或两个都动），脚本会处理其余。

### 2. npm 版本号的语义约定

npm 包版本号采用 semver 三段式 `X.Y.Z`，用三个层级区分**变化来源**，让用户从版本号即可判断变化性质：

```
X . Y . Z
│   │   └─ patch（末位）：仅入口包 JS 代码改动，二进制不变（末位 +1）
│   └───── minor（中位）：上游二进制更新（中位 +1，末位归零）
└───────── major（首位）：破坏性变更（首位 +1，中位与末位归零）
```

三种典型发版情况对应的操作：

| 情况 | 谁变了 | semver bump | 示例 | 怎么操作 |
|------|--------|------------|------|---------|
| ① 仅入口包更新 | `lib/index.js` 等 JS 代码 | patch | 0.2.3→0.2.4 | 人工改 version + `npm run sync-packages` |
| ② 仅上游二进制更新 | cmdsift 二进制 | minor | 0.2.3→0.3.0 | `npm run auto-upgrade`（自动 minor bump）|
| ③ 两者都更新 | JS + 二进制 | minor | 0.2.3→0.3.0 | 先改 JS，再 `npm run auto-upgrade`（自动 minor bump）|

【**patch 归零规则**】

情况②③触发 minor bump 时，patch 位会**归零**。例如当前是 `0.2.3`（已发过 3 个入口包补丁），上游二进制一更新就变成 `0.3.0`（不是 `0.3.3`）。这样 minor 版本永远是「该二进制版本的第一个发布」，patch 位干净地记录「这个二进制版本下又改了几次入口包」。

这样约定后，版本号的语义清晰可读：

- 看到 patch 位非 0（如 `0.2.3`）→ 知道在这个二进制版本下又改了 3 次入口包代码
- 看到 minor 位变化（如 `0.2.x` → `0.3.0`）→ 知道二进制更新了，patch 计数从头开始

## 二、 升级上游二进制版本

当上游 `smk-h/cmdsift` 发布了新的 GitHub Release（如 `v0.2.0`）时使用本流程（对应第一章的情况②③）。`auto-upgrade` 脚本会一次性完成「更新二进制版本 + minor bump npm 版本 + 同步子包」。

### 1. 运行自动升级脚本

```sh
npm run auto-upgrade
```

该脚本自动完成 5 步：

- 查询上游最新 release tag（或用 `--target=v0.2.0` 指定版本）
- 若 [`build/platforms.js`](build/platforms.js) 已是该版本则跳过（退出码 2）
- 更新 `VERSION` 常量
- 下载各平台 archive、计算 SHA256 并重写 [`binaries.lock.json`](binaries.lock.json)
- **minor bump npm 版本号**（中位 +1、末位归零，如 `0.2.3` → `0.3.0`）并运行 `sync-packages` 同步到子包

脚本需要访问 GitHub Releases，建议设置 `GITHUB_TOKEN` 以避免匿名 API 限流：

```sh
GITHUB_TOKEN=<your-token> npm run auto-upgrade
```

### 2. 提交并发布

需要提交的文件由脚本自动改好，包括：

- [`build/platforms.js`](build/platforms.js)（新二进制版本常量）
- [`binaries.lock.json`](binaries.lock.json)（新 SHA256）
- 根 [`package.json`](package.json)（minor bump 后的 npm 版本）
- 所有由 `sync-packages` 重新生成的 [`packages/`](packages/) 下的 `package.json`、`README.md`、`LICENSE`

提交信息中带上 `[publish]` 关键字即可触发 CNB 发布流水线（版本号取脚本输出的 npm 版本）：

```sh
git commit -m "release: 0.3.0 [publish]"
```

## 三、 仅发布入口包代码改动

当只改动了 [`packages/cmdsift/lib/`](packages/cmdsift/lib/) 下的 JS 代码（如修复 README、调整路径解析逻辑），不涉及上游二进制升级时使用本流程（对应第一章的情况①）。

### 1. patch bump npm 包版本

此场景**不需要**运行 `auto-upgrade`（上游二进制没变），也**不需要**运行 `update-lock`。

按 semver 约定，仅入口包代码改动对应 **patch** 升级（末位 +1，中位不变）。编辑根 [`package.json`](package.json) 的 `version` 字段（如 `0.3.0` → `0.3.1`）。

### 2. 同步并提交

```sh
npm run sync-packages
git add -A
git commit -m "release: 0.3.1 [publish]"
```

## 四、 添加新平台

当需要支持新的 OS/CPU 组合时使用本流程。

### 1. 新增平台映射

在 [`build/platforms.js`](build/platforms.js) 的 `platforms` 数组中追加一项：

```js
// build/platforms.js
const platforms = [
  { os: 'win32', cpu: 'x64', target: 'x86_64-pc-windows-msvc', version: VERSION },
  { os: 'linux', cpu: 'x64', target: 'x86_64-unknown-linux-musl', version: VERSION },
  { os: 'darwin', cpu: 'arm64', target: 'aarch64-apple-darwin', version: VERSION }, // 新增
];
```

其中 `target` 为对应的 Rust 编译三元组（triple），必须与上游 release asset 的命名一致。

### 2. 填充哈希锁

```sh
npm run update-lock:<新平台的 short name>
```

或直接运行全量 `npm run update-lock` 为新平台补上 SHA256。

### 3. 生成子包目录

```sh
npm run sync-packages
```

该脚本会自动创建 [`packages/cmdsift-<os>-<cpu>/`](packages/) 目录及其 `package.json`、`README.md`、`LICENSE`。

### 4. 更新发布流水线

在 [`.cnb/workflows/npm-publish.yml`](.cnb/workflows/npm-publish.yml) 中复制一个现有的平台发布阶段，替换其中的包名和 workspace 参数。

### 5. 升级版本并提交

新增平台属于功能性变化，按 semver 约定对应 **minor** 升级（中位 +1、末位归零，如 `0.3.1` → `0.4.0`）。编辑根 [`package.json`](package.json) 的 `version` 字段，运行 `sync-packages`，提交带 `[publish]` 的 commit。

## 五、 CI 发布流水线行为

发布流水线定义在 [`.cnb/workflows/npm-publish.yml`](.cnb/workflows/npm-publish.yml)，由提交信息包含 `[publish]` 触发，依次执行以下阶段：

1. `npm ci --force` 安装依赖（`--force` 用于跳过非宿主平台子包的 os/cpu 校验，这是 workspace 模式下的正常现象，无副作用）
2. `npm run sync-packages` 保证发布的清单与提交的根版本一致（即便开发者本地忘了运行也无妨）
3. `npm run prepare-binaries` 下载并 SHA256 校验二进制
4. 依次发布平台子包（`linux-x64`、`win32-x64`），最后发布入口包 `@smai-kit/cmdsift`

【**发布顺序**】

平台子包必须先于入口包发布，因为入口包的 `optionalDependencies` 指向它们——若顺序颠倒，用户在安装入口包时会因找不到平台子包而报错。

每个发布阶段都内置了幂等保护：发布前先用 `npm view` 查询目标版本是否已存在，已存在则跳过该包，避免重试时触发 `EPUBLISHCONFLICT`。

## 六、 发布前本地验证

```sh
# 1. 确保所有子包清单与根版本同步
npm run sync-packages

# 2. 下载当前宿主平台的二进制（以 Windows x64 为例）
node build/prepare-binaries.js --target x86_64-pc-windows-msvc

# 3. 安装 workspace 并验证入口包能解析到同仓的兄弟子包
#    --force 用于跳过非宿主平台包的 os/cpu 校验（无害）
npm install --force

# 4. 验证解析路径
node -e "import('@smai-kit/cmdsift').then(m => console.log(m.cmdsiftPath))"
```

输出的路径应位于 [`packages/cmdsift-<你的os>-<你的cpu>/bin/`](packages/) 下。

更完整的端到端验证（模拟真实用户安装）可运行：

```sh
npm run verify
```

该命令基于 `npm pack` 在隔离临时目录模拟安装，无需发布即可验证改动对下游可用。

---
*本文档由 markdowncli 技能辅助生成*
