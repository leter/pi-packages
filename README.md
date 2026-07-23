# Pi Packages

A public monorepo for Pi extensions, skills, prompts, and themes maintained by [leter](https://github.com/leter).

## Packages

No Pi packages are currently maintained under `packages/`.

## Plugins

| Directory | What it is |
| --- | --- |
| `agent-activity/` | Herdr sidebar plugin for Agent identity, scope, and status |
| `session-title/` | Pi extension that keeps the terminal title aligned with the latest instruction |

Install from the repository root:

```bash
bash agent-activity/scripts/install-local.sh
bash session-title/scripts/install-local.sh
```

## Development

```bash
npm ci
npm run verify
npm run doctor
```

Each future directory under `packages/` is an independent Pi package.

## Security

Pi extensions execute with the current user's full permissions. Review package source before installation. Never commit API keys, local session data, or runtime databases.

## License

[MIT](./LICENSE)
