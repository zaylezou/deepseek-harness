# dsh-restart-anywhere (fork)

Restart dsh **in place** — from the sidebar ↻ row or from the `dsh_restart`
agent tool — and bring every in-progress session back with it.

This is the fork-local copy of [`dsh-restart-anywhere` 0.1.7][upstream] carried
by this checkout. The restart mechanism (execve / wrapper / systemd timer, the
`/api/dsh-restart` route, the sidebar button) is unchanged; the **handoff**
around it is not.

[upstream]: https://github.com/JoblessJoe/dsh-restart-anywhere

## 中文摘要

上游 0.1.7 只给「调用 `dsh_restart` 的那个会话」留一条 wake；其他正在跑的
会话被直接掐断，重启后也没人叫醒它们。本 fork 在重启前把所有**进行中**的
顶层会话（正在跑 turn，或还有排队的 inbox 消息）快照进 wake 文件，新进程
启动后逐个用 follow-up 唤醒，并告诉它「你被重启打断了、从断点继续」。
调用方自己也会被唤醒：`continue_prompt` 变成它唤醒后的指令，不传则用默认的
「继续上次工作」。等待唤醒的会话按 250ms 错开发车，避免同时打模型。

## What changes from upstream 0.1.7

| | upstream 0.1.7 | this fork |
|---|---|---|
| wake payload | one `{ sessionId, prompt, at }` | `{ version: 2, reason, caller, entries[] }` |
| sessions resumed | only the caller, only with `continue_prompt` | every in-progress top-level session, caller included |
| caller without prompt | nothing wakes it | default "continue where you stopped" notice |
| other running sessions | killed silently | resumed with an interruption notice |
| boot delivery | one follow-up, no flush check | one follow-up per entry, `sessions.flush` checked, failures isolated |
| DSH 0.2.2 agent registry | broken (`agents.roots()`) | fixed (`agents.list()` + `parentSession` root gate) |
| tool parameters | `continue_prompt` | `continue_prompt`, `reason` |
| sidebar confirm | "sessions will be interrupted" | "interrupted, then resumed automatically" |

What counts as **in progress**: a live top-level agent whose status is `running`
or whose inbox still has queued `next-turn` / `next-step` messages. Subagent
sessions (`header.origin === 'subagent'`) are skipped: their parent is the one
that must decide how to continue, and a child cannot be resumed through
`sessionController.resolveAgent` anyway. Limitation: a subagent that is still
running while its parent is idle at restart time is not resumed independently.

The resumed session's transcript gets a durable, model-visible user message:
an interrupted one is told its turn was cut off and that in-flight tool calls,
subagents, and background jobs are gone; an idle-with-queued-work one is told
its queue was dropped. Both are told to re-check state before repeating side
effects and to continue instead of starting over. The caller's
`continue_prompt`, when supplied, keeps the upstream wording
(`dsh has restarted (you called dsh_restart). Continue: …`) so existing
instructions keep working.

## Wake file

`$DSH_HOME/restart-anywhere/wake.json`, written atomically (tmp + rename)
before the tree is torn down, and claimed by rename on boot so two racing dsh
processes cannot both wake the same sessions.

- Older than 30 minutes → dropped: it belongs to a restart that never happened.
- Version 1 (upstream) files are still accepted, so a restart performed by the
  previous install hands off cleanly to this one.
- Only the caller's `continue_prompt` and an optional `reason` live in the
  file; the notice text is composed after boot.

## Install in this profile

The profile links this checkout instead of installing the npm package:

```bash
# ~/.dsh/profiles/web/package.json
"dsh-restart-anywhere": "link:/home/opt/dsh/deepseek-harness/local-plugins/dsh-restart-anywhere"

ln -s /home/opt/dsh/deepseek-harness/local-plugins/dsh-restart-anywhere \
  ~/.dsh/profiles/web/node_modules/dsh-restart-anywhere
```

It is **not** in `local-plugins/patches/dsh-local-patches.sh`: the fork folds
the old `root-agents.py` patch into its source, so there is nothing to
re-derive after a reinstall. `pnpm` recreates the link from the `link:`
specifier; upgrading the upstream package would replace this fork, so treat an
upstream bump as a merge, not an install.

No configuration keys. `/api/dsh-restart` answers `GET` with the detected mode
and `POST` with `{ ok, mode, via, boot, resuming }`, where `resuming` is the
number of sessions parked for the next boot.

## Tests

`node --test test/*.test.js` from this directory. The tests use a fake Cordis context
and a temporary `DSH_HOME`; they never touch the running dsh.
