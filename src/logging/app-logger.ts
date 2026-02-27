import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import type { ErrorCode } from "../domain/errors.js";

export interface AppLogEntry {
  ts: string;
  level: "info" | "warn" | "error";
  message: string;
  error_code?: ErrorCode;
  stack?: string;
  meta?: Record<string, unknown>;
}

export class AppLogger {
  private readonly path: string;

  public constructor(path: string) {
    this.path = path;
  }

  public async log(entry: AppLogEntry): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const handle = await open(this.path, "a");
    try {
      await handle.writeFile(`${JSON.stringify(entry)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}
