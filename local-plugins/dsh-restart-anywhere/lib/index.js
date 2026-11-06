// dsh-restart-anywhere — host half. One restart button for every way dsh is hosted.
//
// The core trick is restarting *in place*: dsh tears its plugin tree down
// gracefully (ctx.appExit, the launcher's own shutdown path), then the same
// process turns into a fresh dsh. Whatever launched dsh — a terminal, tmux,
// Docker without a restart policy, pm2, Kubernetes, launchd, runit, nssm —
// keeps seeing the same PID that never exited, so no supervisor needs
// detecting or configuring, and terminal output keeps flowing where it was.
//
//   execve   Node >= 22.15 on Linux/macOS: process.execve() swaps the process
//            image for a new dsh. Same PID, nothing left behind.
//   wrapper  Windows / older Node: this process stays alive as a thin parent,
//            starts the fresh dsh as its child, forwards signals and mirrors its
//            exit code. A later restart from inside that child just exits with
//            code 75 and the wrapper starts the next one, so there's never more
//            than one wrapper.
//
// systemd gets its native path first (`systemd-run --on-active=1 systemctl
// restart`): a fresh process with no wrapper left behind. The timer lets this
// HTTP reply reach the browser before systemd stops us. If that fails (a system
// unit without root, say), in-place takes over.
//
// The route sits under /api via ctx.connection.fetch, so dsh's own Host/Origin
// fence and browser-cookie auth apply before this handler ever runs.
//
// Teardown interrupts *every* live session, not just the caller. So before the
// tree goes down, the restart snapshots each top-level session that is still in
// progress (a running turn, or queued inbox work) into a wake file. The next
// dsh reads it on boot and sends every entry a follow-up notice that says the
// restart interrupted it and to continue where it stopped. The session that
// called `dsh_restart` gets its own wake too: its optional continue_prompt is
// the instruction, otherwise it gets the same default "pick up where you left
// off" notice. That is the difference from upstream 0.1.7, which only parked
// one wake for the calling session and let every other running session die
// silently. A stale wake older than WAKE_TTL belongs to a restart that never
// happened and is dropped.
import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const name = 'dsh-restart-anywhere'
export const inject = ['connection']

const RESTART_CODE = 75 // child -> wrapper: "start me again"
const PARENT_ENV = 'DSH_RESTART_ANYWHERE_PARENT'
const BOOT = `${process.pid}-${Date.now()}` // lets the browser tell the new server from the old
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const WAKE_FILE = join(DSH_HOME, 'restart-anywhere', 'wake.json')
const WAKE_VERSION = 2
const WAKE_TTL = 30 * 60_000 // a wake older than this belongs to a restart that never happened
const WAKE_STAGGER_MS = 250 // space out resumed sessions so they don't all call the model at once
const DRAIN_POLL_MS = 500 // safe restart: how often to re-check for a still-running turn
const DRAIN_WAIT_S = 120 // safe restart: default bound before giving up instead of cutting work
const readCgroup = () => { try { return readFileSync('/proc/self/cgroup', 'utf8') } catch { return '' } }

/** The systemd service this process runs in, from its cgroup (v2 or v1); null otherwise. */
export function systemdUnit(cgroup) {
  // v2: "0::/user.slice/user-1000.slice/user@1000.service/app.slice/dsh-web.service"
  // v1: "1:name=systemd:/system.slice/dsh.service"
  const line = cgroup.split('\n').find(l => l.startsWith('0::')) ?? cgroup.split('\n').find(l => l.includes(':name=systemd:'))
  const path = line ? line.slice(line.indexOf(':', line.indexOf(':') + 1) + 1) : ''
  const unit = path.split('/').reverse().find(s => s.endsWith('.service'))
  if (!unit || unit.startsWith('user@')) return null
  return { unit, user: path.includes('/user@') }
}

/** How a restart will happen: { mode: 'systemd' | 'child' | 'in-place' | null, via, ... }. */
export function detect({ platform = process.platform, env = process.env, ppid = process.ppid,
  cgroup = platform === 'linux' ? readCgroup() : '', versions = process.versions, argv = process.argv,
  execve = typeof process.execve === 'function' } = {}) {
  if (versions.electron) return { mode: null, via: 'desktop app' } // the desktop app owns its own lifecycle
  if (env[PARENT_ENV] && env[PARENT_ENV] === String(ppid)) return { mode: 'child', via: 'wrapper' }
  // `--port 0` under systemd: a unit restart would land on a new random port, so stay in place.
  const unit = platform === 'linux' && env.INVOCATION_ID && !randomPort(argv) ? systemdUnit(cgroup) : null
  if (unit) return { mode: 'systemd', via: 'systemd', ...unit }
  return { mode: 'in-place', via: execve && platform !== 'win32' ? 'execve' : 'wrapper' }
}

/** True when dsh was told to pick a random port (`--port 0`), which a plain re-run wouldn't reproduce. */
export const randomPort = (argv = process.argv) =>
  argv.some((a, i) => a === '--port=0' || (a === '--port' && argv[i + 1] === '0'))

/** The command line that started this dsh, ready to spawn again (a random port pinned to `port`). */
export function relaunchArgs(port, execArgv = process.execArgv, argv = process.argv, execPath = process.execPath) {
  // A single-executable build repeats execPath as argv[1].
  const args = [...execArgv, ...argv.slice(argv[1] === execPath ? 2 : 1)]
    .map((a, i, all) => (a === '--port=0' ? `--port=${port}` : a === '0' && all[i - 1] === '--port' ? String(port) : a))
  if (!args.includes('--no-open')) args.push('--no-open') // no new browser tab per restart
  return args
}

/** Resolve once nothing answers on host:port any more (or after `ms`). */
function portFreed(host, port, ms = 15_000) {
  const until = Date.now() + ms
  return new Promise((resolve) => {
    if (!port) return setTimeout(resolve, 2000) // no web server info: give teardown a moment
    const probe = () => {
      const s = connect({ host, port })
      s.once('connect', () => { s.destroy(); Date.now() > until ? resolve() : setTimeout(probe, 150) })
      s.once('error', () => resolve())
    }
    probe()
  })
}

/** Replace this process with a fresh dsh: same PID, same stdio, same environment. */
function execInPlace(port) {
  try {
    process.execve(process.execPath, [process.execPath, ...relaunchArgs(port)], process.env)
  } catch (err) {
    console.warn('dsh-restart-anywhere: execve failed, falling back to a wrapper:', err)
    superviseChild(port)
  }
}

/** Become a thin wrapper: start the fresh dsh as a child, forward signals, mirror its exit. */
function superviseChild(port) {
  const args = relaunchArgs(port)
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.removeAllListeners(sig)
  let child
  const start = () => {
    // POSIX: own process group, so a terminal's Ctrl-C reaches the child once (via
    // our forwarder), not twice. Windows: same console, it gets Ctrl-C directly.
    child = spawn(process.execPath, args, { stdio: 'inherit', detached: process.platform !== 'win32',
      env: { ...process.env, [PARENT_ENV]: String(process.pid) } })
    child.once('exit', (code, signal) => {
      if (code === RESTART_CODE) return start()
      if (signal) { process.removeAllListeners(signal); process.kill(process.pid, signal) } else process.exit(code ?? 1)
    })
    child.once('error', (err) => { console.error('dsh-restart-anywhere: could not start dsh:', err); process.exit(1) })
  }
  // Windows: the child shares our console and gets Ctrl-C / close itself, and
  // child.kill() there is a hard TerminateProcess — so just outlive it.
  const forward = process.platform === 'win32' ? () => {} : (sig) => child?.kill(sig)
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, forward)
  start()
}

const json = (status, body) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } })

/** A subagent child is resumed by its parent, never on its own. */
export const isSubagent = agent => agent?.session?.header?.origin === 'subagent'

/**
 * Sources that carry a harness notice rather than a human turn. `user-approval`
 * is what the session controller injects when the permission preset changes;
 * our own wake notice must not chain another one on the next restart. Kinds are
 * merge-extensible, so anything this fork has never seen counts as real work —
 * dropping an unknown producer's session is worse than one spurious resume.
 */
const NOTICE_SOURCES = new Set(['user-approval', 'dsh-restart-anywhere'])

/** Whether a message is work a resume must continue, rather than a notice. */
export const isHumanWork = message => message !== null && typeof message === 'object'
  && !NOTICE_SOURCES.has(message?.source?.kind)

/** Pending inbox messages, or [] when the agent exposes no readable inbox. */
export function pendingMessages(agent) {
  try { return [...(agent?.inbox?.nextTurn ?? []), ...(agent?.inbox?.nextStep ?? [])] } catch { return [] }
}

/** Pending inbox items, or 0 when the agent exposes no readable inbox. */
export function pendingCount(agent) {
  return pendingMessages(agent).length
}

/**
 * Whether the session has a conversation at all. A chat that was opened but
 * never used has no `user/message` or `assistant/message` in its surface, even
 * though the session controller keeps an Agent alive and may queue permission
 * notices in its inbox; resuming that would make the model invent work. An
 * unreadable transcript counts as a conversation: losing it is worse than a
 * spurious resume.
 */
export function hasConversation(agent) {
  try {
    const messages = agent?.session?.deriveMessages?.()
    if (!Array.isArray(messages)) return true
    return messages.some(message => (message?.role === 'user' || message?.role === 'assistant')
      && isHumanWork(message))
  } catch {
    return true
  }
}

/** Whether a live session would lose work if the process stopped right now. */
export function isInProgress(agent) {
  // Queued work is real work even before the first turn admits it into the
  // surface; a blank chat's queue holds only notices, which do not count.
  if (pendingMessages(agent).some(isHumanWork)) return true
  try { if (agent?.status !== 'running') return false } catch { return false /* a disposed agent is not in progress */ }
  return hasConversation(agent)
}

/**
 * Sessions a safe restart must wait for: top-level sessions whose turn is still
 * running. An idle session with queued work cannot drain by waiting, so it is
 * not here — the commit's snapshot parks it and the next boot resumes it. Blank
 * chats are not work either (see {@link hasConversation}).
 * @param agents - live agents from `ctx.agents.list()`.
 * @returns session ids still working.
 */
export function drainBusy(agents) {
  const busy = []
  for (const agent of agents ?? []) {
    const id = agent?.session?.id
    if (!id || isSubagent(agent)) continue
    try { if (agent.status === 'running' && isInProgress(agent)) busy.push(id) } catch { /* a disposed agent is not working */ }
  }
  return busy
}

/**
 * Snapshot every live top-level session that is still in progress into wake
 * entries. The caller is always represented (with its continue_prompt) so the
 * session that asked for the restart is resumed like every other one.
 * @param agents - live agents from `ctx.agents.list()`.
 * @param options - caller identity, prompt, and turn-boundary reader.
 * @returns wake entries, caller first.
 */
export function collectWakes(agents, { callerSessionId = null, continuePrompt = '', turnOf } = {}) {
  const at = Date.now()
  const wakes = []
  const seen = new Set()
  for (const agent of agents ?? []) {
    const id = agent?.session?.id
    if (!id || seen.has(id) || isSubagent(agent) || !isInProgress(agent)) continue
    seen.add(id)
    const caller = id === callerSessionId
    wakes.push({
      sessionId: id,
      kind: caller ? 'caller' : 'interrupted',
      prompt: caller ? continuePrompt : '',
      turn: typeof turnOf === 'function' ? turnOf(agent.session) : 0,
      pending: pendingCount(agent),
      status: agent.status,
      at,
    })
  }
  if (callerSessionId && !seen.has(callerSessionId)) {
    // The caller is mid-tool-call, so it should be running; never lose its wake
    // to a status race (or to a registry that is mid-teardown).
    wakes.unshift({ sessionId: callerSessionId, kind: 'caller', prompt: continuePrompt,
      turn: 0, pending: 0, status: 'running', at })
  } else {
    wakes.sort((a, b) => Number(b.kind === 'caller') - Number(a.kind === 'caller'))
  }
  return wakes
}

/**
 * The model-facing notice one resumed session receives on boot.
 * @param entry - one wake entry.
 * @param wake - the wake file that carried it, for the reason and session count.
 * @returns the follow-up text.
 */
export function composeWakeText(entry, wake = {}) {
  if (entry.kind === 'caller' && entry.prompt) {
    const called = entry.tool === 'safe' ? 'dsh_safe_restart' : 'dsh_restart'
    return `dsh has restarted (you called ${called}). Continue:\n\n${entry.prompt}`
  }
  const reason = typeof wake.reason === 'string' && wake.reason.trim() ? ` Restart reason: ${wake.reason.trim()}.` : ''
  const dropped = entry.pending > 0
    ? ` ${entry.pending} queued follow-up message${entry.pending === 1 ? ' was' : 's were'} dropped by the restart too.`
    : ''
  if (entry.kind === 'caller') {
    return 'dsh has restarted (you called dsh_restart), and your previous turn was cut off by it. '
      + 'Re-check any tool call, subagent, or background job it was waiting on, then continue the work you were doing.'
      + reason + dropped
  }
  if (entry.status === 'idle') {
    return `dsh restarted before the work you had queued could run.${reason}${dropped} `
      + 'Continue that work from where it stopped: check your task list and recent context for what is still open, '
      + 'and re-verify side effects before repeating them.'
  }
  return 'dsh restarted while your previous turn was still running, so that turn was cut off. '
    + 'Any in-flight tool call, subagent, or background job from it is gone: re-check files and task state before '
    + 'repeating side effects, then continue from where you stopped instead of starting over.'
    + reason + dropped
}

/**
 * Normalize a stored wake file into the current shape. Version 1 (upstream
 * 0.1.7) parked one `{ sessionId, prompt, at }` object for the calling session;
 * version 2 parks every in-progress session. Entries older than WAKE_TTL and
 * duplicates are dropped.
 * @param raw - parsed JSON from the wake file.
 * @param now - current epoch milliseconds.
 * @returns the normalized wake, possibly empty.
 */
export function normalizeWake(raw, now = Date.now()) {
  const wake = { version: WAKE_VERSION, at: 0, reason: '', caller: null, entries: [] }
  if (raw === null || typeof raw !== 'object') return wake
  wake.at = Number.isFinite(raw.at) ? raw.at : 0
  wake.reason = typeof raw.reason === 'string' ? raw.reason : ''
  wake.caller = typeof raw.caller === 'string' ? raw.caller : null
  const listed = Array.isArray(raw.entries) ? raw.entries : typeof raw.sessionId === 'string' ? [raw] : []
  const seen = new Set()
  for (const item of listed) {
    if (item === null || typeof item !== 'object') continue
    const sessionId = typeof item.sessionId === 'string' && item.sessionId ? item.sessionId : null
    if (!sessionId || seen.has(sessionId)) continue
    const at = Number.isFinite(item.at) ? item.at : wake.at
    if (now - at > WAKE_TTL) continue
    seen.add(sessionId)
    const prompt = typeof item.prompt === 'string' ? item.prompt : ''
    wake.entries.push({
      sessionId,
      kind: item.kind === 'caller' || (!item.kind && prompt) ? 'caller' : 'interrupted',
      prompt,
      turn: Number.isFinite(item.turn) ? item.turn : 0,
      pending: Number.isFinite(item.pending) ? item.pending : 0,
      status: typeof item.status === 'string' ? item.status : 'running',
      at,
      // Present only for a safe restart, so the resumed session is told which
      // tool restarted dsh; an absent key keeps v2 files from before it intact.
      ...(item.tool === 'safe' ? { tool: 'safe' } : {}),
    })
  }
  return wake
}

/** Atomically park the wake this restart owes the next dsh. */
export function writeWakeFile(entries, { reason = '', caller = null, at = Date.now(), path = WAKE_FILE } = {}) {
  mkdirSync(dirname(path), { recursive: true })
  const body = JSON.stringify({ version: WAKE_VERSION, at, reason, caller, entries }, null, 2)
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, body)
  renameSync(tmp, path)
}

/** Claim and read the wake left by the previous dsh, if it is still fresh. */
export function readWakeFile({ now = Date.now(), path = WAKE_FILE } = {}) {
  let raw
  try {
    // Rename first: only one boot can own the file, even if two dsh processes
    // race on the same DSH_HOME.
    const claim = `${path}.${process.pid}.reading`
    renameSync(path, claim)
    try { raw = JSON.parse(readFileSync(claim, 'utf8')) } finally { rmSync(claim, { force: true }) }
  } catch {
    return { version: WAKE_VERSION, at: 0, reason: '', caller: null, entries: [] }
  }
  return normalizeWake(raw, now)
}

/** One follow-up message delivered to a resumed session. */
function wakeMessage(entry, wake) {
  return Object.freeze({
    id: randomUUID(), role: 'user',
    content: Object.freeze([Object.freeze({ type: 'text', text: composeWakeText(entry, wake) })]),
    source: Object.freeze({ kind: 'dsh-restart-anywhere', form: 'notice',
      summary: entry.kind === 'caller' ? 'dsh restarted; continuing' : 'dsh restarted; resuming your interrupted work' }),
  })
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

export function apply(ctx) {
  let restarting = false
  /** A safe restart waiting for running turns, or null. */
  let pending = null

  const agents = () => ctx.get('agents')
  const turns = session => {
    try {
      const boundary = agents()?.turnBoundaryOf?.(session)
      return Number.isFinite(boundary?.lastTurn) ? boundary.lastTurn : 0
    } catch { return 0 }
  }

  const liveAgents = () => {
    try { return agents()?.list?.() ?? [] } catch { return [] }
  }

  const clampWait = ms => Math.min(Math.max(Number.isFinite(ms) ? ms : DRAIN_WAIT_S * 1000, 5_000), 3_600_000)

  const drainState = () => {
    const busy = drainBusy(liveAgents())
    return { until: pending?.deadline ?? 0, waiting: busy.length, sessions: busy }
  }

  /** Tell the caller its safe restart was cancelled: a follow-up, so it wakes. */
  const notifyCancelled = async (sessionId, text, why) => {
    console.warn(`dsh-restart-anywhere: ${why}`)
    if (!sessionId) return
    try {
      const sessionController = ctx.get('sessionController')
      const sessions = ctx.get('sessions')
      const found = await sessionController?.resolveAgent?.(sessionId)
      if (!found || 'error' in found) throw found?.error ?? new Error('session not found')
      found.agent.followup({ id: randomUUID(), role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'dsh-restart-anywhere', form: 'notice', summary: 'safe restart cancelled' } })
      if (sessions) await sessions.flush(found.agent.session)
    } catch (err) {
      console.warn(`dsh-restart-anywhere: could not tell session ${sessionId} the safe restart was cancelled:`, err)
    }
  }

  /** One drain check: commit once nothing is running, give up at the deadline. */
  const drainTick = () => {
    if (pending === null) return
    const busy = drainBusy(liveAgents())
    if (busy.length === 0) {
      const request = pending.request
      pending = null
      console.info('dsh-restart-anywhere: every session is idle; performing the safe restart')
      void restart({ ...request, drained: true, tool: 'safe' })
      return
    }
    const left = pending.deadline - Date.now()
    if (left <= 0) {
      const request = pending.request
      pending = null
      const seconds = Math.round(request.windowMs / 1000)
      const names = busy.join(', ')
      const text = `dsh did NOT restart: ${busy.length} session${busy.length === 1 ? ' was' : 's were'} still working after ${seconds}s (${names}). Nothing was interrupted.`
        + ' Call dsh_safe_restart again to keep waiting, or dsh_restart to restart immediately.'
      void notifyCancelled(request.callerSessionId, text,
        `safe restart cancelled after ${seconds}s; still running: ${names}`)
      return
    }
    setTimeout(drainTick, DRAIN_POLL_MS)
  }

  /** Schedule a drain; returns the same [status, body] shape the route and tools render. */
  const schedule = (request, windowMs) => {
    const how = detect()
    if (!how.mode) return [409, { ok: false, error: `restart is not supported in the ${how.via}` }]
    if (restarting) return [409, { ok: false, error: 'a restart is already in progress' }]
    if (pending !== null) return [409, { ok: false, error: 'a safe restart is already waiting for sessions to finish' }]
    const ending = Date.now() + windowMs
    pending = { request: { ...request, windowMs }, deadline: ending, windowMs }
    const busy = drainBusy(liveAgents())
    if (request.callerSessionId) {
      // The caller's own turn must end for the drain to finish; it is expected
      // in the list, so this is a note in the log, not a problem.
      console.info(`dsh-restart-anywhere: safe restart scheduled (up to ${Math.round(windowMs / 1000)}s); waiting for ${busy.length} session(s): ${busy.join(', ') || 'none'}`)
    } else {
      console.info(`dsh-restart-anywhere: safe restart scheduled from the sidebar (up to ${Math.round(windowMs / 1000)}s); waiting for ${busy.length} session(s)`)
    }
    setTimeout(drainTick, DRAIN_POLL_MS)
    return [202, { ok: true, ...how, boot: BOOT, draining: true, until: ending, waiting: busy.length, sessions: busy }]
  }

  /** Snapshot in-progress sessions; a broken registry must not block the restart. */
  const snapshot = (request) => {
    try {
      const live = agents()?.list?.() ?? []
      const wakes = collectWakes(live, { callerSessionId: request.callerSessionId,
        continuePrompt: request.continuePrompt ?? '', turnOf: turns })
      // Say why an open tab is not resumed: "a restart left my empty chat
      // alone" is the expected outcome, and the log is where that is visible.
      const parked = new Set(wakes.map(entry => entry.sessionId))
      const skipped = live.filter(agent => {
        const id = agent?.session?.id
        if (!id || parked.has(id) || isSubagent(agent)) return false
        try { return agent.status === 'running' || pendingCount(agent) > 0 } catch { return false }
      })
      if (skipped.length > 0) {
        console.info(`dsh-restart-anywhere: left ${skipped.length} unused session(s) alone: ${skipped.map(agent => agent.session.id).join(', ')}`)
      }
      return wakes
    } catch (err) {
      console.warn('dsh-restart-anywhere: could not snapshot running sessions:', err)
      return request.callerSessionId
        ? collectWakes([], { callerSessionId: request.callerSessionId, continuePrompt: request.continuePrompt ?? '' })
        : []
    }
  }

  const inPlace = (how) => {
    const web = ctx.get('webServer')
    const host = !web?.host || web.host === '0.0.0.0' || web.host === '::' ? '127.0.0.1' : web.host
    const appExit = ctx.get('appExit')
    if (!appExit) throw new Error('this dsh launcher has no graceful exit hook (ctx.appExit)')
    // Let the reply reach the browser, then shut the tree down; the port closing
    // is the signal that teardown is done and the next dsh can bind it.
    setTimeout(() => {
      appExit(how.mode === 'child' ? RESTART_CODE : 0)
      portFreed(host, web?.port).then(() => {
        if (how.mode === 'child') process.exit(RESTART_CODE)
        else if (how.via === 'execve') execInPlace(web?.port)
        else superviseChild(web?.port)
      })
    }, 300)
  }

  /**
   * Start a restart; resolves to [httpStatus, body] once it's committed (or
   * refused). Every in-progress top-level session is parked in the wake file
   * before the tree goes down, the caller included.
   * @param request - caller session, its continue prompt, an optional reason,
   *   and for a drained (safe) restart `drained: true` plus `tool: 'safe'`.
   */
  const restart = async (request = {}) => {
    let how = detect()
    if (!how.mode) return [409, { ok: false, error: `restart is not supported in the ${how.via}` }]
    if (restarting) return [409, { ok: false, error: 'a restart is already in progress' }]
    if (pending !== null) {
      // An immediate restart supersedes a drain the caller no longer wants to wait for.
      pending = null
      console.info('dsh-restart-anywhere: immediate restart superseded the safe restart that was waiting')
    }
    restarting = true
    try {
      const wakes = snapshot(request)
      // A safe restart waited for every running turn to finish, so apart from
      // the caller (which only wants its continue_prompt) there is nothing to
      // resume. A session that slipped back into work during the commit window
      // is still parked as interrupted by the snapshot above.
      const parked = request.drained === true
        ? wakes.filter(entry => entry.kind !== 'caller' || (request.continuePrompt ?? '') !== '')
          .map(entry => (entry.kind === 'caller' ? { ...entry, tool: request.tool ?? 'dsh_restart' } : entry))
        : wakes
      // Park the handoff before any commit path: a systemd unit restart does
      // not run this process's teardown, and a crash between here and the new
      // process must still leave every interrupted session on disk.
      writeWakeFile(parked, { reason: request.reason ?? '', caller: request.callerSessionId ?? null })
      if (how.mode === 'systemd') {
        const scope = how.user ? ['--user'] : []
        const args = [...scope, '--on-active=1', '--timer-property=AccuracySec=100ms', 'systemctl', ...scope, 'restart', how.unit]
        const failed = await new Promise(resolve => execFile('systemd-run', args, { timeout: 10_000 },
          (err, _out, stderr) => resolve(err ? (stderr || err.message).trim() : null)))
        if (!failed) return [202, { ok: true, ...how, boot: BOOT, resuming: parked.length }]
        console.warn(`dsh-restart-anywhere: systemd-run failed (${failed}); restarting in place`)
        how = { ...detect({ env: {} }), fallback: failed }
      }
      inPlace(how)
      return [202, { ok: true, ...how, boot: BOOT, resuming: parked.length }]
    } catch (err) {
      // We are not restarting after all: do not wake anyone on the next boot.
      rmSync(WAKE_FILE, { force: true })
      restarting = false
      return [500, { ok: false, error: err instanceof Error ? err.message : String(err) }]
    }
  }

  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/dsh-restart',
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      if (request.method === 'GET') {
        return json(200, { ...detect(), boot: BOOT, ...(pending === null ? {} : { draining: drainState() }) })
      }
      const url = new URL(request.url, 'http://localhost')
      if (url.searchParams.get('when') === 'idle') {
        // The browser's safe row: drain first, then restart, without a caller.
        const wait = clampWait(Number(url.searchParams.get('wait') ?? DRAIN_WAIT_S) * 1000)
        return json(...schedule({ reason: url.searchParams.get('reason') ?? '' }, wait))
      }
      return json(...await restart())
    },
  }), 'dsh-restart-anywhere: /api/dsh-restart')

  const tool = {
    name: 'dsh_restart',
    description: 'Restart dsh itself, e.g. to load a plugin you just installed or changed, or a config change that needs a restart. '
      + 'Call it last: this session stops while dsh restarts (a few seconds). Every session that is still in progress, this one '
      + 'included, is interrupted and then resumed automatically after the restart with a notice saying it was cut off and to '
      + 'continue where it stopped. Pass continue_prompt to give this session its own instruction for the resumed turn; pass '
      + 'reason to tell every resumed session why the restart happened. This is the immediate (hard) restart: for one that waits '
      + 'for running turns to finish, call dsh_safe_restart instead.',
    parameters: { type: 'object', properties: {
      continue_prompt: { type: 'string',
        description: 'What this session should do once dsh is back, e.g. "Plugin X is installed now; test its tool and finish issue #12." Omit for the default "continue where you stopped" notice.' },
      reason: { type: 'string',
        description: 'Optional short reason included in every resumed session\'s notice, e.g. "loading the updated restart plugin".' },
    } },
    output: { schema: { type: 'string' }, render: (_args, text) => [{ type: 'text', text }] },
    async execute(args, exec) {
      const prompt = typeof args?.continue_prompt === 'string' ? args.continue_prompt.trim() : ''
      const reason = typeof args?.reason === 'string' ? args.reason.trim() : ''
      const callerSessionId = exec.agent.session.id
      const [status, body] = await restart({ callerSessionId, continuePrompt: prompt, reason })
      if (status !== 202) throw new Error(`dsh restart refused: ${body.error}`)
      const resuming = body.resuming ?? 1
      const sessions = `${resuming} in-progress session${resuming === 1 ? '' : 's'}`
      return prompt
        ? `dsh is restarting now. ${sessions} (this one included) will be resumed once dsh is back; this session will get your continue_prompt. End your turn.`
        : `dsh is restarting now. ${sessions} (this one included) will be resumed once dsh is back with a "continue where you stopped" notice. End your turn.`
    },
  }

  /**
   * The safe tool: let every running turn finish, then restart. The caller
   * cannot wait inside this call — its own turn is the one that must end for the
   * drain to finish — so the wait is scheduled and the tool returns immediately.
   */
  const safeTool = {
    name: 'dsh_safe_restart',
    description: 'Restart dsh without cutting anyone off: wait until every session has finished the turn it is running, '
      + 'then restart. Nothing is interrupted and nothing needs resuming, so other sessions get no notice at all. '
      + 'Call it last and end your turn: this session is part of what must go idle, and the restart happens right after it does. '
      + 'If a session is still working at max_wait_seconds, the restart is cancelled (nothing is cut off) and this session is '
      + 'told so in a follow-up message. Use dsh_restart when you need the restart immediately instead.',
    parameters: { type: 'object', properties: {
      continue_prompt: { type: 'string',
        description: 'What this session should do once dsh is back. Omit to stay silent: a safe restart wakes nobody, including this session, because nothing was cut off.' },
      reason: { type: 'string',
        description: 'Optional short reason, recorded in the log and in any wake this restart still has to park.' },
      max_wait_seconds: { type: 'number',
        description: `How long to wait for running turns before giving up instead of cutting them (default ${DRAIN_WAIT_S}, at most 3600).` },
    } },
    output: { schema: { type: 'string' }, render: (_args, text) => [{ type: 'text', text }] },
    async execute(args, exec) {
      const prompt = typeof args?.continue_prompt === 'string' ? args.continue_prompt.trim() : ''
      const reason = typeof args?.reason === 'string' ? args.reason.trim() : ''
      const requested = Number(args?.max_wait_seconds)
      const wait = clampWait(Number.isFinite(requested) && requested > 0 ? requested * 1000 : DRAIN_WAIT_S * 1000)
      const callerSessionId = exec.agent.session.id
      const [status, body] = schedule({ callerSessionId, continuePrompt: prompt, reason }, wait)
      if (status !== 202) throw new Error(`safe restart refused: ${body.error}`)
      const seconds = Math.round(wait / 1000)
      return `dsh will restart as soon as every session has finished the turn it is running (waiting up to ${seconds}s; `
        + `${body.waiting} still working right now). End your turn now — this session is one of them. `
        + (prompt
          ? 'You will be woken with your continue_prompt after the restart.'
          : 'Nothing will be resumed and nobody is woken, because nothing is cut off.')
    },
  }

  // Tools are per agent; root sessions only, so a subagent can't restart dsh under its parent.
  ctx.inject(['agents'], (ctx) => {
    const isRoot = agent => agent?.session?.header?.parentSession === undefined
    const attach = (agent) => {
      if (isRoot(agent)) {
        ctx.effect(() => agent.ctx.effect(() => {
          const off = agent.ctx.tools.register(tool)
          const offSafe = agent.ctx.tools.register(safeTool)
          return () => { off(); offSafe() }
        }))
      }
    }
    ctx.on('agent/created', ({ agent }) => attach(agent))
    for (const agent of ctx.agents.list()) attach(agent)
  })

  // Boot: resume every session the previous dsh parked in the wake file —
  // not just the caller. Each resumed session gets its own follow-up turn, and
  // one failure never stops the rest.
  ctx.inject(['sessionController', 'sessions'], (boot) => {
    const wake = readWakeFile()
    if (wake.entries.length === 0) return
    void (async () => {
      for (const [index, entry] of wake.entries.entries()) {
        if (index > 0) await sleep(WAKE_STAGGER_MS)
        try {
          const found = await boot.sessionController.resolveAgent(entry.sessionId)
          if ('error' in found) throw found.error
          found.agent.followup(wakeMessage(entry, wake))
          const flushed = await boot.sessions.flush(found.agent.session)
          if (!flushed) throw new Error('Session persistence did not acknowledge the wake')
          console.info(`dsh-restart-anywhere: resumed ${entry.kind} session ${entry.sessionId} after the restart`)
        } catch (err) {
          console.warn(`dsh-restart-anywhere: could not resume session ${entry.sessionId} after restart:`, err)
        }
      }
    })()
  })
}
