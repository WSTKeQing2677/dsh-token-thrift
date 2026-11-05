/**
 * token-thrift — a DSH host plugin that cuts context tokens without losing information.
 *
 * Design rules (see ../AGENTS.md and ../docs/design.md):
 *   1. No model calls. Everything here is deterministic.
 *   2. Only ever touches the result of the call that just ran, on its way into the
 *      session. Never rewrites earlier history, so the prompt prefix and its KV cache
 *      stay intact.
 *   3. Every removal is reversible: the full original text is stored through the
 *      spill backend and the model gets a `read`-able locator plus the exact line range.
 *   4. Fail open. Any failure, ambiguity, or unexpected shape returns the original.
 *
 * Ordering note: `dsh-spill-policy` registers with `prepend: true`, so it wraps this
 * listener. This listener therefore sees raw tool content and decides first; whatever
 * it returns is what the spill policy then measures.
 */
import { createHash } from 'node:crypto'

/** Cordis plugin identity. */
export const name = 'token-thrift'

/** The tool runtime owns the waterfall and the result shapes this plugin reads. */
export const inject = ['tools']

/**
 * Lines worth keeping when a middle is dropped. Kept deliberately narrow: a false
 * positive costs budget, a false negative costs a debugging round trip.
 */
const SIGNAL = /\b(?:error|errors|exception|fatal|fail|failed|failure|denied|refused|traceback|panic|warn|warning|assertion|econnrefused|econnreset|eacces|eperm|enoent|eexist|segmentation fault|exit code [1-9]\d*|command not found|is not recognized|permission denied|no such file)\b/i

/** Tools whose whole point is returning an exact range; never trim their content. */
const UNTRIMMED_TOOLS = new Set(['read'])

/**
 * Validate the row configuration once, at activation.
 * A bad value throws here rather than producing a half-applied policy later.
 */
export function resolveConfig(raw) {
  const input = raw ?? {}
  const integer = (key, fallback, min, max) => {
    const value = input[key]
    if (value === undefined) return fallback
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
      throw new Error(`token-thrift: config.${key} must be an integer in [${min}, ${max}] (got ${String(value)})`)
    }
    return value
  }
  const bool = (key, fallback) => {
    const value = input[key]
    if (value === undefined) return fallback
    if (typeof value !== 'boolean') throw new Error(`token-thrift: config.${key} must be a boolean (got ${String(value)})`)
    return value
  }
  const cfg = {
    enabled: bool('enabled', true),
    dedupe: bool('dedupe', true),
    trim: bool('trim', true),
    thresholdChars: integer('thresholdChars', 24000, 1000, 4000000),
    budgetChars: integer('budgetChars', 36000, 1000, 4000000),
    headChars: integer('headChars', 14000, 0, 4000000),
    tailChars: integer('tailChars', 12000, 0, 4000000),
    signalChars: integer('signalChars', 8000, 0, 4000000),
    dedupeMinChars: integer('dedupeMinChars', 400, 0, 4000000),
    maxEntries: integer('maxEntries', 500, 1, 100000),
  }
  if (cfg.headChars + cfg.tailChars + cfg.signalChars > cfg.budgetChars) {
    throw new Error('token-thrift: headChars + tailChars + signalChars must not exceed budgetChars')
  }
  if (cfg.thresholdChars < 1000 || cfg.thresholdChars >= cfg.budgetChars) {
    throw new Error('token-thrift: thresholdChars must be at least 1000 and below budgetChars')
  }
  return cfg
}

function fingerprint(text) {
  return createHash('sha1').update(text, 'utf8').digest('hex')
}

/**
 * Build a bounded replacement that keeps the head, the tail, and every line in the
 * dropped middle that looks like a failure.
 * @returns the replacement text, or `undefined` when nothing would be gained.
 */
/**
 * The shell tool truncates its own output before this plugin ever sees it, and appends
 * a notice naming the true full-output file. If we ignore it, we label a shortened text
 * as the "complete" one — which is exactly the kind of false claim that sends a model to
 * the wrong place. When present, the original file becomes the retrieval target.
 */
const TRUNCATION_NOTICE = /\[output truncated; full output: ([^\]\r\n]+)\]/i

function findOriginalOutput(text) {
  const match = TRUNCATION_NOTICE.exec(text)
  return match === null ? undefined : match[1].trim()
}

export function buildTrimmed(text, cfg, locator, originalOutput) {
  const lines = text.split('\n')
  const total = lines.length
  const noticeReserve = locator.length + 240
  const budget = Math.max(0, cfg.budgetChars - noticeReserve)

  const head = []
  let headUsed = 0
  for (let index = 0; index < total; index++) {
    const cost = lines[index].length + 1
    if (headUsed + cost > cfg.headChars) break
    head.push(lines[index])
    headUsed += cost
  }

  const tail = []
  let tailUsed = 0
  for (let index = total - 1; index >= head.length; index--) {
    const cost = lines[index].length + 1
    if (tailUsed + cost > cfg.tailChars) break
    tail.unshift(lines[index])
    tailUsed += cost
  }

  const middleFrom = head.length
  const middleTo = total - tail.length - 1
  if (middleTo < middleFrom) return undefined

  const signals = []
  let signalUsed = 0
  let cappedByBudget = false
  for (let index = middleFrom; index <= middleTo; index++) {
    const line = lines[index]
    if (line.length === 0 || !SIGNAL.test(line)) continue
    const shown = line.length > 400 ? `${line.slice(0, 400)}…` : line
    const rendered = `• ${shown}`
    if (signalUsed + rendered.length + 1 > cfg.signalChars) {
      cappedByBudget = true
      break
    }
    signals.push(rendered)
    signalUsed += rendered.length + 1
  }

  const omitted = middleTo - middleFrom + 1 - signals.length
  // Deliberately no line numbers: this text may already be shorter than the command's
  // real output (the shell tool trims its own head first), so any number here is an
  // offset the model will mistake for a real line number, and a wrong number is worse
  // than none.
  //
  // Order matters. Leading with "N lines were omitted" reads as "this answer is
  // incomplete" and buys a verification round trip; leading with the complete answer
  // and describing the omission afterwards does not. Both statements are factual.
  const retrieval =
    originalOutput === undefined
      ? `本次内容的原文 ${text.length} 字符：${locator} —— 用 read 的 offset/limit 或 grep 可精确取回`
      : `注意：工具已先截断输出头部，本次只收到 ${text.length} 字符；真正完整的输出在 ${originalOutput}`
  const notice = cappedByBudget
    ? `\n[... 另省略 ${omitted} 行，其中可能还含未列出的失败行。${retrieval} ...]\n`
    : `\n[... 另省略 ${omitted} 行未命中失败特征的日志。${retrieval} ...]\n`
  const signalBlock = cappedByBudget
    ? `[被省略区域中命中失败特征的前 ${signals.length} 行（可能不全，完整内容见下方路径）]\n${signals.join('\n')}\n`
    : `[全部失败行（共 ${signals.length} 行；已扫描被省略区域，未发现其他失败行）]\n${signals.join('\n')}\n`
  const parts = []
  if (head.length > 0) parts.push(head.join('\n'))
  if (signals.length > 0) parts.push(signalBlock)
  parts.push(notice)
  if (tail.length > 0) parts.push(tail.join('\n'))

  const out = parts.join('\n')
  // Never emit a replacement that is not both smaller than the input and inside the
  // configured budget: an over-budget or merely shortened-by-accident rewrite is a bug,
  // not a saving, so fall through to the original instead of guessing.
  if (out.length > budget || out.length >= text.length) return undefined
  return out
}

/**
 * Mount the policy.
 * @param ctx - tool runtime plus the optional spill backend.
 * @param config - row configuration; invalid values reject activation.
 */
export function apply(ctx, config) {
  const cfg = resolveConfig(config)
  if (!cfg.enabled) return

  /** sessionId -> Map(`tool\u0000outputFingerprint` -> ordinal). Derived cache only. */
  const seen = new Map()
  /** `sessionId\u0000toolName` -> last assigned ordinal. */
  const counters = new Map()

  const warn = (message) => {
    try {
      ctx.logger?.warn?.(`token-thrift: ${message}`)
    } catch {
      /* logging must never break a tool result */
    }
  }

  const bucketFor = (sessionId) => {
    let bucket = seen.get(sessionId)
    if (bucket === undefined) {
      bucket = new Map()
      seen.set(sessionId, bucket)
    }
    return bucket
  }

  const keepOriginal = async (exec, text, label) => {
    const spill = ctx.get('spillStore')
    if (spill === undefined) return undefined
    const sessionId = exec.agent?.session?.header?.id
    if (sessionId === undefined) return undefined
    const ref = await spill.saveText({
      owner: { sessionId },
      source: { kind: 'tool', toolName: exec.name, callId: exec.callId, label },
      suggestedName: `${exec.name}.txt`,
      content: text,
    })
    return ref
  }

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    try {
      if (decision.kind !== 'accept' || Object.hasOwn(decision, 'value')) return decision
      if (exec.parent !== undefined) return decision
      if (result.isError) return decision
      const content = decision.content ?? result.content
      if (!Array.isArray(content) || content.length === 0) return decision
      if (!content.every((block) => block.type === 'text')) return decision
      const text = content.map((block) => block.text).join('')
      if (text.length === 0) return decision

      const sessionId = exec.agent?.session?.header?.id ?? 'unscoped'
      const bucket = bucketFor(sessionId)

      const replace = (body) => ({
        kind: 'accept',
        content: [{ type: 'text', text: body }],
        ...(decision.additionalContexts === undefined || decision.additionalContexts.length === 0
          ? {}
          : { additionalContexts: decision.additionalContexts }),
      })

      if (cfg.dedupe && text.length >= cfg.dedupeMinChars) {
        // Key on the output, not the arguments: the same arguments can carry a different
        // description, and two different calls can legitimately produce the same bytes.
        // Suppressing on identical output is the only claim this plugin can actually prove.
        const callKey = `${exec.name}\u0000${fingerprint(text)}`
        const previous = bucket.get(callKey)
        if (previous !== undefined) {
          const ref = await keepOriginal(exec, text, 'duplicate')
          if (ref !== undefined) {
            const notice =
              `[与第 ${previous} 次 ${exec.name} 调用返回的内容完全相同（${text.length} 字符），` +
              `未重复展开。\n原文可按需读取：${ref.locator} —— ${ref.retrievalHint}]`
            // A notice bigger than the content it replaces is a loss, not a saving.
            if (notice.length < text.length) return replace(notice)
          }
        }
        const toolCounter = `${sessionId}\u0000${exec.name}`
        const ordinal = (counters.get(toolCounter) ?? 0) + 1
        counters.set(toolCounter, ordinal)
        bucket.set(callKey, ordinal)
        while (bucket.size > cfg.maxEntries) bucket.delete(bucket.keys().next().value)
      }

      if (!cfg.trim) return decision
      if (UNTRIMMED_TOOLS.has(exec.name)) return decision
      if (text.length <= cfg.thresholdChars) return decision

      const ref = await keepOriginal(exec, text, 'result')
      if (ref === undefined) return decision
      const trimmed = buildTrimmed(text, cfg, ref.locator, findOriginalOutput(text))
      if (trimmed === undefined) return decision
      return replace(trimmed)
    } catch (error) {
      warn(`${error instanceof Error ? error.message : String(error)}; keeping the original result`)
      return decision
    }
  })
}
