import { mkdir, open, readFile, rename, stat } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { DomainError } from "../domain/errors.js";
import type { ToolName } from "../state/replay.js";

const NAME_REGEX = /^[a-z0-9-_]{1,40}$/;

export interface ProjectConfig {
  name: string;
  path: string;
  enabled_tools: ToolName[];
  default_args: Record<ToolName, string[]>;
  created_at: string;
  updated_at: string;
}

export interface ConfigFile {
  version: 1;
  owner_id: string;
  projects: Record<string, ProjectConfig>;
}

export interface CreateProjectInput {
  name: string;
  path: string;
  argsJson?: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asTool(tool: string): ToolName | null {
  if (tool === "claude" || tool === "codex" || tool === "gemini") {
    return tool;
  }

  return null;
}

const ALL_TOOLS: ToolName[] = ["gemini", "codex", "claude"];

function parseArgsJson(raw: string | undefined): Record<ToolName, string[]> {
  const defaults: Record<ToolName, string[]> = {
    gemini: [],
    codex: [],
    claude: []
  };

  if (!raw || raw.trim().length === 0) {
    return defaults;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new DomainError("E_INVALID_TOOLSET", "args_json must be valid JSON");
  }

  if (!isObject(parsed)) {
    throw new DomainError("E_INVALID_TOOLSET", "args_json must be a JSON object");
  }

  for (const tool of ALL_TOOLS) {
    const value = parsed[tool];
    if (value === undefined) {
      continue;
    }

    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
      throw new DomainError("E_INVALID_TOOLSET", `default_args.${tool} must be string[]`);
    }

    defaults[tool] = value;
  }

  return defaults;
}

function validateProjectName(name: string): void {
  if (!NAME_REGEX.test(name)) {
    throw new DomainError("E_INVALID_TOOLSET", "project name must match [a-z0-9-_]{1,40}");
  }
}

async function validateProjectPath(path: string): Promise<void> {
  if (!isAbsolute(path)) {
    throw new DomainError("E_INVALID_PATH", "project path must be absolute");
  }

  try {
    await stat(path);
  } catch {
    throw new DomainError("E_INVALID_PATH", "project path does not exist");
  }
}

function parseConfig(raw: string): ConfigFile {
  const parsed = JSON.parse(raw) as unknown;
  if (!isObject(parsed) || parsed.version !== 1 || typeof parsed.owner_id !== "string") {
    throw new Error("invalid config.json schema");
  }

  const projectsRaw = parsed.projects;
  if (!isObject(projectsRaw)) {
    throw new Error("invalid config projects schema");
  }

  const projects: Record<string, ProjectConfig> = {};
  for (const [name, value] of Object.entries(projectsRaw)) {
    if (!isObject(value)) {
      throw new Error(`invalid project schema: ${name}`);
    }

    const defaultArgsRaw = isObject(value.default_args) ? value.default_args : {};
    const defaultArgs: Record<ToolName, string[]> = {
      gemini: [],
      codex: [],
      claude: []
    };

    for (const tool of ["gemini", "codex", "claude"] as const) {
      const toolArgs = defaultArgsRaw[tool];
      if (Array.isArray(toolArgs) && toolArgs.every((arg) => typeof arg === "string")) {
        defaultArgs[tool] = toolArgs;
      }
    }

    projects[name] = {
      name,
      path: typeof value.path === "string" ? value.path : "",
      enabled_tools: [...ALL_TOOLS],
      default_args: defaultArgs,
      created_at:
        typeof value.created_at === "string" ? value.created_at : new Date(0).toISOString(),
      updated_at:
        typeof value.updated_at === "string" ? value.updated_at : new Date(0).toISOString()
    };
  }

  return {
    version: 1,
    owner_id: parsed.owner_id,
    projects
  };
}

export class ConfigStore {
  private readonly path: string;
  private data: ConfigFile;

  private constructor(path: string, data: ConfigFile) {
    this.path = path;
    this.data = data;
  }

  public static async open(path: string, ownerId: string): Promise<ConfigStore> {
    await mkdir(dirname(path), { recursive: true });

    let data: ConfigFile;
    try {
      const raw = await readFile(path, "utf8");
      data = parseConfig(raw);
      if (data.owner_id !== ownerId) {
        data.owner_id = ownerId;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }

      data = {
        version: 1,
        owner_id: ownerId,
        projects: {}
      };
    }

    const store = new ConfigStore(path, data);
    await store.persist();
    return store;
  }

  public getConfig(): ConfigFile {
    return structuredClone(this.data);
  }

  public listProjects(): ProjectConfig[] {
    return Object.values(this.data.projects).map((project) => structuredClone(project));
  }

  public getProject(name: string): ProjectConfig | undefined {
    const project = this.data.projects[name];
    return project ? structuredClone(project) : undefined;
  }

  public async createProject(input: CreateProjectInput): Promise<ProjectConfig> {
    validateProjectName(input.name);
    await validateProjectPath(input.path);

    if (this.data.projects[input.name]) {
      throw new DomainError("E_PROJECT_EXISTS", `project already exists: ${input.name}`);
    }

    const defaultArgs = parseArgsJson(input.argsJson);
    const now = new Date().toISOString();

    const project: ProjectConfig = {
      name: input.name,
      path: input.path,
      enabled_tools: [...ALL_TOOLS],
      default_args: defaultArgs,
      created_at: now,
      updated_at: now
    };

    this.data.projects[input.name] = project;
    await this.persist();
    return structuredClone(project);
  }

  private async persist(): Promise<void> {
    const tempPath = `${this.path}.tmp`;
    const handle = await open(tempPath, "w");
    try {
      await handle.writeFile(`${JSON.stringify(this.data, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }

    await rename(tempPath, this.path);
  }
}
