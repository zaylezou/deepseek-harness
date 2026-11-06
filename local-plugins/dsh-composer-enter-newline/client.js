/**
 * Browser half: the composer's send-key mapping, plus the Settings row that
 * replaces the stock busy-Enter selector.
 *
 * Stock behavior (the ui-conversation composer keymap): Enter sends,
 * Shift+Enter breaks the line, Ctrl/Cmd+Enter sends with the accelerated
 * (opposite busy-mode) gesture. That keymap is package-internal, so this plugin
 * owns the physical keys one layer above it: a capture-phase keydown listener
 * on the document rewrites the gesture before the editor sees it.
 *
 * Every one of Enter / Shift+Enter / Ctrl+Cmd+Enter can be set to one of:
 *
 *   newline  insert a soft line break (the editor's INSERT_LINE_BREAK_COMMAND,
 *            the same command Shift+Enter ends up at — works on engines that
 *            insert through beforeinput, e.g. Safari)
 *   queue    send, queueing while the agent is running
 *   steer    send, steering into the running turn ("force send")
 *
 * queue/steer are delivered as the composer's own Enter gestures (plain and
 * accelerated), so every stock gate still applies: the busy-mode preference,
 * the upload gate and its toast, menu arbitration, empty-draft refusal, and
 * the queue-steer shortcut on an empty draft. Which of the two gestures a
 * send action dispatches is resolved against the live `ui-conversation`
 * busy-Enter preference, because the core inverts that preference for the
 * accelerated gesture.
 *
 * Settings live in this browser's localStorage (the same device-local model
 * the keybinding editor uses); the row replaces id `composer-enter` at a lower
 * slot priority, which is the documented way to shadow a list entry.
 *
 * Selectors are the composer's own stable data attributes:
 *   [data-composer-input]   the contenteditable host (ComposerContentEditable)
 *   [data-composer-card]    the bar card that anchors the overlay menus
 *   [data-composer-overlay] the trigger/suggestion menu anchor
 *   [role="listbox"][aria-activedescendant] only present with a highlight
 */
window.__ModuleLoader__.load({
  id: 'dsh-composer-enter-newline',
  factory: (require) => {
    const React = require('react')
    const { IconChevronDownOutlineRegular, Menu } = require('@deepseek-ai/dsh-client-ui-primitives')
    const h = React.createElement

    /** Locale namespace owned by this plugin; also the row's translate seat. */
    const NS = 'composer-enter-newline'
    /** Device-local preference document (same model as the keybinding editor). */
    const STORAGE_KEY = 'dsh.composer-enter-newline.v1'

    /** Key roles the row configures, in display order. */
    const ROLES = ['enter', 'shiftEnter', 'ctrlEnter']
    /** Actions one key can perform. */
    const ACTIONS = ['newline', 'queue', 'steer']
    /** Fresh installs: Enter breaks the line, Ctrl/Cmd+Enter sends. */
    const DEFAULTS = Object.freeze({ enter: 'newline', shiftEnter: 'newline', ctrlEnter: 'queue' })

    const KEY_LABEL = Object.freeze({
      enter: 'key.enter',
      shiftEnter: 'key.shift-enter',
      ctrlEnter: 'key.ctrl-enter',
    })
    const ACTION_LABEL = Object.freeze({
      newline: 'action.newline',
      queue: 'action.queue',
      steer: 'action.steer',
    })

    /** The composer's contenteditable host. */
    const COMPOSER = '[data-composer-input]'
    /** The bar card that contains both the editor and the overlay anchor. */
    const CARD = '[data-composer-card]'
    /** The overlay anchor the trigger/suggestion menus render into. */
    const OVERLAY = '[data-composer-overlay]'
    /** A menu owns Enter only while a row is highlighted. */
    const HIGHLIGHTED_MENU = '[role="listbox"][aria-activedescendant]'
    /** Safari delivers the composition-closing keydown after compositionend. */
    const COMPOSITION_GRACE_MS = 20
    /** Lexical keys its command map by object identity; the debug type finds it. */
    const LINE_BREAK_COMMAND = 'INSERT_LINE_BREAK_COMMAND'
    /** Marks the page while the remap is installed (handy for diagnostics). */
    const MARKER = 'data-dsh-composer-enter-newline'
    /** Host entry id whose busy-Enter preference the core inverts. */
    const BUSY_ENTER_NAMESPACE = 'ui-conversation'

    /** Row styles: the stock General row chrome, plus a three-line key list. */
    const ROW_CSS = String.raw`
.dsh-en-row{display:flex;flex-direction:column;gap:16px;padding:16px 0;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.dsh-en-head{display:flex;flex-direction:column;gap:4px}
.dsh-en-title{font-size:14px;font-weight:400;line-height:22px;color:var(--dsw-alias-label-primary)}
.dsh-en-desc{font-size:12px;font-weight:400;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dsh-en-keys{display:flex;flex-direction:column;gap:8px;max-width:560px}
.dsh-en-key{display:flex;align-items:center;justify-content:space-between;gap:16px}
.dsh-en-keylabel{font-size:13px;font-weight:400;line-height:20px;color:var(--dsw-alias-label-secondary)}
.dsh-en-select{display:inline-flex;align-items:center;gap:12px;height:32px;padding:0 12px;border:none;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-module-platform);font:inherit;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);cursor:pointer}
@media (hover:hover){.dsh-en-select:hover{background:var(--dsw-alias-interactive-bg-hover)}}
.dsh-en-chevron{flex:none}
`

    /** Baseline dictionaries: the locale service requires zh and en. */
    const LOCALES = {
      zh: {
        'title': '发送键位',
        'description': '分别设置 Enter、Shift+Enter、Ctrl/Cmd+Enter 在输入框里的行为。强制发送会在智能体运行时插话进当前轮，空闲时等同普通发送。',
        'key.enter': 'Enter',
        'key.shift-enter': 'Shift+Enter',
        'key.ctrl-enter': 'Ctrl/Cmd+Enter',
        'action.newline': '换行',
        'action.queue': '排队发送',
        'action.steer': '强制发送',
      },
      en: {
        'title': 'Send keys',
        'description': 'Choose what Enter, Shift+Enter, and Ctrl/Cmd+Enter do in the composer. Force send steers into the running turn; while idle it is an ordinary send.',
        'key.enter': 'Enter',
        'key.shift-enter': 'Shift+Enter',
        'key.ctrl-enter': 'Ctrl/Cmd+Enter',
        'action.newline': 'New line',
        'action.queue': 'Queue send',
        'action.steer': 'Force send',
      },
    }

    /**
     * Normalize a stored or partial document into a complete mapping.
     * @param value - parsed storage value of unknown shape.
     * @returns a fresh mapping with every role present and valid.
     */
    const normalize = (value) => {
      const next = { ...DEFAULTS }
      if (value !== null && typeof value === 'object') {
        for (const role of ROLES) {
          const candidate = value[role]
          if (ACTIONS.includes(candidate)) next[role] = candidate
        }
      }
      return next
    }

    /** Read the stored mapping; malformed or unavailable storage means defaults. */
    const loadSettings = () => {
      try {
        const raw = globalThis.localStorage?.getItem(STORAGE_KEY)
        return raw === null || raw === undefined ? normalize(undefined) : normalize(JSON.parse(raw))
      } catch {
        return normalize(undefined)
      }
    }

    let settings = loadSettings()
    const listeners = new Set()

    const emit = () => {
      for (const listener of listeners) {
        try {
          listener()
        } catch {
          // A failing subscriber must not break the others.
        }
      }
    }

    /**
     * Change one key mapping and persist it.
     * @param role - enter / shiftEnter / ctrlEnter.
     * @param action - newline / queue / steer.
     */
    const changeSetting = (role, action) => {
      if (!ROLES.includes(role) || !ACTIONS.includes(action)) return
      if (settings[role] === action) return
      settings = { ...settings, [role]: action }
      try {
        globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(settings))
      } catch {
        // Storage being unavailable leaves the in-memory mapping live.
      }
      emit()
    }

    /** Adopt another tab's write. */
    const syncSettings = () => {
      settings = loadSettings()
      emit()
    }

    const subscribeSettings = (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    }
    const readSettings = () => settings

    /** Synthetic keydowns this plugin dispatched; never remap them again. */
    const own = new WeakSet()
    /** Context captured by the key listener for the busy-preference lookup. */
    let listenContext = null
    let composingComposer = null
    let composingUntil = 0

    const composerOf = node => (node instanceof Element ? node.closest(COMPOSER) : null)

    const compositionActive = composer =>
      composer !== null && composer === composingComposer && Date.now() < composingUntil

    /**
     * Whether an Enter-family key currently belongs to a highlighted menu.
     * @param composer - the focused composer root.
     * @returns true when a menu row is highlighted and should take the key.
     */
    const hasHighlightedMenu = (composer) => {
      const scope = composer.closest(CARD) ?? composer.closest('[data-composer-seat]') ?? document
      const overlay = scope.querySelector(OVERLAY)
      return overlay !== null && overlay.querySelector(HIGHLIGHTED_MENU) !== null
    }

    /**
     * Find one of the editor's registered commands by its debug type.
     * @param editor - the composer's Lexical editor.
     * @param type - command type string, e.g. INSERT_LINE_BREAK_COMMAND.
     * @returns the command object, or null when the registry is unreachable.
     */
    const commandOf = (editor, type) => {
      const commands = editor._commands
      if (!(commands instanceof Map)) return null
      for (const command of commands.keys()) {
        if (command !== null && typeof command === 'object' && command.type === type) return command
      }
      return null
    }

    /**
     * Dispatch one synthetic Enter on the original target.
     * @param composer - the composer root, used when the target is not an element.
     * @param source - the native keydown being rewritten.
     * @param init - modifier flags for the synthetic event.
     */
    const dispatchEnter = (composer, source, init) => {
      const target = source.target instanceof Element ? source.target : composer
      const event = new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        bubbles: true,
        cancelable: true,
        composed: true,
        repeat: false,
        isComposing: false,
        ...init,
      })
      own.add(event)
      target.dispatchEvent(event)
    }

    /**
     * Insert one line break through the editor's command layer.
     * @param composer - the composer root carrying the editor binding.
     * @param source - the native keydown being rewritten.
     */
    const breakLine = (composer, source) => {
      const editor = composer.__lexicalEditor
      if (editor !== null && typeof editor === 'object' && typeof editor.dispatchCommand === 'function') {
        const command = commandOf(editor, LINE_BREAK_COMMAND)
        if (command !== null) {
          try {
            if (editor.dispatchCommand(command, false) === true) return
          } catch {
            // A detached editor falls through to the keyboard gesture below.
          }
        }
      }
      // Fallback: the native Shift+Enter gesture (Chromium/Firefox path).
      dispatchEnter(composer, source, { shiftKey: true })
    }

    /**
     * The live busy-Enter preference the core inverts for its accelerated gesture.
     * @param ctx - the plugin context (service lookup, not a declared dependency).
     * @returns the stored preference, defaulting to queue while unavailable.
     */
    const preferredBusyEnter = (ctx) => {
      try {
        const busy = ctx.get('configForms')?.get(BUSY_ENTER_NAMESPACE)?.getSnapshot()?.value?.busyEnter
        return busy === 'steer' ? 'steer' : 'queue'
      } catch {
        return 'queue'
      }
    }

    /**
     * Classify one keydown into the role the row configures.
     * @param event - the native keydown.
     * @returns the role, or null for combinations that keep their stock handling.
     */
    const roleOf = (event) => {
      if (event.key !== 'Enter') return null
      if (event.altKey || event.getModifierState('AltGraph')) return null
      const control = event.ctrlKey
      const meta = event.metaKey
      if (control && meta) return null
      // Shift+Ctrl/Cmd+Enter stays stock (the keymap swallows it).
      if (event.shiftKey && (control || meta)) return null
      if (event.shiftKey) return 'shiftEnter'
      if (control || meta) return 'ctrlEnter'
      return 'enter'
    }

    /** Capture-phase keydown: rewrite the configured send/break gestures. */
    const onKeyDown = (event) => {
      if (own.has(event)) return
      if (event.defaultPrevented) return
      const role = roleOf(event)
      if (role === null) return
      // IME candidate pick: never submit and never break the line.
      if (event.isComposing || event.keyCode === 229) return
      const composer = composerOf(event.target)
      if (composer === null || !composer.isContentEditable) return
      if (compositionActive(composer)) return
      // An open picker owns Enter-family keys: the stock arbitration decides.
      if (hasHighlightedMenu(composer)) return
      const action = settings[role]
      if (action === 'newline') {
        event.preventDefault()
        event.stopImmediatePropagation()
        breakLine(composer, event)
        return
      }
      event.preventDefault()
      event.stopImmediatePropagation()
      // A held chord must not machine-gun sends.
      if (event.repeat) return
      // The core resolves plain Enter to the busy preference and the
      // accelerated chord to its opposite; pick the gesture that lands on the
      // requested mode.
      const preferred = preferredBusyEnter(listenContext)
      const accelerated = action === 'queue' ? preferred === 'steer' : preferred !== 'steer'
      dispatchEnter(composer, event, {
        ctrlKey: accelerated,
        metaKey: false,
        shiftKey: false,
      })
    }

    const onCompositionStart = (event) => {
      const composer = composerOf(event.target)
      if (composer === null) return
      composingComposer = composer
      composingUntil = Number.POSITIVE_INFINITY
    }

    const onCompositionEnd = (event) => {
      const composer = composerOf(event.target)
      if (composer === null || composer !== composingComposer) return
      composingUntil = Date.now() + COMPOSITION_GRACE_MS
      setTimeout(() => {
        if (composingComposer === composer && Date.now() >= composingUntil) composingComposer = null
      }, COMPOSITION_GRACE_MS + 10)
    }

    const onStorage = (event) => {
      if (event.key === STORAGE_KEY || event.key === null) syncSettings()
    }

    /**
     * Attach the document-level listeners.
     * @param ctx - the plugin context.
     * @returns the disposer removing every listener and the page marker.
     */
    const install = (ctx) => {
      listenContext = ctx
      document.addEventListener('keydown', onKeyDown, true)
      document.addEventListener('compositionstart', onCompositionStart, true)
      document.addEventListener('compositionend', onCompositionEnd, true)
      globalThis.addEventListener('storage', onStorage)
      document.documentElement.setAttribute(MARKER, '')
      return () => {
        document.removeEventListener('keydown', onKeyDown, true)
        document.removeEventListener('compositionstart', onCompositionStart, true)
        document.removeEventListener('compositionend', onCompositionEnd, true)
        globalThis.removeEventListener('storage', onStorage)
        document.documentElement.removeAttribute(MARKER)
        composingComposer = null
        composingUntil = 0
        listenContext = null
      }
    }

    /**
     * One key's dropdown.
     * @param props - role, current action, and the bound translate seat.
     * @returns the label and selector line.
     */
    function KeyChoice({ role, value, t }) {
      const [open, setOpen] = React.useState(false)
      const options = ACTIONS.map(action => ({ id: action, label: t(ACTION_LABEL[action]) }))
      const selected = options.find(option => option.id === value) ?? options[0]
      return h('div', { className: 'dsh-en-key' },
        h('span', { className: 'dsh-en-keylabel' }, t(KEY_LABEL[role])),
        h(Menu, {
          open,
          onClose: () => { setOpen(false) },
          items: options,
          selectedId: value,
          onSelect: (id) => {
            setOpen(false)
            changeSetting(role, id)
          },
          align: 'end',
          portal: true,
          anchor: h('button', {
            type: 'button',
            className: 'dsh-en-select',
            'aria-haspopup': 'menu',
            'aria-expanded': open,
            'aria-label': `${t(KEY_LABEL[role])}: ${selected.label}`,
            onClick: () => { setOpen(open => !open) },
          },
            h('span', null, selected.label),
            h(IconChevronDownOutlineRegular, { className: 'dsh-en-chevron' }),
          ),
        }),
      )
    }

    /**
     * The replacement General row: one selector per send key.
     * @param props - the slot's locale translate seat.
     * @returns the row.
     */
    function SendKeysRow({ t }) {
      const mapping = React.useSyncExternalStore(subscribeSettings, readSettings, readSettings)
      return h('div', { className: 'dsh-en-row' },
        h('style', { key: 'style' }, ROW_CSS),
        h('div', { className: 'dsh-en-head' },
          h('div', { className: 'dsh-en-title' }, t('title')),
          h('div', { className: 'dsh-en-desc' }, t('description')),
        ),
        h('div', { className: 'dsh-en-keys' },
          ROLES.map(role => h(KeyChoice, { key: role, role, value: mapping[role], t })),
        ),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, LOCALES), 'dsh-composer-enter-newline: locales')
        ctx.effect(() => install(ctx), 'dsh-composer-enter-newline: composer key remap')
        // A lower priority shadows the stock busy-Enter row at the same id;
        // the winner keeps the same display order.
        ctx.slots.inject('settings.general.item', () => ctx.slots.register({
          name: 'settings.general.item',
          id: 'composer-enter',
          order: 20,
          priority: -1,
          locale: NS,
        }, SendKeysRow))
      },
    }
  },
})
