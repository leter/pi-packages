# Pi Packages

A public monorepo for Pi extensions, skills, prompts, and themes maintained by [leter](https://github.com/leter).

## Packages

| Package | Status | Description |
|---|---|---|
| [`pi-herdr-dispatch`](./packages/pi-herdr-dispatch) | Phase 5 review | Safely dispatch work from Pi to existing agents in a local Herdr workspace. |

## Repository layout

Each directory under [`packages/`](./packages) is an independent Pi package with its own documentation, manifest, source, and tests. Shared code will be introduced only after at least two packages need the same module.

## Development

```bash
npm install
npm run check
npm test
```

During local development, install a package by absolute path:

```bash
pi install "$PWD/packages/pi-herdr-dispatch"
```

Then use `/reload` after source changes. Packages that are still marked as design or development are not installable yet.

## Distribution plan

- The whole repository may be installed from Git once a root Pi manifest is published.
- Stable Git releases use repository tags such as `v0.1.0`.
- Individual packages may later be published separately to npm for selective installation and independent updates.

## Security

Pi extensions execute with the current user's full permissions. Review a package's source and documentation before installing it. Never commit API keys, `.env` files, local session data, pane output, or Registry databases.

## License

[MIT](./LICENSE)
