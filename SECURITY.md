# Security Policy / 安全策略

## Supported versions / 支持的版本

Only the latest released version receives fixes.

只有最新的发布版本会收到修复。

| Version | Supported |
| ------- | --------- |
| 0.1.x   | ✅        |

## Reporting a vulnerability / 报告漏洞

**请勿用公开 Issue 报告安全问题。**

Use GitHub's private reporting flow:

用 GitHub 的私密报告通道：

1. 打开 <https://github.com/Jestions-dev/dsh-download-server/security/advisories/new>
2. 或在该仓库的 **Security → Report a vulnerability** 里填写

Please include / 请附上：

- 受影响的版本（`npm view dsh-dl-server version`）
- DSH 版本（桌面版 `About`，或 `dsh --version`）
- 复现步骤，以及你能提供的最小样例
- 你认为的影响范围

**I reply within 7 days.** 七天内会给首次回复。

## Scope / 在范围内的

DLS 会按用户给的 URL 和路径去读写磁盘，所以这些是真正的安全问题：

| 类别 | 例子 |
| --- | --- |
| 路径穿越 | 构造 `dest` 让文件写到预期目录之外 |
| 任意文件覆盖 | 借 `cleanup(scope="all")` 删掉队列之外的路径 |
| 越权操作 | 非 owner 会话成功 pause / resume / cancel / cleanup |
| 凭据泄漏 | aria2 RPC secret、B站凭证等被写进日志或返回值 |
| 命令注入 | URL 或路径里的内容被拼进 shell |

## Out of scope / 不在范围内的

- **下载内容本身的风险** —— DLS 只负责把字节搬到指定路径，不对来源做审计。下到什么由使用者负责。
- **aria2c 自身的漏洞** —— 请报给 [aria2](https://github.com/aria2/aria2)。DLS 只是调用它。
- **把 `dest` 指向系统目录导致的自伤** —— 这是权限模型的正常表现（当前会话能写的地方它就能写），不是漏洞。
- **磁盘写满、断电、掉网** —— 这些是可用性问题，走普通 Issue。

## Known design decisions / 已知的设计取舍

这些不是漏洞，改动之前请先开 Issue 讨论：

- **作业归属按会话 UUID**。同一台机器上的任何会话都能**看见**全部作业（这是特性），但只有 owner 能改。
- **`cleanup(scope="all")` 会删文件**。默认 `allWithoutFiles` 只删记录，不碰已下载的文件。
- **aria2 RPC 只监听 `127.0.0.1`**，且每次启动随机生成 secret。
