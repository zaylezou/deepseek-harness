#!/usr/bin/env python3
"""Adapt dsh-restart-anywhere 0.1.7 to DSH 0.2.2-alpha.3's agent registry.

DSH <= 0.2.1 exposed `agents.roots()`, the live root agents. 0.2.2 replaced it
with `agents.list()`, so the plugin's `agents` injection throws
"ctx.agents.roots is not a function or its return value is not iterable" and the
per-root tool registration never runs. A root session is the one whose header
carries no `parentSession`; see dsh-core's Agent.session and the fork lineage it
records.
"""
import os
import sys

MARKER = 'root-agent gate: DSH 0.2.2 replaced agents.roots() with agents.list()'
INJECT = "  ctx.inject(['agents'], (ctx) => {\n"
GATE = '      if (ctx.agents.roots().includes(agent)) ctx.effect('
LOOP = '    for (const agent of ctx.agents.roots()) attach(agent)'
GATED = '      if (isRoot(agent)) ctx.effect('
LISTED = '    for (const agent of ctx.agents.list()) attach(agent)'
HELPER = f'    // {MARKER}\n' \
         '    const isRoot = agent => agent?.session?.header?.parentSession === undefined\n'


def main(path: str) -> int:
    src = open(path, encoding='utf-8').read()
    if MARKER in src:
        print('root-agent gate: already patched')
        return 0
    for label, anchor in (('inject block', INJECT), ('gate line', GATE), ('root loop', LOOP)):
        found = src.count(anchor)
        if found != 1:
            print(f'root-agent gate: expected 1 {label}, found {found}', file=sys.stderr)
            return 1
    src = src.replace(INJECT, INJECT + HELPER, 1)
    src = src.replace(GATE, GATED, 1)
    src = src.replace(LOOP, LISTED, 1)
    if GATE in src or LOOP in src:
        print('root-agent gate: replacement left an old call behind', file=sys.stderr)
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
    print(f'root-agent gate: patched agents.roots() -> agents.list(), wrote {path}')
    return 0


if __name__ == '__main__':
    if len(sys.argv) != 2:
        print('usage: root-agents.py <path to dsh-restart-anywhere/lib/index.js>', file=sys.stderr)
        raise SystemExit(2)
    raise SystemExit(main(sys.argv[1]))
