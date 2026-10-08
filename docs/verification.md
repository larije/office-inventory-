# Verification — 6 October 2026

- 14 automated store/API tests passed using the bundled Node.js 24.17.0 runtime.
- Store tests cover persistence after restart, assignments and history, duplicate property numbers, employee deactivation/return/transfer/archive, active-assignment consistency, save/load between fresh databases, automatic recovery, malformed snapshots, transaction rollback, recovery-write failure, and different clocks between computers.
- HTTP tests cover CRUD, backup download/preview/confirmed restore, readable validation failures, foreign Origin/Host rejection, mutation headers, private source/data paths, and unauthorized shutdown.
- Browser checks in a separate temporary data directory: add employee; add assigned equipment; edit location; view readable history; inspect save timestamp/counts; load selected file; verify replacement confirmation and recovery filename. No browser console errors were observed.
- The save endpoint produced a complete .inventory file containing the expected employee, equipment, and both history entries. The in-app browser did not report its blob download event; the file used for browser load verification was downloaded from the same endpoint through HTTP.
- Windows launcher checks: background start, repeat start reuses the running app, instance-authenticated stop. All synthetic records stayed in work/ outside the portable package.
- Runtime matches the installed executable by SHA-256. The official matching Node.js license is included.
- Second-computer behavior is verified using independent database directories on this computer; no second physical PC was available. Ordinary Windows browser download handling and a physical printer remain user-environment checks.

Independent review identified a clock-skew portability issue. It was corrected with a red/green regression test and passed scoped re-review. No remaining material review findings.

Portable ZIP smoke passed after extracting to a new folder with spaces: initially empty records, repeated launch reused the instance, a saved file loaded successfully, and loaded records persisted across stop/restart. Both the extracted test app and clean screenshot preview were stopped afterward.

## Dashboard redesign — 6 October 2026

- Added a default Dashboard using the supplied ledger screenshot as the layout reference. The existing equipment, employees, Save & Load, dialogs, and print layout remain available.
- Re-ran all 14 store/API tests successfully. Dashboard changes do not change the database or save format.
- Browser checks with separate synthetic records: eight active items, five assigned, three unassigned, four active employees; the condition chart showed five good, two needing repair, and one unserviceable. Archived equipment and an inactive employee were excluded correctly.
- Assigned, unassigned, condition, attention, and total-card links opened the correct equipment lists and cleared previous filters.
- Added equipment from Dashboard, assigned it to an employee, verified the assignment in item history, and archived it. Dashboard totals and recent records updated after each save.
- Empty inventory showed zero counts, an empty condition ring, and first-use actions. Save & Load remained accessible.
- Visually reviewed the complete desktop dashboard and the empty dashboard at a 390px viewport; no page-level horizontal overflow. Browser logs contained no warnings or errors.
- Independent code review found no material dashboard logic or HTML integration issues. Preview records are outside the distributed app folder; the dashboard screenshot is labeled as a sample office.

## Automatic port selection — 6 October 2026

- 16 store/API tests pass, including a real occupied-port test: the app binds a free loopback port, reports and records the actual URL, and authenticated shutdown leaves the original listener running. Invalid port errors still propagate.
- Windows PowerShell launcher regression first failed against the original occupied-port rejection, then passed with automatic selection. It verifies the reported URL, repeat launch and Stop after changing the preferred port, stale runtime recovery, record persistence, independent copies, and refusal to duplicate a live unresponsive instance.
- Windows launchers were exercised with isolated temporary databases and ephemeral ports. No existing user app on port 3210 was stopped or modified. All test-owned servers were closed.
- Independent review found no material issues in server binding, launcher ownership checks, or actual-port discovery.

## LedgerDex UI, motion, and startup - 7 October 2026

- Adapted the reference app's light palette, bundled Inter font, 272/72 px collapsible sidebar, sticky header, gradient cards, page/card/list/counter/dialog motion, and dashboard loading skeleton. Mobile navigation uses a focus-managed drawer. Reduced-motion settings disable decorative movement; print rules remain separate.
- Fresh visits use light mode regardless of the OS theme. Explicit saved light/dark preferences still work across local-port changes. Theme tests first reproduced the prior dark OS fallback, then passed after the change.
- Launcher reports progress, prefers installed Zen Browser with default-browser fallback, and creates a Desktop shortcut when the name is free. Existing shortcut targets are preserved. Portable Node/SQLite, instance ownership, readiness checks, automatic port fallback, and scoped shutdown remain intact.
- Final command `runtime\node.exe --test --test-isolation=none tests/*.test.mjs`: 42 passed, 0 failed. Covers records/API/save recovery, theme defaults, workspace assets, animation cancellation, native dialog closing, sidebar persistence, mobile inert/focus handling, and brand-link drawer dismissal.
- `powershell.exe -NoProfile -ExecutionPolicy Bypass -File tests/launcher.test.ps1`: passed browser fallback, isolated shortcut creation/collision handling, startup progress, occupied ports, duplicate launch, scoped stop, persisted records, and stale/unresponsive runtime cases.
- Independent review identified two integration issues, both fixed: refresh errors after a save now await dialog dismissal, and mobile brand navigation closes the drawer before executing its action. The brand regression test fails against the previous nav-only listener.
- Restarted this installation with its scoped launcher. Its full `/api/state` response was identical before and after restart. The running app at http://127.0.0.1:3210 returns HTTP 200 for workspace.js, styles.css, theme.js, and the bundled WOFF2 font.
- Browser visual verification was unavailable: CUA reported no browser surfaces and could not create Edge or in-app browser tabs. CSS was parsed successfully; screenshots and actual browser layout/motion were not verified this session.