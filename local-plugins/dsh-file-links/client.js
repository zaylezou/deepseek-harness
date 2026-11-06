/**
 * Browser half: turn the file references an agent writes in its reply into
 * clickable sidebar navigation.
 *
 * What it is for. A coding agent answers with paths in inline code —
 * `packages/client/ui-chat/src/client/apply.ts:272`, `README.md`, `src/foo.ts`
 * — and the stock renderer links only the files that Turn produced or
 * delivered through the `present` tool (`ui-deliverables`' produced-file
 * vocabulary). Every other path a reply quotes, including the one line the
 * reader actually wants, stays inert text. This plugin makes any file-shaped
 * token clickable and carries its `:line` / `:line:column` / `#Lstart-Lend`
 * suffix through to the preview, so a click lands where the sentence points —
 * the same gesture as clicking a row in the changed-files card.
 *
 * Why `chatFileMentions`. Assistant prose has exactly one extension seam in
 * the Web client: `ctx.get('chatFileMentions').forClosing(owner, sessionId,
 * getFileTriggerProps)` in ui-chat's assistant renderer, consumed by
 * MarkdownText's inline-code vocabulary. It is a single-provider service owned
 * by ui-deliverables, so providing it again would throw and unmount the
 * changed-files card. Instead this plugin *composes* the shipped provider: the
 * wrapper asks ui-deliverables first (its exact/basename resolution of real
 * produced files is more precise than guessing), and only when that declines
 * does it answer with this plugin's path grammar. The wrapper is installed on
 * the service object and restored on disposal.
 *
 * What the click does. `owner.openFile(path, { line })` is Chat's own opener:
 * it resolves the path against the Session's live working directory, opens the
 * Session-scoped file address in the right Sidebar (creating or revealing one
 * tab), and carries `line` as a navigation parameter so the code preview pages
 * to that line and bands it. The sidebar is the product surface for files
 * here; nothing leaves the conversation.
 *
 * The glyph and the label. The renderer draws the icon and the visible text
 * from the authored token, so the chip keeps the exact spelling the agent
 * wrote; this plugin supplies the accessible label, the full-path tooltip, and
 * the ordinary file context menu (copy path, open, ...).
 *
 * What is deliberately left inert: URLs and other URI schemes, glob patterns,
 * directories (trailing separator), `~`-relative paths (the browser cannot
 * expand a home shorthand against the Session's filesystem), template
 * placeholders, command fragments with spaces, and bare tokens that are prose
 * rather than files (`Node.js`, `Vue.js`, ...). Paths inside Markdown links are
 * not this plugin's business: the Markdown delegate already opens those, with
 * the same line support.
 */
window.__ModuleLoader__.load({
  id: 'dsh-file-links',
  factory() {
    /** Locale namespace owned by this plugin. */
    const NS = 'file-links'

    /** Baseline dictionaries: the locale service requires zh and en. */
    const LOCALES = {
      zh: {
        'open': '打开 {path}',
        'openLine': '打开 {path}，定位到第 {line} 行',
      },
      en: {
        'open': 'Open {path}',
        'openLine': 'Open {path} at line {line}',
      },
    }

    /** Longest inline-code token worth parsing; longer spans are prose, not a path. */
    const MAX_TOKEN = 512

    /**
     * Extensions that name a file the preview can show. Curated rather than
     * "anything with a dot": a coding reply is full of dotted identifiers
     * (`ctx.slots.inject`, `v0.2.2-alpha.3`, `192.168.1.1`) that must stay text.
     */
    const EXTENSIONS = new Set((
      // Source and markup
      'ts tsx mts cts js jsx mjs cjs vue svelte astro py pyi rb go rs java kt kts scala sc '
      + 'clj cljs cljc ex exs erl hrl hs lua pl pm r jl dart nim zig v sv svh vhd vhdl asm s '
      + 'c h cc cpp cxx hpp hxx cs fs fsx php swift m mm sql graphql gql proto thrift avsc prisma '
      + 'sh bash zsh fish ps1 psm1 bat cmd '
      // Config and data
      + 'json jsonc json5 jsonl ndjson yml yaml toml ini cfg conf properties env lock mod sum '
      + 'xml xsd xsl dtd plist ipynb csv tsv '
      // Documentation and assets
      + 'md mdx txt log rst adoc org tex patch diff rej map wasm wat '
      // Styles
      + 'css scss sass less styl stylus '
      // Infra and build
      + 'tf tfvars hcl bicep cmake mk ninja bzl bazel gradle proto dockerfile containerfile '
      // Documents and images the preview renders
      + 'html htm xhtml svg png jpg jpeg gif webp bmp ico pdf xls xlsx doc docx ppt pptx'
    ).split(/\s+/))

    /**
     * Extensionless files worth opening by exact name. A prose reply says
     * "the Makefile" or "package.json" without a directory, and the reader
     * still expects a click.
     */
    const NAMES = new Set([
      'Makefile', 'makefile', 'GNUmakefile', 'Dockerfile', 'dockerfile', 'Containerfile',
      'LICENSE', 'LICENCE', 'NOTICE', 'COPYING', 'AUTHORS', 'CHANGELOG', 'CONTRIBUTING',
      'README', 'AGENTS.md', 'CLAUDE.md', 'Procfile', 'Gemfile', 'Rakefile', 'Vagrantfile',
      'Justfile', 'Brewfile', 'CMakeLists.txt',
    ])

    /**
     * Bare dotted names that are libraries or products in prose, not files in
     * this workspace (`Node.js`, `Next.js`, ...). Only consulted for tokens
     * with no separator: `docs/next.js` is still a file.
     */
    const PROSE_NAMES = new Set([
      'node.js', 'next.js', 'nuxt.js', 'vue.js', 'react.js', 'angular.js', 'ember.js',
      'backbone.js', 'express.js', 'three.js', 'd3.js', 'p5.js', 'chart.js', 'pixi.js',
      'matter.js', 'socket.io', 'moment.js', 'underscore.js', 'alpine.js', 'solid.js',
      'tailwind.js', 'vite.js', 'webpack.js', 'rollup.js', 'esbuild.js',
    ])

    /**
     * Split one authored token into a path and an optional 1-based line.
     * A fragment (`#L24`, `#L24-L30`) wins over a colon suffix (`:24`,
     * `:24:5`, `:24-30`); columns and end lines are consumed but only the
     * first line is selected. `file://` destinations are accepted so a reply
     * quoting a Markdown-style file URL still opens.
     * @param raw - the inline-code token, exactly as authored.
     * @returns the path and optional line, or undefined when the token names no file.
     */
    function parseToken(raw) {
      if (typeof raw !== 'string') return undefined
      let text = raw.trim()
      if (text.length === 0 || text.length > MAX_TOKEN) return undefined
      // Authored quoting around a path: `"path with spaces.md"`.
      if (text.length > 2 && (
        (text.startsWith('"') && text.endsWith('"'))
        || (text.startsWith("'") && text.endsWith("'"))
      )) {
        text = text.slice(1, -1).trim()
      }
      if (text.length === 0) return undefined
      if (/^file:\/\//i.test(text)) {
        try {
          text = decodeURIComponent(text.slice('file://'.length))
        } catch {
          return undefined // Malformed escapes cannot name a file unambiguously.
        }
        // `file:///abs/path` decodes to `/abs/path`; `file://host/path` is not a local file.
        if (!text.startsWith('/')) return undefined
      } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text) || /^(?:mailto|tel|data|javascript|blob):/i.test(text)) {
        return undefined
      }
      let line
      const hash = text.indexOf('#')
      if (hash >= 0) {
        const fragment = /^L(\d+)(?:-L(\d+))?$/i.exec(text.slice(hash + 1))
        if (fragment === null) return undefined
        text = text.slice(0, hash)
        line = Number(fragment[1])
      } else {
        const suffix = /:(\d+)(?::\d+|-\d+)?$/.exec(text)
        if (suffix !== null) {
          text = text.slice(0, suffix.index)
          line = Number(suffix[1])
        }
      }
      if (line !== undefined && (!Number.isSafeInteger(line) || line < 1)) return undefined
      if (!looksLikeFilePath(text)) return undefined
      return { path: text, line }
    }

    /**
     * Decide whether a bare word actually names a file in a coding reply.
     * @param path - the token after its location suffix was removed.
     * @returns whether the path is worth a click.
     */
    function looksLikeFilePath(path) {
      if (path.length === 0 || path.length > MAX_TOKEN) return false
      // A home shorthand needs the Session's filesystem to expand; guessing is worse than plain text.
      if (path.startsWith('~')) return false
      if (/[\s\u0000-\u001f]/.test(path)) return false
      // Globs, brace expansion, template placeholders, and pipes are not one file.
      if (/[*?[\]{}<>|"'`]/.test(path)) return false
      // A directory has no preview; a trailing separator is how a reply spells one.
      if (/[\\/]$/.test(path)) return false
      if (/^[\\/]+$/.test(path)) return false
      const base = path.split(/[\\/]/).pop() ?? ''
      if (base.length === 0 || base === '.' || base === '..') return false
      if (base.startsWith('-')) return false // `--flag` reads like a path otherwise
      const flat = !path.includes('/') && !path.includes('\\')
      if (flat && PROSE_NAMES.has(base.toLowerCase())) return false
      if (NAMES.has(base)) return true
      if (/^\.env(\..+)?$/.test(base)) return true
      // Dotfiles with no second dot (` .gitignore`, `.npmrc`) are files, not extensions.
      if (base.startsWith('.') && !base.slice(1).includes('.')) return true
      const dot = base.lastIndexOf('.')
      if (dot <= 0) return false
      const extension = base.slice(dot + 1).toLowerCase()
      return /^[a-z0-9+#]{1,12}$/.test(extension) && EXTENSIONS.has(extension)
    }

    /** Marker stored on the service object so the wrapper installs once. */
    const WRAPPED = Symbol.for('dsh-file-links.wrapped')

    /**
     * Build the vocabulary for one closing Turn: the shipped provider first,
     * this plugin for every file-shaped token it declines.
     * @param owner - closing-Turn identity and Chat's file opener.
     * @param base - the shipped resolver, when ui-deliverables offered one.
     * @param getFileTriggerProps - ordinary file context-menu binding.
     * @param t - localized copy.
     * @returns the resolver MarkdownText consumes.
     */
    function vocabulary(owner, base, getFileTriggerProps, t) {
      const inherited = base !== undefined && typeof base.resolve === 'function' ? base : undefined
      // One entry per authored token: a message repeats its paths, and every
      // repeat must produce the same live handler without re-parsing.
      const cache = new Map()
      return {
        resolve(value) {
          // The shipped vocabulary knows the Turn's real produced paths, which
          // is more precise than this plugin's shape grammar; keep its answer.
          const shipped = inherited === undefined ? undefined : inherited.resolve(value)
          if (shipped !== undefined) return shipped
          const parsed = parseToken(value)
          if (parsed === undefined) return undefined
          // `apply.ts:272` against a produced `apply.ts`: resolve the file
          // through the shipped vocabulary, then attach the line it names.
          if (parsed.line !== undefined && inherited !== undefined) {
            const named = inherited.resolve(parsed.path)
            if (named !== undefined) return located(named, parsed.line, owner, t)
          }
          let entry = cache.get(value)
          if (entry === undefined) entry = entryFor(parsed, owner, getFileTriggerProps, t)
          cache.set(value, entry)
          return entry
        },
      }
    }

    /**
     * One clickable chip's props: localized label, full-path tooltip, file
     * context menu, and the opener that carries the line through.
     * @param parsed - path and optional line.
     * @returns the mention entry MarkdownText renders.
     */
    function entryFor({ path, line }, owner, getFileTriggerProps, t) {
      const trigger = getFileTriggerProps === undefined ? undefined : getFileTriggerProps(path)
      return {
        label: line === undefined ? t('open', { path }) : t('openLine', { path, line }),
        title: line === undefined ? path : `${path}:${line}`,
        open: () => { owner.openFile(path, line === undefined ? undefined : { line }) },
        ...trigger === undefined ? {} : { contextMenuProps: trigger },
      }
    }

    /**
     * Re-point a shipped entry at one line of the file it already names. Its
     * `title` is the full path the deliverables vocabulary resolved, which is
     * what the line has to be attached to.
     * @param named - the shipped entry.
     * @param line - the 1-based line the reply named.
     * @returns the shipped entry with a line-aware opener, when its path is usable.
     */
    function located(named, line, owner, t) {
      const path = typeof named.title === 'string' && named.title.length > 0 ? named.title : undefined
      if (path === undefined) return named
      return {
        ...named,
        label: t('openLine', { path, line }),
        title: `${path}:${line}`,
        open: () => { owner.openFile(path, { line }) },
      }
    }

    /**
     * Compose this plugin behind the shipped `chatFileMentions` provider.
     * Installing on the service object is deliberate: the service is a
     * single-provider seam, and replacing it would take the changed-files card
     * down with it.
     * @param ctx - client root context.
     * @param t - localized copy.
     * @returns the disposer restoring the shipped method, or undefined when there is nothing to wrap.
     */
    function install(ctx, t) {
      const service = ctx.get('chatFileMentions')
      if (service === undefined || typeof service.forClosing !== 'function') return undefined
      if (service[WRAPPED] === true) return undefined
      const shipped = service.forClosing
      const patched = function forClosing(owner, sessionId, getFileTriggerProps) {
        const base = shipped.call(this, owner, sessionId, getFileTriggerProps)
        return vocabulary(owner, base, getFileTriggerProps, t)
      }
      service.forClosing = patched
      service[WRAPPED] = true
      return () => {
        if (service.forClosing === patched) service.forClosing = shipped
        delete service[WRAPPED]
      }
    }

    return {
      name: 'dsh-file-links',
      inject: ['locale'],
      /**
       * Mount the vocabulary. The shipped provider arrives with ui-deliverables,
       * so waiting for it keeps load order the composition's business.
       * @param ctx - client root context.
       */
      apply(ctx) {
        const t = ctx.locale.bind(NS)
        ctx.effect(() => ctx.locale.register(NS, LOCALES), 'dsh-file-links: dictionaries')
        ctx.inject(['chatFileMentions'], (ctx) => {
          ctx.effect(() => install(ctx, t), 'dsh-file-links: prose file vocabulary')
        })
      },
    }
  },
})
