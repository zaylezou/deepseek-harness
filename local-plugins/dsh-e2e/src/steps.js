/**
 * 步骤执行器：把一组声明式步骤翻译成 Playwright 操作。
 *
 * 设计目标是「一次工具调用里能覆盖常见 E2E 场景」：导航、点击、填表、
 * 断言、取 DOM 数据、截图。任何一件超出声明式范围的事都还能用 eval 兜底。
 */
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const ACTION_KEYS = [
  'goto',
  'reload',
  'click',
  'fill',
  'press',
  'hover',
  'selectOption',
  'waitFor',
  'wait',
  'eval',
  'screenshot',
  'assert',
  'setViewport',
]

function describeError(error) {
  const message = error && typeof error === 'object' && 'message' in error ? error.message : String(error)
  return String(message).slice(0, 800)
}

function cleanName(value) {
  return String(value ?? '')
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
}

function truncate(value, limit = 600) {
  const text = String(value ?? '')
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

function formatValue(value, limit = 600) {
  if (value === undefined) return 'undefined'
  try {
    return truncate(JSON.stringify(value), limit)
  } catch {
    return truncate(String(value), limit)
  }
}

/** 导航动作吃全局超时；其它动作默认吃更短的 actionTimeoutMs，写错选择器别再空转几分钟。 */
const NAV_ACTIONS = new Set(['goto', 'reload'])

/**
 * Resolve a goto step against the instance origin. The step is a path on the
 * instance, never a URL: the tool decides the origin, the step only decides
 * where inside it to go. Using the instance URL (not the current page URL)
 * means a prior click cannot move the base of later navigations elsewhere.
 * @param value the declared path, for example "/settings?tab=model".
 * @param instanceUrl the instance URL whose origin is the only allowed base.
 * @returns an absolute URL on the instance origin.
 * @throws when the value is empty, not an absolute path, or protocol-relative.
 */
export function gotoHref(value, instanceUrl) {
  const text = String(value ?? '').trim()
  if (!text.startsWith('/') || text.startsWith('//') || text.includes('\\')) {
    throw new Error('goto 只接受以 / 开头的实例内路径（例如 /settings），不接受 URL')
  }
  let base
  try {
    base = new URL(instanceUrl)
  } catch {
    throw new Error(`goto 需要已知的实例地址，当前是 ${String(instanceUrl)}`)
  }
  if (base.protocol !== 'http:' && base.protocol !== 'https:') {
    throw new Error(`goto 需要 HTTP(S) 实例地址，当前是 ${base.protocol}`)
  }
  return new URL(text, base.origin).href
}

function positiveNumber(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function matchesText(actual, expected) {
  const want = String(expected ?? '')
  if (want.length > 2 && want.startsWith('/') && want.endsWith('/')) {
    return new RegExp(want.slice(1, -1), 'u').test(actual)
  }
  return actual.includes(want)
}

async function runOne(page, kind, value, opts, capture) {
  const timeout = opts.timeoutMs

  switch (kind) {
    case 'goto':
      await page.goto(gotoHref(value, opts.baseUrl), { waitUntil: 'domcontentloaded', timeout })
      return page.url()

    case 'reload':
      await page.reload({ waitUntil: 'domcontentloaded', timeout })
      return page.url()

    case 'click': {
      const spec = typeof value === 'string' ? { selector: value } : (value ?? {})
      const selector = String(spec.selector ?? '')
      if (!selector) throw new Error('click 需要 selector')
      const locator = page.locator(selector).nth(Number(spec.nth ?? 0))
      await locator.click({ timeout, button: spec.button === 'right' ? 'right' : 'left' })
      return selector
    }

    case 'fill': {
      const spec = value ?? {}
      const selector = String(spec.selector ?? '')
      if (!selector) throw new Error('fill 需要 {selector, value}')
      await page.locator(selector).first().fill(String(spec.value ?? ''), { timeout })
      return `${selector} = ${truncate(spec.value, 80)}`
    }

    case 'press':
      await page.keyboard.press(String(value))
      return String(value)

    case 'hover': {
      const selector = String(value?.selector ?? value ?? '')
      if (!selector) throw new Error('hover 需要 selector')
      await page.locator(selector).first().hover({ timeout })
      return selector
    }

    case 'selectOption': {
      const spec = value ?? {}
      const selector = String(spec.selector ?? '')
      if (!selector) throw new Error('selectOption 需要 {selector, value}')
      await page.locator(selector).first().selectOption(spec.value, { timeout })
      return `${selector} = ${truncate(spec.value, 80)}`
    }

    case 'waitFor': {
      const spec = value ?? {}
      const selector = String(spec.selector ?? '')
      if (!selector) throw new Error('waitFor 需要 {selector}')
      const state = String(spec.state ?? 'visible')
      await page.locator(selector).first().waitFor({
        state,
        timeout: Number(spec.timeoutMs) > 0 ? Number(spec.timeoutMs) : timeout,
      })
      return `${selector} ${state}`
    }

    case 'wait': {
      const ms = Math.max(0, Math.min(Number(value) || 0, 60000))
      await page.waitForTimeout(ms)
      return `${ms}ms`
    }

    case 'eval': {
      const result = await page.evaluate(String(value))
      return formatValue(result)
    }

    case 'screenshot': {
      const spec = typeof value === 'string' ? { name: value } : (value ?? {})
      const path = await capture(spec)
      return path
    }

    case 'assert': {
      const spec = value ?? {}
      const notes = []
      const assertTimeout = Number(spec.timeoutMs) > 0 ? Number(spec.timeoutMs) : timeout

      if (spec.url !== undefined) {
        const current = page.url()
        if (!matchesText(current, spec.url)) throw new Error(`URL 不含 "${spec.url}"（当前 ${current}）`)
        notes.push(`url~${spec.url}`)
      }

      if (spec.selector !== undefined) {
        const selector = String(spec.selector)
        const locator = page.locator(selector).first()
        if (spec.visible !== undefined) {
          await locator.waitFor({ state: spec.visible ? 'visible' : 'hidden', timeout: assertTimeout })
          notes.push(`${selector} ${spec.visible ? '可见' : '不可见'}`)
        }
        if (spec.count !== undefined) {
          const count = await page.locator(selector).count()
          if (count !== Number(spec.count)) throw new Error(`${selector} 有 ${count} 个，期望 ${spec.count} 个`)
          notes.push(`${selector} ×${count}`)
        }
        if (spec.text !== undefined) {
          await locator.waitFor({ state: 'visible', timeout: assertTimeout })
          const text = (await locator.textContent()) ?? ''
          if (!matchesText(text, spec.text)) {
            throw new Error(`${selector} 的文本不含 "${spec.text}"（实际：${truncate(text, 120)}）`)
          }
          notes.push(`${selector} 文本命中`)
        }
        if (spec.value !== undefined) {
          const actual = await locator.inputValue({ timeout: assertTimeout })
          if (actual !== String(spec.value)) {
            throw new Error(`${selector} 的值是 "${truncate(actual, 80)}"，期望 "${spec.value}"`)
          }
          notes.push(`${selector} 值命中`)
        }
      } else if (spec.text !== undefined) {
        const body = await page.locator('body').innerText({ timeout: assertTimeout })
        if (!matchesText(body, spec.text)) throw new Error(`页面文本不含 "${spec.text}"`)
        notes.push('页面文本命中')
      }

      if (notes.length === 0) throw new Error('assert 至少要给 url / selector / text 之一')
      return notes.join('；')
    }

    case 'setViewport': {
      const width = Number(value?.width)
      const height = Number(value?.height)
      if (!(width > 0 && height > 0)) throw new Error('setViewport 需要 {width, height}')
      await page.setViewportSize({ width, height })
      return `${width}x${height}`
    }

    default:
      throw new Error(`未知步骤 "${kind}"；可用：${ACTION_KEYS.join(' / ')}`)
  }
}

/**
 * 按顺序执行步骤。失败时停在该步并自动截一张 failure，方便看现场。
 *
 * 超时三层：`opts.timeoutMs` 是导航与全局上限，`opts.actionTimeoutMs` 是
 * click/fill/waitFor/assert/截图这类动作的默认值（更短），单步的
 * `timeout` / `timeoutMs` 覆盖该步。
 * @returns {{log: object[], screenshots: {name: string, path: string, data: Buffer}[], error: string|null, durationMs: number}}
 */
export async function runSteps(page, steps, opts) {
  const log = []
  const screenshots = []
  const started = Date.now()
  const navTimeout = positiveNumber(opts.timeoutMs, 30000)
  const actionTimeout = positiveNumber(opts.actionTimeoutMs, navTimeout)
  let error = null

  const capture = async (spec, index, timeout) => {
    const name = cleanName(spec?.name) || `step-${index + 1}`
    let data
    if (spec?.selector) {
      data = await page.locator(String(spec.selector)).first().screenshot({ timeout })
    } else {
      data = await page.screenshot({ fullPage: spec?.fullPage ?? opts.fullPage, timeout })
    }
    const path = join(opts.shotDir, `${String(screenshots.length + 1).padStart(2, '0')}-${name}.png`)
    await writeFile(path, data)
    screenshots.push({ name, path, data })
    return path
  }

  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index] ?? {}
    const kind = ACTION_KEYS.find((key) => Object.prototype.hasOwnProperty.call(step, key))
      ?? Object.keys(step)[0]
    const stepTimeout = positiveNumber(
      step.timeout ?? step.timeoutMs,
      NAV_ACTIONS.has(kind) ? navTimeout : actionTimeout,
    )
    const stepStarted = Date.now()
    try {
      const detail = await runOne(page, kind, step[kind], { ...opts, timeoutMs: stepTimeout },
        (spec) => capture(spec, index, stepTimeout))
      log.push({ index: index + 1, action: kind, ok: true, ms: Date.now() - stepStarted, detail })
    } catch (caught) {
      log.push({
        index: index + 1,
        action: kind,
        ok: false,
        ms: Date.now() - stepStarted,
        detail: describeError(caught),
      })
      error = `第 ${index + 1} 步 ${kind} 失败：${describeError(caught)}`
      try {
        await capture({ name: 'failure' }, index, actionTimeout)
      } catch { /* 截图都失败了就只留错误 */ }
      break
    }
  }

  if (error === null && opts.finalScreenshot !== false) {
    try {
      await capture({ name: 'final' }, steps.length, actionTimeout)
    } catch (caught) {
      error = `最后截图失败：${describeError(caught)}`
    }
  }

  return { log, screenshots, error, durationMs: Date.now() - started }
}
