<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { ManagedServerPreview, ManagedServerProgress, ManagedServerSyncResult } from '@shared/managedServer'
import { cancelManagedServer, errText, inspectManagedServer, onManagedServerProgress, syncManagedServer } from '../api'
import UpdateDialogShell from './UpdateDialogShell.vue'

const props = defineProps<{ initialAddress?: string }>()
const emit = defineEmits<{ dismiss: []; installed: [result: ManagedServerSyncResult]; viewInstance: [] }>()
const address = ref(props.initialAddress ?? '')
const preview = ref<ManagedServerPreview | null>(null)
const result = ref<ManagedServerSyncResult | null>(null)
const phase = ref<'idle' | 'inspecting' | 'syncing'>('idle')
const error = ref(''), notice = ref(''), cancellationRequested = ref(false)
const trustConfirmed = ref(false)
const progress = ref<ManagedServerProgress | null>(null)
const busy = computed(() => phase.value !== 'idle')
const requiresTrustConfirmation = computed(() => !!preview.value && preview.value.trusted !== true)
const canSync = computed(() => !busy.value && !!preview.value && !result.value &&
  (!requiresTrustConfirmation.value || trustConfirmed.value))
const downloading = computed(() => ['download', 'downloading'].includes(progress.value?.stage ?? ''))
const stageLabel = computed(() => {
  const labels: Record<string, string> = {
    inspect: '检查服务器', discovery: '验证服务器发布信息', discovering: '验证服务器发布信息',
    recovering: '恢复上次中断的同步', checking: '校验已有文件', verify: '校验文件', validating: '校验文件',
    install: '安装游戏与加载器', installing: '安装游戏与加载器',
    download: '下载更新文件', downloading: '下载更新文件',
    apply: '应用并备份变更', applying: '应用并备份变更', complete: '文件同步完成', done: '同步完成'
  }
  return labels[progress.value?.stage ?? ''] ?? (phase.value === 'inspecting' ? '检查服务器' : '准备同步')
})
const percent = computed(() => {
  const event = progress.value
  if (!event) return null
  let fraction: number | undefined
  // File counts stay at zero until a large JAR finishes. Streamed bytes are the
  // accurate download indicator, even when the backend also reports file counts.
  if (downloading.value && typeof event.bytes === 'number' && Number.isFinite(event.bytes) && event.bytes >= 0 &&
      typeof event.totalBytes === 'number' && Number.isFinite(event.totalBytes) && event.totalBytes > 0) {
    fraction = event.bytes / event.totalBytes
  } else if (typeof event.progress === 'number' && Number.isFinite(event.progress)) {
    fraction = event.progress
  } else if (typeof event.completed === 'number' && Number.isFinite(event.completed) && event.completed >= 0 &&
      typeof event.total === 'number' && Number.isFinite(event.total) && event.total > 0) {
    fraction = event.completed / event.total
  }
  if (fraction === undefined) return null
  const maximum = busy.value && !['complete', 'done'].includes(event.stage) ? 99 : 100
  return Math.min(maximum, Math.round(Math.max(0, Math.min(1, fraction)) * 100))
})
const downloadedText = computed(() => {
  const event = progress.value
  if (!downloading.value || !event || typeof event.bytes !== 'number' || !Number.isFinite(event.bytes) || event.bytes < 0) return ''
  const total = typeof event.totalBytes === 'number' && Number.isFinite(event.totalBytes) && event.totalBytes >= 0
    ? ` / ${bytes(event.totalBytes)}` : ''
  return `已下载 ${bytes(event.bytes)}${total}`
})
const loaderLabel = computed(() => ({ forge: 'Forge', neoforge: 'NeoForge', fabric: 'Fabric', quilt: 'Quilt' })[preview.value?.loader ?? 'forge'])
let operation = '', epoch = 0, offProgress: (() => void) | undefined

function bytes(value: number): string {
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GiB`
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MiB`
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KiB`
  return `${value} B`
}

watch(address, () => {
  trustConfirmed.value = false
  if (busy.value) return
  preview.value = null
  result.value = null
  error.value = ''
  notice.value = ''
  progress.value = null
}, { flush: 'sync' })

onMounted(() => {
  offProgress = onManagedServerProgress(event => {
    // Late events from an old or another window's task cannot replace this preview.
    if (busy.value && event.operation === operation) progress.value = event
  })
})
onBeforeUnmount(() => {
  ++epoch
  if (busy.value && operation) void cancelManagedServer(operation).catch(() => {})
  offProgress?.()
})

function begin(next: 'inspecting' | 'syncing'): number {
  operation = crypto.randomUUID()
  phase.value = next
  error.value = ''
  notice.value = ''
  progress.value = null
  cancellationRequested.value = false
  return ++epoch
}

function handleError(caught: unknown) {
  const message = errText(caught)
  if (cancellationRequested.value && /cancel|abort|取消|中止/i.test(message)) {
    notice.value = '操作已取消；请重新检查后再同步。'
    preview.value = null
  } else error.value = message
}

async function inspect() {
  if (busy.value || !address.value.trim()) return
  const requestedAddress = address.value.trim()
  const current = begin('inspecting')
  preview.value = null
  result.value = null
  trustConfirmed.value = false
  try {
    const metadata = await inspectManagedServer({ address: requestedAddress, operation })
    if (current === epoch) {
      if (address.value.trim() === requestedAddress) preview.value = metadata
      else notice.value = '地址已改变，请重新检查服务器。'
    }
  } catch (caught) {
    if (current === epoch) handleError(caught)
  } finally {
    if (current === epoch) { phase.value = 'idle'; cancellationRequested.value = false }
  }
}

async function sync() {
  if (!canSync.value || !preview.value) return
  const inspectionId = preview.value.inspectionId
  const confirmTrust = requiresTrustConfirmation.value && trustConfirmed.value
  const current = begin('syncing')
  try {
    const completed = await syncManagedServer({ inspectionId, operation, confirmTrust })
    if (current !== epoch) return
    result.value = completed
    if (preview.value) preview.value = { ...preview.value, trusted: true }
    notice.value = '同步已完成，专用隔离实例已就绪。不会自动启动游戏。'
    emit('installed', completed)
  } catch (caught) {
    if (current === epoch) handleError(caught)
  } finally {
    if (current === epoch) { phase.value = 'idle'; cancellationRequested.value = false }
  }
}

async function cancel() {
  if (!busy.value || cancellationRequested.value || !operation) return
  const current = epoch, requestedOperation = operation
  cancellationRequested.value = true
  notice.value = '正在请求取消，等待当前任务安全结束…'
  try {
    const accepted = await cancelManagedServer(requestedOperation)
    if (current === epoch && busy.value && !accepted) {
      cancellationRequested.value = false
      notice.value = '任务已进入收尾阶段或已结束，正在等待最终结果…'
    }
  } catch (caught) {
    if (current === epoch && busy.value) {
      cancellationRequested.value = false
      error.value = '取消请求失败：' + errText(caught)
    }
  }
  // Do not clear busy or close the dialog before the main process settles.
}

function dismiss() {
  if (busy.value) { void cancel(); return }
  emit('dismiss')
}
</script>

<template>
  <UpdateDialogShell label="从服务器同步游戏与模组" @dismiss="dismiss">
    <template #header>
      <div class="managed-header"><div><h2>从服务器同步</h2><p class="connection-muted">输入地址，检查游戏版本、加载器及签名文件清单。</p></div><button type="button" class="btn btn-ghost" :disabled="busy" aria-label="关闭服务器同步" @click="dismiss">×</button></div>
    </template>
    <div class="managed-content">
      <form class="managed-address" @submit.prevent="inspect">
        <label for="managed-server-address">Minecraft 服务器地址</label>
        <div><input id="managed-server-address" v-model="address" class="input mono" placeholder="mc.example.com 或 mc.example.com:25565" autocomplete="off" spellcheck="false" :disabled="busy" aria-describedby="managed-discovery-help" /><button type="submit" class="btn btn-ghost" :disabled="busy || !address.trim()">{{ phase === 'inspecting' ? '检查中…' : preview || result ? '重新检查' : '检查服务器' }}</button></div>
      </form>
      <p id="managed-discovery-help" class="connection-muted">服务器必须部署兼容 KAMUCL/PCL 协议的 HTTPS 发现服务并发布签名清单。普通 Minecraft 状态响应不能可靠推断 Forge 或模组列表；首次连接需核对管理员提供的公钥指纹。</p>

      <section v-if="preview" class="managed-preview" aria-label="服务器整合包预览">
        <div><h3>{{ preview.name }}</h3><span class="managed-verified">签名校验通过 · SHA-256 文件校验</span></div>
        <dl class="managed-facts"><div><dt>Minecraft</dt><dd>{{ preview.minecraftVersion }}</dd></div><div><dt>{{ loaderLabel }}</dt><dd>{{ preview.loaderVersion }}</dd></div><div><dt>整合包版本</dt><dd>{{ preview.packVersion || '未标注' }}</dd></div><div><dt>发布修订</dt><dd>{{ preview.revision || '未标注' }}</dd></div><div><dt>同步清单</dt><dd>{{ preview.fileCount }} 个文件</dd></div><div><dt>清单总大小</dt><dd>{{ bytes(preview.totalBytes) }}</dd></div><div><dt>签名联机地址</dt><dd class="mono">{{ preview.address }}</dd></div></dl>
        <div class="managed-target"><strong>{{ preview.existingInstance ? '更新已有受管理隔离实例' : '安装新的专用隔离实例' }}</strong><p v-if="preview.existingInstance" class="mono">{{ preview.existingInstance.id }}<br />{{ preview.existingInstance.folder }}</p><p v-else>游戏版本和 {{ loaderLabel }} 版本由签名清单指定，无需手动选择；不会覆盖普通游戏实例。</p></div>
        <section class="managed-signature" aria-label="服务器公钥与信任状态"><strong>服务器公钥指纹（SHA-256）</strong><p class="mono">{{ preview.keyFingerprint }}</p><p>{{ preview.trusted ? '已信任的服务器公钥；后续连接仍会核对固定指纹。' : '首次信任此服务器：有效签名只证明清单与该公钥一致，不能代替核对管理员身份。' }}</p></section>
        <div v-if="requiresTrustConfirmation" class="managed-trust"><p id="managed-trust-warning">请通过服务器管理员的独立可信渠道核对上面的完整指纹。确认后会固定此服务器公钥；公钥改变会拒绝同步，不会自动重新信任。</p><label><input v-model="trustConfirmed" type="checkbox" :disabled="busy" aria-describedby="managed-trust-warning" /> <span>我已核对管理员提供的公钥指纹，并信任此服务器的模组来源（模组可执行代码）</span></label></div>
        <p class="connection-muted">模组可以执行代码，请仅同步你信任的服务器。受管理文件将按内容校验并更新，同名但内容不同的 JAR 也会替换；本地修改或旧文件的备份由同步结果列出。</p>
      </section>

      <section v-if="busy" class="managed-progress" aria-label="服务器同步进度" aria-live="polite">
        <p class="managed-progress-heading"><strong>{{ stageLabel }}</strong><span v-if="percent !== null">{{ percent }}%</span><span v-else>处理中…</span></p>
        <p>{{ progress?.text || (phase === 'inspecting' ? '正在获取并验证服务器清单…' : '正在准备游戏版本和同步文件…') }}</p>
        <progress :value="percent === null ? undefined : percent" max="100" aria-label="当前阶段进度" :aria-valuetext="stageLabel + (percent === null ? '，处理中' : '，' + percent + '%')" />
        <p v-if="downloadedText" class="managed-download-bytes">{{ downloadedText }}</p>
        <div v-if="progress?.completed !== undefined && progress?.total !== undefined" class="connection-muted">{{ downloading ? '已完成下载文件' : '当前阶段已处理' }} {{ progress.completed }} / {{ progress.total }} 项</div>
        <p class="connection-muted">进度条显示当前阶段，不是所有步骤的总进度；下载后还需校验与应用文件。</p>
        <p class="connection-muted">取消后请等待任务结束。运行中的受管理实例不能同步。</p>
      </section>

      <section v-if="result" class="managed-result" aria-label="同步结果"><h3>同步完成</h3><p>新增 {{ result.added }} · 更新 {{ result.updated }} · 移出 {{ result.removed }} · 未变化 {{ result.unchanged }}</p><p class="mono">{{ result.version.id }}<br />{{ result.version.folder }}</p><p v-if="result.backupDirectory" class="connection-muted">备份目录：<span class="mono">{{ result.backupDirectory }}</span></p></section>
      <p v-if="error" class="connection-error" role="alert">{{ error }}</p>
      <p v-if="notice" class="connection-muted" role="status">{{ notice }}</p>
    </div>
    <template #footer>
      <div class="managed-actions"><button type="button" class="btn btn-ghost" :disabled="cancellationRequested" @click="dismiss">{{ busy ? cancellationRequested ? '正在取消…' : '取消操作' : '关闭' }}</button><button v-if="result" type="button" class="btn btn-gold" @click="emit('viewInstance')">查看游戏实例</button><button v-else-if="preview" type="button" class="btn btn-gold" :disabled="!canSync" @click="sync">{{ phase === 'syncing' ? '同步中…' : preview.existingInstance ? '确认增量同步' : '确认安装并同步' }}</button></div>
    </template>
  </UpdateDialogShell>
</template>

<style scoped>
.managed-header{display:flex;align-items:flex-start;justify-content:space-between;gap:var(--space-3)}.managed-header h2{margin:0;font-size:var(--text-xl)}.managed-header p{margin:var(--space-2) 0 0}.managed-content{display:flex;flex-direction:column;gap:var(--space-4)}.managed-content p{margin:0}.managed-address{display:grid;gap:var(--space-2)}.managed-address label{font-size:var(--text-sm)}.managed-address>div{display:flex;align-items:center;gap:var(--space-2)}.managed-address input{min-width:0;flex:1}.managed-address button{flex:none;white-space:nowrap}.managed-preview{display:flex;flex-direction:column;gap:var(--space-3);padding:var(--space-4);border:1px solid var(--border);border-radius:var(--radius-md);background:var(--card-2)}.managed-preview h3,.managed-result h3{margin:0;font-size:var(--text-lg)}.managed-verified{font-size:var(--text-xs);color:var(--ok)}.managed-facts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--space-3);margin:0}.managed-facts dt{font-size:var(--text-xs);color:var(--text-dim)}.managed-facts dd{margin:0;font-size:var(--text-sm);overflow-wrap:anywhere}.managed-target{border-top:1px solid var(--border);padding-top:var(--space-3);font-size:var(--text-sm)}.managed-target p{margin-top:var(--space-2);color:var(--text-dim);font-size:var(--text-xs);overflow-wrap:anywhere}.managed-signature{font-size:var(--text-xs);color:var(--text-dim)}.managed-signature summary{cursor:pointer}.managed-signature p{margin-top:var(--space-2)}.managed-progress,.managed-result{display:flex;flex-direction:column;gap:var(--space-2);font-size:var(--text-sm)}.managed-progress progress{display:block;width:100%;height:var(--space-3);accent-color:var(--accent)}.managed-progress-heading{display:flex;justify-content:space-between;align-items:baseline;gap:var(--space-3)}.managed-progress-heading span,.managed-download-bytes{font-variant-numeric:tabular-nums}.managed-download-bytes{color:var(--accent-2)}.managed-result{padding:var(--space-3);border:1px solid var(--border);border-radius:var(--radius-md)}.managed-result .mono{font-size:var(--text-xs);overflow-wrap:anywhere}.managed-actions{display:flex;flex-wrap:wrap;justify-content:space-between;gap:var(--space-2)}.managed-content .connection-error{white-space:pre-wrap;overflow-wrap:anywhere}@media(max-width:600px){.managed-address>div{align-items:stretch;flex-direction:column}.managed-facts{grid-template-columns:minmax(0,1fr)}}
.managed-signature .mono{overflow-wrap:anywhere;word-break:break-all}.managed-trust{display:grid;gap:var(--space-3);padding:var(--space-3);border:1px solid var(--accent);border-radius:var(--radius-md);background:var(--accent-soft);font-size:var(--text-xs)}.managed-trust label{display:flex;align-items:flex-start;gap:var(--space-2);line-height:1.7}.managed-trust input{flex:none;width:var(--space-4);height:var(--space-4);margin-top:var(--space-1);accent-color:var(--accent)}
</style>
