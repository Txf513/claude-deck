import { useEffect, useRef, useState } from "react";
import { searchSessions, type SearchHit } from "../lib/sessions";

type Props = {
  open: boolean;
  onClose: () => void;
  onPick: (hit: SearchHit) => void;
};

export function SearchOverlay({ open, onClose, onPick }: Props) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setResults([]);
      setActiveIdx(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (query.trim().length < 2) {
      setResults([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const r = await searchSessions(query.trim(), 60);
        setResults(r);
        setActiveIdx(0);
      } catch (e) {
        console.error("search failed", e);
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 180);
  }, [query, open]);

  if (!open) return null;

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => Math.min(results.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      const hit = results[activeIdx];
      if (hit) onPick(hit);
    }
  }

  return (
    <div className="cd-search-backdrop" onClick={onClose}>
      <div className="cd-search-panel" onClick={(e) => e.stopPropagation()}>
        <div className="cd-search-input-wrap">
          <input
            ref={inputRef}
            className="cd-search-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="搜索所有会话内容..."
          />
          <span className="cd-search-hint">{loading ? "搜索中…" : "Esc 关闭"}</span>
        </div>
        <div className="cd-search-results">
          {!loading && query.trim().length >= 2 && results.length === 0 && (
            <div className="cd-search-empty">无匹配结果</div>
          )}
          {results.map((hit, i) => (
            <button
              key={`${hit.file_path}-${i}`}
              className={`cd-search-item ${i === activeIdx ? "active" : ""}`}
              onMouseEnter={() => setActiveIdx(i)}
              onClick={() => onPick(hit)}
            >
              <div className="cd-search-item-head">
                <span className="cd-search-project">{hit.project_name}</span>
                <span
                  className={`cd-search-role cd-search-role-${hit.role}`}
                >
                  {hit.role === "user" ? "U" : "A"}
                </span>
                {hit.entry_kind && (
                  <span className="cd-search-kind">
                    {entryKindLabel(hit.entry_kind)}
                  </span>
                )}
                {hit.tool_name && (
                  <span className="cd-search-tool">{hit.tool_name}</span>
                )}
                <span className="cd-search-mtime">{relative(hit.mtime_ms)}</span>
              </div>
              <div className="cd-search-snippet">
                {highlight(hit.snippet, query.trim())}
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function relative(ms: number): string {
  const diff = Date.now() - ms;
  const m = 60_000;
  const h = 60 * m;
  const d = 24 * h;
  if (diff < m) return "刚刚";
  if (diff < h) return `${Math.floor(diff / m)}分钟前`;
  if (diff < d) return `${Math.floor(diff / h)}小时前`;
  if (diff < 30 * d) return `${Math.floor(diff / d)}天前`;
  const dt = new Date(ms);
  return `${dt.getMonth() + 1}/${dt.getDate()}`;
}

function highlight(text: string, q: string) {
  if (!q) return text;
  const lower = text.toLowerCase();
  const ql = q.toLowerCase();
  const out: React.ReactNode[] = [];
  let i = 0;
  while (i < text.length) {
    const found = lower.indexOf(ql, i);
    if (found === -1) {
      out.push(<span key={`t-${i}`}>{text.slice(i)}</span>);
      break;
    }
    if (found > i) out.push(<span key={`t-${i}`}>{text.slice(i, found)}</span>);
    out.push(
      <mark key={`m-${found}`} className="cd-search-mark">
        {text.slice(found, found + q.length)}
      </mark>
    );
    i = found + q.length;
  }
  return out;
}

function entryKindLabel(kind: string): string {
  switch (kind) {
    case "tool_call":
      return "Tool";
    case "tool_result":
      return "Result";
    case "text":
      return "Text";
    default:
      return kind;
  }
}
