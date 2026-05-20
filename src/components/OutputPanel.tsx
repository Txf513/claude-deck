import { useMemo } from "react";
import { TerminalIcon, InfoIcon } from "./Icons";
import type { ChatMessage } from "../hooks/useChats";

type Props = {
  visible: boolean;
  messages: ChatMessage[];
  onToggleTerminal?: () => void;
};

export function OutputPanel({ visible, messages, onToggleTerminal }: Props) {
  const tools = useMemo(
    () => messages.filter((m) => m.kind === "tool"),
    [messages]
  );
  const sources = useMemo(() => collectSources(messages), [messages]);

  return (
    <aside className={`cd-rightpanel ${visible ? "" : "collapsed"}`}>
      <div className="cd-rightpanel-actions">
        <button
          className="cd-icon-btn"
          title="终端模式"
          onClick={onToggleTerminal}
        >
          <TerminalIcon size={16} />
        </button>
        <button className="cd-icon-btn cd-icon-btn-active" title="详情">
          <InfoIcon size={16} />
        </button>
      </div>
      {visible && (
        <div className="cd-rightpanel-card">
          <div className="cd-rightpanel-section">
            <div className="cd-rightpanel-title">工具调用</div>
            {tools.length === 0 ? (
              <div className="cd-rightpanel-empty">本轮暂无工具调用</div>
            ) : (
              <ul className="cd-rightpanel-list">
                {tools.map((m) => {
                  if (m.kind !== "tool") return null;
                  const t = m.tool;
                  const dotColor =
                    t.status === "running"
                      ? "var(--accent)"
                      : t.status === "error"
                      ? "var(--danger)"
                      : "var(--success)";
                  return (
                    <li key={m.id} className="cd-rightpanel-item">
                      <span
                        className="cd-rightpanel-dot"
                        style={{ background: dotColor }}
                      />
                      <span className="cd-rightpanel-item-name">{t.name}</span>
                      <span className="cd-rightpanel-item-summary">
                        {summary(t)}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          <div className="cd-rightpanel-section">
            <div className="cd-rightpanel-title">涉及文件</div>
            {sources.length === 0 ? (
              <div className="cd-rightpanel-empty">暂无</div>
            ) : (
              <ul className="cd-rightpanel-list">
                {sources.map((s) => (
                  <li key={s} className="cd-rightpanel-item cd-rightpanel-mono">
                    {s}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </aside>
  );
}

function summary(t: { input?: unknown; partialJson: string }): string {
  const obj =
    t.input ??
    (() => {
      try {
        return JSON.parse(t.partialJson);
      } catch {
        return undefined;
      }
    })();
  if (!obj || typeof obj !== "object") return "";
  const o = obj as Record<string, unknown>;
  for (const k of ["command", "file_path", "path", "pattern", "url", "query"]) {
    if (typeof o[k] === "string") {
      const v = o[k] as string;
      return v.length > 32 ? v.slice(0, 32) + "…" : v;
    }
  }
  return "";
}

function collectSources(messages: ChatMessage[]): string[] {
  const set = new Set<string>();
  for (const m of messages) {
    if (m.kind !== "tool") continue;
    const obj =
      m.tool.input ??
      (() => {
        try {
          return JSON.parse(m.tool.partialJson);
        } catch {
          return undefined;
        }
      })();
    if (!obj || typeof obj !== "object") continue;
    const o = obj as Record<string, unknown>;
    if (typeof o.file_path === "string") set.add(o.file_path);
    if (typeof o.path === "string" && (m.tool.name === "Read" || m.tool.name === "Edit"))
      set.add(o.path);
  }
  return Array.from(set).slice(0, 12);
}
