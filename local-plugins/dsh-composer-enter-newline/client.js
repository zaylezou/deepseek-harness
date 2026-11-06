/**
 * Browser half: rebind the conversation composer's Enter gestures.
 *
 * Stock behavior (the ui-conversation composer keymap): Enter sends,
 * Shift+Enter breaks the line, and Ctrl/Cmd+Enter sends with the accelerated
 * (opposite busy-mode) gesture. That keymap is package-internal, so this plugin
 * owns the same physical keys one layer above it: a capture-phase keydown
 * listener on the document rewrites the gesture before the editor sees it.
 *
 *   Enter                                  -> insert a line break
 *   Ctrl+Enter / Cmd+Enter                 -> send, exactly as plain Enter did
 *   Shift+Enter                            -> untouched (native line break)
 *   Enter while a trigger menu has a highlight -> untouched (the menu picks)
 *   Enter during IME composition           -> untouched
 *
 * The new line break goes through the editor's own INSERT_LINE_BREAK_COMMAND,
 * the same command Shift+Enter ends up at, because a synthetic keydown has no
 * browser default on engines that insert through beforeinput (Safari). The
 * send gesture is a synthetic plain Enter so the composer's submit path,
 * busy-mode preference, upload gate, and toasts all behave exactly as before.
 *
 * Selectors are the composer's own stable data attributes:
 *   [data-composer-input]   the contenteditable host (ComposerContentEditable)
 *   [data-composer-card]    the bar card that anchors the overlay menus
 *   [data-composer-overlay] the trigger/suggestion menu anchor
 *   [role="listbox"][aria-activedescendant] only present with a highlight
 */
window.__ModuleLoader__.load({
  id: 'dsh-composer-enter-newline',
  factory: () => {
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

    /** Synthetic keydowns this plugin dispatched; never remap them again. */
    const own = new WeakSet()
    let composingComposer = null
    let composingUntil = 0

    const composerOf = node => (node instanceof Element ? node.closest(COMPOSER) : null)

    const compositionActive = composer =>
      composer !== null && composer === composingComposer && Date.now() < composingUntil

    /**
     * Whether Enter currently belongs to a highlighted trigger menu.
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

    /** Capture-phase keydown: rewrite the two Enter send/break gestures. */
    const onKeyDown = (event) => {
      if (own.has(event)) return
      if (event.defaultPrevented) return
      if (event.key !== 'Enter') return
      // IME candidate pick: never submit and never break the line.
      if (event.isComposing || event.keyCode === 229) return
      // Alt / AltGr combinations keep their stock behavior.
      if (event.altKey || event.getModifierState('AltGraph')) return
      const composer = composerOf(event.target)
      if (composer === null || !composer.isContentEditable) return
      if (compositionActive(composer)) return
      const control = event.ctrlKey
      const meta = event.metaKey
      if (control && meta) return
      // Shift+Enter already breaks the line; Shift+Ctrl/Cmd+Enter stays stock.
      if (event.shiftKey) return
      if (!control && !meta) {
        // A highlighted menu row owns this Enter: let the composer pick it.
        if (hasHighlightedMenu(composer)) return
        event.preventDefault()
        event.stopImmediatePropagation()
        breakLine(composer, event)
        return
      }
      event.preventDefault()
      event.stopImmediatePropagation()
      // A held chord must not machine-gun sends.
      if (event.repeat) return
      // Plain Enter is the composer's send gesture (the Send button shares it),
      // so Ctrl/Cmd+Enter now means exactly "Send".
      dispatchEnter(composer, event, { ctrlKey: false, metaKey: false, shiftKey: false })
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

    /** Marks the page while the remap is installed (handy for diagnostics). */
    const MARKER = 'data-dsh-composer-enter-newline'

    /** Attach the document-level listeners; returns their disposer. */
    const install = () => {
      document.addEventListener('keydown', onKeyDown, true)
      document.addEventListener('compositionstart', onCompositionStart, true)
      document.addEventListener('compositionend', onCompositionEnd, true)
      document.documentElement.setAttribute(MARKER, '')
      return () => {
        document.removeEventListener('keydown', onKeyDown, true)
        document.removeEventListener('compositionstart', onCompositionStart, true)
        document.removeEventListener('compositionend', onCompositionEnd, true)
        document.documentElement.removeAttribute(MARKER)
        composingComposer = null
        composingUntil = 0
      }
    }

    return {
      apply(ctx) {
        ctx.effect(install, 'dsh-composer-enter-newline: composer key remap')
      },
    }
  },
})
