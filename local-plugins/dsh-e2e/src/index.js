/**
 * dsh-e2e — 专用无头浏览器的端到端测试工具。
 *
 * 为什么要有它：验证 Web GUI 的改动时，以前是借 mijia-geek 那个 Playwright
 * 容器（docker cp 脚本 + docker exec + 从 dsh-webui-auth 里抠 token +
 * docker cp 截图回来）。那容器里跑着米家的持久登录浏览器，两边互相踩。
 *
 * 这个插件把整条链路收成一个工具调用：起一台专用 Chromium（默认是独立的
 * docker 容器，和 mijia 无关）、带上 DSH 登录态、按步骤操作页面、把 console
 * 错误和关键截图直接作为工具结果返回。
 */
import Schema from '@deepseek-ai/schemastery'
import { randomBytes } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureBrowser } from './browser.js'
import { cookiesFor } from './auth.js'
import { runSteps } from './steps.js'
import { getInstance, registerInstanceTool } from './instance.js'

export const name = 'dsh-e2e'
export const inject = ['tools']

export const Config = Schema.object({
  baseUrl: Schema.string()
    .default('')
    .description('默认打开的地址；留空则每次调用必须传 url'),
  auth: Schema.string()
    .default('none')
    .description('登录态来源：dsh = 复用 dsh-webui-auth 的会话 token；none = 不带登录态'),
  sessionsFile: Schema.string()
    .default('')
    .description('dsh-webui-auth 的 sessions.jsonl 绝对路径；auth=dsh 时必填'),
  cookieName: Schema.string()
    .default('dsh_wua_session')
    .description('会话 cookie 名'),
  cdpUrl: Schema.string()
    .default('http://127.0.0.1:9334')
    .description('专用浏览器的 CDP 地址'),
  autoStart: Schema.boolean()
    .default(true)
    .description('连不上 CDP 时自动 docker run 一个专用浏览器容器'),
  dockerImage: Schema.string()
    .default('mcr.microsoft.com/playwright:latest')
    .description('自动启动容器用的镜像（镜像里要有 chromium）'),
  containerName: Schema.string()
    .default('dsh-e2e-browser')
    .description('专用浏览器容器名'),
  executablePath: Schema.string()
    .default('')
    .description('改用本机 chromium 可执行文件时填这里（留空走容器/CDP）'),
  viewportWidth: Schema.number()
    .default(1440)
    .description('默认视口宽'),
  viewportHeight: Schema.number()
    .default(900)
    .description('默认视口高'),
  locale: Schema.string()
    .default('zh-CN')
    .description('浏览器 locale'),
  timeoutMs: Schema.number()
    .default(30000)
    .description('导航与全局超时上限（毫秒）'),
  actionTimeoutMs: Schema.number()
    .default(8000)
    .description('单个动作（click/fill/waitFor/assert/截图）的默认超时；写错选择器时不必空转到全局上限'),
  sessionIdleMs: Schema.number()
    .default(1800000)
    .description('命名会话（e2e 的 session 参数）闲置多久后自动关闭，默认 30 分钟'),
  maxSessions: Schema.number()
    .default(4)
    .description('最多同时保留几个命名会话；超出时关掉最久没用的'),
  maxScreenshots: Schema.number()
    .default(6)
    .description('单次最多内联返回几张图；超出的只给文件路径'),
  screenshotDir: Schema.string()
    .default('')
    .description('截图落盘目录；留空用系统临时目录'),
  sourceProfileDir: Schema.string()
    .default('')
    .description('临时实例镜像哪个 profile；留空用 ~/.dsh/profiles/web'),
  shareCredentials: Schema.boolean()
    .default(true)
    .description('把主实例的 LLM 凭据 .credentials.yaml 快照进临时 home，避免首页弹「开始使用」'),
  sourceHome: Schema.string()
    .default('')
    .description('凭据从哪个 DSH_HOME 取；留空用 DSH_HOME 环境变量或 ~/.dsh'),
  instanceHost: Schema.string()
    .default('')
    .description('临时实例监听地址；留空用镜像过来的 profile 配置，实际地址以启动日志里打印的为准'),
  instancesDir: Schema.string()
    .default('')
    .description('临时实例的 home 与状态文件放哪；留空用 ~/.cache/dsh-e2e/instances'),
  excludeBundles: Schema.array(Schema.string())
    .default(['dsh-qq-onebot', 'dsh-webui-auth', 'dsh-bili-watch', '@deepseek-ai/dsh-experimental-inspector-profile'])
    .description('临时实例默认排除的 bundle：避免抢 QQ 连接、避免卡在登录设置页、避免 bili 轮询 403、避免 inspector 端口冲突'),
})

const STEPS_DOC =
  '步骤写法：每步一个对象，键名就是动作。'
  + 'goto:"url"；click:"selector"（可选 nth）；fill:{selector,value}；press:"Enter"；hover:"selector"；'
  + 'selectOption:{selector,value}；waitFor:{selector,state?:visible|attached|hidden|detached}；wait:毫秒；'
  + 'eval:"(() => ...)()" 取值；screenshot:{name?,selector?,fullPage?}；'
  + 'assert:{url?|selector?,text?,count?,visible?,value?}；setViewport:{width,height}；reload:true。'
  + '每步可带 timeout / timeoutMs 覆盖该步超时（默认动作 8s、导航 30s，写错选择器会很快失败）。'
  + 'selector 用 Playwright 语法：CSS、text=、role=button[name="设置"] 都可以。'

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    text: { type: 'string' },
    url: { type: 'string' },
    title: { type: 'string' },
    durationMs: { type: 'number' },
    error: { type: 'string' },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          index: { type: 'number' },
          action: { type: 'string' },
          ok: { type: 'boolean' },
          ms: { type: 'number' },
          detail: { type: 'string' },
        },
        required: ['index', 'action', 'ok'],
      },
    },
    screenshots: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string' },
          path: { type: 'string' },
          attachmentId: { type: 'string' },
          mediaType: { type: 'string' },
          width: { type: 'number' },
          height: { type: 'number' },
          bytes: { type: 'number' },
          inline: { type: 'boolean' },
        },
        required: ['name', 'path'],
      },
    },
    consoleErrors: { type: 'array', items: { type: 'string' } },
    consoleWarnings: { type: 'array', items: { type: 'string' } },
    failedRequests: { type: 'array', items: { type: 'string' } },
    httpErrors: { type: 'array', items: { type: 'string' } },
  },
  required: ['ok', 'text'],
}

function positive(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function describe(error) {
  const text = error && typeof error === 'object' && 'message' in error ? error.message : String(error)
  return String(text).slice(0, 800)
}

/**
 * 命名的持久页面：`e2e` 传了 `session` 时，后续调用复用同一个 context/page，
 * 不再隐式 goto。这样「发消息 → 等回复 → 点结果」可以拆成几次调用，
 * 不必挤在一次调用里写完、也不会因为重新加载丢掉上一轮的状态。
 */
const SESSIONS = new Map()

/** 每条采集最多留这么多，避免长会话把内存和工具结果撑爆。 */
const COLLECT_LIMIT = 400

function push(list, text) {
  list.push(String(text).slice(0, 500))
  if (list.length > COLLECT_LIMIT) list.splice(0, list.length - COLLECT_LIMIT)
}

function collect() {
  return { consoleErrors: [], consoleWarnings: [], failedRequests: [], httpErrors: [] }
}

/**
 * 两个地址是不是「同一个页面」。查询串不参与比较：实例的 `?token=` 会被应用在
 * 登录换票后从地址栏抹掉，按整串比会把复用误判成「地址变了」而重新导航，
 * `session` 想保住的状态就全丢了。
 */
function samePage(a, b) {
  try {
    const left = new URL(String(a))
    const right = new URL(String(b))
    return left.origin === right.origin && left.pathname === right.pathname
  } catch {
    return String(a) === String(b)
  }
}

/** 采集器随页面只挂一次，调用之间靠索引切片，复用页面也能拿到本轮的新消息。 */
function attachCollectors(page, sink) {
  page.on('console', (message) => {
    const type = message.type()
    if (type === 'error') push(sink.consoleErrors, message.text())
    else if (type === 'warning') push(sink.consoleWarnings, message.text())
  })
  page.on('pageerror', (error) => { push(sink.consoleErrors, `pageerror: ${describe(error)}`) })
  page.on('requestfailed', (request) => {
    push(sink.failedRequests, `${request.method()} ${request.url()} — ${request.failure()?.errorText ?? 'failed'}`)
  })
  // 客户端插件 bundle 是批在一起取的，404 不会触发 requestfailed；HTTP ≥400 单独记。
  page.on('response', (response) => {
    const status = response.status()
    if (status >= 400) push(sink.httpErrors, `${status} ${response.request().method()} ${response.url()}`)
  })
}

async function closeSession(id) {
  const entry = SESSIONS.get(id)
  if (entry === undefined) return
  SESSIONS.delete(id)
  await entry.context.close().catch(() => {})
}

async function closeAllSessions() {
  for (const id of [...SESSIONS.keys()]) await closeSession(id)
}

async function sweepSessions(idleMs) {
  const now = Date.now()
  for (const [id, entry] of [...SESSIONS]) {
    if (entry.page.isClosed() || now - entry.lastUsed > idleMs) await closeSession(id)
  }
}

async function trimSessions(max) {
  while (SESSIONS.size > Math.max(1, max)) {
    const oldest = [...SESSIONS.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0]
    if (oldest === undefined) break
    await closeSession(oldest[0])
  }
}

/** 当前模型路由能不能看图——不能的话只给截图路径，避免 adapter 拒收 image block。 */
async function routeSupportsImages(ctx, exec) {
  try {
    const routed = exec?.agent?.session?.requestHeader?.()?.config
    const provider = routed?.provider ?? exec?.agent?.options?.provider
    const model = routed?.model ?? exec?.agent?.options?.model
    const llm = ctx.get('llm')
    if (!provider || !model || !llm) return false
    const info = await llm.resolveModelInfo(provider, model, exec.signal)
    return Array.isArray(info?.inputModalities) && info.inputModalities.includes('image')
  } catch {
    return false
  }
}

export function apply(ctx, config) {
  const cfg = config ?? {}
  registerInstanceTool(ctx, cfg)
  // 插件卸载/重载时收掉命名会话，别把 context 留在浏览器进程里。
  ctx.effect(() => () => closeAllSessions(), 'dsh-e2e: named sessions')

  ctx.tools.register({
    name: 'e2e',
    description:
      '用一台专用无头 Chromium 打开页面、按步骤操作并截图，做 Web GUI 的端到端测试。'
      + 'auth=dsh 时自动带上 DSH 登录态，收集 console 错误/警告、失败请求和 HTTP ≥400，关键截图直接作为图片返回。'
      + '浏览器是独立的（默认自动起一个专用容器），不占用 mijia 容器，也不碰用户正在使用的浏览器。'
      + '传 session 时同一名称的后续调用复用同一个页面（不重新导航），可把多步操作拆成几次调用；'
      + '传 closeSession 收尾。'
      + '配合方式：先用 e2e_instance up 起一个隔离实例（返回 id 和 url），把 id 传给本工具的 instance，'
      + '测完再 e2e_instance down；也可以直接传 url 测现成页面。'
      + STEPS_DOC,
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: '打开哪个地址；不填用插件配置的 baseUrl',
        },
        instance: {
          type: 'string',
          description: '用 e2e_instance 起的临时实例 id；给了就不必再传 url，且默认不带登录态',
        },
        session: {
          type: 'string',
          description: '命名会话：同一 session 的后续调用复用同一页面（不重新导航），用来把多步操作拆成几次调用。'
            + '换 url 会先导航到新地址；会话闲置 30 分钟或超过上限会自动关掉。',
        },
        closeSession: {
          type: 'boolean',
          description: '传了 session 时，这次调用跑完就关掉它（浏览器状态一起释放）',
        },
        steps: {
          type: 'array',
          description: '按顺序执行的步骤；首次打开会先 goto url，复用 session 且地址未变时不再导航',
          items: { type: 'object', additionalProperties: true },
        },
        viewport: {
          type: 'object',
          additionalProperties: false,
          properties: {
            width: { type: 'number' },
            height: { type: 'number' },
          },
          description: '覆盖默认视口',
        },
        deviceScaleFactor: {
          type: 'number',
          description: '截图缩放倍率，默认 1；要 2x 就传 2',
        },
        auth: {
          type: 'string',
          enum: ['dsh', 'none'],
          description: '登录态来源，默认用插件配置',
        },
        cookies: {
          type: 'array',
          description: '显式 cookie（name/value/domain?/path?）；给了就不读 token 文件',
          items: { type: 'object', additionalProperties: true },
        },
        timeoutMs: {
          type: 'number',
          description: '覆盖全局超时（导航与各动作的上限）',
        },
        actionTimeoutMs: {
          type: 'number',
          description: '覆盖单个动作的默认超时（默认 8000ms，且不超过 timeoutMs）；单步的 timeout 优先级更高',
        },
        screenshot: {
          type: 'boolean',
          description: '跑完后是否自动截一张 final，默认 true',
        },
        fullPage: {
          type: 'boolean',
          description: '截图是否整页，默认 false（只截视口）',
        },
      },
      required: ['steps'],
      additionalProperties: false,
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => {
        const blocks = [{ type: 'text', text: value.text }]
        for (const shot of value.screenshots ?? []) {
          if (shot.inline !== true || !shot.attachmentId) continue
          blocks.push({
            type: 'image',
            attachment: {
              attachmentId: shot.attachmentId,
              mediaType: shot.mediaType ?? 'image/png',
              bytes: shot.bytes ?? 0,
              width: shot.width ?? 0,
              height: shot.height ?? 0,
              name: shot.name,
            },
          })
        }
        return blocks
      },
    },
    async execute(args, exec) {
      const started = Date.now()
      const instanceId = String(args?.instance ?? '').trim()
      let url = String(args?.url ?? '').trim()
      if (!url && instanceId) url = (await getInstance(cfg, instanceId)).url
      if (!url) url = String(cfg.baseUrl ?? '').trim()
      if (!url) throw new Error('没有 url：传 url、传 instance，或在插件配置里设 baseUrl')
      let target
      try {
        target = new URL(url)
      } catch {
        throw new Error(`url 不合法：${url}`)
      }

      const steps = Array.isArray(args?.steps) ? args.steps : []
      const timeoutMs = positive(args?.timeoutMs, positive(cfg.timeoutMs, 30000))
      const actionTimeoutMs = Math.min(
        positive(args?.actionTimeoutMs, positive(cfg.actionTimeoutMs, 8000)),
        timeoutMs,
      )
      const viewport = {
        width: positive(args?.viewport?.width, positive(cfg.viewportWidth, 1440)),
        height: positive(args?.viewport?.height, positive(cfg.viewportHeight, 900)),
      }
      const deviceScaleFactor = positive(args?.deviceScaleFactor, 1)
      const maxInline = Math.max(0, Math.floor(positive(cfg.maxScreenshots, 6)))
      const authMode = String(args?.auth ?? (instanceId ? 'none' : cfg.auth) ?? 'none').trim() || 'none'
      const sessionId = String(args?.session ?? '').trim()

      const browser = await ensureBrowser(cfg)
      const cookies = await cookiesFor(target, { ...cfg, auth: authMode }, args?.cookies)

      const runId = `${Date.now().toString(36)}-${randomBytes(2).toString('hex')}`
      const shotDir = String(cfg.screenshotDir ?? '').trim() || join(tmpdir(), 'dsh-e2e', runId)
      await mkdir(shotDir, { recursive: true })

      await sweepSessions(positive(cfg.sessionIdleMs, 1800000))
      let session = sessionId ? SESSIONS.get(sessionId) : undefined
      // 页面被关掉、或者 CDP 连接断了：这条会话没法再用，丢掉重建。
      if (session !== undefined && (session.page.isClosed() || !browser.isConnected())) {
        await closeSession(sessionId)
        session = undefined
      }
      const reused = session !== undefined

      // 复用会话时不能换 context（cookie、viewport、登录态都在里面）：地址变了才导航。
      let context
      let sink
      let navigated = false
      if (reused) {
        context = session.context
        if (cookies.length > 0) await context.addCookies(cookies).catch(() => {})
        if (!samePage(session.url, url)) {
          await session.page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
          session.url = session.page.url()
          navigated = true
        }
        if (args?.viewport !== undefined) await session.page.setViewportSize(viewport)
        session.page.setDefaultTimeout(timeoutMs)
        session.page.setDefaultNavigationTimeout(timeoutMs)
        session.lastUsed = Date.now()
        sink = session.sink
      } else {
        context = await browser.newContext({
          ignoreHTTPSErrors: true,
          viewport,
          deviceScaleFactor,
          locale: String(cfg.locale ?? '') || 'zh-CN',
        })
        sink = collect()
      }

      // 本轮只报调用之后新产生的消息：复用页面时采集器一直在跑。
      const mark = {
        consoleErrors: sink.consoleErrors.length,
        consoleWarnings: sink.consoleWarnings.length,
        failedRequests: sink.failedRequests.length,
        httpErrors: sink.httpErrors.length,
      }
      let page
      let finalUrl = url
      let title = ''
      let result = { log: [], screenshots: [], error: null, durationMs: 0 }

      try {
        if (!reused) {
          if (cookies.length > 0) await context.addCookies(cookies)
          page = await context.newPage()
          page.setDefaultTimeout(timeoutMs)
          page.setDefaultNavigationTimeout(timeoutMs)
          attachCollectors(page, sink)
        } else {
          page = session.page
        }

        try {
          // 只有新建的页面才导航；复用一个地址没变的会话时保持页面现状——
          // 这正是把「发消息 / 等回复 / 点结果」拆成多次调用的意义。
          if (!reused) await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
          if (sessionId && !reused) {
            SESSIONS.set(sessionId, {
              context, page, url, sink, viewport, lastUsed: Date.now(),
            })
            await trimSessions(positive(cfg.maxSessions, 4))
          }
          const lastStep = steps[steps.length - 1] ?? {}
          const endsWithScreenshot = Object.prototype.hasOwnProperty.call(lastStep, 'screenshot')
          result = await runSteps(page, steps, {
            timeoutMs,
            actionTimeoutMs,
            shotDir,
            fullPage: args?.fullPage === true,
            finalScreenshot: args?.screenshot !== false && !endsWithScreenshot,
          })
        } catch (error) {
          result = { log: [], screenshots: [], error: describe(error), durationMs: Date.now() - started }
        }

        try {
          finalUrl = page.url()
          title = await page.title()
        } catch { /* 页面已经没了也不影响结果 */ }
      } finally {
        // 命名会话默认留着给下一次调用；匿名调用和 closeSession 立刻关掉。
        if (!sessionId || args?.closeSession === true) {
          await closeSession(sessionId)
          if (!reused) await context.close().catch(() => {})
        } else if (SESSIONS.has(sessionId)) {
          const current = SESSIONS.get(sessionId)
          current.url = finalUrl
          current.lastUsed = Date.now()
        } else {
          // 首次导航就失败时没有注册进 SESSIONS，别留下没人管的 context。
          await context.close().catch(() => {})
        }
      }

      const consoleErrors = sink.consoleErrors.slice(mark.consoleErrors)
      const consoleWarnings = sink.consoleWarnings.slice(mark.consoleWarnings)
      const failedRequests = sink.failedRequests.slice(mark.failedRequests)
      const httpErrors = sink.httpErrors.slice(mark.httpErrors)

      // 截图：全部落盘，前 N 张转成 attachment 内联返回。
      const attachments = ctx.get('attachments')
      const canInline = attachments !== undefined && await routeSupportsImages(ctx, exec)
      const shots = []
      for (const [index, shot] of result.screenshots.entries()) {
        const item = { name: shot.name, path: shot.path }
        if (canInline && index < maxInline) {
          try {
            const ref = await attachments.saveImage({
              data: shot.data,
              mediaType: 'image/png',
              name: `${shot.name}.png`,
            })
            item.attachmentId = String(ref.attachmentId)
            item.mediaType = String(ref.mediaType)
            item.width = Number(ref.width)
            item.height = Number(ref.height)
            item.bytes = Number(ref.bytes)
            item.inline = true
          } catch { /* 存不进 attachment 就只给路径 */ }
        }
        shots.push(item)
      }

      const ok = result.error === null
      const lines = []
      lines.push(ok
        ? `e2e 通过：${result.log.length} 步 / ${(result.durationMs / 1000).toFixed(1)}s`
        : `e2e 失败：${result.error}`)
      lines.push(`页面：${title || '(无标题)'} — ${finalUrl}`)
      if (sessionId) {
        lines.push(`会话 ${sessionId}：${reused
          ? (navigated ? '复用了同一页面（地址变了，已重新导航）' : '复用了同一页面（未重新导航）')
          : (args?.closeSession === true ? '已建立，本次结束关闭' : '已建立，后续调用可继续用')}`)
      }
      for (const step of result.log) {
        const detail = step.detail ? ` — ${step.detail}` : ''
        lines.push(`[${step.index}] ${step.action}${step.ok ? '' : ' FAIL'}${detail} (${step.ms}ms)`)
      }
      if (shots.length > 0) {
        lines.push(`截图：${shots.map((shot) => `${shot.name} → ${shot.path}`).join('；')}`)
      }
      if (consoleErrors.length > 0) {
        lines.push(`console/page 错误 ${consoleErrors.length} 条：`)
        for (const message of consoleErrors.slice(0, 10)) lines.push(`  - ${message}`)
      }
      if (consoleWarnings.length > 0) {
        lines.push(`console 警告 ${consoleWarnings.length} 条（插件 apply 失败常落在这里）：`)
        for (const message of consoleWarnings.slice(0, 10)) lines.push(`  - ${message}`)
      }
      if (httpErrors.length > 0) {
        lines.push(`HTTP ≥400 ${httpErrors.length} 条：`)
        for (const message of httpErrors.slice(0, 10)) lines.push(`  - ${message}`)
      }
      if (failedRequests.length > 0) {
        lines.push(`失败请求 ${failedRequests.length} 条：`)
        for (const message of failedRequests.slice(0, 10)) lines.push(`  - ${message}`)
      }

      return {
        ok,
        text: lines.join('\n'),
        url: finalUrl,
        ...(title ? { title } : {}),
        durationMs: Date.now() - started,
        ...(result.error ? { error: result.error } : {}),
        steps: result.log,
        screenshots: shots,
        ...(consoleErrors.length > 0 ? { consoleErrors } : {}),
        ...(consoleWarnings.length > 0 ? { consoleWarnings } : {}),
        ...(httpErrors.length > 0 ? { httpErrors } : {}),
        ...(failedRequests.length > 0 ? { failedRequests } : {}),
      }
    },
  })
}
