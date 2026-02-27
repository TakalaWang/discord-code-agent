import { spawn } from "node:child_process";

export interface CommandRunRequest {
  command: string;
  args: string[];
  cwd: string;
  timeoutSec: number;
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
}

export interface CommandRunResult {
  exitCode: number;
  timedOut: boolean;
  stdoutLines: string[];
  stderrLines: string[];
}

export interface CommandRunner {
  run(request: CommandRunRequest): Promise<CommandRunResult>;
}

function splitLines(chunk: string): string[] {
  return chunk.split(/\r?\n/);
}

export class SpawnCommandRunner implements CommandRunner {
  public async run(request: CommandRunRequest): Promise<CommandRunResult> {
    return new Promise<CommandRunResult>((resolve, reject) => {
      const child = spawn(request.command, request.args, {
        cwd: request.cwd,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"]
      });

      let timedOut = false;
      let stdoutBuffer = "";
      let stderrBuffer = "";
      const stdoutLines: string[] = [];
      const stderrLines: string[] = [];

      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, request.timeoutSec * 1000);

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");

      child.stdout.on("data", (data: string) => {
        stdoutBuffer += data;
        const segments = splitLines(stdoutBuffer);
        stdoutBuffer = segments.pop() ?? "";
        for (const line of segments) {
          stdoutLines.push(line);
          request.onStdoutLine?.(line);
        }
      });

      child.stderr.on("data", (data: string) => {
        stderrBuffer += data;
        const segments = splitLines(stderrBuffer);
        stderrBuffer = segments.pop() ?? "";
        for (const line of segments) {
          stderrLines.push(line);
          request.onStderrLine?.(line);
        }
      });

      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });

      child.once("close", (code) => {
        clearTimeout(timeout);

        if (stdoutBuffer.length > 0) {
          stdoutLines.push(stdoutBuffer);
          request.onStdoutLine?.(stdoutBuffer);
        }

        if (stderrBuffer.length > 0) {
          stderrLines.push(stderrBuffer);
          request.onStderrLine?.(stderrBuffer);
        }

        resolve({
          exitCode: code ?? 1,
          timedOut,
          stdoutLines,
          stderrLines
        });
      });
    });
  }
}
