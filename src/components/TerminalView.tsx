import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import {
  onPtyData,
  onPtyExit,
  resizePty,
  writePtyBytes,
  killPty,
  savePasteImage,
} from "../lib/pty";

type Props = {
  sessionId: string;
  onExit?: () => void;
};

const IMAGE_EXTS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/bmp": "bmp",
  "image/tiff": "tiff",
  "image/svg+xml": "svg",
};

function quotePath(p: string): string {
  if (/[\s'"\\$`]/.test(p)) {
    return `'${p.replace(/'/g, "'\\''")}'`;
  }
  return p;
}

export function TerminalView({ sessionId, onExit }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      cursorBlink: true,
      fontFamily:
        "'JetBrains Mono', Menlo, 'SF Mono', Consolas, 'Liberation Mono', monospace",
      fontSize: 13,
      theme: {
        background: "#0b0d10",
        foreground: "#e6e6e6",
        cursor: "#e6e6e6",
      },
      allowProposedApi: true,
      scrollback: 10000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    fit.fit();

    termRef.current = term;
    fitRef.current = fit;

    const writeText = (text: string) => {
      writePtyBytes(sessionId, new TextEncoder().encode(text)).catch(() => {});
    };

    const onDataDisp = term.onData((data) => writeText(data));

    const onResizeDisp = term.onResize(({ cols, rows }) => {
      resizePty(sessionId, cols, rows).catch(() => {});
    });

    let unlistenData: (() => void) | null = null;
    let unlistenExit: (() => void) | null = null;

    onPtyData((id, bytes) => {
      if (id !== sessionId) return;
      term.write(bytes);
    }).then((u) => (unlistenData = u));

    onPtyExit((id) => {
      if (id !== sessionId) return;
      term.writeln("\r\n\x1b[90m[session ended]\x1b[0m");
      onExit?.();
    }).then((u) => (unlistenExit = u));

    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {}
    });
    ro.observe(containerRef.current);

    const onWindowResize = () => {
      try {
        fit.fit();
      } catch {}
    };
    window.addEventListener("resize", onWindowResize);

    async function handleImageFile(file: File) {
      const buf = new Uint8Array(await file.arrayBuffer());
      const ext =
        IMAGE_EXTS[file.type] ||
        (file.name.includes(".") ? file.name.split(".").pop()! : "png");
      try {
        const path = await savePasteImage(buf, ext);
        writeText(quotePath(path));
        term.write(
          `\r\n\x1b[90m[pasted image → ${path}]\x1b[0m\r\n`
        );
      } catch (e) {
        term.write(`\r\n\x1b[31m[paste failed: ${String(e)}]\x1b[0m\r\n`);
      }
    }

    const onPaste = async (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      let handled = false;
      for (const item of Array.from(items)) {
        if (item.kind === "file" && item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) {
            e.preventDefault();
            handled = true;
            await handleImageFile(file);
            break;
          }
        }
      }
      if (handled) return;
      // Fall through: let xterm handle text paste normally.
    };

    const onDrop = async (e: DragEvent) => {
      const files = e.dataTransfer?.files;
      if (!files || files.length === 0) return;
      e.preventDefault();
      for (const file of Array.from(files)) {
        if (file.type.startsWith("image/")) {
          await handleImageFile(file);
        } else {
          // Non-image: just inject the dropped file's name as a path hint.
          // macOS file drops expose .path via webkit; fall back to name.
          const path = (file as File & { path?: string }).path || file.name;
          writeText(quotePath(path));
        }
      }
    };

    const onDragOver = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes("Files")) {
        e.preventDefault();
      }
    };

    const node = containerRef.current;
    node.addEventListener("paste", onPaste);
    node.addEventListener("drop", onDrop);
    node.addEventListener("dragover", onDragOver);

    return () => {
      ro.disconnect();
      window.removeEventListener("resize", onWindowResize);
      node.removeEventListener("paste", onPaste);
      node.removeEventListener("drop", onDrop);
      node.removeEventListener("dragover", onDragOver);
      onDataDisp.dispose();
      onResizeDisp.dispose();
      unlistenData?.();
      unlistenExit?.();
      term.dispose();
    };
  }, [sessionId]);

  return (
    <div
      ref={containerRef}
      style={{
        position: "absolute",
        inset: 0,
        padding: 8,
        background: "#0b0d10",
      }}
    />
  );
}

export async function endSession(id: string) {
  try {
    await killPty(id);
  } catch {}
}
