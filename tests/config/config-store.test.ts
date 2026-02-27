import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DomainError } from "../../src/domain/errors.js";
import { ConfigStore } from "../../src/config/config-store.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.map(async (dir) => rm(dir, { recursive: true, force: true })));
  dirs.length = 0;
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "dca-config-"));
  dirs.push(dir);
  return dir;
}

describe("ConfigStore", () => {
  it("creates default config when file is missing", async () => {
    const dir = await tempDir();
    const file = join(dir, "config.json");

    const store = await ConfigStore.open(file, "owner-1");

    expect(store.getConfig().owner_id).toBe("owner-1");
    expect(store.listProjects()).toHaveLength(0);
    await expect(stat(file)).resolves.toBeDefined();
  });

  it("validates project creation input", async () => {
    const dir = await tempDir();
    const file = join(dir, "config.json");
    const store = await ConfigStore.open(file, "owner-1");

    await expect(
      store.createProject({
        name: "my-app",
        path: dir,
        toolsCsv: "gemini,codex",
        defaultTool: "gemini",
        argsJson: "{\"gemini\":[\"--model\",\"gemini-2.5-pro\"]}"
      })
    ).resolves.toMatchObject({ name: "my-app", default_tool: "gemini" });

    await expect(
      store.createProject({
        name: "my-app",
        path: dir,
        toolsCsv: "gemini",
        defaultTool: "gemini"
      })
    ).rejects.toMatchObject({ code: "E_PROJECT_EXISTS" });

    await expect(
      store.createProject({
        name: "bad name",
        path: dir,
        toolsCsv: "gemini",
        defaultTool: "gemini"
      })
    ).rejects.toMatchObject({ code: "E_INVALID_TOOLSET" });

    await expect(
      store.createProject({
        name: "valid-name",
        path: "relative/path",
        toolsCsv: "gemini",
        defaultTool: "gemini"
      })
    ).rejects.toMatchObject({ code: "E_INVALID_PATH" });
  });
});
