# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## What this app is

Codex Deck is a Tauri 2 desktop GUI wrapper around the local `Codex` CLI. It reads on-disk session history from `~/.Codex/projects/<folder>/*.jsonl`, lets the user resume or start conversations, streams replies by spawning the CLI as a subprocess, and exposes a fallback xterm.js terminal that runs the CLI directly.

Frontend is React 19 + Vite + TypeScript in `src/`. Backend is Rust in `src-tauri/`. Package manager is **pnpm**.

## Commands

- `pnpm tauri dev` — full app with HMR. **This is the dev command** (it boots Vite on port 1420 and the Rust shell). Plain `pnpm dev` only starts Vite, which is rarely what you want — Tauri APIs won't resolve in a browser.
- `pnpm build` — type-check + frontend bundle (`tsc && vite build`). Useful for catching TS errors without rebuilding Rust.
- `pnpm tauri build` — production `.app` bundle.
- Rust-only iteration: `cargo check` / `cargo build` from `src-tauri/`.

There is no test runner, linter, or formatter configured. Don't invent commands; if you need them, ask first.

## Architecture

### Two-process model

The Rust side (`src-tauri/src/lib.rs`) registers Tauri commands and emits events; the React side calls them via `invoke()` and subscribes via `listen()`. All cross-process traffic goes through these handlers — there is no HTTP server, no IPC channel besides Tauri events.

Registered command groups (see `lib.rs:13-40`):

- `pty::*` — xterm.js-backed PTY sessions for the "legacy terminal" view.
- `Codex::*` — non-interactive `Codex -p` subprocess for the structured chat view.
- `sessions::*` — read/search/rename/archive `.jsonl` session files under `~/.Codex/projects/`.
- `config::*` — read/write `~/.Codex/settings.json` and `settings.local.json`, enumerate skills/plugins/models, save pasted images.

### The chat streaming flow (most important part)

This is the system's main feature; understand it before changing chat behavior.

1. **User sends.** `useChats.send()` (`src/hooks/useChats.ts`) generates a `request_id`, wraps the prompt with attachments, and calls `claudeSend()`.
2. **Rust spawns CLI.** `Codex::claude_send` (`src-tauri/src/Codex.rs:96`) runs `Codex -p <prompt> --output-format stream-json --include-partial-messages --verbose` with `--resume <session_id>` if the conversation has one, plus `--model`, `--permission-mode`, optional `--dangerously-skip-permissions`. Stdin is `null`, stdout/stderr are piped.
3. **Lines stream back as Tauri events.** Stdout lines fire `Codex:event` (one JSON object per line). Stderr fires `Codex:stderr`. Exit fires `Codex:done` with the request_id and exit code.
4. **Frontend parses each line.** `parseStreamLine()` in `src/lib/Codex.ts` decodes the stream-json envelope; `useChats` updates the active conversation's messages, tool calls, usage stats, and detected `sessionId`.
5. **Cancellation.** `claude_cancel(request_id)` looks up a `oneshot::Sender` in `ClaudeState.inflight` and triggers `child.start_kill()`.

If you change the CLI argv, **also** update the parser — they are coupled.

Event channel names emitted from Rust live as `pub const EVENT_*` in `src-tauri/src/Codex.rs` and are mirrored by `EVENT_*` exports in `src/lib/Codex.ts`. Always use the constants on both sides — never inline the string literals.

### Sessions on disk

`sessions::*` treats `~/.Codex/projects/<folder>/*.jsonl` as the source of truth for history. The folder name encodes the cwd (leading `-` becomes `/`, other `-` become `/`; see `folder_to_path` in `sessions.rs`). The frontend opens a session by reading its file path; resuming sends the session id to the CLI as `--resume` and lets the CLI itself append to the same `.jsonl`.

`replay_session` reconstructs the message list and usage totals from the file so the UI can render history without a live process.

### PATH discovery

`augmented_path()` and `resolve_claude_bin()` live in `src-tauri/src/path_util.rs` and are shared by `pty.rs` and `Codex.rs`. They prepend `/opt/homebrew/bin`, `/usr/local/bin`, `~/.cargo/bin`, and the latest `~/.nvm/versions/node/*/bin` so the GUI can find `Codex` even when it launches without the user's shell rc loaded.

### Frontend shell

`App.tsx` is a single-component view router with four modes: `welcome`, `chat`, `config`, `legacy` (xterm). State of all open chats lives in `useChats` and is keyed by `convId` (`disk:<file_path>` for resumed sessions, `new:<folder>:<ts>` for fresh ones). The `Sidebar` lists projects/sessions; `ChatView` renders messages; `Composer` sends; `OutputPanel` shows raw events; `SearchOverlay` is ⌘K.

### UI text

The user-facing strings are in Simplified Chinese. Keep new copy consistent with the existing tone (see `App.tsx`, `Composer.tsx`, `Sidebar.tsx`).

## Conventions worth knowing

- **Tauri capabilities** (`src-tauri/capabilities/default.json`) only grant `opener` + `dialog`. New plugins or commands need a permission entry there or they'll silently fail at runtime.
- **Asset protocol scope** (`tauri.conf.json`) is limited to `$HOME/**`, `/private/tmp/**`, `/tmp/**` — pasted images are saved under one of these so `<LocalImage>` can load them via `convertFileSrc`.
- The Rust crate is named `Codex-deck`, the lib `claude_deck_lib` — needed for the staticlib/cdylib split on Windows.
