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
