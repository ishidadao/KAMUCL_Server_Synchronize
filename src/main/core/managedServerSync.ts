import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { isManagedPackId, normalizeManagedPath, validateManagedManifest, type ManagedFetch, type ManagedProgress, type SignedManagedManifest } from './managedServerProtocol'

export interface ManagedSyncResult { added: number; updated: number; removed: number; unchanged: number; backupDirectory?: string }
interface ManagedState { schema: 1; packId: string; contentRevision?: string; files: string[] }
interface Change { path: string; existed: boolean; beforeHash?: string }
interface Transaction { schema: 1; id: string; packId?: string; status: 'applying' | 'committed'; changes: Change[]; previousState: string | null }
const metadataName = '.kamucl-managed-server'
const transactionIds = /^[0-9]{13}-[0-9a-f]{12}$/
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT'

async function statOptional(filename: string) {
  try { return await fs.lstat(filename) } catch (error) { if (missing(error)) return undefined; throw error }
}
/** Lexical containment alone is not sufficient: every existing parent must be a real directory. */
async function safeTarget(root: string, relative: string): Promise<string> {
  if (!relative || path.isAbsolute(relative) || relative.split('/').some(part => !part || part === '.' || part === '..' || part.includes('\\'))) throw new Error('不安全的同步路径')
  const parts = relative.split('/'); let current = root
  for (let index = 0; index < parts.length; index++) {
    const parent = await statOptional(current)
    if (parent && (parent.isSymbolicLink() || !parent.isDirectory())) throw new Error(`同步路径包含符号链接或非目录：${relative}`)
    if (parent) {
      const matches = (await fs.readdir(current)).filter(name => name.toLowerCase() === parts[index].toLowerCase())
      if (matches.length > 1 || (matches.length === 1 && matches[0] !== parts[index])) throw new Error(`同步路径存在大小写冲突：${relative}`)
    }
    current = path.join(current, parts[index])
    const entry = await statOptional(current)
    if (entry?.isSymbolicLink()) throw new Error(`同步路径包含符号链接：${relative}`)
    if (entry && index < parts.length - 1 && !entry.isDirectory()) throw new Error(`同步路径的父级不是目录：${relative}`)
  }
  return current
}
async function directory(root: string, relative: string): Promise<string> {
  const filename = await safeTarget(root, relative)
  await fs.mkdir(filename, { recursive: true })
  await safeTarget(root, relative)
  return filename
}
async function hashFile(filename: string): Promise<{ hash: string; size: number }> {
  const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const before = await handle.stat()
    if (!before.isFile()) throw new Error('受管路径不是普通文件')
    const hash = createHash('sha256'), buffer = Buffer.alloc(1024 * 1024); let size = 0
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
      if (!bytesRead) break
      hash.update(buffer.subarray(0, bytesRead)); size += bytesRead
    }
    const after = await handle.stat()
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) throw new Error('受管文件在校验期间发生变化，请先关闭游戏后重试')
    return { hash: hash.digest('hex'), size }
  } finally { await handle.close() }
}
async function syncDirectory(filename: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined
  try { handle = await fs.open(filename, 'r'); await handle.sync() } catch (error) {
    // Windows and some filesystems do not permit fsync on directory handles.
    const code = (error as NodeJS.ErrnoException).code ?? ''
    if (!['EINVAL', 'ENOTSUP', 'EPERM', 'EISDIR'].includes(code) && !(process.platform === 'win32' && code === 'EACCES')) throw error
  } finally { await handle?.close() }
}
async function writeAtomic(root: string, relative: string, bytes: Buffer): Promise<void> {
  const target = await safeTarget(root, relative)
  const parentRelative = relative.slice(0, relative.lastIndexOf('/'))
  if (parentRelative) await directory(root, parentRelative)
  const temporaryRelative = relative + `.new-${randomBytes(8).toString('hex')}`
  const temporary = await safeTarget(root, temporaryRelative)
  const handle = await fs.open(temporary, 'wx', 0o600)
  try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
  try { await safeTarget(root, relative); await fs.rename(temporary, target); await syncDirectory(path.dirname(target)) } finally { await fs.unlink(temporary).catch(error => { if (!missing(error)) throw error }) }
}
async function copyAtomic(root: string, relative: string, source: string): Promise<void> {
  const target = await safeTarget(root, relative)
  const parentRelative = relative.slice(0, relative.lastIndexOf('/'))
  if (parentRelative) await directory(root, parentRelative)
  const temporaryRelative = relative + `.new-${randomBytes(8).toString('hex')}`, temporary = await safeTarget(root, temporaryRelative)
  try {
    await fs.copyFile(source, temporary, constants.COPYFILE_EXCL)
    const handle = await fs.open(temporary, 'r+'); try { await handle.sync() } finally { await handle.close() }
    await safeTarget(root, relative); await fs.rename(temporary, target); await syncDirectory(path.dirname(target))
  } finally { await fs.unlink(temporary).catch(error => { if (!missing(error)) throw error }) }
}
async function readText(root: string, relative: string): Promise<string | null> {
  const filename = await safeTarget(root, relative), entry = await statOptional(filename)
  if (!entry) return null
  if (!entry.isFile() || entry.size > 16 * 1024 * 1024) throw new Error('同步状态文件无效或过大')
  return fs.readFile(filename, 'utf8')
}
function parseState(raw: string | null): ManagedState | undefined {
  if (raw === null) return undefined
  let value: ManagedState
  try { value = JSON.parse(raw) } catch { throw new Error('同步状态损坏，请保留实例并联系管理员') }
  if (!value || value.schema !== 1 || !isManagedPackId(value.packId) || !Array.isArray(value.files) || value.files.length > 20000) throw new Error('同步状态身份或格式不正确')
  const seen = new Set<string>()
  for (const relative of value.files) {
    normalizeManagedPath(relative)
    if (seen.has(relative.toLowerCase())) throw new Error('同步状态包含重复路径')
    seen.add(relative.toLowerCase())
  }
  return value
}
async function removeFile(root: string, relative: string): Promise<void> {
  const filename = await safeTarget(root, relative), entry = await statOptional(filename)
  if (!entry) return
  if (!entry.isFile()) throw new Error(`拒绝移除非普通文件：${relative}`)
  await fs.unlink(filename)
}
function parseTransaction(raw: string): Transaction {
  let value: Transaction
  try { value = JSON.parse(raw) } catch { throw new Error('同步事务日志损坏，已阻止启动') }
  if (!value || value.schema !== 1 || !transactionIds.test(value.id) || !['applying', 'committed'].includes(value.status) || !Array.isArray(value.changes) || value.changes.length > 40000 || (typeof value.previousState !== 'string' && value.previousState !== null)) throw new Error('同步事务日志不安全，已阻止启动')
  if (value.packId !== undefined && !isManagedPackId(value.packId)) throw new Error('同步事务整合包身份不正确')
  parseState(value.previousState)
  const seen = new Set<string>()
  for (const change of value.changes) {
    normalizeManagedPath(change.path)
    if (seen.has(change.path.toLowerCase()) || typeof change.existed !== 'boolean' || (change.existed && !/^[0-9a-f]{64}$/.test(change.beforeHash ?? ''))) throw new Error('同步事务恢复路径不安全')
    seen.add(change.path.toLowerCase())
  }
  return value
}
async function rollback(root: string, transaction: Transaction, beforeApply?: () => void | Promise<void>): Promise<void> {
  // Validate every recovery image before touching any destination.
  for (const change of transaction.changes) {
    await safeTarget(root, change.path)
    if (change.existed) {
      const backup = await safeTarget(root, `${metadataName}/backups/${transaction.id}/${change.path}`)
      if ((await hashFile(backup)).hash !== change.beforeHash) throw new Error('恢复备份损坏，保留事务并阻止启动')
    }
  }
  // An external edit after interruption must remain recoverable, not disappear during rollback.
  for (const change of transaction.changes) {
    const current = await safeTarget(root, change.path), entry = await statOptional(current)
    if (entry && !entry.isFile()) throw new Error('恢复目标被目录占用，保留事务并阻止启动')
    if (entry && (await hashFile(current)).hash !== change.beforeHash) await copyAtomic(root, `${metadataName}/backups/${transaction.id}/interrupted-current/${change.path}`, current)
  }
  await beforeApply?.()
  for (const change of transaction.changes) {
    await beforeApply?.()
    if (change.existed) await copyAtomic(root, change.path, await safeTarget(root, `${metadataName}/backups/${transaction.id}/${change.path}`))
    else await removeFile(root, change.path)
  }
  if (transaction.previousState === null) await removeFile(root, `${metadataName}/state.json`)
  else await writeAtomic(root, `${metadataName}/state.json`, Buffer.from(transaction.previousState))
}
async function recover(root: string, packId: string, onProgress?: (progress: ManagedProgress) => void, beforeApply?: () => void | Promise<void>): Promise<void> {
  const raw = await readText(root, `${metadataName}/transaction.json`)
  if (raw === null) return
  const transaction = parseTransaction(raw)
  // Journals predating generic packs were generated only for the-fool.
  const owner = transaction.packId ?? parseState(transaction.previousState)?.packId ?? 'the-fool'
  if (owner !== packId) throw new Error('未完成事务属于另一个整合包，不能接管它的文件')
  if (transaction.status === 'applying') {
    onProgress?.({ stage: 'recovering', text: '恢复上次中断的服务器同步' })
    await rollback(root, transaction, beforeApply)
  }
  await removeFile(root, `${metadataName}/transaction.json`)
}
async function acquireLock(root: string): Promise<() => Promise<void>> {
  const relative = `${metadataName}/lock.json`, filename = await safeTarget(root, relative), token = randomBytes(16).toString('hex')
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await fs.open(filename, 'wx', 0o600)
      try { await handle.writeFile(JSON.stringify({ pid: process.pid, token })); await handle.sync() } finally { await handle.close() }
      return async () => {
        const contents = await readText(root, relative)
        if (contents && JSON.parse(contents).token === token) await removeFile(root, relative)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const raw = await readText(root, relative)
      let owner: { pid?: number }
      try { owner = JSON.parse(raw ?? '') } catch { throw new Error('同步锁损坏，请确认没有启动器同步任务后由管理员处理') }
      if (!Number.isInteger(owner.pid) || (owner.pid ?? 0) < 1) throw new Error('同步锁格式不安全')
      try { process.kill(owner.pid!, 0); throw new Error('此实例正在同步，不能同时执行第二个任务') } catch (probe) {
        if ((probe as NodeJS.ErrnoException).code !== 'ESRCH') throw probe
      }
      await removeFile(root, relative)
    }
  }
  throw new Error('无法获取同步锁')
}
async function verifyActiveModInventory(root: string, manifest: SignedManagedManifest): Promise<void> {
  const expected = new Set(manifest.files.filter(file => file.path.split('/').length === 2 && file.path.startsWith('mods/') && file.path.toLowerCase().endsWith('.jar')).map(file => file.path.toLowerCase()))
  const mods = await safeTarget(root, 'mods'), stat = await statOptional(mods)
  if (!stat) { if (expected.size) throw new Error('受管活动 Mod 目录在同步过程中消失'); return }
  if (!stat.isDirectory()) throw new Error('活动 Mod 目录不是普通目录')
  const actual = new Set<string>()
  for (const entry of await fs.readdir(mods, { withFileTypes: true })) {
    if (!entry.name.toLowerCase().endsWith('.jar')) continue
    const relative = normalizeManagedPath(`mods/${entry.name}`), key = relative.toLowerCase()
    await safeTarget(root, relative)
    if (!entry.isFile() || entry.isSymbolicLink() || actual.has(key)) throw new Error(`活动 Mod 清单包含不安全路径：${relative}`)
    if (!expected.has(key)) throw new Error(`同步过程中新增了清单外活动 Mod，已阻止启动：${relative}`)
    actual.add(key)
  }
  if (actual.size !== expected.size) throw new Error('受管活动 Mod 清单在同步过程中发生变化，已阻止启动')
}
export async function syncManagedFiles(gameDirectory: string, manifest: SignedManagedManifest, fetchBytes: ManagedFetch, signal?: AbortSignal, onProgress?: (progress: ManagedProgress) => void, beforeApply?: () => void | Promise<void>): Promise<ManagedSyncResult> {
  signal?.throwIfAborted()
  const root = path.resolve(gameDirectory), rootStat = await fs.lstat(root)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('受管实例目录必须为真实、独立的目录')
  // Callers must provision a dedicated instance and ensure its game process has exited.
  const manifestBase = manifest.files[0]?.url ?? 'https://managed.invalid/manifest.json'
  const valid = validateManagedManifest(manifest, manifestBase)
  await directory(root, metadataName)
  const release = await acquireLock(root)
  let stageRelative: string | undefined
  try {
    await beforeApply?.()
    const stored = parseState(await readText(root, `${metadataName}/state.json`))
    if (stored && stored.packId !== valid.packId) throw new Error('此实例已受另一个整合包管理，不能接管或移除它的文件')
    await recover(root, valid.packId, onProgress, beforeApply)
    const stateRelative = `${metadataName}/state.json`, previousRaw = await readText(root, stateRelative), previous = parseState(previousRaw)
    if (previous && previous.packId !== valid.packId) throw new Error('此实例已受另一个整合包管理，不能接管或移除它的文件')
    const result: ManagedSyncResult = { added: 0, updated: 0, removed: 0, unchanged: 0 }
    const pending: typeof valid.files = [], expected = new Map(valid.files.map(file => [file.path.toLowerCase(), file.path]))
    const obsolete = new Set<string>()
    let completed = 0
    for (const file of valid.files) {
      signal?.throwIfAborted()
      const filename = await safeTarget(root, file.path), entry = await statOptional(filename)
      if (entry && !entry.isFile()) throw new Error(`受管文件路径被目录占用：${file.path}`)
      // Always hash bytes, even if revision, name, mtime and size match.
      const local = entry ? await hashFile(filename) : undefined
      if (local?.size === file.size && local.hash === file.sha256) result.unchanged++
      else { pending.push(file); if (entry) result.updated++; else result.added++ }
      onProgress?.({ stage: 'checking', text: `SHA-256 校验：${file.path}`, completed: ++completed, total: valid.files.length })
    }
    for (const removal of valid.removeFiles) {
      signal?.throwIfAborted()
      const filename = await safeTarget(root, removal.path), entry = await statOptional(filename)
      if (!entry) continue
      if (!entry.isFile() || (await hashFile(filename)).hash !== removal.sha256) throw new Error(`待迁移文件已被修改，未删除并阻止启动：${removal.path}`)
      obsolete.add(removal.path)
    }
    for (const relative of previous?.files ?? []) if (!expected.has(relative.toLowerCase())) obsolete.add(relative)
    const modsRoot = await safeTarget(root, 'mods'), modsStat = await statOptional(modsRoot)
    if (modsStat) {
      if (!modsStat.isDirectory()) throw new Error('mods 不是目录')
      for (const item of await fs.readdir(modsRoot, { withFileTypes: true })) {
        if (!item.name.toLowerCase().endsWith('.jar')) continue
        const relative = normalizeManagedPath(`mods/${item.name}`)
        if (item.isSymbolicLink() || !item.isFile()) throw new Error(`活动 Mod 不是普通文件：${relative}`)
        if (!expected.has(relative.toLowerCase())) obsolete.add(relative)
      }
    }
    const existingObsolete: string[] = []
    for (const relative of obsolete) {
      const filename = await safeTarget(root, relative), entry = await statOptional(filename)
      if (!entry) continue
      if (!entry.isFile()) throw new Error(`拒绝移除非普通文件：${relative}`)
      existingObsolete.push(relative)
    }
    result.removed = existingObsolete.length
    const id = `${Date.now()}-${randomBytes(6).toString('hex')}`
    let backupBytes = 0
    for (const relative of [...pending.map(file => file.path), ...existingObsolete]) {
      const entry = await statOptional(await safeTarget(root, relative))
      if (entry?.isFile()) backupBytes += entry.size
    }
    if (pending.length || existingObsolete.length) {
      // Downloads remain staged while atomic destination copies are created.
      const space = await fs.statfs(root), requiredBytes = 2 * pending.reduce((sum, file) => sum + file.size, 0) + backupBytes + 32 * 1024 * 1024
      if (space.bavail * space.bsize < requiredBytes) throw new Error('磁盘空间不足，无法同时保存下载暂存和恢复备份；未修改游戏文件')
    }
    stageRelative = `${metadataName}/stage/${id}`
    await directory(root, stageRelative)
    const downloads = new Map<string, string>(), totalBytes = pending.reduce((sum, file) => sum + file.size, 0)
    let downloaded = 0
    for (let index = 0; index < pending.length; index++) {
      signal?.throwIfAborted()
      const file = pending[index]
      onProgress?.({ stage: 'downloading', text: `下载：${file.path}`, completed: index, total: pending.length, bytes: downloaded, totalBytes })
      let currentBytes = 0
      const bytes = await fetchBytes(file.url, { signal, maxBytes: file.size, onProgress: reportedBytes => {
        if (!Number.isFinite(reportedBytes)) return
        const next = Math.max(currentBytes, Math.min(file.size, Math.max(0, Math.floor(reportedBytes))))
        if (next === currentBytes) return
        currentBytes = next
        onProgress?.({ stage: 'downloading', text: `下载：${file.path}`, completed: index, total: pending.length, bytes: downloaded + currentBytes, totalBytes, progress: totalBytes ? (downloaded + currentBytes) / totalBytes : 1 })
      } })
      signal?.throwIfAborted()
      if (!Buffer.isBuffer(bytes) || bytes.length !== file.size || sha256(bytes) !== file.sha256) throw new Error(`下载文件 SHA-256 或大小校验失败：${file.path}`)
      const relative = `${stageRelative}/${index}.download`
      await writeAtomic(root, relative, bytes)
      downloads.set(file.path, relative); downloaded += bytes.length
      onProgress?.({ stage: 'downloading', text: `下载完成：${file.path}`, completed: index + 1, total: pending.length, bytes: downloaded, totalBytes, progress: totalBytes ? downloaded / totalBytes : 1 })
    }
    const affected = [...new Set([...pending.map(file => file.path), ...existingObsolete])]
    if (!affected.length) {
      await beforeApply?.()
      for (const file of valid.files) {
        signal?.throwIfAborted()
        const current = await hashFile(await safeTarget(root, file.path))
        if (current.size !== file.size || current.hash !== file.sha256) throw new Error(`最终校验期间文件发生变化：${file.path}`)
      }
      await verifyActiveModInventory(root, valid)
      const state: ManagedState = { schema: 1, packId: valid.packId, contentRevision: valid.contentRevision, files: valid.files.map(file => file.path) }
      await beforeApply?.()
      await writeAtomic(root, stateRelative, Buffer.from(JSON.stringify(state)))
      onProgress?.({ stage: 'complete', text: '全部受管文件 SHA-256 校验通过', completed: valid.files.length, total: valid.files.length })
      return result
    }
    const backupRelative = `${metadataName}/backups/${id}`, changes: Change[] = []
    await directory(root, backupRelative)
    for (const relative of affected) {
      signal?.throwIfAborted()
      const filename = await safeTarget(root, relative), entry = await statOptional(filename), change: Change = { path: relative, existed: !!entry }
      if (entry) {
        if (!entry.isFile()) throw new Error(`受管文件在同步期间发生变化：${relative}`)
        change.beforeHash = (await hashFile(filename)).hash
        const backup = `${backupRelative}/${relative}`
        await copyAtomic(root, backup, filename)
        if ((await hashFile(await safeTarget(root, backup))).hash !== change.beforeHash) throw new Error('受管文件在创建备份期间发生变化')
      }
      changes.push(change)
    }
    const transaction: Transaction = { schema: 1, id, packId: valid.packId, status: 'applying', changes, previousState: previousRaw }
    const journalRelative = `${metadataName}/transaction.json`
    await beforeApply?.()
    await writeAtomic(root, journalRelative, Buffer.from(JSON.stringify(transaction)))
    try {
      let applied = 0
      for (const file of pending) {
        signal?.throwIfAborted()
        const change = changes.find(item => item.path === file.path)!
        const current = await statOptional(await safeTarget(root, file.path))
        if (!!current !== change.existed || (current && (await hashFile(await safeTarget(root, file.path))).hash !== change.beforeHash)) throw new Error('文件在备份后被其他进程修改，取消同步')
        await beforeApply?.()
        await copyAtomic(root, file.path, await safeTarget(root, downloads.get(file.path)!))
        onProgress?.({ stage: 'applying', text: `应用：${file.path}`, completed: ++applied, total: affected.length })
      }
      for (const relative of existingObsolete) {
        signal?.throwIfAborted()
        const change = changes.find(item => item.path === relative)!
        if ((await hashFile(await safeTarget(root, relative))).hash !== change.beforeHash) throw new Error('待移除文件在备份后发生变化，取消同步')
        await beforeApply?.()
        await removeFile(root, relative)
        onProgress?.({ stage: 'applying', text: `备份并隔离：${relative}`, completed: ++applied, total: affected.length })
      }
      for (const file of valid.files) {
        signal?.throwIfAborted()
        const current = await hashFile(await safeTarget(root, file.path))
        if (current.size !== file.size || current.hash !== file.sha256) throw new Error(`应用后校验失败：${file.path}`)
      }
      await verifyActiveModInventory(root, valid)
      const state: ManagedState = { schema: 1, packId: valid.packId, contentRevision: valid.contentRevision, files: valid.files.map(file => file.path) }
      await beforeApply?.()
      await writeAtomic(root, stateRelative, Buffer.from(JSON.stringify(state)))
      transaction.status = 'committed'
      await writeAtomic(root, journalRelative, Buffer.from(JSON.stringify(transaction)))
    } catch (error) {
      try { await beforeApply?.() } catch (guardError) {
        throw new Error(`游戏正在使用目录，已保留事务，退出游戏后重试恢复。原始错误：${String(error)}；保护检查：${String(guardError)}`, { cause: error })
      }
      try { await rollback(root, transaction, beforeApply); await removeFile(root, journalRelative) } catch (recoveryError) {
        try { await beforeApply?.() } catch (guardError) {
          throw new Error(`游戏正在使用目录，已保留事务，退出游戏后重试恢复。原始错误：${String(error)}；保护检查：${String(guardError)}`, { cause: error })
        }
        throw new Error(`同步失败且自动恢复未完成，保留备份和事务日志，已阻止启动：${String(error)}；${String(recoveryError)}`, { cause: error })
      }
      throw error
    }
    await removeFile(root, journalRelative)
    result.backupDirectory = path.join(root, backupRelative)
    onProgress?.({ stage: 'complete', text: '服务器文件同步完成并通过 SHA-256 校验', completed: affected.length, total: affected.length })
    return result
  } finally {
    try {
      if (stageRelative) {
        const staged = await safeTarget(root, stageRelative)
        await fs.rm(staged, { recursive: true, force: true })
      }
    } finally { await release() }
  }
}
