import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { build } from 'esbuild'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'
import * as vue from 'vue'
import type { ManagedServerPreview, ManagedServerProgress, ManagedServerSyncResult } from '../src/shared/managedServer'

const req = createRequire(import.meta.url)
const componentPath = 'src/renderer/src/components/ManagedServerImport.vue'
const preview: ManagedServerPreview = {
  inspectionId: 'checked-ticket', address: 'mc.example.test:25565', packId: 'fool', name: '测试整合包',
  packVersion: '0.3.0', revision: '20261006180000', minecraftVersion: '1.20.1', loader: 'forge',
  loaderVersion: '47.4.12', fileCount: 600, totalBytes: 12345678, keyFingerprint: 'a'.repeat(64), trusted: true
}
const result: ManagedServerSyncResult = {
  version: { id: 'managed-fool-forge-47.4.12', folder: '/owned/minecraft', mcVersion: '1.20.1',
    loader: 'forge', loaderVersion: '47.4.12', isolated: true } as ManagedServerSyncResult['version'],
  added: 1, updated: 2, removed: 3, unchanged: 594, backupDirectory: '/owned/minecraft/.kamucl/backups/example'
}

let compiled: Promise<string> | undefined
async function fixture(t: TestContext) {
  compiled ??= (async () => {
    const descriptor = parse(fs.readFileSync(componentPath, 'utf8')).descriptor
    const script = compileScript(descriptor, { id: 'managed-server-ui-fixture' }).content
    return (await build({ stdin: { contents: script, loader: 'ts', resolveDir: path.resolve('src/renderer/src/components') },
      bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', logLevel: 'silent',
      plugins: [{ name: 'managed-server-renderer-fixture', setup(plugin) {
        plugin.onResolve({ filter: /^\.\.\/api$/ }, () => ({ path: 'api', namespace: 'managed-fixture' }))
        plugin.onResolve({ filter: /UpdateDialogShell\.vue$/ }, () => ({ path: 'shell', namespace: 'managed-fixture' }))
        plugin.onLoad({ filter: /.*/, namespace: 'managed-fixture' }, args => ({ loader: 'js', contents: args.path === 'shell'
          ? 'export default {}'
          : ['cancelManagedServer', 'errText', 'inspectManagedServer', 'onManagedServerProgress', 'syncManagedServer'].map(name =>
            `export const ${name}=(...args)=>globalThis.fixture.api.${name}(...args)`).join(';') }))
      } }] })).outputFiles[0].text
  })()
  const calls: Array<{ name: string; request: any }> = [], events: any[] = []
  const mounted: Array<() => void> = [], unmounted: Array<() => void> = []
  let progress: ((event: ManagedServerProgress) => void) | undefined, unsubscribed = 0, sequence = 0
  const api = {
    inspectManagedServer: async (request: any): Promise<ManagedServerPreview> => { calls.push({ name: 'inspect', request }); return structuredClone(preview) },
    syncManagedServer: async (request: any): Promise<ManagedServerSyncResult> => { calls.push({ name: 'sync', request }); return structuredClone(result) },
    cancelManagedServer: async (request: string) => { calls.push({ name: 'cancel', request }); return true },
    errText: (error: Error) => error.message,
    onManagedServerProgress: (callback: (event: ManagedServerProgress) => void) => { progress = callback; return () => { unsubscribed++ } }
  }
  const module = { exports: {} as any }
  const vueFixture = { ...vue, onMounted: (callback: () => void) => mounted.push(callback),
    onBeforeUnmount: (callback: () => void) => unmounted.push(callback) }
  new Function('require', 'module', 'exports', 'globalThis', 'crypto', await compiled)(
    (name: string) => name === 'vue' ? vueFixture : req(name), module, module.exports, { fixture: { api } },
    { randomUUID: () => `ui-operation-${++sequence}` })
  const scope = vue.effectScope()
  const state = scope.run(() => module.exports.default.setup({}, { emit: (...args: any[]) => events.push(args), expose: () => {} }))
  mounted.forEach(callback => callback())
  let disposed = false
  const dispose = () => { if (disposed) return; disposed = true; unmounted.forEach(callback => callback()); scope.stop() }
  t.after(dispose)
  return { state, api, calls, events, dispose, progress: (event: ManagedServerProgress) => progress!(event), unsubscribed: () => unsubscribed }
}

test('server-sync component and ServersView templates compile with explicit, accessible confirmation controls', () => {
  for (const filename of [componentPath, 'src/renderer/src/views/ServersView.vue']) {
    const { descriptor, errors } = parse(fs.readFileSync(filename, 'utf8'))
    assert.deepEqual(errors, [])
    const script = compileScript(descriptor, { id: filename })
    const template = compileTemplate({ source: descriptor.template!.content, filename, id: filename,
      compilerOptions: { bindingMetadata: script.bindings } })
    assert.deepEqual(template.errors, [])
  }
  const source = fs.readFileSync(componentPath, 'utf8')
  assert.match(source, /HTTPS 发现服务/)
  assert.match(source, /确认安装并同步/)
  assert.match(source, /同名但内容不同的 JAR/)
  assert.match(source, /aria-label="当前阶段进度"/)
  assert.match(source, /我已核对管理员提供的公钥指纹，并信任此服务器的模组来源（模组可执行代码）/)
  assert.match(source, /:disabled="!canSync"/)
  assert(!/<details[^>]*class="managed-signature"/.test(source), 'the full signing fingerprint must always be visible, not hidden in a collapsed disclosure')
  const api = fs.readFileSync('src/renderer/src/api.ts', 'utf8')
  for (const key of ['managedServerInspect', 'managedServerSync', 'managedServerCancel']) assert(api.includes(`IPC.${key}`))
  assert(api.includes('IPC_EVENT.managedServerProgress'))
  const view = fs.readFileSync('src/renderer/src/views/ServersView.vue', 'utf8')
  const installedHandler = view.slice(view.indexOf('async function onManagedInstalled'), view.indexOf('function viewManagedInstance'))
  assert.match(installedHandler, /selectInstance\(result\.version\.id, result\.version\.folder\)/)
  assert.match(installedHandler, /getInstalled\(true\)/)
  assert(!/launchGame\(|bindServer\(/.test(installedHandler), 'backend-selected instance is refreshed, never auto-launched or rebound by renderer')
})

test('inspecting server address is read-only, exact runtime versions are previewed, and address edits invalidate ticket', async t => {
  const f = await fixture(t)
  f.state.address.value = '  mc.example.test:25565  '
  await vue.nextTick()
  await f.state.inspect()
  assert.deepEqual(f.calls, [{ name: 'inspect', request: { address: 'mc.example.test:25565', operation: 'ui-operation-1' } }])
  assert.equal(f.events.length, 0)
  assert.equal(f.state.preview.value.minecraftVersion, '1.20.1')
  assert.equal(f.state.preview.value.loaderVersion, '47.4.12')
  assert.equal(f.state.loaderLabel.value, 'Forge')
  assert.equal(f.state.busy.value, false)
  f.state.address.value = 'other.example.test'
  assert.equal(f.state.preview.value, null)
  await f.state.sync()
  assert.equal(f.calls.filter(call => call.name === 'sync').length, 0, 'old inspection cannot synchronize a newly entered address')
})

test('explicit sync only submits inspection ticket, returns dedicated isolated target, and never invokes game launch', async t => {
  const f = await fixture(t)
  f.state.address.value = 'mc.example.test'
  await vue.nextTick(); await f.state.inspect()
  assert.equal(f.state.requiresTrustConfirmation.value, false)
  assert.equal(f.state.trustConfirmed.value, false, 'known servers need no new approval, not an automatically checked first-trust box')
  await f.state.sync()
  assert.deepEqual(f.calls[1], { name: 'sync', request: { inspectionId: 'checked-ticket', operation: 'ui-operation-2', confirmTrust: false } })
  assert.deepEqual(f.events, [['installed', result]])
  assert.deepEqual(f.state.result.value, result)
  assert.equal(f.state.busy.value, false)
  await f.state.sync()
  assert.equal(f.calls.filter(call => call.name === 'sync').length, 1, 'completed task cannot be accidentally submitted twice')
  assert(!f.calls.some(call => /launch|bind|setIsolation/i.test(call.name)))
})

test('unknown server cannot synchronize until the user explicitly confirms the administrator fingerprint', async t => {
  const f = await fixture(t)
  f.api.inspectManagedServer = async request => { f.calls.push({ name: 'inspect', request }); return { ...preview, trusted: false } }
  f.state.address.value = 'new.example.test'; await f.state.inspect()
  assert.equal(f.state.requiresTrustConfirmation.value, true)
  assert.equal(f.state.trustConfirmed.value, false)
  assert.equal(f.state.canSync.value, false)
  assert.equal(f.state.preview.value.keyFingerprint, preview.keyFingerprint)
  await f.state.sync()
  assert.equal(f.calls.filter(call => call.name === 'sync').length, 0)
  f.state.trustConfirmed.value = true
  assert.equal(f.state.canSync.value, true)
  await f.state.sync()
  assert.deepEqual(f.calls[1], { name: 'sync', request: { inspectionId: 'checked-ticket', operation: 'ui-operation-2', confirmTrust: true } })
  assert.equal(f.state.preview.value.trusted, true)
  assert.equal(f.state.requiresTrustConfirmation.value, false)
})

test('first-trust approval resets on reinspection and address edits and never carries over to a new preview', async t => {
  const f = await fixture(t)
  f.api.inspectManagedServer = async request => { f.calls.push({ name: 'inspect', request }); return { ...preview, trusted: false } }
  f.state.address.value = 'new.example.test'; await f.state.inspect()
  f.state.trustConfirmed.value = true
  assert.equal(f.state.canSync.value, true)
  await f.state.inspect()
  assert.equal(f.state.trustConfirmed.value, false)
  assert.equal(f.state.canSync.value, false)
  f.state.trustConfirmed.value = true
  f.state.address.value = 'other.example.test'
  assert.equal(f.state.trustConfirmed.value, false)
  assert.equal(f.state.preview.value, null)
  await f.state.inspect()
  assert.equal(f.state.trustConfirmed.value, false)
  assert.equal(f.state.canSync.value, false)
  await f.state.sync()
  assert.equal(f.calls.filter(call => call.name === 'sync').length, 0)
})

test('cancellation keeps task and dialog active until backend settles, blocks duplicates, and permits safe dismissal afterwards', async t => {
  const f = await fixture(t)
  f.state.address.value = 'mc.example.test'; await vue.nextTick(); await f.state.inspect()
  let reject!: (error: Error) => void
  f.api.syncManagedServer = async request => { f.calls.push({ name: 'sync', request }); return new Promise((_, fail) => { reject = fail }) }
  const pending = f.state.sync()
  assert.equal(f.state.busy.value, true)
  await f.state.sync(); await f.state.cancel(); f.state.dismiss()
  assert.equal(f.calls.filter(call => call.name === 'sync').length, 1)
  assert.deepEqual(f.calls.filter(call => call.name === 'cancel'), [{ name: 'cancel', request: 'ui-operation-2' }])
  assert.equal(f.state.busy.value, true)
  assert.equal(f.events.length, 0)
  reject(Error('操作已取消')); await pending
  assert.equal(f.state.busy.value, false)
  assert.equal(f.state.preview.value, null)
  assert.equal(f.state.error.value, '')
  assert.match(f.state.notice.value, /已取消/)
  f.state.dismiss(); assert.deepEqual(f.events, [['dismiss']])
})

test('progress belongs to current operation only, clamps percentages, and unsubscribes on unmount', async t => {
  const f = await fixture(t)
  let complete!: (value: ManagedServerPreview) => void
  f.api.inspectManagedServer = async request => { f.calls.push({ name: 'inspect', request }); return new Promise(resolve => { complete = resolve }) }
  f.state.address.value = 'mc.example.test'; await vue.nextTick()
  const pending = f.state.inspect()
  f.progress({ operation: 'other-window', stage: 'inspect', text: 'wrong', progress: 0.8 })
  assert.equal(f.state.progress.value, null)
  f.progress({ operation: 'ui-operation-1', stage: 'inspect', text: 'verified', progress: 2 })
  assert.equal(f.state.progress.value.text, 'verified')
  assert.equal(f.state.percent.value, 99, 'a non-final active stage cannot pretend the whole synchronization is complete')
  f.progress({ operation: 'ui-operation-1', stage: 'inspect', text: 'verified', progress: -1 })
  assert.equal(f.state.percent.value, 0)
  complete(preview); await pending
  f.progress({ operation: 'ui-operation-1', stage: 'inspect', text: 'late', progress: 0.4 })
  assert.equal(f.state.progress.value.text, 'verified')
  f.dispose(); assert.equal(f.unsubscribed(), 1)
})

test('one large JAR advances download bar from streamed bytes before file completion, and later stages do not retain download completion', async t => {
  const f = await fixture(t)
  f.state.address.value = 'mc.example.test'; await vue.nextTick(); await f.state.inspect()
  let complete!: (value: ManagedServerSyncResult) => void
  f.api.syncManagedServer = async () => new Promise(resolve => { complete = resolve })
  const pending = f.state.sync()
  assert.equal(f.state.percent.value, null, 'preparation without evidence is indeterminate')
  const totalBytes = 64 * 1024 * 1024
  for (const fraction of [0.25, 0.5, 0.75]) {
    f.progress({ operation: 'ui-operation-2', stage: 'downloading', text: '下载：mods/large.jar',
      bytes: totalBytes * fraction, totalBytes, completed: 0, total: 1, progress: 0 })
    assert.equal(f.state.percent.value, fraction * 100, 'byte count has precedence over zero completed files and stale fractional progress')
    assert.equal(f.state.stageLabel.value, '下载更新文件')
    assert.equal(f.state.downloadedText.value, `已下载 ${(64 * fraction).toFixed(1)} MiB / 64.0 MiB`)
    assert.equal(f.state.progress.value.text, '下载：mods/large.jar')
  }
  f.progress({ operation: 'ui-operation-2', stage: 'checking', text: '校验：mods/large.jar', completed: 1, total: 1 })
  assert.equal(f.state.stageLabel.value, '校验已有文件')
  assert.equal(f.state.downloadedText.value, '')
  assert.equal(f.state.percent.value, 99, 'file verification is not overall task completion')
  f.progress({ operation: 'ui-operation-2', stage: 'install', text: '安装 Forge', progress: 1 })
  assert.equal(f.state.stageLabel.value, '安装游戏与加载器')
  assert.equal(f.state.percent.value, 99, 'an installer subtask completing is not overall task completion')
  f.progress({ operation: 'ui-operation-2', stage: 'applying', text: '应用文件', completed: 1, total: 4 })
  assert.equal(f.state.stageLabel.value, '应用并备份变更')
  assert.equal(f.state.percent.value, 25, 'current-stage file counts are the fallback when no byte/progress fraction is provided')
  f.progress({ operation: 'ui-operation-2', stage: 'done', text: '全部完成', progress: 1 })
  assert.equal(f.state.percent.value, 100)
  complete(result); await pending
})

test('unsupported-discovery errors remain visible, editing clears them, and unmounted late completion cannot emit success', async t => {
  const f = await fixture(t)
  f.api.inspectManagedServer = async () => { throw Error('此服务器未提供兼容的 HTTPS 发现服务') }
  f.state.address.value = 'unsupported.example.test'; await vue.nextTick(); await f.state.inspect()
  assert.match(f.state.error.value, /HTTPS 发现服务/)
  assert.equal(f.state.preview.value, null)
  f.state.address.value = 'mc.example.test'; await vue.nextTick()
  assert.equal(f.state.error.value, '')
  let complete!: (value: ManagedServerPreview) => void
  f.api.inspectManagedServer = async () => new Promise(resolve => { complete = resolve })
  const pending = f.state.inspect()
  f.dispose(); complete(preview); await pending
  assert.equal(f.state.preview.value, null)
  assert.equal(f.events.length, 0)
  assert.equal(f.calls.filter(call => call.name === 'cancel').length, 1)
})
