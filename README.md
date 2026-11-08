# dsh-dl-server

English | [中文](README.zh.md)

**DLS** — DSH Download Server
A global download service for DeepSeek Harness: visible across sessions, owned per session, persistent queue, pausable and resumable.

> DLS is all you need

---

## Why

Every existing DSH downloader is one tool function that blocks until the file lands. They make downloads **fast**; they don't solve three things:

- the download dies when the session or the turn ends
- there is no queue, no pause, no resume
- nothing survives a restart

DLS is the **queue layer**, not the transport layer.

## Status

`v0.1` — scaffold. Design: [SPEC.md](SPEC.md).

| Module | State |
| --- | --- |
| Data model | done |
| Persistent domain | done |
| Transport (aria2 JSON-RPC + single-stream fallback) | done |
| Queue engine (scheduling, ownership, pause reasons, checkpoints, recovery) | done |
| Seven tools | done |
| Real DSH install / verification | done (DSH 0.2.1-rc.5) |
| Hermetic tests (`npm test`) | done |
| User panel (v3) | later |

## Tools (planned)

```
download_enqueue    download_status     download_wait
download_pause      download_resume     download_cancel
download_cleanup
```

## License

MIT
