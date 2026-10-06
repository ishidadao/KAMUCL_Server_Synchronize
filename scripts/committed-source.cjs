// Source distributions use committed blobs, not platform-dependent checkout bytes.
const path = require('node:path')
const { execFileSync, spawnSync } = require('node:child_process')
const BATCH_BYTES = 16 * 1024 * 1024
const MAX_BLOB_BYTES = 64 * 1024 * 1024
const MAX_SOURCE_BYTES = 512 * 1024 * 1024
const MAX_TREE_BYTES = 16 * 1024 * 1024
const MAX_SOURCE_FILES = 100000
// Only historical generated validation evidence is outside the corresponding
// build inputs. Keep its exact committed paths visible in the archive manifest.
const isExcludedNonBuildFile = file => /^docs\/validation-(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\/evidence\/.+$/.test(file)

function blobResponseBytes(row) {
  return Buffer.byteLength(row.oid + ' blob ' + row.size + '\n', 'ascii') + row.size + 1
}

function planBlobBatches(rows, budget = BATCH_BYTES) {
  if (!Number.isSafeInteger(budget) || budget < 1 || budget > BATCH_BYTES) throw Error('Invalid committed source batch budget')
  const batches = []; let current = [], bytes = 0
  for (const row of rows) {
    const required = blobResponseBytes(row)
    if (current.length && bytes + required > budget) { batches.push({ rows: current, bytes }); current = []; bytes = 0 }
    current.push(row); bytes += required
    // A single admitted blob may exceed the normal batch budget, never the fixed
    // individual-blob limit. Flush it alone instead of accumulating its neighbors.
    if (bytes >= budget) { batches.push({ rows: current, bytes }); current = []; bytes = 0 }
  }
  if (current.length) batches.push({ rows: current, bytes })
  return batches
}

function readCommittedSource(root, options = {}) {
  root = path.resolve(root)
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw Error('Invalid committed source options')
  const execute = options.execFileSync ?? execFileSync, spawn = options.spawnSync ?? spawnSync, budget = options.batchBytes ?? BATCH_BYTES
  if (typeof execute !== 'function' || typeof spawn !== 'function' || !Number.isSafeInteger(budget) || budget < 1 || budget > BATCH_BYTES) throw Error('Invalid committed source batch budget or command runner')
  const git = (args, maxBuffer = 64 * 1024) => execute('git', args, { cwd: root, maxBuffer })
  const commit = git(['rev-parse', 'HEAD']).toString('utf8').trim()
  const requireClean = () => {
    const dirty = spawn('git', ['diff', '--quiet', 'HEAD', '--'], { cwd: root })
    if (dirty.error) throw dirty.error
    if (dirty.status !== 0) throw Error('Commit tracked source before packaging or auditing delivery')
  }
  requireClean()
  let total = 0
  const tree = git(['ls-tree', '-r', '-z', '-l', '--full-tree', commit], MAX_TREE_BYTES).toString('utf8').split('\0').filter(Boolean)
  if (!tree.length) throw Error('No committed source files')
  if (tree.length > MAX_SOURCE_FILES) throw Error('Too many committed source files')
  const excludedNonBuildFiles = [], rows = []
  for (const row of tree) {
    const match = /^(\d+) (\w+) ([a-f\d]+) +(\d+|-)\t([\s\S]+)$/.exec(row)
    if (!match || !['100644', '100755'].includes(match[1]) || match[2] !== 'blob') throw Error('Source must be a committed ordinary file: ' + row)
    const file = match[5], parts = file.split('/')
    if (file.includes('\\') || file.startsWith('/') || parts[0].includes(':') || parts.some(p => !p || p === '.' || p === '..')) throw Error('Unsafe committed source path: ' + file)
    const size = Number(match[4])
    if (!Number.isSafeInteger(size) || size < 0) throw Error('Invalid committed source blob size: ' + file)
    if (isExcludedNonBuildFile(file)) { excludedNonBuildFiles.push(file); continue }
    if (size > MAX_BLOB_BYTES) throw Error('Committed source blob exceeds the 64 MiB safety limit: ' + file)
    total += size
    if (total > MAX_SOURCE_BYTES) throw Error('Committed source exceeds the 512 MiB safety limit')
    rows.push({ path: file, oid: match[3], size })
  }
  if (!rows.length) throw Error('No committed source files')
  const files = []
  for (const planned of planBlobBatches(rows, budget)) {
    const batch = execute('git', ['cat-file', '--batch'], {
      cwd: root, input: planned.rows.map(row => row.oid).join('\n') + '\n',
      // Git's declared sizes bound each call. This is not a whole-tree limit
      // increase: ordinary batches stay at 16 MiB plus small diagnostic room.
      maxBuffer: planned.bytes + 1024
    })
    let offset = 0
    for (const row of planned.rows) {
      const end = batch.indexOf(10, offset)
      if (end < 0) throw Error('Incomplete committed blob header')
      const header = batch.subarray(offset, end).toString('ascii').split(' '), size = Number(header[2])
      if (header.length !== 3 || header[0] !== row.oid || header[1] !== 'blob' || !Number.isSafeInteger(size) || size !== row.size || String(size) !== header[2]) throw Error('Unexpected committed blob')
      offset = end + 1
      if (offset + size >= batch.length || batch[offset + size] !== 10) throw Error('Incomplete committed blob content')
      const bytes = Buffer.from(batch.subarray(offset, offset + size)); offset += size + 1
      files.push({ path: row.path, oid: row.oid, bytes })
    }
    if (offset !== batch.length || batch.length !== planned.bytes) throw Error('Unexpected trailing committed blob content')
  }
  if (git(['rev-parse', 'HEAD']).toString('utf8').trim() !== commit) throw Error('Committed source changed during packaging')
  requireClean()
  return { commit, files, excludedNonBuildFiles }
}

module.exports = { readCommittedSource, planBlobBatches, isExcludedNonBuildFile }
