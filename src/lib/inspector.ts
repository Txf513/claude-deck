import type { ChatMessage, ConvStatus, UsageStats } from "./chatTypes";

export type InspectorSummary = {
  status: ConvStatus;
  latestError: string | null;
  stderrCount: number;
  toolCount: number;
  relatedFileCount: number;
  inputTokens: number;
  outputTokens: number;
  contextWindow: number;
};

export type InspectorData = {
  summary: InspectorSummary;
  tools: Extract<ChatMessage, { kind: "tool" }>[];
  relatedFiles: string[];
};

function collectInspectorFiles(
  tools: Extract<ChatMessage, { kind: "tool" }>[]
): string[] {
  const set = new Set<string>();
  for (const item of tools) {
    const obj =
      item.tool.input ??
      (() => {
        try {
          return JSON.parse(item.tool.partialJson);
        } catch {
          return undefined;
        }
      })();
    if (!obj || typeof obj !== "object") continue;
    const data = obj as Record<string, unknown>;
    if (typeof data.file_path === "string") set.add(data.file_path);
    if (
      typeof data.path === "string" &&
      (item.tool.name === "Read" || item.tool.name === "Edit")
    ) {
      set.add(data.path);
    }
  }
  return Array.from(set).slice(0, 12);
}

export function buildInspectorData(args: {
  messages: ChatMessage[];
  status: ConvStatus;
  error: string | null;
  stderr: string[];
  usage: UsageStats;
}): InspectorData {
  const tools = args.messages.filter(
    (message): message is Extract<ChatMessage, { kind: "tool" }> =>
      message.kind === "tool"
  );
  const relatedFiles = collectInspectorFiles(tools);

  return {
    summary: {
      status: args.status,
      latestError: args.error,
      stderrCount: args.stderr.length,
      toolCount: tools.length,
      relatedFileCount: relatedFiles.length,
      inputTokens: args.usage.inputTokens,
      outputTokens: args.usage.outputTokens,
      contextWindow: args.usage.contextWindow,
    },
    tools,
    relatedFiles,
  };
}
