# AGENTS.md

npm-workspaces monorepo for leter's Pi packages. No package is currently maintained under `packages/`.

## Git

- Use English conventional commit messages with a scope.
- Keep one concern per commit.
- Never commit, merge, or push without explicit user confirmation.

## Runtime workflow

| User says | Script (from repo root) |
| --- | --- |
| 验证 / 全量测试 / verify | `bash scripts/verify.sh` |
| 单包验证 / verify one package | `bash scripts/verify.sh <package-dir-name>` |
| 诊断 / 环境检查 / doctor | `bash scripts/doctor.sh` |

`verify.sh` must pass before a commit or handoff.
