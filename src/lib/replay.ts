import type { ReplayEntry, ReplayResult } from "./claude";
import type { ChatMessage, ToolCall } from "./chatTypes";

export type NormalizedReplay = {
  messages: ChatMessage[];
  stderr: string[];
};

function safeParseJson(text: string | null): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isSkippableUserReplayText(text: string): boolean {
  return (
    text.startsWith("<local-command-") ||
    text.startsWith("<command-name>") ||
    text.startsWith("<system-reminder>")
  );
}

function createToolMessage(args: {
  id: string;
  toolUseId: string;
  name: string;
  partialJson: string;
  input: unknown;
  output: string | null;
  isError: boolean;
}): ChatMessage {
  const tool: ToolCall = {
    toolUseId: args.toolUseId,
    name: args.name,
    partialJson: args.partialJson,
    input: args.input,
    output: args.output,
    isError: args.isError,
    status: args.isError ? "error" : "done",
  };
  return {
    kind: "tool",
    id: args.id,
    toolUseId: args.toolUseId,
    role: "tool",
    tool,
  };
}

export function entriesToMessages(entries: ReplayEntry[]): ChatMessage[] {
  const messages: ChatMessage[] = [];
  const toolIndex = new Map<string, number>();

  for (const entry of entries) {
    if (entry.is_meta) continue;

    if (entry.kind === "text") {
      const role = entry.role === "assistant" ? "assistant" : "user";
      if (!entry.text) continue;
      if (role === "user" && isSkippableUserReplayText(entry.text)) continue;
      messages.push({
        kind: "text",
        id: entry.id,
        role,
        text: entry.text,
      });
      continue;
    }

    if (entry.kind === "tool_call") {
      const toolUseId = entry.tool_use_id ?? entry.id;
      toolIndex.set(toolUseId, messages.length);
      messages.push(
        createToolMessage({
          id: entry.id,
          toolUseId,
          name: entry.tool_name ?? "Unknown",
          partialJson: entry.tool_input_json ?? "",
          input: safeParseJson(entry.tool_input_json),
          output: null,
          isError: false,
        })
      );
      continue;
    }

    if (entry.kind === "tool_result") {
      const toolUseId = entry.tool_use_id ?? entry.id;
      const index = toolIndex.get(toolUseId);
      if (index !== undefined) {
        const existing = messages[index];
        if (existing?.kind === "tool") {
          const output = entry.tool_output_text ?? entry.text ?? null;
          messages[index] = {
            ...existing,
            tool: {
              ...existing.tool,
              output,
              isError: entry.is_error,
              status: entry.is_error ? "error" : "done",
            },
          };
        }
        continue;
      }

      const output = entry.tool_output_text ?? entry.text ?? null;
      messages.push(
        createToolMessage({
          id: entry.id,
          toolUseId,
          name: entry.tool_name ?? "Tool Result",
          partialJson: "",
          input: undefined,
          output,
          isError: entry.is_error,
        })
      );
    }
  }

  return messages;
}

export function mergePagedReplay(
  prevEntries: ReplayEntry[],
  newPageEntries: ReplayEntry[]
): ChatMessage[] {
  return entriesToMessages([...newPageEntries, ...prevEntries]);
}

export function normalizeReplay(result: ReplayResult): NormalizedReplay {
  return { messages: entriesToMessages(result.entries), stderr: [] };
}
