import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  DEFAULTS,
  apply,
  canonicalPath,
  canonicalRoot,
  guardDecision,
  insideRoot,
  lockMode,
  lockPolicy,
} from '../src/index.js'

function fakeSession(cwd, options = {}) {
  const events = []
  const session = {
    cwd,
    sandboxMode: options.sandboxMode,
    approvalPolicy: options.approvalPolicy,
    events,
    append(type, data) {
      events.push({ type, data })
      if (type === 'sandbox/mode') session.sandboxMode = data.mode
      if (type === 'approval/policy') session.approvalPolicy = data.policy
    },
  }
  return session
}

function fakePolicy() {
  return {
    defaultMode: 'workspace-write',
    resolve(request = {}) {
      return {
        mode: request.mode ?? 'workspace-write',
        workspaceRoot: request.session?.cwd ?? '/process/cwd',
        sessionId: 'session-x',
        additionalWritableRoots: ['/extra'],
      }
    },
    overrideOf(session) {
      return session.sandboxMode
    },
  }
}

function fakeShell() {
  return {
    sandboxMode: 'workspace-write',
    resolve(request = {}) {
      return {
        command: 'true',
        workdir: '/work',
        sandboxPolicy: request.sandboxPolicy ?? { mode: 'workspace-write', workspaceRoot: '/process/cwd' },
      }
    },
    execute(spec) {
      return spec
    },
  }
}

function fakeApproval() {
  return {
    config: { policy: 'ask' },
    calls: [],
    async request(request) {
      this.calls.push(request)
      return 'unavailable'
    },
    overrideOf(session) {
      return session.approvalPolicy
    },
  }
}

function fakeTools() {
  const guards = []
  return {
    guards,
    guard(fn) {
      guards.push(fn)
      return () => { guards.splice(guards.indexOf(fn), 1) }
    },
  }
}

function fakeWorkspaceRegistry(root) {
  return {
    created: [],
    async create(path) { this.created.push(path); return { path } },
    async initializeDefault(resolveDirectory) { return { path: await resolveDirectory() } },
  }
}

function fakeSessionController() {
  return {
    created: [],
    opened: 0,
    async create(request) { this.created.push(request); return { sessionId: 'session-x' } },
    async openWorkspacePath() { this.opened += 1; return 'opened' },
  }
}

function fakeDirectoryPicker() {
  return {
    created: [],
    async createDirectory(path, name) { this.created.push([path, name]); return `${path}/${name}` },
  }
}

function fakeTerminalController() {
  return {
    created: 0,
    async create() { this.created += 1; return 'ok' },
  }
}

function fakePluginManager() {
  const manager = {
    calls: [],
    listPlugins: async () => 'ok',
  }
  for (const method of ['installBundle', 'setBundleEnabled', 'setPluginEnabled', 'removeBundle', 'updateBundle', 'setVersionExemption']) {
    manager[method] = async (...args) => { manager.calls.push([method, ...args]); return 'ok' }
  }
  return manager
}

function fakeContext({ root, policy = fakePolicy(), shell = fakeShell(), approval = fakeApproval() } = {}) {
  const listeners = []
  const effects = []
  const services = {
    approval,
    tools: fakeTools(),
    workspaceRegistry: fakeWorkspaceRegistry(root),
    sessionController: fakeSessionController(),
    pluginManager: fakePluginManager(),
    terminalController: fakeTerminalController(),
    directoryPickerController: fakeDirectoryPicker(),
    workingDirectory: {
      get(session) { return session.cwd },
    },
  }
  const logs = { info: [], warn: [] }
  const ctx = {
    sandboxPolicy: policy,
    shell,
    approval,
    tools: services.tools,
    workspaceRegistry: services.workspaceRegistry,
    sessionController: services.sessionController,
    pluginManager: services.pluginManager,
    terminalController: services.terminalController,
    directoryPickerController: services.directoryPickerController,
    logger: {
      info(message) { logs.info.push(String(message)) },
      warn(message) { logs.warn.push(String(message)) },
    },
    effect(fn) {
      effects.push(fn)
      return () => { effects.splice(effects.indexOf(fn), 1) }
    },
    on(event, fn, options) {
      listeners.push({ event, fn, options })
      return () => { listeners.splice(listeners.findIndex((item) => item.fn === fn), 1) }
    },
    inject(names, fn) {
      for (const name of names) {
        if (services[name] === undefined) return
      }
      fn(ctx)
    },
    get(name) {
      return services[name]
    },
  }
  return { ctx, listeners, effects, services, logs, policy, shell, approval }
}

function restore(effects) {
  const disposer = effects[0]()
  disposer()
}

test('lockMode clamps danger-full-access and keeps read-only narrower', () => {
  assert.equal(lockMode('danger-full-access', 'workspace-write'), 'workspace-write')
  assert.equal(lockMode('workspace-write', 'read-only'), 'read-only')
  assert.equal(lockMode('read-only', 'workspace-write'), 'read-only')
  assert.equal(lockMode('something-else', 'workspace-write'), 'workspace-write')
})

test('lockPolicy pins the mode and root and drops extra writable roots', () => {
  const policy = lockPolicy({ mode: 'danger-full-access', workspaceRoot: '/etc', additionalWritableRoots: ['/srv'], sessionId: 's1' }, '/tmp/root', 'workspace-write')
  assert.deepEqual(policy, { mode: 'workspace-write', workspaceRoot: '/tmp/root', sessionId: 's1' })
})

test('insideRoot rejects parents, siblings and traversal', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-e2e-lockdown-'))
  try {
    const root = join(base, 'instance')
    const inside = join(root, 'src')
    const outside = join(base, 'other')
    await mkdir(inside, { recursive: true })
    await mkdir(outside, { recursive: true })
    assert.equal(insideRoot(root, inside), true)
    assert.equal(insideRoot(root, root), true)
    assert.equal(insideRoot(root, outside), false)
    assert.equal(insideRoot(root, join(root, '..', 'other')), false)
    assert.equal(insideRoot(root, '/'), false)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('insideRoot sees through a symlink that points outside', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-e2e-lockdown-'))
  try {
    const root = join(base, 'instance')
    const outside = join(base, 'outside')
    await mkdir(root, { recursive: true })
    await mkdir(outside, { recursive: true })
    const link = join(root, 'escape')
    await symlink(outside, link)
    assert.equal(insideRoot(root, link), false)
    assert.equal(insideRoot(root, join(link, 'child')), false)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('canonicalRoot requires an existing absolute directory', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-e2e-lockdown-'))
  try {
    const root = join(base, 'instance')
    await mkdir(root, { recursive: true })
    assert.equal(canonicalRoot(root), canonicalPath(root))
    assert.throws(() => canonicalRoot(''), /workspaceRoot is required/)
    assert.throws(() => canonicalRoot('relative/dir'), /must be absolute/)
    assert.throws(() => canonicalRoot(join(base, 'missing')), /does not exist/)
    await writeFile(join(base, 'file'), 'x')
    assert.throws(() => canonicalRoot(join(base, 'file')), /not a directory/)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('apply clamps policy, shell, approvals, tools and cwd entry points', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-e2e-lockdown-'))
  try {
    const root = join(base, 'instance')
    const inside = join(root, 'src')
    await mkdir(inside, { recursive: true })
    const { ctx, listeners, effects, services, policy, shell, approval, logs } = fakeContext({ root })

    apply(ctx, {
      mode: 'always',
      workspaceRoot: root,
      sandboxMode: 'workspace-write',
    })

    // Policy clamp: explicit danger and a session cwd outside the root both lose.
    const clamped = policy.resolve({ mode: 'danger-full-access', session: { cwd: '/home/someone' } })
    assert.equal(clamped.mode, 'workspace-write')
    assert.equal(clamped.workspaceRoot, canonicalPath(root))
    assert.equal('additionalWritableRoots' in clamped, false)
    assert.equal(policy.defaultMode, 'workspace-write')

    // Shell clamp: a plugin handing over danger gets the locked policy.
    const shellSpec = shell.resolve({ sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: '/etc' } })
    assert.equal(shellSpec.sandboxPolicy.mode, 'workspace-write')
    assert.equal(shellSpec.sandboxPolicy.workspaceRoot, canonicalPath(root))
    const executed = shell.execute({ ...shellSpec, sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: '/etc' } })
    assert.equal(executed.sandboxPolicy.mode, 'workspace-write')

    // Approval: default never, a pre-existing ask is rewritten before the answerer runs.
    assert.equal(approval.config.policy, 'never')
    const session = fakeSession(inside, { approvalPolicy: 'ask', sandboxMode: 'danger-full-access' })
    await approval.request({ agent: { session }, toolName: 'bash', reason: 'x' })
    assert.deepEqual(session.events.map((event) => event.type), ['approval/policy'])
    assert.equal(session.approvalPolicy, 'never')

    const denyAll = listeners.find((item) => item.event === 'approval/request')
    assert.ok(denyAll, 'a deny-all approval/request listener is registered')
    assert.equal(denyAll.options?.prepend, true)
    assert.equal(await denyAll.fn({}, async () => 'unavailable'), 'rejected')

    // agent/created re-pins a restored danger/ask session.
    const created = listeners.find((item) => item.event === 'agent/created')
    assert.ok(created)
    assert.equal(created.options?.prepend, true)
    const restored = fakeSession(inside, { sandboxMode: 'danger-full-access', approvalPolicy: 'ask' })
    created.fn({ agent: { session: restored } })
    assert.deepEqual(restored.events.map((event) => event.type), ['sandbox/mode', 'approval/policy'])
    assert.equal(restored.sandboxMode, 'workspace-write')
    assert.equal(restored.approvalPolicy, 'never')

    // Tool guard.
    const guard = services.tools.guards[0]
    assert.ok(guard, 'a monotonic tool guard is registered')
    const call = (name, args, cwd = inside) => guard({ name, arguments: args, agent: { session: fakeSession(cwd) } })
    assert.match(call('plugin_manager', { action: 'list_plugins' }), /disabled in this locked instance/)
    assert.match(call('bash', { command: 'id', sandbox_permissions: 'danger-full-access', justification: 'because' }), /escalation is disabled/)
    assert.match(call('bash', { command: 'id', justification: 'because' }), /escalation is disabled/)
    assert.equal(call('bash', { command: 'id' }), undefined)
    assert.match(call('bash', { command: 'docker ps' }), /host-control command "docker" is disabled/)
    assert.match(call('bash', { command: '/usr/bin/systemctl --user restart dsh-web.service' }), /host-control command "systemctl" is disabled/)
    assert.match(call('bash', { command: 'sudo -n true' }), /host-control command "sudo" is disabled/)
    assert.match(call('subagent', { cwd: '/tmp' }), /outside the locked workspace/)
    assert.equal(call('subagent', { cwd: join(inside, 'child') }), undefined)
    assert.equal(call('subagent', { cwd: 'child' }), undefined)
    assert.match(call('working_directory', { cd: '../..' }), /outside the locked workspace/)
    assert.equal(call('working_directory', { cd: 'src' }), undefined)
    assert.match(call('schedule_create', { target: { kind: 'new', create: { cwd: '/etc' } } }), /outside the locked workspace/)

    // Workspace and session creation cannot step outside the root.
    await assert.rejects(services.workspaceRegistry.create('/etc'), /inside/)
    await services.workspaceRegistry.create(inside)
    assert.equal((await services.workspaceRegistry.initializeDefault()).path, canonicalPath(root))
    await assert.rejects(services.sessionController.create({ cwd: '/etc' }), /session cwd must stay inside/)
    await services.sessionController.create({ cwd: inside })
    await assert.rejects(services.sessionController.openWorkspacePath('/etc'), /opening workspace paths/)
    assert.equal(services.sessionController.opened, 0)

    // The plugin-manager service stays present for the standard preset, but every
    // write path rejects; reads still work.
    for (const method of ['installBundle', 'setBundleEnabled', 'setPluginEnabled', 'removeBundle', 'updateBundle', 'setVersionExemption']) {
      await assert.rejects(services.pluginManager[method]('x'), /plugin management is disabled/)
    }
    assert.equal(await services.pluginManager.listPlugins(), 'ok')
    assert.equal(services.pluginManager.calls.length, 0)
    await assert.rejects(services.terminalController.create(), /browser terminals are disabled/)
    assert.equal(services.terminalController.created, 0)
    await assert.rejects(services.directoryPickerController.createDirectory('/etc', 'evil'), /outside/)
    await services.directoryPickerController.createDirectory(inside, 'ok')
    assert.deepEqual(services.directoryPickerController.created, [[inside, 'ok']])

    assert.ok(logs.info.some((line) => line.includes('active: mode<=workspace-write')))

    // Unload restores the original surface.
    restore(effects)
    assert.equal(policy.resolve({ mode: 'danger-full-access' }).mode, 'danger-full-access')
    assert.equal(policy.defaultMode, 'workspace-write')
    assert.equal(shell.resolve({ sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: '/etc' } }).sandboxPolicy.mode, 'danger-full-access')
    assert.equal(await services.pluginManager.installBundle('x'), 'ok')
    assert.equal(await services.sessionController.openWorkspacePath('/etc'), 'opened')
    assert.equal(await services.terminalController.create(), 'ok')
    assert.equal(await services.directoryPickerController.createDirectory('/etc', 'evil'), '/etc/evil')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('inactive modes leave the services untouched', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-e2e-lockdown-'))
  const previous = process.env.DSH_E2E_INSTANCE
  try {
    const root = join(base, 'instance')
    await mkdir(root, { recursive: true })
    for (const mode of ['off', 'auto']) {
      delete process.env.DSH_E2E_INSTANCE
      const { ctx, services } = fakeContext({ root })
      apply(ctx, { mode, workspaceRoot: root })
      const session = fakeSession(root, { approvalPolicy: 'ask' })
      await services.approval.request({ agent: { session } })
      assert.deepEqual(session.events, [])
      assert.equal(services.approval.config.policy, 'ask')
      assert.equal(services.tools.guards.length, 0)
    }
  } finally {
    if (previous === undefined) delete process.env.DSH_E2E_INSTANCE
    else process.env.DSH_E2E_INSTANCE = previous
    await rm(base, { recursive: true, force: true })
  }
})

test('apply refuses a missing or unconfined executor instead of pretending', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-e2e-lockdown-'))
  try {
    const root = join(base, 'instance')
    await mkdir(root, { recursive: true })
    const { ctx, shell } = fakeContext({ root })
    shell.sandboxMode = undefined
    assert.throws(() => apply(ctx, { mode: 'always', workspaceRoot: root }), /does not confine/)
    const { ctx: ctx2 } = fakeContext({ root })
    assert.throws(() => apply(ctx2, { mode: 'always', workspaceRoot: root, sandboxMode: 'danger-full-access' }), /sandboxMode must be/)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('defaults stay fail-closed', () => {
  assert.equal(DEFAULTS.mode, 'auto')
  assert.equal(DEFAULTS.sandboxMode, 'workspace-write')
  assert.ok(DEFAULTS.denyTools.includes('plugin_manager'))
  assert.ok(DEFAULTS.denyTools.includes('e2e_instance'))
  assert.ok(DEFAULTS.denyTools.includes('dsh_restart'))
  assert.ok(DEFAULTS.denyShellCommands.includes('docker'))
  assert.equal(guardDecision({ name: 'bash', arguments: { sandbox_permissions: 'workspace-write', justification: 'same mode' } }, {
    root: '/tmp/root', denyTools: new Set(), guardCwdTools: true, guardEscalationArgs: true,
  }).startsWith('[dsh-e2e-lockdown]'), true)
  assert.equal(guardDecision({ name: 'bash', arguments: { command: 'echo docker' } }, {
    root: '/tmp/root', denyTools: new Set(), denyShellCommands: new Set(['docker']), guardCwdTools: true, guardEscalationArgs: true,
  }).startsWith('[dsh-e2e-lockdown]'), true)
  assert.equal(guardDecision({ name: 'bash', arguments: { command: 'ls -la' } }, {
    root: '/tmp/root', denyTools: new Set(), denyShellCommands: new Set(['docker']), guardCwdTools: true, guardEscalationArgs: true,
  }), undefined)
})
