# dsh-quiet-light

VS Code **Quiet Light** for the Web GUI's fenced code blocks, installed as a
plugin instead of editing the theme package.

## Why a plugin works here

ui-theme publishes the syntax palette as custom properties: `shiki.css` declares
one `--shiki-token-*` value per shiki css-variables slot, and the highlighter
emits `color: var(--shiki-token-…)` inline on every token span. Re-declaring
those properties is therefore enough to reskin code — no component, no
highlighter, no theme-package change.

This package injects one `<style>` on load and removes it on unload, so
disabling the row restores ui-theme's stock palette exactly.

## Specificity, not load order

The sheet uses `html:root`, not `:root`. Both match the document element, so the
extra pseudo-class makes this sheet win regardless of whether it is injected
before or after ui-theme's — the module graph does not promise an order, and a
silently losing palette is hard to notice. Dark mode needs no rule here:
ui-theme's `body[data-ds-dark-theme]` sets those properties on `body`, and a
declaration beats the value inherited from `html` at any specificity.

## Palette

Official Quiet Light token colors: keywords/storage `#4B69C6`, strings
`#448C27`, comments `#AAAAAA`, variables, types and parameters `#7A3E9D`,
functions and classes `#AA3731`, punctuation and operators `#777777`, markup
links `#4B69C6`. `--shiki-foreground` / `--shiki-background` are left alone so
highlighted blocks and plain blocks keep sharing the markdown code-block fill.

One mapping cost is inherent: shiki's css-variables theme folds
`constant.numeric` into the same slot as `variable.*`, so numbers take Quiet
Light's variable purple (`#7A3E9D`) instead of its number brown (`#9C5D27`).
Variables are by far the more frequent run; swap that one line in `client.js` if
the brown numbers matter more.

## Install (this profile)

```bash
ln -s /opt/dsh/deepseek-harness/local-plugins/dsh-quiet-light \
  ~/.dsh/profiles/web/node_modules/dsh-quiet-light
```

Record the same `link:` specifier in the profile's `package.json`, and the
bundled `cordis.patch.yml` supplies the plugin row. Nothing is built: `main`
points straight at the source, so an edit takes effect on the next restart.
