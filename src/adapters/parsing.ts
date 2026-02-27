export function isLikelyJsonObjectLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("{") && trimmed.endsWith("}");
}

export function tryParseJsonObject(line: string): Record<string, unknown> | null {
  if (!isLikelyJsonObjectLine(line)) {
    return null;
  }

  const parsed = JSON.parse(line) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("line is not a JSON object");
  }

  return parsed as Record<string, unknown>;
}

function visitText(value: unknown, sink: string[]): void {
  if (typeof value === "string") {
    if (value.length > 0) {
      sink.push(value);
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      visitText(item, sink);
    }
    return;
  }

  if (typeof value === "object" && value !== null) {
    const objectValue = value as Record<string, unknown>;
    for (const key of ["delta", "text", "content", "message", "response"]) {
      if (objectValue[key] !== undefined) {
        visitText(objectValue[key], sink);
      }
    }
  }
}

export function extractAssistantText(event: Record<string, unknown>): string {
  const lines: string[] = [];

  if (event.role !== undefined && event.role !== "assistant") {
    return "";
  }

  visitText(event, lines);
  return lines.join(" ").trim();
}

export function hasTransientErrorHint(lines: string[]): boolean {
  const blob = lines.join("\n").toLowerCase();
  return (
    blob.includes("quota") ||
    blob.includes("retry") ||
    blob.includes("rate limit") ||
    blob.includes("429") ||
    blob.includes("temporarily unavailable")
  );
}

export function errorToMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  return "unknown error";
}
