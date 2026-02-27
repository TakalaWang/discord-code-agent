import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  type ChatInputCommandInteraction,
  type Message
} from "discord.js";
import { AgentService } from "../agent/agent-service.js";
import { DomainError } from "../domain/errors.js";
import { withDiscordRateLimitRetry } from "./rate-limit.js";

export interface DiscordBotOptions {
  token: string;
  ownerId: string;
  service: AgentService;
}

export class DiscordBot {
  private readonly token: string;
  private readonly ownerId: string;
  private readonly service: AgentService;
  private readonly client: Client;
  private readonly statusMessages: Map<string, { threadId: string; messageId: string }>;

  public constructor(options: DiscordBotOptions) {
    this.token = options.token;
    this.ownerId = options.ownerId;
    this.service = options.service;
    this.statusMessages = new Map();

    this.client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
    });

    this.client.once(Events.ClientReady, () => {
      // Keep startup log concise for service logs.
      // eslint-disable-next-line no-console
      console.log("discord bot ready");
    });

    this.client.on(Events.InteractionCreate, async (interaction) => {
      if (!interaction.isChatInputCommand()) {
        return;
      }
      await this.handleInteraction(interaction);
    });

    this.client.on(Events.MessageCreate, async (message) => {
      await this.handleMessage(message);
    });
  }

  public async start(): Promise<void> {
    await this.client.login(this.token);
  }

  public async onJobStarted(event: { threadId: string; jobId: string }): Promise<void> {
    const record = this.statusMessages.get(event.jobId);
    if (!record) {
      return;
    }

    await this.editStatusMessage(record.threadId, record.messageId, `Running \`${event.jobId}\` ...`);
  }

  public async onJobFinished(event: {
    threadId: string;
    jobId: string;
    state: "success" | "failed";
    resultExcerpt?: string;
    errorCode?: string;
    errorMessage?: string;
  }): Promise<void> {
    const record = this.statusMessages.get(event.jobId);

    if (event.state === "success") {
      const message = event.resultExcerpt ? `\n\n${event.resultExcerpt}` : "";
      const body = `Completed \`${event.jobId}\` successfully.${message}`;

      if (record) {
        await this.editStatusMessage(record.threadId, record.messageId, body);
      } else {
        await this.sendThreadMessage(event.threadId, body);
      }
    } else {
      const body = `Failed \`${event.jobId}\`: ${event.errorCode ?? "unknown"} ${event.errorMessage ?? ""}`;
      if (record) {
        await this.editStatusMessage(record.threadId, record.messageId, body);
      } else {
        await this.sendThreadMessage(event.threadId, body);
      }
    }

    this.statusMessages.delete(event.jobId);
  }

  private async handleInteraction(interaction: ChatInputCommandInteraction): Promise<void> {
    if (interaction.user.id !== this.ownerId) {
      await this.safeReply(interaction, `E_OWNER_ONLY: owner only`, true);
      return;
    }

    try {
      if (interaction.commandName === "project") {
        await this.handleProjectCommand(interaction);
        return;
      }

      if (interaction.commandName === "start") {
        await this.handleStartCommand(interaction);
        return;
      }

      if (interaction.commandName === "session") {
        await this.handleSessionCommand(interaction);
        return;
      }

      if (interaction.commandName === "status") {
        await this.handleStatusCommand(interaction);
        return;
      }

      if (interaction.commandName === "tool") {
        await this.handleToolCommand(interaction);
        return;
      }

      if (interaction.commandName === "retry") {
        await this.handleRetryCommand(interaction);
      }
    } catch (error) {
      await this.handleCommandError(interaction, error);
    }
  }

  private async handleProjectCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const sub = interaction.options.getSubcommand(true);

    if (sub === "create") {
      const input: {
        userId: string;
        name: string;
        path: string;
        toolsCsv: string;
        defaultTool: string;
        argsJson?: string;
      } = {
        userId: interaction.user.id,
        name: interaction.options.getString("name", true),
        path: interaction.options.getString("path", true),
        toolsCsv: interaction.options.getString("tools_csv", true),
        defaultTool: interaction.options.getString("default_tool", true)
      };
      const argsJson = interaction.options.getString("args_json");
      if (argsJson !== null) {
        input.argsJson = argsJson;
      }

      const project = await this.service.createProject(input);

      await this.safeReply(
        interaction,
        `Project created: ${project.name}\npath: ${project.path}\ndefault_tool: ${project.default_tool}`,
        true
      );
      return;
    }

    if (sub === "list") {
      const projects = this.service.listProjects({ userId: interaction.user.id });
      if (projects.length === 0) {
        await this.safeReply(interaction, "No projects.", true);
        return;
      }

      const body = projects
        .map(
          (project) =>
            `${project.name} | default=${project.default_tool} | tools=${project.enabled_tools.join(",")}`
        )
        .join("\n");

      await this.safeReply(interaction, body, true);
      return;
    }

    const projectName = interaction.options.getString("project_name", true);
    const status = this.service.projectStatus({ userId: interaction.user.id, projectName });
    await this.safeReply(interaction, status, true);
  }

  private async handleStartCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const channel = interaction.channel;
    if (!channel || channel.isThread()) {
      throw new DomainError("E_NOT_IN_MANAGED_THREAD", "/start must run in a guild text channel");
    }

    if (!("threads" in channel)) {
      throw new DomainError("E_NOT_IN_MANAGED_THREAD", "channel does not support threads");
    }

    const projectName = interaction.options.getString("project_name", true);
    const thread = await channel.threads.create({
      name: `session-${projectName}-${Date.now().toString().slice(-6)}`,
      autoArchiveDuration: 1440,
      reason: "discord code agent session"
    });

    const started = await this.service.startSession({
      userId: interaction.user.id,
      projectName,
      threadId: thread.id
    });

    await this.safeReply(
      interaction,
      `Session started: <#${thread.id}>\nsession_id: ${started.sessionId}`,
      true
    );

    await withDiscordRateLimitRetry(async () => {
      await thread.send(
        `Session ready. Use this thread for prompts.\nRun /status in this thread to inspect state.`
      );
      return undefined;
    });
  }

  private async handleSessionCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const sub = interaction.options.getSubcommand(true);

    if (sub === "list") {
      const projectName = interaction.options.getString("project_name");
      const sessions = this.service.listSessions(
        projectName === null
          ? { userId: interaction.user.id }
          : { userId: interaction.user.id, projectName }
      );

      if (sessions.length === 0) {
        await this.safeReply(interaction, "No sessions.", true);
        return;
      }

      const body = sessions
        .map(
          (session) =>
            `${session.session_id} | ${session.project_name} | ${session.state} | <#${session.session_id}>`
        )
        .join("\n");
      await this.safeReply(interaction, body, true);
      return;
    }

    const sessionId = interaction.options.getString("session_id", true);
    const opened = await this.service.openSession({
      userId: interaction.user.id,
      sessionId,
      onOpenThread: async (threadId) => {
        const channel = await this.client.channels.fetch(threadId);
        if (!channel || !channel.isThread()) {
          throw new Error("thread not found");
        }

        if (channel.archived) {
          await channel.setArchived(false);
        }

        if (channel.locked) {
          await channel.setLocked(false);
        }
      }
    });

    await this.safeReply(interaction, `Session opened: <#${opened}>`, true);
  }

  private async handleStatusCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const channel = interaction.channel;
    if (!channel || !channel.isThread()) {
      throw new DomainError("E_NOT_IN_MANAGED_THREAD", "/status must run in a managed thread");
    }

    const status = await this.service.status({
      userId: interaction.user.id,
      threadId: channel.id
    });

    await this.safeReply(interaction, status, true);
  }

  private async handleToolCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const channel = interaction.channel;
    if (!channel || !channel.isThread()) {
      throw new DomainError("E_NOT_IN_MANAGED_THREAD", "/tool must run in a managed thread");
    }

    const tool = interaction.options.getString("name", true) as "claude" | "codex" | "gemini";
    await this.service.changeTool({
      userId: interaction.user.id,
      threadId: channel.id,
      tool
    });

    await this.safeReply(interaction, `Tool switched to ${tool}`, true);
  }

  private async handleRetryCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const jobId = interaction.options.getString("job_id", true);
    const retried = await this.service.retryJob({
      userId: interaction.user.id,
      jobId
    });

    await this.safeReply(interaction, `Retry enqueued: ${retried.jobId}`, true);
  }

  private async handleMessage(message: Message): Promise<void> {
    if (message.author.bot) {
      return;
    }

    if (message.author.id !== this.ownerId) {
      return;
    }

    if (
      message.channel.type !== ChannelType.PublicThread &&
      message.channel.type !== ChannelType.PrivateThread &&
      message.channel.type !== ChannelType.AnnouncementThread
    ) {
      return;
    }

    try {
      const enqueued = await this.service.enqueueThreadMessage({
        userId: message.author.id,
        threadId: message.channel.id,
        messageId: message.id,
        prompt: message.content
      });

      if (enqueued.deduped) {
        return;
      }

      const statusMessage = await withDiscordRateLimitRetry(async () => {
        return await message.reply(`Queued \`${enqueued.jobId}\``);
      });

      this.statusMessages.set(enqueued.jobId, {
        threadId: message.channel.id,
        messageId: statusMessage.id
      });
    } catch (error) {
      if (error instanceof DomainError) {
        await withDiscordRateLimitRetry(async () => {
          await message.reply(`${error.code}: ${error.message}`);
          return undefined;
        });
      }
    }
  }

  private async safeReply(
    interaction: ChatInputCommandInteraction,
    content: string,
    ephemeral: boolean
  ): Promise<void> {
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content, ephemeral });
      return;
    }

    await interaction.reply({ content, ephemeral });
  }

  private async handleCommandError(
    interaction: ChatInputCommandInteraction,
    error: unknown
  ): Promise<void> {
    if (error instanceof DomainError) {
      await this.safeReply(interaction, `${error.code}: ${error.message}`, true);
      return;
    }

    const message = error instanceof Error ? error.message : String(error);
    await this.safeReply(interaction, `unexpected error: ${message}`, true);
  }

  private async sendThreadMessage(threadId: string, content: string): Promise<void> {
    const channel = await this.client.channels.fetch(threadId);
    if (!channel || !channel.isThread()) {
      return;
    }

    await withDiscordRateLimitRetry(async () => {
      await channel.send(content);
      return undefined;
    });
  }

  private async editStatusMessage(
    threadId: string,
    messageId: string,
    content: string
  ): Promise<void> {
    const channel = await this.client.channels.fetch(threadId);
    if (!channel || !channel.isThread()) {
      return;
    }

    await withDiscordRateLimitRetry(async () => {
      const target = await channel.messages.fetch(messageId);
      await target.edit(content);
      return undefined;
    });
  }
}
