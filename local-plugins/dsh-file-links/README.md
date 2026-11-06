# dsh-file-links

让 agent 回复里的文件引用变成**可点击的侧边栏导航**：`` `packages/client/ui-chat/src/client/apply.ts:272` ``
点一下就在右侧边栏打开这个文件、跳到第 272 行，和点 diff 卡片里的文件行是同一种效果。

## 它解决什么

Web 端助手回复里的行内代码，只有一个地方能被点击：`ui-deliverables` 提供的
`chatFileMentions` 词汇表，它只认**本轮**通过写文件 / `present` 交付过的路径。
于是回复里随口引用的其它文件（甚至它刚读过的那一行）都是死文本。

这个插件在同一个接缝上补一张词汇表：形状像文件的 token 都能点，并且把
`:行号` / `:行:列` / `:起-止` / `#L起-L止` 带到预览里。

## 行为

| 写法 | 结果 |
|---|---|
| `src/foo.ts` | 打开该文件 |
| `src/foo.ts:42`、`foo.ts#L42`、`foo.ts:42:7`、`foo.ts:42-50` | 打开并定位到第 42 行（列和结束行只解析、不单独选中） |
| `/abs/path/README.md`、`file:///abs/path/a.ts:12` | 绝对路径同样可点 |
| `apply.ts:272`（本轮写过 `apply.ts`） | 先用交付词汇表解析成真实绝对路径，再挂上行号 |
| `Node.js`、`ctx.slots.inject`、`v0.2.2-alpha.3`、`npm run build`、`src/*.ts`、`packages/`、`~/x/y.md`、URL | 保持普通文本 |

- **点击**：`owner.openFile(path, { line })` —— Chat 自己的打开器，按会话当前工作目录解析路径、
  在右侧边栏开（或复用）该文件的标签页、把行号作为导航参数交给预览，
  代码预览会翻页到那一行并闪一条高亮带。
- **右键**：走和交付卡片一样的文件上下文菜单（复制路径、打开等）。
- **无障碍**：按钮的 aria-label 是本地化的「打开 X / 定位到第 N 行」，title 是完整路径。
- 流式过程中的消息不挂链接（`MarkdownText` 的词汇表只在定稿渲染生效），这是宿主的设计。
- Markdown 链接里的本地文件走 ui-primitives 自己的 delegate，本来就带行号，与这里无关。

## 接缝与实现

`chatFileMentions` 是**单提供者服务**，由 `ui-deliverables` 提供；再 `provide` 一次会抛错并把
改动文件卡片一起带下水。所以本插件不替换服务，而是**包一层**：

```
forClosing(owner, sessionId, getFileTriggerProps)
  = deliverables 的 resolver（命中就用它）
    ?? 本插件的路径语法（解析不出就留空）
```

包装装在服务对象上，随插件卸载恢复原方法。等待服务出现用 `ctx.inject(['chatFileMentions'])`，
加载顺序交给组合层。

## 已知边界

- 只处理**行内代码**（`` `...` ``）。正文里裸写、没有反引号的路径不会变链接——
  Markdown 渲染器没有对应的扩展点，硬做只能去改 DOM。
- 不做存在性校验：浏览器端拿不到同步的文件系统查询（`workspaceFiles.stat` 是异步的，
  而 `resolve` 在 render 期间同步调用）。点到一个不存在的路径时，预览自己的
  「文件不存在」状态就是反馈。
- `~` 开头的路径不展开（浏览器侧无法确定 home 目录，猜反而更糟）。
- 裸文件名靠一份精选扩展名表 + 常见无扩展名文件名识别；`Node.js` 这类散文名用一张小名单排除。
- 只作用于助手回复；用户消息里的引用走 `ui-reference` 自己的 `@` 词法。

## 文件

| 文件 | 作用 |
|---|---|
| `client.js` | 全部逻辑：路径语法、词汇表包装、点击打开 |
| `index.js` | Host 半边占位（无 Host 行为） |
| `cordis.patch.yml` | 一条 `file-links` 插件行 |
| `locale/*.json` | 插件清单里的标题与描述 |
