import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { app } from 'electron'
import type { ManagedServerPreview, ManagedServerProgress, ManagedServerSyncResult } from '../../shared/managedServer'
import type { InstalledVersion, LoaderName } from '../../shared/types'
import { httpFetch } from './httpClient'
import { discoverManagedServer, normalizeMinecraftAddress, type DiscoveredManagedServer, type ManagedFetch } from './managedServerProtocol'
import { syncManagedFiles } from './managedServerSync'
import { managedInstanceId, matchingManagedBinding, type ManagedBinding } from './managedServerPlan'
import { gameDir, versionDir, versionJsonPath, withGameFolder, defaultFolderPath } from './paths'
import { instanceDirectoryState, setNewInstanceIsolation } from './instances'
import { installVersion, listAllInstalled, readVersionJson, scanInstalledFolder, type ProgressEmit } from './versions'
import { activeLaunchStates } from './launchUiState'
import { samePath } from './folderPaths'
import * as servers from './servers'
import { ManagedDirectoryLeases, type ManagedLaunchLease } from './managedServerLease'
import { RunningGameRecords } from './runningGameRecords'
import { getRunningGameDirectories } from './launch'
import { ProgressDeadline } from '../../shared/deadline'
import { withFileJob } from './fileJobs'
import { managedPublicKeyIdentity } from './managedServerTrust'

const directories = new ManagedDirectoryLeases()
type Report = (progress: Omit<ManagedServerProgress, 'operation'>) => void

/** No redirects, TLS exceptions or credential forwarding on the pack trust boundary. */
export const fetchManagedBytes: ManagedFetch = async (url, options) => {
  if (new URL(url).protocol !== 'https:') throw new Error('更新服务器必须使用 HTTPS')
  const idle = new ProgressDeadline(120_000, () => undefined)
  const signal = options.signal ? AbortSignal.any([options.signal, idle.signal]) : idle.signal
  let response: Awaited<ReturnType<typeof httpFetch>> | undefined
  try {
    response = await httpFetch(url, { signal, redirect: 'manual', systemProxy: true })
    if (!response.ok) throw new Error(`更新服务器返回 HTTP ${response.status}`)
    const declared = response.headers.get('content-length')
    if (declared && (!/^\d+$/.test(declared) || Number(declared) > options.maxBytes)) throw new Error('更新文件超出允许大小')
    if (!response.body) throw new Error('更新服务器返回空响应')
    const chunks: Buffer[] = []
    let bytes = 0
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      signal.throwIfAborted()
      bytes += chunk.length
      idle.progress(String(bytes))
      if (bytes > options.maxBytes) throw new Error('更新文件超出允许大小')
      chunks.push(Buffer.from(chunk))
      options.onProgress?.(bytes)
    }
    return Buffer.concat(chunks)
  } finally {
    idle.dispose()
    if (response?.body && !response.body.locked) await response.body.cancel().catch(() => undefined)
  }
}

function managedJson(id: string) {
  return readVersionJson(id) as ReturnType<typeof readVersionJson> & { _managedServer?: ManagedBinding }
}

function saveBinding(id: string, discovered: DiscoveredManagedServer): void {
  const json = managedJson(id)
  json._managedServer = { schema: 1, address: discovered.manifest.serverAddress, packId: discovered.manifest.packId,
    publicKey: discovered.publicKey, discoveryAddress: discovered.address }
  json._gameDir = true
  const target = versionJsonPath(id)
  const temp = `${target}.managed-${crypto.randomUUID()}.tmp`
  try {
    fs.writeFileSync(temp, JSON.stringify(json, null, 2), { flag: 'wx' })
    fs.renameSync(temp, target)
  } finally { fs.rmSync(temp, { force: true }) }
}

function existingInstance(discovered: DiscoveredManagedServer, folder: string): InstalledVersion | undefined {
  const id = managedInstanceId(discovered.manifest)
  return listAllInstalled().find(version => version.id === id && samePath(version.folder, folder))
}

export function previewManagedServer(discovered: DiscoveredManagedServer, inspectionId: string, folder: string): ManagedServerPreview {
  const manifest = discovered.manifest
  return {
    inspectionId, address: manifest.serverAddress, packId: manifest.packId,
    name: manifest.packName || manifest.packId, packVersion: manifest.packVersion,
    revision: manifest.contentRevision, minecraftVersion: manifest.minecraft,
    loader: manifest.loader.type as LoaderName, loaderVersion: manifest.loader.version,
    fileCount: manifest.files.length, totalBytes: manifest.files.reduce((total, file) => total + file.size, 0),
    keyFingerprint: discovered.keyFingerprint, trusted: discovered.trusted, existingInstance: existingInstance(discovered, folder)
  }
}

function assertIdle(id: string, folder: string, ownLaunchId?: string, target = path.join(folder, 'versions', id)): void {
  if (getRunningGameDirectories().some(directory => samePath(directory, target))) throw new Error('游戏进程正在使用此实例，请先退出游戏再同步')
  if (new RunningGameRecords(app.getPath('userData')).usesDirectory(target)) throw new Error('游戏进程仍在使用此实例，请退出游戏后再同步（关闭启动器不会关闭游戏）')
  if (activeLaunchStates().some(state => {
    // Detached restored states are refreshed by the live PID records above.
    if (state.launchId?.startsWith('detached:')) return false
    if (state.status === 'launching' && ownLaunchId && state.launchId === ownLaunchId) return false
    if (!state.versionId) return state.status === 'running'
    const stateFolder = state.folder || folder
    if (state.versionId === id && samePath(stateFolder, folder)) return true
    try {
      const json = JSON.parse(fs.readFileSync(path.join(stateFolder, 'versions', state.versionId, `${state.versionId}.json`), 'utf8'))
      return samePath(instanceDirectoryState(state.versionId, json, stateFolder).path, target)
    } catch { return false }
  })) {
    throw new Error('该受管实例正在运行或准备启动，请先退出游戏再同步')
  }
}

/** Ordinary profiles may not launch into a directory a managed task owns either. */
export function assertManagedDirectoryLaunchAllowed(directory: string, lease?: ManagedLaunchLease): void {
  directories.assertAvailable(directory, lease)
}

export function beginManagedLaunch(id: string, launchId?: string): ManagedLaunchLease | undefined {
  const binding = managedJson(id)._managedServer
  const directory = instanceDirectoryState(id, managedJson(id), gameDir()).path
  directories.assertAvailable(directory)
  // A manually configured profile can point at a managed slot under another ID.
  if (!binding && !fs.existsSync(path.join(directory, '.kamucl-managed-server'))) return undefined
  assertIdle(id, gameDir(), launchId, directory)
  return directories.acquire(directory, undefined, launchId)
}

export function endManagedLaunch(lease?: ManagedLaunchLease): void { if (lease) directories.release(lease) }

async function synchronize(discovered: DiscoveredManagedServer, folder: string, signal: AbortSignal, report: Report, launchLease?: ManagedLaunchLease): Promise<ManagedServerSyncResult> {
  return withGameFolder(folder, async () => {
    const manifest = discovered.manifest
    const id = managedInstanceId(manifest)
    const lease = directories.acquire(versionDir(id), launchLease)
    try {
      assertIdle(id, folder, launchLease?.launchId)
      signal.throwIfAborted()
      const target = versionDir(id)
      const versionsRoot = path.dirname(target)
      if (fs.existsSync(versionsRoot) && fs.lstatSync(versionsRoot).isSymbolicLink()) throw new Error('版本目录不能通过符号链接转向其他位置')
      if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw new Error('受管实例目录不能是符号链接')
      if (fs.existsSync(versionJsonPath(id))) {
        if (fs.lstatSync(versionJsonPath(id)).isSymbolicLink()) throw new Error('受管实例元数据不能是符号链接')
        const json = managedJson(id)
        if (!matchingManagedBinding(json._managedServer, manifest)) throw new Error('同名实例不是此服务器的受管实例；不会覆盖它，请先重命名该实例')
        if (json._managedServer?.publicKey && managedPublicKeyIdentity(json._managedServer.publicKey).fingerprint !== discovered.keyFingerprint) {
          throw new Error('此实例已绑定其他签名公钥；核实管理员的密钥更换后建立新的受管实例，不能静默覆盖信任')
        }
        const existing = scanInstalledFolder(folder).versions.find(version => version.id === id)
        if (!existing || existing.failed || existing.incomplete) throw new Error('受管实例基础安装不完整，请先在版本页清理安装残留后重试')
        if (existing.mcVersion !== manifest.minecraft || existing.loader !== manifest.loader.type || existing.loaderVersion !== manifest.loader.version) {
          throw new Error('受管实例运行环境元数据不匹配；不会向错误的 Minecraft/加载器实例写入模组')
        }
      } else {
        if (fs.existsSync(target)) throw new Error('目标实例目录已有内容；不会接管或覆盖未知目录')
        report({ stage: 'install', text: `安装 Minecraft ${manifest.minecraft} / ${manifest.loader.type} ${manifest.loader.version}` })
        const installedId = await installVersion(manifest.minecraft, {
          loader: manifest.loader.type as LoaderName, loaderVersion: manifest.loader.version, instanceName: id
        }, event => report({ stage: 'install', text: event.text || '安装运行环境', progress: event.overall ?? event.progress }), signal)
        if (installedId !== id) throw new Error('安装器返回了非预期实例；已停止同步，原有实例未被覆盖')
        const installed = scanInstalledFolder(folder).versions.find(version => version.id === id)
        if (!installed || installed.failed || installed.incomplete || installed.mcVersion !== manifest.minecraft ||
          installed.loader !== manifest.loader.type || installed.loaderVersion !== manifest.loader.version) {
          throw new Error('安装器没有生成服务器要求的准确游戏/加载器版本，已停止同步')
        }
        setNewInstanceIsolation(id, true)
        saveBinding(id, discovered) // Fail-closed even if a later pack download is cancelled.
      }
      const json = managedJson(id)
      const directory = instanceDirectoryState(id, json).path
      if (!samePath(directory, target) || json._gameDir !== true) throw new Error('受管同步只允许写入独立版本目录')
      assertIdle(id, folder, launchLease?.launchId)
      const result = await withFileJob(path.join(directory, 'mods'), signal, () =>
        syncManagedFiles(directory, manifest, fetchManagedBytes, signal, report, () => assertIdle(id, folder, launchLease?.launchId)))
      signal.throwIfAborted()
      saveBinding(id, discovered)
      const version = scanInstalledFolder(folder).versions.find(item => item.id === id)
      if (!version || version.failed || version.incomplete) throw new Error('同步后实例运行环境不完整，已阻止启动')
      const entry = servers.listServers().find(item => {
        try { return normalizeMinecraftAddress(item.address) === manifest.serverAddress } catch { return false }
      })
      if (entry) servers.bindServer(entry.id, id, folder)
      else {
        const entries = servers.addServer(manifest.packName || manifest.packId, manifest.serverAddress)
        const created = entries.find(item => item.address === manifest.serverAddress)
        if (created) servers.bindServer(created.id, id, folder)
      }
      report({ stage: 'done', text: '版本、加载器和客户端文件已校验同步；可以启动', progress: 1 })
      return { version, ...result }
    } finally { if (!launchLease) directories.release(lease) }
  })
}

export async function installManagedServer(discovered: DiscoveredManagedServer, folder: string, signal: AbortSignal, report: Report): Promise<ManagedServerSyncResult> {
  if (!discovered.trusted) throw new Error('尚未确认服务器签名公钥，不能安装客户端模组')
  return synchronize(discovered, folder, signal, report)
}

/** Called by the common launch entry point, including Home, Servers and retries. */
export async function prepareManagedLaunch(id: string, emit: ProgressEmit, signal: AbortSignal, requestedAddress?: string, lease?: ManagedLaunchLease): Promise<{ versionId: string; serverAddress: string } | undefined> {
  const binding = managedJson(id)._managedServer
  if (!binding) return undefined
  if (binding.schema !== 1 || typeof binding.address !== 'string' || typeof binding.packId !== 'string') throw new Error('受管实例绑定损坏，已阻止启动')
  if (requestedAddress && normalizeMinecraftAddress(requestedAddress) !== normalizeMinecraftAddress(binding.address)) throw new Error('此受管实例绑定了其他服务器，请从服务器同步入口建立对应实例')
  emit({ stage: 'download', progress: 0, text: '启动前验证服务器签名、版本和所有客户端文件…' })
  const discovered = await discoverManagedServer(binding.discoveryAddress || binding.address, fetchManagedBytes, signal,
    binding.publicKey ? { trustedPublicKey: binding.publicKey } : undefined)
  if (discovered.manifest.packId !== binding.packId) throw new Error('服务器整合包身份变化，必须重新确认，已阻止启动')
  const result = await synchronize(discovered, gameDir(), signal, progress => emit({
    stage: 'download', progress: progress.stage === 'downloading' && progress.totalBytes
      ? (progress.bytes ?? 0) / progress.totalBytes
      : progress.progress ?? (progress.total ? (progress.completed ?? 0) / progress.total : 0),
    bytesDone: progress.bytes, bytesTotal: progress.totalBytes, text: progress.text
  }), lease)
  return { versionId: result.version.id, serverAddress: discovered.manifest.serverAddress }
}

export function managedDownloadFolder(): string { return defaultFolderPath() }
