import { DomainError } from "../domain/errors.js";
import type { ToolName } from "../state/replay.js";
import type { AdapterRegistry, ToolAdapter } from "./types.js";

export class InMemoryAdapterRegistry implements AdapterRegistry {
  private readonly adapters: Record<ToolName, ToolAdapter>;

  public constructor(adapters: Record<ToolName, ToolAdapter>) {
    this.adapters = adapters;
  }

  public get(tool: ToolName): ToolAdapter {
    const adapter = this.adapters[tool];
    if (!adapter) {
      throw new DomainError("E_INVALID_TOOLSET", `adapter not configured: ${tool}`);
    }

    return adapter;
  }
}
