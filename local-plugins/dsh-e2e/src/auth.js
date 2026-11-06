/**
 * 登录态：从 dsh-webui-auth 的 sessions.jsonl 里取一个未过期的会话 token，
 * 作为浏览器 cookie 注入。
 *
 * 为什么读文件而不是走登录接口：dsh-webui-auth 只存口令哈希，登录接口需要
 * 明文口令。会话文件里的 token 是同一个信任边界内的东西（本机可读），
 * 拿来给 E2E 用最直接。
 */
import { readFile } from 'node:fs/promises'

function cookieFromToken(token, cookieName, target) {
  return {
    name: cookieName,
    value: token,
    domain: target.hostname,
    path: '/',
    httpOnly: true,
    secure: target.protocol === 'https:',
    sameSite: 'Lax',
  }
}

function normalizeExplicit(cookies, target) {
  return cookies.map((cookie) => {
    if (!cookie || typeof cookie !== 'object' || !cookie.name || cookie.value === undefined) {
      throw new Error('cookies 里每一项都要有 name 和 value')
    }
    return {
      name: String(cookie.name),
      value: String(cookie.value),
      domain: cookie.domain ? String(cookie.domain) : target.hostname,
      path: cookie.path ? String(cookie.path) : '/',
      httpOnly: cookie.httpOnly === true,
      secure: cookie.secure === undefined ? target.protocol === 'https:' : cookie.secure === true,
      sameSite: cookie.sameSite ?? 'Lax',
    }
  })
}

function latestLiveSession(raw) {
  let best = null
  const now = Date.now()
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (entry?.op !== 'add' || typeof entry.token !== 'string' || !entry.sess) continue
    const expiresAt = Number(entry.sess.expiresAt) || 0
    if (expiresAt <= now) continue
    if (best === null || expiresAt > best.expiresAt) best = { token: entry.token, expiresAt }
  }
  return best
}

/**
 * 算出这次要注入的 cookies。
 * @param {URL} target 目标地址
 * @param {object} config 插件配置（auth / sessionsFile / cookieName）
 * @param {object[]|undefined} explicit 调用方显式给的 cookie
 */
export async function cookiesFor(target, config, explicit) {
  if (Array.isArray(explicit) && explicit.length > 0) {
    return normalizeExplicit(explicit, target)
  }

  const mode = String(config.auth ?? 'none').trim() || 'none'
  if (mode === 'none') return []
  if (mode !== 'dsh') throw new Error(`auth 只能是 dsh / none，收到 "${mode}"`)

  const file = String(config.sessionsFile ?? '').trim()
  if (!file) throw new Error('auth=dsh 但没有配 sessionsFile（dsh-webui-auth 的 sessions.jsonl 路径）')

  let raw
  try {
    raw = await readFile(file, 'utf8')
  } catch (error) {
    throw new Error(`读不到会话文件 ${file}：${error?.message ?? error}。先在 Web GUI 登录一次，或把 auth 设成 none。`)
  }

  const session = latestLiveSession(raw)
  if (session === null) {
    throw new Error(
      'dsh-webui-auth 里没有未过期的会话（token 都过期了）。在 Web GUI 重新登录一次以刷新，'
      + '或者把 auth 设成 none / 显式传 cookies。',
    )
  }

  const cookieName = String(config.cookieName ?? '').trim() || 'dsh_wua_session'
  return [cookieFromToken(session.token, cookieName, target)]
}
