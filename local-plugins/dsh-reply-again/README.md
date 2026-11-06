# dsh-reply-again

One **icon** in front of each user message: click it to send that message
again, so the agent answers it afresh.

## When to use it

- A prompt was accepted but the reply never arrived: provider error, quota
  failure, or the agent stopped before producing an answer.
- A reply was cut off: the turn was interrupted, the process restarted
  mid-turn, or the answer was frozen as a partial.
- The user simply wants a second, independent answer to the same message.

A draft send that the Composer refuses never needs this control: the stock
composer keeps the draft and the user can press Enter again. The control covers
the cases where the message already left the composer.

## Where it sits

`conversation.chat.user.before` — the chain slot rendered inside the user row,
before the bubble. It is the one user-owned decoration point in Chat, so the
control belongs to the message it re-sends rather than to the assistant reply
under it. The row is laid out as a two-column grid by this plugin so the icon
sits on the bubble's line at its left (the copy/branch row still spans
underneath). Icon only, revealed on hovering the row; steering rows and local
echoes decline through the entry's selector.

## What it sends

| Part | Behavior |
|---|---|
| Text | The message text, verbatim, as one text block |
| Images | Re-read with `session.readAttachment` and inlined as base64 prompt parts — the same shape a subagent continuation sends. Their per-prompt receipts are gone, but the bytes stay addressable |
| Files | Refused. `PromptContentPart` takes a per-prompt `receiptId` for a generic file and nothing reconstructs one here, so the icon renders disabled and explains why |
| While running | Hidden; there is nothing to re-answer until the Turn settles (the row keeps its width, so the bubble does not shift) |
| Failure | The Session's own prompt-error surface, exactly as for a failed draft send |
| Success | Nothing but the new user message; the plugin adds no toast of its own |

The duplicate user message in the transcript is intentional: this is a re-ask,
not a branch, and the transcript should show what the agent was actually sent.

## Install

Local plugin source lives in `local-plugins/dsh-reply-again/`. Install or
update it with the house installer:

```sh
/opt/dsh/deepseek-harness/local-plugins/dsh-safe-install/dsh-safe-install.sh \
  link:/opt/dsh/deepseek-harness/local-plugins/dsh-reply-again
```

The client half is served straight from this directory, so a page reload picks
up an edit; only a change to the bundle manifest or the profile needs a restart.

## Removal

Remove the `dsh-reply-again` bundle entry and dependency from the profile, or
delete the row from the profile's composed patch. The plugin writes nothing to
disk and keeps no Session state.
