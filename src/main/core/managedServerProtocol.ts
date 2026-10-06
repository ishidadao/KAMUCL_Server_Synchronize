import { createPublicKey, verify, createHash, constants } from 'node:crypto'
import { isIP } from 'node:net'

export type ManagedFetch = (url: string, options: { signal?: AbortSignal; maxBytes: number; onProgress?: (downloadedBytes: number) => void }) => Promise<Buffer>
export interface ManagedManifestFile { path: string; size: number; sha256: string; url: string }
export interface SignedManagedManifest {
  schema: 1; packId: string; packName?: string; packVersion?: string; contentRevision?: string
  minecraft: string; loader: { type: 'forge' | 'neoforge' | 'fabric' | 'quilt'; version: string }
  serverAddress: string; files: ManagedManifestFile[]; removeFiles: { path: string; sha256: string }[]
}
export interface DiscoveredManagedServer {
  address: string; discoveryUrl: string; manifestUrl: string; publicKey: string; keyFingerprint: string; trusted: boolean; manifest: SignedManagedManifest
}
export interface ManagedDiscoveryOptions { trustedPublicKey?: string; allowUntrustedPreview?: boolean }
export interface ManagedProgress { stage: string; text: string; completed?: number; total?: number; bytes?: number; totalBytes?: number; progress?: number }

export const MAX_MANAGED_DOCUMENT_BYTES = 16 * 1024 * 1024
export const MAX_MANAGED_FILE_BYTES = 512 * 1024 * 1024
export const MANAGED_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBojANBgkqhkiG9w0BAQEFAAOCAY8AMIIBigKCAYEArtthlrMQPmTy/1vmqWsx
QuDWWJWyph55l8cwCpvrlQYaoLJ2rCCdmbVXIhXE+CE9mex8lEJZs1ZQEhGFWj9D
5yzUSS8f7CqmTqu5gfJv5/0AL7hW6yS4yj2cSiS/+THBSSwSrMoRZG7S4k5DzVoJ
LIwOvhLOJaN1jtC6D5LrdeaUyoTANwwl4qo6e4r4V2HzcLpp29+6R/knL0fmRsfz
aMRfQGmyqvgjVQXjss18F8ti9oiW62xgA9PoKYpbUazFS7FAOguy5tY7Z9r3BMj7
AoVLLrEZVmPRy/X7gLFLkzRGL6p4rsizYg81qdJbY0Man18XXJOnX6SCpPJ5unmM
7jKV6b6HhSYd7LIpE68HEDlARYTVVY/45hI+9zJ7d2fDIctYC32l5paxrSf86fiU
sNsqTg5kBm0zQlVN751AS8GlUXRDzfcz/bXf1rj/GsmsoUV12eyCK+RA8QmU3lyI
KmFTfrWDxO/FBnCTthzTgSjXo8ZvAOff8IJZwMmlGm7rAgMBAAE=
-----END PUBLIC KEY-----`
export const MANAGED_KEY_FINGERPRINT = createHash('sha256').update(createPublicKey(MANAGED_PUBLIC_KEY).export({ type: 'spki', format: 'der' })).digest('hex')
const roots = new Set(['mods', 'config', 'defaultconfigs', 'kubejs', 'emotes', 'resourcepacks', 'shaderpacks'])
export const isManagedPackId = (value: unknown): value is string => typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(value)
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('服务器更新文档格式不正确')
  return value as Record<string, unknown>
}
function text(value: unknown, label: string, limit = 256): string {
  if (typeof value !== 'string' || !value || value.length > limit || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`${label}格式不正确`)
  return value
}
function parseAddress(input: string): { host: string; port: number } {
  if (typeof input !== 'string') throw new Error('请输入有效的 Minecraft 服务器地址')
  let value = input.trim()
  if (value.startsWith('minecraft://')) value = value.slice(12)
  if (!value || value.length > 300 || /[\s\x00-\x1f\x7f/\\?#@]/.test(value)) throw new Error('服务器地址应为域名或 IP，可附加端口')
  let host = value, port = 25565
  if (value.startsWith('[')) {
    const match = /^\[([^\]]+)\](?::([0-9]+))?$/.exec(value)
    if (!match || isIP(match[1]) !== 6) throw new Error('IPv6 地址格式不正确')
    host = match[1]; if (match[2]) port = Number(match[2])
  } else if (isIP(value) !== 6) {
    const parts = value.split(':')
    if (parts.length > 2 || (parts.length === 2 && !/^[0-9]+$/.test(parts[1]))) throw new Error('服务器端口格式不正确')
    host = parts[0]; if (parts.length === 2) port = Number(parts[1])
  }
  host = host.toLowerCase().replace(/\.$/, '')
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !host || host.length > 253) throw new Error('服务器地址或端口不正确')
  if (!isIP(host) && !host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) throw new Error('服务器主机名不正确')
  if (/^[0-9.]+$/.test(host) && isIP(host) !== 4) throw new Error('IPv4 地址不正确')
  if (host.includes(':') && isIP(host) !== 6) throw new Error('IPv6 地址不正确')
  if (isIP(host) === 6) host = new URL(`https://[${host}]/`).hostname.slice(1, -1)
  return { host, port }
}
export function normalizeMinecraftAddress(input: string): string {
  const { host, port } = parseAddress(input)
  return `${isIP(host) === 6 ? `[${host}]` : host}:${port}`
}
export function normalizeManagedPath(raw: unknown): string {
  const value = text(raw, '受管文件路径', 2048).replace(/\\/g, '/')
  const parts = value.split('/')
  if (parts.length < 2 || !roots.has(parts[0]) || parts.some(part => !part || part === '.' || part === '..' || part.length > 255 || /[<>:"|?*\x00-\x1f\x7f]/.test(part) || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part))) throw new Error(`不安全或不允许的受管文件路径：${value}`)
  const lower = value.toLowerCase()
  if (lower === 'config/touhou_little_maid/sites' || lower.startsWith('config/touhou_little_maid/sites/') || lower === 'config/netmusic-spotify-audio-bridge.properties') throw new Error('服务器私密配置不得分发到客户端')
  return value
}
function httpsUrl(value: unknown, label: string, base?: string): URL {
  let url: URL
  try { url = base ? new URL(text(value, label, 4096), base) : new URL(text(value, label, 4096)) } catch { throw new Error(`${label}不是有效的 HTTPS 地址`) }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error(`${label}必须使用无凭据的 HTTPS 地址`)
  return url
}
function digest(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/i.test(value)) throw new Error('受管文件 SHA-256 格式不正确')
  return value.toLowerCase()
}
function optionalText(source: Record<string, unknown>, name: string): string | undefined {
  return source[name] === undefined ? undefined : text(source[name], name)
}
export function validateManagedManifest(value: unknown, manifestUrl: string): SignedManagedManifest {
  const source = object(value), origin = httpsUrl(manifestUrl, '清单地址').origin
  if (source.schema !== 1 || !isManagedPackId(source.packId)) throw new Error('不支持的服务器清单版本或整合包身份')
  const loader = object(source.loader), type = text(loader.type, '加载器类型')
  if (!['forge', 'neoforge', 'fabric', 'quilt'].includes(type)) throw new Error('不支持的游戏加载器')
  const minecraft = text(source.minecraft, 'Minecraft 版本'), loaderVersion = text(loader.version, '加载器版本')
  if (!/^[a-zA-Z0-9._+-]+$/.test(minecraft) || !/^[a-zA-Z0-9._+-]+$/.test(loaderVersion)) throw new Error('游戏或加载器版本格式不正确')
  if (!Array.isArray(source.files) || source.files.length > 20000 || (source.removeFiles !== undefined && !Array.isArray(source.removeFiles))) throw new Error('受管文件列表格式不正确')
  const seen = new Set<string>(), removals = new Set<string>()
  type PathPrefix = { spelling: string; file: boolean; children: Map<string, PathPrefix> }
  const prefixes = new Map<string, PathPrefix>()
  // Full-path deduplication is insufficient on Windows: Foo/a + foo/b alias
  // the same directory, and a file can never also be another path's parent.
  const registerPath = (relative: string) => {
    const parts = relative.split('/'); let children = prefixes
    for (let index = 0; index < parts.length; index++) {
      const spelling = parts[index], key = spelling.toLowerCase()
      const file = index === parts.length - 1; let existing = children.get(key)
      if (existing && existing.spelling !== spelling) throw new Error('清单包含大小写冲突的文件或目录路径')
      if (existing && existing.file !== file) throw new Error('清单包含文件与目录路径前缀冲突')
      if (!existing) { existing = { spelling, file, children: new Map() }; children.set(key, existing) }
      children = existing.children
    }
  }
  let total = 0
  const files = source.files.map(raw => {
    const entry = object(raw), relative = normalizeManagedPath(entry.path), key = relative.toLowerCase()
    if (seen.has(key)) throw new Error('清单包含大小写冲突或重复文件路径')
    seen.add(key); registerPath(relative)
    if (typeof entry.size !== 'number' || !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > MAX_MANAGED_FILE_BYTES) throw new Error(`受管文件大小不正确：${relative}`)
    total += entry.size
    if (total > 20 * 1024 * 1024 * 1024) throw new Error('整合包文件总大小超过安全上限')
    const url = httpsUrl(entry.url, '文件下载地址', manifestUrl)
    if (url.origin !== origin) throw new Error('文件下载地址与签名清单不同源')
    return { path: relative, size: entry.size, sha256: digest(entry.sha256), url: url.href }
  })
  const removeFiles = ((source.removeFiles ?? []) as unknown[]).map(raw => {
    const entry = object(raw), relative = normalizeManagedPath(entry.path), key = relative.toLowerCase()
    if (seen.has(key) || removals.has(key)) throw new Error('清单的下载路径与移除路径冲突或重复')
    removals.add(key); registerPath(relative); return { path: relative, sha256: digest(entry.sha256) }
  })
  if (removeFiles.length > 20000) throw new Error('移除文件列表过大')
  return { schema: 1, packId: source.packId, packName: optionalText(source, 'packName'), packVersion: optionalText(source, 'packVersion'), contentRevision: optionalText(source, 'contentRevision'), minecraft, loader: { type: type as SignedManagedManifest['loader']['type'], version: loaderVersion }, serverAddress: normalizeMinecraftAddress(text(source.serverAddress, '联机地址', 300)), files, removeFiles }
}
function decodeBase64(value: unknown): Buffer {
  if (typeof value !== 'string' || !value || value.length % 4 !== 0 || !/^[a-zA-Z0-9+/]*={0,2}$/.test(value)) throw new Error('签名信封 Base64 格式不正确')
  const decoded = Buffer.from(value, 'base64')
  if (decoded.toString('base64') !== value) throw new Error('签名信封 Base64 格式不正确')
  return decoded
}
function parseEnvelope(envelope: Buffer | string): Record<string, unknown> {
  const bytes = Buffer.isBuffer(envelope) ? envelope : Buffer.from(envelope)
  if (bytes.length > MAX_MANAGED_DOCUMENT_BYTES) throw new Error('服务器更新文档超过大小上限')
  const parsed = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)))
  if (parsed.schema !== 1) throw new Error('不支持的签名信封版本')
  return parsed
}
export function managedPublicKeyInfo(value: unknown): { publicKey: string; keyFingerprint: string } {
  if (typeof value !== 'string' || value.length > 16 * 1024 || !/^-----BEGIN (RSA )?PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+\r?\n-----END (RSA )?PUBLIC KEY-----\s*$/.test(value.trim())) throw new Error('服务器公钥必须为大小受限的 RSA 公钥 PEM')
  const key = createPublicKey(value)
  const bits = key.asymmetricKeyDetails?.modulusLength ?? 0
  if (key.asymmetricKeyType !== 'rsa' || bits < 2048 || bits > 8192) throw new Error('服务器 RSA 公钥必须为 2048 至 8192 位')
  const der = key.export({ type: 'spki', format: 'der' })
  return { publicKey: key.export({ type: 'spki', format: 'pem' }).toString(), keyFingerprint: createHash('sha256').update(der).digest('hex') }
}
export function verifySignedEnvelope(envelope: Buffer | string, publicKey = MANAGED_PUBLIC_KEY): Record<string, unknown> {
  const parsed = parseEnvelope(envelope), trusted = managedPublicKeyInfo(publicKey)
  if (parsed.publicKey !== undefined && managedPublicKeyInfo(parsed.publicKey).keyFingerprint !== trusted.keyFingerprint) throw new Error('服务器公钥与已固定公钥不一致，已阻止启动')
  const payload = decodeBase64(parsed.payload), signature = decodeBase64(parsed.signature)
  const key = createPublicKey(trusted.publicKey)
  if (!verify('RSA-SHA256', payload, { key, padding: constants.RSA_PKCS1_PADDING }, signature)) throw new Error('服务器数字签名校验失败，已阻止启动')
  return object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload)))
}
export function verifySignedManifest(envelope: Buffer | string, manifestUrl: string, publicKey = MANAGED_PUBLIC_KEY): SignedManagedManifest {
  return validateManagedManifest(verifySignedEnvelope(envelope, publicKey), manifestUrl)
}
export async function discoverManagedServer(address: string, fetchBytes: ManagedFetch, signal?: AbortSignal, options: ManagedDiscoveryOptions = {}): Promise<DiscoveredManagedServer> {
  signal?.throwIfAborted()
  const normalized = normalizeMinecraftAddress(address), { host } = parseAddress(normalized)
  const urlHost = isIP(host) === 6 ? `[${host}]` : host
  let discoveryUrl = '', bytes: Buffer | undefined, lastError: unknown
  for (const port of [4443, 443]) {
    for (const endpoint of ['kamucl-managed.json', 'pcl-managed.json']) {
      discoveryUrl = `https://${urlHost}${port === 443 ? '' : ':4443'}/.well-known/${endpoint}`
      const timeout = AbortSignal.timeout(8000), probe = signal ? AbortSignal.any([signal, timeout]) : timeout
      try { bytes = await fetchBytes(discoveryUrl, { signal: probe, maxBytes: MAX_MANAGED_DOCUMENT_BYTES }); break } catch (error) { signal?.throwIfAborted(); lastError = error }
    }
    if (bytes !== undefined) break
  }
  if (bytes === undefined) throw new Error(`无法连接服务器签名更新服务：${lastError instanceof Error ? lastError.message : '网络不可用'}`)
  signal?.throwIfAborted()
  // Once a document has been obtained, an invalid signature must never trigger a fallback.
  const envelope = parseEnvelope(bytes)
  const advertised = managedPublicKeyInfo(envelope.publicKey ?? options.trustedPublicKey ?? MANAGED_PUBLIC_KEY)
  const pinned = options.trustedPublicKey ? managedPublicKeyInfo(options.trustedPublicKey) : undefined
  if (pinned && advertised.keyFingerprint !== pinned.keyFingerprint) throw new Error('服务器签名公钥发生变化，已阻止更新；不能自动接受密钥轮换')
  const trusted = !!pinned || advertised.keyFingerprint === MANAGED_KEY_FINGERPRINT
  if (!trusted && !options.allowUntrustedPreview) throw new Error('此服务器的签名公钥尚未确认，请先预览并核对公钥指纹后接入')
  const discovery = verifySignedEnvelope(bytes, advertised.publicKey)
  if (discovery.schema !== 1 || !['kamucl-managed-server', 'pcl-managed-server'].includes(String(discovery.kind)) || !isManagedPackId(discovery.packId)) throw new Error('服务器发现文档身份不正确')
  const manifestUrl = httpsUrl(discovery.manifestUrl, '清单地址')
  if (manifestUrl.origin !== new URL(discoveryUrl).origin) throw new Error('清单地址与签名发现接口不同源')
  const connectAddress = normalizeMinecraftAddress(text(discovery.serverAddress, '联机地址', 300))
  const manifest = verifySignedManifest(await fetchBytes(manifestUrl.href, { signal, maxBytes: MAX_MANAGED_DOCUMENT_BYTES }), manifestUrl.href, advertised.publicKey)
  if (manifest.packId !== discovery.packId) throw new Error('签名发现文档与清单的整合包身份不一致')
  if (manifest.serverAddress !== connectAddress) throw new Error('签名发现文档与清单的联机地址不一致')
  signal?.throwIfAborted()
  return { address: normalized, discoveryUrl, manifestUrl: manifestUrl.href, ...advertised, trusted, manifest }
}
