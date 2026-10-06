import fs from 'node:fs'
import path from 'node:path'
import { createHash, createPublicKey, randomUUID } from 'node:crypto'
import { normalizeMinecraftAddress } from './managedServerProtocol'

export interface ManagedServerTrust { address: string; publicKey: string; fingerprint: string }

export function managedPublicKeyIdentity(publicKey: string): { publicKey: string; fingerprint: string } {
  if (typeof publicKey !== 'string' || publicKey.length > 16 * 1024 ||
      !/^-----BEGIN PUBLIC KEY-----\s[\s\S]+-----END PUBLIC KEY-----\s*$/.test(publicKey)) throw new Error('服务器公钥格式不正确')
  const key = createPublicKey(publicKey)
  const bits = key.asymmetricKeyDetails?.modulusLength ?? 0
  if (key.asymmetricKeyType !== 'rsa' || bits < 2048 || bits > 8192) throw new Error('服务器公钥必须为 2048–8192 位 RSA')
  return { publicKey: key.export({ type: 'spki', format: 'pem' }).toString(),
    fingerprint: createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex') }
}

/** Public keys only: first-use consent is saved per server, never accepted globally. */
export class ManagedServerTrustStore {
  constructor(private readonly filename: string) {}
  private read(): ManagedServerTrust[] {
    if (!fs.existsSync(this.filename)) return []
    const stat = fs.lstatSync(this.filename)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error('服务器信任记录不安全或损坏，已停止同步')
    const source = JSON.parse(fs.readFileSync(this.filename, 'utf8'))
    if (source.schema !== 1 || !Array.isArray(source.servers) || source.servers.length > 256) throw new Error('服务器信任记录损坏，已停止同步')
    const seen = new Set<string>()
    return source.servers.map((entry: ManagedServerTrust) => {
      const address = normalizeMinecraftAddress(entry.address), identity = managedPublicKeyIdentity(entry.publicKey)
      if (entry.fingerprint !== identity.fingerprint || seen.has(address)) throw new Error('服务器信任记录损坏，已停止同步')
      seen.add(address)
      return { address, ...identity }
    })
  }
  find(address: string): ManagedServerTrust | undefined {
    const normalized = normalizeMinecraftAddress(address)
    return this.read().find(entry => entry.address === normalized)
  }
  remember(addresses: string[], publicKey: string): void {
    const entries = this.read(), identity = managedPublicKeyIdentity(publicKey)
    for (const address of new Set(addresses.map(normalizeMinecraftAddress))) {
      const existing = entries.find(entry => entry.address === address)
      if (existing && existing.fingerprint !== identity.fingerprint) throw new Error('服务器签名公钥发生变化，已停止同步；请先向管理员核实密钥更换')
      if (!existing) entries.push({ address, ...identity })
    }
    if (entries.length > 256) throw new Error('受信任服务器数量已达上限')
    const directory = path.dirname(this.filename)
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
    if (fs.lstatSync(directory).isSymbolicLink()) throw new Error('服务器信任记录目录不能是符号链接')
    const temporary = `${this.filename}.${randomUUID()}.tmp`
    try {
      const descriptor = fs.openSync(temporary, 'wx', 0o600)
      try { fs.writeFileSync(descriptor, JSON.stringify({ schema: 1, servers: entries }, null, 2)); fs.fsyncSync(descriptor) }
      finally { fs.closeSync(descriptor) }
      fs.renameSync(temporary, this.filename)
    } finally { fs.rmSync(temporary, { force: true }) }
  }
}
