/**
 * Browser half: one key in the composer flips the current session between
 * Full access and whatever preset it had before, with no risk-confirmation
 * dialog in between.
 *
 * Why a plugin instead of the stock control: the composer chip (and the
 * General-settings row) route a Full-access pick through `RiskConfirmation` —
 * an acknowledgment checkbox plus an Enable button. That gate is deliberate
 * core UI, and it is the only thing standing between a pick and the switch.
 * The write path itself (`/permission <preset>` on the session) has no gate:
 * it appends the preset's two knob events and the `permissions` projection
 * pushes the new value into the chip. This plugin calls that path directly,
 * so enabling Full access is one key, not a dialog.
 *
 * The key is registered as a FIXED shortcut action, not an editable one,
 * because the core reserves Tab: `bindingIssue` reports `modifier-required`
 * for a bare Tab and `reserved` for every modified Tab, and the Web runtime
 * additionally rejects it through `isWebBindingAllowed`. A fixed row is the
 * only way to put Tab in the reference panel — it reserves the combination
 * against editable commands and shows up as a read-only row.
 *
 * Scope: Tab only fires while the caret is inside the composer card
 * (`[data-composer-card]`) and no dialog is open. Everywhere else — page,
 * sidebar, terminal, forms — Tab keeps its native focus movement, and
 * Shift+Tab still moves focus backwards out of the composer. A globally
 * swallowed Tab would make the whole app unusable from the keyboard.
 *
 * Full access applies the preset bundle (`danger-full-access` + approval
 * `never`), so the same key that lifts the sandbox also stops the per-call
 * approval prompts. Toggling back restores the preset the session had when it
 * entered Full access (memory is per session, in this page only).
 */
window.__ModuleLoader__.load({
  id: 'dsh-permission-toggle',
  factory: () => {
    /** Locale namespace owned by this plugin. */
    const NS = 'permission-toggle'

    /** Canonical preset key for Full access; the core chip writes the same literal. */
    const FULL_PRESET = 'danger-full-access'
    /** Preset restored when the session entered Full access from a derived state. */
    const DEFAULT_PRESET = 'workspace-write'
    /** Current values that name a derived state instead of a switch target. */
    const DERIVED_PRESETS = new Set(['custom', 'auto'])
    /** The composer capsule: the one region that owns Tab. */
    const COMPOSER = '[data-composer-card]'
    /** Marks the page while the toggle is installed (handy for diagnostics). */
    const MARKER = 'data-dsh-permission-toggle'
    /** Visible toast lifetime before it fades; the node leaves after the transition. */
    const TOAST_MS = 1600
    /** Fade duration, matching the inline transition below. */
    const FADE_MS = 180

    /** Built-in preset labels; unknown presets keep their raw key. */
    const PRESET_LABELS = {
      'read-only': 'preset.read-only',
      'workspace-write': 'preset.workspace-write',
      'danger-full-access': 'preset.full-access',
    }

    /** Baseline dictionaries: the locale service requires zh and en. */
    const LOCALES = {
      zh: {
        'label': '切换权限模式',
        'key.tab': 'Tab',
        'switched': '权限模式：{name}',
        'preset.read-only': '只读',
        'preset.workspace-write': '工作区写入',
        'preset.full-access': '完全访问',
        'no-session': '没有打开的会话',
        'no-permission': '这个会话没有权限切换入口',
        'no-command': '宿主没有提供 /permission 命令',
        'failed': '切换失败：{message}',
      },
      en: {
        'label': 'Toggle permission mode',
        'key.tab': 'Tab',
        'switched': 'Permission mode: {name}',
        'preset.read-only': 'Read only',
        'preset.workspace-write': 'Workspace write',
        'preset.full-access': 'Full access',
        'no-session': 'No open session',
        'no-permission': 'This session has no permission control',
        'no-command': 'The host offers no /permission command',
        'failed': 'Switch failed: {message}',
      },
    }

    /** Toast node and its fade timer, shared by every feedback path. */
    let toastEl = null
    let toastTimer = 0
    let toastFade = 0
    /** The preset each session had when it entered Full access (page-local). */
    const restore = new Map()
    /** One toggle at a time; a held key must not stack commands. */
    let busy = false

    /**
     * Remove the toast node and both of its timers.
     */
    const clearToast = () => {
      globalThis.clearTimeout(toastTimer)
      globalThis.clearTimeout(toastFade)
      toastTimer = 0
      toastFade = 0
      if (toastEl !== null) {
        toastEl.remove()
        toastEl = null
      }
    }

    /**
     * Show one short, self-dismissing status line above the composer.
     * @param text - already-localized message.
     * @param error - whether to tint the text with the error color.
     */
    const notify = (text, error = false) => {
      if (typeof document === 'undefined' || document.body === null) return
      if (toastEl === null || !toastEl.isConnected) {
        toastEl = document.createElement('div')
        toastEl.setAttribute('data-dsh-permission-toggle-toast', '')
        toastEl.setAttribute('role', 'status')
        toastEl.style.cssText = [
          'position:fixed', 'left:50%', 'bottom:104px', 'transform:translateX(-50%)',
          'z-index:2147483000', 'max-width:min(78vw,520px)', 'padding:8px 14px',
          'border-radius:10px', 'border:.5px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14))',
          'background:var(--dsw-alias-bg-layer-2,#24272e)',
          'box-shadow:0 8px 28px rgba(0,0,0,.28)',
          'font:500 13px/20px system-ui,-apple-system,"Segoe UI",sans-serif',
          `opacity:0`, `transition:opacity ${FADE_MS}ms ease`,
          'pointer-events:none', 'white-space:nowrap', 'overflow:hidden', 'text-overflow:ellipsis',
        ].join(';')
        document.body.appendChild(toastEl)
      }
      globalThis.clearTimeout(toastTimer)
      globalThis.clearTimeout(toastFade)
      toastEl.textContent = text
      toastEl.style.color = error
        ? 'var(--dsw-alias-state-error-primary,#f06a6a)'
        : 'var(--dsw-alias-label-primary,#e8e8ea)'
      toastEl.style.opacity = '1'
      toastTimer = globalThis.setTimeout(() => {
        if (toastEl !== null) toastEl.style.opacity = '0'
      }, TOAST_MS)
      toastFade = globalThis.setTimeout(clearToast, TOAST_MS + FADE_MS + 40)
    }

    /**
     * Render one preset key for the toast.
     * @param preset - preset key the session switched to.
     * @param t - the namespace's translate seat.
     * @returns the localized built-in label, or the raw key.
     */
    const presetName = (preset, t) => {
      const key = PRESET_LABELS[preset]
      return key === undefined ? preset : t(key)
    }

    /**
     * Resolve the session shown in the main conversation.
     * @param ctx - the plugin context.
     * @returns its live Session face, or undefined when nothing is open.
     */
    const mainSession = (ctx) => {
      const list = ctx.sessions.list.getSnapshot()
      const row = Object.values(list.byId)
        .find(candidate => (candidate.retainedBy?.mainView ?? 0) > 0)
      return row === undefined ? undefined : ctx.sessions.binding(row.id)?.session
    }

    /**
     * Switch the main session to one preset through the ungated write path.
     * @param ctx - the plugin context.
     * @param session - its live Session face.
     * @param preset - preset key to write.
     */
    const switchTo = async (ctx, session, preset) => {
      const result = await session.command(`/permission ${preset}`)
      if (!result.ok) throw new Error(result.error.message)
      if (!result.value.matched) throw new Error(ctx.locale.bind(NS)('no-command'))
    }

    /**
     * Flip the main session between Full access and its previous preset.
     * @param ctx - the plugin context.
     */
    const toggle = async (ctx) => {
      const t = ctx.locale.bind(NS)
      if (busy) return
      busy = true
      try {
        const session = mainSession(ctx)
        if (session === undefined) {
          notify(t('no-session'), true)
          return
        }
        const selection = session.projections.faceOf('permissions').getSnapshot()
        if (selection === undefined) {
          notify(t('no-permission'), true)
          return
        }
        const current = selection.currentValue
        const remembered = restore.get(session.sessionId)
        const target = current === FULL_PRESET
          ? (remembered === undefined || DERIVED_PRESETS.has(remembered) ? DEFAULT_PRESET : remembered)
          : FULL_PRESET
        // Remember what we left only once the switch lands, so a failed
        // command cannot poison the next toggle.
        await switchTo(ctx, session, target)
        if (target === FULL_PRESET) {
          restore.set(session.sessionId, DERIVED_PRESETS.has(current) ? DEFAULT_PRESET : current)
        }
        notify(t('switched', { name: presetName(target, t) }))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        notify(t('failed', { message }), true)
        console.warn('[dsh-permission-toggle] switch failed:', error)
      } finally {
        busy = false
      }
    }

    /**
     * Test one physical gesture for the toggle.
     * @param input - fixed-input notification from the shortcuts adapter.
     * @returns whether this input is a bare Tab inside the open composer.
     */
    const isToggleGesture = (input) => {
      if (input.type !== 'keydown') return false
      const { gesture, context } = input
      if (gesture.code !== 'Tab' || gesture.control || gesture.alt || gesture.shift || gesture.meta) return false
      if (gesture.composing || gesture.repeat || gesture.defaultPrevented) return false
      // Dialogs, menus, and the shortcut recorder own their own Tab.
      if (context.modal !== null) return false
      const target = context.target
      return target instanceof Element && target.closest(COMPOSER) !== null
    }

    return {
      inject: ['shortcuts', 'sessions', 'locale'],
      apply(ctx) {
        const t = ctx.locale.bind(NS)
        ctx.effect(() => ctx.locale.register(NS, LOCALES), 'dsh-permission-toggle: locales')

        // The reference panel's read-only row. It also reserves Tab against
        // every editable command, so nothing else can claim the key.
        ctx.effect(() => ctx.shortcuts.registerFixed({
          id: 'permission.toggle',
          label: () => t('label'),
          keys: [t('key.tab')],
          bindings: [{ code: 'Tab', modifiers: [] }],
          group: 'application',
        }), 'dsh-permission-toggle: shortcut row')

        ctx.effect(() => ctx.shortcuts.observeFixedInput((input) => {
          if (!isToggleGesture(input)) return
          // Consuming first stops the browser's focus move and keeps the
          // gesture out of the editable command dispatch.
          input.consume()
          void toggle(ctx)
        }), 'dsh-permission-toggle: Tab listener')

        document.documentElement.setAttribute(MARKER, '')
        ctx.effect(() => () => {
          document.documentElement.removeAttribute(MARKER)
          restore.clear()
          clearToast()
        }, 'dsh-permission-toggle: page marker')
      },
    }
  },
})
