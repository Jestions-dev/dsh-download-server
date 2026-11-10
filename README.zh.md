# dsh-dl-server

[English](README.md) | 中文

**DLS** — DSH Download Server
大肥鱼自己的下载服务器插件

> 下载不该活在会话里。

---

## 装

### 方式一：界面（推荐）

```
设置 → 插件 → 安装第三方插件 → 添加插件
```

输入框里填 **`dsh-dl-server@0.1.1`**，确认，然后**重启一次 DSH**。

### 方式二：命令行

```sh
dsh plugin add dsh-dl-server@0.1.1
```

> **带上 `@0.1.1`。** `0.1.0` 把 `@deepseek-ai/dsh-storage-domain` 声明成了普通依赖，pnpm 会给插件装第二份，服务和宿主对不上、插件挂不住（全部 `pending`）。0.1.1 改成 `peerDependencies` 已修复。
>
> 另外 pnpm 会缓存 registry 元数据 —— 不带版本号时可能仍然解析到 `0.1.0`。

> `dsh` 需要先在 PATH 里。桌面版自带的那份在
> `…\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd`，没加过 PATH 的话用方式一。

**要求 DSH 0.2.1 或以上。**
**aria2 可选** —— 装了走 16 线程分段，没装走单流兜底，一样能下，只是慢一些。

---

## 它解决什么

现有的 DSH 下载插件几乎都是「一个工具函数 + 阻塞等到文件落地」。它们让下载**变快**，但没解决三件事：

- 会话或回合结束，下载就断了
- 不能排队、不能暂停恢复
- 进程重启，什么都没了

DLS 做的是**队列层**，不是传输层。

```
任务活在 DSH 里，不活在会话里
```

一个会话发起的下载，其他会话都能看见进度和落盘路径；但只有发起它的那个会话能暂停、续传、取消。

---

## 七个工具

| 工具 | 作用 |
| --- | --- |
| `download_enqueue` | 入队，**立刻返回** jobId，不等下载 |
| `download_status` | 看队列和单个任务的进度（`J#1042` 这种 id） |
| `download_wait` | 等某个任务到终态，带超时 |
| `download_pause` | 暂停，**保留已下字节** |
| `download_resume` | 从断点接着下 |
| `download_cancel` | 取消，可选删掉半截文件 |
| `download_cleanup` | 清记录（默认不动已下载的文件） |

## 用它

```
你： 把这两个 PDF 下到 D:\Papers，下完告诉我
```

agent 会调 `download_enqueue` 两次拿到 `J#10` / `J#11`，然后 `download_wait`。

**入队就返回**，所以它可以一次发十个，不用等。

---

## 实测

同一台机器，同一个文件：

| 场景 | 结果 |
| --- | --- |
| 清华 TUNA 源 · 单连接 | 43.98 MB/s |
| 清华 TUNA 源 · 16 线程（其他插件） | 54.20 MB/s |
| 清华 TUNA 源 · **DLS** | **61.08 MB/s**（跑满 500M 链路） |
| HuggingFace · 单流兜底 | 1.00 MB/s |
| HuggingFace · **DLS** | **6.96 MB/s**（7 倍） |

最后一个说明问题：**被限速的源上，分段比带宽更值钱。**

---

## 已知行为（不是 bug）

- **归属按会话**：同一台机器上任何会话都能**看见**全部任务，但只有 owner 能改。
- **`cleanup(scope="all")` 会删文件**；默认的 `allWithoutFiles` 只删记录。
- **断点落在 DSH 的存储里**，不是自己往用户目录丢锁文件 —— 所以不看 TMPDIR 或 cwd 的脸色。
- **aria2 不可用时自动降级**到 Node 单流，功能不减，速度降。

---

## 文档

- [SPEC.md](SPEC.md) —— 565 行设计说明，含四个同类插件的对比、从 PCL2 借了什么、v1 的取舍
- [CONTRIBUTING.md](CONTRIBUTING.md) —— 代码布局、怎么跑测试、哪些地方别乱动
- [SECURITY.md](SECURITY.md) —— 漏洞怎么报，什么算漏洞什么不算

## 路线

```
v1    队列 + 持久化 + 七个工具 + aria2 传输      ← 已发布
v1.1  磁盘余量 / 静默失败 / 会话公平 / 镜像表
v2    拦截钩子 / 种子 / 自研分段 / 内容寻址
v3    用户面板 + 操作回传
```

## 许可

MIT
