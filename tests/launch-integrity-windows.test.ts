import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import type { LaunchArtifact } from '../src/main/core/launchIntegrity'

test('Windows integrity never reuses stat-only success after equal-size bytes change within a timestamp tick', async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'kamucl-integrity-win-'))
  const dest = path.join(root, 'client.jar'), bytes = Buffer.from('correct!')
  fs.writeFileSync(dest, bytes)
  const fixture = { stat: fs.statSync(dest, { bigint: true }), verifications: 0 }
  ;(globalThis as any).__launchIntegrityFixture = fixture
  try {
    const result = await build({
      stdin: { contents: "export { invalidLaunchArtifact } from './src/main/core/launchIntegrity'", resolveDir: process.cwd() },
      bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external',
      define: { 'process.platform': '"win32"' },
      plugins: [{ name: 'windows-stat-collision', setup(builder) {
        builder.onResolve({ filter: /^(node:fs|\.\/download)$/ }, args => ({ path: args.path, namespace: 'integrity-fixture' }))
        builder.onLoad({ filter: /.*/, namespace: 'integrity-fixture' }, args => ({ contents: args.path === 'node:fs'
          ? `import fs from 'fs'; export default {...fs, promises: {...fs.promises,
              lstat: async (file, options) => options?.bigint ? globalThis.__launchIntegrityFixture.stat : fs.promises.lstat(file, options)}}`
          : `import fs from 'fs'; import crypto from 'node:crypto';
              export const verifyFile = async (file, expected) => {
                globalThis.__launchIntegrityFixture.verifications++;
                const bytes = await fs.promises.readFile(file);
                if (expected.size !== undefined && bytes.length !== expected.size) return '文件大小不符';
                return crypto.createHash('sha1').update(bytes).digest('hex') === expected.sha1 ? null : 'sha1 校验失败';
              };
              export const downloadFile = async () => { throw new Error('This regression must not download'); }` }))
      } }]
    })
    const module = { exports: {} as { invalidLaunchArtifact: (file: LaunchArtifact) => Promise<string | null> } }
    new Function('require', 'module', 'exports', result.outputFiles[0].text)(createRequire(path.resolve('package.json')), module, module.exports)
    const artifact = { dest, size: bytes.length, sha1: crypto.createHash('sha1').update(bytes).digest('hex') }
    assert.equal(await module.exports.invalidLaunchArtifact(artifact), null)
    assert.equal(fixture.verifications, 1)
    fs.writeFileSync(dest, 'patched!')
    // Every stat field is deliberately frozen, not merely the timestamps.
    assert.match((await module.exports.invalidLaunchArtifact(artifact))!, /sha1/)
    assert.equal(fixture.verifications, 2, 'same metadata must not bypass a content read on Windows')
    fs.writeFileSync(dest, bytes)
    assert.equal(await module.exports.invalidLaunchArtifact(artifact), null)
    assert.equal(await module.exports.invalidLaunchArtifact(artifact), null)
    assert.equal(fixture.verifications, 4, 'even repeated valid Windows checks reread their contents')
  } finally { delete (globalThis as any).__launchIntegrityFixture; fs.rmSync(root, { recursive: true, force: true }) }
})
