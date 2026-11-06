// Child-process fixture: drive one of the fork's restart tools and print the
// parked wake. It exits as soon as the wake file is written, before the
// scheduled teardown timer can fire — the parent asserts on disk.
//
//   node test/fixtures/tool-restart.js hard   (default)  dsh_restart
//   node test/fixtures/tool-restart.js safe              dsh_safe_restart
process.env.DSH_HOME = process.env.TEST_DSH_HOME
process.env.DSH_RESTART_ANYWHERE_PARENT = String(process.ppid) // detect() -> wrapper/child, no systemd-run

import { existsSync } from 'node:fs'
import { join } from 'node:path'

const { apply } = await import('../../lib/index.js')
const mode = process.argv[2] === 'safe' ? 'safe' : 'hard'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const tools = []
const effect = (fn) => { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} }
const said = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] }
const makeAgent = (id, { status = 'running', parentSession, origin, nextTurn = 0, messages = [said] } = {}) => ({
  id,
  status,
  inbox: { nextTurn: Array.from({ length: nextTurn }, () => ({ id })), nextStep: [] },
  session: { id, header: { id, ...(parentSession === undefined ? {} : { parentSession }),
    ...(origin === undefined ? {} : { origin }) },
    deriveMessages: () => messages },
  ctx: { effect, tools: { register: (registered) => { tools.push(registered); return () => {} } } },
})

const caller = makeAgent('caller', { status: 'running' })
const other = makeAgent('other', { status: 'running' })
const agents = [
  caller,
  other,
  makeAgent('idle', { status: 'idle' }),
  // An open tab nobody typed into: running driver, no conversation at all.
  makeAgent('blank', { status: 'running', messages: [] }),
  makeAgent('child', { status: 'running', origin: 'subagent', parentSession: 'caller' }),
]
const registry = {
  list: () => agents,
  turnBoundaryOf: (session) => ({ lastTurn: session.id === 'caller' ? 2 : 9 }),
}

const injected = { agents: registry, on: () => {}, effect }
const ctx = {
  get: (name) => ({ agents: registry, appExit: () => {}, webServer: undefined })[name],
  effect,
  on: () => {},
  connection: { fetch: { register: () => () => {} } },
  inject: (deps, callback) => { if (deps.includes('agents')) callback(injected) },
}

apply(ctx)
const tool = tools.find(candidate => candidate.name === (mode === 'safe' ? 'dsh_safe_restart' : 'dsh_restart'))
if (tool === undefined) throw new Error(`${mode} tool was not registered`)

const text = await tool.execute({ continue_prompt: 'finish the migration', reason: 'loading the fork' }, { agent: caller })

if (mode === 'safe') {
  // The tool replied; now this session's turn ends and the other one finishes
  // too, which is exactly what a safe restart waits for.
  caller.status = 'idle'
  other.status = 'idle'
  const wake = join(process.env.TEST_DSH_HOME, 'restart-anywhere', 'wake.json')
  const deadline = Date.now() + 3000
  while (!existsSync(wake)) {
    if (Date.now() > deadline) throw new Error('the safe restart never committed')
    await sleep(20)
  }
}

process.stdout.write(JSON.stringify({ text, name: tool.name }), () => process.exit(0))
