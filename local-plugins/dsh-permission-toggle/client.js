/**
 * Browser half: the composer's permission control, minus the risk gate.
 *
 * Two things this plugin owns:
 *
 *  1. The composer chip itself (a shadow registration of the
 *     `conversation.input.permission` slot). The stock chip routes a
 *     Full-access pick through `RiskConfirmation` — an acknowledgment
 *     checkbox plus an Enable button. That gate lives only in the component;
 *     the write path (`/permission <preset>` on the session) appends the two
 *     knob events and the `permissions` projection pushes the new value back
 *     into the chip. This chip calls the write path directly, so every manual
 *     pick lands immediately. It renders the same trigger, menu, glyphs, and
 *     copy as the stock control.
 *
 *  2. A fixed shortcut action that cycles the current session through the
 *     advertised presets in catalog order (read-only → workspace-write →
 *     full access → read-only by default). It is registered as a FIXED action
 *     rather than an editable one because the core reserves Tab:
 *     `bindingIssue` reports `modifier-required` for a bare Tab and `reserved`
 *     for every modified Tab, and the Web runtime additionally rejects it
 *     through `isWebBindingAllowed`. The fixed row shows up in the reference
 *     panel, reserves the combination against editable commands, and has no
 *     edit affordance.
 *
 *  3. Two extra actions on the tool-approval card ("switch to full access and
 *     allow", "switch to auto review"). The card is a factory slot the core
 *     panel renders; a factory has exactly one definition, so this shadows the
 *     `conversation.composer` CHAIN above the stock panel (priority 0.5 vs 1),
 *     renders the stock card through `renderFactorySlot` (keeping its keyboard,
 *     detail, and busy state) and portals the two buttons into the card's own
 *     action row.
 *
 * Scope: Tab only fires while the caret is inside the composer card
 * (`[data-composer-card]`) and no dialog is open. Everywhere else — page,
 * sidebar, terminal, forms — Tab keeps its native focus movement, and
 * Shift+Tab still moves focus backwards out of the composer. A globally
 * swallowed Tab would make the whole app unusable from the keyboard.
 */
window.__ModuleLoader__.load({
  id: 'dsh-permission-toggle',
  factory: (require) => {
    const React = require('react')
    const { createPortal } = require('react-dom')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    const {
      Button, Menu, IconChevronDownOutlineRegular,
      PermissionIconReadOnlyRegular, PermissionIconWorkspaceWriteRegular,
      PermissionIconFullAccessRegular, PermissionIconAutoReviewRegular,
    } = primitives
    const h = React.createElement

    /** Locale namespace owned by this plugin; also the chip's translate seat. */
    const NS = 'permission-toggle'
    /** Preset keys used when the process catalog has not arrived yet. */
    const DEFAULT_CYCLE = ['read-only', 'workspace-write', 'danger-full-access']
    /** Full-access preset key (the same literal the stock chip writes). */
    const FULL_PRESET = 'danger-full-access'
    /** Experimental auto-review preset key. */
    const AUTO_PRESET = 'auto'
    /** Catalog fallback so the chip never blanks out while a catalog read is failing. */
    const FALLBACK_OPTIONS = DEFAULT_CYCLE.map(value => ({ value, name: value }))
    /** The composer capsule: the one region that owns Tab. */
    const COMPOSER = '[data-composer-card]'
    /** Marks the page while the toggle is installed (handy for diagnostics). */
    const MARKER = 'data-dsh-permission-toggle'
    /** Owns this plugin's injected stylesheet. */
    const STYLE_ATTR = 'data-dsh-permission-toggle-css'
    /** Visible toast lifetime before it fades; the node leaves after the transition. */
    const TOAST_MS = 1600
    /** Fade duration, matching the inline transition below. */
    const FADE_MS = 180

    /** One glyph per built-in preset, following currentColor. */
    const GLYPHS = {
      'read-only': PermissionIconReadOnlyRegular,
      'workspace-write': PermissionIconWorkspaceWriteRegular,
      'danger-full-access': PermissionIconFullAccessRegular,
      'auto': PermissionIconAutoReviewRegular,
    }

    /** Built-in preset label keys; host-configured names outside this set keep their own text. */
    const LABEL_KEYS = {
      'read-only': 'preset.read-only',
      'workspace-write': 'preset.workspace-write',
      'danger-full-access': 'preset.full-access',
      'auto': 'auto.label',
    }

    /** Baseline dictionaries: the locale service requires zh and en. */
    const LOCALES = {
      zh: {
        'label': '切换权限模式',
        'key.tab': 'Tab',
        'mode': '访问模式，当前：{name}',
        'preset.read-only': '仅可查看',
        'preset.workspace-write': '工作区内修改',
        'preset.full-access': '完全权限',
        'auto.label': '自动审查',
        'auto.badge': 'EXP',
        'switched': '权限模式：{name}',
        'no-session': '没有打开的会话',
        'no-permission': '这个会话没有权限切换入口',
        'no-command': '宿主没有提供 /permission 命令',
        'failed': '切换失败：{message}',
        'approval.escalation': '工具 {toolName} 请求越权执行',
        'approval.full': '切换为完全权限并同意',
        'approval.auto': '切换为自动审批',
      },
      en: {
        'label': 'Toggle permission mode',
        'key.tab': 'Tab',
        'mode': 'Access mode, current: {name}',
        'preset.read-only': 'Read only',
        'preset.workspace-write': 'Workspace write',
        'preset.full-access': 'Full access',
        'auto.label': 'Auto review',
        'auto.badge': 'EXP',
        'switched': 'Permission mode: {name}',
        'no-session': 'No open session',
        'no-permission': 'This session has no permission control',
        'no-command': 'The host offers no /permission command',
        'failed': 'Switch failed: {message}',
        'approval.escalation': 'The tool {toolName} asks to run with wider access',
        'approval.full': 'Switch to full access and allow',
        'approval.auto': 'Switch to auto review',
      },
    }

    /** Chip chrome copied from the stock control so the shadow is indistinguishable. */
    const CSS = String.raw`
.dsh-pt-trigger{display:inline-flex;align-items:center;gap:4px;min-width:0;max-width:220px;height:28px;padding:0 4px 0 8px;border:none;border-radius:var(--dsw-radius-sm);outline:none;background:transparent;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;font-weight:500;cursor:pointer}
@media (hover:hover){.dsh-pt-trigger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}}
.dsh-pt-trigger:focus-visible{box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))}
.dsh-pt-trigger:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}
.dsh-pt-icon{display:inline-flex;flex:0 0 auto}
.dsh-pt-icon svg{width:14px;height:14px}
.dsh-pt-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-pt-chevron{display:inline-flex;flex:0 0 auto;color:var(--dsw-alias-label-caption);transition:transform 120ms ease}
.dsh-pt-chevron-open{transform:rotate(180deg)}
.dsh-pt-option{display:inline-flex;align-items:center;gap:4px;min-width:0;max-width:100%}
.dsh-pt-option-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-pt-badge{flex:none;color:var(--dsw-alias-label-tertiary);font-size:8px;line-height:10px;font-weight:500;letter-spacing:.2px}
@container (max-width:460px){.dsh-pt-trigger:has(.dsh-pt-icon) .dsh-pt-label{display:none}}
.dsh-pt-extra{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px;padding:0 16px 14px}
/* The stock action row does not wrap; with four buttons a phone squeezes the
   labels into vertical stacks and the row runs past the card edge. Marking the
   row from the component (not :has) keeps this working on older WebViews. */
[data-dsh-pt-row]{flex-wrap:wrap}
.dsh-pt-action{white-space:nowrap}
`

    /** Toast node and its timers, shared by every feedback path. */
    let toastEl = null
    let toastTimer = 0
    let toastFade = 0
    /** One Tab-driven cycle at a time. */
    let busy = false

    /** Remove the toast node and both of its timers. */
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
          'opacity:0', `transition:opacity ${FADE_MS}ms ease`,
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

    /** Kebab-case a preset key the way the stock control labels unknown presets. */
    const displayName = (name) => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)
      ? name.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ')
      : name

    /**
     * Render one preset key.
     * @param value - preset machine value.
     * @param t - the namespace's translate seat.
     * @param name - host-supplied label, when one was advertised.
     * @returns the built-in label, the host label, or the title-cased key.
     */
    const labelOf = (value, t, name) => {
      const key = LABEL_KEYS[value]
      return key === undefined ? displayName(name ?? value) : t(key)
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
     * Switch one session through the ungated write path.
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
     * Cycle the main session through the advertised presets.
     * @param ctx - the plugin context.
     * @param catalog - the process catalog shared with the chip.
     */
    const cycle = async (ctx, catalog) => {
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
        const advertised = catalog.values()
        const order = advertised.length > 0 ? advertised : DEFAULT_CYCLE
        const index = order.indexOf(selection.currentValue)
        const next = order[(index + 1) % order.length]
        await switchTo(ctx, session, next)
        const option = catalog.getSnapshot()?.options.find(candidate => candidate.value === next)
        notify(t('switched', { name: labelOf(next, t, option?.name) }))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        notify(t('failed', { message }), true)
        console.warn('[dsh-permission-toggle] switch failed:', error)
      } finally {
        busy = false
      }
    }

    /**
     * Test one physical gesture for the Tab shortcut.
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

    /**
     * Process permission catalog: one lazy read plus the invalidation event.
     * @param ctx - the plugin context.
     * @returns a tiny snapshot store the chip subscribes to.
     */
    const createCatalog = (ctx) => {
      const listeners = new Set()
      let value = null
      const publish = () => { for (const listener of [...listeners]) listener() }
      return {
        subscribe: (listener) => {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
        getSnapshot: () => value,
        /** Re-read the catalog; a host without the permission plugin keeps the last value. */
        load: async () => {
          try {
            const remote = ctx.remote?.permissionPresets
            if (remote === undefined) return
            const result = await remote.catalog()
            if (!result.ok) return
            value = result.value
            publish()
          } catch (error) {
            console.warn('[dsh-permission-toggle] catalog read failed:', error)
          }
        },
        /** Preset keys the cycle walks, in catalog order (live contributions included). */
        values: () => (value?.options ?? []).map(option => option.value),
      }
    }

    return {
      // `remote.permissionPresets` is the Typert gate behind `ctx.remote.permissionPresets`:
      // without it declared, the catalog read is refused and the chip has nothing to show.
      inject: ['slots', 'shortcuts', 'sessions', 'locale', 'remote', 'remote.permissionPresets'],
      apply(ctx) {
        const t = ctx.locale.bind(NS)
        ctx.effect(() => ctx.locale.register(NS, LOCALES), 'dsh-permission-toggle: locales')

        const catalog = createCatalog(ctx)
        ctx.effect(() => {
          const off = ctx.remote.$on('permission-presets/catalog-changed', () => { void catalog.load() })
          void catalog.load()
          return off
        }, 'dsh-permission-toggle: catalog')

        ctx.effect(() => {
          const style = document.createElement('style')
          style.setAttribute(STYLE_ATTR, '')
          style.textContent = CSS
          document.head.appendChild(style)
          return () => { style.remove() }
        }, 'dsh-permission-toggle: styles')

        /**
         * The stock composer chip without the risk gate: same trigger, same menu,
         * same copy; a pick writes `/permission <id>` directly.
         * @param props - slot props: owner `locked` plus the session standard kit.
         * @returns the chip, or null while the capability or catalog is absent.
         */
        const PermissionChip = (props) => {
          const selection = props.useProjection('permissions')
          const live = React.useSyncExternalStore(catalog.subscribe, catalog.getSnapshot)
          const [open, setOpen] = React.useState(false)
          const [committing, setCommitting] = React.useState(false)
          React.useEffect(() => { void catalog.load() }, [])
          React.useEffect(() => {
            if (props.locked) setOpen(false)
          }, [props.locked])
          if (selection === undefined) return null
          const currentValue = selection.currentValue
          const options = live?.options ?? FALLBACK_OPTIONS
          const current = options.find(option => option.value === currentValue)
          const currentLabel = labelOf(currentValue, t, current?.name)
          const items = options.map((option) => {
            const name = labelOf(option.value, t, option.name)
            const badge = option.value === 'auto' ? t('auto.badge') : undefined
            const Glyph = GLYPHS[option.value]
            return {
              id: option.value,
              label: badge === undefined
                ? name
                : h('span', { className: 'dsh-pt-option', 'aria-label': `${name} ${badge}` },
                  h('span', { className: 'dsh-pt-option-text' }, name),
                  h('span', { className: 'dsh-pt-badge' }, badge)),
              ...(Glyph === undefined ? {} : { icon: h(Glyph) }),
            }
          })
          const choose = (id) => {
            setOpen(false)
            if (id === currentValue) return
            setCommitting(true)
            const session = ctx.sessions.binding(props.sessionId)?.session
            const operation = session === undefined
              ? Promise.reject(new Error(t('no-session')))
              : switchTo(ctx, session, id)
            void operation
              .catch((error) => {
                const message = error instanceof Error ? error.message : String(error)
                notify(t('failed', { message }), true)
                console.warn('[dsh-permission-toggle] switch failed:', error)
              })
              .finally(() => { setCommitting(false) })
          }
          const Glyph = GLYPHS[currentValue]
          return h(Menu, {
            open,
            items,
            selectedId: currentValue,
            onSelect: choose,
            onClose: () => { setOpen(false) },
            side: 'top',
            portal: true,
            anchor: h('button', {
              type: 'button',
              className: 'dsh-pt-trigger',
              'aria-label': t('mode', { name: currentLabel }),
              title: current?.description,
              disabled: props.locked || committing,
              onClick: () => { setOpen(value => !value) },
            },
            Glyph === undefined ? null : h('span', { className: 'dsh-pt-icon', 'aria-hidden': true }, h(Glyph)),
            h('span', { className: 'dsh-pt-label' }, currentLabel),
            h('span', { className: open ? 'dsh-pt-chevron dsh-pt-chevron-open' : 'dsh-pt-chevron', 'aria-hidden': true },
              h(IconChevronDownOutlineRegular)),
            ),
          })
        }


        /**
         * The stock approval card with two policy shortcuts beside its own
         * decisions. The card stays the core's: this chain entry renders it
         * through `renderFactorySlot` (keeping the correlated tool detail, the
         * Enter/Escape handling, and the answered state) and portals the two
         * extra buttons into the card's own action row.
         * @param props - chain props: owner interaction, matched approval, factories.
         * @returns the composer takeover for a pending approval.
         */
        const ApprovalActions = (props) => {
          const approval = props.matched
          const wrap = React.useRef(null)
          const [row, setRow] = React.useState(undefined)
          const [pending, setPending] = React.useState(null)
          const alive = React.useRef(true)
          React.useEffect(() => () => { alive.current = false }, [])
          // The card belongs to the core factory; its decision row is the one
          // element carrying the module's readable `actionRow` class suffix.
          React.useLayoutEffect(() => {
            const next = wrap.current === null ? null : wrap.current.querySelector('[class*="actionRow"]')
            // The stock row must wrap once four buttons share it; the marker
            // keeps that rule out of every other approval card.
            next?.setAttribute('data-dsh-pt-row', '')
            setRow(current => (current === next ? current : next))
          })
          const act = (preset) => {
            if (pending !== null || !approval.answerable) return
            setPending(preset)
            void (async () => {
              const session = ctx.sessions.binding(props.sessionId)?.session
              if (session === undefined) throw new Error(t('no-session'))
              // Policy first: the request is only allowed once the wider mode
              // is actually in force, so a failed switch leaves the card open.
              await switchTo(ctx, session, preset)
              await approval.answer('allowed-once')
            })().catch((error) => {
              const message = error instanceof Error ? error.message : String(error)
              notify(t('failed', { message }), true)
              console.warn('[dsh-permission-toggle] approval shortcut failed:', error)
            }).finally(() => {
              if (alive.current) setPending(null)
            })
          }
          const disabled = pending !== null || !approval.answerable
          const buttons = [
            h(Button, {
              key: 'full', variant: 'outline', className: 'dsh-pt-action', disabled,
              onClick: () => { act(FULL_PRESET) },
            }, t('approval.full')),
            h(Button, {
              key: 'auto', variant: 'outline', className: 'dsh-pt-action', disabled,
              onClick: () => { act(AUTO_PRESET) },
            }, t('approval.auto')),
          ]
          const reason = approval.displayReason === undefined
            ? approval.reason
            : ctx.locale.resolveText(approval.displayReason)
          return h('div', { ref: wrap },
            props.renderFactorySlot('conversation.approval.card', {
              requestKey: approval.key,
              title: reason ?? t('approval.escalation', { toolName: approval.toolName }),
              ...(approval.callId === undefined ? {} : { callId: approval.callId }),
              canAnswer: () => approval.answerable,
              onAllow: () => approval.answer('allowed-once'),
              onReject: () => approval.answer('rejected'),
            }),
            row === undefined ? null
              : row === null ? h('div', { className: 'dsh-pt-extra' }, buttons)
                : createPortal(buttons, row, 'permission-toggle-actions'),
          )
        }

        // Same cell as the stock control, one rank lower: the lowest priority renders.
        ctx.slots.inject('conversation.input.permission', () => ctx.slots.register({
          name: 'conversation.input.permission',
          priority: -1,
          locale: NS,
        }, PermissionChip))

        // Above the stock approval panel (chain priority 1). The selector only
        // matches a pending approval, so question cards and subagent takeovers
        // keep their own entries.
        ctx.slots.inject('conversation.composer', () => ctx.slots.register({
          name: 'conversation.composer',
          id: 'permission-toggle.approval',
          priority: 0.5,
          select: ({ pendingInteraction }) => pendingInteraction?.kind === 'approval' ? pendingInteraction : null,
          locale: NS,
        }, ApprovalActions))

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
          void cycle(ctx, catalog)
        }), 'dsh-permission-toggle: Tab listener')

        document.documentElement.setAttribute(MARKER, '')
        ctx.effect(() => () => {
          document.documentElement.removeAttribute(MARKER)
          clearToast()
        }, 'dsh-permission-toggle: page marker')
      },
    }
  },
})
