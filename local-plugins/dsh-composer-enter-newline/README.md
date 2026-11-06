# dsh-composer-enter-newline

Rebinds the conversation composer's Enter gestures in the DSH Web UI:

| Key | Behavior |
| --- | --- |
| `Enter` | 换行（插入 soft line break） |
| `Ctrl+Enter` / `Cmd+Enter` | 发送（与发送按钮完全相同） |
| `Shift+Enter` | 换行（不变） |
| 菜单有高亮项时的 `Enter` | 选中高亮项（不变） |
| 输入法组合中的 `Enter` | 上屏（不动） |

## 为什么需要它

composer 的 `Enter=发送 / Shift+Enter=换行 / Ctrl+Enter=加速发送` 写在
`@deepseek-ai/dsh-client-ui-conversation` 的 keymap 里，不是插件 API。
本插件在 document 捕获阶段先把这两个键拦下来：

- `Enter`：直接调用编辑器自己的 `INSERT_LINE_BREAK_COMMAND`（就是 Shift+Enter
  最终走的那条命令），所以 Safari 上也能换行（合成 keydown 在 Safari 里没有
  beforeinput 默认行为）。
- `Ctrl+Enter`：派发一个**去掉修饰键的合成 Enter**，走的还是 composer 原本的
  提交路径——忙碌时的「排队 / 插话」偏好、附件上传未完成的提示、各种 toast
  都和以前按 Enter 一模一样。

## 安装

这是一个本地 bundle（`link:` 安装）。在仓库里的源目录：
`local-plugins/dsh-composer-enter-newline`，装进 profile 后刷新页面即可生效。

停用：在插件管理里关掉这一行，或从 profile 的 `dsh.profile.bundles` 里移除
`dsh-composer-enter-newline` 并刷新。

## 已知取舍

- 快捷键参考面板（设置 → 快捷键）里仍然是出厂绑定说明（`fixed.send` =
  Enter 等），那是核心的只读行，插件没有覆盖入口。实际行为以本插件为准。
- 「空输入 + 运行中按 Ctrl+Enter 把待发队列插话进当前轮」这个旧手势不再存在：
  Ctrl+Enter 现在是普通发送手势。队列区的插话按钮仍然可用。
- 只作用于主对话输入框（`[data-composer-input]`）；提问卡片里的独立输入框
  不受影响。
