# Contributing / 参与开发

Thanks for looking. 这个插件不大 —— 一个应用、六个模块、一个测试文件，**没有构建步骤**。

## 环境

```
Node  ≥ 22.13      （用了 node:sqlite 之外的现代 API；实测 22.23.1）
DSH   ≥ 0.2.1-rc.5 （profile 实际装的版本，不是文档版本）
```

**注意版本差**：仓库里的注释按 0.2.2 写，但很多人跑的是 0.2.1。涉及 storage API 的地方以**实际安装版本**为准 —— 0.2.1 的 `KvTable` 没有 `deleteMany`，`lib/queue.js` 里是手工循环的，别改回批量调用。

## 跑起来

```sh
# 装依赖（只有 zod 一个运行时依赖，其余由宿主提供）
pnpm install

# 语法检查（没有构建，只有这一道）
node --check lib/index.js

# 单元测试（完全离线，起本地 HTTP 服务器）
npm test
```

**测试不需要联网、不需要 DSH、不需要 aria2** —— `test/edge.test.mjs` 自己起服务器，自己造 Range 请求。

## 装进一个真实 profile

```sh
dsh plugin --profile <你的 profile> add link:<这个目录的绝对路径>
```

⚠️ **`link:` 装法不会自动登记到 `dsh.profile.bundles`**，需要手动把 `"dsh-dl-server"` 加进 profile 的 `package.json`，否则装了不挂载（这是真机踩过的坑）。

## 代码在哪

| 文件 | 职责 |
| --- | --- |
| `lib/index.js` | `apply()`：开 domain → 起 transport → 恢复队列 → 注册工具 |
| `lib/tools.js` | 七个工具的定义。**`output` 字段是必填的**，缺了注册会抛 |
| `lib/queue.js` | 队列、状态机、归属校验、检查点、清理 |
| `lib/transport.js` | aria2 优先，Node 单流兜底（含 Range 续传） |
| `lib/domain.js` | storage domain 定义（`defineDomain`） |
| `lib/types.js` | 状态枚举与 `J#1042` 这类 job id 的编解码 |
| `test/edge.test.mjs` | 兜底通道、断点续传、盘满拒绝 |

## 改之前请先看这些

```
lib/tools.js 的 CANONICAL_OUTPUT   每个工具都必须带 output（schema + render）
lib/queue.js 的 storageKeyOf       `J#1042` 落盘时会转成 `j1042`，因为
                                   per-record 布局要求 key 匹配 [a-zA-Z0-9_-]+
lib/queue.js 的 recover()          同时处理 running 和 paused(host_restart)
                                    两种中断状态
```

## 提交

- 一个 PR 一件事，别混
- commit message 用 `type(scope): summary`，例如 `fix(queue): 保断点前先校验归属`
- 改行为的 PR 请带一条能跑通的验证方式（命令输出、文件校验、截图都行）
- **别在 PR 里改版本号**，发版由维护者做

## 发现安全问题

**不要开公开 Issue**，走 [SECURITY.md](./SECURITY.md) 里的私密通道。
