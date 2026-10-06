import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { RunningGameRecords, type RunningGameRecord } from '../src/main/core/runningGameRecords'

function fixture() {
  // macOS /var is a system symlink; use its canonical path for private storage.
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kamucl-running-records-')))
  const store = path.join(root, 'user data')
  const record = (pid: number, name = String(pid)): RunningGameRecord => ({
    pid, versionId: `managed-${name}`, folder: path.join(root, 'Minecraft Folder'),
    effectiveGameDir: path.join(root, 'Minecraft Folder', 'versions', name),
    logDir: path.join(root, 'logs', name), startedAt: '2026-10-06T10:00:00Z'
  })
  return { root, store, record, close: () => fs.rmSync(root, { recursive: true, force: true }) }
}

test('managed lifecycle: detached parallel PIDs remain independently tracked and removal never clears other games', () => {
  const t = fixture(), records = new RunningGameRecords(t.store, () => true)
  try {
    records.write(t.record(1001)); records.write(t.record(1002))
    const reopened = new RunningGameRecords(t.store, () => true)
    assert.deepEqual(reopened.alive().map(record => record.pid).sort(), [1001, 1002])
    records.remove(1001)
    assert.deepEqual(reopened.alive().map(record => record.pid), [1002])
    assert.equal(fs.existsSync(path.join(t.store, 'running-games', '1001.json')), false)
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(t.store, 'running-games', '1002.json')).mode & 0o777, 0o600)
    assert.deepEqual(fs.readdirSync(path.join(t.store, 'running-games')), ['1002.json'])
  } finally { t.close() }
})

test('managed lifecycle: exact canonical directories with spaces and aliases block sync, unrelated folders do not', () => {
  const t = fixture(), records = new RunningGameRecords(t.store, () => true), game = t.record(1001)
  try {
    fs.mkdirSync(game.effectiveGameDir, { recursive: true })
    records.write(game)
    assert.equal(records.usesDirectory(game.effectiveGameDir), true)
    assert.equal(records.usesDirectory(path.join(t.root, 'Other Folder')), false)
    const alias = path.join(t.root, 'game-alias')
    fs.symlinkSync(game.effectiveGameDir, alias, 'dir')
    assert.equal(records.usesDirectory(alias), true)
  } finally { t.close() }
})

test('managed lifecycle: dead records are pruned without losing a live parallel game', () => {
  const t = fixture(), records = new RunningGameRecords(t.store, pid => pid === 1002)
  try {
    records.write(t.record(1001)); records.write(t.record(1002))
    assert.deepEqual(records.alive().map(record => record.pid), [1002])
    assert.equal(fs.existsSync(path.join(t.store, 'running-games', '1001.json')), false)
    assert.equal(records.usesDirectory(t.record(1001).effectiveGameDir), false)
    assert.equal(records.usesDirectory(t.record(1002).effectiveGameDir), true)
  } finally { t.close() }
})

test('managed lifecycle: permission/probe uncertainty stays busy; only ESRCH proves the recorded process exited', () => {
  const t = fixture()
  try {
    new RunningGameRecords(t.store, () => true).write(t.record(1001))
    for (const code of ['EPERM', 'EACCES', 'UNKNOWN']) {
      const records = new RunningGameRecords(t.store, () => { throw Object.assign(new Error('probe failed'), { code }) })
      assert.equal(records.usesDirectory(t.record(1001).effectiveGameDir), true)
    }
    const dead = new RunningGameRecords(t.store, () => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }) })
    assert.deepEqual(dead.alive(), [])
    assert.equal(fs.existsSync(path.join(t.store, 'running-games', '1001.json')), false)
  } finally { t.close() }
})

test('managed lifecycle: legacy singleton coexists with new parallel records and is cleaned only for its PID', () => {
  const t = fixture(), records = new RunningGameRecords(t.store, () => true)
  try {
    records.write(t.record(1002))
    fs.writeFileSync(path.join(t.store, 'running-game.json'), JSON.stringify(t.record(1001)), { mode: 0o600 })
    assert.deepEqual(records.alive().map(record => record.pid).sort(), [1001, 1002])
    records.remove(1002)
    assert.equal(fs.existsSync(path.join(t.store, 'running-game.json')), true)
    records.write(t.record(1001))
    assert.equal(fs.existsSync(path.join(t.store, 'running-game.json')), false)
    assert.deepEqual(records.alive().map(record => record.pid), [1001])
  } finally { t.close() }
})

test('managed lifecycle: malformed, mismatched, oversized and invalid directory/PID records fail closed', () => {
  const t = fixture(), records = new RunningGameRecords(t.store, () => false)
  try {
    records.write(t.record(1001))
    const filename = path.join(t.store, 'running-games', '1001.json')
    for (const raw of ['{broken', JSON.stringify({ ...t.record(1001), pid: -1 }), JSON.stringify({ ...t.record(1001), pid: 1002 }), JSON.stringify({ ...t.record(1001), effectiveGameDir: 1 }), JSON.stringify({ ...t.record(1001), folder: [] }), JSON.stringify({ ...t.record(1001), logDir: 'relative' }), ' '.repeat(129 * 1024)]) {
      fs.writeFileSync(filename, raw)
      assert.throws(() => records.alive(), /记录|存储/)
      assert.equal(fs.existsSync(filename), true)
    }
    for (const pid of [0, -1, 1.5, Number.MAX_SAFE_INTEGER]) assert.throws(() => records.write(t.record(pid)))
    assert.throws(() => new RunningGameRecords('relative'))
  } finally { t.close() }
})

test('managed lifecycle: symlink storage/records cannot redirect inspection or mutation outside the private store', () => {
  const t = fixture(), records = new RunningGameRecords(t.store, () => true)
  try {
    records.write(t.record(1001))
    const directory = path.join(t.store, 'running-games'), saved = path.join(t.root, 'saved-records')
    fs.renameSync(directory, saved); fs.symlinkSync(saved, directory, 'dir')
    assert.throws(() => records.alive(), /存储/)
    assert.throws(() => records.write(t.record(1002)), /存储/)
    assert.throws(() => records.remove(1001), /存储/)
    fs.unlinkSync(directory); fs.renameSync(saved, directory)
    const filename = path.join(directory, '1001.json'), outside = path.join(t.root, 'outside.json')
    fs.writeFileSync(outside, JSON.stringify(t.record(1001)))
    fs.unlinkSync(filename); fs.symlinkSync(outside, filename)
    assert.throws(() => records.alive(), /存储/)
    assert.throws(() => records.remove(1001), /存储/)
    assert.equal(JSON.parse(fs.readFileSync(outside, 'utf8')).pid, 1001)
  } finally { t.close() }
})

test('managed lifecycle: missing storage is idle; more than 1024 records fail closed before pruning', () => {
  const t = fixture(), records = new RunningGameRecords(t.store, () => false)
  try {
    assert.deepEqual(records.alive(), [])
    const directory = path.join(t.store, 'running-games')
    fs.mkdirSync(directory, { recursive: true })
    for (let pid = 1; pid <= 1025; pid++) fs.writeFileSync(path.join(directory, `${pid}.json`), JSON.stringify(t.record(pid)))
    assert.throws(() => records.alive(), /存储/)
    assert.equal(fs.readdirSync(directory).length, 1025)
  } finally { t.close() }
})
