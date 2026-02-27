# Discord Code Agent

Discord-based personal coding agent for Claude/Codex/Gemini with per-thread session continuity and JSON-only durable state.

## Requirements

- Node.js 22+
- pnpm 10+
- Discord application + bot token
- Installed CLI tools as needed: `gemini`, `codex`, `claude`

## Setup

1. Install dependencies:

```bash
pnpm install
```

2. Configure environment:

```bash
cp .env.example .env
```

3. Fill `.env` values.

4. Start:

```bash
pnpm start
```

Global slash commands are registered on startup. Discord propagation can take a few minutes.

## Command Surface

- `/project create <name> <path> <tools_csv> <default_tool> [args_json]`
- `/project list`
- `/project status <project_name>`
- `/start <project_name>`
- `/session list [project_name]`
- `/session open <session_id>`
- `/status` (inside managed thread)
- `/tool <claude|codex|gemini>` (inside managed thread)
- `/retry <job_id>`

## Persistence

- `STATE_DIR/config.json`
- `STATE_DIR/snapshot.json`
- `STATE_DIR/events.ndjson`

On startup, runtime state is reconstructed from `snapshot + events replay`; any running jobs are marked `unknown_after_crash`.

## Verification

```bash
pnpm check
pnpm test
pnpm build
```
