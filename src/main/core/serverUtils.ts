import net from 'node:net'
import { domainToASCII } from 'node:url'

export interface ParsedServerAddress {
  host: string
  port: number
  explicitPort: boolean
  /** 交给 Minecraft 的地址；默认端口保持简洁，IPv6 始终加方括号。 */
  address: string
  /** 去重键，始终显式包含端口。 */
  normalizedAddress: string
}

function normalizedHost(value: string): string {
  const raw = value.trim().replace(/\.$/, '')
  if (!raw || /[\s/?#@]/.test(raw)) throw new Error('服务器地址格式无效')
  if (net.isIP(raw)) return raw.toLowerCase()
  const ascii = domainToASCII(raw).toLowerCase()
  if (!ascii || ascii.length > 253 || ascii.split('.').some((part) => !part || part.length > 63)) {
    throw new Error('服务器域名格式无效')
  }
  return ascii
}

function normalizedPort(value: string | undefined): { port: number; explicit: boolean } {
  if (value == null || value === '') return { port: 25565, explicit: false }
  if (!/^\d{1,5}$/.test(value)) throw new Error('服务器端口必须是 1 到 65535 的整数')
  const port = Number(value)
  if (port < 1 || port > 65535) throw new Error('服务器端口必须是 1 到 65535 的整数')
  return { port, explicit: true }
}

/**
 * 解析 Java 版服务器地址。支持域名、IPv4、[IPv6]:port 与裸 IPv6；
 * minecraft:// 仅作为用户从浏览器拖入/粘贴时的便利前缀，不保留路径与凭据。
 */
export function parseServerAddress(input: string): ParsedServerAddress {
  let raw = input.trim()
  if (/^minecraft:\/\//i.test(raw)) raw = raw.slice('minecraft://'.length)
  if (!raw) throw new Error('服务器地址不能为空')

  let hostRaw = raw
  let portRaw: string | undefined
  if (raw.startsWith('[')) {
    const closing = raw.indexOf(']')
    if (closing < 0) throw new Error('IPv6 地址缺少右方括号')
    hostRaw = raw.slice(1, closing)
    const rest = raw.slice(closing + 1)
    if (rest) {
      if (!rest.startsWith(':')) throw new Error('服务器地址格式无效')
      portRaw = rest.slice(1)
    }
  } else {
    const colonCount = (raw.match(/:/g) ?? []).length
    if (colonCount === 1) {
      const at = raw.lastIndexOf(':')
      hostRaw = raw.slice(0, at)
      portRaw = raw.slice(at + 1)
    } else if (colonCount > 1 && net.isIP(raw) !== 6) {
      throw new Error('IPv6 地址指定端口时请使用 [地址]:端口')
    }
  }

  const host = normalizedHost(hostRaw)
  const { port, explicit } = normalizedPort(portRaw)
  const shownHost = net.isIP(host) === 6 ? `[${host}]` : host
  return {
    host,
    port,
    explicitPort: explicit,
    address: explicit && port !== 25565 ? `${shownHost}:${port}` : shownHost,
    normalizedAddress: `${shownHost}:${port}`
  }
}

export function serverAssociationKey(
  normalizedAddress: string,
  versionId?: string,
  folderIdentity?: string,
  sourceIdentity?: string
): string {
  if (versionId) return `${normalizedAddress}\u0000${folderIdentity ?? ''}\u0000${versionId}`
  return `${normalizedAddress}\u0000shared\u0000${sourceIdentity ?? ''}`
}

/** 官方 Quick Play 参数自 Java 1.20 / 快照 23w14a 起受支持。 */
export function supportsQuickPlayMultiplayer(version: string): boolean {
  const release = /^(\d+)\.(\d+)(?:\.(\d+))?(?:$|[-+])/.exec(version.trim())
  if (release) {
    const major = Number(release[1])
    const minor = Number(release[2])
    return major > 1 || (major === 1 && minor >= 20)
  }
  const snapshot = /^(\d{2})w(\d{2})([a-z])$/i.exec(version.trim())
  if (!snapshot) return false
  const year = Number(snapshot[1])
  const week = Number(snapshot[2])
  const revision = snapshot[3].toLowerCase()
  return year > 23 || (year === 23 && (week > 14 || (week === 14 && revision >= 'a')))
}

/** 版本字符串能对应到一条 Minecraft 发布版或快照，而不是实例显示名 / 加载器 id。 */
function recognizedMinecraftVersion(version: string): boolean {
  const trimmed = version.trim()
  if (/^(\d+)\.(\d+)(?:\.(\d+))?(?:$|[-+])/.test(trimmed)) return true
  return /^(\d{2})w(\d{2})([a-z])$/i.test(trimmed)
}

/**
 * 决定「启动并连接」要追加的游戏参数。
 * 版本必须是真实 MC 版本：1.20+ / 23w14a+ 用 Quick Play；更旧的已识别版本用 --server/--port；
 * 解析不出版本时不注入参数。
 */
export function serverJoinArguments(version: string, address: string): { kind: 'quickPlay' | 'legacy' | 'skip'; args: string[] } {
  if (!recognizedMinecraftVersion(version) || version.trim() === '未知') return { kind: 'skip', args: [] }
  if (supportsQuickPlayMultiplayer(version)) return { kind: 'quickPlay', args: ['--quickPlayMultiplayer', address] }
  const parsed = parseServerAddress(address)
  return { kind: 'legacy', args: ['--server', parsed.host, '--port', String(parsed.port)] }
}
