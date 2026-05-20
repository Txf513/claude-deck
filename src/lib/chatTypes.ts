export type ToolCall = {
  toolUseId: string;
  name: string;
  partialJson: string;
  input: unknown;
  output: string | null;
  isError: boolean;
  status: "running" | "done" | "error";
};

export type ChatMessage =
  | {
      kind: "text";
      id: string;
      role: "user" | "assistant";
      text: string;
      pending?: boolean;
      startedAt?: number;
      durationMs?: number;
    }
  | {
      kind: "tool";
      id: string;
      toolUseId: string;
      role: "tool";
      tool: ToolCall;
    };

export type ConvStatus = "idle" | "thinking" | "streaming" | "error";

export type UsageStats = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  contextWindow: number;
  costUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  turnCount: number;
};
