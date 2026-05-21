import { describe, expect, it } from "vitest";
import type { ReplayResult } from "./claude";
import {
  entriesToMessages,
  mergePagedReplay,
  normalizeReplay,
} from "./replay";

describe("replay helpers", () => {
  it("entriesToMessages produces same output as normalizeReplay(result).messages", () => {
    const result: ReplayResult = {
      session_id: "session-1",
      messages: [
        {
          id: "u1",
          role: "user",
          text: "hello",
          timestamp: "2026-05-21T10:00:00Z",
          tool_name: null,
          is_meta: false,
        },
        {
          id: "a2",
          role: "assistant",
          text: "",
          timestamp: "2026-05-21T10:00:01Z",
          tool_name: "Read",
          is_meta: false,
        },
        {
          id: "u3",
          role: "user",
          text: "contents",
          timestamp: "2026-05-21T10:00:02Z",
          tool_name: null,
          is_meta: false,
        },
        {
          id: "a4",
          role: "assistant",
          text: "done",
          timestamp: "2026-05-21T10:00:03Z",
          tool_name: null,
          is_meta: false,
        },
      ],
      entries: [
        {
          id: "u1-text-0",
          kind: "text",
          role: "user",
          text: "hello",
          timestamp: "2026-05-21T10:00:00Z",
          tool_name: null,
          tool_use_id: null,
          tool_input_json: null,
          tool_output_text: null,
          is_error: false,
          is_meta: false,
        },
        {
          id: "a2-tool-call-0",
          kind: "tool_call",
          role: "tool",
          text: "",
          timestamp: "2026-05-21T10:00:01Z",
          tool_name: "Read",
          tool_use_id: "toolu_abc",
          tool_input_json: "{\"file_path\":\"src/App.tsx\"}",
          tool_output_text: null,
          is_error: false,
          is_meta: false,
        },
        {
          id: "u3-tool-result-0",
          kind: "tool_result",
          role: "tool",
          text: "contents",
          timestamp: "2026-05-21T10:00:02Z",
          tool_name: null,
          tool_use_id: "toolu_abc",
          tool_input_json: null,
          tool_output_text: "contents",
          is_error: false,
          is_meta: false,
        },
        {
          id: "a4-text-0",
          kind: "text",
          role: "assistant",
          text: "done",
          timestamp: "2026-05-21T10:00:03Z",
          tool_name: null,
          tool_use_id: null,
          tool_input_json: null,
          tool_output_text: null,
          is_error: false,
          is_meta: false,
        },
      ],
      cwd: "/tmp/project",
      total_input_tokens: 10,
      total_output_tokens: 20,
      total_cache_read_tokens: 0,
      total_cache_creation_tokens: 0,
      context_window: 200000,
      turn_count: 1,
      last_input_tokens: 10,
      last_output_tokens: 20,
      last_cache_read_tokens: 0,
      last_cache_creation_tokens: 0,
    };

    expect(entriesToMessages(result.entries)).toEqual(
      normalizeReplay(result).messages
    );
  });

  it("mergePagedReplay resolves tool_call/tool_result across page boundary", () => {
    const prevEntries: ReplayResult["entries"] = [
      {
        id: "u2-tool-result-0",
        kind: "tool_result",
        role: "tool",
        text: "file contents",
        timestamp: "2026-05-21T10:00:02Z",
        tool_name: null,
        tool_use_id: "abc",
        tool_input_json: null,
        tool_output_text: "file contents",
        is_error: false,
        is_meta: false,
      },
    ];
    const newPageEntries: ReplayResult["entries"] = [
      {
        id: "a1-tool-call-0",
        kind: "tool_call",
        role: "tool",
        text: "",
        timestamp: "2026-05-21T10:00:01Z",
        tool_name: "Read",
        tool_use_id: "abc",
        tool_input_json: "{\"file_path\":\"src/App.tsx\"}",
        tool_output_text: null,
        is_error: false,
        is_meta: false,
      },
    ];

    const messages = mergePagedReplay(prevEntries, newPageEntries);
    const toolMessage = messages.find((message) => message.kind === "tool");

    expect(toolMessage?.kind).toBe("tool");
    if (toolMessage?.kind !== "tool") {
      throw new Error("expected tool message");
    }
    expect(toolMessage.tool.status).toBe("done");
    expect(toolMessage.tool.output).toBe("file contents");
  });
});
