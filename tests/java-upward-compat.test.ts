import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { selectJavaByMajor, requiredMajor } from '../src/main/core/java'

const read = (file: string) => fs.readFileSync(file, 'utf8')
const j = (major: number, is64Bit = true) => ({ major, is64Bit, path: `C:/Java/jdk-${major}/bin/java.exe`, version: String(major) })

test('Java selection: pin exact for need < 17; highest >= need for 17+', () => {
  const system = [j(8), j(17), j(21), j(25)]
  // 旧版需 Java 8：有 8 时钉死 8，不选 25
  assert.equal(selectJavaByMajor(system, 8)?.major, 8)
  // 1.17 需 16：有 16 时钉死 16
  assert.equal(selectJavaByMajor([j(8), j(16), j(17), j(21)], 16)?.major, 16)
  // 无精确 8 时才退回最高 >= 8
  assert.equal(selectJavaByMajor([j(17), j(21)], 8)?.major, 21)
  // need 17+：仍取 >= need 的最高主版本
  assert.equal(selectJavaByMajor(system, 17)?.major, 25)
  // 仅装 Java 21 无 Java 17：1.20.1（需 17）向上兼容选 21
  assert.equal(selectJavaByMajor([j(21)], 17)?.major, 21)
  assert.equal(selectJavaByMajor([j(8), j(21), j(25)], 17)?.major, 25)
  // 32 位不满足
  assert.equal(selectJavaByMajor([{ ...j(21), is64Bit: false }], 17), null)
  // 全部低于需求 → null（触发下载）
  assert.equal(selectJavaByMajor([j(8)], 17), null)
  // 空系统 → null
  assert.equal(selectJavaByMajor([], 8), null)
})

test('known release Java requirements include 26.1 Java 25; unknown snapshots and custom profiles do not default to 21', () => {
  const v = (id: string) => ({ id }) as any
  assert.equal(requiredMajor(v('1.8.9')), 8)
  assert.equal(requiredMajor(v('1.12.2')), 8)
  assert.equal(requiredMajor(v('1.16.5')), 8)
  assert.equal(requiredMajor(v('1.17')), 16)
  assert.equal(requiredMajor(v('1.17.1')), 16)
  assert.equal(requiredMajor(v('1.18')), 17)
  assert.equal(requiredMajor(v('1.20.1')), 17)
  assert.equal(requiredMajor(v('1.20.4')), 17)
  assert.equal(requiredMajor(v('1.20.5')), 21)
  assert.equal(requiredMajor(v('1.21.1')), 21)
  assert.equal(requiredMajor(v('26.1')), 25)
  assert.throws(() => requiredMajor(v('26.2')), /无法确认/)
  assert.throws(() => requiredMajor(v('24w14a')), /无法确认/)
  assert.throws(() => requiredMajor(v('my-custom-pack')), /无法确认/)
  // 无法识别的 id 不会猜 21；已知发行版不被过期 javaVersion 压低
  assert.equal(requiredMajor({ id: 'x', javaVersion: { majorVersion: 25 } } as any), 25)
  assert.equal(requiredMajor({ id: '1.20.1', javaVersion: { majorVersion: 21 } } as any), 17)
  assert.equal(requiredMajor({ id: '愚者', javaVersion: { majorVersion: 17 } } as any), 17)
  // 过期的 majorVersion 17 不能把 1.20.5+ 压回 17
  assert.equal(requiredMajor({ id: '1.20.5', javaVersion: { majorVersion: 17 } } as any), 21)
  assert.equal(requiredMajor({ id: '1.21', javaVersion: { majorVersion: 17 } } as any), 21)
  assert.equal(requiredMajor({ id: '愚者', _mcVersion: '1.21.1', javaVersion: { majorVersion: 17 } } as any), 21)
  assert.equal(requiredMajor({ id: '愚者', _mcVersion: '1.20.1', javaVersion: { majorVersion: 17 } } as any), 17)
})

test('launch, installer repair and diagnostics share the compatibility resolver', () => {
  const java = read('src/main/core/java.ts')
  assert.match(java, /prepareCompatibleJava/)
  assert.match(read('src/main/core/launch.ts'), /resolveJavaRequirement\(merged, instanceMcVersion/)
  assert.match(read('src/main/core/instanceDiagnostics.ts'), /resolveJavaRequirement\(merged/)
  assert.match(read('src/main/core/loaders.ts'), /ensureJava\(baseJson, emit, mc\)/)
  assert.match(read('src/main/core/javaCompatibility.ts'), /recommendedMajor >= 17/)
  assert.match(read('src/main/core/javaCompatibility.ts'), /优先精确匹配/)
})
