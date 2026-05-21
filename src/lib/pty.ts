import { commands, events } from "./bindings";
import type { UnlistenFn } from "@tauri-apps/api/event";

export type PtyDataPayload = { id: string; data: string };
export type PtyExitPayload = { id: string; code: number | null };

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

function unwrap<T>(
  r: { status: "ok"; data: T } | { status: "error"; error: string }
): T {
  if (r.status === "error") throw new Error(r.error);
  return r.data;
}

export async function spawnPty(opts: {
  command: string;
  args?: string[];
  cwd?: string;
  cols: number;
  rows: number;
}): Promise<string> {
  return unwrap(
    await commands.ptySpawn(
      opts.command,
      opts.args ?? [],
      opts.cwd ?? null,
      opts.cols,
      opts.rows
    )
  );
}

export async function writePtyBytes(id: string, bytes: Uint8Array): Promise<void> {
  unwrap(await commands.ptyWrite(id, b64encode(bytes)));
}

export async function resizePty(id: string, cols: number, rows: number): Promise<void> {
  unwrap(await commands.ptyResize(id, cols, rows));
}

export async function killPty(id: string): Promise<void> {
  unwrap(await commands.ptyKill(id));
}

export async function resolveClaudeBin(): Promise<string | null> {
  return (await commands.resolveClaudeBin()) ?? null;
}

/** Returns the user's HOME directory, or empty string if unavailable. */
export async function getHomeDir(): Promise<string> {
  try {
    return await commands.getHomeDir();
  } catch {
    return "";
  }
}

export async function savePasteImage(
  bytes: Uint8Array,
  ext: string
): Promise<string> {
  return unwrap(await commands.savePasteImage(Array.from(bytes), ext));
}

export async function readImageDataUrl(path: string): Promise<string> {
  return unwrap(await commands.readImageDataUrl(path));
}

export async function onPtyData(
  cb: (id: string, bytes: Uint8Array, text: string) => void
): Promise<UnlistenFn> {
  return await events.ptyDataEvent.listen((event) => {
    const bytes = b64decode(event.payload.data);
    cb(event.payload.id, bytes, dec.decode(bytes));
  });
}

export async function onPtyExit(
  cb: (id: string, code: number | null) => void
): Promise<UnlistenFn> {
  return await events.ptyExitEvent.listen((event) => {
    cb(event.payload.id, event.payload.code);
  });
}
