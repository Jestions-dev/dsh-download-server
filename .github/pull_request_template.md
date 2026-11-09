## 这个 PR 做了什么

<!-- 一两句话。修了什么、加了什么，别贴 diff。 -->

## 为什么要做

<!-- 解决的是哪个具体问题？有没有 Issue 编号？ -->

Closes #

## 改动的范围

- [ ] `lib/tools.js`（工具定义 / 返回值）
- [ ] `lib/queue.js`（队列、状态机、归属、清理）
- [ ] `lib/transport.js`（aria2 / 单流兜底）
- [ ] `lib/domain.js`（存储结构 —— **会涉及迁移**）
- [ ] `lib/types.js`
- [ ] `test/`
- [ ] 文档（README / SPEC / 注释）

## 验证方式

<!-- 必填。改了行为就得有一条能复现的验证路径。 -->

```
# 命令、输出、文件校验，随便哪种
```

- [ ] `node --check` 全部通过
- [ ] `npm test` 通过（离线，不需要 DSH / aria2）
- [ ] 在真实 profile 里跑过（贴一句 `download_status` 的输出）

## 有没有可能踩到这些

- [ ] **`output` 字段**：新加/修改的工具都带了 `output.schema` 和 `output.render` 吗？缺了注册会抛，而且日志里只会看到「没注册上」
- [ ] **存储 key**：`J#1042` 落盘会转成 `j1042`，per-record 布局要求 key 匹配 `[a-zA-Z0-9_-]+`。新写的 id 符合吗？
- [ ] **0.2.1 兼容**：动了 storage API 吗？0.2.1 的 `KvTable` 没有 `deleteMany`
- [ ] **归属校验**：改动涉及 pause / resume / cancel / cleanup 时，非 owner 还拦得住吗？
- [ ] **盘满 / 断网**：失败路径会抛 `QueueError`，还是会让 `download_status` 崩溃？

## 版本号

- [ ] 我**没有**改 `package.json` 里的 version（发版由维护者做）
