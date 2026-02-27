# Discord Code Agent

Discord-based personal coding agent for Claude/Codex/Gemini with per-thread session continuity and durable JSON state.

## Requirements

- Node.js 22+
- pnpm 10+
- Discord application + bot token
- Installed CLI tools: `gemini`, `codex`, `claude`
- All three CLIs authenticated on this machine

## Quick Start

1. Install dependencies:

```bash
pnpm install
```

2. Create env file:

```bash
cp .env.example .env
```

3. Fill `.env` values (see next section).

4. Start the bot:

```bash
pnpm start
```

Global slash commands are registered at startup. Discord propagation may take a few minutes.

## .env

Required:

- `DISCORD_TOKEN`: Bot token from Discord Developer Portal
- `DISCORD_APP_ID`: Application ID from Discord Developer Portal
- `DISCORD_OWNER_ID`: Your Discord user ID (only this user can operate the bot)

Optional:

- `STATE_DIR`: State directory path, default `state`
- `LOG_DIR`: Log directory path, default `logs`

Example:

```env
DISCORD_TOKEN=your_bot_token
DISCORD_APP_ID=your_application_id
DISCORD_OWNER_ID=your_user_id
STATE_DIR=./state
LOG_DIR=./logs
```

## Discord Bot Setup

In Discord Developer Portal:

1. Create an application and a bot.
2. Enable `Message Content Intent` under Bot settings.
3. Invite the bot with scopes: `bot`, `applications.commands`.
4. Grant bot permissions: `View Channels`, `Read Message History`, `Send Messages`, `Send Messages in Threads`, `Create Public Threads`, `Create Private Threads`, `Manage Threads`.

## Usage Flow

1. Create a project mapping:

```text
/project create name:<project_name> path:<absolute_path>
```

`path` must be an absolute path.

2. Start a session thread:

```text
/start project_name:<project_name> tool:<claude|codex|gemini>
```

Run `/start` in a guild text channel (not DM, not an existing thread).

3. In that thread, send normal messages as prompts.

4. Use support commands when needed:

- `/status` (run inside managed thread)
- `/retry job_id:<job_id>`
- `/session list [project_name]`
- `/session open session_id:<thread_id>`
- `/project status project_name:<project_name>`

## CLI Permission Mode

Current implementation starts tool CLIs with auto-approval/full-access flags by default:

- Codex: `--dangerously-bypass-approvals-and-sandbox`
- Claude: `--dangerously-skip-permissions`
- Gemini: `--yolo`

Use only in trusted local environments.

## Persistence

- `STATE_DIR/config.json`
- `STATE_DIR/snapshot.json`
- `STATE_DIR/events.ndjson`
- `LOG_DIR/job/<job_id>.log`

On startup, runtime state is reconstructed from snapshot + event replay; running jobs from crashes are marked `unknown_after_crash`.

## Verification

```bash
pnpm check
pnpm test
pnpm build
```
