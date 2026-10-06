// This intentionally executes as a dedicated short Electron main; no product
// application or user profile is loaded. No window/GPU/sandbox option is changed.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os')
const assert = require('node:assert/strict'), crypto = require('node:crypto')
const { app, crashReporter } = require('electron'), { isQaMain, loadedAsEntry } = require('./qa-entry.cjs')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'KAMUCL QA entry '))
const proofPrefix = 'qa-entry-proof-' + process.platform + '-' + process.arch + '-'
const proof = path.resolve(process.env.KAMUCL_QA_ENTRY_PROOF_DIR || path.join('out', proofPrefix + Date.now()))
assert.equal(path.dirname(proof), path.resolve('out'), 'The owned QA receipt must stay in its out directory')
assert(path.basename(proof).startsWith(proofPrefix) && /^\d+(?:-[a-f0-9]{8})?$/.test(path.basename(proof).slice(proofPrefix.length)), 'Invalid owned QA receipt directory')
const crashDumps = path.join(proof, 'crashDumps')
fs.mkdirSync(crashDumps, { recursive: true }); fs.mkdirSync(path.join(root, 'config')); fs.mkdirSync(path.join(root, 'profile'))
app.setPath('appData', path.join(root, 'config')); app.setPath('userData', path.join(root, 'profile'))
app.setPath('crashDumps', crashDumps)
const report = { schemaVersion: 1, complete: false, nativeDesktop: false, contractOnly: true,
  actual: { pid: process.pid, executable: process.execPath, executableSHA256: crypto.createHash('sha256').update(fs.readFileSync(process.execPath)).digest('hex'),
    argv: process.argv, moduleFile: module.filename, requireMainFile: require.main?.filename ?? null,
    requireMainEqualsModule: require.main === module, helperLoadedAsEntry: loadedAsEntry,
    matchedRequestedEntry: isQaMain(module, require.main), platform: process.platform, arch: process.arch, runtime: process.versions.electron,
    runAsNode: !!process.env.ELECTRON_RUN_AS_NODE, type: process.type, appData: app.getPath('appData'), userData: app.getPath('userData'), crashDumps: app.getPath('crashDumps') },
  shutdown: { method: 'app.quit', deferredFromReady: true, requested: false, forced: false, events: [], exitCode: null },
  startedAt: new Date().toISOString() }
const save = () => fs.writeFileSync(path.join(proof, 'verification.json'), JSON.stringify(report, null, 2))
save()
// Only this fresh, empty QA process is monitored. Crashpad must not send these
// local diagnostics to any external server or inspect a product user profile.
crashReporter.start({ productName: 'KAMUCL QA entry', uploadToServer: false })
report.crashReporterUploads = crashReporter.getUploadToServer(); assert.equal(report.crashReporterUploads, false); save()
const recordQuitEvent = event => { report.shutdown.events.push(event); save() }
app.once('before-quit', () => recordQuitEvent('before-quit'))
app.once('will-quit', () => recordQuitEvent('will-quit'))
app.once('quit', (_event, exitCode) => {
  report.shutdown.events.push('quit'); report.shutdown.exitCode = exitCode
  report.complete = report.ready === true && !report.error && report.shutdown.requested && !report.shutdown.forced && exitCode === 0 &&
    report.shutdown.events.join(',') === 'before-quit,will-quit,quit'
  report.finishedAt = new Date().toISOString(); save(); clearTimeout(timer)
  console.log('QA_ENTRY_PROOF ' + path.join(proof, 'verification.json'))
})
const fail = error => {
  report.error = { name: error.name, code: error.code, message: error.message, stack: error.stack }; report.complete = false
  report.shutdown.forced = true; save(); clearTimeout(timer); console.error(error); app.exit(1)
}
const timer = setTimeout(() => {
  const error = new Error('Owned Electron entry fixture did not complete its ready and normal quit lifecycle in 15 seconds')
  error.code = 'QA_ENTRY_LIFECYCLE_DEADLINE'; fail(error)
}, 15000)
app.whenReady().then(() => {
  assert.equal(report.actual.matchedRequestedEntry, true)
  assert.equal(report.actual.helperLoadedAsEntry, false)
  assert.equal(report.actual.type, 'browser'); assert.equal(report.actual.runAsNode, false)
  assert.equal(report.actual.runtime, require('../package.json').devDependencies.electron)
  assert.equal(process.arch, process.argv[2]); assert.equal(fs.realpathSync.native(app.getPath('userData')), fs.realpathSync.native(path.join(root, 'profile')))
  report.ready = true; save()
  // The invoking test may remove this private profile after this process exits;
  // removing an active Chromium profile would itself create a fixture failure.
  // Do not immediately tear down Electron from its ready Promise microtask:
  // return control to native startup first, then use the normal quit lifecycle.
  // The parent still requires an actual zero process exit, even after a receipt.
  setImmediate(() => {
    if (report.error || report.shutdown.forced) return
    try { report.shutdown.requested = true; save(); app.quit() }
    catch (error) { fail(error) }
  })
}).catch(fail)
