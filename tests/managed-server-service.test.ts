import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { build } from 'esbuild'
import { managedInstanceId } from '../src/main/core/managedServerPlan'
import { MANAGED_PUBLIC_KEY, MANAGED_KEY_FINGERPRINT } from '../src/main/core/managedServerProtocol'
import type { DiscoveredManagedServer, SignedManagedManifest } from '../src/main/core/managedServerProtocol'

function document(loaderVersion = '47.4.12'): DiscoveredManagedServer {
  const manifest: SignedManagedManifest = { schema: 1, packId: 'the-fool', packName: 'The Fool', packVersion: '0.3.0', minecraft: '1.20.1', loader: { type: 'forge', version: loaderVersion }, serverAddress: 'example.invalid:25565', files: [], removeFiles: [] }
  return { address: manifest.serverAddress, discoveryUrl: 'https://example.invalid:4443/.well-known/pcl-managed.json', manifestUrl: 'https://example.invalid:4443/fool/manifest.json', publicKey: MANAGED_PUBLIC_KEY, keyFingerprint: MANAGED_KEY_FINGERPRINT, trusted: true, manifest }
}

async function harness() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kamucl-managed-service-')))
  const symbol = '__managedService_' + randomUUID().replace(/-/g, '')
  const h: any = { root, folder: root, userData: path.join(root, 'userdata'), versions: [], installs: [], syncCalls: [], states: [], running: [], persisted: [], servers: [], discovered: document(), events: [] }
  const jsonPath = (id: string) => path.join(h.folder, 'versions', id, `${id}.json`)
  const seed = (d: DiscoveredManagedServer, patch: any = {}, extraJson: any = {}) => {
    const id = managedInstanceId(d.manifest), folder = path.join(h.folder, 'versions', id)
    fs.mkdirSync(folder, { recursive: true })
    fs.writeFileSync(jsonPath(id), JSON.stringify({ id, _gameDir: true, _managedServer: { schema: 1, address: d.manifest.serverAddress, packId: d.manifest.packId }, ...extraJson }))
    h.versions.push({ id, folder: h.folder, mcVersion: d.manifest.minecraft, loader: d.manifest.loader.type, loaderVersion: d.manifest.loader.version, ...patch })
    return id
  }
  h.install = async (mc: string, opts: any, emit: any, signal: AbortSignal) => {
    signal?.throwIfAborted(); h.installs.push({ mc, ...opts })
    const dir = path.join(h.folder, 'versions', opts.instanceName)
    fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(jsonPath(opts.instanceName), JSON.stringify({ id: opts.instanceName }))
    h.versions.push({ id: opts.instanceName, folder: h.folder, mcVersion: mc, loader: opts.loader, loaderVersion: opts.loaderVersion, ...h.runtimePatch })
    emit({ stage: 'done', progress: 1, text: 'installed exact runtime' })
    return h.installedId ?? opts.instanceName
  }
  h.sync = async (directory: string, manifest: SignedManagedManifest, _fetch: any, signal: AbortSignal, report: any, guard: any) => {
    await guard(); signal?.throwIfAborted(); h.syncCalls.push({ directory, manifest })
    if (h.onSync) await h.onSync({ directory, report, guard })
    return { added: 1, updated: 0, removed: 0, unchanged: 0 }
  }
  h.http = async (_url: string, options: any) => { options.signal.throwIfAborted(); return new Response('data') }
  const mocks: Record<string, string> = {
    electron: "export const app={getPath:()=>h.userData}",
    httpClient: 'export const httpFetch=(...args)=>h.http(...args)',
    managedServerProtocol: `export {normalizeMinecraftAddress,managedPublicKeyInfo,MANAGED_PUBLIC_KEY,MANAGED_KEY_FINGERPRINT} from ${JSON.stringify(path.resolve('src/main/core/managedServerProtocol.ts'))};export const discoverManagedServer=async(...args)=>{h.discoveryAddress=args[0];h.discoveryOptions=args[3];return h.discovered}`,
    managedServerSync: 'export const syncManagedFiles=(...args)=>h.sync(...args)',
    paths: `export const gameDir=()=>h.folder;export const defaultFolderPath=()=>h.root;export const versionDir=id=>p.join(h.folder,'versions',id);export const versionJsonPath=id=>p.join(versionDir(id),id+'.json');export const withGameFolder=(folder,fn)=>{h.folder=folder;return fn()}`,
    instances: `export const instanceDirectoryState=(id,json,folder=h.folder)=>({path:json._gameDir===true?p.join(folder,'versions',id):(json._gameDirectory||folder)});export const setNewInstanceIsolation=(id,value)=>{const filename=p.join(h.folder,'versions',id,id+'.json'),json=JSON.parse(fs.readFileSync(filename,'utf8'));json._gameDir=value;fs.writeFileSync(filename,JSON.stringify(json))}`,
    versions: `export const installVersion=(...args)=>h.install(...args);export const listAllInstalled=()=>h.versions;export const scanInstalledFolder=folder=>({versions:h.versions.filter(v=>v.folder===folder)});export const readVersionJson=id=>JSON.parse(fs.readFileSync(p.join(h.folder,'versions',id,id+'.json'),'utf8'))`,
    launchUiState: 'export const activeLaunchStates=()=>h.states',
    launch: 'export const getRunningGameDirectories=()=>h.running',
    runningGameRecords: 'export class RunningGameRecords{usesDirectory(directory){return h.persisted.includes(directory)}}',
    servers: `export const listServers=()=>h.servers;export const addServer=(name,address)=>{h.servers.push({id:'server-'+h.servers.length,name,address});return h.servers};export const bindServer=(id,versionId,folder)=>{Object.assign(h.servers.find(s=>s.id===id),{versionId,folder});return h.servers}`
  }
  const result = await build({ entryPoints: ['src/main/core/managedServerService.ts'], bundle: true, write: false, platform: 'node', format: 'cjs', plugins: [{ name: 'managed-service-isolation', setup(builder) {
    builder.onResolve({ filter: /^(electron|\.\/[^/]+)$/ }, args => {
      const key = args.path === 'electron' ? 'electron' : args.path.slice(2)
      return mocks[key] ? { path: key, namespace: 'managed-service-mock' } : undefined
    })
    builder.onLoad({ filter: /.*/, namespace: 'managed-service-mock' }, args => ({ contents: `import fs from 'node:fs';import p from 'node:path';const h=globalThis[${JSON.stringify(symbol)}];` + mocks[args.path], loader: 'js', resolveDir: process.cwd() }))
  } }] })
  ;(globalThis as any)[symbol] = h
  const module = { exports: {} as any }
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports)
  return { root, h, seed, api: module.exports, close: () => { delete (globalThis as any)[symbol]; fs.rmSync(root, { recursive: true, force: true }) } }
}

test('managed service: initial import installs exact MC+Forge into isolated deterministic slot, preserves personal instance', async () => {
  const t = await harness()
  try {
    const personal = path.join(t.root, 'versions', 'personal'); fs.mkdirSync(personal, { recursive: true }); fs.writeFileSync(path.join(personal, 'options.txt'), 'personal')
    const result = await t.api.installManagedServer(t.h.discovered, t.root, new AbortController().signal, () => {})
    const id = managedInstanceId(t.h.discovered.manifest)
    assert.deepEqual(t.h.installs, [{ mc: '1.20.1', loader: 'forge', loaderVersion: '47.4.12', instanceName: id }])
    assert.equal(result.version.id, id); assert.equal(t.h.syncCalls[0].directory, path.join(t.root, 'versions', id))
    const json = JSON.parse(fs.readFileSync(path.join(t.root, 'versions', id, `${id}.json`), 'utf8'))
    assert.equal(json._gameDir, true); assert.equal(json._managedServer.address, 'example.invalid:25565')
    assert.equal(json._managedServer.publicKey, MANAGED_PUBLIC_KEY)
    assert.equal(fs.readFileSync(path.join(personal, 'options.txt'), 'utf8'), 'personal')
    assert.equal(t.h.servers[0].versionId, id)
  } finally { t.close() }
})

test('generic managed service: unknown preview cannot be installed without confirmed key trust', async () => {
  const t = await harness()
  try {
    t.h.discovered = { ...document(), trusted: false }
    await assert.rejects(t.api.installManagedServer(t.h.discovered, t.root, new AbortController().signal, () => {}), /信任|确认|公钥/)
    assert.equal(t.h.installs.length, 0); assert.equal(t.h.syncCalls.length, 0)
  } finally { t.close() }
})

test('generic managed service: another pack persists original discovery alias and reuses exact pinned key at startup', async () => {
  const t = await harness()
  try {
    t.h.discovered = { ...document(), address: 'updates-alias.invalid:25565', manifest: { ...document().manifest, packId: 'community-pack', packName: 'Community Pack' } }
    const imported = await t.api.installManagedServer(t.h.discovered, t.root, new AbortController().signal, () => {})
    const id = imported.version.id, json = JSON.parse(fs.readFileSync(path.join(t.root, 'versions', id, `${id}.json`), 'utf8'))
    assert.equal(json._managedServer.packId, 'community-pack'); assert.equal(json._managedServer.discoveryAddress, 'updates-alias.invalid:25565')
    const lease = t.api.beginManagedLaunch(id)
    await t.api.prepareManagedLaunch(id, () => {}, new AbortController().signal, undefined, lease)
    assert.equal(t.h.discoveryAddress, 'updates-alias.invalid:25565'); assert.equal(t.h.discoveryOptions.trustedPublicKey, MANAGED_PUBLIC_KEY)
    t.api.endManagedLaunch(lease)
  } finally { t.close() }
})

test('managed service: existing mismatched runtime, nonmanaged binding and unknown directory refuse all mod writes', async () => {
  for (const kind of ['runtime', 'binding', 'unknown']) {
    const t = await harness()
    try {
      if (kind === 'runtime') t.seed(t.h.discovered, { loaderVersion: '47.4.0' })
      else if (kind === 'binding') t.seed(t.h.discovered, {}, { _managedServer: undefined })
      else fs.mkdirSync(path.join(t.root, 'versions', managedInstanceId(t.h.discovered.manifest)), { recursive: true })
      await assert.rejects(t.api.installManagedServer(t.h.discovered, t.root, new AbortController().signal, () => {}))
      assert.equal(t.h.syncCalls.length, 0); assert.equal(t.h.installs.length, 0)
    } finally { t.close() }
  }
})

test('managed service: new installer profile must match exact signed runtime before any client file writes', async () => {
  const t = await harness()
  try {
    t.h.runtimePatch = { loaderVersion: '47.4.0' }
    await assert.rejects(t.api.installManagedServer(t.h.discovered, t.root, new AbortController().signal, () => {}), /运行环境|加载器|版本/)
    assert.equal(t.h.syncCalls.length, 0)
  } finally { t.close() }
})

test('managed service: wrong native installer ID cannot be rebound or synchronized', async () => {
  const t = await harness()
  try {
    t.h.installedId = 'another-profile'
    await assert.rejects(t.api.installManagedServer(t.h.discovered, t.root, new AbortController().signal, () => {}), /非预期实例/)
    assert.equal(t.h.syncCalls.length, 0)
  } finally { t.close() }
})

test('managed service: runtime upgrade retains both old/new directory leases until launch owner releases them', async () => {
  const t = await harness()
  try {
    const old = document('47.4.12'), oldId = t.seed(old), oldPath = path.join(t.root, 'versions', oldId)
    fs.writeFileSync(path.join(oldPath, 'options.txt'), 'old-user-data')
    t.h.states = [{ status: 'launching', versionId: oldId, folder: t.root, launchId: 'own-launch' }]
    const lease = t.api.beginManagedLaunch(oldId, 'own-launch')
    t.h.discovered = document('47.4.13')
    const next = await t.api.prepareManagedLaunch(oldId, () => {}, new AbortController().signal, old.manifest.serverAddress, lease)
    const newPath = path.join(t.root, 'versions', next.versionId)
    assert.notEqual(next.versionId, oldId); assert.equal(lease.slots.size, 2)
    assert.throws(() => t.api.assertManagedDirectoryLaunchAllowed(oldPath), /正在同步|准备启动/)
    assert.throws(() => t.api.assertManagedDirectoryLaunchAllowed(newPath), /正在同步|准备启动/)
    t.api.assertManagedDirectoryLaunchAllowed(newPath, lease)
    assert.equal(fs.readFileSync(path.join(oldPath, 'options.txt'), 'utf8'), 'old-user-data')
    t.api.endManagedLaunch(lease)
    t.api.assertManagedDirectoryLaunchAllowed(oldPath); t.api.assertManagedDirectoryLaunchAllowed(newPath)
  } finally { t.close() }
})

test('managed service: only exact own preparing launch is exempt, never running PIDs or other preparing launches', async () => {
  for (const kind of ['own', 'other', 'own-running', 'in-memory-pid', 'persisted-pid']) {
    const t = await harness()
    try {
      const id = t.seed(t.h.discovered), directory = path.join(t.root, 'versions', id)
      t.h.states = [{ status: kind === 'own-running' ? 'running' : 'launching', versionId: id, folder: t.root, launchId: kind === 'other' ? 'different-launch' : 'own-launch' }]
      if (kind === 'in-memory-pid') t.h.running = [directory]
      if (kind === 'persisted-pid') t.h.persisted = [directory]
      if (kind === 'own') t.api.endManagedLaunch(t.api.beginManagedLaunch(id, 'own-launch'))
      else assert.throws(() => t.api.beginManagedLaunch(id, 'own-launch'), /正在|仍在/)
    } finally { t.close() }
  }
})

test('managed service: different profile sharing target directory and newly busy staging are rejected', async () => {
  const t = await harness()
  try {
    const id = t.seed(t.h.discovered), directory = path.join(t.root, 'versions', id), alias = path.join(t.root, 'versions', 'alias')
    fs.mkdirSync(alias, { recursive: true }); fs.writeFileSync(path.join(alias, 'alias.json'), JSON.stringify({ _gameDirectory: directory }))
    t.h.states = [{ status: 'launching', versionId: 'alias', folder: t.root, launchId: 'alias-launch' }]
    await assert.rejects(t.api.installManagedServer(t.h.discovered, t.root, new AbortController().signal, () => {}), /正在/)
    assert.equal(t.h.syncCalls.length, 0)
    t.h.states = []; t.h.onSync = async ({ guard }: any) => { t.h.running = [directory]; await guard() }
    await assert.rejects(t.api.installManagedServer(t.h.discovered, t.root, new AbortController().signal, () => {}), /正在使用/)
  } finally { t.close() }
})

test('managed service: streamed HTTP chunk bytes flow before completion, no redirects and strict byte limit', async () => {
  const t = await harness(), bytes: number[] = [], calls: any[] = []
  try {
    t.h.http = async (url: string, options: any) => { calls.push({ url, options }); return new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(100)); controller.enqueue(new Uint8Array(200)); controller.close() } })) }
    const received = await t.api.fetchManagedBytes('https://example.invalid/object', { maxBytes: 400, onProgress: (value: number) => bytes.push(value) })
    assert.equal(received.length, 300); assert.deepEqual(bytes, [100, 300]); assert.equal(calls[0].options.redirect, 'manual'); assert.equal(calls[0].options.systemProxy, true)
    await assert.rejects(t.api.fetchManagedBytes('https://example.invalid/object', { maxBytes: 150 }), /大小/)
    t.h.http = async () => new Response('redirect', { status: 301, headers: { location: 'https://untrusted.invalid/' } })
    await assert.rejects(t.api.fetchManagedBytes('https://example.invalid/object', { maxBytes: 400 }), /HTTP 301/)
    await assert.rejects(t.api.fetchManagedBytes('http://example.invalid/object', { maxBytes: 400 }), /HTTPS/)
  } finally { t.close() }
})

test('managed service: prepare progress uses streamed byte ratio, not only completed file count', async () => {
  const t = await harness(), events: any[] = []
  try {
    const id = t.seed(t.h.discovered), lease = t.api.beginManagedLaunch(id)
    t.h.onSync = ({ report }: any) => report({ stage: 'downloading', completed: 0, total: 1, bytes: 100, totalBytes: 400, text: 'streaming a large file' })
    await t.api.prepareManagedLaunch(id, (event: any) => events.push(event), new AbortController().signal, undefined, lease)
    assert(events.some(event => event.progress === 0.25 && event.bytesDone === 100 && event.bytesTotal === 400))
    t.api.endManagedLaunch(lease)
  } finally { t.close() }
})
