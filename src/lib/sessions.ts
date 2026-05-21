import {
  commands,
  type ProjectInfo as BProject,
  type SessionInfo as BSession,
  type SearchHit as BSearchHit,
  type FileHit as BFileHit,
  type ExportResult as BExportResult,
  type ImportResult as BImportResult,
} from "./bindings";

export type ProjectInfo = BProject;
export type SessionInfo = BSession;
export type SearchHit = BSearchHit;
export type FileHit = BFileHit;
export type ExportResult = BExportResult;
export type ImportResult = BImportResult;

function unwrap<T>(
  r: { status: "ok"; data: T } | { status: "error"; error: string }
): T {
  if (r.status === "error") throw new Error(r.error);
  return r.data;
}

export async function listProjects(): Promise<ProjectInfo[]> {
  return await commands.listProjects();
}

export async function listSessions(folder: string, limit = 20): Promise<SessionInfo[]> {
  return await commands.listSessions(folder, limit);
}

export async function searchSessions(query: string, limit = 50): Promise<SearchHit[]> {
  return await commands.searchSessions(query, limit);
}

export async function searchFiles(
  cwd: string,
  query: string,
  limit = 30
): Promise<FileHit[]> {
  return unwrap(await commands.searchFiles(cwd, query, limit));
}

export async function renameSession(filePath: string, newTitle: string): Promise<void> {
  unwrap(await commands.renameSession(filePath, newTitle));
}

export async function archiveSession(filePath: string): Promise<string> {
  return unwrap(await commands.archiveSession(filePath));
}

export async function deleteSession(filePath: string): Promise<void> {
  unwrap(await commands.deleteSession(filePath));
}

export async function exportAllProjects(outPath: string): Promise<ExportResult> {
  return unwrap(await commands.exportAllProjects(outPath));
}

export async function exportProject(
  folder: string,
  outPath: string
): Promise<ExportResult> {
  return unwrap(await commands.exportProject(folder, outPath));
}

export async function importBackup(archivePath: string): Promise<ImportResult> {
  return unwrap(await commands.importBackup(archivePath));
}

export function backupDefaultName(scope: "all" | string, now: Date = new Date()): string {
  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const hh = String(now.getHours()).padStart(2, "0");
  const min = String(now.getMinutes()).padStart(2, "0");
  const safeScope =
    scope === "all" ? "all" : scope.replace(/[^A-Za-z0-9._-]/g, "_");
  return `claude-deck-backup-${safeScope}-${yyyy}${mm}${dd}-${hh}${min}.tar.gz`;
}

export function shortLabel(s: SessionInfo): string {
  if (s.first_prompt && s.first_prompt.length > 0) return s.first_prompt;
  return `会话 ${s.id.slice(0, 6)}`;
}

export function formatRelative(ms: number): string {
  if (!ms) return "";
  const diff = Date.now() - ms;
  const min = 60_000;
  const hr = 60 * min;
  const day = 24 * hr;
  if (diff < min) return "just now";
  if (diff < hr) return `${Math.floor(diff / min)}m ago`;
  if (diff < day) return `${Math.floor(diff / hr)}h ago`;
  if (diff < 30 * day) return `${Math.floor(diff / day)}d ago`;
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}
