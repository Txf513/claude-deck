import { invoke } from "@tauri-apps/api/core";

export type ProjectInfo = {
  name: string;
  path: string;
  folder: string;
  session_count: number;
  last_activity_ms: number;
};

export type SessionInfo = {
  id: string;
  cwd: string | null;
  first_prompt: string | null;
  last_activity: string | null;
  mtime_ms: number;
  message_count: number;
  file_path: string;
};

export async function listProjects(): Promise<ProjectInfo[]> {
  return await invoke<ProjectInfo[]>("list_projects");
}

export async function listSessions(folder: string, limit = 20): Promise<SessionInfo[]> {
  return await invoke<SessionInfo[]>("list_sessions", { folder, limit });
}

export type SearchHit = {
  session_id: string;
  file_path: string;
  project_folder: string;
  project_path: string;
  project_name: string;
  role: "user" | "assistant" | string;
  snippet: string;
  timestamp: string | null;
  mtime_ms: number;
  uuid: string | null;
  entry_kind: string | null;
  tool_name: string | null;
};

export async function searchSessions(query: string, limit = 50): Promise<SearchHit[]> {
  return await invoke<SearchHit[]>("search_sessions", { query, limit });
}

export type FileHit = {
  rel_path: string;
  abs_path: string;
};

export async function searchFiles(
  cwd: string,
  query: string,
  limit = 30
): Promise<FileHit[]> {
  return await invoke<FileHit[]>("search_files", { cwd, query, limit });
}

export async function renameSession(filePath: string, newTitle: string): Promise<void> {
  await invoke("rename_session", { filePath, newTitle });
}

export async function archiveSession(filePath: string): Promise<string> {
  return await invoke<string>("archive_session", { filePath });
}

export async function deleteSession(filePath: string): Promise<void> {
  await invoke("delete_session", { filePath });
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
