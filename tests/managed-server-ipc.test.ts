import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { EventEmitter } from 'node:events'
import { createHash, createPublicKey, generateKeyPairSync } from 'node:crypto'
import { createRequire } from 'node:module'
import { build } from 'esbuild'
import { IPC, IPC_EVENT } from '../src/shared/types'
import type { DiscoveredManagedServer, ManagedDiscoveryOptions } from '../src/main/core/managedServerProtocol'

const req = createRequire(import.meta.url)
const key = () => generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' }).toString()
const publicKey = key(), replacementKey = key()
const fingerprint = (value: string) => createHash('sha256').update(createPublicKey(value).export({ type: 'spki', format: 'der' })).digest('hex')

function document(): DiscoveredManagedServer {
  return {
    address: 'updates.example.test:25565', discoveryUrl: 'https://updates.example.test/.well-known/kamucl-managed.json',
    manifestUrl: 'https://updates.example.test/pack/manifest.json', publicKey, keyFingerprint: fingerprint(publicKey), trusted: false,
    manifest: { schema: 1, packId: 'community-pack', packName: 'Community pack', packVersion: '1.0.0',
      contentRevision: 'revision-one', minecraft: '1.20.1', loader: { type: 'forge', version: '47.4.12' },
      serverAddress: 'play.example.test:25566', files: [], removeFiles: [] }
  }
}

class Owner extends EventEmitter {
  destroyed = false
  readonly sent: Array<{ channel: string; payload: any }> = []
  constructor(readonly id: number) { super() }
  isDestroyed() { return this.destroyed }
  send(channel: string, payload: any) { this.sent.push({ channel, payload }) }
}

let compiled: Promise<string> | undefined
async function fixture(t: TestContext) {
  const base = fs.realpathSync.native(os.tmpdir()), root = fs.mkdtempSync(path.join(base, 'kamucl-managed-ipc-'))
  const trustFilename = path.join(root, 'userData', 'managed-server-trust.json')
  const h: any = { root, userData: path.join(root, 'userData'), folder: path.join(root, 'games'), now: 1_770_000_000_000,
    handlers: new Map<string, (...args: any[]) => any>(), document: document(), discoveries: [], installs: [], remembers: [],
    lookups: [], appPaths: [], downloadFolders: [] }
  const first = new Owner(101), other = new Owner(202)
  h.app = { getPath: (name: string) => { h.appPaths.push(name); assert.equal(name, 'userData'); return h.userData } }
  h.ipcMain = { handle: (channel: string, handler: (...args: any[]) => any) => {
    assert(!h.handlers.has(channel), 'handler registered twice'); h.handlers.set(channel, handler)
  } }
  h.discover = async (address: string, _fetch: unknown, signal: AbortSignal, options: ManagedDiscoveryOptions = {}) => {
    h.discoveries.push({ address, options: structuredClone(options), signal })
    signal.throwIfAborted()
    const fresh = structuredClone(h.document) as DiscoveredManagedServer
    // Emulate the protocol's real pinned-key boundary, not an automatically
    // trusted provider response. Other protocol tests exercise real signatures.
    if (options.trustedPublicKey && fingerprint(options.trustedPublicKey) !== fresh.keyFingerprint) throw Error('服务器签名公钥发生变化，已阻止更新')
    if (!options.trustedPublicKey && !options.allowUntrustedPreview && !fresh.trusted) throw Error('服务器公钥尚未确认')
    if (options.trustedPublicKey) fresh.trusted = true
    return fresh
  }
  h.preview = (discovered: DiscoveredManagedServer, inspectionId: string) => ({ inspectionId,
    address: discovered.manifest.serverAddress, packId: discovered.manifest.packId, name: discovered.manifest.packName,
    minecraftVersion: discovered.manifest.minecraft, loader: discovered.manifest.loader.type,
    loaderVersion: discovered.manifest.loader.version, fileCount: 0, totalBytes: 0,
    keyFingerprint: discovered.keyFingerprint, trusted: discovered.trusted })
  h.install = async (fresh: DiscoveredManagedServer, folder: string, signal: AbortSignal, emit: (progress: unknown) => void) => {
    signal.throwIfAborted(); assert.equal(fresh.trusted, true)
    const state = JSON.parse(fs.readFileSync(trustFilename, 'utf8'))
    assert(state.servers.some((entry: any) => entry.address === fresh.address), 'discovery alias must be pinned before installation')
    assert(state.servers.some((entry: any) => entry.address === fresh.manifest.serverAddress), 'signed game address must be pinned before installation')
    h.installs.push({ fresh, folder, signal })
    emit({ stage: 'downloading', text: 'download fixture', bytes: 5, totalBytes: 10 })
    return { version: { id: 'managed-community-fixture', folder, isolated: true, mcVersion: fresh.manifest.minecraft },
      added: 1, updated: 0, removed: 0, unchanged: 0 }
  }

  compiled ??= (async () => {
    const protocol = JSON.stringify(path.resolve('src/main/core/managedServerProtocol.ts'))
    const store = JSON.stringify(path.resolve('src/main/core/managedServerTrust.ts'))
    const mocks: Record<string, string> = {
      electron: 'export const app=h.app,ipcMain=h.ipcMain',
      managedServerProtocol: `export {normalizeMinecraftAddress} from ${protocol};export const discoverManagedServer=(...args)=>h.discover(...args)`,
      managedServerService: 'export const fetchManagedBytes=()=>{throw Error("network must be mocked")};export const managedDownloadFolder=()=>h.folder;export const previewManagedServer=(...args)=>h.preview(...args);export const installManagedServer=(...args)=>h.install(...args)',
      paths: 'export const withDownloadFolder=(folder,fn)=>{h.downloadFolders.push(folder);return fn()}',
      managedServerTrust: `import {ManagedServerTrustStore as Store} from ${store};export class ManagedServerTrustStore extends Store{find(address){h.lookups.push(address);return super.find(address)}remember(addresses,key){h.remembers.push({addresses:[...addresses],key});super.remember(addresses,key)}}`
    }
    return (await build({ entryPoints: ['src/main/core/managedServerIpc.ts'], bundle: true, write: false,
      platform: 'node', format: 'cjs', logLevel: 'silent', plugins: [{ name: 'managed-ipc-owned-fixture', setup(plugin) {
        plugin.onResolve({ filter: /^(electron|\.\/[^/]+)$/ }, args => {
          const name = args.path === 'electron' ? args.path : args.path.slice(2)
          return mocks[name] ? { path: name, namespace: 'managed-ipc-fixture' } : undefined
        })
        plugin.onLoad({ filter: /.*/, namespace: 'managed-ipc-fixture' }, args => ({ loader: 'js',
          contents: 'const h=globalThis.fixture;' + mocks[args.path], resolveDir: process.cwd() }))
      } }] })).outputFiles[0].text
  })()
  const module = { exports: {} as any }, FixtureDate = class extends Date { static now() { return h.now } }
  new Function('require', 'module', 'exports', 'globalThis', 'Date', await compiled)(req, module, module.exports, { fixture: h }, FixtureDate)
  module.exports.registerManagedServerIpc()
  const invoke = (owner: Owner, channel: string, ...args: any[]) => h.handlers.get(channel)!({ sender: owner }, ...args)
  const inspect = (owner = first, operation = 'inspect-operation') => invoke(owner, IPC.managedServerInspect,
    { address: h.document.address, operation })
  const sync = (ticket: string, confirmTrust: unknown = undefined, owner = first, operation = 'sync-operation') => invoke(owner,
    IPC.managedServerSync, { inspectionId: ticket, operation, confirmTrust })
  const cancel = (operation: string, owner = first) => invoke(owner, IPC.managedServerCancel, operation)
  t.after(() => {
    assert.equal(first.listenerCount('destroyed'), 0, 'owner lifecycle listener must be released after task settlement')
    assert.equal(other.listenerCount('destroyed'), 0)
    assert(root.startsWith(base + path.sep))
    fs.rmSync(root, { recursive: true, force: true })
  })
  return { h, first, other, trustFilename, invoke, inspect, sync, cancel }
}

test('IPC unknown-server inspection is read-only, verifies without saving first-use trust, and returns no public key', async t => {
  const f = await fixture(t), preview = await f.inspect()
  assert.equal(preview.trusted, false); assert.equal(preview.keyFingerprint, fingerprint(publicKey))
  assert.equal(preview.publicKey, undefined)
  assert.deepEqual(f.h.discoveries[0].options, { allowUntrustedPreview: true })
  assert.deepEqual(f.h.remembers, []); assert.deepEqual(f.h.installs, [])
  assert.equal(fs.existsSync(f.trustFilename), false)
  assert.equal(fs.existsSync(f.h.folder), false)
})

test('IPC refuses unknown-server sync for every non-boolean-true confirmation before discovery, trust saves or installation', async t => {
  const f = await fixture(t), preview = await f.inspect()
  for (const [index, confirmation] of [undefined, false, 'true', 1, {}, null].entries()) {
    await assert.rejects(f.sync(preview.inspectionId, confirmation, f.first, `denied-operation-${index}`), /首次同步必须明确确认/)
  }
  assert.equal(f.h.discoveries.length, 1, 'unauthorized sync must not even re-fetch the manifest')
  assert.deepEqual(f.h.remembers, []); assert.deepEqual(f.h.installs, [])
  assert.equal(fs.existsSync(f.trustFilename), false)
})

test('IPC explicit first-use consent pins the exact inspected key and both addresses before installation', async t => {
  const f = await fixture(t), preview = await f.inspect(), result = await f.sync(preview.inspectionId, true)
  assert.equal(result.version.isolated, true)
  assert.deepEqual(f.h.discoveries[1].options, { trustedPublicKey: publicKey })
  assert.deepEqual(f.h.remembers, [{ addresses: ['updates.example.test:25565', 'play.example.test:25566'], key: publicKey }])
  assert.equal(f.h.installs.length, 1); assert.equal(f.h.installs[0].folder, f.h.folder)
  const state = JSON.parse(fs.readFileSync(f.trustFilename, 'utf8'))
  assert.deepEqual(state.servers.map((entry: any) => entry.address).sort(), ['play.example.test:25566', 'updates.example.test:25565'])
  assert(state.servers.every((entry: any) => entry.publicKey === publicKey && entry.fingerprint === fingerprint(publicKey)))
  assert.deepEqual(f.first.sent, [{ channel: IPC_EVENT.managedServerProgress, payload: {
    operation: 'sync-operation', stage: 'downloading', text: 'download fixture', bytes: 5, totalBytes: 10 } }])
  assert.equal(f.other.sent.length, 0)
  if (process.platform !== 'win32') assert.equal(fs.statSync(f.trustFilename).mode & 0o777, 0o600)
})

test('IPC known server reuses its per-address pin without repeat consent; same key does not globally trust other servers', async t => {
  const f = await fixture(t), initial = await f.inspect()
  await f.sync(initial.inspectionId, true)
  const known = await f.inspect(f.first, 'inspect-known-operation')
  assert.equal(known.trusted, true)
  assert.deepEqual(f.h.discoveries[2].options, { trustedPublicKey: publicKey })
  await f.sync(known.inspectionId, false, f.first, 'sync-known-operation')
  assert.equal(f.h.installs.length, 2)
  f.h.document = { ...document(), address: 'another.example.test:25565',
    manifest: { ...document().manifest, serverAddress: 'another-play.example.test:25565' } }
  const another = await f.inspect(f.first, 'inspect-another-operation')
  assert.equal(another.trusted, false)
  assert.deepEqual(f.h.discoveries.at(-1).options, { allowUntrustedPreview: true })
  await assert.rejects(f.sync(another.inspectionId, false, f.first, 'sync-another-operation'), /首次同步必须明确确认/)
  assert.equal(f.h.installs.length, 2)
  assert.equal(JSON.parse(fs.readFileSync(f.trustFilename, 'utf8')).servers.length, 2)
})

test('IPC fresh manifest changes invalidate the inspection before saving trust or installing', async t => {
  const f = await fixture(t), preview = await f.inspect()
  f.h.document.manifest.contentRevision = 'changed-after-preview'
  await assert.rejects(f.sync(preview.inspectionId, true), /服务器发布内容已变化/)
  assert.deepEqual(f.h.discoveries[1].options, { trustedPublicKey: publicKey })
  assert.deepEqual(f.h.remembers, []); assert.deepEqual(f.h.installs, [])
  assert.equal(fs.existsSync(f.trustFilename), false)
})

test('IPC revalidates a fresh document against the inspected key, rejecting key changes before all trust writes and installation', async t => {
  const f = await fixture(t), preview = await f.inspect()
  f.h.document.publicKey = replacementKey; f.h.document.keyFingerprint = fingerprint(replacementKey)
  await assert.rejects(f.sync(preview.inspectionId, true), /公钥发生变化/)
  assert.deepEqual(f.h.discoveries[1].options, { trustedPublicKey: publicKey }, 'fresh discovery must pin the key shown to the user, not accept the current advertisement')
  assert.deepEqual(f.h.remembers, []); assert.deepEqual(f.h.installs, [])
  assert.equal(fs.existsSync(f.trustFilename), false)
})

test('IPC inspection tickets are owner-bound and expire before first-use consent can authorize any writes', async t => {
  const f = await fixture(t), preview = await f.inspect()
  await assert.rejects(f.sync(preview.inspectionId, true, f.other, 'wrong-owner-operation'), /预览已过期/)
  f.h.now += 10 * 60_000 + 1
  await assert.rejects(f.sync(preview.inspectionId, true, f.first, 'expired-operation'), /预览已过期/)
  assert.equal(f.h.discoveries.length, 1)
  assert.deepEqual(f.h.remembers, []); assert.deepEqual(f.h.installs, [])
  assert.equal(fs.existsSync(f.trustFilename), false)
})

test('IPC only the operation owner may cancel, and successful cancellation waits until safe task cleanup settles', async t => {
  const f = await fixture(t), preview = await f.inspect()
  let entered!: () => void, finish!: () => void, signal: AbortSignal | undefined, cleaned = false
  const installed = new Promise<void>(resolve => { entered = resolve })
  f.h.install = async (_fresh: DiscoveredManagedServer, _folder: string, activeSignal: AbortSignal) => {
    signal = activeSignal; entered()
    return new Promise((_, reject) => { finish = () => { cleaned = true; reject(activeSignal.reason) } })
  }
  const task = f.sync(preview.inspectionId, true, f.first, 'cancelled-operation')
  const rejected = assert.rejects(task, /已取消服务器同步/)
  await installed
  assert.equal(await f.cancel('cancelled-operation', f.other), false)
  assert.equal(signal!.aborted, false)
  let cancellationSettled = false
  const cancellation = f.cancel('cancelled-operation').then((value: boolean) => { cancellationSettled = true; return value })
  await Promise.resolve(); await Promise.resolve()
  assert.equal(signal!.aborted, true)
  assert.equal(cancellationSettled, false)
  assert.equal(cleaned, false)
  assert.equal(f.first.listenerCount('destroyed'), 1, 'task remains owned while safe cleanup is pending')
  finish(); await rejected
  assert.equal(await cancellation, true)
  assert.equal(cleaned, true)
  assert.equal(await f.cancel('cancelled-operation'), false, 'settled operation was released')
})
