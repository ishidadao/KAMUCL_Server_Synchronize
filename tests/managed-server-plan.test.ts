import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { managedInstanceId, matchingManagedBinding, manifestIdentity } from '../src/main/core/managedServerPlan'
import { ManagedDirectoryLeases } from '../src/main/core/managedServerLease'

const runtime = { packId: 'the-fool', serverAddress: 'mc.example.test:25565', minecraft: '1.20.1', loader: { type: 'forge', version: '47.4.12' } }

test('managed runtime slots reuse content updates but preserve the old slot across MC/loader upgrades', () => {
  const id = managedInstanceId(runtime)
  assert.equal(managedInstanceId({ ...runtime, contentRevision: 'new' } as typeof runtime), id)
  assert.notEqual(managedInstanceId({ ...runtime, minecraft: '1.21.1' }), id)
  assert.notEqual(managedInstanceId({ ...runtime, loader: { type: 'forge', version: '47.4.13' } }), id)
  assert.notEqual(managedInstanceId({ ...runtime, loader: { type: 'neoforge', version: '47.4.12' } }), id)
  assert.notEqual(managedInstanceId({ ...runtime, serverAddress: 'other.example.test:25565' }), id)
  assert.match(id, /^[a-zA-Z0-9._-]+$/)
  const long = { ...runtime, packId: 'long'.repeat(16), loader: { type: 'neoforge', version: '1'.repeat(100) } }
  assert(managedInstanceId(long).length <= 64)
  assert.notEqual(managedInstanceId(long), managedInstanceId({ ...long, loader: { ...long.loader, version: long.loader.version + '2' } }))
})

test('managed bindings and preview identity require the same signed pack/server/content', () => {
  assert(matchingManagedBinding({ schema: 1, address: runtime.serverAddress, packId: runtime.packId }, runtime))
  for (const value of [null, {}, { schema: 2, address: runtime.serverAddress, packId: runtime.packId },
    { schema: 1, address: 'other.example.test:25565', packId: runtime.packId },
    { schema: 1, address: runtime.serverAddress, packId: 'other' }]) assert(!matchingManagedBinding(value, runtime))
  assert.equal(manifestIdentity(runtime), manifestIdentity(structuredClone(runtime)))
  assert.notEqual(manifestIdentity(runtime), manifestIdentity({ ...runtime, files: [{ sha256: 'changed' }] }))
})

test('managed lifecycle lease excludes concurrent sync/launch and retains source plus upgrade slots until spawn', () => {
  const leases = new ManagedDirectoryLeases(), source = path.resolve('source slot'), upgrade = path.resolve('upgrade slot')
  const own = leases.acquire(source, undefined, 'launch-one')
  assert.throws(() => leases.acquire(source, undefined, 'launch-two'), /同步或准备启动/)
  assert.throws(() => leases.assertAvailable(source), /同步或准备启动/)
  assert.doesNotThrow(() => leases.assertAvailable(source, own))
  assert.equal(leases.acquire(upgrade, own), own)
  assert.throws(() => leases.acquire(upgrade), /同步或准备启动/)
  const other = leases.acquire(path.resolve('independent slot'))
  leases.release(other)
  assert.throws(() => leases.assertAvailable(source), /同步或准备启动/)
  assert.throws(() => leases.assertAvailable(upgrade), /同步或准备启动/)
  leases.release(own)
  assert.doesNotThrow(() => leases.acquire(source))
  assert.doesNotThrow(() => leases.acquire(upgrade))
})
