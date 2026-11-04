# Local patches carried by this DSH profile.
#
# dsh-safe-install.sh re-installs packages through pnpm, and pnpm relinks (or
# replaces) files it considers stale, silently dropping any local edit. Rather
# than copying an old patched file over a newer version, the installer asks this
# registry to re-derive each patch on the freshly installed copy — once in the
# trial home, once in the real profile.
#
# Registry contract (sourced by dsh-safe-install.sh):
#   LOCAL_PATCH_FILES     installed files (relative to <profile>/node_modules)
#   LOCAL_PATCH_PATCHERS  space-separated patcher scripts, relative to this dir
#   LOCAL_PATCH_MARKERS   strings that must all be present in a patched file
#
# Index-aligned across the three arrays. A patcher is a python script that takes
# the absolute file path as argv[1], is idempotent, and exits non-zero when its
# anchors are gone (upstream moved: fix the patcher, never guess). The installer
# then refuses to report success instead of shipping a half-patched plugin.
#
# dsh-webui-auth (0.3.6, the only local-patched package today):
#   fallback-seat.py     DSH 0.2.2 turned webServer.fallback into a Fetch
#                        resource ({ resource }); 0.3.6 still calls it as a
#                        function, so the token exchange 500s. Also drops the
#                        loopback-only check on the core token exchange, which
#                        can never be satisfied behind a reverse proxy.
#   crosssite-bridge.py  The core's own browser cookie is SameSite=Strict and the
#                        core's Sec-Fetch-Site fence answers 403 before any
#                        cookie check, so an entry from another app/site lands on
#                        the plain-text 401 (or bounces 302/303 until
#                        ERR_TOO_MANY_REDIRECTS). The bridge page replaces the
#                        302 with a same-site navigation.
#
# dsh-restart-anywhere (0.1.7, added with the 0.2.2-alpha.3 upgrade):
#   root-agents.py       DSH 0.2.2 replaced agents.roots() with agents.list(),
#                        so the plugin's `agents` injection threw and the
#                        per-root dsh_restart registration never ran. A root
#                        session is one whose header carries no parentSession.

LOCAL_PATCH_FILES=(
  'dsh-webui-auth/index.js'
  'dsh-restart-anywhere/lib/index.js'
)

LOCAL_PATCH_PATCHERS=(
  'dsh-webui-auth/fallback-seat.py dsh-webui-auth/crosssite-bridge.py'
  'dsh-restart-anywhere/root-agents.py'
)

LOCAL_PATCH_MARKERS=(
  'coreTokenExchange: peer-independent dsh-webui-auth-crosssite-bridge'
  'root-agent gate: DSH 0.2.2 replaced agents.roots() with agents.list()'
)

PATCH_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

local_patch_list() {
  printf '%s\n' "${LOCAL_PATCH_FILES[@]}"
}

# Index of a registered file, or empty when it is not registered.
local_patch_index() {
  local i
  for i in "${!LOCAL_PATCH_FILES[@]}"; do
    if [ "${LOCAL_PATCH_FILES[$i]}" = "$1" ]; then
      printf '%s' "$i"
      return 0
    fi
  done
  return 1
}

# Apply every patcher registered for one installed file. Idempotent patchers are
# expected, so this is safe to call on an already-patched file.
local_patch_apply() {
  local rel=$1 file=$2 idx patcher out rc=0
  [ -f "$file" ] || return 0
  idx=$(local_patch_index "$rel") || { printf 'unregistered patch target: %s\n' "$rel" >&2; return 1; }
  for patcher in ${LOCAL_PATCH_PATCHERS[$idx]}; do
    if ! out=$(python3 "$PATCH_DIR/$patcher" "$file" 2>&1); then
      printf '%s failed on %s:\n%s\n' "$patcher" "$file" "$out" >&2
      # Patchers run in order and later ones build on earlier edits; stop here so
      # a half-patched file can never reach the trial or the real profile.
      return 1
    fi
    printf '%s: %s\n' "$patcher" "$(printf '%s' "$out" | tr '\n' ';')"
  done
  return 0
}

# Is the installed file already carrying every marker the registry expects?
local_patch_present() {
  local rel=$1 file=$2 idx marker
  [ -f "$file" ] || return 1
  idx=$(local_patch_index "$rel") || return 1
  for marker in ${LOCAL_PATCH_MARKERS[$idx]}; do
    grep -qF -- "$marker" "$file" || return 1
  done
  return 0
}
