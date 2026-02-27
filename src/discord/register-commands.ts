import { REST, Routes } from "discord.js";
import { buildCommandDefinitions } from "./command-definitions.js";

export async function registerGlobalCommands(options: {
  token: string;
  appId: string;
}): Promise<void> {
  const rest = new REST({ version: "10" }).setToken(options.token);
  const commands = buildCommandDefinitions();

  await rest.put(Routes.applicationCommands(options.appId), {
    body: commands
  });
}
