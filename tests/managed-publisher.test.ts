import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash, createPublicKey, constants, verify } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { discoverManagedServer, verifySignedManifest } from '../src/main/core/managedServerProtocol'

const require = createRequire(import.meta.url)
const publisher = require('../publisher/managed-publisher.cjs') as {
  initConfig(configPath: string): Promise<{ config: string; privateKeyCreated: boolean }>
  publish(configPath: string, options?: { beforeCommit?: () => Promise<void> }): Promise<{ changed: boolean; files: number; newObjects: number; fingerprint: string }>
  validateConfig(config: Record<string, any>, configPath: string): Record<string, any>
  normalizeManagedPath(value: string): string
  checkCasePath(value: string, identities: Map<string, { spelling: string; leaf: boolean }>, leaf?: boolean): void
  glob(pattern: string): RegExp
  address(value: string): string
  windowsPrivateAcl(filename: string, initialize?: boolean, isDirectory?: boolean, runner?: (...args: any[]) => any): void
}
const sha256 = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')

test('managed publisher: Windows ACL commands use fixed encoded scripts, protect inheritance and keep paths out of command text', () => {
  const filename = 'C:/private/Unicode 中文; not code/key.pem', calls: any[] = []
  const runner = (...args: any[]) => { calls.push(args); return { status: 0 } }
  publisher.windowsPrivateAcl(filename, true, true, runner)
  publisher.windowsPrivateAcl(filename, true, false, runner)
  publisher.windowsPrivateAcl(filename, false, false, runner)
  for (const [command, args, options] of calls) {
    assert.match(command, /^[A-Za-z]:[\\/].*[\\/]System32[\\/]WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/i)
    assert.equal(args[3], '-EncodedCommand')
    const script = Buffer.from(args[4], 'base64').toString('utf16le')
    assert(!script.includes(filename)); assert.equal(options.env.KAMUCL_PRIVATE_KEY_CHECK, filename)
    assert.match(script, /\[System\.IO\.(?:File|Directory)\]::GetAccessControl\(\$env:KAMUCL_PRIVATE_KEY_CHECK\)/)
    assert.match(script, /GetAccessRules\(\$true,\$true,\[System\.Security\.Principal\.SecurityIdentifier\]\)/)
    assert.match(script, /\$PSModuleAutoLoadingPreference='None'/)
    assert.match(script, /PSEdition -ne 'Desktop'/)
    assert.match(script, /PSVersion\.Major -ne 5/)
    assert(!/\b(?:Get-Acl|Set-Acl|Where-Object|Import-Module)\b/.test(script))
    assert.match(script, /Untrusted principal/)
    assert.equal(options.timeout, 10000); assert.equal(options.maxBuffer, 64 * 1024)
  }
  const directoryScript = Buffer.from(calls[0][1][4], 'base64').toString('utf16le')
  assert.match(directoryScript, /DirectorySecurity\]::new/)
  assert.match(directoryScript, /SetAccessRuleProtection\(\$true,\$false\)/)
  assert.match(directoryScript, /ContainerInherit,ObjectInherit/)
  assert.match(directoryScript, /\[System\.IO\.Directory\]::SetAccessControl\(\$env:KAMUCL_PRIVATE_KEY_CHECK,\$taskAcl\)/)
  assert.match(directoryScript, /AreAccessRulesProtected/)
  const fileScript = Buffer.from(calls[1][1][4], 'base64').toString('utf16le')
  assert.match(fileScript, /\[System\.IO\.File\]::SetAccessControl\(\$env:KAMUCL_PRIVATE_KEY_CHECK,\$taskAcl\)/)
  const inspectScript = Buffer.from(calls[2][1][4], 'base64').toString('utf16le')
  assert(!inspectScript.includes('::SetAccessControl('), 'inspection must never rewrite existing ACLs')
  assert.match(inspectScript, /Private ACL has no trusted allowed principal/)
  assert.throws(() => publisher.windowsPrivateAcl(filename, true, false, () => ({ status: 1, stderr: filename + '\n denied' })), error => {
    assert.match(String(error), /Unable to create private Windows ACL/); assert(!String(error).includes(filename)); return true
  })
  assert.throws(() => publisher.windowsPrivateAcl(filename, false, false, () => ({ status: 1, stderr: 'denied' })), /Signing key ACL must allow only/)
  assert.throws(() => publisher.windowsPrivateAcl(filename, false, false, () => ({ status: null, error: new Error('spawn failed') })), /Signing key ACL must allow only/)
})

test('managed publisher: native Windows ACLs ignore poisoned parent PSModulePath and reject an Everyone allow ACE', { skip: process.platform !== 'win32' }, async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'kamucl-native-acl-')))
  const privateDirectory = path.join(root, 'private 中文 [literal]')
  const filename = path.join(privateDirectory, 'placeholder [key].txt')
  let command = '', environment: NodeJS.ProcessEnv = {}
  const runner = (executable: string, args: string[], options: any) => {
    command = executable
    environment = { ...options.env, PSModulePath: path.join(root, 'missing-incompatible-parent-modules') }
    return spawnSync(executable, args, { ...options, env: environment })
  }
  try {
    await fs.mkdir(privateDirectory)
    publisher.windowsPrivateAcl(privateDirectory, true, true, runner)
    // This placeholder is created only after its parent ACL is protected.
    await fs.writeFile(filename, 'synthetic placeholder, not a key')
    publisher.windowsPrivateAcl(filename, true, false, runner)
    publisher.windowsPrivateAcl(filename, false, false, runner)
    const script = "$ErrorActionPreference='Stop'; $PSModuleAutoLoadingPreference='None'; $taskAcl=[System.IO.File]::GetAccessControl($env:KAMUCL_PRIVATE_KEY_CHECK); $taskIdentity=[System.Security.Principal.SecurityIdentifier]::new('S-1-1-0'); $taskRule=[System.Security.AccessControl.FileSystemAccessRule]::new($taskIdentity,[System.Security.AccessControl.FileSystemRights]::Read,[System.Security.AccessControl.AccessControlType]::Allow); $taskAcl.AddAccessRule($taskRule); [System.IO.File]::SetAccessControl($env:KAMUCL_PRIVATE_KEY_CHECK,$taskAcl)"
    const broadened = spawnSync(command, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
      windowsHide: true, timeout: 10000, maxBuffer: 64 * 1024, env: { ...environment, KAMUCL_PRIVATE_KEY_CHECK: filename }, encoding: 'utf8'
    })
    assert.equal(broadened.status, 0, broadened.error?.message || broadened.stderr)
    assert.throws(() => publisher.windowsPrivateAcl(filename, false, false, runner), /Signing key ACL must allow only.*Untrusted principal/)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'kamucl-publisher-test-')))
  const configPath = path.join(root, 'config.json')
  await publisher.initConfig(configPath)
  const config = JSON.parse(await fs.readFile(configPath, 'utf8')) as Record<string, any>
  Object.assign(config, { clientPrepared: true, packVersion: '0.3.0', minecraft: '1.20.1', loader: { type: 'forge', version: '47.4.12' } })
  await fs.writeFile(configPath, JSON.stringify(config), { mode: 0o600 })
  const clientRoot = path.join(root, 'client-ready'), outputRoot = path.join(root, 'public')
  await fs.mkdir(path.join(clientRoot, 'mods'), { recursive: true })
  return {
    root, configPath, config, clientRoot, outputRoot,
    keyFile: path.join(root, 'private', 'managed-signing-key.pem'),
    write: async (relative: string, bytes: string | Buffer) => {
      const filename = path.join(clientRoot, relative)
      await fs.mkdir(path.dirname(filename), { recursive: true })
      await fs.writeFile(filename, bytes)
    },
    save: async () => { await fs.writeFile(configPath, JSON.stringify(config), { mode: 0o600 }) },
    envelope: async (relative = 'manifest.json') => JSON.parse(await fs.readFile(path.join(outputRoot, relative), 'utf8')),
    cleanup: async () => { await fs.rm(root, { recursive: true, force: true }) }
  }
}
function payload(envelope: Record<string, any>) {
  const bytes = Buffer.from(envelope.payload, 'base64')
  assert.equal(verify('RSA-SHA256', bytes, { key: createPublicKey(envelope.publicKey), padding: constants.RSA_PKCS1_PADDING }, Buffer.from(envelope.signature, 'base64')), true)
  return JSON.parse(bytes.toString()) as Record<string, any>
}
function objectPath(outputRoot: string, digest: string) { return path.join(outputRoot, 'objects', digest.slice(0, 2), digest) }

test('managed publisher: init generates a private 3072-bit signer and never overwrites config or key', async () => {
  const item = await fixture()
  try {
    const keyHash = sha256(await fs.readFile(item.keyFile))
    const publicKey = createPublicKey(await fs.readFile(item.keyFile))
    assert.equal(publicKey.asymmetricKeyDetails?.modulusLength, 3072)
    if (process.platform !== 'win32') {
      assert.equal((await fs.stat(item.keyFile)).mode & 0o777, 0o600)
      assert.equal((await fs.stat(path.dirname(item.keyFile))).mode & 0o777, 0o700)
    }
    await assert.rejects(publisher.initConfig(item.configPath), /never overwrites/)
    await fs.unlink(item.configPath)
    await assert.rejects(publisher.initConfig(item.configPath), /never overwrites/)
    assert.equal(sha256(await fs.readFile(item.keyFile)), keyHash)
  } finally { await item.cleanup() }
})

test('managed publisher: exact hashes, readable immutable objects and generic/legacy signed discoveries are compatible', async () => {
  const item = await fixture()
  try {
    await item.write('mods/example.jar', 'JAR!')
    await item.write('config/public.json', '{"enabled":true}')
    const result = await publisher.publish(item.configPath), document = await item.envelope(), manifest = payload(document)
    assert.equal(result.changed, true); assert.equal(result.files, 2); assert.equal(result.newObjects, 2)
    const file = manifest.files.find((entry: any) => entry.path === 'mods/example.jar')
    assert.equal(file.sha256, sha256('JAR!')); assert.equal(file.size, 4)
    assert.equal(file.url, 'https://mc.example.com/managed/objects/' + file.sha256.slice(0, 2) + '/' + file.sha256)
    assert.equal(await fs.readFile(objectPath(item.outputRoot, file.sha256), 'utf8'), 'JAR!')
    const generic = payload(await item.envelope('.well-known/kamucl-managed.json'))
    const legacy = payload(await item.envelope('.well-known/pcl-managed.json'))
    assert.equal(generic.kind, 'kamucl-managed-server'); assert.equal(legacy.kind, 'pcl-managed-server')
    assert.equal(generic.serverAddress, 'mc.example.com:25565')
    const verified = verifySignedManifest(JSON.stringify(document), generic.manifestUrl, document.publicKey)
    assert.equal(verified.loader.version, '47.4.12')
    const discovered = await discoverManagedServer('mc.example.com', async url => {
      if (new URL(url).port === '4443') throw new Error('not served on this port')
      return Buffer.from(JSON.stringify(await item.envelope(url.includes('/.well-known/') ? '.well-known/kamucl-managed.json' : 'manifest.json')))
    }, undefined, { trustedPublicKey: document.publicKey })
    assert.equal(discovered.trusted, true); assert.equal(discovered.keyFingerprint, result.fingerprint)
    const objectStat = await fs.stat(objectPath(item.outputRoot, file.sha256))
    const unchanged = await publisher.publish(item.configPath)
    assert.equal(unchanged.changed, false); assert.equal(unchanged.newObjects, 0)
    assert.equal((await fs.stat(objectPath(item.outputRoot, file.sha256))).mtimeMs, objectStat.mtimeMs)
    if (process.platform !== 'win32') {
      for (const relative of ['', 'objects', path.join('objects', file.sha256.slice(0, 2)), '.well-known']) assert.equal((await fs.stat(path.join(item.outputRoot, relative))).mode & 0o777, 0o755)
      assert.equal(objectStat.mode & 0o777, 0o644)
      assert.equal((await fs.stat(item.root)).mode & 0o777, 0o700)
    }
  } finally { await item.cleanup() }
})

test('managed publisher: a same-name same-size patched JAR gets a new digest, with the old immutable object retained', async () => {
  const item = await fixture()
  try {
    await item.write('mods/example.jar', 'OLD!')
    await publisher.publish(item.configPath)
    const oldManifest = payload(await item.envelope()), oldHash = oldManifest.files[0].sha256
    await item.write('mods/example.jar', 'NEW!')
    const next = await publisher.publish(item.configPath), newManifest = payload(await item.envelope())
    assert.equal(next.changed, true); assert.equal(next.newObjects, 1)
    assert.equal(newManifest.files[0].sha256, sha256('NEW!'))
    assert.notEqual(newManifest.files[0].sha256, oldHash)
    assert.equal(await fs.readFile(objectPath(item.outputRoot, oldHash), 'utf8'), 'OLD!')
  } finally { await item.cleanup() }
})

test('managed publisher: URL configuration changes republish, and missing or tampered discovery aliases are repaired without object rewrites', async () => {
  const item = await fixture()
  try {
    await item.write('mods/example.jar', 'data')
    await publisher.publish(item.configPath)
    const first = payload(await item.envelope()), objectStat = await fs.stat(objectPath(item.outputRoot, first.files[0].sha256))
    item.config.publicBaseUrl = 'https://mc.example.com:4443/new-prefix/'
    await item.save()
    const moved = await publisher.publish(item.configPath), document = await item.envelope(), manifest = payload(document)
    assert.equal(moved.changed, true); assert.equal(moved.newObjects, 0)
    assert.match(manifest.files[0].url, /^https:\/\/mc\.example\.com:4443\/new-prefix\/objects\//)
    assert.equal(payload(await item.envelope('.well-known/kamucl-managed.json')).manifestUrl, 'https://mc.example.com:4443/new-prefix/manifest.json')
    const manifestBytes = await fs.readFile(path.join(item.outputRoot, 'manifest.json'))
    await fs.unlink(path.join(item.outputRoot, '.well-known', 'kamucl-managed.json'))
    await fs.writeFile(path.join(item.outputRoot, '.well-known', 'pcl-managed.json'), '{}')
    const repaired = await publisher.publish(item.configPath)
    assert.equal(repaired.changed, true); assert.equal(repaired.newObjects, 0)
    assert.deepEqual(await fs.readFile(path.join(item.outputRoot, 'manifest.json')), manifestBytes)
    assert.equal(payload(await item.envelope('.well-known/kamucl-managed.json')).kind, 'kamucl-managed-server')
    assert.equal(payload(await item.envelope('.well-known/pcl-managed.json')).kind, 'pcl-managed-server')
    assert.equal((await fs.stat(objectPath(item.outputRoot, first.files[0].sha256))).mtimeMs, objectStat.mtimeMs)
    assert.equal((await publisher.publish(item.configPath)).changed, false)
  } finally { await item.cleanup() }
})

test('managed publisher: interrupted publish preserves old metadata; stale or competing locks require explicit operator repair', async () => {
  const item = await fixture()
  try {
    await item.write('mods/example.jar', 'old')
    await publisher.publish(item.configPath)
    const previous = await fs.readFile(path.join(item.outputRoot, 'manifest.json'))
    await item.write('mods/example.jar', 'new')
    await assert.rejects(publisher.publish(item.configPath, { beforeCommit: async () => { throw new Error('simulated interruption') } }), /simulated interruption/)
    assert.deepEqual(await fs.readFile(path.join(item.outputRoot, 'manifest.json')), previous)
    const lock = path.join(item.outputRoot, '.managed-publisher.lock')
    await assert.rejects(fs.stat(lock), { code: 'ENOENT' })
    await fs.writeFile(lock, '{"pid":99999999,"token":"stale"}', { mode: 0o600 })
    await assert.rejects(publisher.publish(item.configPath), /Publisher lock exists/)
    assert.deepEqual(await fs.readFile(path.join(item.outputRoot, 'manifest.json')), previous)
  } finally { await item.cleanup() }
})

test('managed publisher: a failure after manifest replacement rolls back previously replaced metadata', async () => {
  const item = await fixture()
  try {
    await item.write('mods/example.jar', 'old')
    await publisher.publish(item.configPath)
    const manifestPath = path.join(item.outputRoot, 'manifest.json')
    const payloadPath = path.join(item.outputRoot, 'manifest.payload.json')
    const previousManifest = await fs.readFile(manifestPath), previousPayload = await fs.readFile(payloadPath)
    await item.write('mods/example.jar', 'new')
    await assert.rejects(publisher.publish(item.configPath, { beforeCommit: async () => {
      const destination = path.join(item.outputRoot, '.well-known', 'kamucl-managed.json')
      await fs.unlink(destination)
      await fs.mkdir(destination)
    } }), /Unsafe publish destination/)
    assert.deepEqual(await fs.readFile(manifestPath), previousManifest)
    assert.deepEqual(await fs.readFile(payloadPath), previousPayload)
  } finally { await item.cleanup() }
})

test('managed publisher: private paths, raw-server sources, symlinks and corrupted content-addressed objects fail closed', async () => {
  const item = await fixture()
  try {
    await item.write('config/credentials.json', 'private')
    await assert.rejects(publisher.publish(item.configPath), /Private credential/)
    await fs.unlink(path.join(item.clientRoot, 'config', 'credentials.json'))
    await fs.writeFile(path.join(item.clientRoot, 'server.properties'), 'private')
    await assert.rejects(publisher.publish(item.configPath), /raw server/)
    await fs.unlink(path.join(item.clientRoot, 'server.properties'))
    await item.write('mods/example.jar', 'data')
    if (process.platform !== 'win32') {
      await fs.symlink(path.join(item.clientRoot, 'mods', 'example.jar'), path.join(item.clientRoot, 'mods', 'linked.jar'))
      await assert.rejects(publisher.publish(item.configPath), /Linked/)
      await fs.unlink(path.join(item.clientRoot, 'mods', 'linked.jar'))
    }
    await publisher.publish(item.configPath)
    const manifest = payload(await item.envelope())
    await fs.writeFile(objectPath(item.outputRoot, manifest.files[0].sha256), 'evil')
    await assert.rejects(publisher.publish(item.configPath), /corrupt/)
    for (const relative of ['mods/../a.jar', 'mods/a.jar:stream', 'mods/CON.jar', 'config/private.key', 'config/secrets/data.json', 'config/touhou_little_maid/sites/ai.json', 'saves/level.dat']) assert.throws(() => publisher.normalizeManagedPath(relative), undefined, relative)
  } finally { await item.cleanup() }
})

test('managed publisher: private exclusions are skipped before reading, root allowlists and key/config isolation cannot be bypassed', async () => {
  const item = await fixture()
  try {
    await item.write('mods/example.jar', 'data')
    await item.write('config/touhou_little_maid/sites/ai.json', '{"secret":"never-published"}')
    await item.write('config/netmusic-spotify-audio-bridge.properties', 'secret=never-published')
    await publisher.publish(item.configPath)
    assert.deepEqual(payload(await item.envelope()).files.map((entry: any) => entry.path), ['mods/example.jar'])
    assert.equal(publisher.glob('**/*.key').test('signing.key'), true)
    assert.equal(publisher.glob('config/**/test?.json').test('config/test1.json'), true)
    assert.equal(publisher.glob('config/**/test?.json').test('config/nested/test1.json'), true)
    assert.throws(() => publisher.glob('../mods/**'))
    assert.throws(() => publisher.validateConfig({ ...item.config, allowRoots: ['saves'] }, item.configPath), /allowRoots/)
    assert.throws(() => publisher.validateConfig({ ...item.config, privateKey: './client-ready/mods/innocent.jar' }, item.configPath), /separate/)
    assert.throws(() => publisher.validateConfig({ ...item.config, clientRoot: '.' }, item.configPath), /separate/)
    assert.throws(() => publisher.validateConfig({ ...item.config, outputRoot: '.' }, item.configPath), /separate/)
  } finally { await item.cleanup() }
})

test('managed publisher: an innocently named hard-link alias of the private signing key or config is never published', async () => {
  if (process.platform === 'win32') return
  const item = await fixture()
  try {
    const destination = path.join(item.clientRoot, 'mods', 'innocent.jar')
    for (const source of [item.keyFile, item.configPath]) {
      await fs.link(source, destination)
      await assert.rejects(publisher.publish(item.configPath), /hard-link alias/)
      await fs.unlink(destination)
    }
  } finally { await item.cleanup() }
})

test('managed publisher: admin identity, exact versions, same-host HTTPS and private signing-key permissions are required', async () => {
  const item = await fixture()
  try {
    for (const patch of [
      { clientPrepared: false }, { packId: 'dotted.pack' }, { packId: '_leading' },
      { minecraft: 'latest' }, { loader: { type: 'forge', version: 'recommended' } },
      { publicBaseUrl: 'http://mc.example.com/managed/' },
      { publicBaseUrl: 'https://another.example.com/managed/' },
      { publicBaseUrl: 'https://mc.example.com:4444/managed/' },
      { serverAddress: 'mc.example.com:65536' }
    ]) assert.throws(() => publisher.validateConfig({ ...item.config, ...patch }, item.configPath))
    assert.equal(publisher.validateConfig({ ...item.config, packId: 'My_SERVER-1' }, item.configPath).packId, 'My_SERVER-1')
    assert.equal(publisher.address('[2001:0DB8::1]:25566'), '[2001:db8::1]:25566')
    if (process.platform !== 'win32') {
      await fs.chmod(item.keyFile, 0o644)
      await assert.rejects(publisher.publish(item.configPath), /private regular/)
    }
  } finally { await item.cleanup() }
})

test('managed publisher: sparse oversized files and active-file removal collisions are rejected without buffering the input', async () => {
  const item = await fixture()
  try {
    const oversized = path.join(item.clientRoot, 'mods', 'oversized.jar'), handle = await fs.open(oversized, 'w')
    try { await handle.truncate(512 * 1024 * 1024 + 1) } finally { await handle.close() }
    await assert.rejects(publisher.publish(item.configPath), /oversized/)
    await fs.unlink(oversized)
    await item.write('mods/example.jar', 'data')
    item.config.removeFiles = [{ path: 'mods/example.jar', sha256: sha256('data') }]
    await item.save()
    await assert.rejects(publisher.publish(item.configPath), /removal-conflicting/)
  } finally { await item.cleanup() }
})

test('managed publisher: case-conflicting parent directory prefixes are refused before Windows-unsafe distribution', async () => {
  const identities = new Map<string, { spelling: string; leaf: boolean }>()
  publisher.checkCasePath('config/Foo/a.json', identities)
  publisher.checkCasePath('config/Foo/b.json', identities)
  assert.throws(() => publisher.checkCasePath('config/foo/c.json', identities), /Case-conflicting/)
  assert.throws(() => publisher.checkCasePath('config/Foo/A.json', identities), /Case-conflicting/)
  const item = await fixture()
  try {
    assert.throws(() => publisher.validateConfig({ ...item.config, removeFiles: [
      { path: 'config/Foo/old.json', sha256: sha256('old') },
      { path: 'config/foo/other.json', sha256: sha256('other') }
    ] }, item.configPath), /Case-conflicting/)
    await item.write('config/Foo/a.json', 'first')
    await item.write('config/foo/b.json', 'second')
    const first = await fs.stat(path.join(item.clientRoot, 'config', 'Foo'))
    const second = await fs.stat(path.join(item.clientRoot, 'config', 'foo'))
    if (first.ino !== second.ino) await assert.rejects(publisher.publish(item.configPath), /Case-conflicting/)
  } finally { await item.cleanup() }
})

test('managed publisher: removed-file and active-file directory prefixes cannot conflict in either direction', async () => {
  const item = await fixture()
  try {
    await item.write('config/foo/a.json', 'active')
    item.config.removeFiles = [{ path: 'config/foo', sha256: sha256('old-leaf') }]
    await item.save()
    await assert.rejects(publisher.publish(item.configPath), /File\/directory-conflicting/)
    await assert.rejects(fs.stat(path.join(item.outputRoot, 'manifest.json')), { code: 'ENOENT' })
    await fs.unlink(path.join(item.clientRoot, 'config', 'foo', 'a.json'))
    await fs.rmdir(path.join(item.clientRoot, 'config', 'foo'))
    await item.write('config/foo', 'active-leaf')
    item.config.removeFiles = [{ path: 'config/foo/a.json', sha256: sha256('old-nested') }]
    await item.save()
    await assert.rejects(publisher.publish(item.configPath), /File\/directory-conflicting/)
    await assert.rejects(fs.stat(path.join(item.outputRoot, 'manifest.json')), { code: 'ENOENT' })
  } finally { await item.cleanup() }
})
