<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue';
import type { Formatter } from '../../../src/pipeline/formatter.js';
import { createJsonFormatter, createLineFormatter } from '../../../src/pipeline/formatter.js';
import type { LogEntry, LogLevelName } from '../../../src/types.js';

const props = withDefaults(defineProps<{ locale?: 'en' | 'zh' }>(), { locale: 'en' });
const isZh = props.locale === 'zh';
const scope = ref('NAPI');
const message = ref('openDrive("")');
const level = ref<'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'>('info');
const format = ref<'text' | 'json'>('text');
const lines = ref<string[]>([]);
const output = ref<HTMLPreElement | null>(null);
const textFormatter = createLineFormatter();
const jsonFormatter = createJsonFormatter();
const levelValues: Record<LogLevelName, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

function writeEntry(
  levelName: LogLevelName,
  text: string,
  args: unknown[] = [],
  error?: Error,
): void {
  const timestamp = Date.now();
  const entry: LogEntry = {
    level: levelValues[levelName],
    levelName,
    message: text,
    args,
    timestamp,
    time: new Date(timestamp).toISOString(),
    scope: scope.value.trim() || 'NAPI',
    context: { source: 'playground' },
    metadata: {},
    error,
  };
  const formatter: Formatter<string> = format.value === 'json' ? jsonFormatter : textFormatter;
  lines.value.push(formatter(entry));
}

async function writeLog(): Promise<void> {
  writeEntry(level.value, message.value || (isZh ? '请输入日志内容' : 'Enter a log message'));
  await nextTick();
  if (output.value) output.value.scrollTop = output.value.scrollHeight;
}

function writeExamples(): void {
  writeEntry('info', 'openDrive("")');
  writeEntry('info', 'setFileBatchTransfer(1)');
  writeEntry('warn', 'Retrying connection', [{ attempt: 2 }]);
  writeEntry('error', 'Connection failed', [], new Error('device unavailable'));
}

onMounted(writeExamples);
</script>

<template>
  <section class="log-playground">
    <div class="playground-controls">
      <label>
        {{ isZh ? '作用域' : 'Scope' }}
        <input v-model="scope" type="text" placeholder="NAPI" />
      </label>
      <label>
        {{ isZh ? '级别' : 'Level' }}
        <select v-model="level">
          <option v-for="item in ['trace', 'debug', 'info', 'warn', 'error', 'fatal']" :key="item">
            {{ item }}
          </option>
        </select>
      </label>
      <label>
        {{ isZh ? '格式' : 'Format' }}
        <select v-model="format">
          <option value="text">{{ isZh ? '人类可读' : 'Human-readable' }}</option>
          <option value="json">JSON</option>
        </select>
      </label>
      <label class="message-field">
        {{ isZh ? '消息' : 'Message' }}
        <input v-model="message" type="text" @keydown.enter="writeLog" />
      </label>
      <div class="playground-actions">
        <button type="button" class="primary" @click="writeLog">
          {{ isZh ? '输出日志' : 'Write log' }}
        </button>
        <button type="button" @click="writeExamples">
          {{ isZh ? '添加示例' : 'Add examples' }}
        </button>
        <button type="button" @click="lines = []">
          {{ isZh ? '清空' : 'Clear' }}
        </button>
      </div>
    </div>
    <pre ref="output" class="playground-output" aria-live="polite"><code>{{ lines.join('\n') }}</code></pre>
  </section>
</template>

<style scoped>
.log-playground {
  margin: 24px 0;
  overflow: hidden;
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  background: var(--vp-c-bg-soft);
}

.playground-controls {
  display: grid;
  grid-template-columns: minmax(120px, 1fr) minmax(100px, 0.6fr) minmax(140px, 0.8fr);
  gap: 14px;
  padding: 18px;
}

.playground-controls label {
  display: grid;
  gap: 6px;
  color: var(--vp-c-text-2);
  font-size: 13px;
  font-weight: 600;
}

.playground-controls input,
.playground-controls select {
  width: 100%;
  min-width: 0;
  padding: 8px 10px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 6px;
  background: var(--vp-c-bg);
  color: var(--vp-c-text-1);
  font: inherit;
}

.playground-controls .message-field {
  grid-column: 1 / -1;
}

.playground-actions {
  display: flex;
  grid-column: 1 / -1;
  flex-wrap: wrap;
  gap: 8px;
}

.playground-actions button {
  padding: 7px 12px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 6px;
  background: var(--vp-c-bg);
  color: var(--vp-c-text-1);
  cursor: pointer;
}

.playground-actions .primary {
  border-color: var(--vp-c-brand-1);
  background: var(--vp-c-brand-1);
  color: var(--vp-c-white);
}

.playground-output {
  min-height: 180px;
  max-height: 420px;
  margin: 0;
  overflow: auto;
  padding: 16px 18px;
  border-top: 1px solid var(--vp-c-divider);
  background: var(--vp-code-block-bg);
  color: var(--vp-c-text-1);
  font-size: 13px;
  line-height: 1.65;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.playground-output code {
  font-family: var(--vp-font-family-mono);
}

@media (max-width: 640px) {
  .playground-controls {
    grid-template-columns: 1fr 1fr;
  }
}
</style>
