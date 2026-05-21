import { commands, events, type ClaudeSendArgs, type ClaudeStreamEvent, type ClaudeStderrEvent, type ClaudeDoneEvent } from "./bindings";
import type { UnlistenFn } from "@tauri-apps/api/event";

export type ClaudeEventPayload = ClaudeStreamEvent;
export type ClaudeStderrPayload = ClaudeStderrEvent;
export type ClaudeDonePayload = ClaudeDoneEvent;

export type SendArgs = ClaudeSendArgs & {
  permission_mode?: PermissionMode | null;
  effort?: Effort | null;
};

export type PermissionMode =
  | "default"
  | "acceptEdits"
  | "auto"
  | "plan"
  | "dontAsk"
  | "bypassPermissions";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

function unwrap<T>(
  r: { status: "ok"; data: T } | { status: "error"; error: string }
): T {
  if (r.status === "error") throw new Error(r.error);
  return r.data;
}

export async function claudeSend(args: SendArgs): Promise<void> {
  unwrap(await commands.claudeSend(args as ClaudeSendArgs));
}

export async function claudeCancel(requestId: string): Promise<void> {
  unwrap(await commands.claudeCancel(requestId));
}

export async function onClaudeEvent(
  cb: (payload: ClaudeEventPayload) => void
): Promise<UnlistenFn> {
  return await events.claudeStreamEvent.listen((e) => cb(e.payload));
}

export async function onClaudeStderr(
  cb: (payload: ClaudeStderrPayload) => void
): Promise<UnlistenFn> {
  return await events.claudeStderrEvent.listen((e) => cb(e.payload));
}

export async function onClaudeDone(
  cb: (payload: ClaudeDonePayload) => void
): Promise<UnlistenFn> {
  return await events.claudeDoneEvent.listen((e) => cb(e.payload));
}

export type ReplayEntry = {
  id: string;
  kind: "text" | "tool_call" | "tool_result" | string;
  role: "user" | "assistant" | "tool" | string;
  text: string;
  timestamp: string | null;
  tool_name: string | null;
  tool_use_id: string | null;
  tool_input_json: string | null;
  tool_output_text: string | null;
  is_error: boolean;
  is_meta: boolean;
};

export type ReplayResult = {
  session_id: string | null;
  entries: ReplayEntry[];
  messages: ReplayMessage[];
  cwd: string | null;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_read_tokens: number;
  total_cache_creation_tokens: number;
  context_window: number;
  turn_count: number;
  last_input_tokens: number;
  last_output_tokens: number;
  last_cache_read_tokens: number;
  last_cache_creation_tokens: number;
};

export type ReplayMessage = {
  id: string;
  role: "user" | "assistant" | string;
  text: string;
  timestamp: string | null;
  tool_name: string | null;
  is_meta: boolean;
};

export type ReplayPage = ReplayResult & {
  total_message_count: number;
  returned_message_count: number;
  has_more_before: boolean;
  earliest_uuid: string | null;
};

export type ReplayPageQuery = { limit?: number; beforeUuid?: string };

export async function replaySession(filePath: string): Promise<ReplayResult> {
  return unwrap(await commands.replaySession(filePath)) as ReplayResult;
}

export async function replaySessionPaged(
  filePath: string,
  query?: ReplayPageQuery
): Promise<ReplayPage> {
  return unwrap(
    await commands.replaySessionPaged(filePath, {
      limit: query?.limit ?? null,
      beforeUuid: query?.beforeUuid ?? null,
    })
  );
}

// Stream-json event types we care about, parsed loosely.
export type StreamEvent =
  | { kind: "init"; session_id: string; slash_commands: string[] }
  | { kind: "thinking" }
  | { kind: "assistant_delta"; text: string }
  | { kind: "assistant_text"; text: string }
  | { kind: "tool_use_start"; tool_use_id: string; name: string; index: number }
  | { kind: "tool_input_delta"; index: number; partial_json: string }
  | { kind: "tool_use_complete"; tool_use_id: string; name: string; input: unknown }
  | { kind: "tool_result"; tool_use_id: string; output: string; is_error: boolean }
  | { kind: "text_block_start"; index: number }
  | { kind: "block_stop"; index: number }
  | {
      kind: "result";
      text: string;
      duration_ms: number;
      cost_usd: number;
      input_tokens: number;
      output_tokens: number;
      cache_read_input_tokens: number;
      cache_creation_input_tokens: number;
      context_window: number;
    }
  | { kind: "error"; message: string }
  | { kind: "ignore" };

export function parseStreamLine(line: string): StreamEvent {
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(line);
  } catch {
    return { kind: "ignore" };
  }
  const type = v.type as string | undefined;
  if (type === "system") {
    const subtype = v.subtype as string | undefined;
    if (subtype === "init") {
      const cmds = Array.isArray(v.slash_commands)
        ? (v.slash_commands as unknown[]).filter(
            (x): x is string => typeof x === "string"
          )
        : [];
      return {
        kind: "init",
        session_id: (v.session_id as string) || "",
        slash_commands: cmds,
      };
    }
    if (subtype === "status" && v.status === "requesting") {
      return { kind: "thinking" };
    }
    return { kind: "ignore" };
  }
  if (type === "stream_event") {
    const event = v.event as Record<string, unknown> | undefined;
    if (!event) return { kind: "ignore" };
    const evType = event.type as string | undefined;
    if (evType === "content_block_delta") {
      const delta = event.delta as Record<string, unknown> | undefined;
      const index = (event.index as number) ?? 0;
      if (delta?.type === "text_delta" && typeof delta.text === "string") {
        return { kind: "assistant_delta", text: delta.text };
      }
      if (delta?.type === "input_json_delta" && typeof delta.partial_json === "string") {
        return {
          kind: "tool_input_delta",
          index,
          partial_json: delta.partial_json,
        };
      }
    }
    if (evType === "content_block_start") {
      const block = event.content_block as Record<string, unknown> | undefined;
      const index = (event.index as number) ?? 0;
      if (block?.type === "tool_use" && typeof block.name === "string") {
        return {
          kind: "tool_use_start",
          tool_use_id: (block.id as string) || "",
          name: block.name,
          index,
        };
      }
      if (block?.type === "text") {
        return { kind: "text_block_start", index };
      }
    }
    if (evType === "content_block_stop") {
      const index = (event.index as number) ?? 0;
      return { kind: "block_stop", index };
    }
    return { kind: "ignore" };
  }
  if (type === "assistant") {
    const msg = v.message as Record<string, unknown> | undefined;
    const content = msg?.content as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(content)) {
      for (const c of content) {
        if (c.type === "tool_use") {
          return {
            kind: "tool_use_complete",
            tool_use_id: (c.id as string) || "",
            name: (c.name as string) || "",
            input: c.input,
          };
        }
      }
      const text = content
        .filter((c) => c.type === "text")
        .map((c) => (typeof c.text === "string" ? c.text : ""))
        .join("");
      if (text) return { kind: "assistant_text", text };
    }
    return { kind: "ignore" };
  }
  if (type === "user") {
    const msg = v.message as Record<string, unknown> | undefined;
    const content = msg?.content as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(content)) {
      for (const c of content) {
        if (c.type === "tool_result") {
          let outputText = "";
          if (typeof c.content === "string") outputText = c.content;
          else if (Array.isArray(c.content)) {
            outputText = c.content
              .map((p: unknown) => {
                if (typeof p === "string") return p;
                if (p && typeof p === "object" && "text" in (p as object))
                  return String((p as { text?: unknown }).text ?? "");
                return "";
              })
              .join("");
          }
          return {
            kind: "tool_result",
            tool_use_id: (c.tool_use_id as string) || "",
            output: outputText,
            is_error: Boolean(c.is_error),
          };
        }
      }
    }
    return { kind: "ignore" };
  }
  if (type === "result") {
    const usage = (v.usage as Record<string, unknown>) ?? {};
    const modelUsage = (v.modelUsage as Record<string, unknown>) ?? {};
    const firstModel = Object.values(modelUsage)[0] as
      | Record<string, unknown>
      | undefined;
    const ctx = firstModel?.contextWindow as number | undefined;
    return {
      kind: "result",
      text: (v.result as string) || "",
      duration_ms: (v.duration_ms as number) || 0,
      cost_usd: (v.total_cost_usd as number) || 0,
      input_tokens: (usage.input_tokens as number) || 0,
      output_tokens: (usage.output_tokens as number) || 0,
      cache_read_input_tokens:
        (usage.cache_read_input_tokens as number) || 0,
      cache_creation_input_tokens:
        (usage.cache_creation_input_tokens as number) || 0,
      context_window: ctx || 0,
    };
  }
  return { kind: "ignore" };
}
