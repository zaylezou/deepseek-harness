# dsh-ntfy

给 DeepSeek Harness 加「往手机推通知」的能力，走自建的 [ntfy](https://ntfy.sh)。

插件提供两个工具，外加一个可选的「审批超时转发」：

```
ntfy_send        推一条通知（支持 Markdown / 动作按钮 / 定时投递 / 附件链接）
ntfy_send_file   把本机文件作为附件推过去（PUT 发布）
```

审批转发见下面的[「审批转发」](#审批转发approval-relay)一节。

原始文档放在 [`docs/publish.md`](docs/publish.md)（取自 ntfy 官方仓库 `docs/publish.md`，
2026-10 快照）——下面所有参数的含义、边界、限制，以那份文档为准。

## ntfy_send 参数

| 参数 | 类型 | 说明 |
|---|---|---|
| `message` | string | **必填**，正文 |
| `title` | string | 标题，默认「NAS 通知」 |
| `priority` | enum | `min`(1) / `low`(2) / `default`(3) / `high`(4) / `urgent`(5)。`urgent` 穿透勿扰 |
| `tags` | string[] | 标签短码，匹配 emoji 的会变图标：`warning`→⚠️、`rocket`→🚀 |
| `markdown` | bool | 正文按 Markdown 渲染 |
| `click` | url | 点通知打开的链接 |
| `actions` | array | 最多 3 个按钮，见下 |
| `attach` | url | 外部附件（服务端下载后再推） |
| `icon` | url | 通知图标 |
| `delay` | string | 定时投递，`30min` / `2h` / `tomorrow 9am`，范围 10 秒 ~ 3 天 |
| `email` | string | 同时转发邮箱（需服务端 SMTP） |
| `call` | string | 语音播报（需服务端通话配置） |
| `cache` | bool | `false` = 不落服务端缓存，含敏感内容时用 |

### 动作按钮

```json
"actions": [
  { "action": "view", "label": "打开面板", "url": "https://example.com/", "clear": true },
  { "action": "http", "label": "知道了", "url": "https://example.com/ack", "method": "POST" }
]
```

`action` 三种：`view`（开网页/App）、`http`（发请求）、`broadcast`（Android 广播）。
`clear: true` 点了就把这条通知从通知栏清掉——适合「已阅」类告警。

## ntfy_send_file 参数

| 参数 | 说明 |
|---|---|
| `file` | **必填**，本机绝对路径 |
| `filename` | 手机上显示的名字，默认用原文件名 |
| `message` / `title` / `priority` / `tags` / `click` / `delay` / `cache` | 同上 |

## 审批转发（approval relay）

除了「agent 主动推消息」，插件还可以在**审批超时**时替你叫人：

- agent 在 Web 页面弹出审批（执行命令要升级沙箱、插件管理等）后，先照常等你在页面上点；
- 超过 `approvalDelayMs`（默认 5 分钟）还没人处理，就往手机推一条
  「需要审批：<工具名>」，正文带上工具名和原因；
- 通知上有两个按钮：**✅ 通过** / **⛔ 拒绝**，点了直接落成
  `allowed-once` / `rejected`，agent 继续或停下；点通知本身则打开 DSH。

几个行为细节：

- **页面优先**：5 分钟内你在页面上点了，就不会推送；推送发出去之后，页面上点也仍然有效
  （谁先到算谁的，后到的丢弃）。
- **页面关了也会推**：没有任何界面应答者时（页面关了、审批来自无界面的会话），请求
  不会立刻失败，而是等满 5 分钟再推；如果连推送都失败，才按 fail-closed 返回 unavailable。
- **取消即撤销**：回合被取消 / 工具调用中止时，定时器清掉，不会再推。
- **按钮是一次性的**：回调 URL 里的随机 id 就是凭证，处理过或过期的 id 返回 410。
  回调只接受 POST（GET 会被 405 掉），避免链接预览/预取误触发。
- **和登录的关系**：回调路由是 `/dsh-ntfy/approval/…`，比 `dsh-webui-auth` 的 `''`
  前缀更长，所以不会被登录页截走；它不依赖 cookie，靠 URL 里的 128 位随机 id 鉴权。
  因此 `approvalBaseUrl` 必须是**手机能访问到的** DSH 地址（通常是反代后的 HTTPS 域名）。

页面上的审批卡会一起消失：监听器给下游应答者换了一条**展示期信号**（镜像工具自己的取消
信号），手机（或任何别处）落定后中止它；Remote Event 网关会向客户端发 `cancel` 帧，卡片
随之关闭。工具自己的取消信号不受影响，不会把刚批准的调用一起杀掉。

配置（`cordis.patch.yml`）：

| 键 | 默认 | 说明 |
|---|---|---|
| `approvalEnabled` | `false` | 打开审批转发 |
| `approvalDelayMs` | `300000` | 等多久没人处理才推（毫秒） |
| `approvalBaseUrl` | `''` | 手机能访问到的 DSH 根地址，如 `https://dsh.example.com`；留空不启用 |

## 配置

`cordis.patch.yml`：

| 键 | 说明 |
|---|---|
| `url` | 服务根地址，**不带 topic**，如 `https://ntfy.example.com` |
| `topic` | 频道名（URL 里 `/` 后面那段） |
| `accessToken` | 服务端开了 ACL 时填 Bearer token |
| `defaultPriority` / `defaultTags` | 未指定时的默认值 |

## 几个实现上的坑（踩过，写下来省得再踩）

**1. JSON 发布的 `priority` 必须是数字。**
传 `"default"` 字符串，ntfy 回的是 `request body must be valid JSON` ——
一个和真实原因毫无关系的错误。插件里做了映射：`default → 3`。

**2. JSON 发布要 POST 到根路径。**
`POST /<topic>` + JSON body 会被当成**纯文本**发出去（body 原样变成消息内容）。
只有 `POST /` 才会解析 JSON。缓存开关 `?cache=no` 同理只能挂在根路径上。

**3. HTTP 头不支持中文。**
`ntfy_send_file` 走的是 PUT + 头传参，文件名/标题带中文会让 fetch 直接抛
`Invalid character in header content`。插件按文档做了 RFC 2047 编码：
`=?UTF-8?B?<base64>?=`。

**4. 安卓端拿到的附件没有扩展名（服务端无能为力）。**
ntfy 安卓 App 的 `DownloadAttachmentWorker` 把附件存成 `cache/attachments/<消息ID>`
（`ensureSafeNewFile(attachmentDir, notification.id)`，**不带扩展名**），再通过
FileProvider 交给系统打开。服务端这边 `Content-Disposition` / `Content-Type` /
URL 里的 `.txt` 都是对的（2026-10-31 实测），但 App 一律不认。

后果：靠扩展名识别格式的应用（典型是 WPS）会显示成「?」+ 后跟 `消息ID` 的文件名。
要靠 MIME 认内容的应用（相册、PDF 阅读器、Chrome）反而正常。

所以：
- 发截图/图表/PDF 没问题，优先发这些；
- 发 `.txt` / `.log` / `.csv` 这类纯文本，手机上大概率打不开——**文本内容优先走
  `ntfy_send` 的 Markdown 正文**，别塞成附件；
- 真要发文本文件，让用户「用其他应用打开」选文本编辑器，或在浏览器里直接开
  `…/file/<id>.txt`（浏览器按 `Content-Disposition` 存盘，名字是对的）。

## 服务端要求

- **附件**：需要服务端配 `base-url` 和 `attachment-cache-dir`，否则会返回
  `40014 attachments not allowed`。`attach`（URL 附件）和 `ntfy_send_file`（本地上传）都受此限制。
- **邮件 / 电话**：需要服务端配 SMTP / 通话后端，默认关闭。

### 部署备忘

服务端部署属于本机资料，不随仓库分发：见 `~/dsh/doc/`。

- 本机独有的一切（部署、路径、凭据位置）都放 `/opt/dsh/doc`，`~/dsh/doc` 是指向它的软链。
- 这里只留占位值：`cordis.patch.yml` 里 `url` 是 `https://ntfy.example.com`、`topic` 为空。
  真实值（含 topic，它等同于口令）写在 profile 的 `cordis.patch.yml` 里。
- **鉴权**：`accessToken` 只在服务端开了 `auth-users` / ACL 时才有意义。

## 安装

跟 `dsh-qq-onebot` 一样用 link 依赖：

```bash
ln -s /path/to/dsh-ntfy ~/.dsh/profiles/web/node_modules/dsh-ntfy
```

profile 的 `package.json` 里把包名加进 `dsh.profile.bundles` 和 `dependencies`
（`"dsh-ntfy": "link:/path/to/dsh-ntfy"`），然后重启 dsh。

## 和脚本的关系

插件是给 agent 在对话里用的；定时任务（巡检、抓包报告）走的是
`notify.sh` + curl，**不依赖 dsh 是否活着**。两条路互不影响。
