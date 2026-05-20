# Claude Deck

[![CI](https://github.com/Txf513/claude-deck/actions/workflows/ci.yml/badge.svg)](https://github.com/Txf513/claude-deck/actions/workflows/ci.yml)

A Tauri 2 desktop GUI for the local `claude` CLI. It reads your on-disk session history from `~/.claude/projects/<folder>/*.jsonl`, lets you resume or start conversations, streams replies by spawning the CLI as a subprocess, and ships a fallback xterm.js terminal that runs the CLI directly.

## Requirements

- macOS (the only platform tested so far)
- A working `claude` CLI on your PATH
- Node 20+, pnpm 10+
- Rust stable (for development)

## Develop

```sh
pnpm install
pnpm tauri dev    # full app with HMR — boots Vite + the Rust shell
```

`pnpm dev` alone starts only Vite and won't resolve Tauri APIs.

## Build

```sh
pnpm build         # type-check + frontend bundle (tsc && vite build)
pnpm tauri build   # production .app bundle
```

## Project layout

- `src/` — React 19 + Vite + TypeScript frontend
- `src-tauri/` — Rust backend (Tauri commands, PTY, session readers, settings I/O)
- `CLAUDE.md` — design notes / architecture summary

## License

MIT
