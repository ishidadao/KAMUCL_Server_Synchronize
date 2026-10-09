import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import {
  parseServerAddress,
  serverAssociationKey,
  serverJoinArguments,
  supportsQuickPlayMultiplayer
} from '../src/main/core/serverUtils'

test('server addresses normalize default ports, case and browser protocol', () => {
  assert.deepEqual(parseServerAddress(' Minecraft://Play.Example.COM.:25565 '), {
    host: 'play.example.com',
    port: 25565,
    explicitPort: true,
    address: 'play.example.com',
    normalizedAddress: 'play.example.com:25565'
  })
  assert.equal(
    parseServerAddress('play.example.com').normalizedAddress,
    parseServerAddress('PLAY.EXAMPLE.COM:25565').normalizedAddress
  )
})

test('server addresses support IPv4 and bracketed or bare IPv6', () => {
  assert.equal(parseServerAddress('127.0.0.1:25566').address, '127.0.0.1:25566')
  assert.equal(parseServerAddress('[2001:db8::1]:25566').normalizedAddress, '[2001:db8::1]:25566')
  assert.equal(parseServerAddress('2001:db8::1').address, '[2001:db8::1]')
})

test('server addresses reject paths, credentials and invalid ports', () => {
  for (const address of [
    'example.com/path',
    'user@example.com',
    'example.com:0',
    'example.com:65536',
    '[2001:db8::1]extra'
  ]) {
    assert.throws(() => parseServerAddress(address))
  }
})

test('server association keys allow one endpoint to belong to multiple instances', () => {
  const endpoint = 'example.com:25565'
  assert.notEqual(
    serverAssociationKey(endpoint, '1.20.1', 'c:/one'),
    serverAssociationKey(endpoint, '1.20.1', 'd:/two')
  )
  assert.notEqual(
    serverAssociationKey(endpoint, '1.20.1', 'c:/one'),
    serverAssociationKey(endpoint, '1.21', 'c:/one')
  )
})

test('Quick Play multiplayer is limited to officially supported versions', () => {
  assert.equal(supportsQuickPlayMultiplayer('1.19.4'), false)
  assert.equal(supportsQuickPlayMultiplayer('1.20'), true)
  assert.equal(supportsQuickPlayMultiplayer('1.20.1'), true)
  assert.equal(supportsQuickPlayMultiplayer('1.21.11'), true)
  assert.equal(supportsQuickPlayMultiplayer('23w13a'), false)
  assert.equal(supportsQuickPlayMultiplayer('23w14a'), true)
  assert.equal(supportsQuickPlayMultiplayer('unknown'), false)
})

test('server join uses the real version: quick play, legacy, or skip', () => {
  assert.deepEqual(serverJoinArguments('1.20.1', 'play.example.com'), {
    kind: 'quickPlay',
    args: ['--quickPlayMultiplayer', 'play.example.com']
  })
  assert.equal(serverJoinArguments('1.21.1', 'play.example.com:25566').kind, 'quickPlay')
  assert.equal(serverJoinArguments('23w14a', 'play.example.com').kind, 'quickPlay')
  assert.deepEqual(serverJoinArguments('1.19.4', 'play.example.com:25566'), {
    kind: 'legacy',
    args: ['--server', 'play.example.com', '--port', '25566']
  })
  assert.deepEqual(serverJoinArguments('1.16.5', 'play.example.com').args, ['--server', 'play.example.com', '--port', '25565'])
  assert.equal(serverJoinArguments('23w13a', 'play.example.com').kind, 'legacy')
  for (const version of ['愚者', '未知', 'fabric-loader-0.16.10-1.20.1', 'unknown']) {
    assert.equal(serverJoinArguments(version, 'play.example.com').kind, 'skip', version)
  }
})

test('launch decides server join from the resolved Minecraft version', () => {
  const launch = fs.readFileSync('src/main/core/launch.ts', 'utf8')
  assert.match(launch, /serverJoinArguments\(\s*(?:instanceMcVersion|minecraftVersion)/)
  assert.doesNotMatch(launch, /const minecraftVersion = instanceConfig\._mcVersion \?\? baseId/)
})
