# dsh-e2e

用专用无头 Chromium 测 DSH Web GUI 的端到端工具。只测 `e2e_instance` 起的隔离实例；正式环境入口和登录态都不交给浏览器工具。

## 能做什么

- `e2e_instance`：镜像当前 profile 的插件组合，在独立 `DSH_HOME`、随机端口和独立工作区里跑一个 `dsh web`；`up` / `down` / `list`。
- **默认限权**：每个临时实例都会装上 `dsh-e2e-lockdown`，锁在 workspace-write 上限、审批全部拒绝，并关掉插件/MCP 管理、`e2e` / `e2e_instance` 等越权入口。`lockdown: false` 只留给调试锁定插件本身。
- `e2e`：打开实例 URL，按声明式步骤操作（goto / click / fill / assert / eval / screenshot…），收集 console 错误、pageerror、失败请求和 HTTP ≥400，截图直接返回。
- 命名会话：同一 `session` 的后续调用复用页面，可把「发消息 → 等回复 → 点结果」拆成多次调用。
- 失败时自动多截一张 `failure`。

## 安全边界

### 浏览器侧（防误用/防误触）

- **只测实例**：`e2e` 必须传 `instance`；没有 `url`、`auth`、`cookies` 入口，不能打开当前实例或任意网页。
- **正式入口拒绝**：当前 web server 自己的 origin（含 `127.0.0.1` / `localhost` / `[::1]` 同端口别名）自动保护；反代/公网入口由 profile 的 `protectedOrigins` 提供。启动浏览器之前就报错，不会发请求。
- **请求层再拦一次**：浏览器 context 会拦截 HTTP 和 WebSocket 请求；页面里点链接或 JS 导航到正式入口也会被 abort。私有/回环地址只放行当前实例 origin，公网资源（CDN/字体）仍可加载。
- **只打开 HTTP(S)**：`file://`、`data:`、`javascript:` 一律拒绝。
- **`goto` 只收 path**：例如 `/settings`，会按实例 origin 解析；绝对 URL、`//host`、`file:` 都拒绝。
- **临时实例端口**：不能 bind 正式端口；实例自己的端口用 `DSH_E2E_INSTANCE=1` 允许，`protectedOrigins` 仍然拒绝。
- 这是**防误用/防误触**护栏，不是对抗恶意代码的沙箱；`eval` 仍可执行任意 JS。

### 实例侧（`dsh-e2e-lockdown`）

`up` 默认 `lockdown: true`，把实例进程锁在：

| 边界 | 做法 |
|---|---|
| 文件写 | `sandboxPolicy.resolve()` 夹到 `workspace-write` 上限，`workspaceRoot` 固定为实例工作区；UI 权限预设、恢复出来的 `danger-full-access` 都改不动实际执行 |
| 审批 | `approval` 策略固定 `never`，进入 answerer 前再强制一次，并挂 prepend deny-all；页面审批、手机转发、hook 都拿不到批准 |
| 提权重试 | 工具 guard 拒绝任何 `sandbox_permissions` / `justification` 调用 |
| 宿主管理 | `plugin_manager` 工具被 guard 拒绝；`pluginManager` 的 install/enable/disable/remove/update 方法在服务层全部拒绝；`ui-plugin-manager` 页面关闭 |
| MCP | 临时 profile 关闭 `mcp-manager`：不能新增会拉起任意进程的 server |
| 实例嵌套 / 越界 | `e2e`、`e2e_instance` 在实例里被 guard 拒绝 |
| 浏览器终端 | 临时 profile 关闭 `terminal-controller` / `ui-sidebar-terminal`：它是 host 直接 spawn 的 shell，源码里明确写着 without Agent sandbox or approval |
| 重启插件 | 临时 profile 关闭 `dsh-restart-anywhere`：它从 cgroup 认出的是主实例的 `dsh-web.service`，在实例里点重启会重启主实例 |
| 宿主控制命令 | `bash` / `pwsh` 直接拒绝 `docker`、`podman`、`systemctl`、`sudo`、`kill` 等命令名；这是减速带，刻意混淆或写脚本仍可绕过 |
| 目录 | `subagent` / `schedule_*` / `working_directory` 的 cwd 必须在实例工作区内；workspace / session 创建、目录选择器“新建文件夹”的裸路径也必须在根内（宿主会在创建前 `mkdir`） |
| 网络暴露 | 锁定实例默认只 bind `127.0.0.1`（`instanceHost` 显式指定除外） |

启动时会在实例日志里写 `[dsh-e2e-lockdown] active: ...`；`up` 会检查这一行，**没看到就杀掉实例并报错**，不会把「看起来起来了、实际没锁」的实例交出去。

这仍然不是 OS 隔离：`workspace-write` 允许读工作区外的文件，沙箱不拦网络，`/tmp` 属于 DSH 明确允许的平台临时区域。更重要的是，**同一 OS 用户**的 `docker` / `systemctl --user` / `kill` 等进程和 IPC 能力不受文件沙箱限制——如果运行 dsh 的用户能跑 `docker ps`，恶意实例可以用 Docker 挂宿主根目录直接越界。要防读、防出网、防这种同用户逃逸，需要独立用户/容器/VM，不在本插件范围内。

## 工作区

`e2e_instance up` 在当前工作区下创建：

```
<当前工作区>/e2e_instance/<实例名>/
```

这个文件夹就是实例唯一的工作区，不会把当前工作区整棵交给实例。实例的 `home` 和状态在 `~/.cache/dsh-e2e/instances/<id>/`；`down` 会删掉 home，但保留 `e2e_instance/<id>/`，方便查看测试产物，需要时手动删。

实例名（`id`）只能包含字母、数字、点、下划线和短横线，1–64 位。

## 用法

```jsonc
// 1. 起一个隔离实例
{ "action": "up" }
// → instance.id = "e2e-xxx"
// → instance.workspace.path = "<当前工作区>/e2e_instance/e2e-xxx"

// 2. 用实例 id 跑测试（实例 URL 和 token 由工具自己取）
{
  "instance": "e2e-xxx",
  "steps": [
    { "waitFor": { "selector": "[data-composer-input][contenteditable=\"true\"]" } },
    { "screenshot": { "name": "home" } }
  ]
}

// 3. 用完关掉
{ "action": "down", "id": "e2e-xxx" }
```

拆成多次调用：

```jsonc
// 发消息并等回复
{ "instance": "e2e-xxx", "session": "chat",
  "steps": [ { "fill": { "selector": "[data-composer-input][contenteditable=\"true\"]", "value": "..." } },
             { "click": "button[aria-label=\"发送消息\"]" },
             { "waitFor": { "selector": "code button", "timeoutMs": 120000 } } ] }

// 页面状态还在，直接点
{ "instance": "e2e-xxx", "session": "chat",
  "steps": [ { "click": "code button" }, { "screenshot": { "name": "opened" } } ] }

// 收尾
{ "instance": "e2e-xxx", "session": "chat", "closeSession": true, "steps": [] }
```

## e2e 参数

| 参数 | 说明 |
|---|---|
| `instance` | **必填**，`e2e_instance` 的实例 id；工具只打开这个实例的 URL |
| `steps` | **必填**，步骤数组 |
| `session` | 命名会话：同一 session 的后续调用复用页面；闲置 30 分钟或超过上限自动关 |
| `closeSession` | 传了 `session` 时，本次跑完就关掉 |
| `viewport` | `{width, height}`，覆盖默认视口 |
| `deviceScaleFactor` | 截图缩放倍率，默认 1 |
| `timeoutMs` | 全局超时（导航与动作上限），默认 30000 |
| `actionTimeoutMs` | 单个动作默认超时，默认 8000，且不超过 `timeoutMs` |
| `screenshot` | 跑完是否自动截 `final`，默认 `true` |
| `fullPage` | 截图是否整页，默认 `false` |

## e2e_instance 参数

| 参数 | 说明 |
|---|---|
| `action` | `up` / `down` / `list` |
| `id` | 实例 id；`up` 不填自动生成，`down` 必填 |
| `enable` | `up` 时**只启用**这些 bundle；`dsh-base` / `dsh-web-app` 始终启用 |
| `exclude` | `up` 时排除的 bundle，默认 `['dsh-qq-onebot', 'dsh-webui-auth', 'dsh-bili-watch', '@deepseek-ai/dsh-experimental-inspector-profile']` |
| `port` | `up` 时指定端口，默认随机；正式端口会被拒绝 |
| `lockdown` | `up` 时是否限权，默认 `true`；`false` 只用于调试锁定插件本身，会留下越权能力 |

- 锁定实例里 `plugin_manager` 服务仍然在（standard 预设的 `tool-plugin-manager` 注入它，服务缺失会让会话创建失败），但所有写方法都被拒绝；不要因此以为能从页面或工具里改插件。
- 排除 QQ：第二个实例再连一次 NapCat 会和主实例抢同一个 bot。
- 排除 webui-auth：临时环境没有凭据；实例用启动日志里的 `?token=` 链接进入。
- 排除 bili-watch / inspector：临时实例里固定 403 或端口冲突，纯噪声。
- 临时实例和主实例在同一个 systemd service cgroup 里：dsh 重启会把它们一起带走，`list` 里显示 `dead`，重新 `up` 即可。
- LLM 凭据默认从主实例的 `$DSH_HOME/.credentials.yaml` 快照进临时 home（`shareCredentials: false` 可关）。

## 步骤

每步一个对象，键名就是动作。`selector` 用 Playwright 语法：CSS、`text=`、`role=button[name="设置"]`。

| 写法 | 说明 |
|---|---|
| `{ goto: "/settings" }` | 导航到实例内路径；只接受以 `/` 开头的 path |
| `{ reload: true }` | 重新加载 |
| `{ click: "selector", nth?: 0 }` | 点击 |
| `{ fill: { selector, value } }` | 填输入框 |
| `{ press: "Enter" }` | 按键 |
| `{ hover: "selector" }` | 悬停 |
| `{ selectOption: { selector, value } }` | 下拉选择 |
| `{ waitFor: { selector, state?: "visible" } }` | 等元素；state 支持 visible/attached/hidden/detached |
| `{ wait: 500 }` | 等毫秒 |
| `{ eval: "(() => ...)()" }` | 在页面里求值，结果作为该步 detail 返回 |
| `{ screenshot: { name?, selector?, fullPage? } }` | 截图；给了 selector 就截元素 |
| `{ assert: { selector?, text?, count?, visible?, value?, url? } }` | 断言，失败即中止；`text` 支持 `/正则/` |
| `{ setViewport: { width, height } }` | 改视口 |

任何一步都可以带 `timeout` / `timeoutMs` 覆盖该步超时。

## 配置

```yaml
- id: dsh-e2e
  name: 'dsh-e2e'
  config:
    # 正式环境入口；插件自己的 origin 已自动保护。真实值只写在 profile patch。
    protectedOrigins:
      - 'https://dsh.example.com:9443'
    cdpUrl: 'http://127.0.0.1:9334'
    instanceHost: ''             # 临时实例监听地址；留空时锁定实例只绑 127.0.0.1
    lockdown: true               # 默认限权；false 只用于调试锁定插件本身
    lockdownPackageDir: ''       # 留空用同级 local-plugins/dsh-e2e-lockdown
    lockdownDenyTools:           # 锁定实例里 guard 直接拒绝的工具
      - plugin_manager
      - e2e
      - e2e_instance
      - ntfy_send
      - ntfy_send_file
      - dsh_restart
      - dsh_safe_restart
    timeoutMs: 30000
    actionTimeoutMs: 8000
    sessionIdleMs: 1800000
    maxSessions: 4
    autoStart: true
    dockerImage: 'mcr.microsoft.com/playwright:latest'
    containerName: 'dsh-e2e-browser'
```

- `protectedOrigins` 比较时忽略 scheme 和 path，只认 `host:port`。
- 浏览器容器用 `--network host` 是必须的：Chrome 的 DevTools 端口只接受回环连接。
- 没有 docker 的部署可以设 `executablePath` 指向本机 chromium。

## 常见坑

- **不传 `session` 每次都会重新打开实例页**，上一次的消息和会话状态都不在。多步操作写进一次调用，或用 `session`。
- `[data-composer-input]` 先匹配到的是「选择工作区」的 inert 变体；等 `[data-composer-input][contenteditable="true"]` 再 fill。
- 装了 `dsh-composer-enter-newline` 的 profile 里 Enter 只换行；发送要点 `button[aria-label="发送消息"]`。
- 插件 `apply` 抛错常进 `console.warn`；bundle 404 走 `HTTP ≥400` 那栏。
- 失败时自动多截一张 `failure`，这是故意的。

## 文件

- `src/index.js` — 工具定义、结果拼装、请求层守卫接线
- `src/guard.js` — 正式环境 origin / 端口守卫
- `src/browser.js` — 浏览器容器 / CDP / 本机 launch
- `src/steps.js` — 步骤执行器
- `src/instance.js` — 临时实例的 up / down / list 与工作区
