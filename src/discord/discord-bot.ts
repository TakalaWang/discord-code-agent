import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  type ChatInputCommandInteraction,
  type Message
} from "discord.js";
import type { AdapterProgressEvent } from "../adapters/types.js";
import { AgentService } from "../agent/agent-service.js";
import { DomainError } from "../domain/errors.js";
import { withDiscordRateLimitRetry } from "./rate-limit.js";

export interface DiscordBotOptions {
  token: string;
  ownerId: string;
  service: AgentService;
}

export class DiscordBot {
  private static readonly TYPING_HEARTBEAT_MS = 8000;
  private static readonly DISCORD_MESSAGE_LIMIT = 2000;
  private readonly token: string;
  private readonly ownerId: string;
  private readonly service: AgentService;
  private readonly client: Client;
  private readonly typingHeartbeats: Map<string, ReturnType<typeof setInterval>>;
  private readonly streamedJobs: Set<string>;
  private readonly lastActivityByJob: Map<string, string>;

  public constructor(options: DiscordBotOptions) {
    this.token = options.token;
    this.ownerId = options.ownerId;
    this.service = options.service;
    this.typingHeartbeats = new Map();
    this.streamedJobs = new Set();
    this.lastActivityByJob = new Map();

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
    await this.sendTyping(event.threadId);
    this.startTypingHeartbeat(event.jobId, event.threadId);
  }

  public async onJobProgress(event: {
    threadId: string;
    jobId: string;
    progress: AdapterProgressEvent;
  }): Promise<void> {
    if (event.progress.type === "assistant_text") {
      const text = event.progress.text.trim();
      if (text.length === 0) {
        return;
      }

      this.streamedJobs.add(event.jobId);
      await this.sendThreadMessage(event.threadId, text);
      return;
    }

    if (event.progress.activity === "thinking") {
      const activityLabel = `${event.progress.activity}:${event.progress.label}`;
      if (this.lastActivityByJob.get(event.jobId) !== activityLabel) {
        this.lastActivityByJob.set(event.jobId, activityLabel);
        await this.sendThreadMessage(event.threadId, this.formatActivity(event.progress));
      }
    }

    await this.sendTyping(event.threadId);
  }

  public async onJobFinished(event: {
    threadId: string;
    jobId: string;
    state: "success" | "failed";
    resultExcerpt?: string;
    errorCode?: string;
    errorMessage?: string;
  }): Promise<void> {
    this.stopTypingHeartbeat(event.jobId);

    if (event.state === "success") {
      const hasStreamed = this.streamedJobs.has(event.jobId);
      if (!hasStreamed && event.resultExcerpt) {
        await this.sendThreadMessage(event.threadId, event.resultExcerpt);
      }
    } else {
      const body = `Failed \`${event.jobId}\`: ${event.errorCode ?? "unknown"} ${event.errorMessage ?? ""}`;
      await this.sendThreadMessage(event.threadId, body);
    }

    this.streamedJobs.delete(event.jobId);
    this.lastActivityByJob.delete(event.jobId);
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
        argsJson?: string;
      } = {
        userId: interaction.user.id,
        name: interaction.options.getString("name", true),
        path: interaction.options.getString("path", true)
      };
      const argsJson = interaction.options.getString("args_json");
      if (argsJson !== null) {
        input.argsJson = argsJson;
      }

      const project = await this.service.createProject(input);

      await this.safeReply(
        interaction,
        `Project created: ${project.name}\npath: ${project.path}\ntools: ${project.enabled_tools.join(",")}`,
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
          (project) => `${project.name} | tools=${project.enabled_tools.join(",")}`
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
    const tool = interaction.options.getString("tool", true) as "claude" | "codex" | "gemini";
    const thread = await channel.threads.create({
      name: `session-${projectName}-${Date.now().toString().slice(-6)}`,
      autoArchiveDuration: 1440,
      reason: "discord code agent session"
    });

    const started = await this.service.startSession({
      userId: interaction.user.id,
      projectName,
      threadId: thread.id,
      tool
    });

    await this.safeReply(
      interaction,
      `Session started: <#${thread.id}>\nsession_id: ${started.sessionId}\ntool: ${tool}`,
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

    for (const chunk of this.splitMessage(content)) {
      await withDiscordRateLimitRetry(async () => {
        await channel.send(chunk);
        return undefined;
      });
    }
  }

  private async sendTyping(threadId: string): Promise<void> {
    const channel = await this.client.channels.fetch(threadId);
    if (!channel || !channel.isThread()) {
      return;
    }

    await withDiscordRateLimitRetry(async () => {
      await channel.sendTyping();
      return undefined;
    });
  }

  private startTypingHeartbeat(jobId: string, threadId: string): void {
    this.stopTypingHeartbeat(jobId);
    const timer = setInterval(() => {
      void this.sendTyping(threadId);
    }, DiscordBot.TYPING_HEARTBEAT_MS);
    this.typingHeartbeats.set(jobId, timer);
  }

  private stopTypingHeartbeat(jobId: string): void {
    const timer = this.typingHeartbeats.get(jobId);
    if (!timer) {
      return;
    }

    clearInterval(timer);
    this.typingHeartbeats.delete(jobId);
  }

  private splitMessage(content: string): string[] {
    const trimmed = content.trim();
    if (trimmed.length === 0) {
      return [];
    }

    if (trimmed.length <= DiscordBot.DISCORD_MESSAGE_LIMIT) {
      return [trimmed];
    }

    const chunks: string[] = [];
    let rest = trimmed;
    while (rest.length > 0) {
      if (rest.length <= DiscordBot.DISCORD_MESSAGE_LIMIT) {
        chunks.push(rest);
        break;
      }

      let cut = rest.lastIndexOf("\n", DiscordBot.DISCORD_MESSAGE_LIMIT);
      if (cut <= 0) {
        cut = DiscordBot.DISCORD_MESSAGE_LIMIT;
      }

      const part = rest.slice(0, cut).trim();
      if (part.length > 0) {
        chunks.push(part);
      }

      rest = rest.slice(cut).trimStart();
    }

    return chunks;
  }

  private formatActivity(event: Extract<AdapterProgressEvent, { type: "activity" }>): string {
    if (event.activity === "thinking") {
      return "_thinking..._";
    }

    return `_using ${event.label}..._`;
  }
}
