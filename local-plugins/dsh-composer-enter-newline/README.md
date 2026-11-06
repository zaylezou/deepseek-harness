# dsh-composer-enter-newline

把对话输入框的 Enter / Shift+Enter / Ctrl（Cmd）+Enter 变成**可配置**的发送键位，
并替换设置里原来那个「繁忙时的发送行为」选项。

## 设置

设置 → 通用 → **发送键位**（原来「繁忙时的发送行为」所在的位置），三个键各选一个：

| 选项 | 行为 |
| --- | --- |
| 换行 | 插入软换行（走编辑器自己的 `INSERT_LINE_BREAK_COMMAND`，Safari 也有效） |
| 排队发送 | 发送；智能体运行中时排进队列 |
| 强制发送 | 发送；智能体运行中时插话进当前轮，空闲时就是普通发送 |

出厂默认：`Enter` = 换行，`Shift+Enter` = 换行，`Ctrl/Cmd+Enter` = 排队发送。

设置按浏览器保存在 `localStorage`（`dsh.composer-enter-newline.v1`），同一模型和
快捷键编辑器一致：换设备不跟随。多标签页之间会同步。

## 实现

composer 的 `Enter=发送 / Shift+Enter=换行 / Ctrl+Enter=加速发送` 写在
`@deepseek-ai/dsh-client-ui-conversation` 的 keymap 里，不是插件 API。本插件在
document 捕获阶段接管这几个键：

- **换行**：直接派发编辑器自己的 `INSERT_LINE_BREAK_COMMAND`（Shift+Enter 最终走
  的就是这条命令），所以合成 keydown 在 Safari 上没默认行为的问题也绕开了。
- **排队 / 强制发送**：派发**合成的 Enter**（普通手势或加速手势），而不是直接调
  内部 submit。这样 composer 原本的所有闸门都还在：上传未完成的提示、菜单仲裁、
  空输入拒发、空输入 + 运行中把待发队列插话的快捷手势、以及「发送中」防重入。
- 核心对「普通 Enter」和「加速手势」的语义是**互为相反**的忙碌模式，所以插件先读
  `ui-conversation` 的 `busyEnter` 偏好，再决定该派发哪个手势，从而让「排队发送」
  和「强制发送」与旧设置无关地稳定生效。

设置行的替换方式：以 `id: composer-enter`、`priority: -1` 重新注册
`settings.general.item` —— 文档化的影子注册（同一 cell 里 priority 最低者渲染）。

## 交互细节

- 触发菜单 / 补全菜单有高亮项时，Enter 系列键归菜单（选中高亮项），不发送也不换行。
- 输入法组合中的 Enter 不动。
- `Shift+Ctrl/Cmd+Enter`、`Alt+Enter` 保持核心原有处理。
- 只作用于主对话输入框（`[data-composer-input]`）；提问卡片里的独立输入框不受影响。
- 设置 → 快捷键参考面板里仍是出厂绑定说明（`fixed.send` = Enter 等），那是核心的
  只读行，插件没有覆盖入口。实际行为以本插件的设置为准。

## 停用

在插件管理里关掉 `dsh-composer-enter-newline`，原来的「繁忙时的发送行为」行会回来，
键位恢复出厂（Enter 发送）。
