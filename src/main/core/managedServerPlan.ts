import { createHash } from 'node:crypto'

export interface ManagedBinding {
  schema: 1
  address: string
  packId: string
  publicKey?: string
  discoveryAddress?: string
}

export interface ManagedRuntime {
  minecraft: string
  loader: { type: string; version: string }
  packId: string
  serverAddress: string
}

/** Content updates reuse a slot; loader/MC upgrades get a new, isolated slot. */
export function managedInstanceId(manifest: ManagedRuntime): string {
  const identity = createHash('sha256').update(JSON.stringify([
    manifest.serverAddress.toLowerCase(), manifest.packId, manifest.minecraft, manifest.loader.type, manifest.loader.version
  ])).digest('hex').slice(0, 24)
  const safe = (value: string, length: number) => value.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, length)
  // Native instance names are limited to 64 characters. Hash full, untruncated
  // identity so long generic pack/loader names cannot collide through truncation.
  return `managed-${safe(manifest.packId, 8)}-${safe(manifest.minecraft, 6)}-${safe(manifest.loader.type, 5)}-${safe(manifest.loader.version, 8)}-${identity}`
}

export function matchingManagedBinding(value: unknown, manifest: ManagedRuntime): value is ManagedBinding {
  if (!value || typeof value !== 'object') return false
  const binding = value as Partial<ManagedBinding>
  return binding.schema === 1 && binding.address === manifest.serverAddress && binding.packId === manifest.packId
}

export function manifestIdentity(manifest: unknown): string {
  return createHash('sha256').update(JSON.stringify(manifest)).digest('hex')
}
