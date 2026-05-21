import { useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/github.css";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { ChevronDown, ChevronRight } from "./Icons";
import { LocalImage } from "./LocalImage";
import { Lightbox } from "./Lightbox";
import { writeTextFile } from "../lib/config";
import { classifyError, type ErrorKind } from "../lib/errorClassify";
import type { ChatMessage, ToolCall } from "../lib/chatTypes";

type Props = {
  title: string;
  subtitle?: string;
  messages: ChatMessage[];
  status: "idle" | "thinking" | "streaming" | "error";
  error?: string | null;
  stderr?: string[];
  exitCode?: number;
  highlightId?: string | null;
  onHighlightConsumed?: () => void;
  onRetry?: () => void;
  canRetry?: boolean;
  onLoadEarlier?: () => void;
  replayLoadState?: {
    hasMoreBefore: boolean;
    loadingBefore: boolean;
    remaining: number;
  };
};

export function ChatView({
  title,
  subtitle,
  messages,
  status,
  error,
  stderr,
  exitCode,
  highlightId,
  onHighlightConsumed,
  onRetry,
  canRetry,
  onLoadEarlier,
  replayLoadState,
}: Props) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const lastTextLen =
    messages.length > 0 && messages[messages.length - 1].kind === "text"
      ? (messages[messages.length - 1] as { text: string }).text.length
      : 0;
  const userScrolledRef = useRef(false);
  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 120,
    overscan: 8,
    measureElement: (element) =>
      element?.getBoundingClientRect().height ?? 0,
  });
  const virtualItems = messages.length > 0 ? virtualizer.getVirtualItems() : [];

  // Track whether user has scrolled up; if so, suppress auto-scroll.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    function onScroll() {
      if (!el) return;
      const distanceFromBottom =
        el.scrollHeight - el.scrollTop - el.clientHeight;
      userScrolledRef.current = distanceFromBottom > 80;
    }
    el.addEventListener("scroll", onScroll);
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (highlightId) return; // when jumping, don't auto-scroll to bottom
    if (messages.length === 0) return;
    if (!scrollRef.current) return;
    if (userScrolledRef.current) return;
    virtualizer.scrollToIndex(messages.length - 1, { align: "end" });
  }, [messages.length, lastTextLen, highlightId]);

  // Jump-to-message support (search result click).
  useEffect(() => {
    if (!highlightId) return;
    const el = scrollRef.current;
    if (!el) return;
    const idx = messages.findIndex((message) => message.id === highlightId);
    if (idx >= 0) {
      virtualizer.scrollToIndex(idx, { align: "center" });
    }
    let cancelled = false;
    function tryScroll(attempt: number) {
      if (cancelled) return;
      const target = el!.querySelector<HTMLElement>(
        `[data-msg-id="${CSS.escape(highlightId!)}"]`
      );
      if (target) {
        target.scrollIntoView({ behavior: "smooth", block: "center" });
        target.classList.add("cd-msg-flash");
        window.setTimeout(() => target.classList.remove("cd-msg-flash"), 2200);
        onHighlightConsumed?.();
        return;
      }
      if (attempt > 12) {
        onHighlightConsumed?.();
        return;
      }
      window.setTimeout(() => tryScroll(attempt + 1), 80);
    }
    tryScroll(0);
    return () => {
      cancelled = true;
    };
  }, [highlightId, messages.length, onHighlightConsumed]);

  return (
    <section className="cd-chat">
      {lightbox && (
        <Lightbox path={lightbox} onClose={() => setLightbox(null)} />
      )}
      <header className="cd-chat-header">
        <div>
          <div className="cd-chat-title">{title}</div>
          {subtitle && <div className="cd-chat-subtitle">{subtitle}</div>}
        </div>
        <button
          className="cd-icon-btn"
          title="导出当前对话为 Markdown"
          disabled={exporting || messages.length === 0}
          onClick={async () => {
            try {
              setExporting(true);
              const safe = title
                .replace(/[\\/:*?"<>|\n\r\t]+/g, " ")
                .trim()
                .slice(0, 60) || "claude-deck";
              const stamp = new Date()
                .toISOString()
                .replace(/[:T]/g, "-")
                .slice(0, 16);
              const path = await saveDialog({
                defaultPath: `${safe}-${stamp}.md`,
                filters: [{ name: "Markdown", extensions: ["md"] }],
              });
              if (!path) return;
              const md = exportToMarkdown(title, subtitle, messages);
              await writeTextFile(path, md);
            } catch (err) {
              console.error("export failed", err);
              alert(`导出失败: ${err}`);
            } finally {
              setExporting(false);
            }
          }}
        >
          {exporting ? "…" : "↓ md"}
        </button>
      </header>
      <div className="cd-chat-scroll" ref={scrollRef}>
        <div className="cd-chat-inner">
          {replayLoadState?.hasMoreBefore && (
            <div
              style={{
                display: "flex",
                justifyContent: "center",
                marginBottom: 16,
              }}
            >
              {replayLoadState.loadingBefore ? (
                <ThinkingDots />
              ) : (
                <button className="cd-foot-btn" onClick={onLoadEarlier}>
                  加载更早 (剩余 {replayLoadState.remaining})
                </button>
              )}
            </div>
          )}
          {messages.length === 0 ? (
            <EmptyState />
          ) : (
            <div
              style={{
                height: `${virtualizer.getTotalSize()}px`,
                position: "relative",
              }}
            >
              {virtualItems.map((virtualRow) => {
                const message = messages[virtualRow.index];
                return (
                  <div
                    key={message.id}
                    ref={virtualizer.measureElement}
                    data-index={virtualRow.index}
                    data-msg-id={message.id}
                    style={{
                      left: 0,
                      paddingBottom:
                        virtualRow.index === messages.length - 1 ? 0 : 16,
                      position: "absolute",
                      top: 0,
                      transform: `translateY(${virtualRow.start}px)`,
                      width: "100%",
                    }}
                  >
                    <Bubble message={message} onImageClick={setLightbox} />
                  </div>
                );
              })}
            </div>
          )}
          {status === "thinking" && <ThinkingDots />}
          {(error ||
            (stderr && stderr.length > 0) ||
            (exitCode !== undefined && exitCode !== 0)) && (
            <ChatErrorBlock
              error={error ?? null}
              stderr={stderr ?? []}
              exitCode={exitCode}
              onRetry={onRetry}
              canRetry={canRetry}
            />
          )}
        </div>
      </div>
    </section>
  );
}

const ERROR_KIND_EMOJI: Record<ErrorKind, string> = {
  "cli-missing": "❓",
  permission: "🔒",
  "rate-limit": "⏱",
  crashed: "💥",
  unknown: "⚠️",
};

function ChatErrorBlock({
  error,
  stderr,
  exitCode,
  onRetry,
  canRetry,
}: {
  error: string | null;
  stderr: string[];
  exitCode?: number;
  onRetry?: () => void;
  canRetry?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const hasStderr = stderr.length > 0;
  const detail = error?.trim() ?? "";
  const classified = classifyError({ error, stderr, exitCode });
  return (
    <div className="cd-chat-error">
      {classified && (
        <div
          style={{
            alignItems: "center",
            display: "flex",
            gap: 8,
          }}
        >
          <span>{ERROR_KIND_EMOJI[classified.kind]}</span>
          <span>{classified.message}</span>
          <button
            className="cd-foot-btn"
            style={{ marginLeft: "auto" }}
            disabled={!canRetry || !onRetry}
            onClick={() => onRetry?.()}
          >
            重试
          </button>
        </div>
      )}
      {detail && <div style={{ marginTop: classified ? 8 : 0 }}>{detail}</div>}
      {!classified && !detail && hasStderr && <div>Claude CLI 输出了诊断信息</div>}
      {hasStderr && (
        <>
          <button
            className="cd-chat-error-toggle"
            onClick={() => setOpen((v) => !v)}
          >
            {open ? "▾" : "▸"} CLI stderr ({stderr.length} 行)
          </button>
          {open && (
            <pre className="cd-chat-error-pre">{stderr.join("\n")}</pre>
          )}
        </>
      )}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="cd-chat-empty">
      <div className="cd-chat-empty-title">开始一段新对话</div>
      <div className="cd-chat-empty-desc">
        在下方输入框写点什么，按 Cmd+Enter 发送。Claude 会以这个项目目录作为
        cwd 运行。
      </div>
    </div>
  );
}

function ThinkingDots() {
  return (
    <div className="cd-thinking">
      <span />
      <span />
      <span />
    </div>
  );
}

function Bubble({ message, onImageClick }: { message: ChatMessage; onImageClick: (path: string) => void }) {
  if (message.kind === "tool") {
    return (
      <div className="cd-row cd-row-tool" data-msg-id={message.id}>
        <ToolCard tool={message.tool} />
      </div>
    );
  }
  if (message.role === "user") {
    const { text, images, files } = extractAttachments(message.text);
    return (
      <div className="cd-row cd-row-user" data-msg-id={message.id}>
        {images.length > 0 && (
          <div className="cd-user-images">
            {images.map((p) => (
              <LocalImage
                key={p}
                path={p}
                className="cd-user-image"
                alt={p}
                onClick={() => onImageClick(p)}
              />
            ))}
          </div>
        )}
        {files.length > 0 && (
          <div className="cd-user-files">
            {files.map((p) => (
              <span key={p} className="cd-user-file" title={p}>
                📎 {p.split("/").pop()}
              </span>
            ))}
          </div>
        )}
        {text && <div className="cd-bubble cd-bubble-user">{text}</div>}
      </div>
    );
  }
  // Drop empty, non-pending assistant bubbles entirely.
  if (!message.text && !message.pending) return null;
  return (
    <div className="cd-row cd-row-assistant" data-msg-id={message.id}>
      {message.durationMs !== undefined && message.text && (
        <div className="cd-thought" title="本轮回复总耗时">
          已处理 {Math.max(1, Math.round(message.durationMs / 1000))}s
        </div>
      )}
      <div className="cd-bubble cd-bubble-assistant">
        <Markdown text={message.text} />
        {message.pending && message.text && <span className="cd-cursor">▍</span>}
      </div>
    </div>
  );
}

function extractAttachments(raw: string): {
  text: string;
  images: string[];
  files: string[];
} {
  const images: string[] = [];
  const files: string[] = [];
  const lines = raw.split("\n");
  const kept: string[] = [];
  for (const line of lines) {
    const img = line.match(/^\[Image:\s*(.+?)\]\s*$/);
    const file = line.match(/^\[Attached file:\s*(.+?)\]\s*$/);
    if (img) {
      images.push(img[1].trim());
      continue;
    }
    if (file) {
      files.push(file[1].trim());
      continue;
    }
    kept.push(line);
  }
  return {
    text: kept.join("\n").trim(),
    images,
    files,
  };
}

function Markdown({ text }: { text: string }) {
  if (!text) return null;
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeHighlight]}
      components={{
        a: ({ ...props }) => (
          <a {...props} target="_blank" rel="noreferrer" />
        ),
      }}
    >
      {text}
    </ReactMarkdown>
  );
}

function ToolCard({ tool }: { tool: ToolCall }) {
  if (tool.name === "TodoWrite") {
    return <TodoCard tool={tool} />;
  }
  return <GenericToolCard tool={tool} />;
}

function GenericToolCard({ tool }: { tool: ToolCall }) {
  const [open, setOpen] = useState(false);
  const summary = summarizeInput(tool);
  const statusColor =
    tool.status === "running"
      ? "var(--accent)"
      : tool.status === "error"
      ? "var(--danger)"
      : "var(--success)";
  const statusLabel =
    tool.status === "running"
      ? "运行中"
      : tool.status === "error"
      ? "失败"
      : "完成";

  const isEdit = tool.name === "Edit";
  const isWrite = tool.name === "Write";

  return (
    <div className={`cd-tool-card ${tool.status}`}>
      <button className="cd-tool-card-head" onClick={() => setOpen((v) => !v)}>
        <span className="cd-tool-card-chev">
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </span>
        <span className="cd-tool-card-name">{tool.name}</span>
        {summary && (
          <span className="cd-tool-card-summary" title={summary}>
            {summary}
          </span>
        )}
        <span className="cd-tool-card-spacer" />
        <span className="cd-tool-card-status" style={{ color: statusColor }}>
          {statusLabel}
        </span>
      </button>
      {open && (
        <div className="cd-tool-card-body">
          {isEdit ? (
            <EditPreview tool={tool} />
          ) : isWrite ? (
            <WritePreview tool={tool} />
          ) : (
            <>
              <div className="cd-tool-card-section-title">输入</div>
              <pre className="cd-tool-card-pre">{prettyInput(tool)}</pre>
            </>
          )}
          {tool.output !== null && !isEdit && !isWrite && (
            <>
              <div className="cd-tool-card-section-title">输出</div>
              <pre
                className={`cd-tool-card-pre ${
                  tool.isError ? "cd-tool-card-error" : ""
                }`}
              >
                {tool.output || "(empty)"}
              </pre>
            </>
          )}
          {tool.output !== null && (isEdit || isWrite) && tool.isError && (
            <>
              <div className="cd-tool-card-section-title">错误</div>
              <pre className="cd-tool-card-pre cd-tool-card-error">
                {tool.output}
              </pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

type TodoItem = {
  content: string;
  status: "pending" | "in_progress" | "completed" | string;
  activeForm?: string;
};

function TodoCard({ tool }: { tool: ToolCall }) {
  const obj = asObject(tool);
  const todos = (obj?.todos as TodoItem[] | undefined) ?? [];
  const isStreaming = tool.status === "running" && todos.length === 0;
  const counts = todos.reduce(
    (acc, t) => {
      if (t.status === "completed") acc.done += 1;
      else if (t.status === "in_progress") acc.doing += 1;
      else acc.pending += 1;
      return acc;
    },
    { done: 0, doing: 0, pending: 0 }
  );
  const total = todos.length;
  const allDone = total > 0 && counts.done === total;
  return (
    <div className={`cd-todo-card ${tool.status}`}>
      <div className="cd-todo-head">
        <span className="cd-todo-icon">📝</span>
        <span className="cd-todo-title">待办列表</span>
        {total > 0 && (
          <span className="cd-todo-count">
            {counts.done} / {total}
            {counts.doing > 0 && ` · 进行中 ${counts.doing}`}
          </span>
        )}
        {tool.isError && <span className="cd-todo-err">失败</span>}
        {allDone && <span className="cd-todo-allgood">全部完成</span>}
      </div>
      {isStreaming && <div className="cd-todo-empty">读取中…</div>}
      {todos.length > 0 && (
        <ul className="cd-todo-list">
          {todos.map((t, i) => {
            const isDoing = t.status === "in_progress";
            const isDone = t.status === "completed";
            const text = isDoing && t.activeForm ? t.activeForm : t.content;
            return (
              <li key={i} className={`cd-todo-item cd-todo-${t.status}`}>
                <span className="cd-todo-mark">
                  {isDone ? "✓" : isDoing ? "▸" : "○"}
                </span>
                <span className="cd-todo-text">{text}</span>
              </li>
            );
          })}
        </ul>
      )}
      {todos.length === 0 && !isStreaming && (
        <div className="cd-todo-empty">(空列表)</div>
      )}
    </div>
  );
}

function asObject(tool: ToolCall): Record<string, unknown> | null {
  const obj =
    tool.input ??
    (() => {
      try {
        return JSON.parse(tool.partialJson);
      } catch {
        return undefined;
      }
    })();
  return obj && typeof obj === "object" ? (obj as Record<string, unknown>) : null;
}

function EditPreview({ tool }: { tool: ToolCall }) {
  const obj = asObject(tool);
  const filePath = (obj?.file_path as string) || "";
  const oldStr = (obj?.old_string as string) ?? "";
  const newStr = (obj?.new_string as string) ?? "";
  const replaceAll = (obj?.replace_all as boolean) ?? false;
  return (
    <div>
      <div className="cd-tool-card-section-title">
        文件 {replaceAll && <span style={{ marginLeft: 6 }}>(replace_all)</span>}
      </div>
      <div className="cd-diff-path">{filePath || "(unknown path)"}</div>
      <div className="cd-diff-grid">
        <DiffPane label="− 旧" cls="cd-diff-old" text={oldStr} />
        <DiffPane label="+ 新" cls="cd-diff-new" text={newStr} />
      </div>
    </div>
  );
}

function WritePreview({ tool }: { tool: ToolCall }) {
  const obj = asObject(tool);
  const filePath = (obj?.file_path as string) || "";
  const content = (obj?.content as string) ?? "";
  return (
    <div>
      <div className="cd-tool-card-section-title">写入文件</div>
      <div className="cd-diff-path">{filePath || "(unknown path)"}</div>
      <pre className="cd-tool-card-pre cd-diff-write">{content || "(empty)"}</pre>
    </div>
  );
}

function DiffPane({
  label,
  cls,
  text,
}: {
  label: string;
  cls: string;
  text: string;
}) {
  const lines = text.length === 0 ? ["(empty)"] : text.split("\n");
  return (
    <div className={`cd-diff-pane ${cls}`}>
      <div className="cd-diff-label">{label}</div>
      <pre className="cd-diff-body">
        {lines.map((line, i) => (
          <div key={i} className="cd-diff-line">
            <span className="cd-diff-num">{i + 1}</span>
            <span className="cd-diff-text">{line || " "}</span>
          </div>
        ))}
      </pre>
    </div>
  );
}

function summarizeInput(tool: ToolCall): string {
  const obj = tool.input ?? safeParse(tool.partialJson);
  if (!obj || typeof obj !== "object") return "";
  const o = obj as Record<string, unknown>;
  if (typeof o.command === "string") return truncate(o.command, 80);
  if (typeof o.file_path === "string") return truncate(o.file_path, 80);
  if (typeof o.path === "string") return truncate(o.path, 80);
  if (typeof o.pattern === "string") return truncate(o.pattern, 80);
  if (typeof o.url === "string") return truncate(o.url, 80);
  if (typeof o.query === "string") return truncate(o.query, 80);
  return "";
}

function prettyInput(tool: ToolCall): string {
  const obj = tool.input ?? safeParse(tool.partialJson);
  if (obj === undefined || obj === null) {
    return tool.partialJson || "(no input)";
  }
  try {
    return JSON.stringify(obj, null, 2);
  } catch {
    return String(obj);
  }
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + "…";
}

function exportToMarkdown(
  title: string,
  subtitle: string | undefined,
  messages: ChatMessage[]
): string {
  const lines: string[] = [];
  lines.push(`# ${title}`);
  if (subtitle) lines.push(`> ${subtitle}`);
  lines.push(`> 导出时间: ${new Date().toISOString()}`);
  lines.push("");
  for (const m of messages) {
    if (m.kind === "tool") {
      const t = m.tool;
      const status =
        t.status === "running" ? "⏳" : t.status === "error" ? "✗" : "✓";
      lines.push(`### 🔧 ${t.name} ${status}`);
      const inputObj =
        t.input ??
        (() => {
          try {
            return JSON.parse(t.partialJson);
          } catch {
            return undefined;
          }
        })();
      if (inputObj !== undefined) {
        lines.push("```json");
        try {
          lines.push(JSON.stringify(inputObj, null, 2));
        } catch {
          lines.push(String(inputObj));
        }
        lines.push("```");
      }
      if (t.output) {
        lines.push(t.isError ? "**错误输出**:" : "**输出**:");
        lines.push("```");
        lines.push(t.output);
        lines.push("```");
      }
      lines.push("");
      continue;
    }
    if (m.role === "user") {
      lines.push("## 🧑 用户");
      lines.push("");
      lines.push(m.text);
      lines.push("");
    } else {
      if (!m.text) continue;
      lines.push("## 🤖 Claude");
      if (m.durationMs !== undefined) {
        lines.push(`*耗时 ${Math.max(1, Math.round(m.durationMs / 1000))}s*`);
      }
      lines.push("");
      lines.push(m.text);
      lines.push("");
    }
  }
  return lines.join("\n");
}
