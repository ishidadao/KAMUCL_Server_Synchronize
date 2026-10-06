import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { generateKeyPairSync } from 'node:crypto'
import { ManagedServerTrustStore, managedPublicKeyIdentity } from '../src/main/core/managedServerTrust'

const key = () => generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' }).toString()
function fixture(t: TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-server-trust-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const filename = path.join(directory, 'trusted.json')
  return { filename, store: new ManagedServerTrustStore(filename) }
}

test('server trust is scoped per normalized server, persisted, and refuses implicit key rotation', t => {
  const { store, filename } = fixture(t), first = key(), second = key()
  assert.equal(store.find('example.test'), undefined)
  store.remember(['EXAMPLE.test', 'alias.test:25565'], first)
  assert.equal(store.find('example.test:25565')?.fingerprint, managedPublicKeyIdentity(first).fingerprint)
  assert.equal(new ManagedServerTrustStore(filename).find('alias.test')?.publicKey, managedPublicKeyIdentity(first).publicKey)
  assert.equal(store.find('example.test:25566'), undefined)
  assert.equal(store.find('other.test'), undefined)
  assert.throws(() => store.remember(['example.test'], second), /公钥发生变化/)
  assert.equal(store.find('example.test')?.fingerprint, managedPublicKeyIdentity(first).fingerprint)
  if (process.platform !== 'win32') assert.equal(fs.statSync(filename).mode & 0o777, 0o600)
})

test('corrupt trust and private keys cannot silently become trusted public keys', t => {
  const { store, filename } = fixture(t), pair = generateKeyPairSync('rsa', { modulusLength: 2048 })
  assert.throws(() => store.remember(['example.test'], pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()), /公钥格式/)
  fs.writeFileSync(filename, JSON.stringify({ schema: 1, servers: [{ address: 'example.test:25565', publicKey: key(), fingerprint: '0'.repeat(64) }] }))
  assert.throws(() => store.find('example.test'), /记录损坏/)
  assert.throws(() => store.remember(['other.test'], key()), /记录损坏/)
})
