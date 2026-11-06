// Child-process fixture: drive `dsh_restart` through the fork's tool and print
// the parked wake. It exits immediately after the tool replies, before the
// scheduled 300ms teardown timer can fire — the parent asserts on disk.
process.env.DSH_HOME = process.env.TEST_DSH_HOME
process.env.DSH_RESTART_ANYWHERE_PARENT = String(process.ppid) // detect() -> wrapper/child, no systemd-run

const { apply } = await import('../../lib/index.js')

let tool
const effect = (fn) => { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} }
const said = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] }
const makeAgent = (id, { status = 'running', parentSession, origin, nextTurn = 0, messages = [said] } = {}) => {
  const live = {
    id,
    status,
    inbox: { nextTurn: Array.from({ length: nextTurn }, () => ({ id })), nextStep: [] },
    session: { id, header: { id, ...(parentSession === undefined ? {} : { parentSession }),
      ...(origin === undefined ? {} : { origin }) },
      deriveMessages: () => messages },
    ctx: { effect, tools: { register: (registered) => { tool = registered; return () => {} } } },
  }
  return live
}

const caller = makeAgent('caller', { status: 'running' })
const agents = [
  caller,
  makeAgent('other', { status: 'running', nextTurn: 1 }),
  makeAgent('idle', { status: 'idle' }),
  // An open tab nobody typed into: running driver, no conversation at all.
  makeAgent('blank', { status: 'running', messages: [] }),
  makeAgent('child', { status: 'running', origin: 'subagent', parentSession: 'caller' }),
]
const registry = {
  list: () => agents,
  turnBoundaryOf: (session) => ({ lastTurn: session.id === 'caller' ? 2 : 9 }),
}

const injected = {
  agents: registry,
  on: () => {},
  effect,
}
const ctx = {
  get: (name) => ({ agents: registry, appExit: () => {}, webServer: undefined })[name],
  effect,
  on: () => {},
  connection: { fetch: { register: () => () => {} } },
  inject: (deps, callback) => { if (deps.includes('agents')) callback(injected) },
}

apply(ctx)
if (tool === undefined) throw new Error('dsh_restart was not registered')

const text = await tool.execute({ continue_prompt: 'finish the migration', reason: 'loading the fork' }, { agent: caller })
process.stdout.write(JSON.stringify({ text, name: tool.name }), () => process.exit(0))
