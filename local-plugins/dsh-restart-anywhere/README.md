# dsh-restart-anywhere (fork)

Restart dsh **in place** — from the sidebar's 更多 (More) menu, from the
`dsh_restart` agent tool, or **without cutting anyone off** from
`dsh_safe_restart` / the menu's "空闲时重启 dsh" (Restart when idle) row, which
waits for every running turn to finish first. Both rows and every confirm/toast
follow the app language (zh/en dictionaries in `lib/client.js`; the plugin
list's own title/description live in `locale/*.json`).

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

另有一个**安全重启**（`dsh_safe_restart` 工具 / 侧栏「Restart when idle」）：
先等所有正在跑 turn 的会话把手头这轮跑完，再重启，谁都不会被打断，也就谁也
不需要被唤醒；等超过 `max_wait_seconds`（默认 120s）还忙，就**放弃重启**并回一条
消息给发起方，而不是掐断别人的活。

## What changes from upstream 0.1.7

| | upstream 0.1.7 | this fork |
|---|---|---|
| wake payload | one `{ sessionId, prompt, at }` | `{ version: 2, reason, caller, entries[] }` |
| sessions resumed | only the caller, only with `continue_prompt` | every in-progress top-level session, caller included; a blank chat nobody typed into is left alone |
| caller without prompt | nothing wakes it | default "continue where you stopped" notice |
| other running sessions | killed silently | resumed with an interruption notice |
| boot delivery | one follow-up, no flush check | one follow-up per entry, `sessions.flush` checked, failures isolated |
| DSH 0.2.2 agent registry | broken (`agents.roots()`) | fixed (`agents.list()` + `parentSession` root gate) |
| tool parameters | `continue_prompt` | `continue_prompt`, `reason` |
| where it lives | one sidebar footer row | two rows in the sidebar 更多 menu, zh/en localized |
| safe restart | — | `dsh_safe_restart` tool + "Restart when idle" row: waits for running turns, cancels instead of cutting work |

What counts as **in progress**: a live top-level agent that still has a
conversation to lose — at least one `user/message` or `assistant/message` in its
surface — and whose status is `running`, or that has something other than a
harness notice queued in `next-turn` / `next-step`. Subagent sessions
(`header.origin === 'subagent'`) are skipped: their parent is the one that must
decide how to continue, and a child cannot be resumed through
`sessionController.resolveAgent` anyway. Limitation: a subagent that is still
running while its parent is idle at restart time is not resumed independently.

A **blank chat is not in progress**. Opening a new conversation keeps an Agent
alive for it and the session controller queues permission notices
(`source.kind === 'user-approval'`) in its inbox, so status and queue alone used
to wake a session nobody had typed into — and the model then invented work to
"continue". Such a session is now left alone, and the restart logs
`left N unused session(s) alone: <ids>` so the omission is visible. Two
deliberate choices: a transcript that cannot be read counts as work (losing it
is the worse failure), and a message source this fork does not know counts as
human work, so a producer such as the QQ adapter is never silently dropped.

The resumed session's transcript gets a durable, model-visible user message:
an interrupted one is told its turn was cut off and that in-flight tool calls,
subagents, and background jobs are gone; an idle-with-queued-work one is told
its queue was dropped. Both are told to re-check state before repeating side
effects and to continue instead of starting over. The caller's
`continue_prompt`, when supplied, keeps the upstream wording
(`dsh has restarted (you called dsh_restart). Continue: …`) so existing
instructions keep working.

## Safe restart

`dsh_safe_restart` (and `POST /api/dsh-restart?when=idle&wait=<seconds>`, and
the sidebar More menu's "空闲时重启 dsh") is the opposite trade-off from
`dsh_restart`: instead of parking sessions and resuming
them, it **waits** until no top-level session has a running turn, then restarts.
Nothing is interrupted, so nothing is resumed — a session that was mid-turn
finishes its turn and simply stays idle across the restart, with no notice in
its transcript.

- The caller cannot wait inside the tool call: its own turn is one of the turns
  that must end. The tool therefore schedules the drain and returns; end your
  turn and the restart follows within a poll interval (500 ms).
- Waiting is bounded (default 120 s, `max_wait_seconds` up to 3600). If sessions
  are still working at the deadline, the restart is **cancelled**: nothing is
  cut off, and the calling session gets a follow-up saying so.
- `continue_prompt` keeps the caller's own handoff (it is parked in the wake
  file and woken after the restart); without it nobody is woken at all.
- Queued-but-idle work cannot drain by waiting, so a session holding it is still
  parked at commit time and resumed — the same rule as the hard restart.
- An immediate `dsh_restart` supersedes a pending safe restart.

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
"dsh-restart-anywhere": "link:/opt/dsh/deepseek-harness/local-plugins/dsh-restart-anywhere"

ln -s /opt/dsh/deepseek-harness/local-plugins/dsh-restart-anywhere \
  ~/.dsh/profiles/web/node_modules/dsh-restart-anywhere
```

It is **not** in `local-plugins/patches/dsh-local-patches.sh`: the fork folds
the old `root-agents.py` patch into its source, so there is nothing to
re-derive after a reinstall. `pnpm` recreates the link from the `link:`
specifier; upgrading the upstream package would replace this fork, so treat an
upstream bump as a merge, not an install.

No configuration keys. `/api/dsh-restart` answers `GET` with the detected mode
(plus `draining: { until, waiting, sessions }` while a safe restart waits) and
`POST` with `{ ok, mode, via, boot, resuming }`, where `resuming` is the number
of sessions parked for the next boot. `POST ?when=idle&wait=<seconds>` schedules
a safe restart instead and answers `{ ok, draining: true, until, waiting }`.

## Tests

`node --test test/*.test.js` from this directory (17 tests). They use a fake
Cordis context and a temporary `DSH_HOME`, cover both tools end to end through a
child-process fixture, and never touch the running dsh.
