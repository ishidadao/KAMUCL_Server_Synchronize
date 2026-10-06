// Exercise the shipped bridge in a real JVM. Only this script's fixture can be
// terminated on timeout; no enumeration/signals to user games or profiles.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict'), net = require('node:net'), crypto = require('node:crypto')
const { spawn, spawnSync } = require('node:child_process')

// Windows JDK 17 native argument decoding can replace characters absent from
// the system code page. Keep every javac/java argument ASCII; actual runtime
// paths are reconstructed as UTF-8 Java Strings, not weakened to ASCII paths.
function nativeArguments(args) {
  for (const arg of args) assert(typeof arg === 'string' && /^[\x20-\x7e]+$/.test(arg), 'Native Java fixture arguments must be printable ASCII')
  return args
}
const encodePath = file => Buffer.from(path.resolve(file), 'utf8').toString('base64')
function decodePath(encoded) {
  assert(typeof encoded === 'string' && encoded.length > 0 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded), 'Invalid fixture path encoding')
  const bytes = Buffer.from(encoded, 'base64'); assert.equal(bytes.toString('base64'), encoded)
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const tool = name => process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', name + (process.platform === 'win32' ? '.exe' : '')) : name

function prepareCompilation(stage, sources, runner = spawnSync) {
  fs.copyFileSync(sources.fixture, path.join(stage, 'BridgeExitFixture.java'))
  fs.copyFileSync(sources.launcher, path.join(stage, 'BridgeExitLauncher.java'))
  fs.copyFileSync(sources.bridge, path.join(stage, 'bridge.jar'))
  fs.copyFileSync(sources.gson, path.join(stage, 'gson.jar'))
  fs.mkdirSync(path.join(stage, 'fixture-classes')); fs.mkdirSync(path.join(stage, 'launcher-classes'))
  for (const args of [
    ['-encoding', 'UTF-8', '--release', '17', '-cp', ['bridge.jar', 'gson.jar'].join(path.delimiter), '-d', 'fixture-classes', 'BridgeExitFixture.java'],
    ['-encoding', 'UTF-8', '--release', '17', '-d', 'launcher-classes', 'BridgeExitLauncher.java']
  ]) {
    const compile = runner(tool('javac'), nativeArguments(args), { cwd: stage, encoding: 'utf8', windowsHide: true })
    assert.ifError(compile.error); assert.equal(compile.status, 0, compile.stderr)
  }
}

function verifyLoadingProof(output, expected) {
  const matches = [...output.matchAll(/^FIXTURE_LOADING_PROOF (.+)$/gm)]
  assert.equal(matches.length, 1, 'Exactly one actual JVM loading proof is required')
  const proof = JSON.parse(matches[0][1])
  assert.equal(proof.schemaVersion, 1); assert.equal(proof.loaderParentPlatform, true); assert.equal(proof.loaderDistinct, true)
  for (const [field, file] of [['bridgeCodeSource', expected.bridge], ['gsonCodeSource', expected.gson], ['fixtureCodeSource', expected.fixtureClasses], ['profile', expected.profile]]) {
    assert.equal(fs.realpathSync.native(decodePath(proof[field])), fs.realpathSync.native(file), 'JVM loading identity mismatch: ' + field)
  }
  assert.equal(proof.bridgeSHA256, hash(expected.bridge)); assert.equal(proof.gsonSHA256, hash(expected.gson))
  assert(expected.profile.includes('中文') && expected.profile.includes(' '), 'The real runtime profile must retain its Unicode and space coverage')
  return proof
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'KAMUCL bridge exit 中文 '))
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'kamucl-bridge-exit-compile-'))
  const baseline = process.argv.includes('--baseline'), results = []
  const jar = path.resolve(process.env.KAMUCL_BRIDGE_JAR || (baseline ? 'tests/fixtures/kamucl-bridge-1.0.0.jar' : 'bridge/dist/kamucl-bridge-1.0.1.jar'))
  const gson = path.resolve('bridge/.cache/gson-2.14.0.jar'), fixtureClasses = path.join(stage, 'fixture-classes')
  try {
    prepareCompilation(stage, { fixture: path.resolve('tests/fixtures/BridgeExitFixture.java'), launcher: path.resolve('tests/fixtures/BridgeExitLauncher.java'), bridge: jar, gson })
    for (const stalled of [false, true]) {
      const dir = path.join(root, stalled ? 'stalled-request' : 'normal'); fs.mkdirSync(dir)
      const mod = path.join(dir, 'bridge.jar'); fs.copyFileSync(jar, mod)
      const args = nativeArguments(['-cp', 'launcher-classes', 'BridgeExitLauncher', ...[fixtureClasses, mod, gson, dir].map(encodePath)])
      const child = spawn(tool('java'), args, { cwd: stage, windowsHide: true })
      let output = '', error = '', socket, exited = false
      child.stdout.on('data', bytes => { output += bytes }); child.stderr.on('data', bytes => { error += bytes })
      const done = new Promise((resolve, reject) => {
        child.once('error', reject); child.once('exit', (code, signal) => { exited = true; resolve({ code, signal }) })
      })
      try {
        const ready = Date.now() + 8000
        while (!output.includes('FIXTURE_READY') && Date.now() < ready && !exited) await sleep(20)
        assert(output.includes('FIXTURE_READY'), output + error)
        const loading = verifyLoadingProof(output, { bridge: mod, gson, fixtureClasses, profile: dir })
        const descriptor = JSON.parse(fs.readFileSync(path.join(dir, '.kamucl-bridge.json')))
        const base = 'http://127.0.0.1:' + descriptor.port + '/kamucl/v1/'
        assert.equal((await (await fetch(base + 'ping')).json()).ok, true)
        const manifest = await (await fetch(base + 'manifest')).json(); assert(manifest.params.length > 0)
        assert.equal((await fetch(base + 'set', { method: 'POST', body: '{}' })).status, 401)
        const parameter = manifest.params.find(parameter => parameter.kind === 'TEXT'); assert(parameter)
        const changed = await (await fetch(base + 'set', { method: 'POST', headers: { 'X-Kamucl-Token': descriptor.token }, body: JSON.stringify({ id: parameter.id, value: 'fixture' }) })).json()
        assert.equal(changed.ok, true)
        if (stalled) {
          socket = net.connect(descriptor.port, '127.0.0.1'); await new Promise(resolve => socket.once('connect', resolve)); socket.on('error', () => {})
          socket.write('POST /kamucl/v1/set HTTP/1.1\r\nHost: localhost\r\nX-Kamucl-Token: ' + descriptor.token + '\r\nContent-Length: 100000\r\n\r\n{'); await sleep(100)
        }
        const start = Date.now(); child.stdin.end('\n')
        let timer
        const result = await Promise.race([done, new Promise(resolve => { timer = setTimeout(() => resolve(null), 4000) })]); clearTimeout(timer)
        if (baseline) {
          assert.equal(result, null, 'Old bridge unexpectedly exited'); results.push({ stalled, baselineStuck: true, loading })
        } else {
          assert.deepEqual(result, { code: 0, signal: null }, error)
          assert.equal(fs.readFileSync(path.join(dir, 'saved.marker'), 'utf8'), 'save completed')
          fs.renameSync(mod, mod + '.released'); fs.unlinkSync(mod + '.released')
          results.push({ stalled, exitMs: Date.now() - start, saved: true, modReleased: true, loading })
        }
      } finally {
        socket?.destroy(); if (!exited) { child.kill(); await done }
      }
    }
    fs.mkdirSync('out', { recursive: true }); fs.writeFileSync('out/bridge-exit-' + (baseline ? 'baseline' : 'fixed') + '.json', JSON.stringify(results, null, 2)); console.log(JSON.stringify(results))
  } catch (error) {
    fs.mkdirSync('out', { recursive: true }); fs.writeFileSync('out/bridge-exit-failure.json', JSON.stringify({ baseline, results, error: { name: error.name, message: error.message, stack: error.stack } }, null, 2))
    throw error
  } finally {
    fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(stage, { recursive: true, force: true })
  }
}

module.exports = { nativeArguments, encodePath, decodePath, prepareCompilation, verifyLoadingProof }
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1 })
