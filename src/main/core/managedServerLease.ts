import { pathIdentity } from './folderPaths'

export interface ManagedLaunchLease { readonly owner: symbol; readonly launchId?: string; readonly slots: Set<string> }

/** Covers preflight, runtime upgrades, file commits and the gap before JVM creation. */
export class ManagedDirectoryLeases {
  private slots = new Map<string, ManagedLaunchLease>()
  acquire(directory: string, lease?: ManagedLaunchLease, launchId?: string): ManagedLaunchLease {
    const key = pathIdentity(directory)
    this.assertAvailable(directory, lease)
    const owner = lease ?? { owner: Symbol('managed-directory'), launchId, slots: new Set<string>() }
    this.slots.set(key, owner)
    owner.slots.add(key)
    return owner
  }
  assertAvailable(directory: string, lease?: ManagedLaunchLease): void {
    const existing = this.slots.get(pathIdentity(directory))
    if (existing && existing !== lease) throw new Error('该实例正在同步或准备启动，请等待当前任务完成')
  }
  release(lease: ManagedLaunchLease): void {
    for (const slot of lease.slots) if (this.slots.get(slot) === lease) this.slots.delete(slot)
    lease.slots.clear()
  }
}
