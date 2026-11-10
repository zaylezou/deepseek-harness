/**
 * e2e_instance：隔离的临时 DSH 实例。
 *
 * 独立 DSH_HOME、随机端口，工作区固定为 <当前工作区>/e2e_instance/<id>/。
 * 镜像当前 profile 的插件组合，up 时装依赖并起 dsh web，down 时清理 home。
 */
import { spawn } from 'node:child_process'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:net'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { forbiddenPorts, guardConfig } from './guard.js'

const run = promisify(execFile)

const DEFAULT_EXCLUDE = ['dsh-qq-onebot', 'dsh-webui-auth', 'dsh-bili-watch', '@deepseek-ai/dsh-experimental-inspector-profile']

/** 没有这两个 bundle 就没有页面可测；白名单也不能把它们剔掉。 */
const REQUIRED_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']

/** 每个临时实例都带上的限权插件；它是独立包，由 dsh-e2e 注入临时 profile。 */
const LOCKDOWN_BUNDLE = 'dsh-e2e-lockdown'

/** 锁定实例里直接拒绝的工具；plugin_manager 另有服务级禁用，这里是第二道。 */
export const DEFAULT_LOCKDOWN_DENY_TOOLS = ['plugin_manager', 'e2e', 'e2e_instance', 'ntfy_send', 'ntfy_send_file', 'dsh_restart', 'dsh_safe_restart']

function lockdownPackageDir(config) {
  const configured = String(config.lockdownPackageDir ?? '').trim()
  if (configured) return resolve(configured)
  // src/ 的上两级是 dsh-e2e，再上一级是 local-plugins；限权插件与它同级。
  return resolve(import.meta.dirname, '..', '..', LOCKDOWN_BUNDLE)
}

/** JSON 字符串就是合法的 YAML 双引号标量；路径里有冒号/空格也不会坏。 */
function yamlQuote(value) {
  return JSON.stringify(String(value))
}

/**
 * 生成临时 profile 的锁定 patch。真实路径只进临时 home，不写进仓库。
 *
 * 关键点：后层 patch 整块替换 config，所以这里把 sandbox-policy / approval /
 * permission / webserver 的整块键都写全；禁用行只按 id，不依赖 bundle 名字。
 * @param {string} workspacePath - 实例唯一工作区（绝对路径）。
 * @param {{host?: string, denyTools?: string[]}} [options] - 监听地址与额外禁用工具。
 * @returns {string} 追加到 profile patch 末尾的 YAML 文本。
 */
export function buildLockdownPatch(workspacePath, options = {}) {
  const host = String(options.host ?? '').trim() || '127.0.0.1'
  const denyTools = Array.isArray(options.denyTools) && options.denyTools.length > 0
    ? options.denyTools.map((name) => String(name).trim()).filter((name) => name !== '')
    : DEFAULT_LOCKDOWN_DENY_TOOLS
  const lines = [
    '',
    '# e2e 锁定：workspace-write 上限 + 审批全拒绝。由 dsh-e2e 自动追加。',
    '# 不要把这些行挪到源 profile；workspaceRoot / host 是每个实例自己的值。',
    '- id: sandbox-policy',
    "  name: '@deepseek-ai/dsh-sandbox-policy'",
    '  config:',
    '    mode: workspace-write',
    `    workspaceRoot: ${yamlQuote(workspacePath)}`,
    '- id: approval',
    "  name: '@deepseek-ai/dsh-user-approval'",
    '  config:',
    '    policy: never',
    '- id: permission',
    "  name: '@deepseek-ai/dsh-permission-presets'",
    '  config:',
    '    presets:',
    '      locked:',
    '        sandbox: workspace-write',
    '        approval: never',
    `        name: ${yamlQuote('锁定（e2e）')}`,
    `        description: ${yamlQuote('临时实例：只能修改工作区，审批一律拒绝。')}`,
    '    defaultPreset: locked',
    '- id: webserver',
    "  name: '@deepseek-ai/dsh-host-webserver'",
    '  config:',
    `    host: ${yamlQuote(host)}`,
    '    port: !!js ctx.webStartup.port ?? 0',
    '    compression: gzip',
    '    compressionLevel: 1',
    '    compressionThresholdBytes: 1024',
    '# Auto review 的固定预设会要求最高权限 + 审批；锁定实例里不提供这个入口。',
    '- id: auto-review',
    '  disabled: true',
    '# 插件管理服务不能直接禁用：standard 预设里的 tool-plugin-manager 注入它，',
    '# 服务缺失会让所有会话创建失败。保留服务，由 dsh-e2e-lockdown 把写方法全部拒绝；',
    '# 页面入口另关，避免从 UI 触发。',
    '- id: ui-plugin-manager',
    '  disabled: true',
    '- id: ui-open-in-app',
    '  disabled: true',
    '# MCP server 由 host 进程拉起，能绕过文件沙箱；锁定实例不提供。',
    '- id: mcp-manager',
    '  disabled: true',
    '# 浏览器终端是 host 直接 spawn 的 shell（源码里明确写了 without Agent sandbox or approval），',
    '# 它会是整个锁定最大的旁路；连服务带 UI 一起关。',
    '- id: terminal-controller',
    '  disabled: true',
    '- id: ui-sidebar-terminal',
    '  disabled: true',
    '# 打开本机应用同样属于 host 侧动作；headless 上也不该出现。',
    '- id: open-in-app',
    '  disabled: true',
    '# 重启插件从 cgroup 认出的是主实例的 dsh-web.service；临时实例里点一下会重启主实例。',
    '- id: dsh-restart-anywhere',
    '  disabled: true',
    '- id: dsh-e2e-lockdown',
    "  name: 'dsh-e2e-lockdown'",
    '  config:',
    '    mode: always',
    '    sandboxMode: workspace-write',
    `    workspaceRoot: ${yamlQuote(workspacePath)}`,
    '    denyTools:',
    ...denyTools.map((name) => `      - ${yamlQuote(name)}`),
  ]
  return `${lines.join('\n')}\n`
}

function checkoutRoot() {
  // src/ 的上两级就是 fork 的 checkout 根目录；环境变量优先。
  return process.env.DSH_E2E_CHECKOUT || resolve(import.meta.dirname, '..', '..', '..')
}

function instancesDir(config) {
  const configured = String(config.instancesDir ?? '').trim()
  return configured || join(homedir(), '.cache', 'dsh-e2e', 'instances')
}

function sourceHome(config) {
  const configured = String(config.sourceHome ?? '').trim()
  if (configured) return configured
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/**
 * 把主实例的 LLM 凭据快照到临时 home。
 *
 * 用拷贝而不是软链：临时实例里的模型页也会写凭据，软链会把临时环境的写入
 * 带回真实 store。拷贝是启动时的一次快照，主实例之后换 key 就重新 up。
 */
async function shareCredentials(config, home) {
  if (config.shareCredentials === false) return null
  const from = join(sourceHome(config), '.credentials.yaml')
  if (!existsSync(from)) return null
  const to = join(home, '.credentials.yaml')
  await cp(from, to)
  await chmod(to, 0o600)
  return to
}

/**
 * 给临时实例种一个工作区：只放调用工具那个会话的工作目录。
 *
 * 不种的话首页会弹「无法创建默认工作区」，而且测试拿不到确定的工作区语义。
 * 以主实例的 workspace.json 为模板（保留 schema 里可能新增的字段），只把
 * workspaceIds / 表项替换成这一个工作区，会话列表清空。
 */
async function seedWorkspace(config, home, workspacePath) {
  if (!workspacePath) return null
  await mkdir(workspacePath, { recursive: true })
  const dir = join(home, 'storages')
  await mkdir(dir, { recursive: true })
  let template = null
  try {
    template = JSON.parse(await readFile(join(sourceHome(config), 'storages', 'workspace.json'), 'utf8'))
  } catch { /* 没有模板就按 v2 结构手写 */ }

  const id = randomUUID()
  const now = new Date().toISOString()
  const state = {
    unit: template?.unit ?? { name: 'workspace', version: 2 },
    global: {
      initialized: true,
      workspaceIds: [id],
      archivedSessionIds: [],
      pinnedSessionIds: [],
    },
    tables: {
      workspaces: {
        [id]: {
          path: workspacePath,
          title: basename(workspacePath) || workspacePath,
          sessionIds: [],
          createdAt: now,
          updatedAt: now,
        },
      },
    },
  }
  const file = join(dir, 'workspace.json')
  await writeFile(file, JSON.stringify(state), 'utf8')
  return { id, path: workspacePath, file }
}

function sourceProfile(config) {
  const configured = String(config.sourceProfileDir ?? '').trim()
  return configured || join(homedir(), '.dsh', 'profiles', 'web')
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolvePort(port))
    })
  })
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** 杀掉 detached 实例的进程组；失败时再单独杀一次主进程。 */
function killTree(pid) {
  try { process.kill(-pid, 'SIGKILL') } catch { /* already gone */ }
  try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
}

/** Reject ids that could escape the instance directory or the workspace root. */
function assertSafeId(id) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(id)) {
    throw new Error(`实例 id 只能包含字母、数字、点、下划线和短横线（1-64 位），收到 "${id}"`)
  }
}

async function readState(dir, id) {
  try {
    return JSON.parse(await readFile(join(dir, `${id}.json`), 'utf8'))
  } catch {
    return null
  }
}

async function writeState(dir, state) {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, `${state.id}.json`), JSON.stringify(state, null, 2), 'utf8')
}

async function healthCheck(url) {
  try {
    const response = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(2500),
      headers: { Accept: 'text/html,application/xhtml+xml' },
    })
    return [200, 302, 303, 401].includes(response.status)
  } catch {
    return false
  }
}

async function sleep(ms) {
  await new Promise((done) => setTimeout(done, ms))
}

async function mirrorProfile(config, home, exclude, enable = [], options = {}) {
  const source = sourceProfile(config)
  if (!existsSync(join(source, 'package.json'))) {
    throw new Error(`找不到源 profile：${source}（用 sourceProfileDir 指定）`)
  }
  const profile = join(home, 'profiles', 'web')
  await mkdir(profile, { recursive: true })

  for (const file of ['package.json', 'cordis.patch.yml', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
    const from = join(source, file)
    if (existsSync(from)) await cp(from, join(profile, file))
  }

  const manifest = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'))
  const bundles = Array.isArray(manifest?.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : []
  manifest.dsh = manifest.dsh ?? {}
  manifest.dsh.profile = manifest.dsh.profile ?? {}

  // 白名单：只保留核心 bundle + 点名要的。没有基础组合连页面都起不来，
  // 所以 `@deepseek-ai/dsh-base` / `@deepseek-ai/dsh-web-app` 永远在场。
  const wanted = enable.filter((name) => name !== '*' && name.length > 0)
  const unknown = wanted.filter((name) => !bundles.includes(name) && !REQUIRED_BUNDLES.includes(name))
  const keep = wanted.length === 0
    ? bundles
    : bundles.filter((name) => REQUIRED_BUNDLES.includes(name) || wanted.includes(name))
  // 限权插件是能力边界的一部分，不能被 enable 白名单漏掉，也不能被 exclude 关掉；
  // lockdown:false 时反过来要把它拿掉，否则 DSH_E2E_INSTANCE=1 会让默认 mode:auto 自己激活。
  const lockdown = options.lockdown === true
  const lockdownExcluded = lockdown && exclude.includes(LOCKDOWN_BUNDLE)
  let kept = keep.filter((name) => !exclude.includes(name))
  if (!lockdown) kept = kept.filter((name) => name !== LOCKDOWN_BUNDLE)
  const dropped = bundles.filter((name) => !kept.includes(name))

  if (lockdown) {
    // 永远放在最后：它的 approval prepend / pluginManager wrapper 要拿到最外层。
    kept = [...kept.filter((name) => name !== LOCKDOWN_BUNDLE), LOCKDOWN_BUNDLE]
    manifest.dependencies = manifest.dependencies !== null && typeof manifest.dependencies === 'object'
      ? manifest.dependencies
      : {}
    if (manifest.dependencies[LOCKDOWN_BUNDLE] === undefined) {
      const dir = lockdownPackageDir(config)
      if (!existsSync(join(dir, 'package.json'))) {
        throw new Error(
          `锁定插件 ${LOCKDOWN_BUNDLE} 不在 ${dir}。`
          + '把 local-plugins/dsh-e2e-lockdown 放回去，或用 lockdownPackageDir 指定。',
        )
      }
      manifest.dependencies[LOCKDOWN_BUNDLE] = `link:${dir}`
    }
  }
  manifest.dsh.profile.bundles = kept
  await writeFile(join(profile, 'package.json'), JSON.stringify(manifest, null, 2), 'utf8')

  // 被排除/未启用的 bundle 如果还有 override 行留在 patch 里，Loader 会找不到
  // 对应的 insert。追加禁用行比删行安全：禁用是幂等的，未知 id 也不会让启动失败。
  const patchFile = join(profile, 'cordis.patch.yml')
  const chunks = []
  if (existsSync(patchFile)) {
    const existing = (await readFile(patchFile, 'utf8')).trimEnd()
    if (existing !== '') chunks.push(existing)
  }
  const disabledNames = [...new Set([...dropped, ...exclude])]
    .filter((name) => !(lockdown && name === LOCKDOWN_BUNDLE))
  if (disabledNames.length > 0) {
    const lines = ['# e2e 临时实例：关掉没启用的 bundle']
    for (const name of disabledNames) {
      lines.push(`- id: '${name}'`, `  name: '${name}'`, '  disabled: true')
    }
    chunks.push(lines.join('\n'))
  }
  if (lockdown) {
    chunks.push(buildLockdownPatch(options.workspacePath, {
      host: options.host,
      denyTools: options.denyTools,
    }).trimEnd())
  }
  if (chunks.length > 0) await writeFile(patchFile, `${chunks.join('\n\n')}\n`, 'utf8')

  return { profile, kept, dropped, unknown, lockdown, lockdownExcluded }
}

async function install(profile) {
  await run('pnpm', ['install', '--no-frozen-lockfile'], {
    cwd: profile,
    timeout: 300000,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, CI: '1' },
  })
}

async function launch(config, profile, home, port) {
  const logFile = join(home, 'dsh-web.log')
  const log = await import('node:fs').then((fs) => fs.openSync(logFile, 'a'))
  const args = [
    '--import', 'tsx/esm',
    'apps/cli/src/bin.ts',
    'web',
    '--port', String(port),
    '--no-open',
  ]
  // 不写死绑定地址：默认让镜像过来的 composition 决定（它可能配了具体网卡），
  // 需要时用 instanceHost 覆盖。实际地址从启动日志里打印的 token URL 反推。
  const host = String(config.instanceHost ?? '').trim()
  if (host) {
    args.push(
      '--host', host,
      '--public-url', `http://${host}:${port}/`,
      '--trusted-host', `${host}:${port}`,
      '--trusted-host', `127.0.0.1:${port}`,
    )
  }
  const child = spawn(
    process.execPath,
    args,
    {
      cwd: checkoutRoot(),
      // 标记这是隔离实例：e2e 守卫不再把它自己的端口当成正式环境，
      // 但 profile 里的正式入口（protectedOrigins）仍然拒绝。
      env: { ...process.env, DSH_HOME: home, DSH_E2E_INSTANCE: '1' },
      detached: true,
      stdio: ['ignore', log, log],
    },
  )
  child.unref()
  return { pid: child.pid, logFile }
}

async function tail(file, lines = 20) {
  try {
    const text = await readFile(file, 'utf8')
    return text.trim().split('\n').slice(-lines).join('\n')
  } catch {
    return ''
  }
}

export async function up(config, options) {
  const dir = instancesDir(config)
  const id = String(options?.id ?? '').trim() || `e2e-${Date.now().toString(36)}`
  assertSafeId(id)
  const wanted = (Array.isArray(options?.enable) ? options.enable : [])
    .map((name) => String(name).trim())
    .filter((name) => name.length > 0 && name !== '*')
  // 显式 enable 会顶掉配置里的默认排除（比如点名要 webui-auth 来测登录页），
  // 但调用方自己传的 exclude 永远优先。
  const configuredExclude = Array.isArray(config.excludeBundles) && config.excludeBundles.length > 0
    ? config.excludeBundles.map(String)
    : DEFAULT_EXCLUDE
  const exclude = Array.isArray(options?.exclude) && options.exclude.length > 0
    ? options.exclude.map(String)
    : configuredExclude.filter((name) => !wanted.includes(name))
  // 默认锁定；只有显式 lockdown:false（或配置里关掉）才放行。关掉是调试逃生门。
  const lockdown = options?.lockdown === false ? false : config.lockdown !== false

  const existing = await readState(dir, id)
  if (existing && alive(existing.pid)) {
    // 同一个 id 已经在跑：组合不同就提醒，别让人以为换了 enable 会生效。
    const mismatch = JSON.stringify(existing.enable ?? []) !== JSON.stringify(wanted)
      || JSON.stringify(existing.exclude ?? []) !== JSON.stringify(exclude)
      || existing.lockdown !== lockdown
    return { ...existing, reused: true, reusedMismatch: mismatch }
  }
  if (existing) await rm(existing.home, { recursive: true, force: true })

  const home = join(dir, id, 'home')
  await mkdir(home, { recursive: true })
  const startedAt = Date.now()
  await shareCredentials(config, home)
  // 工作区固定为「当前工作区/e2e_instance/<实例名>/」，不指向当前工作区本身。
  const workspaceRoot = String(options?.workspaceRoot ?? '').trim() || process.cwd()
  const workspacePath = join(workspaceRoot, 'e2e_instance', id)
  const workspace = await seedWorkspace(config, home, workspacePath)
  let mirrored
  try {
    mirrored = await mirrorProfile(config, home, exclude, wanted, {
      lockdown,
      workspacePath,
      host: String(config.instanceHost ?? '').trim(),
      denyTools: config.lockdownDenyTools,
    })
  } catch (error) {
    await rm(join(dir, id), { recursive: true, force: true }).catch(() => {})
    throw error
  }
  await install(mirrored.profile)

  const port = Number(options?.port) > 0 ? Number(options.port) : await freePort()
  const { pid, logFile } = await launch(config, mirrored.profile, home, port)
  let url = ''
  let baseUrl = ''

  // 核心启动时会打印 token 链接；实际监听地址以它为准，不在代码里猜。
  const deadline = Date.now() + 90000
  let healthy = false
  while (Date.now() < deadline) {
    if (!alive(pid)) break
    const text = await tail(logFile, 400)
    const tokenUrl = /(https?:\/\/[^\s]+\?token=[A-Za-z0-9_-]+)/.exec(text)?.[1]
    if (tokenUrl) {
      url = tokenUrl
      baseUrl = tokenUrl.replace(/\?.*$/, '')
      if (await healthCheck(url)) {
        healthy = true
        break
      }
    }
    await sleep(600)
  }

  if (!healthy) {
    killTree(pid)
    const output = await tail(logFile, 30)
    await rm(join(dir, id), { recursive: true, force: true }).catch(() => {})
    throw new Error(`临时实例没起来（${url}）。日志 ${logFile}\n${output}`)
  }

  // 锁定实例必须验证插件真的装上并生效，不能把「看起来起来了、实际没锁」的实例交出去。
  if (lockdown) {
    const bootLog = await tail(logFile, 800)
    if (!bootLog.includes('[dsh-e2e-lockdown] active:')) {
      killTree(pid)
      const output = await tail(logFile, 60)
      await rm(join(dir, id), { recursive: true, force: true }).catch(() => {})
      throw new Error(
        `临时实例起来了，但限权插件没有激活；拒绝交出未锁定的实例。`
        + `\n用 lockdown:false 只能用于调试锁定插件本身。日志 ${logFile}\n${output}`,
      )
    }
    const requestedHost = String(config.instanceHost ?? '').trim()
    if (requestedHost === '' && !/^http:\/\/127\.0\.0\.1:\d+\//u.test(url)) {
      killTree(pid)
      const output = await tail(logFile, 40)
      await rm(join(dir, id), { recursive: true, force: true }).catch(() => {})
      throw new Error(`锁定实例没有绑在回环地址（${url}）。检查 profile patch 里的 webserver.host。\n${output}`)
    }
  }

  const state = {
    id,
    url,
    baseUrl,
    port,
    pid,
    home,
    logFile,
    exclude,
    enable: wanted,
    bundles: mirrored.kept,
    unknownEnable: mirrored.unknown,
    lockdown,
    lockdownExcluded: mirrored.lockdownExcluded,
    workspace: workspace ? { path: workspace.path, title: basename(workspace.path) } : null,
    createdAt: new Date().toISOString(),
    bootMs: Date.now() - startedAt,
  }
  await writeState(dir, state)
  return state
}

export async function down(config, options) {
  const dir = instancesDir(config)
  const id = String(options?.id ?? '').trim()
  if (!id) throw new Error('down 需要 id（先 up，或 list 看有哪些）')
  assertSafeId(id)
  const state = await readState(dir, id)
  if (!state) throw new Error(`没有这个临时实例：${id}`)

  let stopped = false
  if (alive(state.pid)) {
    try { process.kill(-state.pid, 'SIGTERM') } catch { /* try self */ }
    try { process.kill(state.pid, 'SIGTERM') } catch { /* ignore */ }
    for (let i = 0; i < 40 && alive(state.pid); i += 1) await sleep(150)
    if (alive(state.pid)) {
      try { process.kill(-state.pid, 'SIGKILL') } catch { /* ignore */ }
      try { process.kill(state.pid, 'SIGKILL') } catch { /* ignore */ }
    }
    stopped = true
  }
  await rm(join(dir, id), { recursive: true, force: true })
  await rm(join(dir, `${id}.json`), { force: true })
  return { id, stopped }
}

export async function list(config) {
  const dir = instancesDir(config)
  let names = []
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith('.json'))
  } catch {
    return []
  }
  const states = []
  for (const name of names) {
    const state = await readState(dir, name.replace(/\.json$/, ''))
    if (state) states.push({ ...state, alive: alive(state.pid) })
  }
  return states.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
}

export async function getInstance(config, id) {
  const instanceId = String(id)
  assertSafeId(instanceId)
  const state = await readState(instancesDir(config), instanceId)
  if (!state) throw new Error(`没有这个临时实例：${id}`)
  if (!alive(state.pid)) throw new Error(`临时实例 ${id} 的进程已经没了；重新 up 一个`)
  return state
}

export function registerInstanceTool(ctx, config) {
  ctx.tools.register({
    name: 'e2e_instance',
    description:
      '管理隔离的临时 DSH 实例，给端到端测试用：镜像当前 profile 的插件组合，'
      + '在独立 DSH_HOME 和随机端口上跑一个 dsh web，工作区放在当前工作区的 e2e_instance/<实例名>/，测试完 down 掉，不碰用户正在用的实例和数据。'
      + '默认排除 dsh-qq-onebot（避免抢 NapCat 连接）和 dsh-webui-auth（临时环境没有凭据，会挡在设置页）。'
      + 'enable 给一组 bundle 名时只启用它们（基础组合 dsh-base / dsh-web-app 始终启用），用来隔离某个插件的回归。'
      + '默认 lockdown：实例被锁在 workspace-write 上限、审批全部拒绝，plugin_manager / e2e / e2e_instance 等越权入口禁用；'
      + 'lockdown:false 是调试锁定插件本身的逃生门，不要用在不可信模型上。'
      + 'up 返回 url，可直接把实例 id 传给 e2e 工具的 instance 参数。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['up', 'down', 'list'] },
        id: { type: 'string', description: '实例 id；up 不填则自动生成，down 必填' },
        enable: {
          type: 'array',
          items: { type: 'string' },
          description: 'up 时只启用这些 bundle（白名单）。基础组合 @deepseek-ai/dsh-base 与 '
            + '@deepseek-ai/dsh-web-app 始终启用；点名 enable 的 bundle 不受默认排除影响。不填 = 全部启用。',
        },
        exclude: {
          type: 'array',
          items: { type: 'string' },
          description: 'up 时要排除的 bundle 名；不填用插件配置的 excludeBundles。显式 exclude 优先于 enable',
        },
        port: { type: 'number', description: 'up 时指定端口；不填随机空闲端口。正式端口会被拒绝' },
        lockdown: {
          type: 'boolean',
          description: 'up 时是否锁定实例（默认 true）：workspace-write 上限 + 审批全拒绝 + 禁用插件/MCP 管理与越权工具。'
            + 'false 只用于调试锁定插件本身，会留下越权能力。',
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          text: { type: 'string' },
          instance: { type: 'object', additionalProperties: true },
          instances: { type: 'array', items: { type: 'object', additionalProperties: true } },
        },
        required: ['ok', 'text'],
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      const action = String(args?.action ?? '')
      if (action === 'up') {
        if (Object.hasOwn(args ?? {}, 'workspace')) {
          throw new Error('e2e_instance 不再接受 workspace：工作区固定在 <当前工作区>/e2e_instance/<id>/。')
        }
        const guards = guardConfig(ctx.get('webServer'), config)
        const requestedPort = Number(args?.port)
        if (Number.isInteger(requestedPort) && requestedPort > 0 && forbiddenPorts(guards).has(requestedPort)) {
          throw new Error(
            `e2e_instance 拒绝使用正式环境端口 ${requestedPort}；请留空让工具选随机空闲端口，`
            + '或显式换一个测试端口。',
          )
        }
        // 工作区：当前会话工作区下的 e2e_instance/<实例名>/，不把当前工作区整棵交给实例。
        let workspaceRoot
        try {
          const wd = ctx.get('workingDirectory')
          workspaceRoot = exec?.agent === undefined || wd === undefined
            ? undefined
            : await wd.ensure(exec.agent, exec.signal)
        } catch { /* 拿不到就由 up 用 process.cwd() */ }
        const state = await up(config, { ...args, workspaceRoot })
        const scope = Array.isArray(state.enable) && state.enable.length > 0
          ? `仅启用 ${state.enable.join(', ')}`
          : `${Array.isArray(state.bundles) ? state.bundles.length : 0} 个 bundle`
        const warnings = Array.isArray(state.unknownEnable) && state.unknownEnable.length > 0
          ? `\n⚠ 源 profile 里没有这些 bundle：${state.unknownEnable.join(', ')}`
          : ''
        const stale = state.reusedMismatch === true
          ? '\n⚠ 这个实例是按另一套组合起的；要换组合先 down 再 up'
          : ''
        const lock = state.lockdown
          ? '\n🔒 锁定：workspace-write 上限（根固定为实例工作区），审批一律拒绝；plugin_manager 写操作 / mcp-manager / e2e / e2e_instance 已禁用'
          : '\n⚠ 未锁定（lockdown: false）：这个实例仍可越权，只应用于调试锁定插件本身'
        const forced = state.lockdownExcluded
          ? '\n⚠ exclude 里的 dsh-e2e-lockdown 被忽略：锁定默认开启，要关请用 lockdown:false'
          : ''
        return {
          ok: true,
          text: (state.reused
            ? `临时实例 ${state.id} 已经在跑：${state.url}`
            : `临时实例 ${state.id} 已启动：${state.url}（${(state.bootMs / 1000).toFixed(1)}s，home=${state.home}，workspace=${state.workspace?.path ?? '(none)'}）`)
            + `\n组合：${scope}${warnings}${stale}${lock}${forced}`,
          instance: state,
        }
      }
      if (action === 'down') {
        const result = await down(config, args)
        return { ok: true, text: `临时实例 ${result.id} 已停止并清理` }
      }
      if (action === 'list') {
        const states = await list(config)
        return {
          ok: true,
          text: states.length === 0
            ? '没有临时实例'
            : states.map((state) => `${state.id} ${state.alive ? 'running' : 'dead'} ${state.lockdown === false ? 'UNLOCKED' : 'locked'} ${state.url}`).join('\n'),
          instances: states,
        }
      }
      throw new Error(`action 只能是 up / down / list，收到 "${action}"`)
    },
  })
}
