/**
 * 临时 DSH 实例：给端到端测试用的隔离环境。
 *
 * 为什么要它：测 GUI 时如果直接打用户正在用的实例，点会话、发消息、弹提问卡
 * 都会落进真实数据里。这里在独立的 DSH_HOME 里镜像当前 profile 的组合
 * （同样的 local 插件、同样的 patch），装一遍依赖后用随机端口单独跑一个
 * `dsh web`，测试完整个目录删掉。
 *
 * 默认排除两个 bundle：
 *   - dsh-qq-onebot：第二个实例再连一次 NapCat 会和主实例抢同一个 bot；
 *   - dsh-webui-auth：临时环境没有凭据，留着只会把页面挡在首次设置页；
 *   - dsh-bili-watch：它的状态轮询在临时实例里固定 403，纯噪声；
 *   - inspector：它会占住固定的 9231 端口，临时实例的页面连上去只会拿到 403。
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

const run = promisify(execFile)

const DEFAULT_EXCLUDE = ['dsh-qq-onebot', 'dsh-webui-auth', 'dsh-bili-watch', '@deepseek-ai/dsh-experimental-inspector-profile']

/** 没有这两个 bundle 就没有页面可测；白名单也不能把它们剔掉。 */
const REQUIRED_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']

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

async function mirrorProfile(config, home, exclude, enable = []) {
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
  const kept = keep.filter((name) => !exclude.includes(name))
  const dropped = bundles.filter((name) => !kept.includes(name))
  manifest.dsh.profile.bundles = kept
  await writeFile(join(profile, 'package.json'), JSON.stringify(manifest, null, 2), 'utf8')

  // 被排除/未启用的 bundle 如果还有 override 行留在 patch 里，Loader 会找不到
  // 对应的 insert。追加禁用行比删行安全：禁用是幂等的，未知 id 也不会让启动失败。
  const patchFile = join(profile, 'cordis.patch.yml')
  if (existsSync(patchFile)) {
    const lines = ['', '# e2e 临时实例：关掉没启用的 bundle']
    for (const name of [...new Set([...dropped, ...exclude])]) {
      lines.push(`- id: '${name}'`, `  name: '${name}'`, '  disabled: true')
    }
    await writeFile(patchFile, `${await readFile(patchFile, 'utf8')}\n${lines.join('\n')}\n`, 'utf8')
  }

  return { profile, kept, dropped, unknown }
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
      env: { ...process.env, DSH_HOME: home },
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

  const existing = await readState(dir, id)
  if (existing && alive(existing.pid)) {
    // 同一个 id 已经在跑：组合不同就提醒，别让人以为换了 enable 会生效。
    const mismatch = JSON.stringify(existing.enable ?? []) !== JSON.stringify(wanted)
      || JSON.stringify(existing.exclude ?? []) !== JSON.stringify(exclude)
    return { ...existing, reused: true, reusedMismatch: mismatch }
  }
  if (existing) await rm(existing.home, { recursive: true, force: true })

  const home = join(dir, id, 'home')
  await mkdir(home, { recursive: true })
  const startedAt = Date.now()
  await shareCredentials(config, home)
  const workspace = await seedWorkspace(config, home, String(options?.workspace ?? '').trim())
  const mirrored = await mirrorProfile(config, home, exclude, wanted)
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
    try { process.kill(-pid, 'SIGKILL') } catch { /* already gone */ }
    try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
    const output = await tail(logFile, 30)
    await rm(join(dir, id), { recursive: true, force: true }).catch(() => {})
    throw new Error(`临时实例没起来（${url}）。日志 ${logFile}\n${output}`)
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
  const state = await readState(instancesDir(config), String(id))
  if (!state) throw new Error(`没有这个临时实例：${id}`)
  if (!alive(state.pid)) throw new Error(`临时实例 ${id} 的进程已经没了；重新 up 一个`)
  return state
}

export function registerInstanceTool(ctx, config) {
  ctx.tools.register({
    name: 'e2e_instance',
    description:
      '管理隔离的临时 DSH 实例，给端到端测试用：镜像当前 profile 的插件组合，'
      + '在独立 DSH_HOME 和随机端口上跑一个 dsh web，测试完删掉，不碰用户正在用的实例和数据。'
      + '默认排除 dsh-qq-onebot（避免抢 NapCat 连接）和 dsh-webui-auth（临时环境没有凭据，会挡在设置页）。'
      + 'enable 给一组 bundle 名时只启用它们（基础组合 dsh-base / dsh-web-app 始终启用），用来隔离某个插件的回归。'
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
        port: { type: 'number', description: 'up 时指定端口；不填随机空闲端口' },
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
        // 临时实例的工作区只能是调用方会话当前的工作目录。
        let workspace
        try {
          const wd = ctx.get('workingDirectory')
          workspace = exec?.agent === undefined || wd === undefined
            ? undefined
            : await wd.ensure(exec.agent, exec.signal)
        } catch { /* 拿不到就交给 up 的默认值 */ }
        const state = await up(config, { ...args, workspace })
        const scope = Array.isArray(state.enable) && state.enable.length > 0
          ? `仅启用 ${state.enable.join(', ')}`
          : `${Array.isArray(state.bundles) ? state.bundles.length : 0} 个 bundle`
        const warnings = Array.isArray(state.unknownEnable) && state.unknownEnable.length > 0
          ? `\n⚠ 源 profile 里没有这些 bundle：${state.unknownEnable.join(', ')}`
          : ''
        const stale = state.reusedMismatch === true
          ? '\n⚠ 这个实例是按另一套组合起的；要换组合先 down 再 up'
          : ''
        return {
          ok: true,
          text: (state.reused
            ? `临时实例 ${state.id} 已经在跑：${state.url}`
            : `临时实例 ${state.id} 已启动：${state.url}（${(state.bootMs / 1000).toFixed(1)}s，home=${state.home}）`)
            + `\n组合：${scope}${warnings}${stale}`,
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
            : states.map((state) => `${state.id} ${state.alive ? 'running' : 'dead'} ${state.url}`).join('\n'),
          instances: states,
        }
      }
      throw new Error(`action 只能是 up / down / list，收到 "${action}"`)
    },
  })
}
