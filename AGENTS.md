# Repository Guidelines

## Project Structure & Module Organization
This repository is a small Node.js bridge service that connects channel messages to local CLI agent sessions. Runtime code lives in [`src/`](/vol3/1000/workspace/codex-bridge/src): `index.js` boots the process, `bridge-service.js` handles routing and task queues, `codex-runner.js` spawns Codex, and the Feishu transport is split across `feishu-client.js` and `feishu-ws-client.js`. Persistent local state is written to `.agent-bridge/state.json`. Vendored third-party SDK code is kept under `.vendor/`; treat it as upstream code and avoid editing it unless you are intentionally updating the vendor snapshot.

## Build, Test, and Development Commands
There is no build step. Use Node 18.18+.

- `npm install`: install package metadata dependencies if the manifest changes.
- `npm start`: run the bridge once with `node src/index.js`.
- `npm run dev`: start the service in watch mode for local iteration.
- `curl http://127.0.0.1:3000/healthz`: verify the optional health server after startup.

Set secrets and runtime options in a local `.env` file as documented in [`README.md`](/vol3/1000/workspace/codex-bridge/README.md).

## Coding Style & Naming Conventions
Follow the existing plain JavaScript ESM style: 2-space indentation, semicolons, double quotes, and small focused modules. Use `camelCase` for functions and variables, `PascalCase` for classes, and kebab-case file names such as `feishu-ws-client.js`. Prefer Node built-ins and simple synchronous filesystem code where startup or state persistence is involved. Keep user-facing reply text concise and preserve the current command names (`/help`, `/status`, `/reset`, `/abort`).

## Testing Guidelines
No automated test suite is checked in yet. For behavior changes, at minimum run `npm start` or `npm run dev`, exercise the health endpoint, and manually verify one Feishu message flow when credentials are available. If you add tests, keep them close to the source in `src/__tests__/` or add a top-level `test/` directory, and prefer Node's built-in test runner to avoid unnecessary tooling.

## Commit & Pull Request Guidelines
Git history is not included in this workspace snapshot, so follow a simple imperative style for commit subjects, for example: `Add queue position to task acknowledgements`. Keep commits scoped to one change. Pull requests should describe the user-visible effect, list any `.env` or Feishu configuration changes, include manual verification steps, and attach screenshots or message transcripts for chat-facing behavior changes.

## Security & Configuration Tips
Do not commit `.env`, access tokens, or chat transcripts. Validate changes that touch `CODEX_APPROVAL_POLICY`, workspace paths, or user allowlists carefully; these settings directly affect what the bridge can execute and who can trigger it.
