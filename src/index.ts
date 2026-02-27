import { join } from "node:path";
import { ClaudeAdapter } from "./adapters/claude-adapter.js";
import { CodexAdapter } from "./adapters/codex-adapter.js";
import { GeminiAdapter } from "./adapters/gemini-adapter.js";
import { SpawnCommandRunner } from "./adapters/command-runner.js";
import { InMemoryAdapterRegistry } from "./adapters/registry.js";
import { AgentService } from "./agent/agent-service.js";
import { ConfigStore } from "./config/config-store.js";
import { readEnv } from "./config/env.js";
import { DiscordBot } from "./discord/discord-bot.js";
import { registerGlobalCommands } from "./discord/register-commands.js";
import { JobCoordinator } from "./runner/job-coordinator.js";
import { RuntimeStore } from "./state/runtime-store.js";

async function main(): Promise<void> {
  const env = readEnv();

  const stateDir = env.STATE_DIR;
  const configStore = await ConfigStore.open(join(stateDir, "config.json"), env.DISCORD_OWNER_ID);
  const runtimeStore = await RuntimeStore.open({ stateDir });
  await runtimeStore.recoverRunningJobsAfterCrash();

  const runner = new SpawnCommandRunner();
  const adapters = new InMemoryAdapterRegistry({
    gemini: new GeminiAdapter(runner),
    codex: new CodexAdapter(runner),
    claude: new ClaudeAdapter(runner)
  });

  const coordinator = new JobCoordinator({
    runtimeStore,
    configStore,
    adapters,
    logDir: env.LOG_DIR
  });

  const service = new AgentService({
    ownerId: env.DISCORD_OWNER_ID,
    configStore,
    runtimeStore,
    coordinator
  });

  const bot = new DiscordBot({
    token: env.DISCORD_TOKEN,
    ownerId: env.DISCORD_OWNER_ID,
    service
  });

  coordinator.setHooks({
    onJobStarted: (event) => bot.onJobStarted(event),
    onJobFinished: (event) => bot.onJobFinished(event),
    onJobProgress: (event) => bot.onJobProgress(event)
  });

  await registerGlobalCommands({
    token: env.DISCORD_TOKEN,
    appId: env.DISCORD_APP_ID
  });

  await bot.start();
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});
