#!/usr/bin/env node
'use strict'

// Original, dependency-free static publisher. It never reads a running world.
const fs = require('node:fs'), fsp = fs.promises, path = require('node:path')
const crypto = require('node:crypto'), { isIP } = require('node:net'), { spawnSync } = require('node:child_process')
const ROOTS = ['mods', 'config', 'defaultconfigs', 'kubejs', 'emotes', 'resourcepacks', 'shaderpacks']
const DOCUMENT_LIMIT = 16 * 1024 * 1024, FILE_LIMIT = 512 * 1024 * 1024, TOTAL_LIMIT = 20 * 1024 ** 3
const CHUNK = 1024 * 1024
const missing = error => error && error.code === 'ENOENT'
const checkText = (value, name, limit = 256) => {
  if (typeof value !== 'string' || !value || value.length > limit || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`Invalid ${name}`)
  return value
}
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)
async function stat(filename) { try { return await fsp.lstat(filename) } catch (error) { if (missing(error)) return undefined; throw error } }
async function directory(filename, create = false) {
  const absolute = path.resolve(filename), parsed = path.parse(absolute)
  let current = parsed.root
  for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part); let item = await stat(current)
    if (!item && create) { await fsp.mkdir(current, { mode: 0o700 }); item = await stat(current) }
    if (!item || !item.isDirectory() || item.isSymbolicLink()) throw new Error('Directory missing, linked or unsafe: ' + current)
  }
  return absolute
}
async function publicDirectory(filename, outputRoot) {
  await directory(filename, true)
  const root = path.resolve(outputRoot), relative = path.relative(root, path.resolve(filename))
  if (!contains(root, path.resolve(filename))) throw new Error('Public directory escaped output root')
  let current = root
  await fsp.chmod(current, 0o755)
  for (const part of relative.split(path.sep).filter(Boolean)) { current = path.join(current, part); await fsp.chmod(current, 0o755) }
}
function normalizeManagedPath(value) {
  const relative = checkText(value, 'managed path', 2048).replace(/\\/g, '/')
  const parts = relative.split('/')
  if (parts.length < 2 || !ROOTS.includes(parts[0]) || parts.some(part => !part || part === '.' || part === '..' || part.length > 255 || /[<>:"|?*\x00-\x1f\x7f]/.test(part) || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part))) throw new Error('Unsafe managed path: ' + relative)
  const lower = relative.toLowerCase()
  if (lower.startsWith('config/touhou_little_maid/sites/') || lower === 'config/netmusic-spotify-audio-bridge.properties' ||
    parts.some(part => /credentials|access[_-]?token|api[_-]?key|secret|^\.env(?:\.|$)/i.test(part)) || /\.(?:pem|key|pfx|p12|keystore|jks)$/i.test(relative)) throw new Error('Private credential path cannot be published: ' + relative)
  return relative
}
function checkCasePath(relative, identities, leaf = true) {
  const parts = relative.split('/')
  for (let index = 1; index <= parts.length; index++) {
    const prefix = parts.slice(0, index).join('/'), key = prefix.toLowerCase(), previous = identities.get(key), isLeaf = leaf && index === parts.length
    if (previous !== undefined && previous.spelling !== prefix) throw new Error('Case-conflicting managed path component: ' + prefix)
    if (previous !== undefined && previous.leaf !== isLeaf) throw new Error('File/directory-conflicting managed path component: ' + prefix)
    identities.set(key, { spelling: prefix, leaf: isLeaf })
  }
}
function glob(pattern) {
  checkText(pattern, 'exclude glob', 2048)
  pattern = pattern.replace(/\\/g, '/')
  if (pattern.startsWith('/') || pattern.split('/').some(part => part === '..' || part === '.')) throw new Error('Unsafe exclude glob')
  let result = '^'
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === '*' && pattern[i + 1] === '*') {
      i++; if (pattern[i + 1] === '/') { i++; result += '(?:.*/)?' } else result += '.*'
    } else if (pattern[i] === '*') result += '[^/]*'
    else if (pattern[i] === '?') result += '[^/]'
    else result += pattern[i].replace(/[\\^$+?.()|[\]{}]/g, '\\$&')
  }
  return new RegExp(result + '$', 'i')
}
function address(value) {
  let input = checkText(value, 'serverAddress', 300).toLowerCase(), host, port = 25565
  if (/[\s/\\?#@]/.test(input)) throw new Error('Invalid serverAddress')
  if (input.startsWith('[')) {
    const match = /^\[([^\]]+)\](?::([0-9]+))?$/.exec(input)
    if (!match || isIP(match[1]) !== 6) throw new Error('Invalid IPv6 serverAddress')
    host = new URL(`https://[${match[1]}]/`).hostname; if (match[2]) port = Number(match[2])
  } else {
    const match = /^([^:]+)(?::([0-9]+))?$/.exec(input)
    if (!match) throw new Error('Invalid serverAddress')
    host = match[1].replace(/\.$/, ''); if (match[2]) port = Number(match[2])
    if (!host || host.length > 253 || (!isIP(host) && !host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) || (/^[0-9.]+$/.test(host) && isIP(host) !== 4)) throw new Error('Invalid server host')
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid server port')
  return `${host}:${port}`
}
function version(value, name) {
  checkText(value, name, 80)
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(value) || value.includes('..') || /replace|edit.me/i.test(value) || /^(?:latest|stable|recommended|auto)$/i.test(value)) throw new Error('Set an exact valid ' + name)
  return value
}
function contains(parent, child) { const relative = path.relative(parent, child); return !relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)) }
function validateConfig(value, configPath) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schema !== 1 || value.clientPrepared !== true) throw new Error('Publish requires schema:1 and an explicitly reviewed clientPrepared:true bundle')
  const base = path.dirname(path.resolve(configPath)), resolve = name => path.resolve(base, checkText(value[name], name, 16384))
  const result = { ...value, clientRoot: resolve('clientRoot'), outputRoot: resolve('outputRoot'), privateKey: resolve('privateKey') }
  if (contains(result.clientRoot, result.outputRoot) || contains(result.outputRoot, result.clientRoot) || contains(result.outputRoot, result.privateKey) || contains(result.outputRoot, path.resolve(configPath)) || contains(result.clientRoot, result.privateKey) || contains(result.clientRoot, path.resolve(configPath))) throw new Error('Public output/client bundle must be separate from configuration and signing key')
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(checkText(value.packId, 'packId'))) throw new Error('Invalid packId')
  result.packName = checkText(value.packName, 'packName'); result.packVersion = version(value.packVersion, 'packVersion')
  result.minecraft = version(value.minecraft, 'minecraft')
  if (!value.loader || !['forge', 'neoforge', 'fabric', 'quilt'].includes(value.loader.type)) throw new Error('Invalid loader type')
  result.loader = { type: value.loader.type, version: version(value.loader.version, 'loader.version') }
  result.serverAddress = address(value.serverAddress)
  let url
  try { url = new URL(checkText(value.publicBaseUrl, 'publicBaseUrl', 4096)) } catch { throw new Error('Invalid publicBaseUrl') }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('publicBaseUrl requires plain HTTPS without credentials/query/fragment')
  if (url.port && !['443', '4443'].includes(url.port)) throw new Error('Discovery HTTPS port must be 443 or 4443')
  if (url.hostname !== new URL('https://' + result.serverAddress).hostname) throw new Error('Discovery and Minecraft must use the same server hostname')
  if (!url.pathname.endsWith('/')) url.pathname += '/'
  result.publicBaseUrl = url.href
  const allowed = value.allowRoots ?? ROOTS
  if (!Array.isArray(allowed) || !allowed.length || new Set(allowed).size !== allowed.length || allowed.some(root => !ROOTS.includes(root))) throw new Error('Invalid allowRoots')
  result.allowRoots = allowed
  const excludes = value.exclude ?? []
  if (!Array.isArray(excludes) || excludes.length > 256) throw new Error('Invalid exclude globs')
  result.excludeMatchers = excludes.map(glob)
  const removals = value.removeFiles ?? []
  if (!Array.isArray(removals) || removals.length > 20000) throw new Error('Invalid removeFiles')
  const seen = new Set(), removalCasePaths = new Map()
  result.removeFiles = removals.map(entry => {
    const relative = normalizeManagedPath(entry && entry.path), key = relative.toLowerCase()
    if (!allowed.includes(relative.split('/')[0]) || seen.has(key) || !/^[a-f0-9]{64}$/i.test(entry.sha256)) throw new Error('Invalid or duplicate removal')
    checkCasePath(relative, removalCasePaths)
    seen.add(key); return { path: relative, sha256: entry.sha256.toLowerCase() }
  })
  return result
}
async function readBounded(filename, limit) {
  await directory(path.dirname(filename)); const item = await stat(filename)
  if (!item || !item.isFile() || item.isSymbolicLink() || item.size > limit) throw new Error('Unsafe, missing or oversized file: ' + filename)
  const handle = await fsp.open(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.ino !== item.ino) throw new Error('File changed before reading')
    const buffer = Buffer.alloc(Math.min(CHUNK, limit + 1)), chunks = []; let total = 0
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, limit + 1 - total), null)
      if (!bytesRead) break
      total += bytesRead; if (total > limit) throw new Error('File grew beyond limit')
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)))
    }
    const after = await handle.stat(), current = await stat(filename)
    if (!current || current.isSymbolicLink() || current.ino !== item.ino || after.ino !== item.ino || after.size !== item.size || after.mtimeMs !== item.mtimeMs || total !== item.size) throw new Error('File changed while reading')
    return Buffer.concat(chunks, total)
  }
  finally { await handle.close() }
}
async function keyData(filename) {
  const item = await stat(filename)
  if (!item || item.isSymbolicLink() || !item.isFile() || (process.platform !== 'win32' && (item.mode & 0o077))) throw new Error('Signing key must be a private regular file (chmod 600)')
  if (process.platform === 'win32') {
    const script = "$ErrorActionPreference='Stop'; $allowed=@([Security.Principal.WindowsIdentity]::GetCurrent().User.Value,'S-1-5-18','S-1-5-32-544'); $bad=(Get-Acl -LiteralPath $env:KAMUCL_PRIVATE_KEY_CHECK).Access | Where-Object { $_.AccessControlType -eq 'Allow' -and $allowed -notcontains $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value }; if($bad){exit 1}"
    const checked = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 10000, env: { ...process.env, KAMUCL_PRIVATE_KEY_CHECK: filename }, encoding: 'utf8' })
    if (checked.status !== 0) throw new Error('Signing key ACL must allow only this user, Administrators and SYSTEM')
  }
  const privateKey = crypto.createPrivateKey(await readBounded(filename, 64 * 1024))
  if (privateKey.asymmetricKeyType !== 'rsa' || (privateKey.asymmetricKeyDetails.modulusLength ?? 0) < 3072 || privateKey.asymmetricKeyDetails.modulusLength > 8192) throw new Error('Signing key must be RSA 3072–8192 bits')
  const publicKey = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString()
  const fingerprint = crypto.createHash('sha256').update(crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' })).digest('hex')
  return { privateKey, publicKey, fingerprint }
}
async function hashFile(filename, copyTarget) {
  await directory(path.dirname(filename)); const before = await stat(filename)
  if (!before || !before.isFile() || before.isSymbolicLink() || before.size > FILE_LIMIT) throw new Error('Unsafe or oversized client/object file: ' + filename)
  const source = await fsp.open(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0)), hash = crypto.createHash('sha256')
  let target, total = 0
  try {
    const opened = await source.stat(); if (!opened.isFile() || opened.ino !== before.ino) throw new Error('File changed before reading')
    if (copyTarget) target = await fsp.open(copyTarget, 'wx', 0o600)
    const buffer = Buffer.alloc(CHUNK)
    while (true) {
      const { bytesRead } = await source.read(buffer, 0, buffer.length, null)
      if (!bytesRead) break
      total += bytesRead; if (total > FILE_LIMIT) throw new Error('File grew beyond limit')
      hash.update(buffer.subarray(0, bytesRead))
      if (target) { let offset = 0; while (offset < bytesRead) { const written = await target.write(buffer, offset, bytesRead - offset, null); if (!written.bytesWritten) throw new Error('Object write stopped'); offset += written.bytesWritten } }
    }
    const after = await source.stat(), current = await stat(filename)
    if (!current || current.isSymbolicLink() || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino || current.ino !== before.ino || total !== before.size) throw new Error('File changed while reading')
    if (target) await target.sync()
    return { sha256: hash.digest('hex'), size: total }
  } finally { if (target) await target.close(); await source.close() }
}
async function objectFile(source, outputRoot) {
  const content = await hashFile(source), relative = `objects/${content.sha256.slice(0, 2)}/${content.sha256}`
  const destination = path.join(outputRoot, ...relative.split('/')); await publicDirectory(path.dirname(destination), outputRoot)
  if (await stat(destination)) {
    const current = await hashFile(destination)
    if (current.sha256 !== content.sha256 || current.size !== content.size) throw new Error('Immutable object is corrupt; refused replacement')
    return { ...content, url: relative, created: false }
  }
  const temporary = path.join(path.dirname(destination), '.object-' + crypto.randomUUID())
  try {
    const copied = await hashFile(source, temporary)
    if (copied.sha256 !== content.sha256 || copied.size !== content.size) throw new Error('Source changed while copying')
    await fsp.chmod(temporary, 0o644); await fsp.rename(temporary, destination)
  } finally { await fsp.unlink(temporary).catch(error => { if (!missing(error)) throw error }) }
  return { ...content, url: relative, created: true }
}
async function atomic(filename, bytes, mode = 0o644, outputRoot) {
  if (outputRoot) await publicDirectory(path.dirname(filename), outputRoot)
  else await directory(path.dirname(filename), true)
  const existing = await stat(filename)
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new Error('Unsafe publish destination')
  const temporary = path.join(path.dirname(filename), '.publish-' + crypto.randomUUID()), handle = await fsp.open(temporary, 'wx', 0o600)
  try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
  try { await directory(path.dirname(filename)); const current = await stat(filename); if (current && (!current.isFile() || current.isSymbolicLink())) throw new Error('Destination changed'); await fsp.chmod(temporary, mode); await fsp.rename(temporary, filename) }
  finally { await fsp.unlink(temporary).catch(error => { if (!missing(error)) throw error }) }
}
function signed(payload, keys) {
  const bytes = Buffer.from(canonical(payload))
  if (bytes.length > DOCUMENT_LIMIT / 2) throw new Error('Manifest exceeds signed document limit')
  return { schema: 1, payload: bytes.toString('base64'), signature: crypto.sign('RSA-SHA256', bytes, { key: keys.privateKey, padding: crypto.constants.RSA_PKCS1_PADDING }).toString('base64'), publicKey: keys.publicKey }
}
async function lock(outputRoot) {
  const filename = path.join(outputRoot, '.managed-publisher.lock'), token = crypto.randomUUID()
  let handle
  try { handle = await fsp.open(filename, 'wx', 0o600) }
  catch (error) { if (error.code !== 'EEXIST') throw error; throw new Error('Publisher lock exists (live, stale or malformed); inspect the owner before explicitly removing this exact lock') }
  try { await handle.writeFile(JSON.stringify({ pid: process.pid, token })); await handle.sync() } finally { await handle.close() }
  return async () => { const value = JSON.parse((await readBounded(filename, 4096)).toString()); if (value.token !== token) throw new Error('Publisher lock ownership changed'); await fsp.unlink(filename) }
}
async function publish(configPath, options = {}) {
  const raw = JSON.parse((await readBounded(path.resolve(configPath), 1024 * 1024)).toString()), config = validateConfig(raw, configPath)
  await directory(config.clientRoot)
  for (const marker of ['world', 'server.properties', 'ops.json', 'whitelist.json']) if (await stat(path.join(config.clientRoot, marker))) throw new Error('Source looks like a raw server; prepare a separate reviewed CLIENT bundle')
  await publicDirectory(config.outputRoot, config.outputRoot)
  const realClient = await fsp.realpath(config.clientRoot), realOutput = await fsp.realpath(config.outputRoot)
  const realKey = await fsp.realpath(config.privateKey), realConfig = await fsp.realpath(configPath)
  if (contains(realClient, realOutput) || contains(realOutput, realClient) || contains(realOutput, realKey) || contains(realOutput, realConfig) || contains(realClient, realKey) || contains(realClient, realConfig)) throw new Error('Public output/client bundle aliases configuration or signing key')
  const reservedInodes = [await fsp.stat(realKey), await fsp.stat(realConfig)]
  const release = await lock(config.outputRoot)
  try {
    const keys = await keyData(config.privateKey), files = [], seen = new Set(), casePaths = new Map(), removed = new Set(config.removeFiles.map(entry => entry.path.toLowerCase()))
    for (const removal of config.removeFiles) checkCasePath(removal.path, casePaths)
    let total = 0, newObjects = 0
    async function walk(directoryName, prefix) {
      for (const name of (await fsp.readdir(directoryName)).sort()) {
        const relative = prefix + '/' + name
        // A directory prefix ending in /** must skip the directory itself before
        // private-path validation or traversal, not just files beneath it.
        if (config.excludeMatchers.some(match => match.test(relative) || match.test(relative + '/'))) continue
        const source = path.join(directoryName, name), entry = await stat(source)
        if (!entry || entry.isSymbolicLink()) throw new Error('Linked or changed client entry cannot be published')
        if (entry.isDirectory()) { normalizeManagedPath(relative + '/.path-validation'); checkCasePath(relative, casePaths, false); await walk(source, relative); continue }
        if (!entry.isFile()) throw new Error('Client entry is not a regular file')
        if (reservedInodes.some(reserved => reserved.dev === entry.dev && reserved.ino === entry.ino)) throw new Error('Client entry is a hard-link alias of private configuration or signing key')
        const managed = normalizeManagedPath(relative), key = managed.toLowerCase()
        checkCasePath(managed, casePaths)
        if (seen.has(key) || removed.has(key)) throw new Error('Duplicate, case-conflicting or removal-conflicting managed path')
        seen.add(key); if (seen.size > 20000) throw new Error('Too many managed files')
        total += entry.size; if (total > TOTAL_LIMIT) throw new Error('Managed files exceed total size limit')
        const content = await objectFile(source, config.outputRoot); if (content.created) newObjects++
        files.push({ path: managed, sha256: content.sha256, size: content.size, url: new URL(content.url, config.publicBaseUrl).href })
      }
    }
    for (const root of [...config.allowRoots].sort()) {
      const source = path.join(config.clientRoot, root), entry = await stat(source)
      if (!entry) continue
      if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error('Client managed root must be an ordinary directory')
      await walk(source, root)
    }
    files.sort((a, b) => a.path.toLowerCase().localeCompare(b.path.toLowerCase(), 'en'))
    const identity = { schema: 1, packId: config.packId, packName: config.packName, packVersion: config.packVersion, minecraft: config.minecraft, loader: config.loader, serverAddress: config.serverAddress, files, removeFiles: config.removeFiles }
    const now = new Date()
    let payload = { ...identity, publishedAt: now.toISOString(), contentRevision: now.toISOString().replace(/[-:.TZ]/g, '') }
    const manifestPath = path.join(config.outputRoot, 'manifest.json'), oldEntry = await stat(manifestPath)
    if (oldEntry) {
      const old = JSON.parse((await readBounded(manifestPath, DOCUMENT_LIMIT)).toString()), oldBytes = Buffer.from(old.payload ?? '', 'base64')
      if (old.schema === 1 && old.publicKey === keys.publicKey && crypto.verify('RSA-SHA256', oldBytes, { key: crypto.createPublicKey(keys.publicKey), padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(old.signature ?? '', 'base64'))) {
        const previous = JSON.parse(oldBytes.toString()), comparable = { ...previous }; delete comparable.publishedAt; delete comparable.contentRevision
        if (canonical(comparable) === canonical(identity)) payload = previous
      }
    }
    const manifestUrl = new URL('manifest.json', config.publicBaseUrl).href
    const discovery = kind => signed({ schema: 1, kind, packId: config.packId, manifestUrl, serverAddress: config.serverAddress }, keys)
    const generic = Buffer.from(canonical(discovery('kamucl-managed-server')) + '\n'), legacy = Buffer.from(canonical(discovery('pcl-managed-server')) + '\n')
    const documents = [
      ['manifest.json', Buffer.from(canonical(signed(payload, keys)) + '\n')],
      ['manifest.payload.json', Buffer.from(canonical(payload) + '\n')],
      ['.well-known/kamucl-managed.json', generic], ['.well-known/pcl-managed.json', legacy],
      ['discovery.json', generic], ['discovery.legacy.json', legacy]
    ]
    const previous = []
    for (const [name] of documents) {
      const filename = path.join(config.outputRoot, name), existing = await stat(filename)
      previous.push(existing ? await readBounded(filename, DOCUMENT_LIMIT) : null)
    }
    if (previous.every((bytes, index) => bytes !== null && bytes.equals(documents[index][1]))) return { changed: false, files: files.length, newObjects, fingerprint: keys.fingerprint }
    // Repair missing/outdated discovery after an interruption even when the manifest is unchanged.
    // Everything is validated/signed before touching the current metadata. Objects are immutable.
    if (options.beforeCommit) await options.beforeCommit()
    let applied = 0
    try { for (const [name, bytes] of documents) { await atomic(path.join(config.outputRoot, name), bytes, 0o644, config.outputRoot); applied++ } }
    catch (error) {
      for (let index = applied - 1; index >= 0; index--) {
        const filename = path.join(config.outputRoot, documents[index][0])
        if (previous[index] === null) await fsp.unlink(filename); else await atomic(filename, previous[index], 0o644, config.outputRoot)
      }
      throw error
    }
    return { changed: true, files: files.length, newObjects, revision: payload.contentRevision, fingerprint: keys.fingerprint }
  } finally { await release() }
}
async function initConfig(configPath) {
  const filename = path.resolve(configPath), base = path.dirname(filename), privateDirectory = path.join(base, 'private'), keyFile = path.join(privateDirectory, 'managed-signing-key.pem')
  await directory(base, true)
  if (await stat(filename) || await stat(keyFile)) throw new Error('Init never overwrites an existing config or signing key')
  await directory(privateDirectory, true)
  const key = crypto.generateKeyPairSync('rsa', { modulusLength: 3072 }).privateKey.export({ type: 'pkcs8', format: 'pem' })
  const config = { schema: 1, clientPrepared: false, clientRoot: './client-ready', outputRoot: './public', privateKey: './private/managed-signing-key.pem', publicBaseUrl: 'https://mc.example.com/managed/', serverAddress: 'mc.example.com:25565', packId: 'my-server', packName: 'My reviewed server client', packVersion: 'REPLACE_ME', minecraft: 'REPLACE_ME', loader: { type: 'forge', version: 'REPLACE_ME' }, allowRoots: ROOTS, exclude: ['**/.DS_Store', '**/*.download', '**/*.lock', 'config/touhou_little_maid/sites/**', 'config/netmusic-spotify-audio-bridge.properties'], removeFiles: [] }
  const keyHandle = await fsp.open(keyFile, 'wx', 0o600)
  try { await keyHandle.writeFile(key); await keyHandle.sync() } finally { await keyHandle.close() }
  if (process.platform === 'win32') {
    const script = "$ErrorActionPreference='Stop'; $user=[Security.Principal.WindowsIdentity]::GetCurrent().User; $acl=New-Object Security.AccessControl.FileSecurity; $acl.SetOwner($user); $acl.SetAccessRuleProtection($true,$false); foreach($sid in @($user.Value,'S-1-5-18','S-1-5-32-544')) { $id=New-Object Security.Principal.SecurityIdentifier($sid); $rule=New-Object Security.AccessControl.FileSystemAccessRule($id,'FullControl','Allow'); $acl.AddAccessRule($rule) }; Set-Acl -LiteralPath $env:KAMUCL_PRIVATE_KEY_CHECK -AclObject $acl"
    const restricted = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 10000, env: { ...process.env, KAMUCL_PRIVATE_KEY_CHECK: keyFile }, encoding: 'utf8' })
    if (restricted.status !== 0) throw new Error('Unable to create private Windows signing-key ACL; keep the key private and repair ACL before publishing')
  }
  const configHandle = await fsp.open(filename, 'wx', 0o600)
  try { await configHandle.writeFile(JSON.stringify(config, null, 2) + '\n'); await configHandle.sync() } finally { await configHandle.close() }
  return { config: filename, privateKeyCreated: true }
}
async function main(args = process.argv.slice(2)) {
  if (args.length !== 3 || !['init', 'publish'].includes(args[0]) || args[1] !== '--config') throw new Error('Usage: node publisher/managed-publisher.cjs <init|publish> --config /private/config.json')
  const result = args[0] === 'init' ? await initConfig(args[2]) : await publish(args[2])
  console.log(JSON.stringify(result))
}
module.exports = { initConfig, publish, validateConfig, normalizeManagedPath, checkCasePath, address, glob, main }
if (require.main === module) main().catch(error => { console.error('Publisher failed: ' + error.message); process.exitCode = 1 })
