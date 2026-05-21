import { useCallback, useEffect, useRef, useState } from "react";
import {
  claudeCancel,
  claudeSend,
  onClaudeDone,
  onClaudeEvent,
  onClaudeStderr,
  parseStreamLine,
  replaySessionPaged,
  type ReplayEntry,
  type ReplayPage,
  type ReplayResult,
  type Effort,
  type PermissionMode,
} from "../lib/claude";
import type { ChatMessage, ConvStatus, UsageStats } from "../lib/chatTypes";
import { entriesToMessages, mergePagedReplay, normalizeReplay } from "../lib/replay";

export type ChatTab = {
  convId: string;
  title: string;
  cwd: string;
  sessionId: string | null;
  filePath: string | null;
  messages: ChatMessage[];
  status: ConvStatus;
  error: string | null;
  stderr: string[];
  unread: boolean;
  usage: UsageStats;
  extraDirs: string[];
  slashCommands: string[];
  lastExitCode?: number;
  replayState?: {
    filePath: string;
    loadedEntries: ReplayEntry[];
    earliestUuid: string | null;
    totalMessageCount: number;
    hasMoreBefore: boolean;
    loadingBefore: boolean;
  };
  // private bookkeeping
  requestId: string | null;
  assistantId: string | null;
  startedAt: number;
  toolByIndex: Record<number, string>;
  lastSendConfig: SendConfig | null;
};

type Notify = (title: string, body?: string) => void;
type SendConfigInput = {
  claudeBin: string | null;
  permissionMode?: PermissionMode;
  model?: string | null;
  systemPrompt?: string | null;
  appendSystemPrompt?: string | null;
  effort?: Effort | null;
};
type SendConfig = {
  claudeBin: string | null;
  permissionMode: PermissionMode;
  model: string | null;
  systemPrompt: string | null;
  appendSystemPrompt: string | null;
  effort: Effort | null;
};

function tryNotify(title: string, body?: string) {
  void (async () => {
    try {
      const { isPermissionGranted, sendNotification } = await import(
        "@tauri-apps/plugin-notification"
      );
      if (await isPermissionGranted()) {
        sendNotification({ title, body });
      }
    } catch {
      // Plugin unavailable (e.g. running in pure web preview) — silently ignore.
    }
  })();
}

const SLASH_CACHE_KEY = "cd:slash_commands";

function readCachedSlash(): string[] {
  try {
    const v = localStorage.getItem(SLASH_CACHE_KEY);
    if (!v) return [];
    const parsed = JSON.parse(v);
    if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string")) {
      return parsed;
    }
  } catch {}
  return [];
}

function writeCachedSlash(list: string[]) {
  try {
    localStorage.setItem(SLASH_CACHE_KEY, JSON.stringify(list));
  } catch {}
}

function normalizeSendConfig(input: SendConfigInput): SendConfig {
  return {
    claudeBin: input.claudeBin,
    permissionMode: input.permissionMode ?? "default",
    model: input.model ?? null,
    systemPrompt: input.systemPrompt ?? null,
    appendSystemPrompt: input.appendSystemPrompt ?? null,
    effort: input.effort ?? null,
  };
}

export function useChats(
  notify: Notify = tryNotify,
  fallbackSendContext?: SendConfigInput | null
) {
  const [tabs, setTabs] = useState<Record<string, ChatTab>>({});
  const [activeId, setActiveId] = useState<string | null>(null);

  const tabsRef = useRef(tabs);
  const activeIdRef = useRef(activeId);
  const fallbackSendContextRef = useRef<SendConfig | null>(
    fallbackSendContext ? normalizeSendConfig(fallbackSendContext) : null
  );
  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);
  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);
  useEffect(() => {
    fallbackSendContextRef.current = fallbackSendContext
      ? normalizeSendConfig(fallbackSendContext)
      : null;
  }, [fallbackSendContext]);

  // Resolve convId from a streaming request_id by scanning ref.
  function findConvByRequestId(reqId: string): string | null {
    const all = tabsRef.current;
    for (const [convId, tab] of Object.entries(all)) {
      if (tab.requestId === reqId) return convId;
    }
    return null;
  }

  useEffect(() => {
    let unlistenEvent: (() => void) | null = null;
    let unlistenStderr: (() => void) | null = null;
    let unlistenDone: (() => void) | null = null;

    onClaudeEvent((p) => {
      const convId = findConvByRequestId(p.request_id);
      if (!convId) return;
      handleLine(convId, p.line);
    }).then((u) => (unlistenEvent = u));

    onClaudeStderr((p) => {
      const convId = findConvByRequestId(p.request_id);
      if (!convId) return;
      // Cap to last 200 lines per conversation to avoid unbounded growth.
      patch(convId, (t) => ({
        ...t,
        stderr: [...t.stderr, p.line].slice(-200),
      }));
    }).then((u) => (unlistenStderr = u));

    onClaudeDone((p) => {
      const convId = findConvByRequestId(p.request_id);
      if (!convId) return;
      patch(convId, (t) => ({
        ...t,
        lastExitCode: p.code ?? undefined,
      }));
      finalize(convId, p.error ?? null, p.code);
    }).then((u) => (unlistenDone = u));

    return () => {
      unlistenEvent?.();
      unlistenStderr?.();
      unlistenDone?.();
    };
  }, []);

  // Request OS notification permission once via the Tauri plugin.
  useEffect(() => {
    void (async () => {
      try {
        const { isPermissionGranted, requestPermission } = await import(
          "@tauri-apps/plugin-notification"
        );
        if (!(await isPermissionGranted())) {
          await requestPermission();
        }
      } catch {
        // Plugin unavailable; nothing to do.
      }
    })();
  }, []);

  function patch(convId: string, mutate: (t: ChatTab) => ChatTab) {
    setTabs((prev) => {
      const t = prev[convId];
      if (!t) return prev;
      return { ...prev, [convId]: mutate(t) };
    });
  }

  function patchMessages(
    convId: string,
    fn: (msgs: ChatMessage[]) => ChatMessage[]
  ) {
    patch(convId, (t) => ({ ...t, messages: fn(t.messages) }));
  }

  function handleLine(convId: string, line: string) {
    const evt = parseStreamLine(line);
    switch (evt.kind) {
      case "init":
        if (evt.session_id || evt.slash_commands.length > 0) {
          if (evt.slash_commands.length > 0) {
            writeCachedSlash(evt.slash_commands);
          }
          patch(convId, (t) => ({
            ...t,
            sessionId: evt.session_id || t.sessionId,
            slashCommands:
              evt.slash_commands.length > 0
                ? evt.slash_commands
                : t.slashCommands,
          }));
        }
        return;
      case "thinking":
        patch(convId, (t) => ({ ...t, status: "thinking" }));
        return;
      case "assistant_delta": {
        // Atomic: in a single setState updater, ensure the assistant bubble
        // exists (creating one if needed) AND append the delta. Reading from
        // tabsRef across two patches caused the first batch of deltas to be
        // dropped before the ref caught up with the queued setState.
        setTabs((prev) => {
          const t = prev[convId];
          if (!t) return prev;
          let messages = t.messages;
          let assistantId = t.assistantId;
          if (!assistantId) {
            assistantId = `assist-${Date.now()}-${Math.random()
              .toString(36)
              .slice(2, 6)}`;
            messages = [
              ...messages,
              {
                kind: "text",
                id: assistantId,
                role: "assistant",
                text: evt.text,
                pending: true,
                startedAt: t.startedAt,
              },
            ];
          } else {
            messages = messages.map((m) =>
              m.kind === "text" && m.id === assistantId
                ? { ...m, text: m.text + evt.text }
                : m
            );
          }
          return {
            ...prev,
            [convId]: {
              ...t,
              status: "streaming",
              assistantId,
              messages,
            },
          };
        });
        return;
      }
      case "text_block_start": {
        // A new text block opens — close any prior assistant bubble so
        // subsequent text_delta starts a fresh one (instead of extending
        // and leaving multiple ghost cursors stacked).
        finalizeAssistant(convId);
        return;
      }
      case "block_stop": {
        finalizeAssistant(convId);
        return;
      }
      case "tool_use_start": {
        // close any pending assistant bubble before tool block opens
        finalizeAssistant(convId);
        patch(convId, (t) => ({
          ...t,
          status: "streaming",
          toolByIndex: { ...t.toolByIndex, [evt.index]: evt.tool_use_id },
        }));
        const msg: ChatMessage = {
          kind: "tool",
          id: `tool-${evt.tool_use_id}`,
          toolUseId: evt.tool_use_id,
          role: "tool",
          tool: {
            toolUseId: evt.tool_use_id,
            name: evt.name,
            partialJson: "",
            input: undefined,
            output: null,
            isError: false,
            status: "running",
          },
        };
        patchMessages(convId, (msgs) => [...msgs, msg]);
        return;
      }
      case "tool_input_delta": {
        const tab = tabsRef.current[convId];
        const tid = tab?.toolByIndex[evt.index];
        if (!tid) return;
        patchMessages(convId, (msgs) =>
          msgs.map((m) =>
            m.kind === "tool" && m.toolUseId === tid
              ? {
                  ...m,
                  tool: {
                    ...m.tool,
                    partialJson: m.tool.partialJson + evt.partial_json,
                  },
                }
              : m
          )
        );
        return;
      }
      case "tool_use_complete": {
        patchMessages(convId, (msgs) =>
          msgs.map((m) =>
            m.kind === "tool" && m.toolUseId === evt.tool_use_id
              ? { ...m, tool: { ...m.tool, input: evt.input } }
              : m
          )
        );
        return;
      }
      case "tool_result": {
        patchMessages(convId, (msgs) =>
          msgs.map((m) =>
            m.kind === "tool" && m.toolUseId === evt.tool_use_id
              ? {
                  ...m,
                  tool: {
                    ...m.tool,
                    output: evt.output,
                    isError: evt.is_error,
                    status: evt.is_error ? "error" : "done",
                  },
                }
              : m
          )
        );
        return;
      }
      case "result":
        patch(convId, (t) => ({
          ...t,
          usage: {
            inputTokens: evt.input_tokens || t.usage.inputTokens,
            outputTokens: evt.output_tokens,
            cacheReadTokens: evt.cache_read_input_tokens,
            cacheCreationTokens: evt.cache_creation_input_tokens,
            contextWindow: evt.context_window || t.usage.contextWindow,
            costUsd: t.usage.costUsd + (evt.cost_usd || 0),
            totalInputTokens:
              t.usage.totalInputTokens + (evt.input_tokens || 0),
            totalOutputTokens:
              t.usage.totalOutputTokens + (evt.output_tokens || 0),
            totalCacheReadTokens:
              t.usage.totalCacheReadTokens +
              (evt.cache_read_input_tokens || 0),
            totalCacheCreationTokens:
              t.usage.totalCacheCreationTokens +
              (evt.cache_creation_input_tokens || 0),
            turnCount: t.usage.turnCount + 1,
          },
        }));
        return;
      default:
        return;
    }
  }

  function finalizeAssistant(convId: string) {
    const tab = tabsRef.current[convId];
    if (!tab) return;
    const finishedId = tab.assistantId;
    if (!finishedId) return;
    const startedAt = tab.startedAt;
    patchMessages(convId, (msgs) =>
      msgs.map((m) =>
        m.kind === "text" && m.id === finishedId
          ? { ...m, pending: false, durationMs: Date.now() - startedAt }
          : m
      )
    );
    patch(convId, (t) => ({ ...t, assistantId: null }));
  }

  function finalize(convId: string, err: string | null, code: number | null = null) {
    finalizeAssistant(convId);
    const tabBefore = tabsRef.current[convId];
    // If the CLI failed with a non-zero exit but no explicit error string,
    // promote the captured stderr tail into the surfaced error so the user
    // sees something actionable instead of a silent failure.
    let displayErr: string | null = err;
    if (!displayErr && code !== null && code !== 0) {
      const tail = (tabBefore?.stderr ?? []).slice(-8).join("\n").trim();
      displayErr = tail
        ? `claude exited with code ${code}\n${tail}`
        : `claude exited with code ${code}`;
    }
    patch(convId, (t) => ({
      ...t,
      status: displayErr ? "error" : "idle",
      error: displayErr,
      lastExitCode: code ?? undefined,
      requestId: null,
      toolByIndex: {},
      unread: t.convId === activeIdRef.current ? false : true,
    }));
    const tab = tabsRef.current[convId];
    if (tab && convId !== activeIdRef.current) {
      notify(
        displayErr ? "Claude 出错了" : "Claude 回复完成",
        `${tab.title}${displayErr ? `\n${displayErr}` : ""}`
      );
    }
  }

  function setActive(convId: string | null) {
    setActiveId(convId);
    if (convId) {
      patch(convId, (t) => ({ ...t, unread: false }));
    }
  }

  function openOrCreate(args: {
    convId: string;
    title: string;
    cwd: string;
    sessionId?: string | null;
    filePath?: string | null;
  }): ChatTab {
    const existing = tabsRef.current[args.convId];
    if (existing) {
      setActive(args.convId);
      return existing;
    }
    const fresh: ChatTab = {
      convId: args.convId,
      title: args.title,
      cwd: args.cwd,
      sessionId: args.sessionId ?? null,
      filePath: args.filePath ?? null,
      messages: [],
      status: "idle",
      error: null,
      stderr: [],
      unread: false,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        contextWindow: 0,
        costUsd: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheReadTokens: 0,
        totalCacheCreationTokens: 0,
        turnCount: 0,
      },
      extraDirs: [],
      slashCommands: readCachedSlash(),
      lastExitCode: undefined,
      replayState: undefined,
      requestId: null,
      assistantId: null,
      startedAt: 0,
      toolByIndex: {},
      lastSendConfig: null,
    };
    setTabs((prev) => ({ ...prev, [args.convId]: fresh }));
    setActive(args.convId);
    return fresh;
  }

  function loadReplay(
    convId: string,
    replay: ReplayResult
  ) {
    const normalized = normalizeReplay(replay);
    patch(convId, (t) => ({
      ...t,
      sessionId: replay.session_id,
      messages: normalized.messages,
      status: "idle",
      error: null,
      stderr: normalized.stderr,
      lastExitCode: undefined,
      lastSendConfig: null,
      replayState: t.filePath
        ? {
            filePath: t.filePath,
            loadedEntries: replay.entries,
            earliestUuid: replay.messages[0]?.id ?? null,
            totalMessageCount: replay.messages.length,
            hasMoreBefore: false,
            loadingBefore: false,
          }
        : undefined,
      usage: {
        inputTokens: replay.last_input_tokens ?? 0,
        outputTokens: replay.last_output_tokens ?? 0,
        cacheReadTokens: replay.last_cache_read_tokens ?? 0,
        cacheCreationTokens: replay.last_cache_creation_tokens ?? 0,
        contextWindow: replay.context_window ?? 0,
        costUsd: t.usage.costUsd, // jsonl has no cost; keep whatever was there
        totalInputTokens: replay.total_input_tokens ?? 0,
        totalOutputTokens: replay.total_output_tokens ?? 0,
        totalCacheReadTokens: replay.total_cache_read_tokens ?? 0,
        totalCacheCreationTokens: replay.total_cache_creation_tokens ?? 0,
        turnCount: replay.turn_count ?? 0,
      },
    }));
  }

  function loadInitialPage(
    convId: string,
    filePath: string,
    page: ReplayPage
  ) {
    patch(convId, (t) => ({
      ...t,
      filePath,
      sessionId: page.session_id,
      messages: entriesToMessages(page.entries),
      status: "idle",
      error: null,
      stderr: [],
      lastExitCode: undefined,
      lastSendConfig: null,
      replayState: {
        filePath,
        loadedEntries: page.entries,
        earliestUuid: page.earliest_uuid,
        totalMessageCount: page.total_message_count,
        hasMoreBefore: page.has_more_before,
        loadingBefore: false,
      },
      usage: {
        inputTokens: page.last_input_tokens ?? 0,
        outputTokens: page.last_output_tokens ?? 0,
        cacheReadTokens: page.last_cache_read_tokens ?? 0,
        cacheCreationTokens: page.last_cache_creation_tokens ?? 0,
        contextWindow: page.context_window ?? 0,
        costUsd: t.usage.costUsd,
        totalInputTokens: page.total_input_tokens ?? 0,
        totalOutputTokens: page.total_output_tokens ?? 0,
        totalCacheReadTokens: page.total_cache_read_tokens ?? 0,
        totalCacheCreationTokens: page.total_cache_creation_tokens ?? 0,
        turnCount: page.turn_count ?? 0,
      },
    }));
  }

  async function loadEarlier(convId: string): Promise<void> {
    const tab = tabsRef.current[convId];
    const replayState = tab?.replayState;
    if (
      !replayState ||
      !replayState.hasMoreBefore ||
      replayState.loadingBefore ||
      !replayState.earliestUuid
    ) {
      return;
    }

    patch(convId, (t) => ({
      ...t,
      replayState: t.replayState
        ? { ...t.replayState, loadingBefore: true }
        : t.replayState,
    }));

    try {
      const page = await replaySessionPaged(replayState.filePath, {
        beforeUuid: replayState.earliestUuid,
        limit: 600,
      });
      const current = tabsRef.current[convId]?.replayState;
      if (!current) return;
      const newEntries = page.entries.concat(current.loadedEntries);
      patch(convId, (t) => ({
        ...t,
        messages: mergePagedReplay(current.loadedEntries, page.entries),
        replayState: {
          filePath: current.filePath,
          loadedEntries: newEntries,
          earliestUuid: page.earliest_uuid,
          totalMessageCount: page.total_message_count,
          hasMoreBefore: page.has_more_before,
          loadingBefore: false,
        },
      }));
    } catch (error) {
      console.error("loadEarlier failed", error);
      patch(convId, (t) => ({
        ...t,
        replayState: t.replayState
          ? { ...t.replayState, loadingBefore: false }
          : t.replayState,
      }));
    }
  }

  async function spawnRequest(
    convId: string,
    prompt: string,
    sendConfig: SendConfig,
    appendUserMessage: boolean
  ) {
    const tab = tabsRef.current[convId];
    if (!tab) return;
    if (tab.status === "thinking" || tab.status === "streaming") return;

    const startedAt = Date.now();
    const reqId = `req-${convId}-${startedAt}-${Math.random()
      .toString(36)
      .slice(2, 6)}`;
    const userId = `user-${startedAt}`;

    patch(convId, (t) => ({
      ...t,
      requestId: sendConfig.claudeBin ? reqId : null,
      assistantId: null,
      startedAt,
      toolByIndex: {},
      status: sendConfig.claudeBin ? "thinking" : "error",
      error: sendConfig.claudeBin ? null : "claude: not found",
      stderr: [],
      lastExitCode: sendConfig.claudeBin ? undefined : 127,
      lastSendConfig: sendConfig,
      messages: appendUserMessage
        ? [...t.messages, { kind: "text", id: userId, role: "user", text: prompt }]
        : t.messages,
    }));

    if (!sendConfig.claudeBin) return;

    try {
      const latestTab = tabsRef.current[convId];
      await claudeSend({
        request_id: reqId,
        prompt,
        cwd: latestTab?.cwd ?? tab.cwd,
        resume_session_id: latestTab?.sessionId ?? tab.sessionId,
        claude_bin: sendConfig.claudeBin,
        skip_permissions: sendConfig.permissionMode === "bypassPermissions",
        permission_mode: sendConfig.permissionMode,
        model: sendConfig.model,
        system_prompt: sendConfig.systemPrompt,
        append_system_prompt: sendConfig.appendSystemPrompt,
        effort: sendConfig.effort,
        extra_dirs: latestTab?.extraDirs ?? tab.extraDirs,
      });
    } catch (e) {
      patch(convId, (t) => ({
        ...t,
        status: "error",
        error: String(e),
        requestId: null,
      }));
    }
  }

  const send = useCallback(
    async (
      convId: string,
      prompt: string,
      claudeBin: string | null,
      opts?: {
        permissionMode?: PermissionMode;
        model?: string | null;
        systemPrompt?: string | null;
        appendSystemPrompt?: string | null;
        effort?: Effort | null;
      }
    ) => {
      await spawnRequest(
        convId,
        prompt,
        normalizeSendConfig({
          claudeBin,
          permissionMode: opts?.permissionMode,
          model: opts?.model,
          systemPrompt: opts?.systemPrompt,
          appendSystemPrompt: opts?.appendSystemPrompt,
          effort: opts?.effort,
        }),
        true
      );
    },
    []
  );

  const retryLast = useCallback(async (convId: string) => {
    const tab = tabsRef.current[convId];
    if (!tab) return;
    const lastUser = [...tab.messages]
      .reverse()
      .find((message): message is ChatMessage & { kind: "text"; role: "user" } =>
        message.kind === "text" && message.role === "user"
      );
    if (!lastUser) return;
    const sendConfig = tab.lastSendConfig ?? fallbackSendContextRef.current;
    if (!sendConfig) return;
    await spawnRequest(convId, lastUser.text, sendConfig, false);
  }, []);

  const hasUserMessage = useCallback((convId: string) => {
    const tab = tabsRef.current[convId];
    if (!tab) return false;
    return tab.messages.some(
      (message) => message.kind === "text" && message.role === "user"
    );
  }, []);

  const cancel = useCallback(async (convId: string) => {
    const tab = tabsRef.current[convId];
    if (!tab?.requestId) return;
    await claudeCancel(tab.requestId);
  }, []);

  function closeTab(convId: string) {
    const tab = tabsRef.current[convId];
    if (tab?.requestId) {
      claudeCancel(tab.requestId).catch(() => {});
    }
    setTabs((prev) => {
      const next = { ...prev };
      delete next[convId];
      return next;
    });
    if (activeIdRef.current === convId) {
      const remaining = Object.keys(tabsRef.current).filter((k) => k !== convId);
      setActive(remaining[remaining.length - 1] ?? null);
    }
  }

  const tabsList = Object.values(tabs);
  const active = activeId ? tabs[activeId] ?? null : null;

  function setExtraDirs(convId: string, next: string[]) {
    patch(convId, (t) => ({ ...t, extraDirs: next }));
  }

  return {
    tabs,
    tabsList,
    active,
    activeId,
    setActive,
    openOrCreate,
    loadReplay,
    loadInitialPage,
    loadEarlier,
    send,
    retryLast,
    hasUserMessage,
    cancel,
    closeTab,
    setExtraDirs,
  };
}
