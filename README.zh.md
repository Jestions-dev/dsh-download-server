# dsh-dl-server

[English](README.md) | 中文

**DLS** — DSH Download Server
大肥鱼自己的下载服务器插件

> DLS is all you need

---

## 为什么

现成的 DSH 下载插件都是「一个工具函数 + 阻塞等到下完」。它们让下载**变快**，但没解决三件事：

- 会话或回合结束，下载就断了
- 不能排队、不能暂停恢复
- 进程重启，什么都没了

DLS 做的是**队列层**，不是传输层。

## 状态

`v0.1` 脚手架阶段。完整设计见 [SPEC.md](SPEC.md)。

| 模块 | 状态 |
| --- | --- |
| 数据模型 | ✅ |
| 持久化 domain | ✅ |
| `download_status` | 最小实现 |
| 队列引擎 | 待做 |
| 传输层（aria2 / Node 兜底） | 待做 |
| 其余六个工具 | 待做 |

## 工具（规划）

```
download_enqueue    download_status     download_wait
download_pause      download_resume     download_cancel
download_cleanup
```

## 许可

MIT
