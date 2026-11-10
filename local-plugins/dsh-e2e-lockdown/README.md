# dsh-e2e-lockdown

把一个 DSH 进程锁在 **「工作区内修改 + 审批全部不通过」**。

它不是提示词护栏，而是把越权路径从执行层拆掉：无论调用方是模型、页面上的权限开关、
恢复出来的旧会话、hook，还是别的插件，实际执行时都只能拿到 `workspace-write` 上限；
所有审批在到达任何 answerer 之前就变成 `rejected`。

`e2e_instance up` 默认自动启用它，并把实例目录作为唯一工作区根。

## 启用

```yaml
- id: dsh-e2e-lockdown
  name: 'dsh-e2e-lockdown'
  config:
    mode: always              # auto | always | off
    sandboxMode: workspace-write
    workspaceRoot: /abs/path/to/instance/workspace
```

- `mode: auto`（默认）：只在 `DSH_E2E_INSTANCE=1` 时生效，装进普通 profile 不会误锁真实会话。
- `mode: always`：无条件生效；`workspaceRoot` 必填，且必须是已存在的绝对目录。
- `mode: off`：完全不做事（等价于没装）。

`e2e_instance` 生成的临时 profile 会覆盖成 `mode: always` + 实例目录 + 锁定版
permission 预设，所以不需要手工配置。

## 锁掉什么

| 入口 | 处理 |
|---|---|
| `sandboxPolicy.resolve()` | 模式夹到 `read-only` / `workspace-write`，`workspaceRoot` 固定为配置的根，`additionalWritableRoots` 丢弃 |
| `shell.resolve()` / `shell.execute()` | 再夹一次，防止别的插件绕过 policy 直接塞 `danger-full-access` |
| `approval` 策略 | 固定 `never`；进入 answerer 前把会话策略改回 `never` |
| `approval/request` | prepend 一个 deny-all answerer，页面审批、手机转发、hook 都拿不到一次批准 |
| `sandbox_permissions` / `justification` | 工具 guard 直接拒绝；不会弹审批 |
| `plugin_manager` | 工具被 guard 拒绝；服务本身保留（standard 预设注入它，服务缺失会让会话创建失败），但 install/enable/disable/remove/update 写方法在服务层全部拒绝；`e2e_instance` 的临时 profile 另外关掉 `ui-plugin-manager` 页面 |
| `mcp-manager` | 临时 profile 里禁用：不能通过设置新增会拉起任意进程的 MCP server |
| `e2e` / `e2e_instance` | 锁定实例里禁用：不能借浏览器工具打开别的实例，也不能再套一层实例 |
| `ntfy_send` / `ntfy_send_file` | 默认禁用：不把实例里的东西推到真实手机（需要时可从 `denyTools` 去掉） |
| `terminal-controller` | `e2e_instance` 的临时 profile 关闭：浏览器终端是 host 直接 spawn 的 shell，不带 Agent 沙箱/审批 |
| `dsh_restart` / `dsh_safe_restart` | 默认禁用；`dsh-restart-anywhere` 在临时实例里会重启主实例的 systemd 服务，临时 profile 也把该插件关掉 |
| `subagent` / `subagent_fork` / `schedule_*` / `working_directory` | 带绝对/相对 `cwd` 的调用必须在根内；否则拒绝（宿主会真的在目录外 `mkdir`） |
| `workspaceRegistry.create` / `initializeDefault` | 只允许登记根内已存在的目录；默认工作区也落在根上 |
| `directoryPicker.createDirectory` | 目录选择器的“新建文件夹”父目录必须在根内（host 侧 mkdir） |
| `sessionController.create` | 裸 `cwd` 必须在根内 |
| 宿主控制命令 | `bash` / `pwsh` 的 `docker`、`podman`、`systemctl`、`systemd-run`、`sudo`、`kill` 等按词拒绝；这是防误触的减速带，不是硬边界 |
| `agent/created` | 恢复出来的会话如果显式写过 `danger-full-access` / `ask`，重新钉回 locked |
| `webserver` | `e2e_instance` 的锁定 profile 默认只绑 `127.0.0.1`，不把无登录态的控制面暴露到网卡上 |

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `mode` | `auto` | `auto` / `always` / `off` |
| `sandboxMode` | `workspace-write` | 上限；只接受 `read-only` / `workspace-write`，传 `danger-full-access` 直接启动失败 |
| `workspaceRoot` | 空 | active 时必填；必须是已存在的绝对目录，插件会 `realpath` 后使用 |
| `denyTools` | `plugin_manager`, `e2e`, `e2e_instance`, `ntfy_send`, `ntfy_send_file`, `dsh_restart`, `dsh_safe_restart` | 单调 guard 直接拒绝的工具名 |
| `guardCwdTools` | `true` | 是否检查 `subagent` / `schedule_*` / `working_directory` 的 cwd |
| `guardEscalationArgs` | `true` | 是否拒绝任何带 `sandbox_permissions` / `justification` 的调用 |
| `denyShellCommands` | `docker`, `podman`, `systemctl`, `systemd-run`, `sudo`, `su`, `doas`, `mount`, `umount`, `kill`, `pkill`, `killall`, `reboot`, `shutdown`, `poweroff`, `nsenter`, `unshare`, `chroot` | `bash` / `pwsh` 命令串里按词拒绝；只挡直接调用，混淆/脚本仍可绕过 |

## 边界（重要）

这是**同一 OS 用户、同一进程内**的限权，不是容器/独立用户隔离。它保证的是：

- 写文件：最多只能写 `workspaceRoot` 下（以及沙箱自己给的临时目录）；
- 提权：没有任何审批通道能批准 `danger-full-access`；
- 宿主代劳：不会替你调 `plugin_manager`、MCP、workspace/session 创建在根外 `mkdir`。

它**不**保证：

- **读**：`workspace-write` 一直允许读工作区外的文件；`.credentials.yaml`、profile 配置、
  会话日志都在可读范围内。要防读，需要容器或独立用户。
- **网络**：沙箱不拦网络；`web_fetch`、`curl` 仍可出网。
- **其他有副作用的工具**：`schedule_*`、`present`、`ask_user_question` 等仍可用；需要时把名字
  加进 `denyTools`，或从 `exclude` 里把对应 bundle 排除。
- **平台临时目录**：`/tmp` 是 DSH `workspace-write` 明确允许的临时区域，能写；不要把它当成越界。
- **同一用户的进程/IPC 能力**：`systemctl --user`、`docker` / `podman`、`kill` / `ptrace`、Unix socket
  都绕开文件沙箱。默认的 `denyShellCommands` 会拒绝直接写出来的命令名，但刻意混淆
  （拼接字符串、写脚本再执行、`/proc/self/...` 等）可以绕过。如果运行 dsh 的用户能访问
  Docker（`docker ps` 能跑），恶意实例仍可能用 Docker 挂宿主根目录直接越界。
- **网络**：沙箱不拦网络；`web_fetch` / `curl` 仍可出网、可把读到的文件带出去。

要把「恶意模型」也挡住，必须换隔离层：独立 OS 用户（没有 docker/systemd socket）、容器、
或者虚拟机。`dsh-e2e-lockdown` 的目标是把 DSH 自己的权限入口（审批、sandbox 模式、
plugin/MCP 管理、宿主 mkdir、无沙箱终端）全部关掉，不是替代 OS 隔离。

## 与 e2e_instance 一起用

`e2e_instance up` 默认 `lockdown: true`：

- 把 `dsh-e2e-lockdown` 加进临时 profile 的 bundle 列表和 `link:` 依赖；
- 往临时 `cordis.patch.yml` 追加：`sandbox-policy`（固定根/模式）、`approval`（`never`）、
  `permission`（只有 `locked` 一个预设）、禁用 `plugin-manager` / `ui-plugin-manager` /
  `mcp-manager` / `open-in-app`、锁定 `webserver.host`，以及本插件的 `mode: always`；
- 实例启动日志里应出现 `[dsh-e2e-lockdown] active: ...`。

`lockdown: false` 是调试这个插件本身的逃生门，**不要**用在一个不可信模型会跑的实例上。

## 自检（不上模型也能看）

实例启动后：

```bash
# 1) 插件确实 active
grep 'dsh-e2e-lockdown' ~/.cache/dsh-e2e/instances/<id>/home/dsh-web.log

# 2) 临时 profile 的锁定行
sed -n '/e2e 锁定/,$p' ~/.cache/dsh-e2e/instances/<id>/home/profiles/web/cordis.patch.yml

# 3) 页面里权限选择器只剩 locked（用 e2e 打开实例后点一下权限按钮，或查 boot 后的 catalog）
```

模型侧探针（让实例里的 agent 跑）：

- 在实例工作区里写文件：应成功，无审批；
- `touch /tmp/x` 或写 `$HOME/x`：应得到 `[sandbox: file access denied under workspace-write mode]`；
- 再带 `sandbox_permissions: danger-full-access` 重试：应得到
  `[dsh-e2e-lockdown] sandbox escalation is disabled: every approval is rejected in this instance`；
- 调 `plugin_manager`：工具不存在或被 guard 拒绝；
- `subagent` 带 `cwd: /tmp`：被 guard 拒绝。

## 兼容性

核心强制点依赖 DSH 的公开服务方法：

- `ctx.sandboxPolicy.resolve()`、`ctx.shell.resolve()/execute()`：缺失或不是函数时插件**启动失败**，
  不会静默放行；
- `ctx.approval.request()`、`ctx.workspaceRegistry.create()`、`ctx.sessionController.create()`：
  缺失只影响对应的额外加固，核心夹紧仍然生效。

升级 DSH 后如果启动日志出现 `dsh-e2e-lockdown: ...` 的报错，先看这几个方法是否还在；
不要改成 best-effort 静默降级。

## 文件

- `src/index.js` — 全部强制逻辑（无外部依赖，只有 Node 内置模块）
- `cordis.patch.yml` — 默认 config（`mode: auto`，普通 profile 里不生效）
- `test/lockdown.test.js` — 夹紧/guard/审批的单元测试
