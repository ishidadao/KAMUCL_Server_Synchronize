const test = require('node:test'), assert = require('node:assert/strict')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')
const { EventEmitter } = require('node:events'), vm = require('node:vm')
const { isQaMain, loadedAsEntry } = require('../scripts/qa-entry.cjs')

function executeOwnedNativeEntry(executable, env, proof, runner = execFileSync) {
  try {
    return runner(executable, [path.resolve('scripts/verify-electron-qa-entry.cjs'), process.arch], { encoding: 'utf8', env, timeout: 25000, maxBuffer: 1024 * 1024 })
  } catch (error) {
    const diagnostic = { status: error.status, signal: error.signal, code: error.code,
      stdout: String(error.stdout || '').slice(-12000), stderr: String(error.stderr || '').slice(-12000), receipt: null }
    try { diagnostic.receipt = fs.readFileSync(path.join(proof, 'verification.json'), 'utf8').slice(0, 20000) } catch {}
    fs.mkdirSync(proof, { recursive: true }); fs.writeFileSync(path.join(proof, 'invocation-failure.json'), JSON.stringify(diagnostic, null, 2))
    console.error('QA_ENTRY_NATIVE_FAILURE ' + JSON.stringify(diagnostic))
    // An apparently complete receipt never excuses a crash, signal, timeout,
    // or nonzero exit. Preserve the original owned-process failure for CI.
    throw error
  }
}

function entryLifecycleFixture() {
  const script = path.resolve('scripts/verify-electron-qa-entry.cjs'), files = new Map(), scheduled = [], paths = new Map(), exits = [], crashStarts = []
  let ready, deadline, cleared = false, quitCalls = 0
  const app = new EventEmitter()
  app.setPath = (name, value) => paths.set(name, value); app.getPath = name => paths.get(name)
  app.whenReady = () => new Promise(resolve => { ready = resolve })
  app.exit = code => exits.push(code)
  app.quit = () => { quitCalls++; app.emit('before-quit'); app.emit('will-quit'); app.emit('quit', {}, 0) }
  const fakeFs = { ...fs, mkdtempSync: prefix => prefix + 'owned', mkdirSync: () => {},
    readFileSync: filename => { assert.equal(filename, 'owned-electron'); return Buffer.from('owned-native-bytes') },
    writeFileSync: (filename, content) => files.set(filename, content), realpathSync: { native: value => value } }
  const electronVersion = require('../package.json').devDependencies.electron
  const ownedProcess = { pid: 12345, execPath: 'owned-electron', platform: process.platform, arch: process.arch, argv: ['owned-electron', script, process.arch],
    env: {}, versions: { electron: electronVersion }, type: 'browser' }
  const ownedRequire = name => name === 'electron' ? { app, crashReporter: { start: options => crashStarts.push(options), getUploadToServer: () => false } } :
    name === './qa-entry.cjs' ? { isQaMain: () => true, loadedAsEntry: false } :
      name === 'node:fs' ? fakeFs : name === '../package.json' ? { devDependencies: { electron: electronVersion } } : require(name)
  const logs = []
  vm.runInNewContext(fs.readFileSync(script, 'utf8'), { require: ownedRequire, module: { filename: script }, process: ownedProcess, console: { log: value => logs.push(value), error: () => {} },
    setTimeout: (callback, ms) => { assert.equal(ms, 15000); deadline = callback; return 1 }, clearTimeout: timer => { assert.equal(timer, 1); cleared = true },
    setImmediate: callback => scheduled.push(callback) }, { filename: script })
  const report = () => JSON.parse([...files.entries()].find(([filename]) => filename.endsWith('verification.json'))[1])
  return { ready: () => ready(), deadline: () => deadline(), scheduled, exits, crashStarts, logs, report, quitCalls: () => quitCalls, cleared: () => cleared }
}

test('QA entry defers normal quit until its ready callback returns and only completes after all quit events', async () => {
  const fixture = entryLifecycleFixture()
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.crashStarts)), [{ productName: 'KAMUCL QA entry', uploadToServer: false }])
  fixture.ready(); await Promise.resolve(); await Promise.resolve()
  assert.equal(fixture.report().ready, true); assert.equal(fixture.report().complete, false)
  assert.equal(fixture.quitCalls(), 0); assert.equal(fixture.scheduled.length, 1); assert.equal(fixture.cleared(), false)
  assert.deepEqual(fixture.report().shutdown.events, [])
  fixture.scheduled[0]()
  assert.equal(fixture.quitCalls(), 1); assert.deepEqual(fixture.exits, [])
  assert.deepEqual(fixture.report().shutdown.events, ['before-quit', 'will-quit', 'quit'])
  assert.equal(fixture.report().shutdown.exitCode, 0); assert.equal(fixture.report().shutdown.forced, false)
  assert.equal(fixture.report().complete, true); assert.equal(fixture.cleared(), true)
  assert.equal(fixture.logs.length, 1); assert.match(fixture.logs[0], /^QA_ENTRY_PROOF /)
})

test('QA entry readiness alone cannot pass its normal quit deadline and forced termination stays a failure', async () => {
  const fixture = entryLifecycleFixture()
  fixture.ready(); await Promise.resolve(); await Promise.resolve(); fixture.deadline()
  assert.equal(fixture.report().ready, true); assert.equal(fixture.report().complete, false)
  assert.equal(fixture.report().error.code, 'QA_ENTRY_LIFECYCLE_DEADLINE')
  assert.equal(fixture.report().shutdown.forced, true); assert.deepEqual(fixture.exits, [1])
  assert.equal(fixture.quitCalls(), 0); assert.equal(fixture.logs.length, 0)
  fixture.scheduled[0](); assert.equal(fixture.quitCalls(), 0)
})

test('QA entry keeps a native access violation fatal even when the child already wrote a complete receipt', () => {
  const proof = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-entry-crash-contract-'))
  const failure = Object.assign(new Error('Owned Electron access violation'), { status: 3221225477, signal: null, stdout: 'QA_ENTRY_PROOF ' + path.join(proof, 'verification.json'), stderr: '' })
  fs.writeFileSync(path.join(proof, 'verification.json'), JSON.stringify({ complete: true, ready: true, shutdown: { exitCode: 0 } }))
  let invocations = 0
  try {
    assert.throws(() => executeOwnedNativeEntry('owned-electron.exe', { OWNED_QA: 'true' }, proof, (executable, args, options) => {
      invocations++; assert.equal(executable, 'owned-electron.exe'); assert.equal(args[1], process.arch)
      assert.equal(options.timeout, 25000); assert.equal(options.maxBuffer, 1024 * 1024); assert.deepEqual(options.env, { OWNED_QA: 'true' })
      throw failure
    }), error => error === failure)
    assert.equal(invocations, 1, 'A failed native process must not be silently retried')
    const diagnostic = JSON.parse(fs.readFileSync(path.join(proof, 'invocation-failure.json'), 'utf8'))
    assert.equal(diagnostic.status, 3221225477); assert.equal(diagnostic.signal, null)
    assert.equal(JSON.parse(diagnostic.receipt).complete, true)
  } finally { fs.rmSync(proof, { recursive: true, force: true }) }
})

test('Electron QA entry matches only the canonical requested main despite default-app require.main', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-entry-contract-'))
  const file = path.join(root, 'main.cjs'), imported = path.join(root, 'imported.cjs')
  fs.writeFileSync(file, ''); fs.writeFileSync(imported, '')
  try {
    const runtime = { type: 'browser', versions: { electron: '44.3.0' }, env: {}, argv: ['electron', file] }
    assert.equal(isQaMain({ filename: path.join(root, '..', path.basename(root), 'main.cjs') }, { filename: 'electron' }, runtime), true)
    assert.equal(isQaMain({ filename: imported }, { filename: 'electron' }, runtime), false)
    assert.equal(isQaMain({ filename: file }, { filename: 'electron' }, { ...runtime, argv: ['electron', path.join(root, 'missing.cjs')] }), false)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('Electron QA entry rejects RUN_AS_NODE browser identity and imported Node modules', () => {
  const current = { filename: __filename }
  assert.equal(isQaMain(current, current, { type: 'browser', versions: { electron: '44.3.0' }, env: { ELECTRON_RUN_AS_NODE: '1' }, argv: ['electron', __filename] }), false)
  assert.equal(isQaMain(current, current, { versions: {}, env: {}, argv: ['node', __filename] }), true)
  assert.equal(isQaMain(current, {}, { versions: {}, env: {}, argv: ['node', __filename] }), false)
  assert.equal(loadedAsEntry, false)
})

test('QA entry retains actual ordinary Node direct behavior without starting an imported helper', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-node-entry-'))
  const main = path.join(root, 'main.cjs'), helper = path.resolve('scripts/qa-entry.cjs')
  fs.writeFileSync(main, `const q=require(${JSON.stringify(helper)});console.log(JSON.stringify({direct:q.isQaMain(module,require.main),helper:q.loadedAsEntry}));`)
  try {
    const result = JSON.parse(execFileSync(process.execPath, [main], { encoding: 'utf8', timeout: 10000 }).trim())
    assert.deepEqual(result, { direct: true, helper: false })
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('actual pinned Electron custom-main loads the QA entry and leaves its private imported helper inactive', {
  timeout: 30000,
  skip: process.platform === 'linux' && !process.env.DISPLAY ? 'No display on native package test host; mandatory integration Xvfb loader contract runs separately, not desktop acceptance' : false
}, () => {
  const executable = require('electron'), env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const proof = path.resolve('out/qa-entry-proof-' + process.platform + '-' + process.arch + '-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex'))
  env.KAMUCL_QA_ENTRY_PROOF_DIR = proof
  const output = executeOwnedNativeEntry(executable, env, proof)
  const match = /^QA_ENTRY_PROOF (.+)$/m.exec(output); assert(match, 'Actual Electron must execute and emit the short-main receipt')
  const file = match[1].trim(), report = JSON.parse(fs.readFileSync(file)), actual = report.actual
  assert.equal(path.resolve(file), path.join(proof, 'verification.json'))
  assert.equal(report.complete, true); assert.equal(report.ready, true); assert.equal(report.contractOnly, true); assert.equal(report.nativeDesktop, false)
  assert.equal(report.crashReporterUploads, false)
  assert.equal(report.shutdown.method, 'app.quit'); assert.equal(report.shutdown.deferredFromReady, true)
  assert.equal(report.shutdown.requested, true); assert.equal(report.shutdown.forced, false); assert.equal(report.shutdown.exitCode, 0)
  assert.deepEqual(report.shutdown.events, ['before-quit', 'will-quit', 'quit'])
  assert.equal(actual.matchedRequestedEntry, true); assert.equal(actual.helperLoadedAsEntry, false)
  assert.equal(actual.type, 'browser'); assert.equal(actual.runAsNode, false); assert.equal(actual.arch, process.arch)
  assert.equal(actual.runtime, require('../package.json').devDependencies.electron)
  assert(Number.isSafeInteger(actual.pid) && actual.pid > 0 && actual.pid !== process.pid)
  assert.equal(fs.realpathSync(actual.argv[1]), fs.realpathSync(actual.moduleFile))
  assert.equal(actual.executableSHA256, crypto.createHash('sha256').update(fs.readFileSync(executable)).digest('hex'))
  const privateRoot = path.dirname(actual.userData)
  assert.equal(actual.appData, path.join(privateRoot, 'config')); assert.equal(actual.userData, path.join(privateRoot, 'profile'))
  assert(fs.realpathSync.native(privateRoot).startsWith(fs.realpathSync.native(os.tmpdir()) + path.sep)); assert(path.basename(privateRoot).startsWith('KAMUCL QA entry '))
  assert.equal(fs.realpathSync.native(actual.crashDumps), fs.realpathSync.native(path.join(proof, 'crashDumps')))
  // execFileSync has observed the owned native process's normal exit already.
  fs.rmSync(privateRoot, { recursive: true, force: true })
})
