import assert from 'node:assert/strict'
import test from 'node:test'

import { Queue } from '../lib/queue.js'
import { Transport, aria2InstallHint } from '../lib/transport.js'

/**
 * SPEC §11.4 —— aria2 缺失要【说出来】（0.4.1）。
 *
 * 背景：DLS 没有 aria2 时会静默降级到单流，功能完全正常，只是慢一个数量级。
 * 结果就是新装的人以为"DLS 就这速度"，然后卸载。这组用例守三件事：
 *
 *   ① 提示是分平台的，且指向真的能装的命令
 *   ② 缺 aria2 时 Transport 自己知道，并把 hint 挂在 modeInfo() 上
 *   ③ download_status 的 health() 带出这个状态
 *
 * 关键点：**不能 throw，也不能挡住下载** —— 降级必须继续可用。
 */

test('aria2InstallHint 按平台给不同的安装命令', () => {
  assert.match(aria2InstallHint('linux'), /apt install aria2/)
  assert.match(aria2InstallHint('win32'), /winget install aria2/)
  assert.match(aria2InstallHint('darwin'), /brew install aria2/)
  // 未知平台也不能崩，得给一条通用建议
  assert.match(aria2InstallHint('freebsd'), /aria2c/)
})

/**
 * 在"PATH 里没有 aria2"的环境里跑一段代码，跑完一定还原。
 *
 * 开发机上通常装着 aria2（DLS 自己就靠它），所以只传一个不存在的 aria2Path
 * 是不够的 —— findAria2 会顺着 PATH 找到真的那个，init() 正常启动，
 * 降级路径根本走不到。这里把 PATH 也清空，还原放在 finally 里。
 *
 * @param {() => Promise<void>} run
 */
async function withoutAria2OnPath(run) {
  const savedPath = process.env.PATH
  const savedDls = process.env.DLS_ARIA2C_PATH
  const savedMt = process.env.MT_ARIA2C_PATH
  const savedPlain = process.env.ARIA2C_PATH
  const savedLocalAppData = process.env.LOCALAPPDATA
  const savedProgramFiles = process.env.ProgramFiles
  const savedProgramFilesX86 = process.env['ProgramFiles(x86)']
  try {
    process.env.PATH = ''
    delete process.env.DLS_ARIA2C_PATH
    delete process.env.MT_ARIA2C_PATH
    delete process.env.ARIA2C_PATH
    // 这几个只影响 Windows 的"常见安装位置"兜底探测；清掉才真的找不到
    delete process.env.LOCALAPPDATA
    delete process.env.ProgramFiles
    delete process.env['ProgramFiles(x86)']
    await run()
  } finally {
    if (savedPath === undefined) delete process.env.PATH
    else process.env.PATH = savedPath
    if (savedDls !== undefined) process.env.DLS_ARIA2C_PATH = savedDls
    if (savedMt !== undefined) process.env.MT_ARIA2C_PATH = savedMt
    if (savedPlain !== undefined) process.env.ARIA2C_PATH = savedPlain
    if (savedLocalAppData !== undefined) process.env.LOCALAPPDATA = savedLocalAppData
    if (savedProgramFiles !== undefined) process.env.ProgramFiles = savedProgramFiles
    if (savedProgramFilesX86 !== undefined) process.env['ProgramFiles(x86)'] = savedProgramFilesX86
  }
}

test('找不到 aria2 时不抛错，降级到 direct 并记住原因', async () => {
  await withoutAria2OnPath(async () => {
    const logged = []
    const transport = new Transport(
      { aria2Path: '/nonexistent/aria2c-does-not-exist' },
      (level, message) => logged.push({ level, message }),
    )

    await assert.doesNotReject(() => transport.init())
    assert.equal(transport.mode, 'direct')
    assert.equal(transport.aria2Missing, true)

    // 必须是 warn：info 在大多数宿主里根本看不到
    const warn = logged.find((entry) => entry.level === 'warn')
    assert.ok(warn, '缺 aria2 必须打 warn，不是 info')
    assert.match(warn.message, /aria2c/)
    assert.match(warn.message, /apt install aria2|winget install aria2|brew install aria2/)
  })
})

test('modeInfo() 在缺 aria2 时带上 hint，正常时只报 mode', async () => {
  await withoutAria2OnPath(async () => {
    const missing = new Transport({ aria2Path: '/nonexistent/aria2c' }, () => {})
    await missing.init()
    const info = missing.modeInfo()
    assert.equal(info.mode, 'direct')
    assert.equal(info.aria2Missing, true)
    assert.match(info.hint, /aria2/)
  })

  // 没降级过的实例不该报缺失
  const fresh = new Transport({}, () => {})
  assert.deepEqual(fresh.modeInfo(), { mode: 'direct' })
})

test('download_status 的 health 里能看到 transport 状态', () => {
  const table = new Map()
  const domain = {
    table: () => ({
      entries: () => table.entries(),
      keys: () => table.keys(),
      get: (key) => table.get(key),
      put: async (key, value) => table.set(key, value),
      delete: async (key) => table.delete(key),
    }),
    global: { _v: {}, get() { return this._v }, async set(value) { this._v = value } },
  }

  const degraded = {
    transfer: async () => ({ bytes: 0, total: 0 }),
    modeInfo: () => ({ mode: 'direct', aria2Missing: true, hint: 'sudo apt install aria2' }),
  }
  const queue = new Queue({
    domain,
    transport: degraded,
    config: { maxConcurrentJobs: 1, connectionsPerJob: 16, speedCheckSeconds: 0 },
    log: () => {},
  })

  const health = queue.health()
  assert.equal(health.transport.mode, 'direct')
  assert.equal(health.transport.aria2Missing, true)
  assert.match(health.transport.hint, /aria2/)

  // 存不下东西时 storage 的错误计数仍然要报出来
  assert.equal(health.storage.errors, 0)
})

test('transport 什么都没接的旧桩不会让 health 崩', () => {
  const table = new Map()
  const domain = {
    table: () => ({
      entries: () => table.entries(),
      keys: () => table.keys(),
      get: (key) => table.get(key),
      put: async (key, value) => table.set(key, value),
      delete: async (key) => table.delete(key),
    }),
    global: { _v: {}, get() { return this._v }, async set(value) { this._v = value } },
  }
  const queue = new Queue({
    domain,
    transport: { transfer: async () => ({ bytes: 0, total: 0 }) },
    config: { maxConcurrentJobs: 1, connectionsPerJob: 16 },
    log: () => {},
  })
  assert.doesNotThrow(() => queue.health())
  assert.equal(queue.health().transport, undefined)
})
