import { app, ipcMain, type WebContents } from 'electron'
import crypto from 'node:crypto'
import path from 'node:path'
import { IPC, IPC_EVENT } from '../../shared/types'
import { discoverManagedServer, type DiscoveredManagedServer } from './managedServerProtocol'
import { fetchManagedBytes, installManagedServer, managedDownloadFolder, previewManagedServer } from './managedServerService'
import { manifestIdentity } from './managedServerPlan'
import { withDownloadFolder } from './paths'
import { ManagedServerTrustStore } from './managedServerTrust'

interface Inspection { owner: number; expires: number; discovered: DiscoveredManagedServer; folder: string }
interface Operation { owner: number; controller: AbortController; completion: Promise<unknown> }
const inspections = new Map<string, Inspection>()
const operations = new Map<string, Operation>()
const trustStore = () => new ManagedServerTrustStore(path.join(app.getPath('userData'), 'managed-server-trust.json'))

function operationName(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(value)) throw new Error('无效的同步任务编号')
  return value
}

async function run<T>(owner: WebContents, operation: string, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
  if (operations.has(operation)) throw new Error('该同步任务已在执行')
  if ([...operations.values()].filter(item => item.owner === owner.id).length >= 2) throw new Error('请先完成或取消已有同步任务')
  const controller = new AbortController()
  const destroyed = () => controller.abort(new Error('启动器窗口已关闭'))
  owner.once('destroyed', destroyed)
  const completion = Promise.resolve().then(() => action(controller.signal))
  operations.set(operation, { owner: owner.id, controller, completion })
  try { return await completion }
  finally { operations.delete(operation); owner.removeListener('destroyed', destroyed) }
}

export function registerManagedServerIpc(): void {
  ipcMain.handle(IPC.managedServerInspect, async (event, request: { address?: unknown; operation?: unknown }) => {
    const operation = operationName(request?.operation)
    if (typeof request?.address !== 'string' || request.address.length > 300) throw new Error('请输入有效服务器地址')
    const address = request.address
    return run(event.sender, operation, async signal => {
      for (const [key, item] of inspections) if (item.expires < Date.now() || item.owner === event.sender.id) inspections.delete(key)
      const trusted = trustStore().find(address)
      const discovered = await discoverManagedServer(address, fetchManagedBytes, signal,
        trusted ? { trustedPublicKey: trusted.publicKey } : { allowUntrustedPreview: true })
      const folder = withDownloadFolder(undefined, () => managedDownloadFolder())
      const inspectionId = crypto.randomUUID()
      if (inspections.size >= 32) throw new Error('待确认服务器过多，请重启启动器后重试')
      inspections.set(inspectionId, { owner: event.sender.id, expires: Date.now() + 10 * 60_000, discovered, folder })
      return previewManagedServer(discovered, inspectionId, folder)
    })
  })
  ipcMain.handle(IPC.managedServerSync, async (event, request: { inspectionId?: unknown; operation?: unknown; confirmTrust?: unknown }) => {
    const operation = operationName(request?.operation)
    const inspection = typeof request?.inspectionId === 'string' ? inspections.get(request.inspectionId) : undefined
    if (!inspection || inspection.owner !== event.sender.id || inspection.expires < Date.now()) throw new Error('服务器预览已过期，请重新检测后确认')
    if (!inspection.discovered.trusted && request.confirmTrust !== true) throw new Error('首次同步必须明确确认服务器公钥指纹和模组来源')
    return run(event.sender, operation, async signal => {
      const fresh = await discoverManagedServer(inspection.discovered.address, fetchManagedBytes, signal,
        { trustedPublicKey: inspection.discovered.publicKey })
      if (manifestIdentity(fresh.manifest) !== manifestIdentity(inspection.discovered.manifest)) throw new Error('服务器发布内容已变化，请重新检测并确认新版本')
      signal.throwIfAborted()
      trustStore().remember([fresh.address, fresh.manifest.serverAddress], fresh.publicKey)
      return withDownloadFolder(inspection.folder, () => installManagedServer(fresh, inspection.folder, signal, progress => {
        if (!event.sender.isDestroyed()) event.sender.send(IPC_EVENT.managedServerProgress, { operation, ...progress })
      }))
    })
  })
  ipcMain.handle(IPC.managedServerCancel, async (event, value: unknown) => {
    const operation = operations.get(operationName(value))
    if (!operation || operation.owner !== event.sender.id) return false
    operation.controller.abort(new Error('已取消服务器同步'))
    await operation.completion.catch(() => undefined)
    return true
  })
}
