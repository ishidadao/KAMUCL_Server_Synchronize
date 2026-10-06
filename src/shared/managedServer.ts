import type { InstalledVersion, LoaderName } from './types'

/** Renderer-safe metadata; signed payloads and network access remain in the main process. */
export interface ManagedServerPreview {
  inspectionId: string
  address: string
  packId: string
  name: string
  packVersion?: string
  revision?: string
  minecraftVersion: string
  loader: LoaderName
  loaderVersion: string
  fileCount: number
  totalBytes: number
  keyFingerprint: string
  /** A valid self-signature is not first-use trust. Unknown publishers need explicit consent. */
  trusted: boolean
  existingInstance?: InstalledVersion
}

export interface ManagedServerProgress {
  operation: string
  stage: string
  text: string
  completed?: number
  total?: number
  bytes?: number
  totalBytes?: number
  progress?: number
}

export interface ManagedServerSyncResult {
  version: InstalledVersion
  added: number
  updated: number
  removed: number
  unchanged: number
  backupDirectory?: string
}
