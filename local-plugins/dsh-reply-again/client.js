/**
 * Browser half: a "Re-answer" control in the Turn tail.
 *
 * What it is for. A Turn can end without usable output: the Host refused a
 * prompt after the draft left the composer, the model call failed, the agent
 * was interrupted, or the process restarted mid-turn. The transcript then
 * shows the user message with no reply (or a frozen partial one), and there is
 * no stock way to ask for that answer again. This plugin adds one control
 * under the closed Turn that re-sends the Turn's user text as a fresh prompt.
 *
 * Why the Turn tail and not a per-message action strip. `conversation.chat.turnTail`
 * is the one Chat slot rendered for EVERY closed Turn, including the ones with
 * no durable assistant message at all (interrupted before output, provider
 * error). The assistant action strip only exists when a finalized assistant
 * message carries a `messageId`, and the user row has no action slot. One
 * registration therefore covers both cases.
 *
 * What is resent. The Turn's opening user message, verbatim, as one text
 * block. Attachments are NOT replayed: their upload receipts are per-prompt
 * and cannot be reconstructed here, so a Turn whose message carries images or
 * files renders the control disabled with that reason instead of silently
 * dropping them.
 *
 * Delivery. `conversation.send` is the Session-scoped send path: it is
 * resolved through `ctx.sessions.scope(sessionId)` so a control that outlives
 * a session switch still targets its own session. It rejects on the Host's
 * business errors (writer held, agent busy); those surface in the composer's
 * notice rail, the same place a draft send failure appears.
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
        'action': '重新回复',
        'sending': '发送中…',
        'hint': '把这条消息再发一次，让 agent 重新回答（发送失败、回复中断或进程重启后适用）',
        'busy': '先等当前这轮回复结束',
        'unsupported': '这条消息带附件，暂时不能重发（附件凭证无法复用）',
        'sent': '已重新发送，等 agent 回复',
        'failed': '重发失败：{message}',
        'denied': '这个会话不允许发送消息',
      },
      en: {
        'action': 'Re-answer',
        'sending': 'Sending…',
        'hint': 'Send this message again so the agent answers it afresh (failed send, interrupted reply, or a restart mid-turn)',
        'busy': 'Wait for the current turn to finish',
        'unsupported': 'This message has attachments, which cannot be replayed here',
        'sent': 'Sent again; waiting for the agent',
        'failed': 'Re-send failed: {message}',
        'denied': 'This session does not allow sending messages',
      },
    }

    /** Package-local chrome: same metrics as the stock IconActions row. */
    const CSS = String.raw`
.dsh-ra-row{display:flex;align-items:center;margin-left:-6px}
.dsh-ra-button{display:inline-flex;align-items:center;gap:5px;height:calc(28px + var(--dsh-content-font-delta, 0px));padding:0 8px;border:none;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-tertiary);font-size:var(--dsh-content-font-size-secondary, 13px);line-height:20px;cursor:pointer}
.dsh-ra-button svg{width:14px;height:14px;flex:0 0 auto}
@media (hover:hover){.dsh-ra-button:hover:not([aria-disabled]){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}}
.dsh-ra-button:focus-visible{box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline:none}
.dsh-ra-button[aria-disabled]{opacity:0.4;cursor:default}
@media (hover:hover){
  [data-actions-reveal='hover'] .dsh-ra-row{opacity:0;transition:opacity 80ms ease}
  [data-actions-reveal='hover']:hover .dsh-ra-row,
  [data-actions-reveal='hover']:focus-within .dsh-ra-row{opacity:1}
}
`

    /**
     * One Chat Node's visible text, for the Turn-opening user message.
     * @param snapshot - live Chat snapshot.
     * @param turn - owning Turn number.
     * @returns trimmed prompt text, or undefined when the Turn's input is outside the loaded window.
     */
    function turnPrompt(snapshot, turn) {
      const keys = snapshot.locations.getTurn(turn)
      for (const key of keys) {
        const node = snapshot.nodes.get(key)
        if (node === undefined || node.kind !== 'user') continue
        const parts = []
        for (const block of node.data.content ?? []) {
          if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
            parts.push(block.text)
          }
        }
        const text = parts.join('\n').trim()
        return text === '' ? undefined : text
      }
      return undefined
    }

    /**
     * Whether the Turn's input carries attachments this control cannot replay.
     * @param snapshot - live Chat snapshot.
     * @param turn - owning Turn number.
     * @returns true when an image or file block is present.
     */
    function turnHasAttachments(snapshot, turn) {
      const keys = snapshot.locations.getTurn(turn)
      for (const key of keys) {
        const node = snapshot.nodes.get(key)
        if (node === undefined || node.kind !== 'user') continue
        return (node.data.content ?? []).some(block =>
          block !== null && typeof block === 'object' && (block.type === 'image' || block.type === 'file'))
      }
      return false
    }

    /**
     * The Turn-tail entry: a compact button that resends this Turn's message.
     * @param props - Turn owner currency, the injected send verb, and the standard Session kit.
     * @returns the control, or null without permission to send.
     */
    function ReplyAgainButton(props) {
      const { turn, resend, notify, t, useSession, useAccess, useChat } = props
      // The owner hands over the Turn LOCATION; its number keys the Chat indexes.
      const number = turn.turn
      const running = useSession(snapshot => snapshot.running)
      const allowed = useAccess('session/prompt') !== false
      const text = useChat(snapshot => turnPrompt(snapshot, number))
      const attachments = useChat(snapshot => turnHasAttachments(snapshot, number))
      const [pending, setPending] = React.useState(false)
      if (!allowed) return null
      // A partial history window can start mid-Turn; nothing to resend then.
      if (text === undefined) return null

      const blocked = running ? t('busy') : attachments ? t('unsupported') : null
      const onRetry = () => {
        if (blocked !== null || pending) return
        setPending(true)
        Promise.resolve()
          .then(() => resend(text))
          .then(() => { notify('info', t('sent')) })
          .catch((error) => { notify('error', t('failed', { message: error instanceof Error ? error.message : String(error) })) })
          .finally(() => { setPending(false) })
      }

      return h('div', { className: 'dsh-ra-row' },
        h(Tooltip, { label: blocked ?? t('hint'), side: 'bottom' },
          h('button', {
            type: 'button',
            className: 'dsh-ra-button',
            'aria-label': t('action'),
            'aria-disabled': blocked !== null || pending ? true : undefined,
            'aria-busy': pending ? true : undefined,
            onClick: blocked === null && !pending ? onRetry : undefined,
          },
          h(IconRefreshOutlineRegular, null),
          h('span', null, pending ? t('sending') : t('action')))))
    }

    return {
      name: 'dsh-reply-again',
      inject: ['slots', 'sessions', 'locale'],
      /**
       * Mount the Turn-tail control.
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

        ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
          name: 'conversation.chat.turnTail',
          id: 'reply-again',
          order: 10,
          locale: NS,
          inject: (sessionId) => ({
            // Resolve per call: a switch can dispose the Session scope between
            // mount and click, and the click must still hit its own Session.
            resend: async (text) => {
              const actx = ctx.sessions.scope(sessionId)
              if (actx === undefined) throw new Error(t('denied'))
              const conversation = actx.get('conversation')
              if (conversation === undefined) throw new Error(t('denied'))
              await conversation.send(text)
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
