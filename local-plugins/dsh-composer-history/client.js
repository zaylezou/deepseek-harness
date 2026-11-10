/**
 * Browser half: shell-style message history for the composer.
 *
 * What it is for. A terminal lets you press ↑ to get the command you ran
 * before. The composer has no such thing: once a message is sent, its text is
 * gone from the editor, and getting it back means scrolling the transcript,
 * selecting the bubble, and copying it. This plugin walks the messages the
 * session already holds: ↑ fills the draft with the previous message, ↓ walks
 * forward again, and ↓ past the newest entry puts back whatever you had typed
 * before you started browsing.
 *
 * Two faces, one list. A phone has no arrow keys, so a handheld browser also
 * gets a two-button stepper in the composer tool row; a desktop keyboard drives
 * the same list with plain ↑ / ↓ inside the composer. The buttons are chosen by
 * `handheld()` (UA first, then touch plus a coarse primary pointer), so a touch
 * laptop with a fine pointer keeps its screen uncluttered.
 *
 * Keyboard boundaries, so editing still works. ↑ is taken only when the draft
 * is empty, when it is the text this plugin just wrote with the caret at either
 * end, or when the caret sits at the very start of whatever the user typed;
 * ↓ only while browsing the recalled text itself. A multi-line draft therefore
 * keeps its caret movement, and a picker that owns the arrows (command / @
 * reference) is never stolen from.
 *
 * Where the history comes from. The session log is the only source of truth,
 * so the list is derived from the live Chat node store instead of a private
 * copy of what was sent: `user` nodes are the admitted messages, and `steering`
 * nodes are the messages typed into a running turn, which a terminal-history
 * user would also expect to get back. Only text blocks can be recalled;
 * attachments and reference chips are browser-owned values that cannot be
 * recreated from a transcript, so an image-only message is skipped rather than
 * recalled as an empty draft.
 *
 * Where the buttons render. `conversation.input.left` is the empty left end of
 * the composer tool row (after the attach and Plan / Read-only chips). It is
 * the same row the stock compact controls use, so the stepper inherits their
 * size and spacing and needs no DOM measurement of its own.
 *
 * Position model. `cursor` counts messages from the newest one, so a message
 * that arrives while browsing does not shift the entry under the cursor; it
 * only becomes the new newest entry. `saved` holds the draft the user had
 * before the first ↑, and `pending` marks the text this plugin just wrote so
 * the "draft went empty" reset only fires for a real clear or send, never for
 * the store's lag between `setDraft()` and the next published snapshot.
 */
window.__ModuleLoader__.load({
  id: 'dsh-composer-history',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    /** Locale namespace owned by this plugin. */
    const NS = 'composer-history'
    /** Marks the injected stylesheet for diagnostics and removal. */
    const STYLE_ATTR = 'data-dsh-composer-history-css'
    /** Marks the document while the stepper is installed (handy in devtools). */
    const MARKER = 'data-dsh-composer-history'
    /** Device-check override: '1' always shows the buttons, '0' hides them. */
    const FORCE_BUTTONS = 'dsh.composer-history.force-buttons'
    /** The composer's contenteditable host (the composer's own stable attribute). */
    const COMPOSER = '[data-composer-input]'
    /** The composer card that anchors the overlay menus. */
    const CARD = '[data-composer-card]'
    /** The overlay anchor the command / reference pickers render into. */
    const OVERLAY = '[data-composer-overlay]'
    /** Root attribute naming the Session a Conversation host renders. */
    const CONVERSATION_SESSION = '[data-conversation-session]'

    /** Node kinds whose content is a human message this stepper can recall. */
    const RECALLABLE = new Set(['user', 'steering'])

    /** Baseline dictionaries: the locale service requires zh and en. */
    const LOCALES = {
      zh: {
        'group': '历史消息',
        'up': '上一条历史消息',
        'down': '下一条历史消息',
        'up.hint': '把上一条发过的消息填回输入框（像终端的 ↑）',
        'up.oldest': '已经到最早的一条了',
        'down.hint': '回到较新的消息；到最新一条后再按一次会恢复你刚才的草稿',
        'down.idle': '先按 ↑ 才开始回溯',
        'empty': '这个会话还没有可以回溯的消息',
      },
      en: {
        'group': 'Message history',
        'up': 'Previous message',
        'down': 'Next message',
        'up.hint': 'Put the previous message you sent back into the composer (like ↑ in a terminal)',
        'up.oldest': 'Already at the oldest message',
        'down.hint': 'Move to a newer message; past the newest one this restores the draft you had',
        'down.idle': 'Press ↑ first to start browsing',
        'empty': 'This session has no messages to recall yet',
      },
    }

    /**
     * Stepper chrome. Sized and colored like the stock attach circle and mode
     * chips in the same row: one segmented pill, two icon buttons, theme
     * tokens only. `role`/`aria-label` on the group, real `disabled` on the
     * buttons so keyboard users cannot reach a dead action.
     */
    const CSS = String.raw`
.dsh-ch-group{display:inline-flex;align-items:center;flex:none;height:28px;padding:1px;border-radius:999px;background:var(--dsw-specific-selector,rgba(127,127,127,0.12))}
.dsh-ch-btn{display:grid;place-items:center;width:26px;height:26px;padding:0;border:none;border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary,#6b7280);cursor:pointer}
@media (hover:hover){
  .dsh-ch-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,0.16));color:var(--dsw-alias-label-primary,#111827)}
}
.dsh-ch-btn:disabled{opacity:0.38;cursor:default}
.dsh-ch-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#1f6feb);outline-offset:1px}
.dsh-ch-btn svg{width:14px;height:14px;display:block}
`

    /** The pictogram inside both buttons; direction is the only difference. */
    const chevron = (path) => () => h('svg', { viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
      h('path', {
        d: path,
        stroke: 'currentColor',
        strokeWidth: 1.7,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      }))
    const IconUp = chevron('M4 10 8 6l4 4')
    const IconDown = chevron('M4 6l4 4 4-4')

    /**
     * Whether this browser is a handheld device, where no arrow keys exist.
     *
     * The UA is the primary signal: phones and most tablets name themselves,
     * and iPadOS keeps "Mobile" in its Macintosh-shaped UA. A Mac reports no
     * touch points, so touch plus a coarse primary pointer catches the iPad
     * desktop-mode case without hiding the buttons on a touchscreen laptop,
     * whose primary pointer stays fine. `localStorage` can override the answer
     * for testing (documented in the README).
     * @returns true when the tool row should show the buttons.
     */
    function handheld() {
      try {
        const forced = globalThis.localStorage?.getItem(FORCE_BUTTONS)
        if (forced === '1') return true
        if (forced === '0') return false
      } catch {
        // Private-mode storage can throw; the UA answer stands.
      }
      const ua = globalThis.navigator?.userAgent ?? ''
      if (/Android|iPhone|iPad|iPod|Mobile|HarmonyOS|Windows Phone|Kindle/i.test(ua)) return true
      const touch = (globalThis.navigator?.maxTouchPoints ?? 0) > 1
      return touch && globalThis.matchMedia?.('(pointer: coarse)')?.matches === true
    }

    /**
     * Whether a command / reference picker currently owns the arrow keys.
     * @param composer - the focused composer root.
     * @returns true while a listbox is open inside the composer overlay.
     */
    function pickerOpen(composer) {
      const scope = composer.closest(CARD) ?? document
      const overlay = scope.querySelector(OVERLAY)
      return overlay !== null && overlay.querySelector('[role="listbox"]') !== null
    }

    /**
     * Join one message node's text blocks.
     * @param node - live Chat view node; only `text` blocks are recallable.
     * @returns the trimmed message text, or '' when the message carries none.
     */
    function textOf(node) {
      const blocks = node?.data?.content
      if (!Array.isArray(blocks)) return ''
      const parts = []
      for (const block of blocks) {
        if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
          parts.push(block.text)
        }
      }
      return parts.join('\n').trim()
    }

    /**
     * Collect the session's recallable messages, oldest first.
     *
     * Reads the live node store at call time (it is a stable reader, not a
     * time-point snapshot), so a click after a send still sees the new message.
     * Consecutive duplicates collapse: pressing ↑ over three identical "继续"
     * turns would otherwise cost three presses for one visible difference.
     * @param nodes - the Chat node store from the Chat snapshot.
     * @returns message texts, oldest first, newest last.
     */
    function collect(nodes) {
      const rows = []
      for (const node of nodes.values()) {
        if (node === undefined || !RECALLABLE.has(node.kind)) continue
        const text = textOf(node)
        if (text === '') continue
        rows.push({ anchorSeq: node.anchorSeq, text })
      }
      rows.sort((left, right) => left.anchorSeq - right.anchorSeq)
      const texts = []
      for (const row of rows) {
        if (texts.length > 0 && texts[texts.length - 1] === row.text) continue
        texts.push(row.text)
      }
      return texts
    }

    /** Keep the caret in the editor: a press on the stepper must not move focus. */
    const keepFocus = (event) => { event.preventDefault() }

    /**
     * The composer history control: buttons on a handheld browser, arrow keys
     * everywhere.
     * @param props - the session-scope standard props plus the locale seat.
     * @returns the segmented Up/Down control, or null when the buttons are off.
     */
    function HistoryStepper(props) {
      const { useChat, useInput, inputActions, useAccess, sessionId, t } = props
      // `nodes` is one stable reader across snapshots and `order` changes only
      // when a node appears or leaves, so the memo below runs on structural
      // changes, never on a streaming token.
      const nodes = useChat(snapshot => snapshot.nodes)
      const order = useChat(snapshot => snapshot.order)
      const draft = useInput(state => state.draft)
      const phase = useInput(state => state.phase)
      const allowed = useAccess('session/prompt') !== false
      const history = React.useMemo(() => collect(nodes), [nodes, order])
      const showButtons = React.useMemo(handheld, [])

      /** Offset from the newest message while browsing; null when not browsing. */
      const [cursor, setCursor] = React.useState(null)
      /** Mirror of `cursor` for handlers called before React re-renders (key repeat). */
      const cursorRef = React.useRef(null)
      /** Draft the user had before the first ↑ of this browse session. */
      const saved = React.useRef('')
      /** Text this plugin last wrote; also the "unmodified recall" marker. */
      const applied = React.useRef(null)
      /** Text this plugin wrote, until the editor publishes it back. */
      const pending = React.useRef(null)

      const ready = allowed && phase === 'plain'
      // The key listener is installed once; every value it consults lives in a
      // ref that this render body refreshes, so it never reads a stale closure.
      const nodesRef = React.useRef(nodes)
      const draftRef = React.useRef(draft)
      const readyRef = React.useRef(ready)
      const sessionRef = React.useRef(sessionId)
      nodesRef.current = nodes
      draftRef.current = draft
      readyRef.current = ready
      sessionRef.current = sessionId

      const setPosition = (value) => {
        cursorRef.current = value
        setCursor(value)
      }

      /** Write one recalled entry and remember it until the store confirms. */
      const write = (text) => {
        applied.current = text
        pending.current = text
        if (inputActions === undefined) return
        try {
          inputActions.setDraft(text)
        } catch {
          // A disposed Session has no editor to write to; the next render of
          // the new binding replaces this component.
        }
      }

      /** ↑: older message; the first press also stores the current draft. */
      const older = () => {
        if (!readyRef.current) return
        const list = collect(nodesRef.current)
        if (list.length === 0) return
        const current = cursorRef.current
        if (current === null) saved.current = draftRef.current
        const next = current === null ? 0 : Math.min(current + 1, list.length - 1)
        setPosition(next)
        write(list[list.length - 1 - next])
      }

      /** ↓: newer message; past the newest one, restore the saved draft. */
      const newer = () => {
        if (!readyRef.current) return
        const current = cursorRef.current
        if (current === null) return
        const list = collect(nodesRef.current)
        const next = current - 1
        if (next < 0 || list.length === 0) {
          setPosition(null)
          write(saved.current)
          return
        }
        const clamped = Math.min(next, list.length - 1)
        setPosition(clamped)
        write(list[list.length - 1 - clamped])
      }

      /** Live selection span; a disposed editor answers null. */
      const caret = () => {
        if (inputActions === undefined) return null
        try {
          return inputActions.captureInsertion()
        } catch {
          return null
        }
      }

      /** A collapsed caret at the very start of the document. */
      const atStart = () => {
        const span = caret()
        return span !== null && span.start === 0 && span.end === 0
      }

      /**
       * A collapsed caret at the very end of the draft. Detect coordinates
       * count a reference chip as one character while the draft projection
       * expands it, so this is exact for text and conservative with chips.
       */
      const atEnd = () => {
        const span = caret()
        return span !== null && span.start === span.end && span.end >= draftRef.current.length
      }

      /**
       * ↑ may take the key where ArrowUp has no native meaning — an empty
       * draft, the very start, the end of a single-line draft — plus anywhere
       * inside the recall this plugin itself wrote (the browse chain).
       */
      const mayOlder = () => {
        const value = draftRef.current
        if (value === '') return true
        if (value === applied.current) return atStart() || atEnd()
        if (atStart()) return true
        return atEnd() && !value.includes('\n')
      }

      /** ↓ may take the key only while the recalled text is still unmodified. */
      const mayNewer = () => cursorRef.current !== null && draftRef.current === applied.current && atEnd()

      // Refresh the listener's view of the handlers without reinstalling it.
      const handlers = React.useRef(null)
      handlers.current = { older, newer, mayOlder, mayNewer }

      // A different Session keeps its own composer; drop the previous browse.
      React.useEffect(() => {
        setCursor(null)
        cursorRef.current = null
        saved.current = ''
        pending.current = null
      }, [sessionId])

      React.useEffect(() => {
        if (pending.current !== null) {
          if (draft === pending.current) pending.current = null
          return
        }
        // A send or a manual clear ends the browse; the next ↑ starts from the
        // newest message again (which now includes the one just sent).
        if (cursor !== null && draft === '') {
          setCursor(null)
          cursorRef.current = null
        }
      }, [draft, cursor])

      React.useEffect(() => {
        /**
         * Capture-phase arrows: inside the composer, at a history boundary,
         * with no picker owning them. Everything else keeps its stock meaning.
         * @param event - native keydown.
         */
        const onKeyDown = (event) => {
          if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return
          if (event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return
          if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
          if (!(event.target instanceof Element)) return
          const composer = event.target.closest(COMPOSER)
          if (composer === null) return
          // Two Conversation hosts can be mounted at once (the subagent panel
          // has its own composer); only the host of this Session may act.
          const scope = composer.closest(CONVERSATION_SESSION)
          if (scope === null || scope.getAttribute('data-conversation-session') !== sessionRef.current) return
          const live = handlers.current
          if (live === null || !readyRef.current) return
          if (pickerOpen(composer)) return
          const take = event.key === 'ArrowUp' ? live.mayOlder() : live.mayNewer()
          if (!take) return
          event.preventDefault()
          event.stopImmediatePropagation()
          if (event.key === 'ArrowUp') live.older()
          else live.newer()
        }
        document.addEventListener('keydown', onKeyDown, true)
        return () => { document.removeEventListener('keydown', onKeyDown, true) }
      }, [])

      const canRecall = ready && history.length > 0
      const atOldest = cursor !== null && cursor >= history.length - 1
      const upDisabled = !canRecall || atOldest
      const downDisabled = !ready || cursor === null
      const upTitle = upDisabled
        ? (!ready ? t('down.idle') : canRecall ? t('up.oldest') : t('empty'))
        : t('up.hint')
      const downTitle = downDisabled ? t('down.idle') : t('down.hint')

      // A desktop keyboard drives the same actions; the tool row stays clean.
      if (!showButtons) return null

      return h('div', {
        className: 'dsh-ch-group',
        role: 'group',
        'aria-label': t('group'),
        title: t('group'),
      },
        h('button', {
          type: 'button',
          className: 'dsh-ch-btn',
          'aria-label': t('up'),
          title: upTitle,
          disabled: upDisabled,
          onMouseDown: keepFocus,
          onClick: older,
        }, h(IconUp, null)),
        h('button', {
          type: 'button',
          className: 'dsh-ch-btn',
          'aria-label': t('down'),
          title: downTitle,
          disabled: downDisabled,
          onMouseDown: keepFocus,
          onClick: newer,
        }, h(IconDown, null)),
      )
    }

    return {
      name: 'dsh-composer-history',
      inject: ['slots', 'locale'],
      /**
       * Mount the history control into the composer tool row.
       * @param ctx - client root context.
       */
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, LOCALES), 'dsh-composer-history: dictionaries')

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
        }, 'dsh-composer-history: stylesheet')

        ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
          name: 'conversation.input.left',
          id: 'composer-history',
          order: 0,
          locale: NS,
        }, HistoryStepper))
      },
    }
  },
})
