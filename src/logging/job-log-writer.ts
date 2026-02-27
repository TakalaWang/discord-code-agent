import { mkdir, open } from "node:fs/promises";
import { join } from "node:path";

export async function writeJobLog(options: {
  logDir: string;
  jobId: string;
  stdoutLines: string[];
  stderrLines: string[];
  diagnosticLogs: string[];
}): Promise<void> {
  const dir = join(options.logDir, "job");
  await mkdir(dir, { recursive: true });

  const file = join(dir, `${options.jobId}.log`);
  const handle = await open(file, "w");

  try {
    for (const line of options.stdoutLines) {
      await handle.writeFile(`[stdout] ${line}\n`, "utf8");
    }

    for (const line of options.stderrLines) {
      await handle.writeFile(`[stderr] ${line}\n`, "utf8");
    }

    for (const line of options.diagnosticLogs) {
      await handle.writeFile(`[diagnostic] ${line}\n`, "utf8");
    }

    await handle.sync();
  } finally {
    await handle.close();
  }
}
