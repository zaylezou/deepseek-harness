/**
 * Production-access guard for the browser tool.
 *
 * The guard runs before the browser starts and again before every declared
 * navigation. The live web server is protected automatically on the primary
 * instance; `protectedOrigins` carries public entry points (for example a
 * reverse-proxied URL) from the private profile patch. An instance created by
 * `e2e_instance` marks its child process with `DSH_E2E_INSTANCE=1`, so only
 * there does self-origin protection step aside: the isolated page is the thing
 * under test, while public entry points stay protected.
 */

/** Hosts that alias the local machine. */
const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '[::1]']

/**
 * Parse one URL with a network host: HTTP(S) for navigation, WebSocket for the
 * request-layer guard.
 * @param value URL instance or string.
 * @returns the URL, or null for a malformed or unsupported value.
 */
function hostUrl(value) {
  let url
  try {
    url = value instanceof URL ? value : new URL(String(value))
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'ws:' && url.protocol !== 'wss:') return null
  return url.hostname === '' ? null : url
}

/**
 * Parse one HTTP(S) URL for navigation and instance origins.
 * @param value URL instance or string.
 * @returns the URL, or null for a non-HTTP(S) or malformed value.
 */
function httpUrl(value) {
  const url = hostUrl(value)
  return url === null || (url.protocol !== 'http:' && url.protocol !== 'https:') ? null : url
}

/**
 * Effective port of a parsed URL, including scheme defaults.
 * @param url parsed HTTP(S) URL.
 * @returns the port as a string.
 */
function portOf(url) {
  if (url.port !== '') return url.port
  return url.protocol === 'https:' || url.protocol === 'wss:' ? '443' : '80'
}

/**
 * Host-and-port identity that ignores the scheme, so an HTTP downgrade of a
 * protected HTTPS entry point is still refused.
 * @param value URL instance or string.
 * @returns `host:port`, or null when the value is not an HTTP(S) URL.
 */
export function hostKeyOf(value) {
  const url = hostUrl(value)
  return url === null ? null : `${url.hostname}:${portOf(url)}`
}

/**
 * Exact origin of an HTTP(S) URL.
 * @param value URL instance or string.
 * @returns the origin, or null when the value is not an HTTP(S) URL.
 */
export function originOf(value) {
  const url = httpUrl(value)
  return url === null ? null : url.origin
}

/**
 * Host-and-port keys that identify the live web server: its bound origin plus
 * loopback aliases on the same port.
 * @param webServer the host web server service, when composed.
 * @returns host-and-port keys.
 */
function selfHostKeys(webServer) {
  const keys = new Set()
  if (webServer === undefined) return keys
  let origin
  try {
    origin = webServer.getOrigin()
  } catch {
    return keys
  }
  const key = hostKeyOf(origin)
  if (key !== null) keys.add(key)
  const url = httpUrl(origin)
  if (url === null) return keys
  const port = portOf(url)
  for (const host of LOOPBACK_HOSTS) keys.add(`${host}:${port}`)
  return keys
}

/**
 * Build the immutable guard inputs for one tool call.
 * @param webServer the host web server service, when composed.
 * @param config plugin configuration with `protectedOrigins`.
 * @param environment process environment; the isolated-instance marker is read here.
 * @returns the set of protected host-and-port keys.
 */
export function guardConfig(webServer, config, environment = process.env) {
  const protectedHosts = new Set()
  if (environment?.DSH_E2E_INSTANCE !== '1') {
    for (const key of selfHostKeys(webServer)) protectedHosts.add(key)
  }
  for (const value of config?.protectedOrigins ?? []) {
    const key = hostKeyOf(value)
    if (key !== null) protectedHosts.add(key)
  }
  return { protectedHosts }
}

/**
 * Whether a hostname is a loopback, private, or link-local literal.
 * @param hostname hostname as parsed by WHATWG URL (IPv6 keeps brackets).
 * @returns true for local-only addresses.
 */
export function isPrivateHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/gu, '')
  if (host === 'localhost' || host === '::' || host === '::1') return true
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/u.exec(host)
  if (mapped !== null) return isPrivateHost(mapped[1])
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(host)
  if (ipv4 !== null) {
    const first = Number(ipv4[1])
    const second = Number(ipv4[2])
    return first === 0 || first === 10 || first === 127
      || (first === 169 && second === 254)
      || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && second === 168)
  }
  if (host.includes(':')) return /^(fc|fd)/u.test(host) || /^fe[89ab]/u.test(host)
  return false
}

/**
 * Whether one network request from the test page may proceed. Protected
 * entries and private hosts are refused; the instance origin is the only
 * private destination allowed. Public resources (CDNs, fonts) still load.
 * @param value requested URL.
 * @param guards result of {@link guardConfig}.
 * @param instanceOrigin the instance URL whose page is under test.
 * @returns true when the request may continue.
 */
export function isRequestAllowed(value, guards, instanceOrigin) {
  if (isProtectedUrl(value, guards)) return false
  const url = hostUrl(value)
  if (url === null) return true
  if (!isPrivateHost(url.hostname)) return true
  return hostKeyOf(value) === hostKeyOf(instanceOrigin)
}

/**
 * Whether a URL would reach the live environment.
 * @param value URL instance or string.
 * @param guards result of {@link guardConfig}.
 * @returns true when the host and port are protected.
 */
export function isProtectedUrl(value, guards) {
  const key = hostKeyOf(value)
  return key !== null && guards.protectedHosts.has(key)
}

/**
 * Ports that a temporary instance must not bind: the live server and every
 * configured public entry point.
 * @param guards result of {@link guardConfig}.
 * @returns the set of port numbers.
 */
export function forbiddenPorts(guards) {
  const ports = new Set()
  for (const key of guards.protectedHosts) {
    const port = key.slice(key.lastIndexOf(':') + 1)
    if (/^[0-9]+$/u.test(port)) ports.add(Number(port))
  }
  return ports
}

/**
 * Refuse a target that is not the expected HTTP(S) instance origin or that
 * would reach the live environment.
 * @param value target URL instance or string.
 * @param guards result of {@link guardConfig}.
 * @param options the expected instance origin and id.
 * @returns the parsed target URL.
 * @throws when the target is not allowed.
 */
export function assertAllowedTarget(value, guards, options = {}) {
  const url = httpUrl(value)
  if (url === null) {
    throw new Error(`e2e 拒绝非 HTTP(S) 目标：${String(value)}。这个工具只测隔离实例的页面。`)
  }
  if (isProtectedUrl(url, guards)) {
    throw new Error(
      `e2e 拒绝访问正式环境 ${url.origin}。这个工具只打开 e2e_instance 的临时实例；`
      + '正式环境的地址、端口和登录态都不交给浏览器工具。',
    )
  }
  if (options.instanceOrigin !== undefined) {
    const expected = originOf(options.instanceOrigin)
    if (expected === null || url.origin !== expected) {
      throw new Error(
        `e2e 拒绝访问实例 ${options.instanceId ?? ''} 之外的地址 ${url.origin}；`
        + `只允许该实例的 ${expected ?? '(无效实例 URL)'}。`,
      )
    }
  }
  return url
}
