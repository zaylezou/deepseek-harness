# dsh-reply-again

A **Re-answer** control under a closed Turn in the Harness Web GUI. It sends
that Turn's user message again, as a fresh prompt, so the agent answers it from
scratch.

## When to use it

- A prompt was accepted but the reply never arrived: provider error, quota
  failure, or the agent stopped before producing an answer.
- A reply was cut off: the turn was interrupted, the process restarted
  mid-turn, or the answer was frozen as a partial.
- The user simply wants a second, independent answer to the same message.

A draft send that the Composer refuses never needs this control: the stock
composer keeps the draft and the user can press Enter again. The control covers
the cases where the message already left the composer.

## What it does

| Aspect | Behavior |
|---|---|
| Placement | The Turn tail (`conversation.chat.turnTail`), below the reply, in the same hover-reveal group as the copy/branch icons |
| Sent | The Turn's opening user message text, verbatim, as one text block |
| Not sent | Attachments. Image and file receipts are per-prompt and cannot be replayed, so a message with attachments renders the control disabled and explains why |
| Busy | Disabled while the session runs; a Turn cannot be re-asked over an in-flight one |
| Failure | The Host's business error (writer held, agent busy) is surfaced in the composer's notice rail, the same place a failed send appears |
| Success | An info notice in the composer; the new prompt appears as a normal user message |

The duplicate user message in the transcript is intentional: this is a re-ask,
not a branch, and the transcript should show what the agent was actually sent.

## Install

Local plugin source lives in `local-plugins/dsh-reply-again/`. Install or
update it with the house installer, then restart:

```sh
/opt/dsh/deepseek-harness/local-plugins/dsh-safe-install/dsh-safe-install.sh \
  link:/opt/dsh/deepseek-harness/local-plugins/dsh-reply-again
```

## Removal

Remove the `dsh-reply-again` bundle entry and dependency from the profile, or
delete the row from the profile's composed patch. The plugin writes nothing to
disk and keeps no Session state.
