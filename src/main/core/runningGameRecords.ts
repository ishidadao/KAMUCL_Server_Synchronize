import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { samePath } from './folderPaths'

export interface RunningGameRecord {
  pid: number
  versionId: string
  folder?: string
  effectiveGameDir: string
  logDir: string
  startedAt: string
}

const MAX_RECORD_BYTES = 128 * 1024
const MAX_RECORDS = 1024
const absent = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === 'ENOENT'
const unsafe = (): Error => new Error('运行中游戏记录损坏或存储路径不安全；为保护游戏文件，已阻止同步')

function pidValid(pid: unknown): pid is number {
  return typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0 && pid <= 0x7fffffff
}

function stringValid(value: unknown, limit: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= limit && !/[\x00-\x1f\x7f]/.test(value)
}

function directoryValid(value: unknown): value is string {
  return stringValid(value, 16384) && path.isAbsolute(value)
}

function validated(value: unknown): RunningGameRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw unsafe()
  const record = value as Partial<RunningGameRecord>
  if (!pidValid(record.pid) || !stringValid(record.versionId, 1024) ||
    !directoryValid(record.effectiveGameDir) || !directoryValid(record.logDir) ||
    !stringValid(record.startedAt, 256) || (record.folder !== undefined && !directoryValid(record.folder))) throw unsafe()
  return {
    pid: record.pid, versionId: record.versionId, effectiveGameDir: record.effectiveGameDir,
    logDir: record.logDir, startedAt: record.startedAt,
    ...(record.folder !== undefined ? { folder: record.folder } : {})
  }
}

function statOptional(filename: string): fs.Stats | undefined {
  try { return fs.lstatSync(filename) } catch (error) { if (absent(error)) return undefined; throw error }
}

/** Reject links in the storage ancestry, not just in the final record filename. */
function checkedDirectory(directory: string, create: boolean): boolean {
  const parsed = path.parse(directory)
  let current = parsed.root
  for (const part of directory.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part)
    let stat = statOptional(current)
    if (!stat) {
      if (!create) return false
      fs.mkdirSync(current, { mode: 0o700 })
      stat = fs.lstatSync(current)
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw unsafe()
  }
  return true
}

function readRecord(filename: string): { record: RunningGameRecord; raw: string } | undefined {
  const stat = statOptional(filename)
  if (!stat) return undefined
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_RECORD_BYTES) throw unsafe()
  const descriptor = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
  let raw: string
  try {
    const opened = fs.fstatSync(descriptor)
    if (!opened.isFile() || opened.size > MAX_RECORD_BYTES || opened.ino !== stat.ino) throw unsafe()
    raw = fs.readFileSync(descriptor, 'utf8')
    if (Buffer.byteLength(raw) > MAX_RECORD_BYTES) throw unsafe()
  } finally { fs.closeSync(descriptor) }
  let value: unknown
  try { value = JSON.parse(raw) } catch { throw unsafe() }
  return { record: validated(value), raw }
}

function defaultProbe(pid: number): boolean {
  try { process.kill(pid, 0); return true }
  catch (error) { return (error as NodeJS.ErrnoException)?.code !== 'ESRCH' }
}

/** Per-process, private records survive launcher exit while detached games keep running. */
export class RunningGameRecords {
  private readonly root: string
  private readonly recordsDirectory: string
  private readonly legacyFile: string

  constructor(storeDir: string, private readonly probe: (pid: number) => boolean = defaultProbe) {
    if (!directoryValid(storeDir)) throw unsafe()
    this.root = path.resolve(storeDir)
    this.recordsDirectory = path.join(this.root, 'running-games')
    this.legacyFile = path.join(this.root, 'running-game.json')
  }

  private storage(create = false): boolean {
    if (!checkedDirectory(this.root, create)) return false
    return checkedDirectory(this.recordsDirectory, create)
  }

  private recordPath(pid: number): string {
    if (!pidValid(pid)) throw unsafe()
    return path.join(this.recordsDirectory, `${pid}.json`)
  }

  private isAlive(pid: number): boolean {
    try { return this.probe(pid) !== false }
    catch (error) { return (error as NodeJS.ErrnoException)?.code !== 'ESRCH' }
  }

  write(value: RunningGameRecord): void {
    const record = validated(value)
    this.storage(true)
    const legacy = readRecord(this.legacyFile)
    const target = this.recordPath(record.pid)
    const previous = readRecord(target)
    if (previous && previous.record.pid !== record.pid) throw unsafe()
    const temporary = path.join(this.recordsDirectory, `.${record.pid}-${randomUUID()}.tmp`)
    let descriptor: number | undefined
    try {
      descriptor = fs.openSync(temporary, 'wx', 0o600)
      fs.writeFileSync(descriptor, JSON.stringify(record), 'utf8')
      fs.fsyncSync(descriptor)
      fs.closeSync(descriptor); descriptor = undefined
      // Recheck immediately before an atomic replacement.
      this.storage(false)
      readRecord(target)
      fs.renameSync(temporary, target)
      if (legacy?.record.pid === record.pid) fs.unlinkSync(this.legacyFile)
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor)
      try { fs.unlinkSync(temporary) } catch (error) { if (!absent(error)) throw error }
    }
  }

  remove(pid: number): void {
    const target = this.recordPath(pid)
    if (!checkedDirectory(this.root, false)) return
    const legacy = readRecord(this.legacyFile)
    if (this.storage(false)) {
      const existing = readRecord(target)
      if (existing) {
        if (existing.record.pid !== pid) throw unsafe()
        fs.unlinkSync(target)
      }
    }
    if (legacy?.record.pid === pid) fs.unlinkSync(this.legacyFile)
  }

  alive(): RunningGameRecord[] {
    if (!checkedDirectory(this.root, false)) return []
    const entries: Array<{ filename: string; record: RunningGameRecord; raw: string }> = []
    const legacy = readRecord(this.legacyFile)
    if (legacy) entries.push({ filename: this.legacyFile, ...legacy })
    if (this.storage(false)) {
      const filenames = fs.readdirSync(this.recordsDirectory)
      if (filenames.length > MAX_RECORDS) throw unsafe()
      for (const name of filenames) {
        const filename = path.join(this.recordsDirectory, name), stat = statOptional(filename)
        if (!stat) continue
        if (stat.isSymbolicLink() || !stat.isFile()) throw unsafe()
        if (!name.endsWith('.json')) continue // A crash can leave a private atomic-write temporary.
        if (!/^[1-9][0-9]*\.json$/.test(name)) throw unsafe()
        const entry = readRecord(filename)
        if (entry) {
          if (String(entry.record.pid) + '.json' !== name) throw unsafe()
          entries.push({ filename, ...entry })
        }
      }
    }
    if (entries.length > MAX_RECORDS) throw unsafe()
    // Validate every record before pruning anything; corruption must fail closed.
    const result = new Map<number, RunningGameRecord>()
    for (const entry of entries) {
      if (!this.isAlive(entry.record.pid)) {
        const current = readRecord(entry.filename)
        if (current?.raw === entry.raw) fs.unlinkSync(entry.filename)
        continue
      }
      const previous = result.get(entry.record.pid)
      if (previous && (!samePath(previous.effectiveGameDir, entry.record.effectiveGameDir) || previous.versionId !== entry.record.versionId)) throw unsafe()
      result.set(entry.record.pid, entry.record)
    }
    return [...result.values()]
  }

  usesDirectory(directory: string): boolean {
    if (!directoryValid(directory)) throw unsafe()
    return this.alive().some(record => samePath(record.effectiveGameDir, directory))
  }
}
