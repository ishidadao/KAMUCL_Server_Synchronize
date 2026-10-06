import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, createPublicKey, generateKeyPairSync, sign } from 'node:crypto'
import { discoverManagedServer, MANAGED_KEY_FINGERPRINT, managedPublicKeyInfo, normalizeMinecraftAddress, normalizeManagedPath, validateManagedManifest, verifySignedEnvelope, verifySignedManifest } from '../src/main/core/managedServerProtocol'

const keys = generateKeyPairSync('rsa', { modulusLength: 2048 })
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const base = 'https://example.invalid:4443/fool/manifest.json'
const payload = () => ({ schema: 1, packId: 'the-fool', packVersion: '0.3.0', contentRevision: '20261006010534', minecraft: '1.20.1', loader: { type: 'forge', version: '47.4.12' }, serverAddress: 'Example.Invalid:25565', files: [{ path: 'mods/example.jar', size: 4, sha256: hash('data'), url: 'objects/aa/content' }], removeFiles: [] })
const envelope = (value: unknown, pair = keys, includeKey = false) => {
  const bytes = Buffer.from(JSON.stringify(value))
  return Buffer.from(JSON.stringify({ schema: 1, ...(includeKey ? { publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString() } : {}), payload: bytes.toString('base64'), signature: sign('RSA-SHA256', bytes, pair.privateKey).toString('base64') }))
}

test('managed protocol: signed exact payload bytes and SHA-256 are verified, active pin matches production public key', () => {
  const document = verifySignedManifest(envelope(payload()), base, publicKey)
  assert.equal(document.files[0].url, 'https://example.invalid:4443/fool/objects/aa/content')
  assert.equal(document.serverAddress, 'example.invalid:25565')
  assert.equal(document.loader.version, '47.4.12')
  assert.equal(MANAGED_KEY_FINGERPRINT, '5ca1237d24c64ad4f2a1640e9d9be18b2cae6db4abc5ed9bb5805fd27e86df40')
  assert.throws(() => verifySignedManifest(envelope(payload()), base), /签名/)
  const damaged = JSON.parse(envelope(payload()).toString())
  damaged.payload = Buffer.from(JSON.stringify({ ...payload(), minecraft: '1.21' })).toString('base64')
  assert.throws(() => verifySignedManifest(JSON.stringify(damaged), base, publicKey), /签名/)
  damaged.signature = 'AAAA'
  assert.throws(() => verifySignedManifest(JSON.stringify(damaged), base, publicKey), /签名/)
})

test('managed protocol: version identity, loader, sizes and both files/removal collisions fail closed', () => {
  for (const patch of [{ schema: 2 }, { packId: 'invalid/pack' }, { packId: 'x'.repeat(65) }, { minecraft: '../1.20' }, { loader: { type: 'custom', version: '1' } }, { files: undefined }]) assert.throws(() => validateManagedManifest({ ...payload(), ...patch }, base))
  const file = payload().files[0]
  for (const patch of [{ size: -1 }, { size: 1.5 }, { size: 1024 ** 3 }, { sha256: 'name-only' }, { url: 'http://example.invalid/mod.jar' }, { url: 'https://elsewhere.invalid/mod.jar' }, { url: 'https://example.invalid/mod.jar' }, { url: 'https://user:password@example.invalid:4443/mod.jar' }]) assert.throws(() => validateManagedManifest({ ...payload(), files: [{ ...file, ...patch }] }, base))
  assert.throws(() => validateManagedManifest({ ...payload(), files: [file, { ...file, path: 'mods/EXAMPLE.jar' }] }, base), /重复|冲突/)
  assert.throws(() => validateManagedManifest({ ...payload(), removeFiles: [{ path: file.path, sha256: file.sha256 }] }, base), /冲突/)
})

test('managed protocol: traversal, private server settings and Windows ambiguous/device paths are forbidden', () => {
  for (const relative of ['/mods/a.jar', '../mods/a.jar', 'mods/../a.jar', 'mods//a.jar', 'mods/./a.jar', 'mods/a.jar:stream', 'mods/con.jar', 'mods/LPT9.jar', 'mods/COM¹.txt', 'mods/CONOUT$.txt', 'mods/trailing./a.jar', 'mods/trailing /a.jar', 'saves/level.dat', 'options.txt', 'config/touhou_little_maid/sites/llm.json', 'config/netmusic-spotify-audio-bridge.properties']) assert.throws(() => normalizeManagedPath(relative), undefined, relative)
  assert.equal(normalizeManagedPath('mods\\valid.jar'), 'mods/valid.jar')
  assert.equal(normalizeManagedPath('config/个人设置.json'), 'config/个人设置.json')
})

test('managed protocol: case-aliased parents and file/directory prefixes fail before synchronization', () => {
  const file = payload().files[0], files = (...paths: string[]) => paths.map(path => ({ ...file, path }))
  for (const paths of [
    ['config/Foo/a.json', 'config/foo/b.json'],
    ['kubejs/server_scripts/A/first.js', 'kubejs/server_scripts/a/second.js'],
    ['config/entry', 'config/entry/nested.json'],
    ['config/entry/nested.json', 'config/entry']
  ]) assert.throws(() => validateManagedManifest({ ...payload(), files: files(...paths) }, base), /冲突/)
  for (const [download, removed] of [
    ['config/shared/new.json', 'config/Shared/old.json'],
    ['config/shared/new.json', 'config/shared'],
    ['config/shared', 'config/shared/old.json']
  ]) assert.throws(() => validateManagedManifest({ ...payload(), files: files(download), removeFiles: [{ path: removed, sha256: file.sha256 }] }, base), /冲突/)
  assert.throws(() => validateManagedManifest({ ...payload(), files: [], removeFiles: [{ path: 'config/Old/a.json', sha256: file.sha256 }, { path: 'config/old/b.json', sha256: file.sha256 }] }, base), /冲突/)
  const valid = validateManagedManifest({ ...payload(), files: files('mods/new-name.jar', 'config/shared/new.json', 'config/shared/another.json'), removeFiles: [{ path: 'mods/old-name.jar', sha256: file.sha256 }, { path: 'config/shared/old.json', sha256: file.sha256 }] }, base)
  assert.equal(valid.files.length, 3); assert.equal(valid.removeFiles.length, 2)
})

test('managed protocol: strict address parsing and canonical IPv6/host/default port', () => {
  assert.equal(normalizeMinecraftAddress('MC.Example.COM.'), 'mc.example.com:25565')
  assert.equal(normalizeMinecraftAddress('[2001:0DB8:0:0::1]:25566'), '[2001:db8::1]:25566')
  assert.equal(normalizeMinecraftAddress('::1'), '[::1]:25565')
  assert.equal(normalizeMinecraftAddress('minecraft://127.0.0.1:25566'), '127.0.0.1:25566')
  for (const address of ['', 'https://example.com', 'example.com/a', 'user@example.com', 'example.com:0', 'example.com:65536', 'example.com:', 'example.com:abc', '[example.com]:25565', '192.168.1.999', 'bad host', 'evil\\host']) assert.throws(() => normalizeMinecraftAddress(address), undefined, address)
})

test('managed protocol: network fallback is HTTPS only, successful invalid response never downgrades', async () => {
  const calls: string[] = []
  await assert.rejects(discoverManagedServer('example.invalid:25566', async url => { calls.push(url); if (calls.length === 1) throw new Error('offline'); return Buffer.from('{}') }))
  assert.deepEqual(calls, ['https://example.invalid:4443/.well-known/kamucl-managed.json', 'https://example.invalid:4443/.well-known/pcl-managed.json'])
  calls.length = 0
  await assert.rejects(discoverManagedServer('example.invalid', async url => { calls.push(url); return envelope(payload()) }), /签名/)
  assert.equal(calls.length, 1)
  const controller = new AbortController(); controller.abort()
  await assert.rejects(discoverManagedServer('example.invalid', async () => { throw new Error('must not fetch') }, controller.signal))
})

test('managed protocol: malformed UTF-8/base64 and oversized documents are rejected before application', () => {
  assert.throws(() => verifySignedEnvelope(Buffer.from([0xff]), publicKey))
  assert.throws(() => verifySignedEnvelope(JSON.stringify({ schema: 1, payload: 'YWJj==', signature: 'AAAA' }), publicKey), /Base64/)
  assert.throws(() => verifySignedEnvelope(Buffer.alloc(17 * 1024 * 1024), publicKey), /大小/)
})

function genericDocuments(packId = 'community-pack', pair = keys, includeKey = true) {
  const manifest = { ...payload(), packId }
  const discovery = { schema: 1, kind: 'kamucl-managed-server', packId, manifestUrl: base, serverAddress: manifest.serverAddress }
  const calls: string[] = []
  const fetch = async (url: string) => { calls.push(url); return url.includes('/.well-known/') ? envelope(discovery, pair, includeKey) : envelope(manifest, pair, includeKey) }
  return { manifest, discovery, calls, fetch }
}

test('generic managed protocol: unknown key is preview-only, confirmed pin permits multiple pack identities', async () => {
  const first = genericDocuments('community-one')
  await assert.rejects(discoverManagedServer('example.invalid', first.fetch), /公钥尚未确认/)
  assert.equal(first.calls.length, 1)
  const preview = await discoverManagedServer('example.invalid', first.fetch, undefined, { allowUntrustedPreview: true })
  assert.equal(preview.trusted, false); assert.equal(preview.manifest.packId, 'community-one')
  assert.equal(preview.publicKey, publicKey); assert.equal(preview.keyFingerprint, managedPublicKeyInfo(publicKey).keyFingerprint)
  const pinned = await discoverManagedServer('example.invalid', first.fetch, undefined, { trustedPublicKey: preview.publicKey })
  assert.equal(pinned.trusted, true)
  const other = genericDocuments('community-two')
  const second = await discoverManagedServer('example.invalid', other.fetch, undefined, { trustedPublicKey: preview.publicKey })
  assert.equal(second.manifest.packId, 'community-two'); assert.equal(second.trusted, true)
})

test('generic managed protocol: changed key and discovery/manifest identities or keys never downgrade to another endpoint', async () => {
  const replacement = generateKeyPairSync('rsa', { modulusLength: 2048 }), changed = genericDocuments('community-one', replacement)
  await assert.rejects(discoverManagedServer('example.invalid', changed.fetch, undefined, { trustedPublicKey: publicKey, allowUntrustedPreview: true }), /公钥发生变化/)
  assert.equal(changed.calls.length, 1)
  const first = genericDocuments('community-one'), calls: string[] = []
  await assert.rejects(discoverManagedServer('example.invalid', async url => { calls.push(url); return url.includes('/.well-known/') ? envelope(first.discovery, keys, true) : envelope({ ...first.manifest, packId: 'community-two' }, keys, true) }, undefined, { trustedPublicKey: publicKey }), /整合包身份不一致/)
  assert.equal(calls.length, 2)
  await assert.rejects(discoverManagedServer('example.invalid', async url => url.includes('/.well-known/') ? envelope(first.discovery, keys, true) : envelope(first.manifest, replacement, true), undefined, { trustedPublicKey: publicKey }), /公钥.*不一致/)
  const missingKey = genericDocuments('community-one', keys, false)
  await assert.rejects(discoverManagedServer('example.invalid', missingKey.fetch, undefined, { allowUntrustedPreview: true }), /签名/)
  assert.equal(missingKey.calls.length, 1)
})

test('generic managed protocol: legacy envelopes remain compatible with explicit pins and bounded discovery probes', async () => {
  const documents = genericDocuments('legacy-custom', keys, false), calls: string[] = []
  const legacy = { ...documents.discovery, kind: 'pcl-managed-server' }
  const result = await discoverManagedServer('example.invalid', async (url, options) => {
    calls.push(url)
    if (url.includes('/.well-known/')) { assert(options.signal); assert.equal(options.signal.aborted, false) }
    if (url.endsWith('kamucl-managed.json')) throw new Error('HTTP 404')
    return url.includes('/.well-known/') ? envelope(legacy) : envelope(documents.manifest)
  }, undefined, { trustedPublicKey: publicKey })
  assert.equal(result.trusted, true); assert.equal(result.manifest.packId, 'legacy-custom')
  assert.deepEqual(calls.slice(0, 2), ['https://example.invalid:4443/.well-known/kamucl-managed.json', 'https://example.invalid:4443/.well-known/pcl-managed.json'])
  const missing: string[] = []
  await assert.rejects(discoverManagedServer('example.invalid', async url => { missing.push(url); throw new Error('offline') }))
  assert.deepEqual(missing, ['https://example.invalid:4443/.well-known/kamucl-managed.json', 'https://example.invalid:4443/.well-known/pcl-managed.json', 'https://example.invalid/.well-known/kamucl-managed.json', 'https://example.invalid/.well-known/pcl-managed.json'])
})

test('generic managed protocol: private/oversized/weak/non-RSA public keys are rejected', () => {
  const weak = generateKeyPairSync('rsa', { modulusLength: 1024 }), ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  for (const value of [keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), weak.publicKey.export({ type: 'spki', format: 'pem' }).toString(), ec.publicKey.export({ type: 'spki', format: 'pem' }).toString(), 'x'.repeat(17000)]) assert.throws(() => managedPublicKeyInfo(value))
  const oversized = createPublicKey({ key: { kty: 'RSA', n: Buffer.alloc(1281, 0xff).toString('base64url'), e: 'AQAB' }, format: 'jwk' })
  assert.throws(() => managedPublicKeyInfo(oversized.export({ type: 'spki', format: 'pem' }).toString()), /8192/)
})
