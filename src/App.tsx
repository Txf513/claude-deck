import { useEffect, useMemo, useState } from "react";
import { ChatView } from "./components/ChatView";
import {
  buildPromptWithAttachments,
  Composer,
  type Attachment,
  type ComposerSettings,
} from "./components/Composer";
import { ConfigView } from "./components/ConfigView";
import { OutputPanel } from "./components/OutputPanel";
import { SearchOverlay } from "./components/SearchOverlay";
import { Sidebar, type ConvSelection } from "./components/Sidebar";
import { TerminalView, endSession } from "./components/TerminalView";
import { useChats } from "./hooks/useChats";
import { replaySession, replaySessionPaged } from "./lib/claude";
import { getHomeDir, resolveClaudeBin, spawnPty } from "./lib/pty";
import {
  listSessions,
  type ProjectInfo,
  type SearchHit,
  type SessionInfo,
} from "./lib/sessions";
import "./App.css";
import "./theme.css";
import "./chat.css";

type View =
  | { kind: "chat" }
  | { kind: "welcome" }
  | { kind: "config" }
  | { kind: "legacy" };

type LegacyTab = {
  id: string;
  title: string;
  ptyId: string | null;
  status: "starting" | "running" | "exited";
};

type Theme = "light" | "dark";

const THEME_KEY = "cd:theme";
const COMPOSER_KEY = "cd:composer";
const FONT_SCALE_KEY = "cd:font-scale";
const FONT_SCALE_MIN = 0.85;
const FONT_SCALE_MAX = 1.4;
const PAGINATION_THRESHOLD = 1500;

function clampFontScale(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, value));
}

const DEFAULT_COMPOSER: ComposerSettings = {
  permissionMode: "default",
  model: "opus",
  effort: "off",
  appendSystemPrompt: "",
};

function readTheme(): Theme {
  try {
    const v = localStorage.getItem(THEME_KEY);
    if (v === "dark" || v === "light") return v;
  } catch {}
  return "light";
}

function readFontScale(): number {
  try {
    const v = localStorage.getItem(FONT_SCALE_KEY);
    if (v) {
      const n = Number(v);
      if (Number.isFinite(n)) return clampFontScale(n);
    }
  } catch {}
  return 1;
}

function readComposerSettings(): ComposerSettings {
  try {
    const v = localStorage.getItem(COMPOSER_KEY);
    if (v) {
      const parsed = JSON.parse(v) as Partial<ComposerSettings> & {
        thinking?: boolean;
      };
      // Migrate legacy `thinking: true/false` to the new effort field.
      const migrated: Partial<ComposerSettings> = { ...parsed };
      if (parsed.effort === undefined && parsed.thinking !== undefined) {
        migrated.effort = parsed.thinking ? "high" : "off";
      }
      delete (migrated as { thinking?: boolean }).thinking;
      return { ...DEFAULT_COMPOSER, ...migrated };
    }
  } catch {}
  return DEFAULT_COMPOSER;
}

function modelArg(s: ComposerSettings): string {
  // Family alias is enough; reasoning effort is now passed separately as --effort.
  return s.model;
}

export default function App() {
  const [claudeBin, setClaudeBin] = useState<string | null>(null);
  const [view, setView] = useState<View>({ kind: "welcome" });
  const [outputVisible, setOutputVisible] = useState(true);
  const [legacyTabs, setLegacyTabs] = useState<LegacyTab[]>([]);
  const [legacyActiveId, setLegacyActiveId] = useState<string | null>(null);
  const [theme, setTheme] = useState<Theme>(readTheme);
  const [fontScale, setFontScale] = useState<number>(readFontScale);
  const [searchOpen, setSearchOpen] = useState(false);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [composerSettings, setComposerSettings] = useState<ComposerSettings>(
    readComposerSettings
  );
  const currentSendContext = useMemo(() => {
    const trimmedAppend = composerSettings.appendSystemPrompt.trim();
    return {
      claudeBin,
      permissionMode: composerSettings.permissionMode,
      model: modelArg(composerSettings),
      effort:
        composerSettings.effort === "off" ? null : composerSettings.effort,
      appendSystemPrompt: trimmedAppend || null,
    };
  }, [claudeBin, composerSettings]);
  const chats = useChats(undefined, currentSendContext);
  const [homeDir, setHomeDir] = useState<string>("");

  useEffect(() => {
    resolveClaudeBin().then(setClaudeBin);
    getHomeDir().then(setHomeDir);
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {}
  }, [theme]);

  useEffect(() => {
    document.documentElement.style.setProperty(
      "--cd-font-scale",
      String(fontScale)
    );
    try {
      localStorage.setItem(FONT_SCALE_KEY, String(fontScale));
    } catch {}
  }, [fontScale]);

  useEffect(() => {
    try {
      localStorage.setItem(COMPOSER_KEY, JSON.stringify(composerSettings));
    } catch {}
  }, [composerSettings]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const key = e.key.toLowerCase();
      // Ignore shortcuts while typing in inputs/textareas/contenteditable
      const target = e.target as HTMLElement | null;
      const inEditable =
        !!target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable);

      if (key === "k") {
        e.preventDefault();
        setSearchOpen((v) => !v);
        return;
      }
      // ⌘W close current tab — only when in chat view
      if (key === "w" && view.kind === "chat" && chats.active) {
        e.preventDefault();
        chats.closeTab(chats.active.convId);
        return;
      }
      // ⌘N new conversation in active project (or first project)
      if (key === "n" && !inEditable) {
        e.preventDefault();
        const folder = chats.active?.cwd;
        // Best-effort: pick a project whose cwd matches active tab; else None.
        // App holds no projects list; rely on Sidebar's first-project default.
        // We dispatch a synthetic event the Sidebar handles via onNewConv.
        const evt = new CustomEvent("cd:new-conv", { detail: { cwd: folder } });
        window.dispatchEvent(evt);
        return;
      }
      // ⌘1..9 switch to nth tab
      if (/^[1-9]$/.test(key)) {
        const idx = parseInt(key, 10) - 1;
        const list = chats.tabsList;
        if (idx < list.length) {
          e.preventDefault();
          chats.setActive(list[idx].convId);
          setView({ kind: "chat" });
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view.kind, chats.active, chats.tabsList]);

  const activeKey = useMemo(() => {
    if (view.kind !== "chat" || !chats.active) return null;
    if (chats.active.filePath) {
      const folder = chats.active.filePath
        .split("/")
        .slice(-2, -1)[0];
      return `${folder}/${chats.active.sessionId ?? ""}`;
    }
    return `tab:${chats.active.convId}`;
  }, [view, chats.active]);

  async function selectConv(sel: ConvSelection) {
    const convId = `disk:${sel.session.file_path}`;
    const existing = chats.tabs[convId];
    if (existing) {
      chats.setActive(convId);
      setView({ kind: "chat" });
      return;
    }
    chats.openOrCreate({
      convId,
      title: sel.session.first_prompt ?? `会话 ${sel.session.id.slice(0, 6)}`,
      cwd: sel.session.cwd ?? sel.projectPath,
      filePath: sel.session.file_path,
    });
    setView({ kind: "chat" });
    try {
      const isLargeSession = sel.session.message_count > PAGINATION_THRESHOLD;
      if (isLargeSession) {
        const page = await replaySessionPaged(sel.session.file_path, {
          limit: 600,
        });
        chats.loadInitialPage(convId, sel.session.file_path, page);
      } else {
        const replay = await replaySession(sel.session.file_path);
        chats.loadReplay(convId, replay);
      }
    } catch (e) {
      console.error("replay failed", e);
    }
  }

  async function selectByHit(hit: SearchHit) {
    setSearchOpen(false);
    let session: SessionInfo | undefined;
    try {
      const list = await listSessions(hit.project_folder, 200);
      session = list.find((s) => s.id === hit.session_id);
    } catch (e) {
      console.error("listSessions in search jump", e);
    }
    if (!session) {
      session = {
        id: hit.session_id,
        cwd: null,
        first_prompt: hit.snippet,
        last_activity: hit.timestamp,
        mtime_ms: hit.mtime_ms,
        message_count: 0,
        file_path: hit.file_path,
      };
    }
    setHighlightId(hit.uuid ?? null);
    await selectConv({
      projectName: hit.project_name,
      projectPath: hit.project_path,
      session,
    });
  }

  function newConv(project: ProjectInfo) {
    const convId = `new:${project.folder}:${Date.now()}`;
    chats.openOrCreate({
      convId,
      title: `新对话 · ${project.name}`,
      cwd: project.path,
    });
    setView({ kind: "chat" });
  }

  function selectTab(convId: string) {
    chats.setActive(convId);
    setView({ kind: "chat" });
  }

  function openConfig() {
    setView({ kind: "config" });
  }

  function openLegacy() {
    setView({ kind: "legacy" });
  }

  async function newLegacyShell() {
    if (!claudeBin) return;
    const tabId = crypto.randomUUID();
    const tab: LegacyTab = {
      id: tabId,
      title: "claude · home",
      ptyId: null,
      status: "starting",
    };
    setLegacyTabs((p) => [...p, tab]);
    setLegacyActiveId(tabId);
    try {
      const ptyId = await spawnPty({
        command: claudeBin,
        args: [],
        cwd: homeDir || undefined,
        cols: 100,
        rows: 30,
      });
      setLegacyTabs((p) =>
        p.map((t) =>
          t.id === tabId ? { ...t, ptyId, status: "running" } : t
        )
      );
    } catch {
      setLegacyTabs((p) =>
        p.map((t) => (t.id === tabId ? { ...t, status: "exited" } : t))
      );
    }
  }

  async function closeLegacyTab(id: string) {
    const tab = legacyTabs.find((t) => t.id === id);
    if (tab?.ptyId) await endSession(tab.ptyId);
    setLegacyTabs((p) => p.filter((t) => t.id !== id));
    if (legacyActiveId === id) {
      const remaining = legacyTabs.filter((t) => t.id !== id);
      setLegacyActiveId(remaining.length ? remaining[remaining.length - 1].id : null);
    }
  }

  const subtitle = useMemo(() => {
    const tab = chats.active;
    if (!tab) return undefined;
    const parts = [tab.cwd];
    if (tab.sessionId) parts.push(`session ${tab.sessionId.slice(0, 8)}`);
    return parts.join("  ·  ");
  }, [chats.active]);

  const tab = chats.active;
  const busy = !!tab && (tab.status === "thinking" || tab.status === "streaming");
  const replayLoadState = tab?.replayState
    ? {
        hasMoreBefore: tab.replayState.hasMoreBefore,
        loadingBefore: tab.replayState.loadingBefore,
        remaining: Math.max(
          0,
          tab.replayState.totalMessageCount - tab.messages.length
        ),
      }
    : undefined;

  return (
    <div className="cd-root">
      <Sidebar
        activeKey={activeKey}
        theme={theme}
        onThemeChange={setTheme}
        onSelectConv={selectConv}
        onSelectTab={selectTab}
        onCloseTab={chats.closeTab}
        onNewConv={newConv}
        onOpenLegacyTerminal={openLegacy}
        onOpenConfig={openConfig}
        onOpenSearch={() => setSearchOpen(true)}
        openTabs={chats.tabsList}
      />

      {view.kind === "chat" && tab && (
        <main className="cd-main">
          <ChatView
            title={tab.title}
            subtitle={subtitle}
            messages={tab.messages}
            status={tab.status}
            error={tab.error}
            stderr={tab.stderr}
            exitCode={tab.lastExitCode}
            highlightId={highlightId}
            onHighlightConsumed={() => setHighlightId(null)}
            onRetry={() => chats.retryLast(tab.convId)}
            canRetry={chats.hasUserMessage(tab.convId)}
            onLoadEarlier={() => chats.loadEarlier(tab.convId)}
            replayLoadState={replayLoadState}
          />
          <Composer
            busy={busy}
            placeholder={tab.sessionId ? "继续对话…" : "向 Claude 提问…"}
            settings={composerSettings}
            onSettingsChange={setComposerSettings}
            extraDirs={tab.extraDirs ?? []}
            onExtraDirsChange={(next) => chats.setExtraDirs(tab.convId, next)}
            usage={tab.usage}
            slashCommands={tab.slashCommands}
            cwd={tab.cwd}
            onSend={(text, attachments: Attachment[]) => {
              if (!claudeBin) return;
              const fullPrompt = buildPromptWithAttachments(text, attachments);
              chats.send(tab.convId, fullPrompt, claudeBin, {
                permissionMode: currentSendContext.permissionMode,
                model: currentSendContext.model,
                effort: currentSendContext.effort,
                appendSystemPrompt: currentSendContext.appendSystemPrompt,
              });
            }}
            onCancel={() => chats.cancel(tab.convId)}
          />
        </main>
      )}

      {(view.kind === "welcome" || (view.kind === "chat" && !tab)) && (
        <main className="cd-main">
          <div className="cd-chat-empty" style={{ marginTop: 120 }}>
            <div className="cd-chat-empty-title">Claude Deck</div>
            <div className="cd-chat-empty-desc">
              从左侧选择项目下的历史会话，按 <strong>⌘K</strong> 搜索全部内容，
              或点项目右边 <strong>+</strong> 在该目录起一段新对话。
              {!claudeBin && (
                <>
                  <br />
                  <br />
                  <span style={{ color: "var(--warning)" }}>
                    未检测到 claude CLI。
                  </span>
                </>
              )}
            </div>
          </div>
        </main>
      )}

      {view.kind === "config" && (
        <main className="cd-main">
          <ConfigView
            fontScale={fontScale}
            onFontScaleChange={(value) => setFontScale(clampFontScale(value))}
            fontScaleMin={FONT_SCALE_MIN}
            fontScaleMax={FONT_SCALE_MAX}
          />
        </main>
      )}

      {view.kind === "legacy" && (
        <main className="cd-main cd-main-legacy">
          <div className="cd-legacy-bar">
            <button className="cd-foot-btn" onClick={newLegacyShell} disabled={!claudeBin}>
              + claude (home)
            </button>
            <div style={{ flex: 1 }} />
            {legacyTabs.map((t) => (
              <button
                key={t.id}
                className={`cd-foot-btn ${legacyActiveId === t.id ? "active" : ""}`}
                onClick={() => setLegacyActiveId(t.id)}
              >
                {t.title}
                <span
                  onClick={(e) => {
                    e.stopPropagation();
                    closeLegacyTab(t.id);
                  }}
                  style={{ marginLeft: 6 }}
                >
                  ×
                </span>
              </button>
            ))}
          </div>
          <div className="cd-legacy-host">
            {(() => {
              const t = legacyTabs.find((x) => x.id === legacyActiveId);
              if (t && t.ptyId)
                return (
                  <TerminalView
                    key={t.ptyId}
                    sessionId={t.ptyId}
                    onExit={() => {
                      setLegacyTabs((prev) =>
                        prev.map((x) =>
                          x.id === t.id ? { ...x, status: "exited" } : x
                        )
                      );
                    }}
                  />
                );
              return (
                <div className="cd-chat-empty">
                  <div className="cd-chat-empty-title">终端模式</div>
                  <div className="cd-chat-empty-desc">
                    点上方 + claude 开一个直连 Claude Code CLI 的终端会话作为兜底。
                  </div>
                </div>
              );
            })()}
          </div>
        </main>
      )}

      <OutputPanel
        visible={outputVisible && view.kind === "chat" && !!tab}
        messages={tab ? tab.messages : []}
        status={tab?.status ?? "idle"}
        error={tab?.error ?? null}
        stderr={tab?.stderr ?? []}
        usage={
          tab?.usage ?? {
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
          }
        }
        onToggleTerminal={() => setOutputVisible((v) => !v)}
      />

      <SearchOverlay
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        onPick={selectByHit}
      />
    </div>
  );
}
