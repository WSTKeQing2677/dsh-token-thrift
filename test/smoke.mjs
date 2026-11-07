// Offline smoke test: drives the plugin's waterfall listener without a Harness.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { apply } from '../index.js'

const root = join(tmpdir(), `thrift-smoke-${process.pid}`)
mkdirSync(root, { recursive: true })

let saved = 0
const spillStore = {
  async saveText(input) {
    const path = join(root, `save-${++saved}.txt`)
    writeFileSync(path, input.content, 'utf8')
    return { locator: path, bytes: Buffer.byteLength(input.content, 'utf8'), retrievalHint: 'Use read with offset/limit, or grep this path.' }
  },
}

function harness(config = {}) {
  const handlers = []
  const ctx = {
    on(event, handler) { handlers.push({ event, handler }) },
    get(name) { return name === 'spillStore' ? spillStore : undefined },
    logger: { warn: () => {} },
  }
  apply(ctx, config)
  const listener = handlers.find((entry) => entry.event === 'tools/post-execute')
  return async (exec, result) => listener.handler(exec, result, async () => ({ kind: 'accept', content: result.content }))
}

const failures = []
function check(name, condition, detail) {
  if (condition) { console.log(`  ok   ${name}`) }
  else { failures.push(name); console.log(`  FAIL ${name}${detail === undefined ? '' : ` — ${detail}`}`) }
}

const agent = { session: { header: { id: 'session-test' } } }
const text = (value) => [{ type: 'text', text: value }]
const okResult = (content) => ({ isError: false, value: null, content })

// 1. A long log with a buried failure keeps the failure and drops the middle.
{
  const lines = []
  for (let index = 0; index < 3000; index++) lines.push(`step ${index} ${'x'.repeat(80)}`)
  lines[1500] = 'ERROR 2026-11-02 build failed: module not found ./secret-target'
  const body = lines.join('\n')
  const run = harness({ thresholdChars: 4000, budgetChars: 8000, headChars: 3000, tailChars: 3000, signalChars: 1500 })
  const decision = await run({ name: 'pwsh', callId: 'c1', arguments: { command: 'build' }, agent }, okResult(text(body)))
  const out = decision.content[0].text
  console.log('\n[1] trimmed log')
  check('shrinks the result', out.length < body.length, `${out.length} vs ${body.length}`)
  check('keeps the buried error line', out.includes('module not found ./secret-target'))
  check('reports the omitted range', /另省略 \d+ 行未命中失败特征的日志/.test(out))
  check('points at a readable locator', /本次内容的原文 \d+ 字符：.+save-\d+\.txt/.test(out))
  check('never claims a line number', !/\bL\d+:/.test(out))
  check('loads the complete answer first', /全部失败行（共 \d+ 行；已扫描被省略区域，未发现其他失败行）/.test(out))
  check('stays inside the budget', out.length <= 8000, String(out.length))
}

// 2. The identical call twice is not expanded twice.
{
  const run = harness({ thresholdChars: 4000, budgetChars: 8000, headChars: 3000, tailChars: 3000, signalChars: 1500 })
  const body = Array.from({ length: 200 }, (_, index) => `line ${index}`).join('\n')
  const first = await run({ name: 'grep', callId: 'c2', arguments: { pattern: 'line' }, agent }, okResult(text(body)))
  const second = await run({ name: 'grep', callId: 'c3', arguments: { pattern: 'line' }, agent }, okResult(text(body)))
  console.log('\n[2] duplicate suppression')
  check('first call untouched', first.content[0].text === body)
  check('second call points at the first', second.content[0].text.includes('完全相同'))
  check('second call is small', second.content[0].text.length < 400, String(second.content[0].text.length))
}

// 3. Same call, different output: never suppressed.
{
  const run = harness({ thresholdChars: 4000, budgetChars: 8000, headChars: 3000, tailChars: 3000, signalChars: 1500 })
  const before = 'old contents'
  const after = 'new contents'
  await run({ name: 'grep', callId: 'c4', arguments: { pattern: 'z' }, agent }, okResult(text(before)))
  const decision = await run({ name: 'grep', callId: 'c5', arguments: { pattern: 'z' }, agent }, okResult(text(after)))
  console.log('\n[3] changed output')
  check('passes the new content through', decision.content[0].text === after)
}

// 4. A `read` result is never trimmed, even when large.
{
  const run = harness({ thresholdChars: 2000, budgetChars: 4000, headChars: 1500, tailChars: 1500, signalChars: 500 })
  const body = Array.from({ length: 500 }, (_, index) => `   ${index + 1}→const a${index} = ${index}`).join('\n')
  const decision = await run({ name: 'read', callId: 'c6', arguments: { file_path: 'x.js' }, agent }, okResult(text(body)))
  console.log('\n[4] read passthrough')
  check('keeps the exact range', decision.content[0].text === body)
}

// 5. Non-text content is left alone.
{
  const run = harness({ thresholdChars: 2000, budgetChars: 4000, headChars: 1500, tailChars: 1500, signalChars: 500 })
  const content = [{ type: 'text', text: 'x'.repeat(3000) }, { type: 'image', attachment: { attachmentId: 'a' } }]
  const decision = await run({ name: 'read_image', callId: 'c7', arguments: {}, agent }, okResult(content))
  console.log('\n[5] rich content')
  check('passes mixed content through', decision.content === content)
}

// 6. A result-value decision is never touched.
{
  const run = harness({ thresholdChars: 1000, budgetChars: 2000, headChars: 800, tailChars: 800, signalChars: 200 })
  const body = 'y'.repeat(5000)
  const handlers = []
  const ctx = { on: (e, h) => handlers.push(h), get: (n) => (n === 'spillStore' ? spillStore : undefined), logger: { warn: () => {} } }
  apply(ctx, { thresholdChars: 1000, budgetChars: 2000, headChars: 800, tailChars: 800, signalChars: 200 })
  const decision = await handlers[0]({ name: 'pwsh', callId: 'c8', arguments: {}, agent }, okResult(text(body)), async () => ({ kind: 'accept', value: { raw: body } }))
  console.log('\n[6] value decisions')
  check('leaves canonical values alone', decision.value !== undefined && decision.content === undefined)
  void run
}

// 7. No spill backend: fail open, keep the original.
{
  const handlers = []
  const ctx = { on: (e, h) => handlers.push(h), get: () => undefined, logger: { warn: () => {} } }
  apply(ctx, { thresholdChars: 1000, budgetChars: 2000, headChars: 800, tailChars: 800, signalChars: 200 })
  const body = 'z'.repeat(9000)
  const decision = await handlers[0]({ name: 'pwsh', callId: 'c9', arguments: {}, agent }, okResult(text(body)), async () => ({ kind: 'accept', content: text(body) }))
  console.log('\n[7] missing spill backend')
  check('keeps the original when recovery is unavailable', decision.content[0].text === body)
}

// 8. Identical output from a differently-described call is still suppressed.
{
  const run = harness({ thresholdChars: 4000, budgetChars: 8000, headChars: 3000, tailChars: 3000, signalChars: 1500 })
  const body = 'a'.repeat(900)
  await run({ name: 'pwsh', callId: 'c10', arguments: { command: 'x', description: 'first wording' }, agent }, okResult(text(body)))
  const second = await run({ name: 'pwsh', callId: 'c11', arguments: { command: 'x', description: 'other wording' }, agent }, okResult(text(body)))
  console.log('\n[8] output-keyed dedupe')
  check('suppresses identical output even with new arguments', second.content[0].text.includes('完全相同'))
}

// 9. A tiny duplicate is left alone: the notice would be longer than the content.
{
  const run = harness({ thresholdChars: 4000, budgetChars: 8000, headChars: 3000, tailChars: 3000, signalChars: 1500 })
  const body = 'ok'
  await run({ name: 'pwsh', callId: 'c12', arguments: { command: 'y' }, agent }, okResult(text(body)))
  const second = await run({ name: 'pwsh', callId: 'c13', arguments: { command: 'y' }, agent }, okResult(text(body)))
  console.log('\n[9] tiny results')
  check('never grows a short result', second.content[0].text === body)
}

// 10. When the shell tool already truncated the output, point at its full copy instead
//     of calling the received (shortened) text "complete".
{
  const run = harness({ thresholdChars: 4000, budgetChars: 8000, headChars: 3000, tailChars: 3000, signalChars: 1500 })
  const lines = Array.from({ length: 3000 }, (_, index) => `line ${index} ${'z'.repeat(40)}`)
  lines[1500] = 'ERROR something broke'
  const body = lines.join('\n') + '\n[output truncated; full output: C:\\tmp\\real-full.log]'
  const decision = await run({ name: 'pwsh', callId: 'c14', arguments: { command: 'x' }, agent }, okResult(text(body)))
  const out = decision.content[0].text
  console.log('\n[10] tool-truncated output')
  check('points at the true full output', out.includes('C:\\tmp\\real-full.log'))
  check('never calls the received text complete', !out.includes('本次内容的原文'))
  check('still keeps the failure line', out.includes('something broke'))
}

console.log(failures.length === 0 ? '\nALL PASS' : `\n${failures.length} FAILED: ${failures.join(', ')}`)
process.exit(failures.length === 0 ? 0 : 1)
