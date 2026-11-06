# dsh-e2e

专用无头浏览器的端到端测试工具。给 DSH 的 Web GUI 用，也可以测任何网页。

以前验证 GUI 改动是借 `mijia-geek` 那个 Playwright 容器：`docker cp` 脚本进去、
`docker exec` 跑、从 `dsh-webui-auth` 的会话文件里抠 token、再把截图 `docker cp`
回来。那容器里还跑着米家的持久登录浏览器，两边互相干扰。这个插件把整条链路收成
一次工具调用。

## 它做什么

- 起一台**专用** Chromium（默认是独立的 docker 容器 `dsh-e2e-browser`，host 网络，
  CDP 在 `127.0.0.1:9334`），不和 mijia 共用；
- `auth: dsh` 时自动从 `dsh-webui-auth` 的 `sessions.jsonl` 取一个未过期的会话
  token 注入 cookie，不用每次手工抠；
- 按声明式步骤操作页面（goto / click / fill / assert / eval / screenshot…）；
- 收集 `console` 错误、`console` 警告、`pageerror`、失败请求，以及 **HTTP ≥400 响应**
  （客户端插件 bundle 是批在一起取的，404 不会触发 `requestfailed`，要单独看）；
- 截图落盘，并把前 N 张直接作为图片返回给模型；
- 失败时自动截一张 `failure`，方便看现场；
- **命名会话**：传 `session` 时，后续调用复用同一个页面、不再重新导航，可以把
  「发消息 → 等回复 → 点结果」拆成几次调用，不用挤在一次里写完。

## 用法（先用临时实例）

```jsonc
// 1. 起一个隔离实例（独立 DSH_HOME + 随机端口，默认排除 QQ / webui-auth）
{ "action": "up" }
// → { "instance": { "id": "e2e-xxx", "url": "http://<实例地址>:<端口>/?token=..." } }

// 2. 用实例 id 跑测试；不用传 url，默认不带登录态
{
  "instance": "e2e-xxx",
  "steps": [ { "waitFor": { "selector": "[data-composer-input]" } }, { "screenshot": { "name": "home" } } ]
}

// 3. 用完关掉（进程 + 临时 home 一起删）
{ "action": "down", "id": "e2e-xxx" }
```

拆成多次调用（同一 `session` 复用页面，不再重新加载）：

```jsonc
// 第一次：发消息并等回复
{ "instance": "e2e-xxx", "session": "chat",
  "steps": [ { "fill": { "selector": "[data-composer-input][contenteditable=\"true\"]", "value": "..." } },
             { "click": "button[aria-label=\"发送消息\"]" },
             { "waitFor": { "selector": "code button", "timeoutMs": 120000 } } ] }

// 第二次：页面状态还在，直接点
{ "instance": "e2e-xxx", "session": "chat",
  "steps": [ { "click": "code button" }, { "screenshot": { "name": "opened" } } ] }

// 收尾：关掉这条会话
{ "instance": "e2e-xxx", "session": "chat", "closeSession": true, "steps": [] }
```

也可以直接给 `url` 测任何地址（比如已经起好的实例或静态页面）：

```jsonc
{
  "url": "https://dsh.example.com:9443/",
  "steps": [
    { "waitFor": { "selector": "[data-composer-input]" } },
    { "assert": { "selector": "[data-composer-input]", "visible": true } },
    { "click": "text=设置" },
    { "wait": 300 },
    { "screenshot": { "name": "settings" } },
    { "eval": "(() => ({ title: document.title, w: innerWidth }))()" }
  ]
}
```

### 参数

| 参数 | 说明 |
|---|---|
| `instance` | `e2e_instance` 起的实例 id；给了就不必传 `url`，且默认 `auth: none` |
| `url` | 打开哪个地址；不填用配置里的 `baseUrl` |
| `steps` | 步骤数组，见下 |
| `viewport` | `{width, height}`，覆盖默认视口 |
| `deviceScaleFactor` | 截图缩放倍率，默认 1 |
| `auth` | `dsh` / `none`，默认用插件配置 |
| `cookies` | 显式 cookie 数组；给了就不读会话文件 |
| `session` | 命名会话：同一 session 的后续调用复用同一页面；换 `url` 会先导航；闲置 30 分钟或超过上限自动关 |
| `closeSession` | 传了 `session` 时，本次跑完就关掉它 |
| `timeoutMs` | 全局超时（导航与各动作上限），默认 30000 |
| `actionTimeoutMs` | 单个动作的默认超时，默认 8000，且不超过 `timeoutMs` |
| `screenshot` | 跑完是否自动截 `final`，默认 `true` |
| `fullPage` | 截图是否整页，默认 `false` |

### 步骤

每步一个对象，键名就是动作。`selector` 用 Playwright 语法：CSS、`text=`、
`role=button[name="设置"]` 都可以。

| 写法 | 说明 |
|---|---|
| `{ goto: "url" }` | 导航（第一步之前也会先打开 `url`） |
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
| `{ setViewport: { width, height } }` | 改视口，测响应式 |

任何一步都可以带 `timeout` / `timeoutMs` 覆盖该步的超时（默认动作 8 秒、导航 30 秒）。
等模型回合、等长任务这类才需要显式给大值，例如
`{ "waitFor": { "selector": "code button" }, "timeoutMs": 120000 }`。

失败时还会自动多截一张 `failure`。

## 临时实例工具

`e2e_instance` 用一个独立的 `DSH_HOME` 镜像当前 profile 的插件组合，在随机空闲端口
跑一个 `dsh web`，不碰主实例的会话、存储和 QQ 连接。

| 参数 | 说明 |
|---|---|
| `action` | `up` / `down` / `list` |
| `id` | 实例 id；`up` 不填自动生成，`down` 必填 |
| `enable` | `up` 时**只启用**这些 bundle（白名单）；`dsh-base` / `dsh-web-app` 始终启用，点名 enable 的 bundle 不受默认排除影响。不填 = 全部启用 |
| `exclude` | `up` 时排除的 bundle，默认 `['dsh-qq-onebot', 'dsh-webui-auth', 'dsh-bili-watch', '@deepseek-ai/dsh-experimental-inspector-profile']`；显式 exclude 优先于 enable |
| `port` | `up` 时指定端口，默认随机 |

- 用 `enable` 隔离回归：`up { enable: ["dsh-file-links"] }` 只留基础组合 + 这个插件，
  其余 bundle 不加载（同时在镜像的 patch 里追加禁用行，避免 override 悬空）。源 profile
  里没有的名字会在结果里列成 ⚠，方便发现拼错。
- 排除 QQ：第二个实例再连一次 NapCat 会和主实例抢同一个 bot。
- 排除 webui-auth：临时环境没有凭据，留着只会把页面挡在首次设置页；实例用核心
  启动时打印的 `?token=` 链接进入，e2e 每次新开浏览器都能用。实际地址由启动日志决定，
  代码里不写死。
- 排除 inspector：它固定在 9231 上开 devtools 桥，第二个实例抢不到端口，页面里会刷
  一串 `ws://127.0.0.1:9231/ingest 403` 的噪声。
- 排除 bili-watch：状态轮询在临时实例里固定 403，纯噪声。
- 工作区在 `up` 时种好，**只能是调用工具那个会话的当前工作目录**（从
  `workingDirectory.ensure(agent)` 取，不可另选）。临时实例的 `workspace.json`
  只有这一个工作区，会话列表为空。
- 状态和临时目录在 `~/.cache/dsh-e2e/instances/<id>/`，`down` 会把整个目录删掉。
- 临时实例和主实例在同一个 systemd service cgroup 里：dsh 重启会把它们一起带走，
  `list` 里显示 `dead`，重新 `up` 即可（不要以为它还在跑）。
- LLM 凭据默认从主实例的 `$DSH_HOME/.credentials.yaml` **快照**一份进临时 home
  （`shareCredentials: false` 可关）。用拷贝不用软链：临时实例的模型页也会写凭据，
  软链会把写入带回真实 store；主实例换了 key，重新 `up` 即可。
- 依赖安装用 `pnpm install --no-frozen-lockfile`（主 profile 的 lock 可能落后于
  package.json）。

## 配置

```yaml
- insert:
    - id: dsh-e2e
      name: 'dsh-e2e'
      config:
        baseUrl: 'https://dsh.example.com:9443/'
        auth: 'dsh'
        sessionsFile: '/home/you/.dsh/profiles/web/.dsh-webui-auth/sessions.jsonl'
        cdpUrl: 'http://127.0.0.1:9334'
        instanceHost: ''          # 临时实例监听地址；留空用镜像 profile 的配置
        timeoutMs: 30000          # 导航与全局上限
        actionTimeoutMs: 8000     # 单个动作默认超时
        sessionIdleMs: 1800000    # 命名会话闲置多久关掉
        maxSessions: 4            # 同时保留几个命名会话
        autoStart: true
        dockerImage: 'mcr.microsoft.com/playwright:latest'
        containerName: 'dsh-e2e-browser'
```

- `auth: dsh` 读的是 dsh-webui-auth 的会话文件；token 过期（默认 12 小时，
  取决于设置）后需要在 GUI 重新登录一次，工具会明确报错。
- 浏览器容器用 `--network host` 是必须的：Chrome 的 DevTools 端口只接受回环
  连接，走 docker 端口映射时对端是网桥地址（不是回环），连接会被 reset。
- 没有 docker 的部署可以设 `executablePath` 指向本机 chromium，直接 launch。
- 镜像里没有 Playwright 时，插件依赖 `playwright-core`（`npm install` 装在
  插件目录下）。

## 测试纪律

- 测 GUI 时**不要打用户正在用的 profile / 地址**。用 `e2e_instance up` 起一个
  独立实例，把实例 id 传给 `e2e`；测完 `down`。
- 生产 GUI 只做只读冒烟时也要先确认没有任何会写入会话的操作（点会话、发消息、
  答题都算写）。

## 常见坑

- **每次调用都加载新页面**：不传 `session` 时，每次调用都会 `goto url`，上一次调用里
  打开的会话、发出的消息都不在了。多步操作要么写进一次调用，要么用 `session`。
- **composer 有两个状态**：`[data-composer-input]` 先匹配到的是「选择工作区」的
  inert 变体（`contenteditable="false"`）。等
  `[data-composer-input][contenteditable="true"]` 再 fill，或者直接等页面稳定 3 秒。
- **Enter 不一定是发送**：装了 `dsh-composer-enter-newline` 的 profile 里 Enter 只换行，
  发送要点 `button[aria-label="发送消息"]`，而且草稿为空时它是 disabled。
- **选择器写错时要快失败**：动作默认 8 秒超时；确实要等长任务就单独给该步
  `timeoutMs`，别把全局超时调大来掩盖写错的选择器。
- **看不到插件加载失败**：插件的 `apply` 抛错常进 `console.warn`，现在会一并报出来；
  bundle 404 走 `HTTP ≥400` 那一栏。

## 已知噪声

- 默认会把主实例的 `.credentials.yaml` 快照进临时 home，所以一般不会有「开始使用」
  引导框；只有 `shareCredentials: false` 或主实例没登录时才可能弹，测试里点 X 即可。
- `dsh-bili-watch` 的 `/api/bili-watch/status` 在临时实例里会 403（两次），
  和 e2e 本身无关；断言时忽略。
- 失败时自动多截一张 `failure`，这是故意的。

## 文件

- `src/index.js` — 插件注册、工具定义、结果拼装
- `src/browser.js` — 浏览器容器 / CDP / 本机 launch
- `src/steps.js` — 步骤执行器
- `src/auth.js` — dsh-webui-auth 会话 token → cookie
- `src/instance.js` — 临时实例的 up / down / list
