#!/usr/bin/env python3
"""Adapt dsh-webui-auth 0.3.6 to DSH 0.2.2-alpha.2's Fetch-style fallback seat.

DSH <= 0.2.1 kept a Node `(req, res)` handler in `webServer.fallback`; 0.2.2
stores `{ resource }` (a Fetch `(Request) => Response`). The plugin calls the
seat as a function, which throws and turns the printed token URL into a 500.
"""
import os
import re
import sys

HELPER = '''
/**
 * Delegate to the fallback seat in whichever shape this DSH core keeps there.
 *
 * DSH <= 0.2.1: a Node handler owning the response lifecycle.
 * DSH >= 0.2.2: `{ resource }`, a Fetch resource answering `(Request) => Response`
 * (see webServer.serveResource). The resource receives `peer === undefined`, so
 * frontend-static runs the core's own browser authentication on the request.
 */
async function serveFallback(ctx, req, res) {
  const fallback = ctx.webServer.fallback
  if (fallback === undefined) {
    res.writeHead(404)
    res.end()
    return
  }
  if (typeof fallback === 'function') {
    await fallback(req, res)
    return
  }
  const resource = fallback && fallback.resource
  if (typeof resource !== 'function') {
    res.writeHead(404)
    res.end()
    return
  }
  const headers = new Headers()
  for (const [name, value] of Object.entries(req.headers)) {
    for (const item of typeof value === 'string' ? [value] : value ?? []) headers.append(name, item)
  }
  const abort = new AbortController()
  const onClose = () => { if (!abort.signal.aborted) abort.abort() }
  res.on('close', onClose)
  try {
    const response = await resource(new Request(new URL(req.url || '/', 'http://dsh.invalid'), {
      method: req.method,
      headers,
      signal: abort.signal,
    }))
    const out = new Headers()
    for (const [name, value] of response.headers) {
      if (name.toLowerCase() !== 'set-cookie') out.append(name, value)
    }
    const cookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : []
    const flat = {}
    for (const [name, value] of out) flat[name] = value
    if (cookies.length > 0) flat['set-cookie'] = cookies
    res.writeHead(response.status, flat)
    if (req.method === 'HEAD' || response.body === null) {
      res.end()
      return
    }
    const body = Buffer.from(await response.arrayBuffer())
    res.end(body)
  } finally {
    res.off('close', onClose)
  }
}
'''

CALL = re.compile(
    r"(?P<indent>[ \t]*)const fallback = ctx\.webServer\.fallback\n"
    r"[ \t]*if \(fallback !== undefined\) \{\n"
    r"[ \t]*await fallback\(req, res\)\n"
    r"[ \t]*return\n"
    r"[ \t]*\}\n"
)


# The plugin only treats a request as the core's token->cookie exchange when the
# TCP peer is loopback. Behind a reverse proxy the peer is the proxy's address,
# so no browser could ever complete the exchange and a fresh one would bounce
# between /login and the token URL forever. The core itself authorizes that
# exchange by token, not by peer, so the extra condition is dropped.
LOOPBACK = re.compile(
    r'(?P<head>function coreTokenExchange\(ctx, req\) \{\n)'
    r'[ \t]*if \(!isLoopbackPeer\(req\)\) return false\n'
)


def patch_fallback(src: str) -> tuple[str, str]:
    if 'serveFallback(ctx, req, res)' in src:
        return src, 'fallback: already patched'
    replaced, count = CALL.subn(
        lambda m: f"{m.group('indent')}if (ctx.webServer.fallback !== undefined) {{\n"
                  f"{m.group('indent')}  await serveFallback(ctx, req, res)\n"
                  f"{m.group('indent')}  return\n"
                  f"{m.group('indent')}}}\n",
        src,
    )
    if count != 2:
        return src, f'fallback: expected 2 call sites, found {count}'
    marker = 'export async function apply(ctx) {'
    if marker not in replaced:
        return src, 'fallback: apply() marker not found'
    replaced = replaced.replace(marker, HELPER.strip('\n') + '\n\n' + marker, 1)
    return replaced, f'fallback: patched {count} call sites'


def patch_loopback(src: str) -> tuple[str, str]:
    if 'coreTokenExchange: peer-independent' in src:
        return src, 'token exchange: already patched'
    replaced, count = LOOPBACK.subn(
        lambda m: f"{m.group('head')}"
                  "  // coreTokenExchange: peer-independent, matching the core's own rule (token, not peer)\n",
        src,
    )
    if count != 1:
        return src, f'token exchange: expected 1 site, found {count}'
    return replaced, 'token exchange: loopback requirement removed'


def main(path: str) -> int:
    src = open(path, encoding='utf-8').read()
    src, a = patch_fallback(src)
    src, b = patch_loopback(src)
    print(a)
    print(b)
    if 'expected' in a or 'expected' in b or 'not found' in a:
        return 1
    # pnpm hard-links installed files to its content-addressable store. Opening
    # the path for writing edits the shared inode, so the store's blob changes
    # too; the next `pnpm add` anywhere then sees an integrity mismatch and
    # restores the pristine blob, silently undoing this patch. Replace the file
    # instead: a new inode detaches node_modules from the store.
    tmp = f'{path}.patch-tmp'
    with open(tmp, 'w', encoding='utf-8') as handle:
        handle.write(src)
    os.chmod(tmp, 0o644)
    os.replace(tmp, path)
    print(f'wrote {path}')
    return 0


if __name__ == '__main__':
    if len(sys.argv) != 2:
        print('usage: fallback-seat.py <path to dsh-webui-auth/index.js>', file=sys.stderr)
        raise SystemExit(2)
    raise SystemExit(main(sys.argv[1]))
