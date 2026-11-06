/**
 * Browser half: a "Re-answer" icon in front of a user message.
 *
 * What it is for. A Turn can end without usable output: the model call failed,
 * the agent was interrupted, the process restarted mid-turn, or the reply was
 * cut off. The transcript then shows the user message with no reply (or a
 * frozen partial one), and there is no stock way to ask for that answer again.
 * This plugin puts one icon before the user message row; a click re-sends that
 * message as a fresh prompt.
 *
 * Why `conversation.chat.user.before`. The user asked for the control in front
 * of their own message rather than under the assistant's reply. That chain
 * slot is rendered inside the user row, before the bubble, and receives the
 * durable message `source`. The same chain also decorates steering rows, so
 * the selector declines anything that is not a durable opening user message.
 *
 * What is resent. The message text, verbatim, plus its images. Images are
 * re-read through `session.readAttachment` and inlined as base64 prompt parts,
 * the same shape a subagent continuation uses; their receipts are per-prompt,
 * but the bytes are addressable. Generic file attachments have no such
 * readable form (the prompt takes a per-prompt receipt id), so a message that
 * carries one renders the icon disabled and says why.
 *
 * Delivery. `session.prompt` is the Session-scoped send path, resolved through
 * `ctx.sessions.binding(sessionId)` at click time so a control that outlives a
 * session switch still targets its own Session. Business failures surface in
 * the composer's notice rail, the same place a failed draft send appears.
 */
window.__ModuleLoader__.load({
  id: 'dsh-reply-again',
  factory: (require) => {
    const React = require('react')
    const { IconRefreshOutlineRegular, Tooltip } = require('@deepseek-ai/dsh-client-ui-primitives')
    const h = React.createElement

    /** Locale namespace owned by this plugin. */
    const NS = 'reply-again'
    /** Marks the injected stylesheet for diagnostics and removal. */
    const STYLE_ATTR = 'data-dsh-reply-again-css'
    /** Marks the document while the control is installed (handy in devtools). */
    const MARKER = 'data-dsh-reply-again'

    /** Baseline dictionaries: the locale service requires zh and en. */
    const LOCALES = {
      zh: {
        'action': '重新回复这条消息',
        'hint': '把这条消息再发一次，让 agent 重新回答（发送失败、回复中断或进程重启后适用）',
        'busy': '先等当前这轮回复结束',
        'unsupported': '这条消息带文件附件，暂时不能重发（文件凭证无法复用；图片可以）',
        'sent': '已重新发送，等 agent 回复',
        'failed': '重发失败：{message}',
        'denied': '这个会话不允许发送消息',
      },
      en: {
        'action': 'Re-answer this message',
        'hint': 'Send this message again so the agent answers it afresh (failed send, interrupted reply, or a restart mid-turn)',
        'busy': 'Wait for the current turn to finish',
        'unsupported': 'This message carries a file attachment, which cannot be replayed here (images can)',
        'sent': 'Sent again; waiting for the agent',
        'failed': 'Re-send failed: {message}',
        'denied': 'This session does not allow sending messages',
      },
    }

    /** Package-local chrome: the control sits above the bubble, right-aligned like it. */
    const CSS = String.raw`
.dsh-ra-row{display:flex;justify-content:flex-end;align-items:center;height:22px}
.dsh-ra-button{display:inline-flex;align-items:center;justify-content:center;width:24px;height:22px;padding:0;border:none;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.dsh-ra-button svg{width:14px;height:14px}
@media (hover:hover){
  .dsh-ra-row{opacity:0;transition:opacity 80ms ease}
  [data-chat-flow-kind='user']:hover .dsh-ra-row,
  [data-chat-flow-kind='user']:focus-within .dsh-ra-row{opacity:1}
  .dsh-ra-button:hover:not([aria-disabled]){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
}
.dsh-ra-button:focus-visible{box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline:none;opacity:1}
.dsh-ra-button[aria-disabled]{opacity:0.4;cursor:default}
`

    /**
     * Resolve one durable user message by the `source` object the chain hands over.
     * The same object instance comes back from the Chat node store, so identity
     * comparison is exact and no seq plumbing is needed.
     * @param snapshot - live Chat snapshot.
     * @param source - durable message source from the user row.
     * @returns the text, image blocks, and whether a file is present, or undefined.
     */
    function messageOf(snapshot, source) {
      const turns = snapshot.timeline?.turnOrder ?? []
      for (const turn of turns) {
        for (const key of snapshot.locations.getTurn(turn)) {
          const node = snapshot.nodes.get(key)
          if (node === undefined || node.kind !== 'user' || node.data.source !== source) continue
          const texts = []
          const images = []
          let hasFile = false
          for (const block of node.data.content ?? []) {
            if (block === null || typeof block !== 'object') continue
            if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text)
            else if (block.type === 'image' && block.attachment !== undefined) images.push(block)
            else if (block.type === 'file') hasFile = true
          }
          return { text: texts.join('\n').trim(), images, hasFile }
        }
      }
      return undefined
    }

    /** Base64 without the call-stack limit a spread over a large byte array would hit. */
    function toBase64(bytes) {
      let binary = ''
      const chunk = 0x8000
      for (let index = 0; index < bytes.length; index += chunk) {
        binary += String.fromCharCode(...bytes.subarray(index, index + chunk))
      }
      return btoa(binary)
    }

    /** Resolved-message cache, keyed by the durable source object (identity-stable). */
    const CACHE = new WeakMap()

    /**
     * The user-row entry: one icon button, disabled while a turn runs or when a
     * file attachment cannot be replayed.
     * @param props - chain owner share, the resolved message, and the injected send verb.
     * @returns the icon row, or null before the message resolves.
     */
    function ReplyAgainButton(props) {
      const { source, resend, notify, t, useSession, useAccess, useChat } = props
      const running = useSession(snapshot => snapshot.running)
      const allowed = useAccess('session/prompt') !== false
      // Resolve once per source and keep it out of the render path afterwards:
      // the selector returns a primitive, so a streaming publish costs nothing.
      useChat((snapshot) => {
        if (!CACHE.has(source)) {
          const found = messageOf(snapshot, source)
          if (found !== undefined) CACHE.set(source, found)
        }
        return CACHE.has(source)
      })
      const [pending, setPending] = React.useState(false)
      const message = CACHE.get(source)
      if (!allowed || message === undefined) return null

      const blocked = running ? t('busy') : message.hasFile ? t('unsupported') : null
      const onRetry = () => {
        if (blocked !== null || pending) return
        setPending(true)
        Promise.resolve()
          .then(() => resend(message))
          .then(() => { notify('info', t('sent')) })
          .catch((error) => { notify('error', t('failed', { message: error instanceof Error ? error.message : String(error) })) })
          .finally(() => { setPending(false) })
      }

      return h('div', { className: 'dsh-ra-row' },
        h(Tooltip, { label: blocked ?? t('hint'), side: 'bottom', align: 'end' },
          h('button', {
            type: 'button',
            className: 'dsh-ra-button',
            'aria-label': t('action'),
            'aria-disabled': blocked !== null || pending ? true : undefined,
            'aria-busy': pending ? true : undefined,
            onClick: blocked === null && !pending ? onRetry : undefined,
          },
          h(IconRefreshOutlineRegular, null))))
    }

    return {
      name: 'dsh-reply-again',
      inject: ['slots', 'sessions', 'locale'],
      /**
       * Mount the user-row re-answer control.
       * @param ctx - client root context.
       */
      apply(ctx) {
        const t = ctx.locale.bind(NS)
        ctx.effect(() => ctx.locale.register(NS, LOCALES), 'dsh-reply-again: dictionaries')

        ctx.effect(() => {
          const style = document.createElement('style')
          style.setAttribute(STYLE_ATTR, '')
          style.textContent = CSS
          document.head.appendChild(style)
          document.documentElement.setAttribute(MARKER, '')
          return () => {
            style.remove()
            document.documentElement.removeAttribute(MARKER)
          }
        }, 'dsh-reply-again: stylesheet')

        ctx.slots.inject('conversation.chat.user.before', () => ctx.slots.register({
          name: 'conversation.chat.user.before',
          // Claim every durable opening user row; decline steering and echoes.
          select: owner => (owner.kind === 'user' && owner.source !== null && typeof owner.source === 'object'
            ? { source: owner.source }
            : null),
          locale: NS,
          inject: (sessionId) => ({
            // Resolve per call: a switch can dispose the Session scope between
            // mount and click, and the click must still hit its own Session.
            resend: async ({ text, images }) => {
              const binding = ctx.sessions.binding(sessionId)
              const session = binding?.session
              if (session === undefined) throw new Error(t('denied'))
              const content = text === '' ? [] : [{ type: 'text', text }]
              for (const image of images) {
                const result = await session.readAttachment(image.attachment)
                if (!result.ok) throw new Error(result.error.message)
                content.push({
                  type: 'image',
                  mediaType: image.attachment.mediaType,
                  data: toBase64(result.value.data),
                  ...image.attachment.name === undefined ? {} : { name: image.attachment.name },
                })
              }
              if (content.length === 0) throw new Error(t('denied'))
              const result = await session.prompt(content, 'queue')
              if (!result.ok) throw new Error(result.error.message)
            },
            notify: (level, text) => {
              const actx = ctx.sessions.scope(sessionId)
              const conversation = actx === undefined ? undefined : actx.get('conversation')
              conversation?.input.for(actx).notify(level, text)
            },
          }),
        }, ReplyAgainButton))
      },
    }
  },
})
