# dsh-dl-server · 规格 v0.1

> **DLS** — DSH Download Server
> 大肥鱼自己的下载服务器插件
>
> *DLS is all you need*

---

## 0. 定位

一个挂在 DSH 上的**全局下载服务**：跨会话可见、按会话归属、持久化队列、可暂停恢复。

### 现在有谁在做这件事

目前能找到的、跟下载直接相关的 DSH 插件，一共四个：

| 插件 | 做对了什么 | 缺什么 |
| --- | --- | --- |
| **dsh-mt-download** | 16 路 aria2c 并发；aria2 不在时退回 Node 单流；按域名自动补 `Referer`（抖音 / B站 / 小红书 / 微博 / GitHub）；零运行时依赖 | 一次只下一个文件，调用阻塞到结束；没有队列、没有暂停、没有跨会话续传 |
| **dsh-rayburst** | 直接接 Rayburst（aria2-next 内核），断点续传 + 多线程 | 16 KB 薄壳，能力全在外置内核；没有队列、没有归属、没有权限 |
| **dsh-motrix-download** | 复用本机 Motrix，把下载转手给现成的下载器 | 依赖外部 App 常驻；没有队列，没有状态 |
| **dsh-ops-guard** | 在 `tools/pre-execute` 上把 shell 下载命令拒掉，强制统一走 aria2；顺手把文件搜索也换成了 Everything | 只有"拦截"没有"实现" —— 拒掉之后不给替代命令，也没有逃生门；用户被卡住就只能自己绕 |

### 它们的共同形状

```
download_file(url, path)  →  阻塞，等到下完才返回
```

**都是"一次调用、一个文件、一个回合"。** 没有人做队列。

### 四个共同的缺口

```
① 会话结束 / 回合结束  →  下载就断了
② 不能排队、不能暂停、不能恢复
③ 别的会话看不见你在下什么
④ 重启之后什么都没了
```

### DLS 做什么：融于一炉

```
传输      借 dsh-mt-download 的通道策略（aria2 优先，Node 兜底），不重写
编排      借 PCL2 的下载引擎设计（见下）
常驻      队列活在插件生命周期里 —— 活过回合、活过会话、活过重启
全局      所有会话看得见全部任务；只有 owner 能操作进行中的
权限      按会话归属 + 状态分级，没有超级管理员
策略      借 dsh-ops-guard 的 pre-execute 钩子（v2），但留一道逃生门
```

### 从 PCL2 借了什么

PCL2（Plain Craft Launcher 2）的下载器是这个领域里被打磨得最久的实现。抄的是**设计**，不是代码（C# → JS）：

```
片段链表 + 从最大碎片尾部切 40%            而不是均分 N 份
下载源三态：正常 / 只能单线程 / 已禁用       区分「讨厌并发」和「真的坏了」
自适应超时  clamp(平均连接时间,15s,30s) × (1+失败次数)
慢速判死    间隔 > 5s 且速度 < 1 KB/s
镜像 = 字符串替换，但按 URL 特征分支         注定失败的源不去试
超时切换 + 失败提速                          两条触发线
ProgressWeight 的单位是「秒」                进度条在时间维度上匀速
进度曲线 1-(1-p)^0.9                        不卡在 99%
```

### 从 PCL2 没借到的（也就是我们存在的理由）

PCL2 下载器的生命周期止于进程退出 ——

```
它的临时目录在下次启动时会被整个删掉
续传只到「文件级」：下完的跳过，半截的重来
```

对"一次下 500 个库文件"这已经够用；对"下一个 8 GB 的模型"，半截的东西全废。

**DLS 补的就是这一段。**

### 一句话

> 四个插件各解决了一角，PCL 解决了"下得又快又对"。
> DLS 把它们融成一个：**能排队、能续、能看见、有归属**。
>
> 做到这一步，你只需要这一个 —— 大肥鱼自己的下载插件。
>
> ***DLS is all you need***

---

## 1. 范围

### v1 做

| 项 | 说明 |
|---|---|
| 持久化队列 | 重启后任务还在，能续 |
| 分段 + 断点 | 靠 aria2c；没有就退回 Node 单流 |
| 多会话可见 | 所有会话能看到全部任务 |
| 按会话归属 | 只有 owner 能操作进行中的任务 |
| 暂停 / 恢复 / 取消 | 真正的队列控制 |
| 清理 | 按作用域清记录和缓存 |

### v1 不做

| 项 | 放到 |
|---|---|
| 用户 UI 面板 | v3 |
| 用户操作回传 agent | v3 |
| `pre-execute` 拦截 shell 下载 | v2 |
| 种子 / magnet | v2 |
| 自己的分段引擎（不依赖 aria2） | v2 |
| 内容寻址 / 引用计数 | v2 |

---

## 2. 包结构

**v1 单包**，不做 monorepo 拆分。

```
dsh-dl-server/
├ package.json
├ cordis.patch.yml
├ README.md
└ src/
  ├ index.ts          插件入口：export name / inject / apply
  ├ tools.ts          七个工具的注册
  ├ queue.ts          队列引擎：调度、并发、状态迁移
  ├ transport.ts      传输抽象 + aria2 通道 + Node 兜底
  ├ domain.ts         defineDomain 声明
  └ types.ts          JobRecord / JobState
```

依赖注入声明：

```ts
export const name = 'dsh-dl-server'
export const inject = ['tools', 'storageDomain', 'jobs']
```

---

## 3. 数据模型

### JobRecord

```ts
interface JobRecord {
  /** J#1042 */
  readonly id: string
  /** 单调序号，与 id 中的数字一致 */
  readonly seq: number

  /** 归属：父会话 */
  readonly ownerWorkspace: string      // WorkspaceId (uuid)
  readonly ownerSession: string        // SessionId (uuid)，父会话
  /** 谁发起的（子代理名），仅展示与审计 */
  readonly origin?: string

  /** 下载目标 */
  readonly urls: readonly string[]
  readonly destPath: string

  state: JobState

  readonly createdAt: number
  updatedAt: number

  /** 已知总字节；未知为 -1 */
  bytesTotal: number
  /** 检查点字节（不是实时进度） */
  bytesCheckpoint: number

  /** 最近一次失败原因 */
  lastError?: string
  /** 重试次数 */
  attempts: number

  /** 校验（可选） */
  readonly expectSha256?: string
  /** 完成后的真实大小 */
  finalBytes?: number
}
```

### 状态机

```
queued ──start──▶ running ──done──▶ completed
                    │  ▲
              fail  │  │ resume
                    ▼  │
                  paused
                    │
                    └─cancel──▶ canceled
                    ▲
              cancel └────────┘
```

| 迁移 | 触发 |
|---|---|
| `queued → running` | 调度器取到槽位 |
| `running → paused` | 用户暂停 / 会话关闭 / DSH 重启 |
| `running → completed` | 下载完成且校验通过 |
| `running → failed` | 超过重试上限 |
| `running → canceled` | 用户取消 / owner 会话被删除 |
| `paused → running` | 用户恢复 / 会话重开（可配置） |
| `paused → canceled` | 用户取消 / owner 会话被删除 |

**终态**：`completed` / `failed` / `canceled`。终态不可再迁移（重下 = 新建 job）。

---

## 4. 存储

```ts
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'

export const JobDomain = defineDomain({
  name: 'dsh-dl-jobs',
  version: 1,
  layout: 'per-record',
  invalidRecords: 'backup-and-skip',
  tables: {
    jobs: domainTable<JobId, JobRecord>(JobRecordSchema),
  },
  global: {
    initial: { nextSeq: 1 },
    schema: z.object({ nextSeq: z.number().int().positive() }),
  },
})
```

### 为什么是 `per-record`

> 一条 job 坏掉不该让整个队列打不开。

用 `single` 布局时，任何一条记录 schema 校验失败 → **整个 domain 打不开** → 插件废掉。

### 进度不落库

```
状态变化        立即写
字节进度        不写（内存 + 事件）
检查点          每 30 秒写一次
```

理由：进度每秒变几次，每次写都是一个事务；而且 `domain/changed` 事件会被进度刷屏。

---

## 5. 工具清单

### `download_enqueue`

```ts
{
  urls:       string[]          // 多个候选源，按顺序试
  dest:       string            // 绝对路径或目录
  sha256?:    string
  connections?: number          // 默认 16，aria2 上限
  headers?:   Record<string,string>
}
→ { jobId: 'J#1042', state: 'queued' }
```

### `download_status`

```ts
{ id?: string }        // 省略 = 列出全部可见任务
→ {
    jobs: Array<{
      id, state, owner, origin?,
      dest, bytesTotal, bytesDone, speedBps, etaSeconds?,
      url, lastError?, createdAt, updatedAt
    }>
  }
```

### `download_wait`

```ts
{ id: string, timeoutSeconds?: number }    // 默认 60，上限 600
→ { state, bytesTotal, finalBytes?, error? }
```

### `download_pause` / `download_resume` / `download_cancel`

```ts
{ id: string }
→ { id, state }
```

**仅 owner 可调用。**

### `download_cleanup`

```ts
{ scope: 'records' | 'cache' | 'allWithoutFiles' | 'all' }
→ {
    scope,
    removedRecords: number,
    removedCacheFiles: number,
    removedFiles: number,
    freedBytes: number
  }
```

**默认 `allWithoutFiles`。`all` 才删成品文件。**

---

## 6. 权限

```
状态        读       owner 写      非 owner 写
queued      ✅       ✅             ❌
running     ✅       ✅             ❌
paused      ✅       ✅             ❌
completed   ✅       ✅（删记录）    ✅（删记录 / 重下）
failed      ✅       ✅             ✅
canceled    ✅       ✅             ✅
```

**没有超级管理员。** 面板（v3）上的按钮 = 这套规则的另一入口。

### 错误码

| code | 情形 |
|---|---|
| `not-found` | job 不存在 |
| `not-owner` | 非 owner 试图操作 |
| `bad-state` | 状态不允许该操作 |
| `disk-full` | 目标盘空间不足 |
| `url-invalid` | URL 解析失败 |
| `transport-unavailable` | aria2 和 Node 通道都不可用 |

---

## 7. 生命周期与 `ctx.jobs`

**两层分工：**

```
运行期    ctx.jobs.start({ kind: 'download', owner: exec.agent, run })
          → 白拿控制工具、完成通知、owner dispose 清理、并发上限

持久层    自己的 dsh-dl-jobs domain
          → 状态机、重启恢复、检查点
```

### 会话事件的对应

| 事件 | 动作 | 缓存 |
|---|---|---|
| 会话关闭（可重开） | `running → paused`，`reason: session_closed` | 保留 |
| 会话被删除 | `running/paused → canceled` | 清空 |
| DSH 重启 | 启动时把所有 `running` 改成 `paused`，`reason: host_restart` | 保留 |
| 启动扫描 | owner 已不存在的 → `canceled` | 清空 |

**默认行为：暂停。只有 owner 真的不存在了才取消。**

### 恢复

```
paused(session_closed)  →  会话重开时自动恢复（可配置关闭）
paused(host_restart)    →  启动后自动恢复（可配置关闭）
paused(user)            →  只能手动恢复
```

---

## 8. 传输层（v1）

```
① 探测 aria2c
   PATH → MT_ARIA2C_PATH / ARIA2C_PATH → 常见安装位置

② 有 aria2c
   JSON-RPC，多连接分段、断点续传、限速
   由 DLS 拉起，随插件退出而关闭

③ 没有 aria2c
   Node fetch 单流落盘
   慢，但能下完
```

**v1 不自己写分段引擎。** 传输层的差异点不在"多线程"，在"队列和持久化"。

---

## 9. 配置

```yaml
dsh-dl-server:
  # 并发
  maxConcurrentJobs: 3
  connectionsPerJob: 16

  # 传输
  aria2Path: ""                  # 留空自动探测
  aria2Port: 16801
  speedLimitKbps: 0              # 0 = 不限
  proxy: ""                      # 例 http://127.0.0.1:65532

  # 存储
  defaultDownloadDir: ""         # 留空 = 工作区下 .dls/
  checkpointSeconds: 30

  # 生命周期
  autoResumeOnSessionReopen: true
  autoResumeOnHostRestart: true

  # 清理
  keepCompletedRecords: 200      # 超过就自动裁剪最老的
```

---

## 10. 挂接点

| 位置 | 用途 |
|---|---|
| `ctx.tools.register(defineTool(...))` | 七个工具 |
| `ctx.storageDomain.open(JobDomain)` | 队列持久化 |
| `ctx.jobs.start({ owner: exec.agent })` | 运行期任务 |
| `ctx.on('domain/changed')` | 队列变更 → 触发调度 |
| `ctx.tools.guard(...)` | **v2**：拦 shell 下载命令 |

---

## 11. 路线

```
v1  队列 + 持久化 + 七个工具 + aria2 传输       ← 现在
v2  拦截钩子 / 种子 / 自研分段 / 内容寻址
v3  用户面板 + 操作回传（agent.inject）
```

---

## 12. 验收标准（v1）

```
1. enqueue 一个大文件 → status 能看到进度 → 完成
2. 下到一半 pause → resume → 接着下（不重头）
3. 下到一半关 DSH → 重开 → 任务还在，变 paused
4. 重开后 resume → 从检查点继续
5. 会话 A 的 job，会话 B 调 pause → not-owner
6. 会话 B 调 status → 能看到 A 的 job
7. cleanup(allWithoutFiles) → 记录没了，文件还在
8. cleanup(all) → 文件也没了
9. 没装 aria2c → 自动退回 Node 单流，仍能完成
10. 目标盘空间不足 → 入队时直接 disk-full
```

---

## 附：已核实的 API

```ts
// @deepseek-ai/dsh-tools
ctx.tools.register(definition: ToolDefinition, options?): () => void
ctx.tools.guard(guard: ToolGuard): () => void
defineTool(spec)                                   // packages/core/tools/src/schema.ts:555

// @deepseek-ai/dsh-jobs
ctx.jobs.start(spec: JobSpec): JobId

// @deepseek-ai/dsh-storage-domain
defineDomain(spec): S                              // packages/storage/storage-domain/src/spec.ts:107
domainTable<K, V>(schema)                          // 同文件:91

// 会话与工作区
ctx.sessions.scopeOf(ctx): SessionId | undefined
ctx.sessions.subagentAddress(id) → { kind:'subagent', parentSessionId, ... }
```

---

*SPEC v0.1 · 2026-11-08*
