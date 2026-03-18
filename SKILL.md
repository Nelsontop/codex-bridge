---
name: agent-bridge
description: Operate, configure, troubleshoot, and extend the Agent Bridge project that routes channel messages to local CLI agent sessions. Use when you need to set up the bridge, start or restart the service, health-check the channel connection, bind group chats to local workspaces, debug task/session/queue behavior, or modify the bridge implementation itself.
---

# Agent Bridge

Use this skill when working on this repository or when another Codex instance needs to run this bridge for remote control through Feishu.

## Start Here

- Read [README.md](README.md) first for the current operational model, required Feishu events, and `.env` shape.
- Treat the repository root as the service root.
- Derive the health endpoint from `.env` `HOST` and `PORT`; do not assume the default port matches the current environment.

## Core Workflows

### Set Up

- Run `npm run setup` to generate or update `.env`.
- Confirm required credentials exist before starting the bridge: `FEISHU_APP_ID`, `FEISHU_APP_SECRET`, and a valid `CODEX_WORKSPACE_DIR`.
- If group chats will use `/bind`, ensure `WORKSPACE_ALLOWED_ROOTS` covers the target directories.

### Start Or Restart The Bridge

- Find only bridge processes for this repo before killing anything:
  - `ps -ef | grep -E 'npm start|node src/index.js' | grep -v grep`
  - verify cwd with `pwdx <pid>` when there is any doubt
- Do not kill unrelated `npm start` processes.
- Start with `npm start`.
- After restart, verify with:
  - process check
  - `curl http://<HOST>:<PORT>/healthz`

### Health Check And Triage

- The health payload is the fastest status source. Check:
  - `ok`
  - `transport`
  - `runningTasks`
  - `queuedTasks`
  - `interruptedTasks`
  - `feishu.lastErrorMessage`
  - `ws.lastErrorMessage`
- If the bridge looks alive but Feishu is not receiving events, inspect:
  - `.env`
  - Feishu event subscriptions
  - long-connection metrics in `/healthz`

### Group Chat Operations

- Groups must bind a workspace before normal task execution:
  - `/bind <工作目录> [仓库名]`
- `/reset` clears the Codex session for the current chat but keeps the bound workspace.
- `/abort`, `/retry`, and `/choose` are scoped to the current chat.
- Queueing and user pending counts are isolated per chat/group; if changing queue behavior, preserve that isolation.

## Code Map

- [src/index.js](src/index.js): process boot, config loading, health server, Feishu WS startup
- [src/bridge-service.js](src/bridge-service.js): event dispatch, queueing, session reuse, cards, interaction state
- [src/bridge-command-router.js](src/bridge-command-router.js): command routing for `/bind`, `/status`, `/reset`, `/abort`, `/retry`, `/choose`
- [src/task-lifecycle.js](src/task-lifecycle.js): task completion/failure state transitions and shared lifecycle rules
- [src/task-runtime.js](src/task-runtime.js): runtime task shaping and progress state
- [src/codex-runner.js](src/codex-runner.js): `codex exec` / `codex exec resume` process execution
- [src/workspace-binding.js](src/workspace-binding.js): workspace binding, Git init, optional GitHub repo creation
- [src/workspace-policy.js](src/workspace-policy.js): allowed-root checks for `/bind`
- [src/state-store.js](src/state-store.js): persistent conversation/runtime state
- [src/feishu-client.js](src/feishu-client.js): Feishu HTTP messaging and card updates
- [src/feishu-ws-client.js](src/feishu-ws-client.js): Feishu long connection lifecycle

## Validation

- Run `npm test` after behavior changes.
- For runtime-only checks, also verify:
  - `curl http://<HOST>:<PORT>/healthz`
  - the expected `node src/index.js` process is running
- When changing queueing, group isolation, interactive cards, or command routing, prefer adding or updating tests in [test/bridge-service.test.js](test/bridge-service.test.js).

## Guardrails

- Do not assume port `3000`; read `.env`.
- Do not reset or delete workspace bindings unless the user explicitly asks.
- Before killing processes, prove they belong to this repository.
- If the user asks to push or deploy, check `git status -sb` first and preserve unrelated local changes.
