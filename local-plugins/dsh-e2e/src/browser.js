/**
 * 浏览器供给：优先连一台已经跑着的专用浏览器（CDP），连不上就自己起一个
 * docker 容器跑 Chromium。
 *
 * 为什么用容器：宿主机上没有 chromium，而 Playwright 镜像里自带浏览器和全套
 * 依赖。容器必须是 host 网络：Chrome 的 DevTools 端口只接受来自回环地址的
 * 连接，走 docker 端口映射时对端是网桥地址（不是回环），会被直接 reset。
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { chromium } from 'playwright-core'

const run = promisify(execFile)

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

let cached = null

function describeError(error) {
  const text = error && typeof error === 'object'
    ? (error.stderr || error.message || String(error))
    : String(error)
  return String(text).trim().slice(0, 800)
}

async function connect(endpoint) {
  try {
    return await chromium.connectOverCDP(endpoint, { timeout: 5000 })
  } catch {
    return null
  }
}

async function waitForCdp(endpoint, deadline) {
  while (Date.now() < deadline) {
    const browser = await connect(endpoint)
    if (browser !== null) return browser
    await new Promise((resolve) => setTimeout(resolve, 700))
  }
  return null
}

function chromeLaunchScript(port) {
  // 镜像里的 chromium 目录名带版本号；headless shell 也可能在，但先找完整版。
  return [
    'set -e',
    'CHROME=$(ls -d /ms-playwright/chromium-*/chrome-linux*/chrome 2>/dev/null | head -1 || true)',
    '[ -n "$CHROME" ] || CHROME=$(command -v chromium || command -v chromium-browser || command -v google-chrome || true)',
    '[ -x "$CHROME" ] || { echo "no chromium found in image" >&2; exit 1; }',
    `exec "$CHROME" --headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage --hide-scrollbars --force-color-profile=srgb --remote-debugging-port=${port} --remote-debugging-address=127.0.0.1 --user-data-dir=/tmp/dsh-e2e-profile about:blank`,
  ].join('\n')
}

async function startContainer(config) {
  const endpoint = new URL(String(config.cdpUrl))
  if (!LOOPBACK.has(endpoint.hostname)) {
    throw new Error(`cdpUrl 不是本机地址（${endpoint.hostname}），无法自动启动容器；请手动启动浏览器或配置 executablePath`)
  }
  const port = endpoint.port || '9222'
  const name = String(config.containerName ?? '').trim() || 'dsh-e2e-browser'
  const image = String(config.dockerImage ?? '').trim() || 'mcr.microsoft.com/playwright:latest'

  await run('docker', ['rm', '-f', name]).catch(() => {})
  try {
    await run('docker', [
      'run', '-d', '--rm',
      '--name', name,
      '--network', 'host',
      '--entrypoint', 'sh',
      image,
      '-c', chromeLaunchScript(port),
    ], { timeout: 180000 })
  } catch (error) {
    throw new Error(`启动专用浏览器容器失败：${describeError(error)}`)
  }
}

/**
 * 取得一台可用的 Chromium。
 * @param {object} config 插件配置（cdpUrl / autoStart / dockerImage / containerName / executablePath）
 */
export async function ensureBrowser(config) {
  const executablePath = String(config.executablePath ?? '').trim()
  if (executablePath) {
    if (cached?.kind === 'local' && cached.browser.isConnected()) return cached.browser
    const browser = await chromium.launch({
      executablePath,
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    })
    cached = { kind: 'local', browser }
    return browser
  }

  const endpoint = String(config.cdpUrl ?? '').trim() || 'http://127.0.0.1:9334'
  if (cached?.kind === 'cdp' && cached.endpoint === endpoint && cached.browser.isConnected()) {
    return cached.browser
  }

  let browser = await connect(endpoint)
  if (browser === null && config.autoStart !== false) {
    await startContainer({ ...config, cdpUrl: endpoint })
    browser = await waitForCdp(endpoint, Date.now() + 30000)
  }
  if (browser === null) {
    throw new Error(
      `连不上专用浏览器（${endpoint}）。自动启动${config.autoStart === false ? '已关闭' : '也失败了'}；`
      + `也可以用 executablePath 指定本机 chromium。`,
    )
  }
  cached = { kind: 'cdp', endpoint, browser }
  return browser
}
