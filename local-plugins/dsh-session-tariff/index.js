/**
 * dsh-session-tariff — per-session peak/off-peak token ledger.
 *
 * The token-usage projection a Session publishes is cumulative and carries no
 * per-request clock, so a cost built from it cannot tell peak from off-peak.
 * This Host-only plugin listens to `session/event` and banks every
 * `assistant/message` usage into the tariff in force at that event's timestamp:
 *
 *   { version: 1, sessions: { <id>: { firstAt, updatedAt, models: {
 *       <model>: { peak: { hit, miss, out }, off: { hit, miss, out } } } } } }
 *
 * The balance client reads it from GET /plugins/dsh-session-tariff/session-cost
 * and prices the buckets; missing history (recorded before this plugin ran, or
 * attempts that report no assistant message) is still inferred and marked as
 * such by the client.
 *
 * The ledger lives under $DSH_HOME/dsh-session-tariff/session-tariffs.json and
 * is flushed atomically after a short debounce.
 *
 * @module dsh-session-tariff
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'dsh-session-tariff'
export const inject = ['webServer']

const ROUTE = '/plugins/dsh-session-tariff/session-cost'
const FLUSH_MS = 1000

/** @param value - any projected count. @returns a non-negative finite number. */
function countOf(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/** One zeroed billing bucket. */
function zeroBucket() {
  return { hit: 0, miss: 0, out: 0 }
}

/**
 * Peak is 09:00–12:00 and 14:00–18:00 Beijing time on workdays; everything
 * else is off-peak. Holidays are not modelled.
 * @param instant - event time.
 * @returns true for the peak tariff.
 */
function isPeakAt(instant) {
  const beijing = new Date(instant.getTime() + 8 * 60 * 60 * 1000)
  const day = beijing.getUTCDay()
  if (day === 0 || day === 6) return false
  const hour = beijing.getUTCHours()
  return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18)
}

/**
 * The DSH home, whether the service exposes it as a function, a string, or only
 * through the launching environment.
 * @param ctx - the plugin context.
 * @returns an absolute home directory.
 */
function homeDir(ctx) {
  try {
    const value = ctx.get('dshHomePath')
    const dir = typeof value === 'function' ? value() : value
    if (typeof dir === 'string' && dir !== '') return dir
  } catch {
    /* fall through */
  }
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/**
 * Load the ledger, accepting only a shape this writer understands.
 * @param file - ledger path.
 * @returns the mutable state.
 */
function loadLedger(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (parsed && parsed.version === 1 && parsed.sessions && typeof parsed.sessions === 'object') {
      return parsed
    }
  } catch {
    /* absent or corrupt: start empty rather than blocking the sampler */
  }
  return { version: 1, sessions: {} }
}

/**
 * Write one JSON response.
 * @param res - the response to own.
 * @param status - HTTP status.
 * @param body - serializable payload.
 */
function sendJson(res, status, body) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

/** @param ctx - the plugin context. */
export function apply(ctx) {
  const dir = join(homeDir(ctx), 'dsh-session-tariff')
  const file = join(dir, 'session-tariffs.json')
  const state = loadLedger(file)

  let timer = null
  let dirty = false

  const flush = () => {
    if (!dirty) return
    dirty = false
    try {
      mkdirSync(dir, { recursive: true })
      const tmp = `${file}.tmp`
      writeFileSync(tmp, JSON.stringify(state), 'utf8')
      renameSync(tmp, file)
    } catch (error) {
      ctx.logger?.warn?.('dsh-session-tariff: ledger write failed:', error?.message ?? error)
    }
  }

  const schedule = () => {
    dirty = true
    if (timer !== null) return
    timer = setTimeout(() => {
      timer = null
      flush()
    }, FLUSH_MS)
    timer.unref?.()
  }

  ctx.on('session/event', (session, event) => {
    if (event === null || typeof event !== 'object' || event.type !== 'assistant/message') return
    const usage = event.data?.usage
    if (usage === null || typeof usage !== 'object') return
    const id = session?.id
    if (typeof id !== 'string' || id === '') return

    const hit = countOf(usage.cacheReadTokens)
    const miss = countOf(usage.inputTokens) + countOf(usage.cacheWriteTokens)
    const out = countOf(usage.outputTokens)
    if (hit + miss + out === 0) return

    const at = Number.isFinite(event.time) ? event.time : Date.now()
    const source = event.data?.message?.source
    const model = typeof source?.model === 'string' && source.model !== '' ? source.model : 'unknown'
    const tariff = isPeakAt(new Date(at)) ? 'peak' : 'off'

    const record = state.sessions[id] ?? { firstAt: at, updatedAt: at, models: {} }
    state.sessions[id] = record
    const buckets = record.models[model] ?? { peak: zeroBucket(), off: zeroBucket() }
    record.models[model] = buckets
    buckets[tariff].hit += hit
    buckets[tariff].miss += miss
    buckets[tariff].out += out
    record.updatedAt = at
    schedule()
  })

  ctx.effect(() => {
    const webServer = ctx.get('webServer')
    if (webServer === undefined || typeof webServer.register !== 'function') {
      ctx.logger?.warn?.('dsh-session-tariff: no webServer service; the ledger route is not mounted')
      return () => {}
    }
    return webServer.register({
      kind: 'exact',
      path: ROUTE,
      handler: (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://localhost')
          const sessionId = url.searchParams.get('sessionId') ?? ''
          const record = sessionId === '' ? undefined : state.sessions[sessionId]
          if (record === undefined) {
            sendJson(res, 200, { ok: true, recorded: false, sessionId })
            return
          }
          sendJson(res, 200, {
            ok: true,
            recorded: true,
            sessionId,
            firstAt: record.firstAt,
            updatedAt: record.updatedAt,
            models: record.models,
          })
        } catch (error) {
          sendJson(res, 500, { ok: false, error: error?.message ?? String(error) })
        }
      },
    })
  }, 'dsh-session-tariff: ledger route')

  ctx.effect(() => () => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    flush()
  }, 'dsh-session-tariff: flush on dispose')
}
