import Schema from '@deepseek-ai/schemastery'
import { randomBytes } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { basename } from 'node:path'

export const name = 'dsh-ntfy'
export const inject = ['tools']

/**
 * ntfy 推送配置。
 *
 * url 是**服务根地址**（不带 topic），topic 单独放一个键：
 * 换 topic 不用动 url，换域名也不用重新拼字符串。
 */
export const Config = Schema.object({
  url: Schema.string()
    .default('https://ntfy.example.com')
    .description('ntfy 服务根地址，例如 https://ntfy.example.com；不要带 topic'),
  topic: Schema.string()
    .default('')
    .description('推送频道名（URL 里 / 后面那段）。留空则工具照常注册，但调用时会报错提示去配'),
  accessToken: Schema.string()
    .default('')
    .description('服务端开了访问控制时填 access token（Bearer）；留空表示匿名发布'),
  defaultPriority: Schema.string()
    .default('default')
    .description('未指定时的优先级：min / low / default / high / urgent'),
  defaultTags: Schema.array(Schema.string())
    .default([])
    .description('未指定时的标签（ntfy 的 Tag 短码，比如 bell、warning）'),
  timeoutMs: Schema.number()
    .default(10000)
    .description('单次推送超时，单位毫秒'),
  approvalEnabled: Schema.boolean()
    .default(false)
    .description('开启审批转发：页面上的审批超过 delay 没人处理，就推到手机，通知上带「通过 / 拒绝」按钮'),
  approvalDelayMs: Schema.number()
    .default(300000)
    .description('审批等待多久没人处理才推送，单位毫秒（默认 5 分钟）'),
  approvalBaseUrl: Schema.string()
    .default('')
    .description('手机能访问到的 DSH 地址（用于审批按钮回调），例如 https://dsh.example.com；留空则不启用审批转发'),
})

const PRIORITIES = ['min', 'low', 'default', 'high', 'urgent']

// ntfy 的 JSON 发布只认数字优先级；传 'default' 这类字符串它会回一个
// 极具误导性的「request body must be valid JSON」（踩过）。
const PRIORITY_VALUE = { min: 1, low: 2, default: 3, high: 4, urgent: 5 }

const ACTION_KINDS = ['view', 'http', 'broadcast']
const MAX_ACTIONS = 3

const DOC_HINT = '完整参数见插件目录下的 docs/publish.md。'

/**
 * HTTP 头只能是 ISO-8859-1；中文标题直接塞进去 fetch 会抛
 * "Invalid character in header content"。ntfy 支持 RFC 2047 编码，
 * 所以非 ASCII 一律转成 =?UTF-8?B?...?=。
 */
function asciiHeader(value) {
  const text = String(value ?? '')
  if (/^[\x20-\x7E]*$/.test(text)) return text
  return `=?UTF-8?B?${Buffer.from(text, 'utf8').toString('base64')}?=`
}

function normalizePriority(want, fallback) {
  const name = PRIORITIES.includes(want) ? want : (PRIORITIES.includes(fallback) ? fallback : 'default')
  return { name, value: PRIORITY_VALUE[name] }
}

function normalizeActions(actions) {
  if (!Array.isArray(actions) || actions.length === 0) return undefined
  return actions.slice(0, MAX_ACTIONS).map((a) => {
    const kind = String(a?.action ?? 'view')
    if (!ACTION_KINDS.includes(kind)) {
      throw new Error(`actions 里的 action 只能是 ${ACTION_KINDS.join(' / ')}，收到 "${kind}"`)
    }
    if (!a?.url) throw new Error('actions 里每一项都要有 url')
    const item = { action: kind, label: String(a.label ?? kind), url: String(a.url) }
    if (a.method) item.method = String(a.method).toUpperCase()
    if (a.body !== undefined) item.body = a.body
    if (a.clear === true) item.clear = true
    return item
  })
}

function resolveTarget(config) {
  const base = String(config?.url ?? '').replace(/\/+$/, '')
  const topic = String(config?.topic ?? '').trim()
  if (!base) throw new Error('dsh-ntfy 还没配 url，去 cordis.patch.yml 里填 ntfy 服务地址')
  if (!topic) throw new Error('dsh-ntfy 还没配 topic，去 cordis.patch.yml 里填频道名')
  return { base, topic }
}

function authHeaders(config) {
  const token = String(config?.accessToken ?? '').trim()
  return token ? { Authorization: `Bearer ${token}` } : {}
}

async function errorText(res) {
  try { return (await res.text()).slice(0, 300) } catch { return '' }
}

/**
 * Publish one JSON message to the ntfy root endpoint.
 *
 * JSON publishing must POST to `/` (the topic lives in the body) and `cache=no`
 * can only ride the query string — see README. Both the tools and the approval
 * relay go through here so the two paths cannot drift.
 * @param config - plugin config.
 * @param body - ntfy JSON payload (topic included).
 * @param options - cache flag, caller signal, and timeout.
 * @returns `{ ok, id, status }`.
 */
async function postJsonMessage(config, body, options = {}) {
  const { base } = resolveTarget(config)
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || 10000)
  const url = `${base}/${options.cache === false ? '?cache=no' : ''}`
  const headers = { 'Content-Type': 'application/json', ...authHeaders(config) }
  const deadline = AbortSignal.timeout(timeoutMs)
  const signal = options.signal === undefined ? deadline : AbortSignal.any([options.signal, deadline])

  let res
  try {
    res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal })
  } catch (err) {
    throw new Error(`连不上 ntfy（${url}）：${err?.message ?? err}`)
  }
  if (!res.ok) throw new Error(`ntfy 返回 HTTP ${res.status}：${await errorText(res)}`)

  let id = ''
  try { id = String((await res.json())?.id ?? '') } catch { /* 发出去了就算成功 */ }
  return { ok: true, id, status: res.status }
}

const APPROVAL_ROUTE = '/dsh-ntfy/approval'
/** Path action → approval outcome. The id in the path is the capability. */
const APPROVAL_ACTIONS = new Map([
  ['allow', 'allowed-once'],
  ['reject', 'rejected'],
])

/**
 * Pick the approval text shown on the phone. Prefer the request's localized
 * copy (approval sources such as Auto review ship it); fall back to the raw
 * reason for older or unlocalized requests.
 * @param req - the pending approval request.
 * @returns the reason text, already trimmed.
 */
function approvalReason(req) {
  const localized = req?.displayReason
  if (localized !== null && typeof localized === 'object') {
    const text = localized.zh ?? localized.en
    if (typeof text === 'string' && text.trim() !== '') return text.trim()
  }
  return String(req?.reason ?? '').trim()
}

/**
 * Human-readable body for an approval push. The reason is the model's / hook's
 * own text, so it is passed through verbatim (trimmed and capped).
 * @param req - the pending approval request.
 * @returns the notification body.
 */
function approvalMessage(req) {
  const reason = approvalReason(req)
  return [
    `工具：${req.toolName}`,
    `原因：${reason === '' ? '（没有说明）' : (reason.length > 1200 ? `${reason.slice(0, 1200)}…` : reason)}`,
    '',
    '在页面上等了一会儿没人处理，所以推到你手机。点下面的按钮直接决定；点通知本身可打开 DSH。',
  ].join('\n')
}

/**
 * Build the approval relay: a `approval/request` listener that lets the normal
 * answerers (the Web UI) decide first, and only after `delayMs` falls back to a
 * phone push with allow/reject action buttons.
 *
 * The listener is composed with `prepend: true`: the forwarded client
 * waterfall would otherwise sit in front of it and hold this listener until
 * the user answers, so the timer could never start.
 * @param ctx - host context (logger + webServer).
 * @param config - plugin config.
 * @returns `onRequest` for the waterfall and `handleRoute` for the callback.
 */
function createApprovalRelay(ctx, config) {
  const pending = new Map()
  const active = new Set()
  const configuredDelay = Number(config.approvalDelayMs)
  const delayMs = Math.min(2 ** 31 - 1, Number.isFinite(configuredDelay) && configuredDelay >= 0 ? configuredDelay : 300000)
  const baseUrl = String(config.approvalBaseUrl ?? '').trim().replace(/\/+$/, '')
  let disposed = false

  /**
   * One approval request. Resolves with the first decision from the Web UI, the
   * phone, cancellation, or the fail-closed outcome.
   */
  function onRequest(req, next) {
    return new Promise((resolve) => {
      let settled = false
      let timer = null
      let pushed = null
      let downstreamDone = false
      let downstreamOutcome = 'unavailable'

      // The Web UI card is dismissed only when its Client-side presentation
      // signal aborts: the Remote Event gateway sends a cancel frame for a
      // projected request whose signal aborted. That signal is normally the
      // tool's own cancellation signal, which must NOT abort when we decide
      // from the phone (it would kill the very tool we just approved). So
      // downstream answerers get a presentation-lifetime signal of our own,
      // mirroring the tool signal but also aborted when this request settles.
      const originalSignal = req.signal
      const presentation = new AbortController()
      const mirrorAbort = () => presentation.abort(originalSignal?.reason)
      if (originalSignal !== undefined) {
        if (originalSignal.aborted) presentation.abort(originalSignal.reason)
        else originalSignal.addEventListener('abort', mirrorAbort, { once: true })
      }
      let presentationInstalled = false
      try {
        req.signal = presentation.signal
        presentationInstalled = true
      } catch (error) {
        ctx.logger?.warn?.(`dsh-ntfy: approval card cannot be auto-dismissed (signal not writable): ${error?.message ?? error}`)
      }

      const settle = (outcome) => {
        if (settled) return
        settled = true
        if (timer !== null) { clearTimeout(timer); timer = null }
        if (pushed !== null) { pending.delete(pushed.id); pushed = null }
        active.delete(settle)
        originalSignal?.removeEventListener('abort', onAbort)
        originalSignal?.removeEventListener('abort', mirrorAbort)
        resolve(outcome)
        if (presentationInstalled) {
          // Next macrotask: let the decided outcome reach the approval service
          // first, then cancel the Client presentation (no-op if the page
          // itself answered and already removed the card).
          setTimeout(() => {
            if (!presentation.signal.aborted) {
              presentation.abort(new Error('approval was decided in another surface'))
            }
          }, 0)
        }
      }
      const onAbort = () => settle('cancelled')
      active.add(settle)

      if (disposed || originalSignal?.aborted === true) { settle('cancelled'); return }
      originalSignal?.addEventListener('abort', onAbort, { once: true })

      const handleDownstream = (outcome) => {
        downstreamDone = true
        downstreamOutcome = outcome
        // 'unavailable' means no answerer claimed it (page closed, another
        // process, …). Keep the request alive until the push has a chance:
        // that is exactly the "user is away from the screen" case.
        if (outcome === 'unavailable') return
        settle(outcome)
      }
      Promise.resolve().then(() => next()).then(handleDownstream, () => handleDownstream('unavailable'))

      timer = setTimeout(() => { timer = null; void pushNow() }, delayMs)
      timer.unref?.()

      async function pushNow() {
        if (settled || disposed) return
        const id = randomBytes(16).toString('base64url')
        const allowUrl = `${baseUrl}${APPROVAL_ROUTE}/${id}/allow`
        const rejectUrl = `${baseUrl}${APPROVAL_ROUTE}/${id}/reject`
        const body = {
          topic: String(config.topic ?? '').trim(),
          title: `需要审批：${req.toolName}`,
          message: approvalMessage(req),
          priority: 4,
          tags: ['warning'],
          click: baseUrl,
          actions: [
            { action: 'http', label: '✅ 通过', url: allowUrl, method: 'POST', clear: true },
            { action: 'http', label: '⛔ 拒绝', url: rejectUrl, method: 'POST', clear: true },
          ],
        }
        try {
          const sent = await postJsonMessage(config, body, { timeoutMs: config.timeoutMs })
          ctx.logger?.info?.(`[dsh-ntfy] approval push sent (${req.toolName}, id ${sent.id || 'unknown'}); allow ${allowUrl}`)
        } catch (error) {
          ctx.logger?.warn?.(`[dsh-ntfy] approval push failed: ${error?.message ?? error}`)
          // No UI either: fail closed instead of hanging the tool call forever.
          if (downstreamDone && downstreamOutcome === 'unavailable') settle('unavailable')
          return
        }
        if (settled || disposed) return
        pushed = { id, toolName: req.toolName, createdAt: Date.now(), settle }
        pending.set(id, pushed)
      }
    })
  }

  /** POST /dsh-ntfy/approval/<id>/{allow,reject} — the phone button target. */
  function handleRoute(webReq, webRes) {
    const send = (status, text, headers = {}) => {
      webRes.writeHead(status, {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
        'x-robots-tag': 'noindex, nofollow',
        ...headers,
      })
      webRes.end(text)
    }

    // POST only: a GET could be triggered by a link preview / prefetch and
    // approve an action the user never saw. ntfy's http action uses POST.
    if (webReq.method !== 'POST') {
      send(405, '请从手机通知上的「通过 / 拒绝」按钮操作。\n', { allow: 'POST' })
      return
    }
    let url
    try { url = new URL(webReq.url ?? '/', 'http://dsh.invalid') } catch { send(400, 'bad request\n'); return }
    const prefix = `${APPROVAL_ROUTE}/`
    if (!url.pathname.startsWith(prefix)) { send(404, 'not found\n'); return }
    const parts = url.pathname.slice(prefix.length).split('/')
    if (parts.length !== 2) { send(404, 'not found\n'); return }
    const [id, action] = parts
    const outcome = APPROVAL_ACTIONS.get(action)
    if (outcome === undefined) { send(400, '未知操作\n'); return }

    const record = pending.get(id)
    if (record === undefined) {
      send(410, '这个审批已经处理过了，或者已经失效。\n')
      return
    }
    record.settle(outcome)
    ctx.logger?.info?.(`[dsh-ntfy] approval ${outcome === 'allowed-once' ? 'allowed' : 'rejected'} from phone (${record.toolName})`)
    send(200, outcome === 'allowed-once'
      ? '✅ 已通过，agent 会继续执行。\n'
      : '⛔ 已拒绝，agent 会停止这个操作。\n')
  }

  /** Fail in-flight requests closed and drop every pending button when the plugin unloads. */
  function dispose() {
    disposed = true
    for (const settle of [...active]) settle('cancelled')
    pending.clear()
  }

  return { onRequest, handleRoute, dispose }
}

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    id: { type: 'string' },
    status: { type: 'number' },
  },
  required: ['ok'],
  additionalProperties: false,
}

export function apply(ctx, config) {
  const timeoutMs = Number(config?.timeoutMs) > 0 ? Number(config.timeoutMs) : 10000

  ctx.tools.register({
    name: 'ntfy_send',
    description:
      '把一条通知推送到用户手机（走本机自建的 ntfy）。' +
      '适合：长任务跑完了、有告警、需要用户马上知道的事。' +
      '平常聊天不要用它——对方就在对话框里，直接说话就行；这个工具是「人不在电脑前」时才用的。' +
      '支持 Markdown、动作按钮、定时投递、附件链接。' + DOC_HINT,
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: '正文。要用 Markdown 渲染需同时把 markdown 设成 true' },
        title: { type: 'string', description: '标题，一行以内；不填用「NAS 通知」' },
        priority: {
          type: 'string',
          enum: PRIORITIES,
          description: '优先级；urgent(5) 会穿透手机静音和勿扰，慎用',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: '标签短码。匹配 emoji 的会自动变图标：warning→⚠️、rocket→🚀、heavy_check_mark→✔️',
        },
        markdown: { type: 'boolean', description: '正文按 Markdown 渲染（加粗、列表、代码块）' },
        click: { type: 'string', description: '点通知时打开的链接' },
        actions: {
          type: 'array',
          description: '通知上的按钮，最多 3 个。每项 {action: view|http|broadcast, label, url, method?, body?, clear?}',
          items: {
            type: 'object',
            properties: {
              action: { type: 'string', enum: ACTION_KINDS },
              label: { type: 'string' },
              url: { type: 'string' },
              method: { type: 'string', description: 'action=http 时的请求方法，默认 POST' },
              body: { type: 'string', description: 'action=http 时的请求体' },
              clear: { type: 'boolean', description: '点完自动清除这条通知' },
            },
            required: ['action', 'url'],
            additionalProperties: false,
          },
        },
        attach: { type: 'string', description: '附件 URL（服务端下载后再推给手机）' },
        icon: { type: 'string', description: '通知图标 URL' },
        delay: { type: 'string', description: '定时投递：30min、2h、tomorrow 9am；范围 10 秒 ~ 3 天' },
        email: { type: 'string', description: '同时转发邮箱（需服务端配 SMTP）' },
        call: { type: 'string', description: '同时语音播报（需服务端配通话，格式 +86138...）' },
        cache: {
          type: 'boolean',
          description: 'false = 不在服务端缓存（含敏感内容时用，离线设备就收不到了）。默认 true',
        },
      },
      required: ['message'],
      additionalProperties: false,
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [
        {
          type: 'text',
          text: value.ok
            ? `已推送到手机（ntfy 消息 id ${value.id || '未知'}）`
            : '推送没有成功',
        },
      ],
    },
    async execute(args, exec) {
      const { topic } = resolveTarget(config)
      const message = String(args?.message ?? '').trim()
      if (!message) throw new Error('message 不能为空')

      const { value: priorityValue } = normalizePriority(args?.priority, config?.defaultPriority)
      const body = { topic, message, title: String(args?.title ?? '').trim() || 'NAS 通知', priority: priorityValue }

      const tags = Array.isArray(args?.tags) && args.tags.length ? args.tags : (config?.defaultTags ?? [])
      if (tags.length) body.tags = tags

      const actions = normalizeActions(args?.actions)
      if (actions) body.actions = actions

      for (const key of ['click', 'attach', 'icon', 'delay', 'email', 'call']) {
        const v = String(args?.[key] ?? '').trim()
        if (v) body[key] = v
      }
      if (args?.markdown === true) body.markdown = true

      return postJsonMessage(config, body, {
        cache: args?.cache !== false,
        timeoutMs,
        signal: exec.signal,
      })
    },
  })

  ctx.tools.register({
    name: 'ntfy_send_file',
    description:
      '把本机的一个文件作为附件推到手机（ntfy 的 PUT 发布）。' +
      '适合截图、日志片段、导出的报告这类「看一眼就明白」的东西。' +
      '本机服务端已开附件：单文件上限 100 MB、保留 72 小时。' + DOC_HINT,
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: '本机文件的绝对路径' },
        filename: { type: 'string', description: '手机上显示的文件名；不填用原文件名' },
        message: { type: 'string', description: '随附件显示的一行说明' },
        title: { type: 'string', description: '标题' },
        priority: { type: 'string', enum: PRIORITIES },
        tags: { type: 'array', items: { type: 'string' } },
        click: { type: 'string', description: '点通知时打开的链接' },
        delay: { type: 'string', description: '定时投递，如 30min' },
        cache: { type: 'boolean', description: 'false = 不缓存' },
      },
      required: ['file'],
      additionalProperties: false,
    },
    output: {
      schema: {
        ...OUTPUT_SCHEMA,
        properties: { ...OUTPUT_SCHEMA.properties, bytes: { type: 'number' } },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: value.ok
            ? `附件已推送（${Math.round((value.bytes ?? 0) / 1024)} KB，id ${value.id || '未知'}）`
            : '附件没有发出去',
        },
      ],
    },
    async execute(args, exec) {
      const { base, topic } = resolveTarget(config)
      const path = String(args?.file ?? '').trim()
      if (!path) throw new Error('file 不能为空')

      let info
      try { info = await stat(path) } catch { throw new Error(`文件不存在：${path}`) }
      if (!info.isFile()) throw new Error(`不是普通文件：${path}`)

      const bytes = await readFile(path)
      const { value: priorityValue } = normalizePriority(args?.priority, config?.defaultPriority)

      const headers = {
        'Content-Type': 'application/octet-stream',
        Title: asciiHeader(String(args?.title ?? '').trim() || 'NAS 附件'),
        Priority: String(priorityValue),
        Filename: asciiHeader(String(args?.filename ?? '').trim() || basename(path)),
        ...authHeaders(config),
      }
      const message = String(args?.message ?? '').trim()
      if (message) headers['X-Message'] = asciiHeader(message)
      const tags = Array.isArray(args?.tags) && args.tags.length ? args.tags : (config?.defaultTags ?? [])
      if (tags.length) headers.Tags = asciiHeader(tags.join(','))
      const click = String(args?.click ?? '').trim()
      if (click) headers.Click = click
      const delay = String(args?.delay ?? '').trim()
      if (delay) headers['X-Delay'] = delay

      const url = `${base}/${encodeURIComponent(topic)}${args?.cache === false ? '?cache=no' : ''}`
      const signal = AbortSignal.any([exec.signal, AbortSignal.timeout(Math.max(timeoutMs, 30000))].filter(Boolean))

      let res
      try {
        res = await fetch(url, { method: 'PUT', headers, body: bytes, signal })
      } catch (err) {
        throw new Error(`连不上 ntfy（${url}）：${err?.message ?? err}`)
      }
      if (!res.ok) throw new Error(`ntfy 返回 HTTP ${res.status}：${await errorText(res)}`)

      let id = ''
      try { id = String((await res.json())?.id ?? '') } catch { /* ignore */ }
      return { ok: true, id, status: res.status, bytes: bytes.length }
    },
  })

  // 审批转发：页面上的审批超过 approvalDelayMs 没人处理，就推手机并挂
  // 「通过 / 拒绝」按钮。回调走 dsh 自己的 HTTP 服务（前缀路由比 webui-auth
  // 的 '' 前缀更长，所以不会被登录页截走）；URL 里的随机 id 就是凭证。
  if (config?.approvalEnabled === true) {
    const baseUrl = String(config?.approvalBaseUrl ?? '').trim()
    if (baseUrl === '') {
      ctx.logger?.warn?.('dsh-ntfy: approvalEnabled 为 true 但 approvalBaseUrl 为空，审批转发没有启用')
      return
    }
    ctx.inject(['webServer'], (scope) => {
      const relay = createApprovalRelay(scope, config)
      scope.effect(() => {
        const offRequest = scope.on('approval/request', relay.onRequest, { prepend: true })
        const offRoute = scope.webServer.register({
          kind: 'prefix',
          path: APPROVAL_ROUTE,
          handler: relay.handleRoute,
        })
        return () => {
          offRequest()
          offRoute()
          relay.dispose()
        }
      }, 'dsh-ntfy: approval relay')
    })
  }
}
