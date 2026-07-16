# AGENTS.md

npm-workspaces monorepo for leter's Pi packages. Currently one package: `packages/pi-herdr-dispatch` (a Pi extension; it has its own `AGENTS.md` — read it before touching that package).

## Git

- Commit message format: English conventional commits with a scope, e.g. `feat(ui): render themed TUI surfaces`, `fix(dispatch): close live acceptance edge cases`, `docs(pi-herdr-dispatch): record final acceptance`.
- One concern per commit: split tests, refactors, docs, and CI config into separate commits.
- Never commit, merge, or push without the user's explicit confirmation in the current conversation. Finishing a task or passing `verify.sh` does NOT count as authorization.

## Runtime workflow

Treat the user's phrase as a command intent. If a row matches, run the exact script from the repo root instead of hand-composing npm/vitest commands.

| User says | Script (from repo root) |
| --- | --- |
| 验证 / 全量测试 / verify | `bash scripts/verify.sh` |
| 单包验证 / verify one package | `bash scripts/verify.sh <package-dir-name>` (e.g. `pi-herdr-dispatch`) |
| 真机契约测试 / live contract / live 验证 | `bash scripts/verify.sh live` |
| 诊断 / 环境检查 / doctor | `bash scripts/doctor.sh` |

Rules:

- This table is the single source of the phrase→script mapping. When scripts are added or renamed, update this table in the same change; `verify.sh` self-checks that every script named here exists and that every `scripts/*.sh` appears here.
- `verify.sh` (type-check + full test suite) must pass before any commit or handoff.
- Live contract tests talk to the real Herdr server and are excluded from `verify.sh`'s default mode and from CI; run them only inside a Herdr pane via `verify.sh live`.

## Environment

- Node.js 24+ is required (`node:sqlite`). Install dependencies with `npm ci` at the repo root.
- Pi loads extensions from TypeScript source (`package.json` → `pi.extensions`); there is no build step.
- The extension dev loop is: edit source → run `/reload` in the Pi session (which must run inside a Herdr pane with `HERDR_SOCKET_PATH`, `HERDR_WORKSPACE_ID`, `HERDR_PANE_ID`). `pi install ./packages/<name>` is a one-time path-reference registration in `~/.pi/agent/settings.json`, not a copy — never reinstall to pick up code changes.
- For pure logic or rendering changes, running the focused vitest file is a faster inner loop than a live `/reload`.

## Documentation contract

- `CONTEXT-MAP.md` indexes the bounded contexts; each package's `docs/CONTEXT.md` is the terminology authority — use its exact terms in code, docs, and commit messages.
- User-visible behavior changes must update the package README **and** its translations (e.g. `README.zh-CN.md`) in the same change. The English version is authoritative.
- Design-level changes (state vocabulary, lifecycle, safety rules) must update the package's `docs/DESIGN.md`; significant decisions get an ADR under `docs/adr/`.
