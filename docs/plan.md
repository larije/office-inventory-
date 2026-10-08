# Office Inventory Implementation Plan

> For agentic workers: use subagent-driven-development for the independent store and UI tasks; root implements server, launcher, and integration.

**Goal:** Deliver a small, persistent, single-office equipment register with portable save/load.

**Architecture:** Local Node HTTP server, native SQLite persistence, and static HTML/CSS/JS. No package dependencies or external services. Separate data directory from shipped source/runtime.

**Tech Stack:** Node.js 24.17+, node:sqlite, node:test, browser platform, Windows launchers.

**Spec:** design.md in this directory.

## Global constraints

One office, one computer at a time; only individually tracked equipment; no sample data; bind 127.0.0.1; no Docker; snapshot restore replaces current data only after validation and a recovery save; preserve existing inventory_Sys.

## Review focus

- Duplicate property numbers and references to nonexistent employees: store rejects without partial writes.
- Restore corruption or incompatible version: existing data and history survive untouched.
- Restoring an older save: clear confirmation, automatic recovery snapshot, no silent merge.
- Cross-site browser requests and static path traversal: loopback/Host/Origin checks and a static allowlist.
- Occupied app port or stale startup state: do not reuse or terminate an unrelated server.

## Tasks

- [x] Store and backup: src/store.mjs plus tests/store.test.mjs. Implement the design interface and use node:test to prove persistence, assignment history, uniqueness, round-trip saves, failed restore, and recovery.
- [x] Browser UI: public/index.html, public/styles.css, public/app.js. Three views, responsive inventory table, concise forms, direct assignment changes, detail/history drawer, employees, filters/CSV/print, and explicit save/load preview/confirmation. Consume the documented HTTP interface and use safe text rendering.
- [x] Server and launcher: src/server.mjs, scripts/launch.ps1, batch files, package.json, tests/server.test.mjs. Test HTTP success/errors, origin/Host enforcement, request limits and recovery workflow. Launch a single background server, identify/reuse its instance, stop through an instance-authenticated shutdown request, and package a portable runtime.
- [x] Integration: run node --test tests/*.test.mjs, browser CRUD and save/load smoke, inspect desktop/mobile layout, launcher start/repeat/stop checks. Independent review, fix substantiated findings, document use and verified limitations, and produce a portable ZIP.

## Execution note

The original build request and the user's scope answers authorize this separate local implementation. These are concrete defaults chosen to minimize setup and daily steps; naming can be revised while work proceeds. The directory is new and is not a Git checkout, so Git/worktree/commit stages do not apply.
