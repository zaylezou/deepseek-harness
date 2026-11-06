/**
 * Browser half: the landscape rail, plus a direct-reply affordance for both
 * orientations. Written in the client-module bundle format the shared tsdown
 * preset emits, so this package needs no build step.
 *
 * Background: the question card and the conversation input bar are two entries
 * of the same `conversation.composer` chain. While a question is pending the
 * card is elected and the chain hides the fallback input bar with
 * `display: none` (the fallback stays mounted, drafts intact). The card also
 * takes the whole composer floor.
 *
 * This plugin adds presentation only:
 *  1. Landscape: the card docks to a right rail that fills the conversation
 *     body's height, and the fallback input returns to the bottom-left.
 *  2. A `回复` button in the card footer (beside Skip) that collapses the card
 *     and focuses the reply bar.
 *  3. Portrait: a swipe down on the card header does the same, collapsing the
 *     card into a strip above the reply bar; swiping up on the strip expands
 *     the card again.
 *
 * The rail is gated by the RUNTIME orientation, not `@media (orientation)`:
 * on a portrait phone the soft keyboard shrinks the layout viewport below its
 * width, and a viewport-aspect media query then flips to "landscape" while the
 * device is still held upright. `screen.orientation` keeps reporting the real
 * device orientation, so the reply layout stays the portrait one.
 *
 * The reply bar is the ordinary composer: what it sends is a normal
 * message/steering, not the answer, which still goes through the card.
 */
window.__ModuleLoader__.load({
  id: 'dsh-question-landscape',
  factory: () => {
    const css = String.raw`
/* Landscape rail: only while the runtime marks the conversation as a
   landscape device (see installLayout; the keyboard never sets this). */
[data-conversation-content][data-conversation-region][data-dsh-question-landscape]:has([data-question-key]) {
  --dsh-question-rail: min(46vw, 560px);
}

/* The card leaves the composer seat's box. The seat carries
   will-change: transform in the active phase, which would make it the
   containing block for the card's fixed positioning; drop the hint so the
   card anchors to the viewport. */
[data-conversation-content][data-conversation-region][data-dsh-question-landscape]:has([data-question-key]) [data-composer-seat] {
  will-change: auto !important;
}

/* The chain hides the fallback composer (the ordinary input bar) while the
   card is elected. Put it back: it stays mounted, so drafts survive, and it
   becomes the floor of the left column again. */
[data-conversation-content][data-conversation-region][data-dsh-question-landscape]:has([data-question-key]) [data-chain-overlay-fallback="conversation.composer"] {
  display: contents !important;
}

/* Reserve the rail's width for the card; the conversation and the input bar
   reflow into the left column. */
[data-conversation-content][data-conversation-region][data-dsh-question-landscape]:has([data-question-key]) [data-conversation-scroll] {
  padding-right: calc(var(--dsh-question-rail) + 8px);
}

/* The card itself: a floating panel on the viewport's right floor. */
[data-conversation-content][data-conversation-region][data-dsh-question-landscape]:has([data-question-key]) [data-question-key] {
  position: fixed;
  top: auto;
  right: 8px;
  bottom: 8px;
  left: auto;
  width: var(--dsh-question-rail);
  max-width: var(--dsh-question-rail);
  padding: 0 6px 10px;
  z-index: 40;
}

/* With top and bottom both set, the frame has a definite height and the
   section stretches to it; the card body scrolls when the batch outgrows
   the rail, and the footer stays on the card's floor. */
[data-conversation-content][data-conversation-region][data-dsh-question-landscape]:has([data-question-key]) [data-question-key] > section {
  max-width: 100%;
  max-height: none;
}

/* Portrait direct reply: the collapsed card becomes a strip above the
   ordinary composer. The reply button / swipe sets the attribute; expanding
   the card clears it. The :not() keeps the landscape rail layout authoritative
   when the device is actually horizontal. */
[data-conversation-content][data-conversation-region][data-dsh-question-reply]:not([data-dsh-question-landscape]) [data-chain-overlay-fallback="conversation.composer"] {
  display: contents !important;
}

[data-conversation-content][data-conversation-region][data-dsh-question-reply]:not([data-dsh-question-landscape]) [data-question-key] {
  order: -1;
}


`

    /**
     * Presentation for one pending question card: the landscape rail height,
     * the reply button in the footer, the portrait swipe, and the reply mode.
     */
    const installLayout = (ctx) => {
      let frame = 0
      let bypassPrimary = false
      let seat
      let seatObserver
      let boundScroll
      let scrollAbort
      let observedContent
      let contentObserver

      const cardOf = () => document.querySelector('[data-composer-seat] [data-question-key]')
      const contentOf = (card) => card.closest('[data-conversation-content]')
      const chevronOf = (card) => card.querySelector('header button[aria-expanded]')
      const isMinimized = (card) => chevronOf(card)?.getAttribute('aria-expanded') === 'false'
      const editorOf = () => document.querySelector(
        '[data-composer-seat] [data-composer-input="true"], [data-composer-seat] [contenteditable="true"]',
      )
      const primaryButton = () => document.querySelector('[data-composer-seat] button[class*="_primary"]')
      const hasDraft = () => {
        const editor = editorOf()
        return editor instanceof HTMLElement && (editor.textContent ?? '').trim() !== ''
      }
      const isStopLabel = (label) => /stop|停止|中止/i.test(label)

      /** Real device orientation; the viewport aspect flips under a soft keyboard. */
      const deviceIsLandscape = () => {
        const orientation = window.screen?.orientation
        if (orientation !== undefined && typeof orientation.type === 'string') {
          return orientation.type.startsWith('landscape')
        }
        return window.innerWidth > window.innerHeight
      }

      /** The rail also needs a wide conversation body. A right-side app panel
       *  (Start, workspace, ...) narrows the body while the device and viewport
       *  stay horizontal; below this width the side-by-side layout stops being
       *  readable and the portrait layout is the honest one. */
      const RAIL_MIN_CONTENT = 900
      const railFor = (content) => deviceIsLandscape()
        && content.getBoundingClientRect().width >= RAIL_MIN_CONTENT
        && (window.matchMedia('(pointer: coarse)').matches || window.innerHeight <= 900)

      /** Publish the rail decision on every conversation body the CSS reads. */
      const applyOrientation = () => {
        for (const content of document.querySelectorAll('[data-conversation-content][data-conversation-region]')) {
          content.toggleAttribute('data-dsh-question-landscape', railFor(content))
        }
      }

      /** Clear reply mode on every conversation body (the card may have moved). */
      const clearReplyMode = () => {
        for (const content of document.querySelectorAll('[data-conversation-content][data-dsh-question-reply]')) {
          content.removeAttribute('data-dsh-question-reply')
        }
      }

      /** Rail geometry: the card must live inside the conversation body, not
       *  the viewport. A right-side app panel (Start, workspace, ...) narrows
       *  the body while the viewport stays the same, so both the rail width and
       *  the card's right offset are measured from the body. */
      const syncRail = () => {
        const card = cardOf()
        if (card === null) {
          clearReplyMode()
          return
        }
        const content = contentOf(card)
        if (content === null) return
        if (!content.hasAttribute('data-dsh-question-landscape')) {
          for (const prop of ['top', 'bottom', 'left', 'width', 'max-width', 'right']) card.style.removeProperty(prop)
          content.style.removeProperty('--dsh-question-rail')
          return
        }
        const rect = content.getBoundingClientRect()
        const width = Math.max(280, Math.min(560, Math.round(rect.width * 0.46)))
        content.style.setProperty('--dsh-question-rail', `${width}px`)
        card.style.width = `${width}px`
        card.style.maxWidth = `${width}px`
        card.style.right = `${Math.round(window.innerWidth - rect.right + 8)}px`
        card.style.bottom = '8px'
        if (isMinimized(card)) card.style.removeProperty('top')
        else card.style.top = `${Math.round(rect.top + 8)}px`
      }

      /** Collapse the card and reveal the ordinary composer (focus optional). */
      const enterReply = (card, focus = true) => {
        const content = contentOf(card)
        content?.setAttribute('data-dsh-question-reply', '')
        const chevron = chevronOf(card)
        if (chevron !== null && chevron.getAttribute('aria-expanded') === 'true') chevron.click()
        if (!focus) return
        requestAnimationFrame(() => {
          const editor = editorOf()
          if (editor instanceof HTMLElement) {
            editor.focus()
            editor.scrollIntoView({ block: 'nearest' })
          }
          frame = 0
          sync()
        })
      }

      /** Expand the card again and drop reply mode (portrait). */
      const exitReply = (card) => {
        const content = contentOf(card)
        content?.removeAttribute('data-dsh-question-reply')
        const chevron = chevronOf(card)
        if (chevron !== null && chevron.getAttribute('aria-expanded') === 'false') chevron.click()
      }

      /** Inject the reply action beside Skip, once per footer render. Landscape
       *  hides it: there the ordinary composer is already on screen. */
      const ensureReplyButton = (card) => {
        const footer = card.querySelector('footer')
        if (footer === null) return
        const existing = footer.querySelector('[data-dsh-question-reply-button]')
        const rail = contentOf(card)?.hasAttribute('data-dsh-question-landscape') === true
        if (rail) {
          existing?.remove()
          return
        }
        if (existing !== null) return
        const textButtons = [...footer.querySelectorAll('button')]
          .filter(button => (button.textContent ?? '').trim() !== '')
        const skip = textButtons[0]
        if (skip === undefined) return
        const reply = document.createElement('button')
        reply.type = 'button'
        reply.dataset.dshQuestionReplyButton = ''
        reply.className = skip.className
        reply.textContent = /^zh/i.test(document.documentElement.lang || navigator.language) ? '回复' : 'Reply'
        reply.setAttribute('aria-label', reply.textContent)
        reply.addEventListener('click', (event) => {
          event.preventDefault()
          event.stopPropagation()
          enterReply(card)
        })
        skip.parentElement?.insertBefore(reply, skip)
      }

      /** Whether the session is still running (session face, list fallback). */
      const runningOf = (sessionId) => {
        try {
          const binding = ctx.sessions.binding(sessionId)
          const direct = binding?.session?.getSnapshot?.()?.running
          if (typeof direct === 'boolean') return direct
          return ctx.sessions.list.getSnapshot()?.byId?.[sessionId]?.running === true
        } catch {
          return false
        }
      }

      /** Cancel (Stop) the scoped conversation while preserving the draft. */
      const cancelTurn = (sessionId) => {
        try {
          const scope = ctx.sessions.scope(sessionId)
          const conversation = scope?.get('conversation')
          if (conversation !== undefined && typeof conversation.cancel === 'function') {
            return Promise.resolve(conversation.cancel())
          }
          return Promise.reject(new Error('dsh-question-landscape: conversation cancel unavailable'))
        } catch (error) {
          return Promise.reject(error)
        }
      }

      /** After a cancel, wait until the turn really stops, then press Send once. */
      const sendWhenIdle = (sessionId) => {
        let tries = 0
        const waitIdle = () => {
          tries += 1
          if (runningOf(sessionId)) {
            if (tries < 80) setTimeout(waitIdle, 100)
            return
          }
          bypassPrimary = true
          primaryButton()?.click()
          setTimeout(() => { bypassPrimary = false }, 0)
        }
        setTimeout(waitIdle, 80)
      }

      const INTERRUPT_LABEL_ZH = '打断并发送'
      const INTERRUPT_LABEL_EN = 'Interrupt and send'
      const interruptLabel = () => (/^zh/i.test(document.documentElement.lang || navigator.language)
        ? INTERRUPT_LABEL_ZH : INTERRUPT_LABEL_EN)

      /** The special state: pending question card, text in the composer, running
       *  turn, and an enabled primary button — otherwise the button would queue. */
      const interruptState = () => {
        const card = cardOf()
        if (card === null || !hasDraft()) return null
        const content = contentOf(card)
        const sessionId = content?.getAttribute('data-conversation-session')
        if (content === null || sessionId === null || sessionId === '') return null
        if (!runningOf(sessionId)) return null
        const primary = primaryButton()
        if (primary === null || primary.disabled) return null
        return { sessionId, primary }
      }

      /** Cancel the turn, then deliver the draft once the session is idle. A
       *  failed cancel falls back to the ordinary send so the text is not lost. */
      const beginInterrupt = (sessionId) => {
        const fallback = () => {
          bypassPrimary = true
          primaryButton()?.click()
          setTimeout(() => { bypassPrimary = false }, 0)
        }
        try {
          cancelTurn(sessionId).then(() => { sendWhenIdle(sessionId) }, fallback)
        } catch {
          fallback()
        }
      }

      /** Clicking send in the special state interrupts instead of queueing. */
      const interceptSend = (event) => {
        if (bypassPrimary) return
        if (!(event.target instanceof Element)) return
        const button = event.target.closest('button[class*="_primary"]')
        if (button === null) return
        const state = interruptState()
        if (state === null) return
        event.preventDefault()
        event.stopImmediatePropagation()
        beginInterrupt(state.sessionId)
      }

      /** Plain Enter in the composer takes the same interrupt path. Shift,
       *  modifier, and IME Enters keep their native behavior. */
      const interceptEnter = (event) => {
        if (bypassPrimary) return
        if (event.key !== 'Enter' || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return
        if (event.isComposing || event.keyCode === 229) return
        if (!(event.target instanceof Element)) return
        if (event.target.closest('[data-composer-input="true"]') === null) return
        const state = interruptState()
        if (state === null) return
        event.preventDefault()
        event.stopImmediatePropagation()
        beginInterrupt(state.sessionId)
      }

      /** Keep the primary button's cue and tooltip in step with the special state. */
      const syncInterruptState = () => {
        const primary = primaryButton()
        const state = interruptState()
        const label = interruptLabel()

        if (primary !== null) {
          if (state !== null) {
            if (!primary.hasAttribute('data-dsh-interrupt')) {
              primary.dataset.dshOriginalLabel = primary.getAttribute('aria-label') ?? ''
            }
            primary.setAttribute('data-dsh-interrupt', '')
            if (primary.getAttribute('aria-label') !== label) primary.setAttribute('aria-label', label)
          } else if (primary.hasAttribute('data-dsh-interrupt')) {
            const current = primary.getAttribute('aria-label')
            const wasOurs = current === label || current === INTERRUPT_LABEL_ZH || current === INTERRUPT_LABEL_EN
            primary.removeAttribute('data-dsh-interrupt')
            const saved = primary.dataset.dshOriginalLabel ?? ''
            if (wasOurs && saved !== '') primary.setAttribute('aria-label', saved)
            delete primary.dataset.dshOriginalLabel
          }
        }

        // The app builds the tooltip label in React; rewrite the bubble while it
        // describes the primary button, and restore it when the state ends.
        for (const tip of document.querySelectorAll('[role="tooltip"]')) {
          const marked = tip.hasAttribute('data-dsh-interrupt-tooltip')
          if (state === null) {
            if (marked) {
              const original = tip.dataset.dshOriginalTooltip
              const text = tip.firstElementChild
              if (text !== null && original !== undefined) text.textContent = original
              delete tip.dataset.dshOriginalTooltip
              tip.removeAttribute('data-dsh-interrupt-tooltip')
            }
            continue
          }
          const text = tip.firstElementChild
          if (text === null || primary === null) continue
          const btn = primary.getBoundingClientRect()
          const rect = tip.getBoundingClientRect()
          const above = rect.bottom <= btn.top + 4 && rect.bottom >= btn.top - 48
          const below = rect.top >= btn.bottom - 4 && rect.top <= btn.bottom + 48
          const near = (above || below)
            && Math.abs((rect.left + rect.right) / 2 - (btn.left + btn.right) / 2) <= Math.max(btn.width, 48)
          if (!near) continue
          if (text.textContent === label) continue
          if (!marked) {
            tip.dataset.dshInterruptTooltip = ''
            tip.dataset.dshOriginalTooltip = text.textContent ?? ''
          }
          text.textContent = label
        }
      }

      /** The header chevron is a collapse too: in portrait it must land in the
       *  reply layout (strip + composer), never in a bare strip with no input
       *  box. Expanding clears reply mode again. */
      const bindHeaderToggle = (card) => {
        if (card.dataset.dshToggleBound === '') return
        const header = card.querySelector('header')
        if (header === null) return
        card.dataset.dshToggleBound = ''
        header.addEventListener('click', (event) => {
          const toggle = event.target instanceof Element ? event.target.closest('button[aria-expanded]') : null
          if (toggle === null) return
          const content = contentOf(card)
          if (content === null) return
          const rail = content.hasAttribute('data-dsh-question-landscape')
          // aria-expanded is the state BEFORE React applies this toggle.
          if (toggle.getAttribute('aria-expanded') === 'false') {
            content.removeAttribute('data-dsh-question-reply')
          } else if (!rail) {
            content.setAttribute('data-dsh-question-reply', '')
          }
        })
      }

      /**
       * Scrolling the conversation behind the card (touch or wheel) collapses it
       * and reveals the composer. Events starting inside the card belong to its
       * own scrollport and are ignored; landscape keeps the card docked.
       */
      const bindScrollCollapse = () => {
        const scroll = document.querySelector('[data-conversation-scroll]')
        if (scroll === null || scroll === boundScroll) return
        scrollAbort?.abort()
        boundScroll = scroll
        scrollAbort = new AbortController()
        const { signal } = scrollAbort
        const collapse = (event) => {
          if (event.target instanceof Element && event.target.closest('[data-question-key]') !== null) return
          const card = cardOf()
          if (card === null || isMinimized(card)) return
          const content = contentOf(card)
          if (content?.hasAttribute('data-dsh-question-landscape')) return
          enterReply(card, false)
        }
        scroll.addEventListener('wheel', (event) => {
          if (Math.abs(event.deltaY) > 0) collapse(event)
        }, { passive: true, signal })
        let touchStart = null
        scroll.addEventListener('touchstart', (event) => {
          touchStart = event.touches.length === 1 ? event.touches[0].clientY : null
        }, { passive: true, signal })
        scroll.addEventListener('touchmove', (event) => {
          if (touchStart === null || event.touches.length !== 1) return
          const dy = event.touches[0].clientY - touchStart
          if (Math.abs(dy) < 12) return
          touchStart = null
          collapse(event)
        }, { passive: true, signal })
        scroll.addEventListener('touchend', () => { touchStart = null }, { passive: true, signal })
      }

      const observeContent = () => {
        const content = document.querySelector('[data-conversation-content][data-conversation-region]')
        if (content === null || content === observedContent) return
        contentObserver?.disconnect()
        observedContent = content
        contentObserver = new ResizeObserver(schedule)
        contentObserver.observe(content)
      }

      const sync = () => {
        frame = 0
        observeContent()
        applyOrientation()
        const card = cardOf()
        if (card === null) {
          clearReplyMode()
          return
        }
        ensureReplyButton(card)
        bindHeaderToggle(card)
        bindScrollCollapse()
        syncRail()
        syncInterruptState()
      }

      const schedule = () => {
        if (frame !== 0) return
        frame = requestAnimationFrame(sync)
      }

      const bindSeat = () => {
        const next = document.querySelector('[data-composer-seat]')
        if (next === null || next === seat) return
        seatObserver?.disconnect()
        seat = next
        seatObserver = new MutationObserver(schedule)
        seatObserver.observe(seat, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-expanded', 'aria-label'] })
      }

      const bodyObserver = new MutationObserver(schedule)
      bodyObserver.observe(document.body, { childList: true, subtree: true })
      document.addEventListener('input', schedule, { passive: true })
      document.addEventListener('click', interceptSend, true)
      document.addEventListener('keydown', interceptEnter, true)
      window.addEventListener('resize', schedule)
      window.addEventListener('orientationchange', schedule)
      window.screen?.orientation?.addEventListener?.('change', schedule)
      bindSeat()
      applyOrientation()
      schedule()

      return () => {
        if (frame !== 0) cancelAnimationFrame(frame)
        bodyObserver.disconnect()
        seatObserver?.disconnect()
        scrollAbort?.abort()
        contentObserver?.disconnect()
        document.removeEventListener('input', schedule)
        document.removeEventListener('click', interceptSend, true)
        document.removeEventListener('keydown', interceptEnter, true)
        window.removeEventListener('resize', schedule)
        window.removeEventListener('orientationchange', schedule)
        window.screen?.orientation?.removeEventListener?.('change', schedule)
        clearReplyMode()
        for (const card of document.querySelectorAll('[data-question-key]')) {
          card.style.removeProperty('top')
          card.style.removeProperty('bottom')
        }
        for (const content of document.querySelectorAll('[data-dsh-question-landscape]')) {
          content.removeAttribute('data-dsh-question-landscape')
        }
      }
    }

    return {
      inject: ['sessions'],
      apply(ctx) {
        ctx.effect(() => {
          const tag = document.createElement('style')
          tag.dataset.plugin = 'dsh-question-landscape'
          tag.dataset.pluginCss = 'dsh-question-landscape/landscape.css'
          tag.textContent = css
          document.head.appendChild(tag)
          return () => { tag.remove() }
        }, 'dsh-question-landscape: landscape stylesheet')
        ctx.effect(() => installLayout(ctx), 'dsh-question-landscape: layout and reply affordance')
      },
    }
  },
})
