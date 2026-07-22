# Session Title

A versioned local Pi extension that uses a small AI classifier to keep the terminal title aligned with the latest concrete human instruction.

For each human input, the classifier receives only the current effective title and the new input. It keeps the previous title for acknowledgements or continuation messages, and generates a new title when the user starts, corrects, refines, redirects, or stops concrete work. Decisions run asynchronously and never block the main Agent. Invalid output, missing credentials, timeouts, and request failures keep the previous title.

After three consecutive failures in one Pi Session, the extension stops calling the title model. A valid `keep` or `update` decision resets the failure count. Starting or reloading a Session resets the circuit breaker and allows calls again. The failure count is memory-only and is never persisted.

The classifier uses `gpt-5.4-mini` through the OpenAI-compatible BYOK credentials already stored in Droid's `~/.factory/settings.local.json` or `~/.factory/settings.json`. It reads the key at runtime and never copies it into this repository or another config file. See [Droid BYOK](https://docs.factory.ai/cli/byok/overview).

Slash commands, shell input, extension-generated messages, and exact acknowledgement phrases such as `继续`、`好的`、`可以` are filtered locally without an AI request. Other short inputs such as `提交`、`回滚`、`删除` still go to the classifier so it can combine them with the current title.

Chinese titles target 8–14 characters. Every title has a hard limit of 28 terminal columns, excluding the sidebar's `▸ ` prefix. Overlong model output is truncated locally at a grapheme boundary and ends with `…`; it never triggers a second model request. Titles are persisted as Pi custom Session entries. The first accepted title becomes the stable Pi Session Name; later accepted titles update only the native terminal title.

## Install locally

From the repository root:

```bash
bash tools/session-title/scripts/install-local.sh
```

The installer copies the tracked source to `~/.pi/agent/extensions/herdr-session-title.ts`. Run `/reload` in Pi afterward.

The repository file is authoritative. Do not edit the installed copy directly.

## Test

```bash
node --import tsx --test tools/session-title/tests/session-title.test.ts
```
