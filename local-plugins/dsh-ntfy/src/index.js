import Schema from '@deepseek-ai/schemastery'
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
      const { base, topic } = resolveTarget(config)
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

      // JSON 发布要 POST 到**根路径**，topic 放在 body 里；
      // cache=no 只能走查询参数（JSON 字段表里没有它）。
      const url = `${base}/${args?.cache === false ? '?cache=no' : ''}`
      const headers = { 'Content-Type': 'application/json', ...authHeaders(config) }
      const signal = AbortSignal.any([exec.signal, AbortSignal.timeout(timeoutMs)].filter(Boolean))

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
}
