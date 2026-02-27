import { SlashCommandBuilder } from "discord.js";

export function buildCommandDefinitions() {
  const project = new SlashCommandBuilder()
    .setName("project")
    .setDescription("Manage projects")
    .addSubcommand((sub) =>
      sub
        .setName("create")
        .setDescription("Create a project")
        .addStringOption((option) =>
          option.setName("name").setDescription("Project name").setRequired(true)
        )
        .addStringOption((option) =>
          option
            .setName("path")
            .setDescription("Absolute project path")
            .setRequired(true)
        )
        .addStringOption((option) =>
          option
            .setName("args_json")
            .setDescription("Optional JSON for default args per tool")
            .setRequired(false)
        )
    )
    .addSubcommand((sub) => sub.setName("list").setDescription("List all projects"))
    .addSubcommand((sub) =>
      sub
        .setName("status")
        .setDescription("Show project status")
        .addStringOption((option) =>
          option.setName("project_name").setDescription("Project name").setRequired(true)
        )
    );

  const start = new SlashCommandBuilder()
    .setName("start")
    .setDescription("Create a new session thread")
    .addStringOption((option) =>
      option.setName("project_name").setDescription("Project name").setRequired(true)
    )
    .addStringOption((option) =>
      option
        .setName("tool")
        .setDescription("Tool for this thread")
        .setRequired(true)
        .addChoices(
          { name: "gemini", value: "gemini" },
          { name: "codex", value: "codex" },
          { name: "claude", value: "claude" }
        )
    );

  const session = new SlashCommandBuilder()
    .setName("session")
    .setDescription("Session operations")
    .addSubcommand((sub) =>
      sub
        .setName("list")
        .setDescription("List sessions")
        .addStringOption((option) =>
          option
            .setName("project_name")
            .setDescription("Optional project filter")
            .setRequired(false)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("open")
        .setDescription("Open an existing session thread")
        .addStringOption((option) =>
          option.setName("session_id").setDescription("Session ID (thread ID)").setRequired(true)
        )
    );

  const status = new SlashCommandBuilder().setName("status").setDescription("Show thread status");

  const retry = new SlashCommandBuilder()
    .setName("retry")
    .setDescription("Retry a failed or unknown job")
    .addStringOption((option) =>
      option.setName("job_id").setDescription("Job ID").setRequired(true)
    );

  return [project, start, session, status, retry].map((builder) => builder.toJSON());
}
