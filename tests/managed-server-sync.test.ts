import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import syncFs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { syncManagedFiles } from '../src/main/core/managedServerSync'
import type { SignedManagedManifest, ManagedFetch } from '../src/main/core/managedServerProtocol'

const hash = (data: string | Buffer) => createHash('sha256').update(data).digest('hex')
function manifest(entries: Record<string, string>, revision = '20261006010534'): SignedManagedManifest {
  return { schema: 1, packId: 'the-fool', packVersion: '0.3.0', contentRevision: revision, minecraft: '1.20.1', loader: { type: 'forge', version: '47.4.12' }, serverAddress: 'example.invalid:25565', files: Object.entries(entries).map(([relative, data]) => ({ path: relative, size: Buffer.byteLength(data), sha256: hash(data), url: `https://example.invalid:4443/objects/${hash(data)}` })), removeFiles: [] }
}
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kamucl-managed-sync-'))
  const write = async (relative: string, data: string) => { await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true }); await fs.writeFile(path.join(root, relative), data) }
  const read = (relative: string) => fs.readFile(path.join(root, relative), 'utf8')
  const close = () => fs.rm(root, { recursive: true, force: true })
  return { root, write, read, close }
}
function fetcher(entries: Record<string, string>, calls: string[] = []): ManagedFetch {
  const bytes = new Map(Object.values(entries).map(data => [hash(data), Buffer.from(data)]))
  return async (url, { signal, maxBytes }) => { signal?.throwIfAborted(); calls.push(url); const result = bytes.get(url.split('/').at(-1)!); assert(result); assert(result.length <= maxBytes); return result }
}

test('managed sync: same-name same-size patched JAR and unchanged-revision corruption both get repaired', async () => {
  const t = await fixture(), entries = { 'mods/a.jar': 'NEW!' }, calls: string[] = []
  try {
    await t.write('mods/a.jar', 'OLD!')
    const first = await syncManagedFiles(t.root, manifest(entries), fetcher(entries, calls))
    assert.equal(first.updated, 1); assert.equal(await t.read('mods/a.jar'), 'NEW!')
    assert.equal(await fs.readFile(path.join(first.backupDirectory!, 'mods/a.jar'), 'utf8'), 'OLD!')
    await t.write('mods/a.jar', 'BAD!')
    const second = await syncManagedFiles(t.root, manifest(entries), fetcher(entries, calls))
    assert.equal(second.updated, 1); assert.equal(await t.read('mods/a.jar'), 'NEW!'); assert.equal(calls.length, 2)
    const third = await syncManagedFiles(t.root, manifest(entries), fetcher(entries, calls))
    assert.equal(third.unchanged, 1); assert.equal(third.updated, 0); assert.equal(calls.length, 2)
  } finally { await t.close() }
})

test('managed sync: preserve worlds/options/disabled JARs/personal config, backup extras and prior-managed obsolete files', async () => {
  const t = await fixture(), firstEntries = { 'mods/a.jar': 'a', 'config/shared.json': 'shared' }
  try {
    await t.write('options.txt', 'personal'); await t.write('saves/world/level.dat', 'world'); await t.write('mods/disabled.jar.disabled', 'disabled'); await t.write('config/personal.json', 'personal')
    await syncManagedFiles(t.root, manifest(firstEntries), fetcher(firstEntries))
    await t.write('mods/extra.jar', 'extra')
    const entries = { 'mods/a.jar': 'a' }, result = await syncManagedFiles(t.root, manifest(entries), fetcher(entries))
    assert.equal(result.removed, 2); assert.equal(await fs.readFile(path.join(result.backupDirectory!, 'mods/extra.jar'), 'utf8'), 'extra')
    await assert.rejects(t.read('config/shared.json')); await assert.rejects(t.read('mods/extra.jar'))
    assert.equal(await t.read('config/personal.json'), 'personal'); assert.equal(await t.read('mods/disabled.jar.disabled'), 'disabled'); assert.equal(await t.read('options.txt'), 'personal'); assert.equal(await t.read('saves/world/level.dat'), 'world')
  } finally { await t.close() }
})

test('managed sync: failed or hash-corrupt download never changes any active file', async () => {
  const t = await fixture(), entries = { 'mods/a.jar': 'new-a', 'mods/b.jar': 'new-b' }
  try {
    await t.write('mods/a.jar', 'old-a'); await t.write('mods/extra.jar', 'extra')
    let count = 0
    await assert.rejects(syncManagedFiles(t.root, manifest(entries), async url => { if (++count === 2) throw new Error('network failed'); return fetcher(entries)(url, { maxBytes: 5 }) }), /network failed/)
    assert.equal(await t.read('mods/a.jar'), 'old-a'); assert.equal(await t.read('mods/extra.jar'), 'extra'); await assert.rejects(t.read('mods/b.jar'))
    await assert.rejects(syncManagedFiles(t.root, manifest(entries), async () => Buffer.from('BAD!!')), /校验/)
    assert.equal(await t.read('mods/a.jar'), 'old-a')
  } finally { await t.close() }
})

test('managed sync: apply failure/cancellation restores old files and state while preserving recovery backups', async () => {
  const t = await fixture(), original = { 'mods/a.jar': 'old-a' }, entries = { 'mods/a.jar': 'new-a', 'mods/b.jar': 'new-b' }
  try {
    await syncManagedFiles(t.root, manifest(original), fetcher(original))
    const previousState = await t.read('.kamucl-managed-server/state.json')
    await assert.rejects(syncManagedFiles(t.root, manifest(entries), fetcher(entries), undefined, progress => { if (progress.stage === 'applying') throw new Error('simulate apply failure') }), /simulate apply failure/)
    assert.equal(await t.read('mods/a.jar'), 'old-a'); await assert.rejects(t.read('mods/b.jar')); assert.equal(await t.read('.kamucl-managed-server/state.json'), previousState)
    const controller = new AbortController()
    await assert.rejects(syncManagedFiles(t.root, manifest(entries), fetcher(entries), controller.signal, progress => { if (progress.stage === 'applying') controller.abort() }))
    assert.equal(await t.read('mods/a.jar'), 'old-a'); await assert.rejects(t.read('mods/b.jar')); await assert.rejects(t.read('.kamucl-managed-server/transaction.json'))
  } finally { await t.close() }
})

test('managed sync: explicitly removed migration JAR requires exact old SHA-256 and conflicting paths fail closed', async () => {
  const t = await fixture()
  try {
    await t.write('mods/legacy.jar', 'modified')
    const document = manifest({}); document.removeFiles = [{ path: 'mods/legacy.jar', sha256: hash('original') }]
    await assert.rejects(syncManagedFiles(t.root, document, async () => Buffer.alloc(0)), /已被修改/)
    assert.equal(await t.read('mods/legacy.jar'), 'modified')
    document.removeFiles[0].sha256 = hash('modified')
    const result = await syncManagedFiles(t.root, document, async () => Buffer.alloc(0))
    assert.equal(result.removed, 1); assert.equal(await fs.readFile(path.join(result.backupDirectory!, 'mods/legacy.jar'), 'utf8'), 'modified')
    const conflict = manifest({ 'mods/same.jar': 'a' }); conflict.removeFiles = [{ path: 'mods/same.jar', sha256: hash('a') }]
    await assert.rejects(syncManagedFiles(t.root, conflict, fetcher({ 'mods/same.jar': 'a' })), /冲突/)
  } finally { await t.close() }
})

test('managed sync: symlink parents/metadata and case collisions cannot escape the instance', async () => {
  const t = await fixture(), outside = await fs.mkdtemp(path.join(os.tmpdir(), 'kamucl-managed-outside-'))
  try {
    await fs.writeFile(path.join(outside, 'a.jar'), 'outside')
    await fs.symlink(outside, path.join(t.root, 'mods'), 'dir')
    await assert.rejects(syncManagedFiles(t.root, manifest({ 'mods/a.jar': 'new' }), fetcher({ 'mods/a.jar': 'new' })), /符号链接/)
    assert.equal(await fs.readFile(path.join(outside, 'a.jar'), 'utf8'), 'outside')
    await fs.unlink(path.join(t.root, 'mods')); await t.write('mods/A.jar', 'old')
    await assert.rejects(syncManagedFiles(t.root, manifest({ 'mods/a.jar': 'new' }), fetcher({ 'mods/a.jar': 'new' })), /大小写/)
    await fs.rm(path.join(t.root, '.kamucl-managed-server'), { recursive: true, force: true })
    await fs.symlink(outside, path.join(t.root, '.kamucl-managed-server'), 'dir')
    await assert.rejects(syncManagedFiles(t.root, manifest({ 'mods/a.jar': 'new' }), fetcher({ 'mods/a.jar': 'new' })), /符号链接/)
  } finally { await t.close(); await fs.rm(outside, { recursive: true, force: true }) }
})

test('managed sync: live task lock and corrupted prior state block updates', async () => {
  const t = await fixture(), entries = { 'mods/a.jar': 'new' }
  try {
    await t.write('.kamucl-managed-server/lock.json', JSON.stringify({ pid: process.pid, token: 'other' }))
    await assert.rejects(syncManagedFiles(t.root, manifest(entries), fetcher(entries)), /正在同步/)
    await fs.unlink(path.join(t.root, '.kamucl-managed-server/lock.json'))
    await t.write('.kamucl-managed-server/state.json', '{broken')
    await assert.rejects(syncManagedFiles(t.root, manifest(entries), fetcher(entries)), /状态损坏/)
    await assert.rejects(t.read('mods/a.jar'))
  } finally { await t.close() }
})

test('managed sync: interrupted persistent transaction rolls back before fresh validation', async () => {
  const t = await fixture(), id = '1760000000000-abcdef123456'
  try {
    await t.write('mods/a.jar', 'half-updated')
    await t.write(`.kamucl-managed-server/backups/${id}/mods/a.jar`, 'original')
    await t.write('.kamucl-managed-server/transaction.json', JSON.stringify({ schema: 1, id, status: 'applying', changes: [{ path: 'mods/a.jar', existed: true, beforeHash: hash('original') }], previousState: null }))
    const entries = { 'mods/a.jar': 'original' }, result = await syncManagedFiles(t.root, manifest(entries), fetcher(entries))
    assert.equal(result.unchanged, 1); assert.equal(await t.read('mods/a.jar'), 'original'); await assert.rejects(t.read('.kamucl-managed-server/transaction.json'))
    assert.equal(await t.read(`.kamucl-managed-server/backups/${id}/interrupted-current/mods/a.jar`), 'half-updated')
  } finally { await t.close() }
})

test('managed sync: damaged crash-recovery backup fails closed and keeps active files untouched', async () => {
  const t = await fixture(), id = '1760000000000-abcdef123456'
  try {
    await t.write('mods/a.jar', 'half-updated'); await t.write(`.kamucl-managed-server/backups/${id}/mods/a.jar`, 'corrupt-backup')
    await t.write('.kamucl-managed-server/transaction.json', JSON.stringify({ schema: 1, id, status: 'applying', changes: [{ path: 'mods/a.jar', existed: true, beforeHash: hash('original') }], previousState: null }))
    await assert.rejects(syncManagedFiles(t.root, manifest({ 'mods/a.jar': 'new' }), async () => { throw new Error('must not download') }), /备份损坏/)
    assert.equal(await t.read('mods/a.jar'), 'half-updated'); assert(await t.read('.kamucl-managed-server/transaction.json'))
  } finally { await t.close() }
})

test('managed sync: one large-file download reports live 25%/50% bytes before file completion, clamped monotonically', async () => {
  const t = await fixture(), entries = { 'mods/large.jar': 'x'.repeat(400) }, events: any[] = []
  try {
    await syncManagedFiles(t.root, manifest(entries), async (_url, options) => {
      options.onProgress?.(100); options.onProgress?.(80); options.onProgress?.(200); options.onProgress?.(NaN); options.onProgress?.(800)
      return Buffer.from(entries['mods/large.jar'])
    }, undefined, event => { if (event.stage === 'downloading') events.push(event) })
    assert(events.some(event => event.completed === 0 && event.bytes === 100 && event.totalBytes === 400 && event.progress === 0.25))
    assert(events.some(event => event.completed === 0 && event.bytes === 200 && event.progress === 0.5))
    assert(events.some(event => event.completed === 1 && event.bytes === 400 && event.progress === 1))
    assert(events.every((event, index) => event.bytes <= 400 && (!index || event.bytes >= events[index - 1].bytes)))
  } finally { await t.close() }
})

test('managed sync: game becomes busy during staging, before-apply guard leaves all active files unchanged', async () => {
  const t = await fixture(), entries = { 'mods/a.jar': 'new' }; let busy = false
  try {
    await t.write('mods/a.jar', 'old'); await t.write('mods/extra.jar', 'extra')
    await assert.rejects(syncManagedFiles(t.root, manifest(entries), async url => {
      busy = true; return fetcher(entries)(url, { maxBytes: 3 })
    }, undefined, undefined, () => { if (busy) throw new Error('game became busy') }), /game became busy/)
    assert.equal(await t.read('mods/a.jar'), 'old'); assert.equal(await t.read('mods/extra.jar'), 'extra')
    await assert.rejects(t.read('.kamucl-managed-server/state.json')); await assert.rejects(t.read('.kamucl-managed-server/transaction.json'))
  } finally { await t.close() }
})

test('managed sync: transient guard failure rolls back files already applied once idle again', async () => {
  const t = await fixture(), entries = { 'mods/a.jar': 'new-a', 'mods/b.jar': 'new-b' }; let guards = 0
  try {
    await t.write('mods/a.jar', 'old-a')
    await assert.rejects(syncManagedFiles(t.root, manifest(entries), fetcher(entries), undefined, undefined, () => { if (++guards === 4) throw new Error('busy at second apply') }), /busy at second apply/)
    assert.equal(await t.read('mods/a.jar'), 'old-a'); await assert.rejects(t.read('mods/b.jar')); await assert.rejects(t.read('.kamucl-managed-server/transaction.json'))
  } finally { await t.close() }
})

test('managed sync: persistently busy JVM defers rollback without active writes, guarded idle retry recovers', async () => {
  const t = await fixture(), entries = { 'mods/a.jar': 'new-a', 'mods/b.jar': 'new-b' }; let busy = false
  try {
    await t.write('mods/a.jar', 'old-a')
    await assert.rejects(syncManagedFiles(t.root, manifest(entries), fetcher(entries), undefined, progress => { if (progress.stage === 'applying') busy = true }, () => { if (busy) throw new Error('JVM still running') }), error => {
      assert(error instanceof Error); assert.match(error.message, /游戏正在使用目录，已保留事务，退出游戏后重试恢复/)
      assert(error.cause instanceof Error); assert.match(error.cause.message, /JVM still running/); return true
    })
    // No rollback is allowed underneath the live JVM: keep the first after-image and journal.
    assert.equal(await t.read('mods/a.jar'), 'new-a'); await assert.rejects(t.read('mods/b.jar'))
    const journal = JSON.parse(await t.read('.kamucl-managed-server/transaction.json'))
    assert.equal(journal.status, 'applying'); assert.equal(await t.read(`.kamucl-managed-server/backups/${journal.id}/mods/a.jar`), 'old-a')
    await assert.rejects(syncManagedFiles(t.root, manifest({ 'mods/a.jar': 'old-a' }), fetcher({ 'mods/a.jar': 'old-a' }), undefined, undefined, () => { if (busy) throw new Error('still busy') }), /still busy/)
    assert.equal(await t.read('mods/a.jar'), 'new-a'); assert(await t.read('.kamucl-managed-server/transaction.json'))
    busy = false
    const restored = await syncManagedFiles(t.root, manifest({ 'mods/a.jar': 'old-a' }), fetcher({ 'mods/a.jar': 'old-a' }), undefined, undefined, () => { if (busy) throw new Error('still busy') })
    assert.equal(restored.unchanged, 1); assert.equal(await t.read('mods/a.jar'), 'old-a'); await assert.rejects(t.read('.kamucl-managed-server/transaction.json'))
  } finally { await t.close() }
})

test('managed sync: unexpected active JAR added during download fails final inventory and preserves manual file', async () => {
  const t = await fixture(), entries = { 'mods/a.jar': 'new-a' }
  try {
    await t.write('mods/a.jar', 'old-a')
    await assert.rejects(syncManagedFiles(t.root, manifest(entries), async (url, options) => {
      await t.write('mods/manual-during-download.jar', 'manual'); return fetcher(entries)(url, options)
    }), /同步过程中新增了清单外活动 Mod/)
    assert.equal(await t.read('mods/a.jar'), 'old-a'); assert.equal(await t.read('mods/manual-during-download.jar'), 'manual')
    await assert.rejects(t.read('.kamucl-managed-server/state.json')); await assert.rejects(t.read('.kamucl-managed-server/transaction.json'))
  } finally { await t.close() }
})

test('managed sync: unchanged-file branch also checks final active JAR inventory', async () => {
  const t = await fixture(), entries = { 'mods/a.jar': 'unchanged' }; let guards = 0
  try {
    await t.write('mods/a.jar', 'unchanged'); await t.write('mods/disabled.jar.disabled', 'disabled')
    await assert.rejects(syncManagedFiles(t.root, manifest(entries), fetcher(entries), undefined, undefined, () => {
      if (++guards === 2) syncFs.writeFileSync(path.join(t.root, 'mods/manual-after-inventory.jar'), 'manual')
    }), /同步过程中新增了清单外活动 Mod/)
    assert.equal(await t.read('mods/a.jar'), 'unchanged'); assert.equal(await t.read('mods/manual-after-inventory.jar'), 'manual'); assert.equal(await t.read('mods/disabled.jar.disabled'), 'disabled')
    await assert.rejects(t.read('.kamucl-managed-server/state.json'))
  } finally { await t.close() }
})

test('generic managed sync: exact pack identity persists and another pack cannot claim the same directory', async () => {
  const t = await fixture(), entries = { 'mods/community.jar': 'community' }
  try {
    const first = { ...manifest(entries), packId: 'community-one' }
    await syncManagedFiles(t.root, first, fetcher(entries))
    assert.equal(JSON.parse(await t.read('.kamucl-managed-server/state.json')).packId, 'community-one')
    const second = { ...manifest({ 'mods/other.jar': 'other' }), packId: 'community-two' }
    await assert.rejects(syncManagedFiles(t.root, second, async () => { throw new Error('must not fetch') }), /另一个整合包/)
    assert.equal(await t.read('mods/community.jar'), 'community'); await assert.rejects(t.read('mods/other.jar'))
    const again = await syncManagedFiles(t.root, first, fetcher(entries)); assert.equal(again.unchanged, 1)
  } finally { await t.close() }
})

test('generic managed sync: a different pack cannot recover legacy Fool or explicitly owned interrupted transactions', async () => {
  for (const owner of [undefined, 'community-one']) {
    const t = await fixture(), id = '1760000000000-abcdef123456'
    try {
      await t.write('mods/a.jar', 'half-updated'); await t.write(`.kamucl-managed-server/backups/${id}/mods/a.jar`, 'original')
      await t.write('.kamucl-managed-server/transaction.json', JSON.stringify({ schema: 1, id, packId: owner, status: 'applying', changes: [{ path: 'mods/a.jar', existed: true, beforeHash: hash('original') }], previousState: null }))
      await assert.rejects(syncManagedFiles(t.root, { ...manifest({ 'mods/a.jar': 'other' }), packId: 'community-two' }, async () => { throw new Error('must not fetch') }), /另一个整合包/)
      assert.equal(await t.read('mods/a.jar'), 'half-updated'); assert(await t.read('.kamucl-managed-server/transaction.json'))
    } finally { await t.close() }
  }
})
