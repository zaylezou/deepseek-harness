// Tests for the fork's wake handoff. A fake Cordis context and a temporary
// DSH_HOME keep this away from the running dsh.
//
//   node --test test/
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

// The wake path is resolved at module load, so DSH_HOME must be final first.
const HOME = mkdtempSync(join(tmpdir(), 'dsh-restart-test-'))
process.env.DSH_HOME = HOME
const WAKE = join(HOME, 'restart-anywhere', 'wake.json')

const plugin = await import('../lib/index.js')
const {
  apply, collectWakes, composeWakeText, isInProgress, normalizeWake, pendingCount,
  readWakeFile, writeWakeFile,
} = plugin

const agent = (id, { status = 'running', parentSession, origin, nextTurn = 0, nextStep = 0, header = {} } = {}) => ({
  id,
  status,
  inbox: { nextTurn: Array.from({ length: nextTurn }, (_, i) => ({ id: `${id}-t${i}` })),
    nextStep: Array.from({ length: nextStep }, (_, i) => ({ id: `${id}-s${i}` })) },
  session: { id, header: { id, ...header, ...(parentSession === undefined ? {} : { parentSession }), ...(origin === undefined ? {} : { origin }) } },
})

const turnOf = values => (session) => values[session.id] ?? 0

test.after(() => { rmSync(HOME, { recursive: true, force: true }) })

test('in-progress means a running turn or queued inbox work', () => {
  assert.equal(isInProgress(agent('a', { status: 'running' })), true)
  assert.equal(isInProgress(agent('b', { status: 'idle', nextTurn: 1 })), true)
  assert.equal(isInProgress(agent('c', { status: 'idle', nextStep: 2 })), true)
  assert.equal(isInProgress(agent('d', { status: 'idle' })), false)
  assert.equal(pendingCount(agent('e', { nextTurn: 1, nextStep: 2 })), 3)
})

test('collectWakes snapshots every in-progress top-level session, caller first', () => {
  const live = [
    agent('idle', { status: 'idle' }),
    agent('child', { parentSession: 'root', origin: 'subagent', nextTurn: 2 }),
    agent('root', { nextTurn: 1 }),
    agent('caller', { nextStep: 1 }),
  ]
  const wakes = collectWakes(live, {
    callerSessionId: 'caller', continuePrompt: 'finish the migration', turnOf: turnOf({ root: 7, caller: 3 }),
  })
  assert.deepEqual(wakes.map(w => w.sessionId), ['caller', 'root'])
  assert.deepEqual(wakes.map(w => w.kind), ['caller', 'interrupted'])
  assert.equal(wakes[0].prompt, 'finish the migration')
  assert.equal(wakes[0].turn, 3)
  assert.equal(wakes[1].turn, 7)
  assert.equal(wakes[1].pending, 1)
})

test('collectWakes keeps the caller even when the registry lost it', () => {
  const wakes = collectWakes([], { callerSessionId: 'caller', continuePrompt: 'go' })
  assert.deepEqual(wakes, [{ sessionId: 'caller', kind: 'caller', prompt: 'go', turn: 0,
    pending: 0, status: 'running', at: wakes[0].at }])
})

test('caller with continue_prompt keeps the upstream wake wording', () => {
  assert.equal(composeWakeText({ kind: 'caller', prompt: 'test the plugin' }),
    'dsh has restarted (you called dsh_restart). Continue:\n\ntest the plugin')
})

test('interrupted session is told what was lost and to continue', () => {
  const text = composeWakeText({ kind: 'interrupted', status: 'running', turn: 4, pending: 2 },
    { reason: 'loading a new plugin' })
  assert.match(text, /previous turn was still running/)
  assert.match(text, /in-flight tool call, subagent, or background job/)
  assert.match(text, /Restart reason: loading a new plugin\./)
  assert.match(text, /2 queued follow-up messages were dropped/)
  assert.match(text, /continue from where you stopped/)
})

test('idle session with a dropped queue gets its own wording', () => {
  const text = composeWakeText({ kind: 'interrupted', status: 'idle', turn: 0, pending: 1 })
  assert.match(text, /before the work you had queued could run/)
  assert.match(text, /1 queued follow-up message was dropped/)
  assert.doesNotMatch(text, /previous turn was still running/)
})

test('v1 wake files still hand off', () => {
  const now = Date.now()
  const wake = normalizeWake({ sessionId: 'old', prompt: 'finish', at: now - 1000 }, now)
  assert.equal(wake.entries.length, 1)
  assert.deepEqual(wake.entries[0], { sessionId: 'old', kind: 'caller', prompt: 'finish',
    turn: 0, pending: 0, status: 'running', at: now - 1000 })
})

test('stale and malformed wakes are dropped, duplicates collapsed', () => {
  const now = Date.now()
  const wake = normalizeWake({ version: 2, at: now, entries: [
    { sessionId: 'fresh', at: now, status: 'running' },
    { sessionId: 'fresh', at: now, status: 'running' },
    { sessionId: 'stale', at: now - 31 * 60_000 },
    { sessionId: '', at: now },
    null,
  ] }, now)
  assert.deepEqual(wake.entries.map(e => e.sessionId), ['fresh'])
})

test('wake file write/read round trip, and only one boot can claim it', () => {
  rmSync(WAKE, { force: true })
  const now = Date.now()
  writeWakeFile([{ sessionId: 'a', kind: 'caller', prompt: 'x', turn: 2, pending: 0, status: 'running', at: now }],
    { reason: 'test', caller: 'a', at: now })
  assert.match(readFileSync(WAKE, 'utf8'), /"version": 2/)
  const first = readWakeFile()
  assert.equal(first.reason, 'test')
  assert.equal(first.caller, 'a')
  assert.equal(first.entries.length, 1)
  assert.deepEqual(readWakeFile().entries, [])
})

test('the tool parks every in-progress session before committing the restart', () => {
  rmSync(WAKE, { force: true })
  const summary = JSON.parse(execFileSync(process.execPath, [join(import.meta.dirname, 'fixtures/tool-restart.js')], {
    encoding: 'utf8', env: { ...process.env, TEST_DSH_HOME: HOME },
  }))
  assert.equal(summary.name, 'dsh_restart')
  assert.match(summary.text, /dsh is restarting now\. 2 in-progress sessions \(this one included\)/)
  const wake = JSON.parse(readFileSync(WAKE, 'utf8'))
  assert.equal(wake.version, 2)
  assert.equal(wake.reason, 'loading the fork')
  assert.equal(wake.caller, 'caller')
  assert.deepEqual(wake.entries.map(entry => entry.sessionId), ['caller', 'other'])
  assert.deepEqual(wake.entries.map(entry => entry.kind), ['caller', 'interrupted'])
  assert.equal(wake.entries[0].prompt, 'finish the migration')
  assert.equal(wake.entries[0].turn, 2)
  assert.equal(wake.entries[1].pending, 1)
})

// ---- apply(): boot half -------------------------------------------------------

const fakeApplyContext = (boot) => {
  const handlers = {}
  const ctx = {
    get: () => undefined,
    effect: (fn) => { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
    inject: (deps, callback) => {
      if (deps.includes('sessionController')) callback(boot)
    },
    on: () => {},
    connection: { fetch: { register: (handler) => { handlers.restart = handler; return () => {} } } },
  }
  return { ctx, handlers }
}

const waitFor = async (check, timeoutMs = 3000) => {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('timed out waiting for condition')
}

test('boot resumes every parked session and isolates failures', async () => {
  rmSync(WAKE, { force: true })
  const now = Date.now()
  writeWakeFile([
    { sessionId: 'caller', kind: 'caller', prompt: 'finish the job', turn: 2, pending: 0, status: 'running', at: now },
    { sessionId: 'gone', kind: 'interrupted', prompt: '', turn: 1, pending: 0, status: 'running', at: now },
    { sessionId: 'other', kind: 'interrupted', prompt: '', turn: 5, pending: 1, status: 'running', at: now },
  ], { reason: 'loading the fork', caller: 'caller', at: now })

  const followups = []
  const flushed = []
  const boot = {
    sessionController: {
      resolveAgent: async (sessionId) => {
        if (sessionId === 'gone') return { error: new Error('session not found') }
        const live = agent(sessionId, { status: 'idle' })
        live.followup = message => { followups.push({ sessionId, message }) }
        return { agent: live }
      },
    },
    sessions: { flush: async (session) => { flushed.push(session.id); return true } },
  }

  const { ctx } = fakeApplyContext(boot)
  apply(ctx)
  await waitFor(() => followups.length === 2)

  assert.deepEqual(followups.map(f => f.sessionId), ['caller', 'other'])
  assert.match(followups[0].message.content[0].text, /^dsh has restarted \(you called dsh_restart\)\. Continue:\n\nfinish the job$/)
  assert.match(followups[1].message.content[0].text, /turn was cut off/)
  assert.equal(followups[1].message.source.kind, 'dsh-restart-anywhere')
  assert.equal(followups[1].message.source.form, 'notice')
  assert.deepEqual(flushed, ['caller', 'other'])
  assert.equal(readWakeFile().entries.length, 0)
})

test('no wake file means no boot work', async () => {
  rmSync(WAKE, { force: true })
  let resolved = 0
  const boot = {
    sessionController: { resolveAgent: async () => { resolved += 1; return { error: new Error('nope') } } },
    sessions: { flush: async () => true },
  }
  apply(fakeApplyContext(boot).ctx)
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(resolved, 0)
})

test('wake file is not read twice across two boot halves', async () => {
  rmSync(WAKE, { force: true })
  const now = Date.now()
  writeWakeFile([{ sessionId: 'once', kind: 'interrupted', prompt: '', turn: 1, pending: 0, status: 'idle', at: now }],
    { at: now })
  let calls = 0
  const boot = {
    sessionController: { resolveAgent: async () => {
      calls += 1
      const live = agent('once', { status: 'idle' })
      live.followup = () => {}
      return { agent: live }
    } },
    sessions: { flush: async () => true },
  }
  apply(fakeApplyContext(boot).ctx)
  apply(fakeApplyContext(boot).ctx)
  await waitFor(() => calls === 1)
  assert.equal(readWakeFile().entries.length, 0)
})
