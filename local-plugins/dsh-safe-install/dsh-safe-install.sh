#!/usr/bin/env bash
# dsh-safe-install — install a DSH plugin only after it has booted in a throwaway
# DSH_HOME that mirrors this profile's composition.
#
# Why: a plugin that fails to boot takes the whole Web GUI with it, and the
# failure is only discovered after it is already in the real profile. This
# script copies the profile's package.json / cordis.patch.yml into a temp home,
# installs the candidate there, boots `dsh web` on a free port, probes it, and
# only then installs into the real profile.
#
# Local patches (which installed files this profile edits, and how to re-derive
# them) live in patches/dsh-local-patches.sh, not here. This script only asks the
# registry: same version -> carry the patched file over; version moved -> re-run
# the registered patchers; after the real install -> make sure the markers are
# back. A patcher that no longer applies is a hard failure, not a warning.
#
# Usage:
#   ./dsh-safe-install.sh dsh-qq-onebot
#   ./dsh-safe-install.sh @scope/pkg@1.2.3
#   ./dsh-safe-install.sh --test-only dsh-qq-onebot     # trial boot, never install
#   ./dsh-safe-install.sh --keep dsh-qq-onebot          # keep the temp home
#   ./dsh-safe-install.sh --restart dsh-qq-onebot       # restart the service after
#   ./dsh-safe-install.sh --patch-append extra.yml pkg  # also apply an extra patch layer
set -uo pipefail

# This script ships inside the checkout, at local-plugins/dsh-safe-install/, so
# the checkout root and the patch registry are both derived from its own path
# instead of naming a machine. DSH_CHECKOUT / DSH_PATCH_REGISTRY still override.
HERE=$(cd "$(dirname "$0")" && pwd)
CHECKOUT=${DSH_CHECKOUT:-$(cd "$HERE/../.." && pwd)}
PROFILE_HOME=${DSH_HOME:-$HOME/.dsh}
PROFILE=$PROFILE_HOME/profiles/web
SERVICE=${DSH_SERVICE:-dsh-web.service}
TIMEOUT=${DSH_SAFE_TIMEOUT:-45}

SPEC=
TEST_ONLY=0
KEEP=0
RESTART=0
PATCH_APPEND=
PATCH_PROBLEM=0

PATCH_REGISTRY=${DSH_PATCH_REGISTRY:-$HERE/../patches/dsh-local-patches.sh}

while [ $# -gt 0 ]; do
  case "$1" in
    --test-only) TEST_ONLY=1; shift ;;
    --keep) KEEP=1; shift ;;
    --restart) RESTART=1; shift ;;
    --timeout) TIMEOUT=$2; shift 2 ;;
    --patch-append) PATCH_APPEND=$2; shift 2 ;;
    -h|--help) sed -n '2,23p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "unknown flag: $1" >&2; exit 2 ;;
    *) SPEC=$1; shift ;;
  esac
done

[ -n "$SPEC" ] || { echo "usage: $0 [--test-only] [--keep] [--restart] <package>[@version]" >&2; exit 2; }
[ -d "$PROFILE" ] || { echo "no profile at $PROFILE" >&2; exit 2; }
[ -d "$CHECKOUT" ] || { echo "no checkout at $CHECKOUT" >&2; exit 2; }

say() { printf '%s\n' "$*"; }
step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
fail() { printf '\033[31mFAIL\033[0m %s\n' "$*" >&2; }

pkg_version() {
  python3 -c "import json,sys;print(json.load(open(sys.argv[1] + '/package.json'))['version'])" "$1" 2>/dev/null
}

# Local patch registry: optional, so this installer still works on a profile
# that carries no patches at all.
if [ -f "$PATCH_REGISTRY" ]; then
  # shellcheck source=patches/dsh-local-patches.sh
  . "$PATCH_REGISTRY"
else
  say "no local patch registry at $PATCH_REGISTRY; local patches disabled"
fi
if ! declare -F local_patch_list >/dev/null; then
  local_patch_list() { :; }
  local_patch_apply() { return 0; }
  local_patch_present() { return 1; }
fi

# Re-derive the local patches for one installed file.
patch_local() {
  local rel=$1 file=$2 label=$3 out
  [ -f "$file" ] || return 0
  if ! out=$(local_patch_apply "$rel" "$file" 2>&1); then
    fail "local patch for $rel did not apply ($label: $file)"
    printf '%s\n' "$out" >&2
    return 1
  fi
  say "local patch ($label): $(printf '%s' "$out" | tr '\n' ' ')"
  return 0
}

# Same filesystem as the pnpm store: a cross-device temp dir makes pnpm switch
# stores, and a copied node_modules then fails with ERR_PNPM_UNEXPECTED_STORE.
TMP=$(mktemp -d "${HOME}/.dsh/tmp-safe-install.XXXXXX") || exit 1
TRIAL_PROFILE=$TMP/profiles/web
mkdir -p "$TRIAL_PROFILE"
LOG=$TMP/trial.log
PID=

cleanup() {
  if [ -n "${PID:-}" ] && kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null
    for _ in $(seq 1 20); do kill -0 "$PID" 2>/dev/null || break; sleep 0.2; done
    kill -9 "$PID" 2>/dev/null
  fi
  if [ "$KEEP" = 1 ]; then
    say "temp home kept: $TMP"
  else
    rm -rf "$TMP"
  fi
}
trap cleanup EXIT INT TERM

# ── 1. mirror the real composition ──────────────────────────────────────────
step "mirroring profile $PROFILE"
cp "$PROFILE/package.json" "$TRIAL_PROFILE/package.json" || exit 1
[ -f "$PROFILE/cordis.patch.yml" ] && cp "$PROFILE/cordis.patch.yml" "$TRIAL_PROFILE/cordis.patch.yml"
[ -f "$PROFILE/pnpm-lock.yaml" ] && cp "$PROFILE/pnpm-lock.yaml" "$TRIAL_PROFILE/pnpm-lock.yaml"
# node_modules is deliberately NOT copied: pnpm resolves `link:` dependencies
# through relative symlinks that break in a new directory, and a copied tree
# also makes pnpm switch stores. A fresh install plus the local-patch carry-over
# below reproduces the composition faithfully.
if [ -n "$PATCH_APPEND" ]; then
  cat "$PATCH_APPEND" >> "$TRIAL_PROFILE/cordis.patch.yml"
  say "extra patch layer appended: $PATCH_APPEND"
fi
python3 -c "import json;json.dump(sorted(json.load(open('$TRIAL_PROFILE/package.json')).get('dependencies',{})),open('$TMP/deps-before.json','w'))" || exit 1
say "bundles: $(python3 -c "import json;print(json.load(open('$TRIAL_PROFILE/package.json'))['dsh']['profile']['bundles'])")"

# ── 2. install the candidate into the throwaway home ────────────────────────
step "installing $SPEC into the throwaway home"
if ! ( cd "$CHECKOUT" && DSH_HOME="$TMP" pnpm dsh plugin --profile web add "$SPEC" ) >"$TMP/install.log" 2>&1; then
  fail "install step failed (dependency resolution / registry)"
  tail -20 "$TMP/install.log"
  exit 1
fi
# pnpm relinks packages it considers stale, which silently discards a local
# patch. Carry the patched file over when the version is unchanged; when the
# version moved, re-derive the patch instead of copying stale code over it.
for rel in $(local_patch_list); do
  pkg=${rel%%/*}
  src=$PROFILE/node_modules/$rel
  dst=$TRIAL_PROFILE/node_modules/$rel
  [ -f "$src" ] && [ -f "$dst" ] || continue
  srcv=$(pkg_version "$PROFILE/node_modules/$pkg")
  dstv=$(pkg_version "$TRIAL_PROFILE/node_modules/$pkg")
  if [ "$srcv" = "$dstv" ]; then
    cmp -s "$src" "$dst" || { cp "$src" "$dst" && say "carried local patch: $rel"; }
    # A profile copy that somehow lost its markers must not run unpatched here.
    if ! local_patch_present "$rel" "$dst"; then
      patch_local "$rel" "$dst" "trial" || PATCH_PROBLEM=1
    fi
  else
    say "$pkg moved ${srcv:-?} -> ${dstv:-?}; re-deriving local patches instead of copying"
    patch_local "$rel" "$dst" "trial" || PATCH_PROBLEM=1
  fi
done
say "installed: $(python3 -c "
import json
d=json.load(open('$TRIAL_PROFILE/package.json'))
print(d['dsh']['profile']['bundles'][-1])")"

# ── 3. boot it on a free port ───────────────────────────────────────────────
port=$(( (RANDOM % 3000) + 21000 ))
while ss -ltn 2>/dev/null | grep -q ":$port "; do port=$((port + 1)); done

step "trial boot on port $port"
(
  cd "$CHECKOUT" || exit 1
  DSH_HOME="$TMP" exec pnpm dsh web \
    --port "$port" \
    --public-url "http://172.17.0.1:$port/" \
    --trusted-host "172.17.0.1:$port" \
    --trusted-host "127.0.0.1:$port" \
    --no-open
) >"$LOG" 2>&1 &
PID=$!

probe() {
  local code
  for addr in 172.17.0.1 127.0.0.1; do
    code=$(curl -s -m 2 -o /dev/null -w '%{http_code}' \
      -H 'Accept: text/html,application/xhtml+xml' \
      "http://$addr:$port/" 2>/dev/null)
    case "$code" in 200|302|303|401) printf '%s' "$code"; return 0 ;; esac
  done
  printf '%s' "${code:-000}"
}

healthy=0
for _ in $(seq 1 $((TIMEOUT * 2))); do
  sleep 0.5
  if ! kill -0 "$PID" 2>/dev/null; then
    fail "the process exited during startup"
    break
  fi
  if ls "$TMP"/logs/startup-*.log >/dev/null 2>&1; then
    fail "dsh wrote a startup failure dump"
    break
  fi
  code=$(probe)
  case "$code" in 200|302|303|401) healthy=1; break ;; esac
done

if [ "$healthy" != 1 ]; then
  fail "$SPEC does not boot in this composition — NOT installed"
  echo
  say "--- trial output (last 30 lines) ---"
  tail -30 "$LOG"
  dump=$(ls "$TMP"/logs/startup-*.log 2>/dev/null | head -1)
  if [ -n "${dump:-}" ]; then
    echo
    say "--- startup dump: $dump ---"
    sed -n '1,40p' "$dump"
  fi
  exit 1
fi

# A process can be up and still be useless (500 on every document). Give the
# crash-dump watch one more beat, then require a sane document status.
sleep 1
if ls "$TMP"/logs/startup-*.log >/dev/null 2>&1 || ! kill -0 "$PID" 2>/dev/null; then
  fail "$SPEC died just after binding the port — NOT installed"
  tail -30 "$LOG"
  exit 1
fi

# A plugin can fail to load while the host still boots (DSH tolerates a failed
# non-required row). That is not "installing successfully", so treat a load
# failure naming the new package as a failed trial.
newdeps=$(python3 - "$TMP/deps-before.json" "$TRIAL_PROFILE/package.json" <<'PYDIFF'
import json, sys
before = set(json.load(open(sys.argv[1])))
after = json.load(open(sys.argv[2])).get('dependencies', {})
print(' '.join(sorted(set(after) - before)))
PYDIFF
)
for dep in ${newdeps:-}; do
  if grep -qE "(${dep}).*(failed to import|failed to activate|did not activate)|(failed to import|did not activate).*(${dep})" "$LOG"; then
    fail "$SPEC installed but failed to load in the trial — NOT installed"
    grep -nE "(${dep}).*(failed|Error)|failed to import" "$LOG" | head -6
    exit 1
  fi
done

# The token exchange is the path that decides whether a browser can ever get a
# core cookie. A plugin that boots can still turn it into a 500 (that is exactly
# how dsh-webui-auth broke).
token=$(grep -o 'token=[A-Za-z0-9_-]*' "$LOG" | head -1 | cut -d= -f2)
if [ -n "${token:-}" ]; then
  tcode=
  for addr in 172.17.0.1 127.0.0.1; do
    c=$(curl -s -m 3 -o /dev/null -w '%{http_code}' "http://$addr:$port/?token=$token" 2>/dev/null)
    [ -z "$tcode" ] && [ "$c" != "000" ] && tcode=$c
    case "$c" in 200|302|303|401|500) tcode=$c; break ;; esac
  done
  if [ "$tcode" = 500 ]; then
    fail "$SPEC boots but breaks the core token exchange (500) — NOT installed"
    tail -20 "$LOG"
    exit 1
  fi
  say "token exchange: HTTP ${tcode:-none}"
fi

step "trial boot OK (HTTP $code)"
say "boot took under ${TIMEOUT}s; log: $LOG"

if [ "$TEST_ONLY" = 1 ]; then
  step "test-only mode: nothing installed into $PROFILE"
  if [ "$PATCH_PROBLEM" = 1 ]; then
    fail "the trial composition does NOT carry its local patches ($PATCH_REGISTRY)"
    exit 1
  fi
  exit 0
fi

# ── 4. install for real ─────────────────────────────────────────────────────
python3 -c "import json; json.dump(json.load(open('$PROFILE/package.json'))['dsh']['profile']['bundles'], open('$TMP/bundles-before.json','w'))" || exit 1

# pnpm relinks whatever it considers stale, and a relink of a locally patched
# package replaces the patched file with the published one. Snapshot those files
# (with their versions) so they can be put back after the install.
mkdir -p "$TMP/preserved"
for rel in $(local_patch_list); do
  pkg=${rel%%/*}
  src=$PROFILE/node_modules/$rel
  if [ -f "$src" ] && local_patch_present "$rel" "$src"; then
    mkdir -p "$TMP/preserved/$(dirname "$rel")"
    cp "$src" "$TMP/preserved/$rel"
    pkg_version "$PROFILE/node_modules/$pkg" > "$TMP/preserved/$pkg.version"
    say "will preserve local patch: $rel"
  fi
done

step "installing $SPEC into $PROFILE"
if ! ( cd "$CHECKOUT" && pnpm dsh plugin --profile web add "$SPEC" ) 2>&1 | tail -5; then
  fail "the real install failed"
  exit 1
fi

# Restore any preserved patch the install replaced. When the version moved the
# saved file is the wrong code, so skip it; the ensure step below re-derives it.
for saved in $(cd "$TMP/preserved" 2>/dev/null && find . -name '*.js' | sed 's|^\./||'); do
  pkg=${saved%%/*}
  dst=$PROFILE/node_modules/$saved
  before=$(cat "$TMP/preserved/$pkg.version" 2>/dev/null)
  now=$(python3 -c "import json;print(json.load(open('$PROFILE/node_modules/$pkg/package.json'))['version'])" 2>/dev/null)
  if cmp -s "$TMP/preserved/$saved" "$dst"; then
    continue
  fi
  if [ "$before" = "$now" ]; then
    cp "$TMP/preserved/$saved" "$dst"
    printf '\033[33mNOTE\033[0m restored local patch for %s (version unchanged)\n' "$saved"
  else
    printf '\033[33mWARN\033[0m %s moved %s -> %s; its saved patch was not restored\n' \
      "$pkg" "${before:-?}" "${now:-?}"
  fi
done

# Whatever path the install took — restored copy, moved version, first install —
# no registered file may end up without its local patch.
for rel in $(local_patch_list); do
  file=$PROFILE/node_modules/$rel
  [ -f "$file" ] || continue
  if ! local_patch_present "$rel" "$file"; then
    patch_local "$rel" "$file" "real profile" || PATCH_PROBLEM=1
  fi
done

# The install command rewrites the whole bundle list from time to time; a plugin
# installed earlier silently drops out and takes its feature with it (this is how
# dsh-webui-auth once disappeared). Refuse to leave the profile in that state.
missing=$(python3 - "$TMP/bundles-before.json" "$PROFILE/package.json" <<'PY'
import json, sys
before = json.load(open(sys.argv[1]))
after = json.load(open(sys.argv[2]))['dsh']['profile']['bundles']
print(' '.join(b for b in before if b not in after))
PY
)
if [ -n "${missing:-}" ]; then
  printf '\033[33mWARN\033[0m this install dropped bundles that were there before: %s\n' "$missing"
  say "restoring them:"
  for b in $missing; do
    ( cd "$CHECKOUT" && pnpm dsh plugin --profile web add "$b" ) 2>&1 | tail -2
  done
fi

say "bundles now: $(python3 -c "
import json
print(json.load(open('$PROFILE/package.json'))['dsh']['profile']['bundles'])")"

# A local patch that no longer applies is not "installed successfully". Leave the
# running service untouched and say exactly which registry/patcher to fix.
if [ "$PATCH_PROBLEM" = 1 ]; then
  fail "a registered local patch did not apply (registry: $PATCH_REGISTRY)"
  say "the service was left running on the previous code; fix the patcher, re-run it, then restart"
  exit 1
fi

if [ "$RESTART" = 1 ]; then
  step "restarting $SERVICE"
  XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$(id -u)} systemctl --user restart "$SERVICE"
  sleep 3
  say "unit: $(XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$(id -u)} systemctl --user is-active "$SERVICE")"
fi

step "done"
