/**
 * Browser half: VS Code "Quiet Light" for fenced code blocks.
 *
 * ui-theme owns the syntax palette: `shiki.css` publishes one
 * `--shiki-token-*` custom property per shiki css-variables slot, and the
 * highlighter (ui-primitives `highlight.ts`) emits `color: var(--shiki-…)`
 * inline on every token span. That indirection is the seam this package uses:
 * one stylesheet that re-declares the light values, with no change to the
 * theme package, the highlighter, or any component.
 *
 * Selector: `html:root` instead of `:root`. Both target the same element, so
 * the injected sheet wins on specificity (one pseudo-class more) rather than
 * on injection order — the module graph does not promise this package loads
 * after ui-theme, and a rejected palette would be silent. Dark mode needs no
 * counterpart here: ui-theme's `body[data-ds-dark-theme]` declares those
 * properties on `body`, and a declaration always beats the value inherited
 * from `html`, whatever the specificity.
 *
 * The colors are the official extensions/theme-quietlight token colors:
 * keywords/storage #4B69C6, strings #448C27, comments #AAAAAA, variables,
 * types and parameters #7A3E9D, functions and classes #AA3731, punctuation
 * and operators #777777, markup links #4B69C6. shiki's css-variables theme
 * folds `constant.numeric` into the same slot as `variable.*`, so numbers
 * take Quiet Light's variable purple instead of its number brown — variables
 * are by far the more frequent run.
 */
window.__ModuleLoader__.load({
  id: 'dsh-quiet-light',
  factory: () => {
    /** Marks the injected sheet for diagnostics and removal. */
    const STYLE_ATTR = 'data-dsh-quiet-light-css'
    /** Marks the document while the palette is installed (handy in devtools). */
    const MARKER = 'data-dsh-quiet-light'

    /** Light-theme token values only; `-foreground`/`-background` stay aliased. */
    const CSS = `html:root {
  --shiki-token-constant: #7a3e9d;
  --shiki-token-string: #448c27;
  --shiki-token-comment: #aaaaaa;
  --shiki-token-keyword: #4b69c6;
  --shiki-token-parameter: #7a3e9d;
  --shiki-token-function: #aa3731;
  --shiki-token-string-expression: #448c27;
  --shiki-token-punctuation: #777777;
  --shiki-token-link: #4b69c6;
}
`

    return {
      apply(ctx) {
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
        }, 'dsh-quiet-light: syntax palette')
      },
    }
  },
})
