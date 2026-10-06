const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createHash } = require('node:crypto')
const vm = require('node:vm')
const { execFileSync } = require('node:child_process')
const { readCommittedSource, planBlobBatches, isExcludedNonBuildFile } = require('../scripts/committed-source.cjs')

function repository(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kamucl-source 中文 '))
  t.after(() => {
    assert(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep))
    assert(path.basename(root).startsWith('kamucl-source 中文 '))
    fs.rmSync(root, { recursive: true, force: true })
  })
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
  git(['init', '-q']); git(['config', 'user.name', 'Source fixture']); git(['config', 'user.email', 'fixture@invalid.test']); git(['config', 'core.autocrlf', 'false'])
  fs.writeFileSync(path.join(root, '源码 §.txt'), 'first\nsecond\n')
  fs.writeFileSync(path.join(root, 'binary.bin'), Buffer.from([0, 10, 13, 255]))
  git(['add', '--', '.']); git(['commit', '-qm', 'Synthetic source fixture'])
  return { root, git }
}

test('source distribution reads exact Git blobs despite CRLF checkout and excludes untracked private files', t => {
  const { root, git } = repository(t)
  git(['config', 'core.autocrlf', 'true'])
  fs.unlinkSync(path.join(root, '源码 §.txt')); git(['checkout', '--', '源码 §.txt'])
  assert.equal(fs.readFileSync(path.join(root, '源码 §.txt'), 'utf8'), 'first\r\nsecond\r\n')
  fs.writeFileSync(path.join(root, 'accounts.json'), '{"private":"synthetic"}')
  const result = readCommittedSource(root)
  assert.equal(result.commit, git(['rev-parse', 'HEAD']))
  assert.deepEqual(result.files.map(f => f.path), ['binary.bin', '源码 §.txt'])
  assert.equal(result.files[1].bytes.toString(), 'first\nsecond\n')
  assert.deepEqual(result.files[0].bytes, Buffer.from([0, 10, 13, 255]))
})

test('source distribution rejects both staged and unstaged changes rather than silently shipping an older commit', t => {
  const { root, git } = repository(t)
  fs.writeFileSync(path.join(root, 'binary.bin'), Buffer.from([1]))
  assert.throws(() => readCommittedSource(root), /Commit tracked source/)
  git(['add', '--', 'binary.bin'])
  assert.throws(() => readCommittedSource(root), /Commit tracked source/)
})

test('source distribution rejects committed symbolic link entries even without a local symlink', t => {
  const { root, git } = repository(t)
  const oid = git(['rev-parse', 'HEAD:binary.bin'])
  git(['update-index', '--add', '--cacheinfo', '120000,' + oid + ',link'])
  git(['commit', '-qm', 'Synthetic forbidden link'])
  // The checkout must be clean so the test reaches the authoritative tree mode guard.
  fs.writeFileSync(path.join(root, 'link'), Buffer.from([0, 10, 13, 255]))
  git(['update-index', '--assume-unchanged', '--', 'link'])
  assert.throws(() => readCommittedSource(root), /committed ordinary file/)
})

function mockedGit(sources, settings = {}) {
  const entries = sources.map(source => {
    const bytes = source.bytes ?? Buffer.alloc(0)
    const oid = createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex')
    return { ...source, bytes, oid, size: source.size ?? bytes.length }
  })
  const batches = []; let headCalls = 0, cleanCalls = 0
  const options = {
    batchBytes: settings.batchBytes ?? 256,
    execFileSync: (command, args, config) => {
      assert.equal(command, 'git')
      assert(Number.isSafeInteger(config.maxBuffer) && config.maxBuffer > 0)
      if (args[0] === 'rev-parse') {
        const commit = headCalls++ && settings.changedHead ? 'b'.repeat(40) : 'a'.repeat(40)
        return Buffer.from(commit + '\n')
      }
      if (args[0] === 'ls-tree') {
        assert(args.includes('-l'), 'size metadata must come from the authoritative committed tree')
        return Buffer.from(entries.map(entry => (entry.mode ?? '100644') + ' blob ' + entry.oid + ' ' + entry.size + '\t' + entry.path + '\0').join(''))
      }
      assert.deepEqual(args, ['cat-file', '--batch'])
      const ids = config.input.trimEnd().split('\n')
      batches.push(ids)
      const response = Buffer.concat(ids.map(oid => {
        const entry = entries.find(item => item.oid === oid)
        assert(entry)
        return Buffer.concat([Buffer.from(oid + ' blob ' + entry.size + '\n'), entry.bytes, Buffer.from('\n')])
      }))
      assert(response.length <= config.maxBuffer, 'each response must fit its independently bounded maxBuffer')
      return settings.alterBatch ? settings.alterBatch(response) : response
    },
    spawnSync: (command, args) => {
      assert.equal(command, 'git'); assert.deepEqual(args, ['diff', '--quiet', 'HEAD', '--'])
      cleanCalls++
      return { status: settings.dirtyAfter && cleanCalls > 1 ? 1 : 0 }
    }
  }
  return { options, entries, batches, calls: () => ({ headCalls, cleanCalls }) }
}

test('source distribution batches more than the previous 96 MiB aggregate without allocating a large fixture', () => {
  const rows = Array.from({ length: 120 }, (_, index) => ({
    path: 'asset-' + index + '.bin', oid: index.toString(16).padStart(40, '0'), size: 1024 * 1024
  }))
  assert(rows.reduce((total, row) => total + row.size, 0) > 96 * 1024 * 1024)
  const planned = planBlobBatches(rows)
  assert(planned.length > 1)
  assert(planned.every(batch => batch.bytes <= 16 * 1024 * 1024))
  assert.deepEqual(planned.flatMap(batch => batch.rows), rows)
  // Scale the same admission threshold down for a complete mocked execution:
  // the old all-objects call would need one response larger than the budget.
  const git = mockedGit(Array.from({ length: 30 }, (_, index) => ({
    path: 'source-' + index + '.txt', bytes: Buffer.from(('exact-' + index + '-').padEnd(32, '!'))
  })))
  const result = readCommittedSource(os.tmpdir(), git.options)
  assert(git.batches.length > 1)
  assert(git.batches.every(batch => batch.length < git.entries.length))
  assert.deepEqual(result.files.map(file => file.bytes), git.entries.map(entry => entry.bytes))
  assert.deepEqual(result.files.map(file => file.oid), git.entries.map(entry => entry.oid))
  assert.deepEqual(git.calls(), { headCalls: 2, cleanCalls: 2 })
})

test('source distribution admits one bounded large blob alone and rejects invalid batch budgets', () => {
  const rows = [
    { path: 'large.bin', oid: 'a'.repeat(40), size: 20 * 1024 * 1024 },
    { path: 'small.bin', oid: 'b'.repeat(40), size: 10 }
  ]
  const batches = planBlobBatches(rows)
  assert.equal(batches.length, 2); assert.equal(batches[0].rows.length, 1)
  assert(batches[0].bytes < 64 * 1024 * 1024 + 1024)
  for (const batchBytes of [0, -1, 1.5, NaN, Infinity, 16 * 1024 * 1024 + 1, '256']) {
    assert.throws(() => readCommittedSource(os.tmpdir(), { batchBytes }), /Invalid committed source/)
    assert.throws(() => planBlobBatches(rows, batchBytes), /Invalid committed source/)
  }
})

test('source distribution bounds individual and total committed sizes before reading object bodies', () => {
  const single = mockedGit([{ path: 'oversized.bin', size: 64 * 1024 * 1024 + 1 }])
  assert.throws(() => readCommittedSource(os.tmpdir(), single.options), /64 MiB safety limit/)
  assert.equal(single.batches.length, 0)
  const total = mockedGit([
    ...Array.from({ length: 8 }, (_, index) => ({ path: 'large-' + index + '.bin', size: 64 * 1024 * 1024 })),
    { path: 'one-more.bin', size: 1 }
  ])
  assert.throws(() => readCommittedSource(os.tmpdir(), total.options), /512 MiB safety limit/)
  assert.equal(total.batches.length, 0)
})

test('source distribution rejects malformed batched headers, sizes, terminators and trailing bytes', () => {
  const source = { path: 'binary.bin', bytes: Buffer.from([0, 10, 13, 255]) }
  const mutations = [
    bytes => Buffer.from(bytes.toString('latin1').replace(/^[a-f0-9]/, 'z'), 'latin1'),
    bytes => Buffer.from(bytes.toString('latin1').replace(' blob 4\n', ' blob 5\n'), 'latin1'),
    bytes => Buffer.from(bytes.toString('latin1').replace(' blob ', ' tree '), 'latin1'),
    bytes => Buffer.from(bytes.toString('latin1').replace(' blob ', ' blob  '), 'latin1'),
    bytes => bytes.subarray(0, bytes.length - 1),
    bytes => { const changed = Buffer.from(bytes); changed[changed.length - 1] = 0; return changed },
    bytes => Buffer.concat([bytes, Buffer.from('unexpected')]),
    () => Buffer.from('missing-newline')
  ]
  for (const alterBatch of mutations) {
    const git = mockedGit([source], { alterBatch })
    assert.throws(() => readCommittedSource(os.tmpdir(), git.options), /committed blob/)
  }
})

test('source distribution keeps same-HEAD and before/after clean guards across multiple batches', () => {
  const source = Array.from({ length: 20 }, (_, index) => ({ path: 'file-' + index + '.txt', bytes: Buffer.from('content-' + index) }))
  const changed = mockedGit(source, { changedHead: true })
  assert.throws(() => readCommittedSource(os.tmpdir(), changed.options), /changed during packaging/)
  assert(changed.batches.length > 1)
  const dirty = mockedGit(source, { dirtyAfter: true })
  assert.throws(() => readCommittedSource(os.tmpdir(), dirty.options), /Commit tracked source/)
  assert.deepEqual(dirty.calls(), { headCalls: 2, cleanCalls: 2 })
})

test('source distribution excludes only numeric-semver validation evidence and still requires those tracked files to be clean', t => {
  const { root, git } = repository(t)
  const excluded = [
    'docs/validation-1.1.15/evidence/capes/report.json',
    'docs/validation-1.1.15/evidence/raw/out/generated.js'
  ]
  const retained = [
    'src/assets/icon.txt', 'scripts/build-input.cjs', 'tests/current.test.cjs', 'licenses/NOTICE.txt',
    'publisher/README.md', 'docs/managed-server-sync.md', 'docs/current/evidence/report.json',
    'docs/validation-1.1.15/README.md', 'docs/validation-1.1.15/evidence-not/report.json',
    'docs/validation-1.1.15/notes/evidence/report.json', 'docs/validation-1.1.15-rc.1/evidence/report.json',
    'docs/validation-01.1.15/evidence/report.json', 'docs/validation-latest/evidence/report.json',
    'docs/validation-1.1/evidence/report.json', 'assets/validation-1.1.15/evidence/source.txt'
  ]
  for (const name of [...excluded, ...retained]) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true })
    fs.writeFileSync(path.join(root, name), name + '\n')
  }
  git(['add', '--', '.']); git(['commit', '-qm', 'Synthetic source and historical generated evidence'])
  const result = readCommittedSource(root), paths = result.files.map(file => file.path)
  assert.deepEqual(result.excludedNonBuildFiles, excluded)
  for (const name of excluded) assert(!paths.includes(name))
  for (const name of retained) {
    assert(paths.includes(name), 'retain corresponding source input: ' + name)
    assert.equal(result.files.find(file => file.path === name).bytes.toString(), name + '\n')
    assert.equal(isExcludedNonBuildFile(name), false)
  }
  fs.writeFileSync(path.join(root, excluded[0]), 'changed evidence\n')
  assert.throws(() => readCommittedSource(root), /Commit tracked source/)
  git(['add', '--', excluded[0]])
  assert.throws(() => readCommittedSource(root), /Commit tracked source/)
})

test('source distribution never reads excluded generated blobs but does not exempt unsafe paths or file modes', () => {
  const excluded = 'docs/validation-1.1.15/evidence/raw/out/large-generated.bin'
  const git = mockedGit([
    { path: excluded, size: 1024 * 1024 * 1024 },
    { path: 'src/build-input.ts', bytes: Buffer.from('retained input\n') }
  ])
  const result = readCommittedSource(os.tmpdir(), git.options)
  assert.deepEqual(result.excludedNonBuildFiles, [excluded])
  assert.deepEqual(result.files.map(file => file.path), ['src/build-input.ts'])
  assert(!git.batches.flat().includes(git.entries[0].oid))
  const linked = mockedGit([{ path: excluded, mode: '120000' }])
  assert.throws(() => readCommittedSource(os.tmpdir(), linked.options), /committed ordinary file/)
  const unsafe = mockedGit([{ path: 'docs/validation-1.1.15/evidence/../source.ts' }])
  assert.throws(() => readCommittedSource(os.tmpdir(), unsafe.options), /Unsafe committed source path/)
  for (const name of [
    'docs/validation-1.1.15/evidence', 'docs/validation-1.1.15/Evidence/report.json',
    'nested/docs/validation-1.1.15/evidence/report.json', 'docs/validation-1.1.15/evidences/report.json'
  ]) assert.equal(isExcludedNonBuildFile(name), false)
})

// Execute the real archive gate with synthetic ZIP/command adapters. No archive
// extraction, dependency installation, source edits or build commands occur.
function archiveGate(settings = {}) {
  const scriptPath = path.join(__dirname, '..', 'scripts', 'verify-source-archive.cjs')
  const archive = path.resolve(os.tmpdir(), 'synthetic-kamucl-source.zip')
  const filePath = settings.filePath ?? 'src/main.ts'
  const originalBytes = Buffer.from('retained original source\n')
  const bytes = settings.memberBytes ?? originalBytes
  const excluded = [
    'docs/validation-1.1.15/evidence/a.json',
    'docs/validation-1.1.15/evidence/raw/out/generated.js'
  ]
  const committed = { commit: 'a'.repeat(40), files: [{ path: filePath, bytes: originalBytes }], excludedNonBuildFiles: excluded }
  const sha = value => createHash('sha256').update(value).digest('hex')
  const manifest = {
    version: '1.1.17', commit: committed.commit, representation: 'raw-git-blobs',
    excludedNonBuildFiles: settings.excludedNonBuildFiles ?? excluded,
    files: settings.omitRetained ? [] : [{ path: filePath, size: bytes.length, sha256: sha(bytes) }]
  }
  if (settings.missingExclusions) delete manifest.excludedNonBuildFiles
  let extracted = false, proof, loggedError
  const calls = []
  class SyntheticZip {
    getEntries() { return [{ entryName: 'SOURCE-MANIFEST.json', isDirectory: false }, ...(settings.omitRetained ? [] : [{ entryName: filePath, isDirectory: false }])] }
    readAsText(name) { assert.equal(name, 'SOURCE-MANIFEST.json'); return JSON.stringify(manifest) }
    getEntry(name) { return name === filePath && !settings.omitRetained ? { attr: (settings.symlink ? 0o120000 : 0o100644) << 16 } : undefined }
    readFile(name) { return name === filePath && !settings.omitRetained ? bytes : undefined }
    extractAllTo() { extracted = true }
  }
  const fakeFs = {
    existsSync: () => false,
    mkdirSync: () => {},
    writeFileSync: (filename, value) => { if (filename.endsWith('.json')) proof = JSON.parse(String(value)) },
    readFileSync: filename => filename === archive ? Buffer.from('synthetic archive bytes') : settings.modifiedAfterBuild ? Buffer.from('changed after build') : bytes
  }
  const fakeProcess = { argv: ['node', scriptPath, archive], env: {}, platform: 'linux', exitCode: 0 }
  vm.runInNewContext(fs.readFileSync(scriptPath, 'utf8'), {
    __dirname: path.dirname(scriptPath), Buffer, process: fakeProcess,
    console: { log: () => {}, error: message => { loggedError = String(message) } },
    require: name => {
      if (name === 'node:fs') return fakeFs
      if (name === 'node:child_process') return { spawnSync: (command, args) => { calls.push([command, ...args]); return { status: settings.failedBuild ? 1 : 0, stdout: '', stderr: '' } } }
      if (name === 'adm-zip') return SyntheticZip
      if (name === '../package.json') return { version: '1.1.17' }
      if (name === './committed-source.cjs') return { readCommittedSource: () => committed }
      return require(name)
    }
  }, { filename: scriptPath })
  return { extracted, proof, loggedError, calls, exitCode: fakeProcess.exitCode }
}

test('source archive requires the exact complete committed exclusion list before extraction or rebuilding', () => {
  const accepted = archiveGate()
  assert.equal(accepted.extracted, true); assert.equal(accepted.exitCode, 0)
  assert.equal(accepted.proof.verified, true); assert.equal(accepted.proof.rawGitBlobIdentity, true)
  assert.deepEqual(accepted.calls, [
    ['npm', 'ci'], ['node', 'scripts/build-bridge.cjs'], ['npx', 'tsc', '--noEmit'],
    ['npm', 'run', 'build'], ['node', 'scripts/check-licenses.cjs']
  ])
  for (const settings of [
    { missingExclusions: true }, { excludedNonBuildFiles: [] },
    { excludedNonBuildFiles: ['src/main.ts'] },
    { excludedNonBuildFiles: ['docs/validation-1.1.15/evidence/a.json', 'docs/validation-1.1.15/evidence/a.json'] },
    { excludedNonBuildFiles: ['docs/validation-1.1.15/evidence/raw/out/generated.js', 'docs/validation-1.1.15/evidence/a.json'] }
  ]) {
    const result = archiveGate(settings)
    assert.equal(result.extracted, false); assert.equal(result.exitCode, 1); assert.equal(result.calls.length, 0)
    assert.match(result.loggedError, /manifest|exclusions/)
  }
})

test('source pack records exact excluded evidence paths alongside hashes of every retained Git blob', () => {
  const scriptPath = path.join(__dirname, '..', 'scripts', 'pack-source.cjs')
  const required = [
    'package-lock.json', 'src/main/core/voxlink/engine.ts', 'src/renderer/src/vendor/skinview3d/model.ts',
    'scripts/build-bridge.cjs', 'THIRD_PARTY_NOTICES.md', 'licenses/LGPL-3.0.txt'
  ]
  const committed = {
    commit: 'a'.repeat(40),
    files: required.map(name => ({ path: name, bytes: Buffer.from('retained Git blob: ' + name + '\n') })),
    excludedNonBuildFiles: ['docs/validation-1.1.15/evidence/raw/out/generated.js']
  }
  let writtenEntries, packedResult
  class SyntheticZip {
    constructor(filename) { this.files = filename ? writtenEntries : new Map() }
    addFile(name, bytes) { assert(!this.files.has(name)); this.files.set(name, Buffer.from(bytes)) }
    writeZip() { writtenEntries = this.files }
    readFile(name) { return this.files.get(name) }
  }
  vm.runInNewContext(fs.readFileSync(scriptPath, 'utf8'), {
    __dirname: path.dirname(scriptPath), Buffer,
    console: { log: value => { packedResult = JSON.parse(value) } },
    require: name => {
      if (name === 'node:fs') return { mkdirSync: () => {}, statSync: () => ({ size: 42 }), readFileSync: () => Buffer.from('synthetic archive') }
      if (name === 'adm-zip') return SyntheticZip
      if (name === '../package.json') return { version: '1.1.17' }
      if (name === './committed-source.cjs') return { readCommittedSource: () => committed }
      return require(name)
    }
  }, { filename: scriptPath })
  const manifest = JSON.parse(writtenEntries.get('SOURCE-MANIFEST.json').toString())
  assert.deepEqual(manifest.excludedNonBuildFiles, committed.excludedNonBuildFiles)
  assert.equal(manifest.commit, committed.commit); assert.equal(manifest.representation, 'raw-git-blobs')
  assert.equal(packedResult.files, required.length)
  assert(!writtenEntries.has(committed.excludedNonBuildFiles[0]))
  for (const file of committed.files) {
    assert(writtenEntries.get(file.path).equals(file.bytes))
    const entry = manifest.files.find(item => item.path === file.path)
    assert.equal(entry.size, file.bytes.length)
    assert.equal(entry.sha256, createHash('sha256').update(file.bytes).digest('hex'))
  }
})

test('source archive exclusion policy does not weaken retained membership, raw blobs, forbidden paths, secrets or clean rebuild gates', () => {
  for (const settings of [
    { omitRetained: true }, { memberBytes: Buffer.from('modified source with a valid manifest hash\n') },
    { filePath: 'src/out/generated.js' }, { filePath: '../escape.ts' }, { symlink: true },
    { filePath: 'src/accounts.json' },
    { memberBytes: Buffer.from('-----BEGIN ' + 'PRIVATE KEY-----\nsynthetic-only\n') }
  ]) {
    const result = archiveGate(settings)
    assert.equal(result.extracted, false); assert.equal(result.exitCode, 1); assert.equal(result.calls.length, 0)
  }
  const failedBuild = archiveGate({ failedBuild: true })
  assert.equal(failedBuild.extracted, true); assert.equal(failedBuild.exitCode, 1); assert.equal(failedBuild.proof.verified, false)
  assert.match(failedBuild.loggedError, /Clean source check failed/)
  const modified = archiveGate({ modifiedAfterBuild: true })
  assert.equal(modified.extracted, true); assert.equal(modified.exitCode, 1); assert.equal(modified.proof.verified, false)
  assert.match(modified.loggedError, /Build modified source/)
})
