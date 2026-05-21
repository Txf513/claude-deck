import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { useEffect, useMemo, useState } from "react";
import {
  AutomationIcon,
  ChevronDown,
  ChevronRight,
  ClockIcon,
  FolderIcon,
  GearIcon,
  NewChatIcon,
  PluginIcon,
  SearchIcon,
} from "./Icons";
import {
  archiveSession,
  backupDefaultName,
  deleteSession,
  exportAllProjects,
  exportProject,
  formatRelative,
  importBackup,
  listProjects,
  listSessions,
  renameSession,
  shortLabel,
  type ProjectInfo,
  type SessionInfo,
} from "../lib/sessions";
import type { ChatTab } from "../hooks/useChats";

export type ConvSelection = {
  projectName: string;
  projectPath: string;
  session: SessionInfo;
};

type Props = {
  activeKey: string | null;
  theme: "light" | "dark";
  onThemeChange: (t: "light" | "dark") => void;
  onSelectConv: (sel: ConvSelection) => void;
  onSelectTab: (convId: string) => void;
  onCloseTab: (convId: string) => void;
  onNewConv: (project: ProjectInfo) => void;
  onOpenLegacyTerminal: () => void;
  onOpenConfig: () => void;
  onOpenSearch: () => void;
  openTabs: ChatTab[];
};

export function Sidebar({
  activeKey,
  theme,
  onThemeChange,
  onSelectConv,
  onSelectTab,
  onCloseTab,
  onNewConv,
  onOpenLegacyTerminal,
  onOpenConfig,
  onOpenSearch,
  openTabs,
}: Props) {
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [openProjects, setOpenProjects] = useState<Record<string, boolean>>({});
  const [sessionsByFolder, setSessionsByFolder] = useState<
    Record<string, SessionInfo[]>
  >({});
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    session: SessionInfo;
  } | null>(null);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [backupOpen, setBackupOpen] = useState(false);
  const [backupBusy, setBackupBusy] = useState(false);
  const [backupError, setBackupError] = useState<string | null>(null);
  const [backupStatus, setBackupStatus] = useState<string | null>(null);

  const activeProjectFolder = useMemo(() => {
    if (!activeKey) return null;
    if (activeKey.startsWith("tab:")) {
      const convId = activeKey.slice(4);
      const tab = openTabs.find((item) => item.convId === convId);
      if (!tab) return null;
      if (tab.filePath) {
        return tab.filePath.split("/").slice(-2, -1)[0] ?? null;
      }
      return projects.find((project) => project.path === tab.cwd)?.folder ?? null;
    }
    return activeKey.split("/", 1)[0] ?? null;
  }, [activeKey, openTabs, projects]);

  const activeProjectName =
    projects.find((project) => project.folder === activeProjectFolder)?.name ??
    null;

  useEffect(() => {
    if (!menu) return;
    function close() {
      setMenu(null);
    }
    window.addEventListener("click", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [menu]);

  useEffect(() => {
    if (!backupOpen) return;
    function close() {
      if (!backupBusy) setBackupOpen(false);
    }
    window.addEventListener("click", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [backupBusy, backupOpen]);

  useEffect(() => {
    if (!backupStatus) return;
    const timer = window.setTimeout(() => setBackupStatus(null), 3000);
    return () => window.clearTimeout(timer);
  }, [backupStatus]);

  function reloadFolder(folder: string) {
    listSessions(folder, 30)
      .then((ss) => setSessionsByFolder((p) => ({ ...p, [folder]: ss })))
      .catch((e) => console.error("listSessions reload", e));
  }

  async function commitRename(filePath: string, newTitle: string) {
    setRenamingPath(null);
    try {
      await renameSession(filePath, newTitle);
      // refresh whichever folder this session lives under
      for (const [folder, list] of Object.entries(sessionsByFolder)) {
        if (list.some((s) => s.file_path === filePath)) {
          reloadFolder(folder);
        }
      }
    } catch (e) {
      console.error("rename failed", e);
    }
  }

  async function doArchive(s: SessionInfo) {
    if (!confirm(`归档对话?\n${shortLabel(s)}\n\n会移到 ~/.claude/claude-deck-archive/`)) return;
    try {
      await archiveSession(s.file_path);
      onCloseTab(`disk:${s.file_path}`);
      for (const [folder, list] of Object.entries(sessionsByFolder)) {
        if (list.some((x) => x.file_path === s.file_path)) reloadFolder(folder);
      }
    } catch (e) {
      console.error("archive failed", e);
      alert(`归档失败: ${e}`);
    }
  }

  async function doDelete(s: SessionInfo) {
    if (!confirm(`删除对话?\n${shortLabel(s)}\n\n此操作不可撤销。`)) return;
    try {
      await deleteSession(s.file_path);
      onCloseTab(`disk:${s.file_path}`);
      for (const [folder, list] of Object.entries(sessionsByFolder)) {
        if (list.some((x) => x.file_path === s.file_path)) reloadFolder(folder);
      }
    } catch (e) {
      console.error("delete failed", e);
      alert(`删除失败: ${e}`);
    }
  }

  async function pickSavePath(scope: "all" | string) {
    const path = await saveDialog({
      defaultPath: backupDefaultName(scope),
      filters: [{ name: "tarball", extensions: ["tar.gz"] }],
    });
    if (!path || Array.isArray(path)) return null;
    return path;
  }

  async function runBackup(scope: "all" | "project") {
    const folder = activeProjectFolder;
    if (scope === "project" && !folder) {
      setBackupError("先选中项目");
      return;
    }

    setBackupError(null);
    setBackupStatus(null);
    const path = await pickSavePath(scope === "all" ? "all" : folder!);
    if (!path) return;

    try {
      setBackupBusy(true);
      const result =
        scope === "all"
          ? await exportAllProjects(path)
          : await exportProject(folder!, path);
      setBackupStatus(
        `已备份 ${result.project_count} 个项目 / ${result.session_count} 个会话 → ${result.path}`
      );
    } catch (error) {
      console.error("backup failed", error);
      setBackupError(error instanceof Error ? error.message : String(error));
    } finally {
      setBackupBusy(false);
    }
  }

  async function runRestore() {
    setBackupError(null);
    setBackupStatus(null);

    const selected = await openDialog({
      multiple: false,
      directory: false,
      filters: [{ name: "tarball", extensions: ["tar.gz", "tgz"] }],
      title: "选择备份文件",
    });
    if (!selected || Array.isArray(selected)) return;

    const archivePath = String(selected);
    if (
      !window.confirm(
        `将从 ${archivePath} 还原会话到 ~/.claude/projects/。已存在的同名会话将被跳过。是否继续？`
      )
    ) {
      return;
    }

    try {
      setBackupBusy(true);
      const result = await importBackup(archivePath);
      setBackupStatus(
        `已导入 ${result.project_count} 个项目 / ${result.imported_session_count} 个会话（跳过 ${result.skipped_session_count} 个；标题：新增 ${result.titles_added}、保留 ${result.titles_kept}）`
      );
      await refresh();
    } catch (error) {
      console.error("restore failed", error);
      setBackupError(error instanceof Error ? error.message : String(error));
    } finally {
      setBackupBusy(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  // Global ⌘N hook: create new conv in matching project (by cwd) or first.
  useEffect(() => {
    function onNewConvEvent(e: Event) {
      const detail = (e as CustomEvent<{ cwd?: string }>).detail || {};
      if (projects.length === 0) return;
      const match = detail.cwd
        ? projects.find((p) => p.path === detail.cwd)
        : null;
      onNewConv(match ?? projects[0]);
    }
    window.addEventListener("cd:new-conv", onNewConvEvent);
    return () => window.removeEventListener("cd:new-conv", onNewConvEvent);
  }, [projects, onNewConv]);

  async function refresh() {
    try {
      const list = await listProjects();
      setProjects(list);
      setOpenProjects((prev) => {
        const next = { ...prev };
        if (list[0] && next[list[0].folder] === undefined) {
          next[list[0].folder] = true;
        }
        return next;
      });
      if (list[0] && !sessionsByFolder[list[0].folder]) {
        const ss = await listSessions(list[0].folder, 30);
        setSessionsByFolder((p) => ({ ...p, [list[0].folder]: ss }));
      }
    } catch (e) {
      console.error("listProjects", e);
    }
  }

  async function toggle(folder: string) {
    const open = !openProjects[folder];
    setOpenProjects((p) => ({ ...p, [folder]: open }));
    if (open && !sessionsByFolder[folder]) {
      try {
        const ss = await listSessions(folder, 30);
        setSessionsByFolder((p) => ({ ...p, [folder]: ss }));
      } catch (e) {
        console.error("listSessions", e);
      }
    }
  }

  return (
    <aside className="cd-sidebar">
      <div className="cd-sidebar-top">
        <button
          className="cd-nav-item"
          onClick={() => projects[0] && onNewConv(projects[0])}
        >
          <span className="cd-nav-icon">
            <NewChatIcon />
          </span>
          <span className="cd-nav-label">新对话</span>
        </button>
        <button className="cd-nav-item" onClick={onOpenSearch}>
          <span className="cd-nav-icon">
            <SearchIcon />
          </span>
          <span className="cd-nav-label">搜索</span>
          <span className="cd-nav-badge">⌘K</span>
        </button>
        <button className="cd-nav-item" onClick={onOpenConfig}>
          <span className="cd-nav-icon">
            <PluginIcon />
          </span>
          <span className="cd-nav-label">插件 / Skills</span>
        </button>
        <button className="cd-nav-item" disabled title="即将推出">
          <span className="cd-nav-icon">
            <AutomationIcon />
          </span>
          <span className="cd-nav-label">自动化</span>
        </button>
      </div>

      <div className="cd-section-label cd-section-label-with-action">
        项目
        <button className="cd-section-action" onClick={refresh} title="刷新项目列表">
          ↻
        </button>
      </div>
      <div className="cd-projects">
        {projects.map((p) => {
          const open = !!openProjects[p.folder];
          const sessions = sessionsByFolder[p.folder] ?? [];
          return (
            <div className="cd-project-group" key={p.folder}>
              <div className="cd-project-row-wrap">
                <button className="cd-project-row" onClick={() => toggle(p.folder)}>
                  <span className="cd-project-chevron">
                    {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  </span>
                  <FolderIcon size={15} />
                  <span className="cd-project-name">{p.name}</span>
                </button>
                <button
                  className="cd-project-add"
                  onClick={() => onNewConv(p)}
                  title="在此项目新建对话"
                >
                  +
                </button>
              </div>
              {open && (
                <div className="cd-conv-list">
                  {sessions.length === 0 && (
                    <div className="cd-conv-empty">暂无历史会话</div>
                  )}
                  {sessions.map((s) => {
                    const key = `${p.folder}/${s.id}`;
                    const tab = openTabs.find(
                      (t) => t.filePath === s.file_path
                    );
                    const isRenaming = renamingPath === s.file_path;
                    return (
                      <div
                        key={s.id}
                        className={`cd-conv-item ${
                          activeKey === key ? "active" : ""
                        }`}
                        onClick={() => {
                          if (isRenaming) return;
                          onSelectConv({
                            projectName: p.name,
                            projectPath: p.path,
                            session: s,
                          });
                        }}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          setMenu({
                            x: e.clientX,
                            y: e.clientY,
                            session: s,
                          });
                        }}
                        title={s.first_prompt ?? s.id}
                      >
                        <ConvStatusIcon tab={tab} />
                        {isRenaming ? (
                          <input
                            className="cd-conv-rename"
                            autoFocus
                            defaultValue={shortLabel(s)}
                            onClick={(e) => e.stopPropagation()}
                            onBlur={(e) => commitRename(s.file_path, e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                e.preventDefault();
                                commitRename(s.file_path, e.currentTarget.value);
                              } else if (e.key === "Escape") {
                                setRenamingPath(null);
                              }
                            }}
                          />
                        ) : (
                          <>
                            <span className="cd-conv-title">{shortLabel(s)}</span>
                            <span className="cd-conv-meta">
                              {formatRelative(s.mtime_ms)}
                            </span>
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
        {projects.length === 0 && (
          <div className="cd-conv-empty" style={{ padding: "8px 14px" }}>
            ~/.claude/projects/ 暂无项目
          </div>
        )}
      </div>

      {openTabs.length > 0 && (
        <>
          <div className="cd-section-label cd-section-label-spaced">活跃对话</div>
          <div className="cd-conv-list cd-conv-list-flush">
            {openTabs.map((tab) => (
              <div
                key={tab.convId}
                className={`cd-conv-item ${
                  activeKey === `tab:${tab.convId}` ? "active" : ""
                }`}
                onClick={() => onSelectTab(tab.convId)}
              >
                <ConvStatusIcon tab={tab} />
                <span className="cd-conv-title">{tab.title}</span>
                <button
                  className="cd-conv-close"
                  onClick={(e) => {
                    e.stopPropagation();
                    onCloseTab(tab.convId);
                  }}
                  title="关闭"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        </>
      )}

      <div className="cd-sidebar-footer">
        <div className="cd-theme-toggle">
          <button
            className={theme === "light" ? "active" : ""}
            onClick={() => onThemeChange("light")}
          >
            ☀ 浅色
          </button>
          <button
            className={theme === "dark" ? "active" : ""}
            onClick={() => onThemeChange("dark")}
          >
            ☾ 深色
          </button>
        </div>
        <div className="cd-pop-wrap">
          <button
            className="cd-foot-btn"
            disabled={backupBusy}
            onClick={(e) => {
              e.stopPropagation();
              setBackupOpen((open) => !open);
              setBackupError(null);
            }}
          >
            <span style={{ fontSize: 14 }}>{backupBusy ? "…" : "⤓"}</span>
            {backupBusy ? "处理中…" : "备份"}
          </button>
          {backupOpen && (
            <div
              className="cd-pop cd-pop-right"
              style={{ minWidth: 320, padding: 8, gap: 6 }}
              onClick={(e) => e.stopPropagation()}
            >
              {backupStatus && (
                <div
                  className="cd-pop-item-hint"
                  style={{ padding: "4px 6px", whiteSpace: "normal" }}
                >
                  {backupStatus}
                </div>
              )}
              {backupError && (
                <div
                  className="cd-pop-item-hint"
                  style={{
                    padding: "4px 6px",
                    whiteSpace: "normal",
                    color: "var(--danger)",
                  }}
                >
                  {backupError}
                </div>
              )}
              <button
                className="cd-pop-item"
                disabled={backupBusy}
                onClick={() => runBackup("all")}
              >
                <div className="cd-pop-item-label">备份所有项目…</div>
                <div className="cd-pop-item-hint">导出全部项目会话和自定义标题</div>
              </button>
              <button
                className="cd-pop-item"
                disabled={backupBusy || !activeProjectFolder}
                title={activeProjectFolder ? undefined : "先选中项目"}
                onClick={() => runBackup("project")}
              >
                <div className="cd-pop-item-label">备份当前项目…</div>
                <div className="cd-pop-item-hint">
                  {activeProjectName
                    ? `当前项目：${activeProjectName}`
                    : "先选中项目"}
                </div>
              </button>
              <div
                aria-hidden
                style={{
                  borderTop: "1px solid var(--border)",
                  margin: "4px 0",
                }}
              />
              <button
                className="cd-pop-item"
                disabled={backupBusy}
                onClick={runRestore}
              >
                <div className="cd-pop-item-label">从备份恢复…</div>
                <div className="cd-pop-item-hint">
                  跳过已存在的会话；自定义标题不覆盖现有
                </div>
              </button>
            </div>
          )}
        </div>
        <button className="cd-foot-btn" onClick={onOpenLegacyTerminal}>
          <span style={{ fontSize: 14 }}>▦</span> 终端模式
        </button>
        <button className="cd-foot-btn" onClick={onOpenConfig}>
          <GearIcon size={16} /> 设置
        </button>
      </div>

      {menu && (
        <div
          className="cd-ctxmenu"
          style={{ left: menu.x, top: menu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            className="cd-ctxmenu-item"
            onClick={() => {
              setRenamingPath(menu.session.file_path);
              setMenu(null);
            }}
          >
            ✎ 重命名
          </button>
          <button
            className="cd-ctxmenu-item"
            onClick={() => {
              const s = menu.session;
              setMenu(null);
              doArchive(s);
            }}
          >
            📦 归档
          </button>
          <button
            className="cd-ctxmenu-item cd-ctxmenu-danger"
            onClick={() => {
              const s = menu.session;
              setMenu(null);
              doDelete(s);
            }}
          >
            🗑 删除
          </button>
        </div>
      )}
    </aside>
  );
}

function ConvStatusIcon({ tab }: { tab: ChatTab | undefined }) {
  if (!tab) {
    return (
      <span className="cd-conv-icon">
        <ClockIcon size={13} />
      </span>
    );
  }
  if (tab.status === "thinking" || tab.status === "streaming") {
    return <span className="cd-conv-spinner" title="后台运行中" />;
  }
  if (tab.unread) {
    return <span className="cd-conv-dot" title="有新回复" />;
  }
  return (
    <span className="cd-conv-icon">
      <ClockIcon size={13} />
    </span>
  );
}
