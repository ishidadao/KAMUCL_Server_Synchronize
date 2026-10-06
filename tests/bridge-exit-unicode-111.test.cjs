const test = require('node:test'), assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto')
const { nativeArguments, encodePath, decodePath, prepareCompilation, verifyLoadingProof } = require('../scripts/verify-bridge-exit.cjs')
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')

test('bridge fixture retains Unicode paths through UTF-8/Base64 while every native Java argument stays ASCII', () => {
  const file = path.join(os.tmpdir(), 'KAMUCL bridge exit 中文 空格', '桥.jar')
  assert.equal(decodePath(encodePath(file)), path.resolve(file))
  assert.deepEqual(nativeArguments(['-cp', 'launcher-classes', 'BridgeExitLauncher', encodePath(file)]), ['-cp', 'launcher-classes', 'BridgeExitLauncher', encodePath(file)])
  assert.throws(() => nativeArguments(['-d', file]), /printable ASCII/)
  assert.throws(() => nativeArguments(['line\nbreak']), /printable ASCII/)
  assert.throws(() => decodePath('not-base64!'), /encoding/)
  assert.throws(() => decodePath(Buffer.from([0xff]).toString('base64')), /encoded data/)
})

test('bridge fixture compiles unmodified sources and JAR copies using only relative ASCII argv from an owned stage', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'KAMUCL compile fixture 中文 ')), stage = path.join(root, 'stage')
  fs.mkdirSync(stage)
  const sources = { fixture: path.join(root, '原fixture.java'), launcher: path.resolve('tests/fixtures/BridgeExitLauncher.java'), bridge: path.join(root, '桥.jar'), gson: path.join(root, '库.jar') }
  fs.writeFileSync(sources.fixture, fs.readFileSync('tests/fixtures/BridgeExitFixture.java')); fs.writeFileSync(sources.bridge, 'bridge bytes'); fs.writeFileSync(sources.gson, 'gson bytes')
  const invocations = []
  try {
    prepareCompilation(stage, sources, (executable, args, options) => { invocations.push({ executable, args, options }); return { status: 0, stderr: '' } })
    assert.equal(invocations.length, 2)
    for (const invocation of invocations) {
      assert.equal(invocation.options.cwd, stage); assert.equal(invocation.options.windowsHide, true)
      assert.equal(invocation.options.encoding, 'utf8'); assert.deepEqual(nativeArguments(invocation.args), invocation.args)
      assert(invocation.args.includes('--release') && invocation.args.includes('17'))
      assert(!invocation.args.some(arg => arg.includes(root)))
    }
    assert.deepEqual(invocations[0].args, ['-encoding', 'UTF-8', '--release', '17', '-cp', ['bridge.jar', 'gson.jar'].join(path.delimiter), '-d', 'fixture-classes', 'BridgeExitFixture.java'])
    assert.deepEqual(invocations[1].args, ['-encoding', 'UTF-8', '--release', '17', '-d', 'launcher-classes', 'BridgeExitLauncher.java'])
    assert(fs.readFileSync(path.join(stage, 'BridgeExitFixture.java')).equals(fs.readFileSync('tests/fixtures/BridgeExitFixture.java')))
    assert.equal(hash(path.join(stage, 'bridge.jar')), hash(sources.bridge)); assert.equal(hash(path.join(stage, 'gson.jar')), hash(sources.gson))
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('bridge fixture rejects substituted JAR, profile, fixture parent and digest loading proofs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'KAMUCL proof 中文 ')), profile = path.join(root, 'actual profile'), fixtureClasses = path.join(root, 'fixture-classes')
  fs.mkdirSync(profile); fs.mkdirSync(fixtureClasses)
  const bridge = path.join(profile, 'bridge.jar'), gson = path.join(root, 'gson.jar'), other = path.join(root, 'other.jar')
  fs.writeFileSync(bridge, 'bridge bytes'); fs.writeFileSync(gson, 'gson bytes'); fs.writeFileSync(other, 'different bytes')
  const expected = { bridge, gson, profile, fixtureClasses }, proof = { schemaVersion: 1, loaderParentPlatform: true, loaderDistinct: true,
    bridgeCodeSource: encodePath(bridge), bridgeSHA256: hash(bridge), gsonCodeSource: encodePath(gson), gsonSHA256: hash(gson), fixtureCodeSource: encodePath(fixtureClasses), profile: encodePath(profile) }
  const output = value => 'FIXTURE_LOADING_PROOF ' + JSON.stringify(value) + '\nFIXTURE_READY\n'
  try {
    assert.deepEqual(verifyLoadingProof(output(proof), expected), proof)
    for (const changed of [{ bridgeCodeSource: encodePath(other) }, { gsonCodeSource: encodePath(other) }, { profile: encodePath(root) },
      { fixtureCodeSource: encodePath(root) }, { bridgeSHA256: '0'.repeat(64) }, { gsonSHA256: '0'.repeat(64) }, { loaderParentPlatform: false }, { loaderDistinct: false }]) {
      assert.throws(() => verifyLoadingProof(output({ ...proof, ...changed }), expected))
    }
    assert.throws(() => verifyLoadingProof(output(proof) + output(proof), expected), /Exactly one/)
    assert.throws(() => verifyLoadingProof('FIXTURE_READY\n', expected), /Exactly one/)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
