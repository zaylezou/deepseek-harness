#!/usr/bin/env python3
"""Make dsh-webui-auth survive cross-site top-level navigations (SameSite=Strict core cookie).

DSH 0.2.2's core browser gate (client-connection BrowserAuth) mints a
`SameSite=Strict` cookie. Two entry paths then break:

  1. cross-site navigation (link from another app / another site): the core's
     host fence rejects `Sec-Fetch-Site: cross-site` with 403, the plugin only
     redirects on 401, so the request is handed to the core fallback, which
     answers 401 with the plain text "dsh web authentication required; reopen
     the URL printed by dsh web."
  2. any navigation whose Strict cookie is withheld for the redirect chain:
     the plugin answers 302 -> /?token=..., the core mints the Strict cookie and
     303s back to "/", the browser still does not send it, and the pair repeats
     until the browser gives up with ERR_TOO_MANY_REDIRECTS ("too many
     redirects", which suggests clearing cookies).

Both are fixed by replacing the raw 302 with a tiny same-site bridge page whose
`location.replace()` starts a NEW navigation initiated by our own document. A
same-site navigation carries the Strict cookie, so the core's token exchange is
accepted and the app loads.

Only GET document navigations are bridged; the previous 302 stays in place for
every other request shape. The patch is idempotent and keeps a .bak copy.
"""
import os
import re
import sys

DEFAULT_TARGET = os.path.expanduser('~/.dsh/profiles/web/node_modules/dsh-webui-auth/index.js')


def resolve_target(argv: list[str]) -> str:
    """Patcher contract: the installed file path is argv[1]."""
    if len(argv) > 1 and argv[1].strip():
        return argv[1]
    return os.environ.get('DSH_WEBUI_AUTH_INDEX') or DEFAULT_TARGET
MARKER = "dsh-webui-auth-crosssite-bridge"

OLD_GATE = """          const connection = ctx.get('connection')
          if (connection && typeof connection.requestRejection === 'function') {
            let hasToken = false
            try { hasToken = new URL(req.url || '/', 'http://x').searchParams.has('token') } catch (e) { /* ignore */ }
            if (!hasToken && connection.requestRejection(req) === 401) {
              res.writeHead(302, { location: postLoginRedirect(ctx, req) })
              res.end()
              return
            }
          }
"""

NEW_GATE = """          const connection = ctx.get('connection')
          if (connection && typeof connection.requestRejection === 'function') {
            let hasToken = false
            try { hasToken = new URL(req.url || '/', 'http://x').searchParams.has('token') } catch (e) { /* ignore */ }
            if (!hasToken) {
              const rejection = connection.requestRejection(req)
              const target = postLoginRedirect(ctx, req)
              // dsh-webui-auth-crosssite-bridge: a cross-site top-level navigation cannot
              // carry the core's SameSite=Strict cookie (and the core's Sec-Fetch-Site fence
              // answers 403 before any cookie check), so redirecting would either bounce to
              // the core's plain-text 401 or loop 302 -> 303 -> 302 until the browser gives
              // up. Answer with a same-site bridge page instead: its location.replace()
              // starts a navigation initiated by our own document, which does carry the
              // Strict cookie and completes the core token exchange.
              // 403 is the core's Sec-Fetch-Site fence: only bridge it for a genuinely
              // cross-site navigation. An untrusted Host also answers 403 and bridging
              // that would keep re-entering the bridge page forever.
              const bridgeable = rejection === 401 || (rejection === 403 && isCrossSiteRequest(req))
              if (bridgeable && isDocumentNavigation(req) && bridgeTarget(target)) {
                sendBridgePage(res, target)
                return
              }
              if (rejection === 401) {
                res.writeHead(302, { location: target })
                res.end()
                return
              }
            }
          }
"""

HELPERS = """// dsh-webui-auth-crosssite-bridge: helpers for the same-site bridge page.
// A SameSite=Strict cookie is withheld on cross-site navigations (and the core
// refuses Sec-Fetch-Site: cross-site outright), so the token redirect must be
// performed by our own document instead of by a 302.

/** Is this request a top-level document GET (a navigation a bridge page can serve)? */
function isDocumentNavigation(req) {
  if (!req || req.method !== 'GET') return false
  const headers = req.headers || {}
  const dest = typeof headers['sec-fetch-dest'] === 'string' ? headers['sec-fetch-dest'].trim().toLowerCase() : ''
  if (dest !== '' && dest !== 'document') return false
  const mode = typeof headers['sec-fetch-mode'] === 'string' ? headers['sec-fetch-mode'].trim().toLowerCase() : ''
  if (mode !== '' && mode !== 'navigate') return false
  return true
}

/** Did the browser label this navigation as coming from another site? */
function isCrossSiteRequest(req) {
  const value = req && req.headers ? req.headers['sec-fetch-site'] : undefined
  return typeof value === 'string' && value.trim().toLowerCase() === 'cross-site'
}

/** Is the redirect target an absolute URL carrying the core launch token? */
function bridgeTarget(target) {
  try {
    const url = new URL(String(target), 'http://dsh.invalid')
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.searchParams.has('token')
  } catch (e) {
    return false
  }
}

/** Same-site bootstrap page: navigates (not redirects) to the token URL. */
function sendBridgePage(res, target) {
  const href = String(target)
  const safe = href.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  let literal = JSON.stringify(href)
  literal = literal.replace(/</g, '\\\\u003c')
  const html = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1"><title>正在进入 DSH</title>'
    + '<style>body{font:15px/1.6 system-ui,-apple-system,sans-serif;margin:0;min-height:100vh;'
    + 'display:flex;align-items:center;justify-content:center;background:#fff;color:#0f1115}'
    + '@media (prefers-color-scheme:dark){body{background:#151517;color:#f9fafb}}'
    + 'a{color:inherit}</style></head><body>'
    + '<p>正在进入 DSH…</p>'
    + '<script>location.replace(' + literal + ')</script>'
    + '<noscript><p><a href="' + safe + '">点这里继续</a></p></noscript>'
    + '</body></html>'
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
  })
  res.end(html)
}

"""

ANCHOR = "export async function apply(ctx) {"


def main(target: str) -> int:
    TARGET = target
    if not os.path.exists(TARGET):
        print(f"missing target: {TARGET}", file=sys.stderr)
        return 2
    with open(TARGET, encoding='utf-8') as fh:
        source = fh.read()

    if MARKER in source:
        print("already patched; nothing to do")
        return 0

    if source.count(OLD_GATE) != 1:
        print(f"gate anchor not found exactly once (count={source.count(OLD_GATE)}); refusing to patch", file=sys.stderr)
        return 3
    if source.count(ANCHOR) != 1:
        print("apply() anchor not found exactly once; refusing to patch", file=sys.stderr)
        return 3

    patched = source.replace(OLD_GATE, NEW_GATE, 1)
    patched = patched.replace(ANCHOR, HELPERS + ANCHOR, 1)

    backup = TARGET + '.bak-crosssite'
    if not os.path.exists(backup):
        with open(backup, 'w', encoding='utf-8') as fh:
            fh.write(source)

    # pnpm hard-links installed files to its content-addressable store, so an
    # in-place write would edit the shared blob and the next `pnpm add` would
    # restore the pristine file. Replace the inode instead.
    tmp = TARGET + '.patch-tmp'
    with open(tmp, 'w', encoding='utf-8') as fh:
        fh.write(patched)
    os.chmod(tmp, 0o644)
    os.replace(tmp, TARGET)
    print(f"patched {TARGET} (+{len(patched) - len(source)} bytes)")
    return 0


if __name__ == '__main__':
    raise SystemExit(main(resolve_target(sys.argv)))
