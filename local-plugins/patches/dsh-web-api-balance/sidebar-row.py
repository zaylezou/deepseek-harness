#!/usr/bin/env python3
"""Replace dsh-web-api-balance's composer client with the sidebar balance row.

The package's Host half (credentials, cache, route) stays untouched. Only the
browser half changes: one row in `sidebar.footer.action` above Restart dsh, and
no per-conversation cost column.

Idempotent: the marker string in the replacement file is the "already patched"
signal. Writes through a temp file + os.replace, because pnpm hard-links the
installed file into its content-addressable store.
"""

import os
import sys
import tempfile

MARKER = "LOCAL_PATCH_SIDEBAR_BALANCE_ROW"


def main(path: str) -> int:
    try:
        with open(path, "rb") as handle:
            current = handle.read()
    except OSError as error:
        print(f"cannot read {path}: {error}", file=sys.stderr)
        return 1

    if MARKER.encode() in current:
        print("already patched")
        return 0

    here = os.path.dirname(os.path.abspath(__file__))
    template = os.path.join(here, "client.sidebar.js")
    try:
        with open(template, "rb") as handle:
            replacement = handle.read()
    except OSError as error:
        print(f"cannot read template {template}: {error}", file=sys.stderr)
        return 1

    if MARKER.encode() not in replacement:
        print(f"template {template} lacks the marker", file=sys.stderr)
        return 1

    directory = os.path.dirname(path)
    fd, tmp = tempfile.mkstemp(dir=directory, prefix=".sidebar-row-", suffix=".js")
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(replacement)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise

    print("replaced client with sidebar balance row")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("usage: sidebar-row.py <installed client.js>", file=sys.stderr)
        sys.exit(2)
    sys.exit(main(sys.argv[1]))
