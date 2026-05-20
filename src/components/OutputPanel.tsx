import { useMemo } from "react";
import { TerminalIcon } from "./Icons";
import type { ChatMessage, ConvStatus, UsageStats } from "../lib/chatTypes";
import { buildInspectorData } from "../lib/inspector";

type Props = {
  visible: boolean;
  messages: ChatMessage[];
  status: ConvStatus;
  error: string | null;
  stderr: string[];
  usage: UsageStats;
  onToggleTerminal?: () => void;
};

export function OutputPanel({
  visible,
  messages,
  status,
  error,
  stderr,
  usage,
  onToggleTerminal,
}: Props) {
  const inspector = useMemo(
    () => buildInspectorData({ messages, status, error, stderr, usage }),
    [messages, status, error, stderr, usage]
  );

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
      </div>
      {visible && (
        <div className="cd-rightpanel-card">
          <div className="cd-rightpanel-section">
            <div className="cd-rightpanel-title">当前概览</div>
            <div className="cd-rightpanel-summary-grid">
              <div className="cd-rightpanel-stat">
                <span className="cd-rightpanel-stat-label">状态</span>
                <span className={`cd-rightpanel-badge is-${inspector.summary.status}`}>
                  {statusLabel(inspector.summary.status)}
                </span>
              </div>
              <div className="cd-rightpanel-stat">
                <span className="cd-rightpanel-stat-label">工具</span>
                <span className="cd-rightpanel-stat-value">
                  {inspector.summary.toolCount}
                </span>
              </div>
              <div className="cd-rightpanel-stat">
                <span className="cd-rightpanel-stat-label">文件</span>
                <span className="cd-rightpanel-stat-value">
                  {inspector.summary.relatedFileCount}
                </span>
              </div>
              <div className="cd-rightpanel-stat">
                <span className="cd-rightpanel-stat-label">Tokens</span>
                <span className="cd-rightpanel-stat-value">
                  {formatTokens(inspector.summary.inputTokens + inspector.summary.outputTokens)}
                </span>
              </div>
            </div>
            {inspector.summary.latestError && (
              <div className="cd-rightpanel-error">{inspector.summary.latestError}</div>
            )}
            {inspector.summary.stderrCount > 0 && (
              <div className="cd-rightpanel-muted">
                CLI stderr {inspector.summary.stderrCount} 行
              </div>
            )}
          </div>
          <div className="cd-rightpanel-section">
            <div className="cd-rightpanel-title">工具步骤</div>
            {inspector.tools.length === 0 ? (
              <div className="cd-rightpanel-empty">当前暂无工具步骤</div>
            ) : (
              <ul className="cd-rightpanel-list">
                {inspector.tools.map((message) => {
                  const tool = message.tool;
                  const dotColor =
                    tool.status === "running"
                      ? "var(--accent)"
                      : tool.status === "error"
                      ? "var(--danger)"
                      : "var(--success)";
                  return (
                    <li key={message.id} className="cd-rightpanel-item">
                      <span
                        className="cd-rightpanel-dot"
                        style={{ background: dotColor }}
                      />
                      <span className="cd-rightpanel-item-name">{tool.name}</span>
                      <span className="cd-rightpanel-item-summary">
                        {summary(tool)}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          <div className="cd-rightpanel-section">
            <div className="cd-rightpanel-title">涉及文件</div>
            {inspector.relatedFiles.length === 0 ? (
              <div className="cd-rightpanel-empty">暂无</div>
            ) : (
              <ul className="cd-rightpanel-list">
                {inspector.relatedFiles.map((s) => (
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

function statusLabel(status: ConvStatus): string {
  switch (status) {
    case "thinking":
      return "思考中";
    case "streaming":
      return "输出中";
    case "error":
      return "失败";
    default:
      return "空闲";
  }
}

function formatTokens(value: number): string {
  if (value >= 1000) {
    return `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}k`;
  }
  return String(value);
}
