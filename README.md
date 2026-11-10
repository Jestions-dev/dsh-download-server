# dsh-dl-server

English | [中文](README.zh.md)

**DLS** — DSH Download Server
A persistent download queue for DeepSeek Harness.

> Downloads should not live inside a session.

---

## Install

### From the UI (recommended)

```
Settings → Plugins → Install a third-party plugin → Add plugin
```

Type **`dsh-dl-server@0.1.1`**, confirm, then **restart DSH once**.

### From the command line

```sh
dsh plugin add dsh-dl-server@0.1.1
```

> **Pin the version.** `0.1.0` declared `@deepseek-ai/dsh-storage-domain` as a regular dependency, so pnpm installed a second copy inside the plugin; the injected service then no longer matched the host and the plugin never mounted (every service stayed `pending`). `0.1.1` moves it to `peerDependencies`.
>
> pnpm also caches registry metadata — without an explicit version you may still resolve `0.1.0`.

> `dsh` must be on your PATH. The desktop build ships one at
> `…\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd`; if you have never added it, use the UI path.

**Requires DSH 0.2.1-rc.5 or newer.**
**aria2 is optional** — install it for 16-way segmented downloading, or skip it and the plugin falls back to a single-stream transfer. Same features, less speed.

---

## Why

Most DSH downloaders are one tool function that blocks until the file lands. They make downloads **fast**; they don't solve three things:

- the download dies when the session or the turn ends
- there is no queue, no pause, no resume
- nothing survives a restart

DLS is the **queue layer**, not the transport layer.

```
Jobs live in DSH, not in a session.
```

A download started in one session is visible to every other session — progress, destination, everything. But only the session that started it can pause, resume, or cancel it.

---

## The seven tools

| Tool | What it does |
| --- | --- |
| `download_enqueue` | Queue a job, **return immediately** with a job id |
| `download_status` | Inspect the queue or a single job (`J#1042`) |
| `download_wait` | Block until a job reaches a terminal state, with a timeout |
| `download_pause` | Pause, **keeping the bytes already on disk** |
| `download_resume` | Continue from the last checkpoint |
| `download_cancel` | Cancel, optionally dropping the partial file |
| `download_cleanup` | Drop records (the default scope leaves downloaded files alone) |

## New in 0.2.0

| | |
| --- | --- |
| **Mirror expansion** | GitHub Releases / HuggingFace / raw.githubusercontent / PyPI URLs gain a fallback mirror automatically. The original always stays first. |
| **Mirror cooldown** | Two consecutive failures on one host parks it for 10 minutes instead of retrying it on every job. |
| **Size-aware concurrency** | Under 1 MB skips aria2 entirely; 1–8 MB runs 4 connections; only 8 MB and up gets 16. |
| **Session fairness** | When two sessions queue at once they share the slots instead of one of them taking the whole queue. |
| **Cumulative disk budget** | Enqueue counts what already-queued jobs still need, so a batch cannot quietly fill the disk. |
| **Failures are no longer silent** | Checkpoint write errors are counted and surfaced in `download_status` under `storage`; an unwritable destination is refused before the transfer starts. |

## Example

```
You:   download these two PDFs into D:\Papers and tell me when they're done
```

The agent calls `download_enqueue` twice and gets `J#10` / `J#11` back, then `download_wait`.

Because enqueue returns immediately, it can fire off ten downloads without waiting for any of them.

---

## Measured

Same machine, same file:

| Setup | Throughput |
| --- | --- |
| TUNA mirror · single connection | 43.98 MB/s |
| TUNA mirror · 16 threads (another plugin) | 54.20 MB/s |
| TUNA mirror · **DLS** | **61.08 MB/s** (saturates a 500 Mbps link) |
| HuggingFace · single-stream fallback | 1.00 MB/s |
| HuggingFace · **DLS** | **6.96 MB/s** (7×) |

The last row is the point: **on a per-connection-throttled host, segmentation beats bandwidth.**

---

## Behaviour worth knowing

- **Ownership is per session.** Any session on the machine can *see* every job; only the owner can mutate one.
- **`cleanup(scope="all")` deletes files.** The default `allWithoutFiles` only drops records.
- **Checkpoints live in DSH storage**, not as lock files dropped into your home directory — the plugin does not depend on `TMPDIR` or the working directory.
- **When aria2 is unavailable** the transport degrades to a single Node stream. No features lost, some speed lost.

---

## Docs

- [SPEC.md](SPEC.md) — the 565-line design doc: comparison with four sibling plugins, what was borrowed from PCL2, and the v1 trade-offs
- [CONTRIBUTING.md](CONTRIBUTING.md) — layout, how to run the tests, what not to touch
- [SECURITY.md](SECURITY.md) — how to report a vulnerability, and what counts as one

## Roadmap

```
v1    queue + persistence + seven tools + aria2 transport   ← released
v1.1  disk headroom / silent failures / session fairness / mirrors
v2    shell interception / torrents / own segmented engine / content addressing
v3    user panel + callbacks into the agent
```

## License

MIT
