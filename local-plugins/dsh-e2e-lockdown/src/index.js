/**
 * dsh-e2e-lockdown — 把一个 DSH 进程锁在「工作区内修改 + 审批全部拒绝」。
 *
 * 设计目标不是给模型加提示词，而是把越权路径从执行层拿掉：
 *
 *   1. `sandboxPolicy.resolve()` 永远是「最多 workspace-write」，工作区根固定为
 *      配置的实例目录；UI 的权限预设、恢复出来的 `sandbox/mode` 事件、
 *      `sandbox_permissions` 申请都改不动实际执行边界。
 *   2. `approval` 的策略固定 `never`，并且在 `approval.request()` 进入
 *      answerer 之前把会话策略改回 `never`，再挂一个 prepend 的 deny-all
 *      answerer；页面、手机转发、hook 都拿不到一次批准。
 *   3. 工具 guard（单调、排在所有 pre-execute listener 之后）拒绝
 *      `sandbox_permissions` / `justification`，以及默认的
 *      `plugin_manager`、`e2e`、`e2e_instance`、`ntfy_send*`。
 *   4. workspace registry / session create 的工作目录必须在实例目录内，
 *      避免宿主替模型在目录外 `mkdir`。
 *
 * 这是进程内的限权，不是 OS 隔离：workspace-write 仍然允许读工作区外的文件，
 * 沙箱也不拦网络。真正的边界见 README「边界」一节。
 *
 * @module dsh-e2e-lockdown
 */
import { realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export const name = 'dsh-e2e-lockdown'

/** 核心强制点：服务缺失时 Cordis 会让插件保持 pending，而不是带着空引用 apply。 */
export const inject = ['sandboxPolicy', 'shell']

/** 默认值；profile patch / e2e_instance 通过 config 覆盖。 */
export const DEFAULTS = {
  /** `auto` 只在 DSH_E2E_INSTANCE=1 时生效；`always` 一直生效；`off` 不做事。 */
  mode: 'auto',
  /** 允许的上限；只接受 read-only / workspace-write，绝不接受 danger-full-access。 */
  sandboxMode: 'workspace-write',
  /** 固定工作区根；active 时必填，必须是已存在的绝对目录。 */
  workspaceRoot: '',
  /** 单调 guard 直接拒绝的工具。 */
  denyTools: ['plugin_manager', 'e2e', 'e2e_instance', 'ntfy_send', 'ntfy_send_file', 'dsh_restart', 'dsh_safe_restart'],
  /** 拒绝 subagent / schedule / working_directory 等工具把 cwd 指到根外。 */
  guardCwdTools: true,
  /** 拒绝任何带 sandbox_permissions / justification 的调用（审批不会通过）。 */
  guardEscalationArgs: true,
  /**
   * 额外拒绝的 shell 命令名（bash/pwsh 的 `command` 里按词匹配）。
   * 这是防误触/防直连的减速带：同一用户的 systemctl/docker 能直接动宿主，
   * 靠字符串匹配挡不住刻意混淆，真正的隔离必须靠独立用户/容器。
   */
  denyShellCommands: [
    'docker', 'podman', 'systemctl', 'systemd-run', 'nsenter', 'unshare', 'chroot',
    'sudo', 'su', 'doas', 'mount', 'umount', 'kill', 'pkill', 'killall', 'reboot', 'shutdown', 'poweroff',
  ],
}

const LOCKED_APPROVAL = 'never'
const WORKSPACE_WRITE = 'workspace-write'
const READ_ONLY = 'read-only'
const DANGER = 'danger-full-access'

/** 这些工具的参数里只要出现 cwd/cd，就必须落在实例目录内（宿主会真的 mkdir）。 */
const CWD_GUARD_KEYS = {
  subagent: ['cwd'],
  subagent_fork: ['cwd'],
  working_directory: ['cd'],
  schedule_create: ['cwd'],
  schedule_edit: ['cwd'],
}

/**
 * 把路径解析成真实路径：对还不存在的路径，先 realpath 最近的存在祖先，
 * 再拼回不存在的尾巴。这样 `a/../b`、祖先是指向根外的 symlink 都会被看穿。
 * @param {string} value - 待解析路径。
 * @returns {string} 绝对、规范化的路径。
 */
export function canonicalPath(value) {
  const raw = resolve(String(value))
  let current = raw
  const tail = []
  for (;;) {
    try {
      const real = realpathSync.native(current)
      return tail.length === 0 ? real : join(real, ...tail)
    } catch {
      const parent = dirname(current)
      if (parent === current) return raw
      tail.unshift(basename(current))
      current = parent
    }
  }
}

/** 把 active 配置里的根解析成必须存在的目录；失败就抛，绝不带着空根启动。 */
export function canonicalRoot(value) {
  const text = String(value ?? '').trim()
  if (text === '') throw new Error('dsh-e2e-lockdown: workspaceRoot is required when the lockdown is active')
  if (!isAbsolute(text)) throw new Error(`dsh-e2e-lockdown: workspaceRoot must be absolute, got ${JSON.stringify(text)}`)
  const root = canonicalPath(text)
  let stat
  try {
    stat = statSync(root)
  } catch (error) {
    throw new Error(`dsh-e2e-lockdown: workspaceRoot does not exist: ${root} (${error instanceof Error ? error.message : String(error)})`)
  }
  if (!stat.isDirectory()) throw new Error(`dsh-e2e-lockdown: workspaceRoot is not a directory: ${root}`)
  return root
}

/**
 * `target` 是否在 `root` 内（含根本身）。两边都按真实路径比较。
 * @param {string} root - canonicalRoot() 的结果。
 * @param {string} target - 任意路径。
 * @returns {boolean} 是否在边界内。
 */
export function insideRoot(root, target) {
  const rel = relative(root, canonicalPath(target))
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/**
 * 把任意模式夹到锁定上限：read-only 保持更窄，danger-full-access 降为
 * workspace-write，未知值按上限处理。
 * @param {unknown} mode - 请求解析出的模式。
 * @param {string} lockedMode - 配置的上限（read-only / workspace-write）。
 * @returns {string} 夹紧后的模式。
 */
export function lockMode(mode, lockedMode) {
  if (lockedMode === READ_ONLY) return READ_ONLY
  if (mode === READ_ONLY) return READ_ONLY
  return WORKSPACE_WRITE
}

/**
 * 夹紧一份 SandboxExecutionPolicy：固定模式、固定根、丢掉额外可写目录，
 * 保留 sessionId 等无关字段。
 * @param {object} policy - ctx.sandboxPolicy.resolve() 的返回值。
 * @param {string} root - 固定的实例目录。
 * @param {string} lockedMode - read-only / workspace-write。
 * @returns {object} 新的、不可越界的策略对象。
 */
export function lockPolicy(policy, root, lockedMode) {
  const result = {
    ...(policy !== null && typeof policy === 'object' ? policy : {}),
    mode: lockMode(policy?.mode, lockedMode),
    workspaceRoot: root,
  }
  delete result.additionalWritableRoots
  return result
}

/** 工具 guard 的拒绝文本；统一前缀便于日志和测试断言。 */
function deny(reason) {
  return `[dsh-e2e-lockdown] ${reason}`
}

/** 递归收集某个 key 的字符串值（schedule 的 cwd 藏在 target.create 里）。 */
function collectKey(value, key, out, depth = 0) {
  if (depth > 8 || value === null || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const item of value) collectKey(item, key, out, depth + 1)
    return
  }
  for (const [name, child] of Object.entries(value)) {
    if (name === key && typeof child === 'string' && child.trim() !== '') out.push(child)
    else collectKey(child, key, out, depth + 1)
  }
}

/**
 * 单调工具 guard：在 pre-execute / 审批之后执行，顺序无法把它翻回允许。
 * @param {{name?: string, arguments?: object, agent?: {session?: object}}} exec - 待执行的工具调用。
 * @param {object} options - root、denyTools、guardCwdTools、guardEscalationArgs、base。
 * @returns {string | undefined} 拒绝原因；undefined 表示放行。
 */
export function guardDecision(exec, options) {
  if (exec === null || typeof exec !== 'object') return undefined
  const tool = typeof exec.name === 'string' ? exec.name : ''
  if (tool === '') return undefined

  if (options.denyTools instanceof Set && options.denyTools.has(tool)) {
    return deny(`tool "${tool}" is disabled in this locked instance`)
  }

  const args = exec.arguments
  if (options.guardEscalationArgs && args !== null && typeof args === 'object') {
    if (Object.hasOwn(args, 'sandbox_permissions') || Object.hasOwn(args, 'justification')) {
      return deny('sandbox escalation is disabled: every approval is rejected in this instance')
    }
  }

  if ((tool === 'bash' || tool === 'pwsh') && args !== null && typeof args === 'object'
    && options.denyShellCommands instanceof Set && options.denyShellCommands.size > 0) {
    const command = typeof args.command === 'string' ? args.command : ''
    const hit = deniedCommand(command, options.denyShellCommands)
    if (hit !== undefined) {
      return deny(`host-control command "${hit}" is disabled in this locked instance`)
    }
  }

  if (!options.guardCwdTools) return undefined
  const keys = CWD_GUARD_KEYS[tool]
  if (keys === undefined) return undefined
  const values = []
  for (const key of keys) collectKey(args, key, values)
  for (const value of values) {
    let target
    try {
      target = isAbsolute(value) ? value : resolve(options.base ?? options.root, value)
    } catch {
      return deny(`invalid working directory ${JSON.stringify(value)}`)
    }
    if (!insideRoot(options.root, target)) {
      return deny(`working directory ${JSON.stringify(canonicalPath(target))} is outside the locked workspace ${JSON.stringify(options.root)}`)
    }
  }
  return undefined
}

/** 在 shell 命令串里按词找被禁的命令名；`/usr/bin/docker`、`sudo docker` 都命中。 */
function deniedCommand(command, deny) {
  if (typeof command !== 'string' || command === '') return undefined
  for (const name of deny) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const pattern = new RegExp(`(?:^|[^A-Za-z0-9_./-])(?:/[^ \t\n]+/)?${escaped}(?:[^A-Za-z0-9_-]|$)`)
    if (pattern.test(command)) return name
  }
  return undefined
}

/**
 * 报告启用状态：`ctx.logger` 在正式 web 组合里没有 console transport（只有测试 fixture
 * 会挂 `cordis-plugin-logger-console`），所以必须同时写 stdout，否则 `e2e_instance up`
 * 在实例的启动日志里读不到 `[dsh-e2e-lockdown] active:`，会把已锁定的实例当成没锁。
 */
function report(ctx, line) {
  try { ctx.logger?.info?.(line) } catch { /* logger 不可用不影响启动 */ }
  console.info(line)
}

/** 对外的 apply：按配置决定是否启用，并把各项边界装到服务实例上。 */
export function apply(ctx, config = {}) {
  const settings = { ...DEFAULTS, ...(config ?? {}) }
  const mode = String(settings.mode ?? 'auto')
  if (mode !== 'auto' && mode !== 'always' && mode !== 'off') {
    throw new Error(`dsh-e2e-lockdown: mode must be auto / always / off, got ${JSON.stringify(mode)}`)
  }
  const active = mode === 'always' || (mode === 'auto' && process.env.DSH_E2E_INSTANCE === '1')
  if (!active) {
    report(ctx, `[dsh-e2e-lockdown] inactive (mode=${mode}, DSH_E2E_INSTANCE=${process.env.DSH_E2E_INSTANCE ?? ''})`)
    return
  }
  if (settings.sandboxMode !== READ_ONLY && settings.sandboxMode !== WORKSPACE_WRITE) {
    throw new Error(`dsh-e2e-lockdown: sandboxMode must be ${READ_ONLY} or ${WORKSPACE_WRITE}, got ${JSON.stringify(settings.sandboxMode)}`)
  }

  const root = canonicalRoot(settings.workspaceRoot)
  const lockedMode = settings.sandboxMode
  const denyTools = new Set(
    (Array.isArray(settings.denyTools) ? settings.denyTools : DEFAULTS.denyTools)
      .map((item) => String(item).trim())
      .filter((item) => item !== ''),
  )
  const denyShellCommands = new Set(
    (Array.isArray(settings.denyShellCommands) ? settings.denyShellCommands : DEFAULTS.denyShellCommands)
      .map((item) => String(item).trim())
      .filter((item) => item !== ''),
  )
  const options = {
    root,
    lockMode: lockedMode,
    denyTools,
    denyShellCommands,
    guardCwdTools: settings.guardCwdTools !== false,
    guardEscalationArgs: settings.guardEscalationArgs !== false,
  }

  const restores = []
  const restore = () => {
    for (const undo of restores.splice(0).reverse()) {
      try { undo() } catch { /* 卸载时尽力恢复，别把卸载本身弄挂 */ }
    }
  }
  ctx.effect(() => restore, 'dsh-e2e-lockdown: restore')

  const policy = ctx.sandboxPolicy
  const shell = ctx.shell
  if (policy === undefined || policy === null) throw new Error('dsh-e2e-lockdown: sandboxPolicy service is missing')
  if (shell === undefined || shell === null) throw new Error('dsh-e2e-lockdown: shell service is missing')
  if (shell.sandboxMode === undefined) {
    throw new Error('dsh-e2e-lockdown: the mounted shell executor does not confine (no sandboxMode); refusing to pretend it is locked')
  }

  // 1) 执行层的唯一真相：sandboxPolicy.resolve()。
  restores.push(installPolicyClamp(policy, root, lockedMode))
  // 2) 命令执行器自己的默认模式/请求兜底。
  restores.push(installShellClamp(shell, root, lockedMode))
  // 3) 其他闸门按服务出现顺序装上；核心两项缺失时上面已经抛了。
  installApprovalAndPins(ctx, policy, lockedMode, restores)
  installToolGuard(ctx, options, restores)
  installWorkspaceClamp(ctx, root, restores)
  // session.create 需要在同一个注入作用域里拿到 workspaceRegistry；分开取会触发 Cordis 的 inject 检查。
  let workspaceRegistry
  ctx.inject(['workspaceRegistry'], (scope) => { workspaceRegistry = scope.workspaceRegistry })
  installSessionCreateClamp(ctx, root, () => workspaceRegistry, restores)
  installDirectoryPickerClamp(ctx, root, restores)
  installPluginManagerClamp(ctx, restores)
  installTerminalClamp(ctx, restores)

  // 启动自检：夹紧后的 agentless 策略必须已经落在固定根上。
  const probe = policy.resolve({})
  if (probe?.mode !== lockMode(probe?.mode, lockedMode) || probe?.workspaceRoot !== root) {
    throw new Error('dsh-e2e-lockdown: self-check failed; the policy clamp did not take effect')
  }
  report(
    ctx,
    `[dsh-e2e-lockdown] active: mode<=${lockedMode}, root=${root}, approvals=${LOCKED_APPROVAL},`
    + ` deniedTools=${[...denyTools].join(',')}`,
  )
}

/** 把实例上的一个方法换成 wrapper，并返回可精确恢复的 disposer。 */
function wrapMethod(target, method, build) {
  const original = target[method]
  if (typeof original !== 'function') throw new Error(`dsh-e2e-lockdown: ${method} is not a function`)
  const hadOwn = Object.hasOwn(target, method)
  target[method] = build(original.bind(target))
  return () => {
    if (hadOwn) target[method] = original
    else delete target[method]
  }
}

/** 夹紧 `ctx.sandboxPolicy.resolve()`。这是执行边界最硬的一层。 */
function installPolicyClamp(policy, root, lockedMode) {
  const undo = wrapMethod(policy, 'resolve', (original) => (request = {}) => lockPolicy(original(request), root, lockedMode))
  // `defaultMode` 是实例自己的 data property；先记下来，卸载时原样放回。
  const descriptor = Object.getOwnPropertyDescriptor(policy, 'defaultMode')
  let defined = false
  try {
    Object.defineProperty(policy, 'defaultMode', { configurable: true, enumerable: true, get: () => lockedMode })
    defined = true
  } catch {
    // 不能改 defaultMode 不影响 resolve() 的强制边界。
  }
  return () => {
    undo()
    if (!defined) return
    try {
      if (descriptor === undefined) delete policy.defaultMode
      else Object.defineProperty(policy, 'defaultMode', descriptor)
    } catch { /* ignore */ }
  }
}

/** 夹紧 shell 的 resolve/execute，防止别的插件绕过 policy 直接塞 danger。 */
function installShellClamp(shell, root, lockedMode) {
  const fallback = () => ({ mode: lockedMode, workspaceRoot: root })
  const undoResolve = wrapMethod(shell, 'resolve', (original) => (request = {}) => {
    const spec = original(request)
    return { ...spec, sandboxPolicy: lockPolicy(spec?.sandboxPolicy ?? fallback(), root, lockedMode) }
  })
  let undoExecute
  try {
    undoExecute = wrapMethod(shell, 'execute', (original) => (spec) => {
      const input = spec !== null && typeof spec === 'object' ? spec : {}
      return original({ ...input, sandboxPolicy: lockPolicy(input.sandboxPolicy ?? fallback(), root, lockedMode) })
    })
  } catch {
    undoExecute = undefined
  }
  // shell.sandboxMode 是 getter；用自有 getter 把它压到上限。
  const descriptor = Object.getOwnPropertyDescriptor(shell, 'sandboxMode')
  let defined = false
  try {
    Object.defineProperty(shell, 'sandboxMode', { configurable: true, enumerable: true, get: () => lockedMode })
    defined = true
  } catch { /* ignore */ }
  return () => {
    undoExecute?.()
    undoResolve()
    if (defined) {
      try {
        if (descriptor === undefined) delete shell.sandboxMode
        else Object.defineProperty(shell, 'sandboxMode', descriptor)
      } catch { /* ignore */ }
    }
  }
}

/** 审批全拒绝：policy、request 入口、deny-all answerer 三层。 */
function installApprovalAndPins(ctx, policy, lockedMode, restores) {
  ctx.inject(['approval'], (scope) => {
    const approval = scope.approval
    try {
      if (approval.config !== undefined && approval.config !== null) approval.config.policy = LOCKED_APPROVAL
    } catch { /* config 可能被冻结；request 入口仍然强制 */ }

    try {
      restores.push(wrapMethod(approval, 'request', (original) => async (request) => {
        forceApprovalNever(approval, request)
        return original(request)
      }))
    } catch (error) {
      ctx.logger?.warn?.(`[dsh-e2e-lockdown] cannot wrap approval.request: ${error instanceof Error ? error.message : String(error)}`)
    }

    try {
      const off = scope.on('approval/request', () => 'rejected', { prepend: true })
      if (typeof off === 'function') restores.push(off)
    } catch (error) {
      ctx.logger?.warn?.(`[dsh-e2e-lockdown] cannot register the deny-all approval answerer: ${error instanceof Error ? error.message : String(error)}`)
    }

    // 恢复出来的会话里显式写过的危险覆盖，回到 locked。
    try {
      const off = ctx.on('agent/created', ({ agent }) => {
        const session = agent?.session
        if (session === undefined || session === null) return
        try {
          if (policy.overrideOf?.(session) === DANGER) session.append('sandbox/mode', { mode: lockedMode })
        } catch (error) {
          ctx.logger?.warn?.(`[dsh-e2e-lockdown] cannot re-pin session sandbox mode: ${error instanceof Error ? error.message : String(error)}`)
        }
        try {
          if (approval.overrideOf?.(session) === 'ask') session.append('approval/policy', { policy: LOCKED_APPROVAL })
        } catch (error) {
          ctx.logger?.warn?.(`[dsh-e2e-lockdown] cannot re-pin session approval policy: ${error instanceof Error ? error.message : String(error)}`)
        }
      }, { prepend: true })
      if (typeof off === 'function') restores.push(off)
    } catch (error) {
      ctx.logger?.warn?.(`[dsh-e2e-lockdown] cannot register the session pin listener: ${error instanceof Error ? error.message : String(error)}`)
    }
  })
}

/** 在一次审批请求进入 answerer 之前，把该会话的策略改回 never。 */
function forceApprovalNever(approval, request) {
  const session = request?.agent?.session
  if (session === undefined || session === null || typeof session.append !== 'function') return
  let current
  try {
    current = typeof approval.overrideOf === 'function' ? approval.overrideOf(session) : undefined
  } catch {
    current = undefined
  }
  if (current === LOCKED_APPROVAL) return
  try {
    session.append('approval/policy', { policy: LOCKED_APPROVAL })
  } catch { /* 追加失败交给 deny-all answerer 兜底 */ }
}

/** 单调 guard：拒绝禁用工具、越权参数、根外 cwd。 */
function installToolGuard(ctx, options, restores) {
  ctx.inject(['tools'], (scope) => {
    try {
      const workingDirectory = () => {
        try { return scope.get('workingDirectory') } catch { return undefined }
      }
      const off = scope.tools.guard((exec) => guardDecision(exec, {
        ...options,
        base: resolveGuardBase(exec, workingDirectory(), options.root),
      }))
      if (typeof off === 'function') restores.push(off)
    } catch (error) {
      ctx.logger?.warn?.(`[dsh-e2e-lockdown] cannot register the tool guard: ${error instanceof Error ? error.message : String(error)}`)
    }
  })
}

/** 相对 cwd 以调用会话的当前目录为基准；拿不到就用根。 */
function resolveGuardBase(exec, workingDirectory, root) {
  try {
    const session = exec?.agent?.session
    if (workingDirectory !== undefined && session !== undefined) {
      const current = workingDirectory.get(session)
      if (typeof current === 'string' && current !== '') return current
    }
  } catch { /* fall through */ }
  return root
}

/** workspace registry 只允许登记实例目录内的已有目录；默认工作区也落在根上。 */
function installWorkspaceClamp(ctx, root, restores) {
  ctx.inject(['workspaceRegistry'], (scope) => {
    const registry = scope.workspaceRegistry
    if (registry === undefined || registry === null) return
    try {
      const off = wrapMethod(registry, 'create', (original) => async (path, title) => {
        if (typeof path !== 'string' || !isAbsolute(path) || !insideRoot(root, path)) {
          throw new Error(`[dsh-e2e-lockdown] workspace must be an existing directory inside ${JSON.stringify(root)}, got ${JSON.stringify(path)}`)
        }
        return original(path, title)
      })
      restores.push(off)
    } catch (error) {
      ctx.logger?.warn?.(`[dsh-e2e-lockdown] cannot wrap workspace create: ${error instanceof Error ? error.message : String(error)}`)
    }
    try {
      const off = wrapMethod(registry, 'initializeDefault', (original) => () => original(async () => root))
      restores.push(off)
    } catch (error) {
      ctx.logger?.warn?.(`[dsh-e2e-lockdown] cannot wrap default workspace initialization: ${error instanceof Error ? error.message : String(error)}`)
    }
  })
}

/** 插件管理的写方法全部拒绝；服务本身必须留着，否则 standard 预设起不来。 */
const PLUGIN_MANAGER_MUTATIONS = [
  'installBundle',
  'setBundleEnabled',
  'setPluginEnabled',
  'removeBundle',
  'updateBundle',
  'setVersionExemption',
]

function installPluginManagerClamp(ctx, restores) {
  ctx.inject(['pluginManager'], (scope) => {
    const manager = scope.pluginManager
    if (manager === undefined || manager === null) return
    for (const method of PLUGIN_MANAGER_MUTATIONS) {
      if (typeof manager[method] !== 'function') continue
      try {
        restores.push(wrapMethod(manager, method, () => async () => {
          throw new Error(`[dsh-e2e-lockdown] plugin management is disabled in this locked instance (${method})`)
        }))
      } catch (error) {
        ctx.logger?.warn?.(`[dsh-e2e-lockdown] cannot wrap pluginManager.${method}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  })
}

/** 目录选择器的“新建文件夹”也是 host 侧 mkdir；父目录必须在根内。 */
function installDirectoryPickerClamp(ctx, root, restores) {
  ctx.inject(['directoryPickerController'], (scope) => {
    const picker = scope.directoryPickerController
    if (picker === undefined || picker === null) return
    try {
      restores.push(wrapMethod(picker, 'createDirectory', (original) => async (path, name) => {
        if (typeof path !== 'string' || !isAbsolute(path) || !insideRoot(root, path)) {
          throw new Error(`[dsh-e2e-lockdown] cannot create a directory outside ${JSON.stringify(root)}`)
        }
        return original(path, name)
      }))
    } catch (error) {
      ctx.logger?.warn?.(`[dsh-e2e-lockdown] cannot wrap directoryPicker.createDirectory: ${error instanceof Error ? error.message : String(error)}`)
    }
  })
  // 控制器只是 Remote 外壳；真正的 mkdir 在 directoryPicker seam 上。两层都包。
  ctx.inject(['directoryPicker'], (scope) => {
    const seam = scope.directoryPicker
    if (seam === undefined || seam === null || typeof seam.createDirectory !== 'function') return
    try {
      restores.push(wrapMethod(seam, 'createDirectory', (original) => async (path, name) => {
        if (typeof path !== 'string' || !isAbsolute(path) || !insideRoot(root, path)) {
          throw new Error(`[dsh-e2e-lockdown] cannot create a directory outside ${JSON.stringify(root)}`)
        }
        return original(path, name)
      }))
    } catch (error) {
      ctx.logger?.warn?.(`[dsh-e2e-lockdown] cannot wrap directoryPicker seam: ${error instanceof Error ? error.message : String(error)}`)
    }
  })
}

/** 浏览器终端是 host 直接 spawn 的 shell（无沙箱、无审批）；锁定的实例不能有它。 */
function installTerminalClamp(ctx, restores) {
  ctx.inject(['terminalController'], (scope) => {
    const controller = scope.terminalController
    if (controller === undefined || controller === null) return
    try {
      restores.push(wrapMethod(controller, 'create', () => async () => {
        throw new Error('[dsh-e2e-lockdown] browser terminals are disabled in this locked instance')
      }))
    } catch (error) {
      ctx.logger?.warn?.(`[dsh-e2e-lockdown] cannot wrap terminalController.create: ${error instanceof Error ? error.message : String(error)}`)
    }
  })
}

/** session.create 的裸 cwd 也必须在根内（宿主在创建会话前会 mkdir）。 */
function installSessionCreateClamp(ctx, root, workspaceRegistryOf, restores) {
  ctx.inject(['sessionController'], (scope) => {
    const controller = scope.sessionController
    if (controller === undefined || controller === null) return
    try {
      const off = wrapMethod(controller, 'create', (original) => async (request) => {
        const cwd = request?.cwd
        if (typeof cwd === 'string' && cwd.trim() !== '' && !insideRoot(root, cwd)) {
          throw new Error(`[dsh-e2e-lockdown] session cwd must stay inside ${JSON.stringify(root)}, got ${JSON.stringify(cwd)}`)
        }
        const workspaceId = request?.workspaceId
        if (workspaceId !== undefined && workspaceId !== null) {
          const registry = workspaceRegistryOf()
          const workspace = registry?.get?.(workspaceId)
          if (workspace !== undefined && workspace !== null && !insideRoot(root, workspace.path)) {
            throw new Error(`[dsh-e2e-lockdown] workspace ${JSON.stringify(workspace.path)} is outside ${JSON.stringify(root)}`)
          }
        }
        return original(request)
      })
      restores.push(off)
    } catch (error) {
      ctx.logger?.warn?.(`[dsh-e2e-lockdown] cannot wrap session create: ${error instanceof Error ? error.message : String(error)}`)
    }
    // 用系统应用打开目录也属于宿主动作；锁定实例里一律拒绝。
    try {
      restores.push(wrapMethod(controller, 'openWorkspacePath', () => async () => {
        throw new Error('[dsh-e2e-lockdown] opening workspace paths with host applications is disabled in this locked instance')
      }))
    } catch (error) {
      ctx.logger?.warn?.(`[dsh-e2e-lockdown] cannot wrap openWorkspacePath: ${error instanceof Error ? error.message : String(error)}`)
    }
  })
}
