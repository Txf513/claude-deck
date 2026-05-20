import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type PtyDataPayload = { id: string; data: string };
export type PtyExitPayload = { id: string; code: number | null };

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64encode(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function b64decode(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export async function spawnPty(opts: {
  command: string;
  args?: string[];
  cwd?: string;
  cols: number;
  rows: number;
}): Promise<string> {
  return await invoke<string>("pty_spawn", {
    command: opts.command,
    args: opts.args ?? [],
    cwd: opts.cwd ?? null,
    cols: opts.cols,
    rows: opts.rows,
  });
}

export async function writePty(id: string, text: string): Promise<void> {
  const data = b64encode(enc.encode(text));
  await invoke("pty_write", { id, data });
}

export async function writePtyBytes(id: string, bytes: Uint8Array): Promise<void> {
  await invoke("pty_write", { id, data: b64encode(bytes) });
}

export async function resizePty(id: string, cols: number, rows: number): Promise<void> {
  await invoke("pty_resize", { id, cols, rows });
}

export async function killPty(id: string): Promise<void> {
  await invoke("pty_kill", { id });
}

export async function resolveClaudeBin(): Promise<string | null> {
  return (await invoke<string | null>("resolve_claude_bin")) ?? null;
}

export async function savePasteImage(
  bytes: Uint8Array,
  ext: string
): Promise<string> {
  return await invoke<string>("save_paste_image", {
    bytes: Array.from(bytes),
    ext,
  });
}

export async function readImageDataUrl(path: string): Promise<string> {
  return await invoke<string>("read_image_data_url", { path });
}

export async function onPtyData(
  cb: (id: string, bytes: Uint8Array, text: string) => void
): Promise<UnlistenFn> {
  return await listen<PtyDataPayload>("pty:data", (event) => {
    const bytes = b64decode(event.payload.data);
    cb(event.payload.id, bytes, dec.decode(bytes));
  });
}

export async function onPtyExit(
  cb: (id: string, code: number | null) => void
): Promise<UnlistenFn> {
  return await listen<PtyExitPayload>("pty:exit", (event) => {
    cb(event.payload.id, event.payload.code);
  });
}
