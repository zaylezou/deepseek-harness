/**
 * Browser half: a "Re-answer" icon at the left of a user message bubble.
 *
 * What it is for. A Turn can end without usable output: the model call failed,
 * the agent was interrupted, the process restarted mid-turn, or the reply was
 * cut off. The transcript then shows the user message with no reply (or a
 * frozen partial one), and there is no stock way to ask for that answer again.
 * This plugin puts one icon on the bubble's line; a click re-sends that
 * message as a fresh prompt.
 *
 * Why `conversation.chat.user.before`. The user asked for the control beside
 * their own message rather than under the assistant's reply. That chain slot
 * is rendered inside the user row, before the bubble, and receives the durable
 * message `source`. The slot only supplies the first column; the row is laid
 * out as a two-column grid here so the icon sits on the bubble's line, at its
 * left, with the copy/branch row still spanning underneath.
 *
 * What is resent. The message text, verbatim, plus its images. Images are
 * re-read through `session.readAttachment` and inlined as base64 prompt parts,
 * the same shape a subagent continuation uses; their receipts are per-prompt,
 * but the bytes are addressable. Generic file attachments have no such
 * readable form (the prompt takes a per-prompt receipt id), so a message that
 * carries one renders the icon disabled and says why.
 *
 * No notices. A re-ask is a normal prompt: the new user bubble is its own
 * receipt, and a refusal lands in the composer's prompt-error surface like any
 * other failed send. The plugin adds no toast of its own.
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
        'denied': '这个会话不允许发送消息',
      },
      en: {
        'action': 'Re-answer this message',
        'hint': 'Send this message again so the agent answers it afresh (failed send, interrupted reply, or a restart mid-turn)',
        'busy': 'Wait for the current turn to finish',
        'unsupported': 'This message carries a file attachment, which cannot be replayed here (images can)',
        'denied': 'This session does not allow sending messages',
      },
    }

    /**
     * Row layout. The stock user row is a right-aligned column: decoration,
     * bubble stack, actions. Two grid columns put the decoration on the
     * bubble's line at its left; the actions row spans both underneath. The
     * second column keeps a definite width so the stack's own `max-width: 82%`
     * still resolves, and the bubble stays right-aligned inside it.
     */
    const CSS = String.raw`
.dsh-ra-row{display:flex;align-items:center;justify-content:center;width:24px;grid-area:1/1;justify-self:end}
[data-chat-flow-kind='user'] > div > div{display:grid;grid-template-columns:auto fit-content(82%);justify-content:end;align-items:center;column-gap:6px;row-gap:6px}
[data-chat-flow-kind='user'] > div > div > *:nth-child(2){max-width:100%;justify-self:end;min-width:0}
[data-chat-flow-kind='user'] > div > div > *:nth-child(3){grid-column:1/-1;justify-self:end}
.dsh-ra-button{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:none;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.dsh-ra-button svg{width:15px;height:15px}
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
     * file attachment cannot be replayed. The row itself always renders so the
     * grid's child order stays stable while the message is resolving.
     * @param props - chain owner share, the resolved message, and the injected send verb.
     * @returns the icon row.
     */
    function ReplyAgainButton(props) {
      const { source, resend, t, useSession, useAccess, useChat } = props
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
      const blocked = !allowed ? t('denied') : running ? t('busy') : message?.hasFile ? t('unsupported') : null
      const onRetry = () => {
        if (blocked !== null || pending || message === undefined) return
        setPending(true)
        Promise.resolve()
          .then(() => resend(message))
          .catch(() => { /* the Session's prompt error surfaces in the composer */ })
          .finally(() => { setPending(false) })
      }

      return h('div', { className: 'dsh-ra-row' },
        message === undefined
          ? null
          : h(Tooltip, { label: blocked ?? t('hint'), side: 'bottom', align: 'end' },
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
              await session.prompt(content, 'queue')
            },
          }),
        }, ReplyAgainButton))
      },
    }
  },
})
