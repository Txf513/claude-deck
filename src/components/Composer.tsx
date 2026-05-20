import { useEffect, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { savePasteImage } from "../lib/pty";
import { listModels, type ModelOption } from "../lib/config";
import { searchFiles, type FileHit } from "../lib/sessions";
import type { Effort, PermissionMode } from "../lib/claude";
import { LocalImage } from "./LocalImage";
import { Lightbox } from "./Lightbox";
import { ChevronDown, MicIcon, PlusIcon, SendIcon, WarningDot } from "./Icons";

export type EffortChoice = Effort | "off";

export type ComposerSettings = {
  permissionMode: PermissionMode;
  model: string;
  effort: EffortChoice;
  appendSystemPrompt: string;
};

export type Attachment = {
  id: string;
  path: string;
  name: string;
  kind: "image" | "file";
};

type Props = {
  busy: boolean;
  placeholder?: string;
  settings: ComposerSettings;
  onSettingsChange: (s: ComposerSettings) => void;
  onSend: (text: string, attachments: Attachment[]) => void;
  onCancel: () => void;
  cwd?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    contextWindow: number;
    costUsd: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCacheReadTokens: number;
    totalCacheCreationTokens: number;
    turnCount: number;
  };
  slashCommands?: string[];
};

const PERMISSION_OPTIONS: {
  value: PermissionMode;
  label: string;
  hint: string;
}[] = [
  { value: "default", label: "default", hint: "需要时弹出权限确认（CLI 默认）" },
  { value: "acceptEdits", label: "acceptEdits", hint: "Edit/Write 自动放行" },
  { value: "auto", label: "auto", hint: "全自动，所有工具放行" },
  { value: "plan", label: "plan", hint: "只规划不执行（拦工具调用）" },
  { value: "dontAsk", label: "dontAsk", hint: "不弹权限询问，直接拒绝" },
  { value: "bypassPermissions", label: "bypassPermissions", hint: "跳过所有权限检查" },
];

const EFFORT_OPTIONS: {
  value: EffortChoice;
  label: string;
  hint: string;
}[] = [
  { value: "off", label: "effort: off", hint: "不传 --effort，使用模型默认" },
  { value: "low", label: "effort: low", hint: "极少思考，最省 token" },
  { value: "medium", label: "effort: medium", hint: "中等思考量" },
  { value: "high", label: "effort: high", hint: "充分思考（推荐）" },
  { value: "xhigh", label: "effort: xhigh", hint: "更深入推理" },
  { value: "max", label: "effort: max", hint: "最大思考预算" },
];

const MODEL_FALLBACK: ModelOption[] = [
  {
    id: "opus",
    family: "opus",
    label: "Opus",
    thinking: false,
    context_1m: false,
    source: "alias",
  },
  {
    id: "sonnet",
    family: "sonnet",
    label: "Sonnet",
    thinking: false,
    context_1m: false,
    source: "alias",
  },
  {
    id: "haiku",
    family: "haiku",
    label: "Haiku",
    thinking: false,
    context_1m: false,
    source: "alias",
  },
];

function buildModelArg(family: string): string {
  return family;
}

function modelLabel(s: ComposerSettings, options: ModelOption[]): string {
  const exact = options.find((m) => m.id === s.model);
  if (exact) return exact.label;
  const family = options.find((m) => m.family === s.model);
  if (family) return family.label;
  return s.model;
}

function permissionLabel(mode: PermissionMode): string {
  return PERMISSION_OPTIONS.find((o) => o.value === mode)?.label ?? mode;
}

function effortLabel(value: EffortChoice): string {
  return EFFORT_OPTIONS.find((o) => o.value === value)?.label ?? `effort: ${value}`;
}

function permissionAccent(mode: PermissionMode): string {
  if (mode === "bypassPermissions" || mode === "auto") return "var(--accent)";
  if (mode === "plan") return "var(--link, #0969da)";
  if (mode === "dontAsk") return "var(--danger)";
  return "var(--text-secondary)";
}

const IMAGE_RE = /\.(png|jpe?g|gif|webp|heic|bmp|tiff|svg)$/i;

export function Composer({
  busy,
  placeholder,
  settings,
  onSettingsChange,
  onSend,
  onCancel,
  usage,
  slashCommands,
  cwd,
}: Props) {
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [permOpen, setPermOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [effortOpen, setEffortOpen] = useState(false);
  const [systemOpen, setSystemOpen] = useState(false);
  const [models, setModels] = useState<ModelOption[]>(MODEL_FALLBACK);
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashIdx, setSlashIdx] = useState(0);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [fileQuery, setFileQuery] = useState<string | null>(null);
  const [fileHits, setFileHits] = useState<FileHit[]>([]);
  const [fileIdx, setFileIdx] = useState(0);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const slashListRef = useRef<HTMLDivElement | null>(null);
  const fileSearchSeq = useRef(0);

  useEffect(() => {
    listModels()
      .then((list) => {
        if (list.length > 0) setModels(list);
      })
      .catch(() => {});
  }, []);

  const canSend = text.trim().length > 0 || attachments.length > 0;

  const slashQuery = useSlashQuery(text);
  const slashResults = useFilteredSlash(slashCommands ?? [], slashQuery);

  // @ file picker trigger
  useEffect(() => {
    const m = text.match(/(^|\s)@([^\s@]*)$/);
    if (!m || !cwd) {
      setFileQuery(null);
      setFileHits([]);
      return;
    }
    const q = m[2];
    setFileQuery(q);
    setFileIdx(0);
    const seq = ++fileSearchSeq.current;
    const t = setTimeout(async () => {
      try {
        const hits = await searchFiles(cwd, q, 30);
        if (seq === fileSearchSeq.current) setFileHits(hits);
      } catch (e) {
        console.error("searchFiles", e);
      }
    }, 120);
    return () => clearTimeout(t);
  }, [text, cwd]);

  const fileOpen = fileQuery !== null && fileHits.length > 0;

  useEffect(() => {
    if (slashQuery !== null && slashResults.length > 0) {
      setSlashOpen(true);
      setSlashIdx(0);
    } else {
      setSlashOpen(false);
    }
  }, [slashQuery, slashResults.length]);

  // Scroll the active slash item into view when navigating with keys.
  useEffect(() => {
    if (!slashOpen) return;
    const list = slashListRef.current;
    if (!list) return;
    const active = list.querySelector(".cd-slash-item.active") as HTMLElement | null;
    if (active) {
      active.scrollIntoView({ block: "nearest" });
    }
  }, [slashIdx, slashOpen]);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) {
        setPermOpen(false);
        setModelOpen(false);
        setEffortOpen(false);
      }
    }
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, []);

  function autoresize() {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 240) + "px";
  }

  useEffect(() => {
    autoresize();
  }, [text]);

  function handleSend() {
    if (busy) {
      onCancel();
      return;
    }
    if (!canSend) return;
    onSend(text, attachments);
    setText("");
    setAttachments([]);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (fileOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setFileIdx((i) => Math.min(fileHits.length - 1, i + 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setFileIdx((i) => Math.max(0, i - 1));
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.metaKey && !e.ctrlKey)) {
        e.preventDefault();
        applyFile(fileHits[fileIdx]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setFileQuery(null);
        return;
      }
    }
    if (slashOpen && slashResults.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashIdx((i) => Math.min(slashResults.length - 1, i + 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashIdx((i) => Math.max(0, i - 1));
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.metaKey && !e.ctrlKey)) {
        e.preventDefault();
        applySlash(slashResults[slashIdx]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setSlashOpen(false);
        return;
      }
    }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSend();
    }
  }

  function applySlash(cmd: string) {
    const replaced = replaceSlashTrigger(text, cmd);
    setText(replaced);
    setSlashOpen(false);
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  function applyFile(hit: FileHit) {
    const replaced = text.replace(
      /(^|\s)@([^\s@]*)$/,
      (_m, lead) => `${lead}@${hit.rel_path} `
    );
    setText(replaced);
    setFileQuery(null);
    setFileHits([]);
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  async function pickFiles() {
    try {
      const picked = await openDialog({
        multiple: true,
        directory: false,
        title: "选择附件",
      });
      if (!picked) return;
      const list = Array.isArray(picked) ? picked : [picked];
      const next = list.map<Attachment>((p) => {
        const name = String(p).split("/").pop() ?? String(p);
        return {
          id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          path: String(p),
          name,
          kind: IMAGE_RE.test(name) ? "image" : "file",
        };
      });
      setAttachments((a) => [...a, ...next]);
    } catch (e) {
      console.error("dialog failed", e);
    }
  }

  async function onPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of Array.from(items)) {
      if (item.kind === "file" && item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (!file) continue;
        e.preventDefault();
        const buf = new Uint8Array(await file.arrayBuffer());
        const ext =
          file.type.split("/")[1] ||
          (file.name.includes(".") ? file.name.split(".").pop()! : "png");
        try {
          const path = await savePasteImage(buf, ext);
          setAttachments((a) => [
            ...a,
            {
              id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
              path,
              name: path.split("/").pop() ?? "image",
              kind: "image",
            },
          ]);
        } catch (err) {
          console.error("savePasteImage", err);
        }
        break;
      }
    }
  }

  async function onDrop(e: React.DragEvent<HTMLDivElement>) {
    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;
    e.preventDefault();
    const next: Attachment[] = [];
    for (const file of Array.from(files)) {
      const path = (file as File & { path?: string }).path;
      if (path) {
        next.push({
          id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          path,
          name: file.name,
          kind: IMAGE_RE.test(file.name) ? "image" : "file",
        });
      } else if (file.type.startsWith("image/")) {
        const buf = new Uint8Array(await file.arrayBuffer());
        const ext = file.type.split("/")[1] || "png";
        try {
          const saved = await savePasteImage(buf, ext);
          next.push({
            id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            path: saved,
            name: file.name,
            kind: "image",
          });
        } catch (err) {
          console.error("savePasteImage drop", err);
        }
      }
    }
    if (next.length) setAttachments((a) => [...a, ...next]);
  }

  function onDragOver(e: React.DragEvent<HTMLDivElement>) {
    if (e.dataTransfer?.types.includes("Files")) {
      e.preventDefault();
    }
  }

  function removeAttachment(id: string) {
    setAttachments((a) => a.filter((x) => x.id !== id));
  }

  return (
    <div className="cd-composer-wrap" ref={wrapRef}>
      {lightbox && <Lightbox path={lightbox} onClose={() => setLightbox(null)} />}
      <div className="cd-composer" onDrop={onDrop} onDragOver={onDragOver}>
        <div className="cd-composer-syshead">
          <button
            className="cd-composer-sys-toggle"
            onClick={() => setSystemOpen((v) => !v)}
            title="附加给 Claude 的系统提示，会通过 --append-system-prompt 传入"
          >
            {systemOpen ? "▾" : "▸"} 系统提示
            {settings.appendSystemPrompt.trim() && (
              <span className="cd-composer-sys-dot" title="已设置" />
            )}
          </button>
        </div>
        {systemOpen && (
          <textarea
            className="cd-composer-sys-input"
            placeholder="可选。这里写的内容会作为 --append-system-prompt 加在默认系统提示之后。"
            value={settings.appendSystemPrompt}
            onChange={(e) =>
              onSettingsChange({
                ...settings,
                appendSystemPrompt: e.target.value,
              })
            }
            rows={3}
          />
        )}

        {attachments.length > 0 && (
          <div className="cd-composer-attachments">
            {attachments.map((a) =>
              a.kind === "image" ? (
                <div key={a.id} className="cd-att-img-wrap" title={a.name}>
                  <LocalImage
                    path={a.path}
                    className="cd-att-img"
                    alt={a.name}
                    onClick={() => setLightbox(a.path)}
                  />
                  <button
                    className="cd-att-img-remove"
                    onClick={(e) => {
                      e.stopPropagation();
                      removeAttachment(a.id);
                    }}
                    title="移除"
                  >
                    ×
                  </button>
                </div>
              ) : (
                <div key={a.id} className="cd-att-chip" title={a.path}>
                  <span className="cd-att-icon">📎</span>
                  <span className="cd-att-name">{a.name}</span>
                  <button
                    className="cd-att-remove"
                    onClick={() => removeAttachment(a.id)}
                  >
                    ×
                  </button>
                </div>
              )
            )}
          </div>
        )}

        <textarea
          ref={inputRef}
          className="cd-composer-input"
          placeholder={placeholder ?? "要求后续变更"}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          rows={1}
        />

        {slashOpen && slashResults.length > 0 && (
          <div className="cd-slash-pop" ref={slashListRef}>
            {slashResults.map((cmd, i) => (
              <button
                key={cmd}
                className={`cd-slash-item ${i === slashIdx ? "active" : ""}`}
                onMouseEnter={() => setSlashIdx(i)}
                onClick={() => applySlash(cmd)}
              >
                <span className="cd-slash-name">/{cmd}</span>
              </button>
            ))}
          </div>
        )}

        {fileOpen && (
          <div className="cd-slash-pop">
            {fileHits.map((hit, i) => (
              <button
                key={hit.abs_path}
                className={`cd-slash-item ${i === fileIdx ? "active" : ""}`}
                onMouseEnter={() => setFileIdx(i)}
                onClick={() => applyFile(hit)}
                title={hit.abs_path}
              >
                <span className="cd-file-icon">📄</span>
                <span className="cd-slash-name">{hit.rel_path}</span>
              </button>
            ))}
          </div>
        )}

        <div className="cd-composer-toolbar">
          <button className="cd-composer-btn" title="附件" onClick={pickFiles}>
            <PlusIcon size={16} />
          </button>

          <div className="cd-pop-wrap">
            <button
              className="cd-perm-btn"
              onClick={() => {
                setPermOpen((v) => !v);
                setModelOpen(false);
              }}
              style={{ color: permissionAccent(settings.permissionMode) }}
            >
              <WarningDot
                size={13}
                style={{ color: permissionAccent(settings.permissionMode) }}
              />
              <span>{permissionLabel(settings.permissionMode)}</span>
              <ChevronDown size={12} />
            </button>
            {permOpen && (
              <div className="cd-pop">
                {PERMISSION_OPTIONS.map((o) => (
                  <button
                    key={o.value}
                    className={`cd-pop-item ${
                      settings.permissionMode === o.value ? "active" : ""
                    }`}
                    onClick={() => {
                      onSettingsChange({ ...settings, permissionMode: o.value });
                      setPermOpen(false);
                    }}
                  >
                    <div className="cd-pop-item-label">{o.label}</div>
                    <div className="cd-pop-item-hint">{o.hint}</div>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="cd-pop-wrap">
            <button
              className="cd-pill"
              onClick={() => {
                setEffortOpen((v) => !v);
                setPermOpen(false);
                setModelOpen(false);
              }}
              title="思考强度（--effort）。off 表示不传该参数。"
            >
              {effortLabel(settings.effort)} <ChevronDown size={12} />
            </button>
            {effortOpen && (
              <div className="cd-pop">
                {EFFORT_OPTIONS.map((o) => (
                  <button
                    key={o.value}
                    className={`cd-pop-item ${
                      settings.effort === o.value ? "active" : ""
                    }`}
                    onClick={() => {
                      onSettingsChange({ ...settings, effort: o.value });
                      setEffortOpen(false);
                    }}
                  >
                    <div className="cd-pop-item-label">{o.label}</div>
                    <div className="cd-pop-item-hint">{o.hint}</div>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="cd-composer-spacer" />

          {usage && <UsageChip usage={usage} />}

          <div className="cd-pop-wrap">
            <button
              className="cd-pill"
              onClick={() => {
                setModelOpen((v) => !v);
                setPermOpen(false);
              }}
            >
              {modelLabel(settings, models)} <ChevronDown size={12} />
            </button>
            {modelOpen && (
              <div className="cd-pop cd-pop-right cd-pop-models">
                {groupModels(models).map((group) => (
                  <div key={group.family}>
                    <div className="cd-pop-group-label">{group.label}</div>
                    {group.items.map((o) => (
                      <button
                        key={o.id}
                        className={`cd-pop-item ${
                          settings.model === o.id ? "active" : ""
                        }`}
                        onClick={() => {
                          onSettingsChange({ ...settings, model: o.id });
                          setModelOpen(false);
                        }}
                      >
                        <div className="cd-pop-item-label">{o.label}</div>
                        <div className="cd-pop-item-hint cd-pop-item-mono">
                          {o.id}
                        </div>
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>

          <button className="cd-composer-btn" title="语音（即将推出）" disabled>
            <MicIcon size={16} />
          </button>
          <button
            className={`cd-send ${!canSend && !busy ? "disabled" : ""} ${
              busy ? "cd-send-cancel" : ""
            }`}
            onClick={handleSend}
            disabled={!canSend && !busy}
            title={busy ? "取消" : "发送 (Cmd+Enter)"}
          >
            {busy ? "■" : <SendIcon size={14} />}
          </button>
        </div>
      </div>
    </div>
  );
}

export function buildPromptWithAttachments(
  text: string,
  attachments: Attachment[]
): string {
  if (attachments.length === 0) return text;
  const lines = attachments.map((a) =>
    a.kind === "image" ? `[Image: ${a.path}]` : `[Attached file: ${a.path}]`
  );
  return [text.trim(), "", ...lines].filter(Boolean).join("\n");
}

const FAMILY_ORDER = ["opus", "sonnet", "haiku", "other"];
const FAMILY_LABEL: Record<string, string> = {
  opus: "Opus  最强推理",
  sonnet: "Sonnet  平衡",
  haiku: "Haiku  快速",
  other: "其他",
};

function groupModels(models: ModelOption[]) {
  const buckets: Record<string, ModelOption[]> = {};
  for (const m of models) {
    const key = FAMILY_ORDER.includes(m.family) ? m.family : "other";
    (buckets[key] ??= []).push(m);
  }
  // Within each family: thinking variants first, then plain alias last
  for (const k of Object.keys(buckets)) {
    buckets[k].sort((a, b) => {
      const aliasOnly = (m: ModelOption) => m.id === m.family;
      if (aliasOnly(a) !== aliasOnly(b)) return aliasOnly(a) ? 1 : -1;
      if (a.thinking !== b.thinking) return a.thinking ? -1 : 1;
      if (a.context_1m !== b.context_1m) return a.context_1m ? -1 : 1;
      return a.id.localeCompare(b.id);
    });
  }
  return FAMILY_ORDER.filter((f) => buckets[f]?.length).map((f) => ({
    family: f,
    label: FAMILY_LABEL[f],
    items: buckets[f],
  }));
}

export { buildModelArg };

function UsageChip({
  usage,
}: {
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    contextWindow: number;
    costUsd: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCacheReadTokens: number;
    totalCacheCreationTokens: number;
    turnCount: number;
  };
}) {
  const used = usage.inputTokens + usage.cacheReadTokens;
  const total = usage.contextWindow;
  const totalIO =
    usage.totalInputTokens +
    usage.totalOutputTokens +
    usage.totalCacheReadTokens +
    usage.totalCacheCreationTokens;
  const hasAny = used > 0 || total > 0 || totalIO > 0 || usage.costUsd > 0;
  if (!hasAny) return null;
  const pct = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;
  const color =
    pct >= 90
      ? "var(--danger)"
      : pct >= 70
      ? "var(--accent)"
      : "var(--text-secondary)";
  const ctxText = total > 0
    ? `${formatTokens(used)} / ${formatTokens(total)}`
    : `${formatTokens(used)}`;
  return (
    <div
      className="cd-usage-chip"
      title={
        `本轮：\n` +
        `  输入 ${usage.inputTokens.toLocaleString()}\n` +
        `  缓存读取 ${usage.cacheReadTokens.toLocaleString()}\n` +
        `  输出 ${usage.outputTokens.toLocaleString()}\n` +
        (total > 0 ? `  上下文窗口 ${total.toLocaleString()}\n` : "") +
        `\n累计 (${usage.turnCount} 轮)：\n` +
        `  输入 ${usage.totalInputTokens.toLocaleString()}\n` +
        `  缓存读取 ${usage.totalCacheReadTokens.toLocaleString()}\n` +
        `  缓存写入 ${usage.totalCacheCreationTokens.toLocaleString()}\n` +
        `  输出 ${usage.totalOutputTokens.toLocaleString()}\n` +
        `  成本 $${usage.costUsd.toFixed(4)}`
      }
    >
      <div
        className="cd-usage-track"
        style={{ background: "var(--bg-button-pill)" }}
      >
        <div
          className="cd-usage-fill"
          style={{ width: `${pct}%`, background: color }}
        />
      </div>
      <span className="cd-usage-text" style={{ color }}>
        {ctxText}
      </span>
      {totalIO > 0 && (
        <span className="cd-usage-sep" aria-hidden>
          ·
        </span>
      )}
      {totalIO > 0 && (
        <span className="cd-usage-total" title="本会话累计 token (输入+输出+缓存)">
          累计 {formatTokens(totalIO)}
        </span>
      )}
      {usage.costUsd > 0 && (
        <span className="cd-usage-cost" title="本会话累计成本 (美元)">
          ${usage.costUsd < 0.01 ? usage.costUsd.toFixed(4) : usage.costUsd.toFixed(2)}
        </span>
      )}
    </div>
  );
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}K`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

// Returns the partial slash query under the cursor (e.g. "cle" for "/cle"),
// or null if not currently in a slash trigger.
function useSlashQuery(text: string): string | null {
  // Match /word at the very start, or /word at start of a line, or after whitespace.
  // Only first occurrence — autocomplete pops on the leading slash you're typing.
  const m = text.match(/(^|\s)\/([A-Za-z0-9_:-]*)$/);
  if (!m) return null;
  return m[2];
}

function useFilteredSlash(all: string[], query: string | null): string[] {
  if (query === null) return [];
  const q = query.toLowerCase();
  if (q.length === 0) return all.slice(0, 30);
  const exact: string[] = [];
  const prefix: string[] = [];
  const fuzzy: string[] = [];
  for (const c of all) {
    const lc = c.toLowerCase();
    if (lc === q) exact.push(c);
    else if (lc.startsWith(q)) prefix.push(c);
    else if (lc.includes(q)) fuzzy.push(c);
  }
  return [...exact, ...prefix, ...fuzzy];
}

function replaceSlashTrigger(text: string, cmd: string): string {
  return text.replace(
    /(^|\s)\/([A-Za-z0-9_:-]*)$/,
    (_m, lead) => `${lead}/${cmd} `
  );
}
