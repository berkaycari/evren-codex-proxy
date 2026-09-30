# AGENTS.md — EVREN Codex Bridge / EVREN Codex Desktop

This file is the durable repository-wide working contract for AI coding agents.

Read this file before making changes.

---

## 1. Project purpose

EVREN Codex Bridge started as a local compatibility bridge between OpenAI Codex CLI and the EVREN Responses API.

The project is evolving into **EVREN Codex Desktop**, a Windows desktop coding-agent application built around:

- Electron
- React
- TypeScript
- Vite
- the existing EVREN Bridge core
- OpenAI Codex App Server
- EVREN `/v1/responses`

Target normal-user flow:

```text
EVREN Codex Desktop
→ enter EVREN API key
→ select model
→ open project
→ chat with Codex
→ close app
→ return later
→ Continue Work
```

Normal users should not need to manually start the Bridge or open a second Codex terminal.

---

## 2. Current development state

The v2 Desktop implementation is under active development.

Do not treat v2 as publicly released unless the user explicitly requests a release.

Current Codex compatibility target:

```text
Codex CLI 0.157.1
upstream tag: rust-v0.157.1
```

Do not silently upgrade this target.

For Codex protocol work, inspect the exact upstream 0.157.1 schema/source before using methods, notifications, params, or response fields.

---

## 3. Core architecture

Normal Desktop flow:

```text
React Renderer
→ typed preload IPC
→ Electron Main
→ Codex App Server
→ local authenticated Bridge
→ EVREN Responses API
```

Electron Main owns privileged operations.

The renderer must remain unprivileged.

Reuse the existing Bridge runtime instead of duplicating it.

---

## 4. Electron security invariants

Do not weaken these without explicit user approval:

```text
nodeIntegration = false
contextIsolation = true
sandbox = true
webSecurity = true
```

The renderer must NOT receive direct access to:

- `fs`
- `child_process`
- `process.env`
- raw `ipcRenderer`
- raw JSON-RPC transport
- credentials
- arbitrary shell execution

Use a narrow typed preload API.

Production preload must remain Electron-sandbox compatible.

Expected production preload:

```text
dist/desktop/preload/index.cjs
```

Do not regress to an ESM preload that Electron cannot load.

If preload is unavailable, preserve the visible safe failure state rather than rendering a blank window.

---

## 5. EVREN API key rules

The EVREN API key is sensitive.

It may exist:

- temporarily in renderer while the user types it
- in Electron Main memory
- encrypted through Electron `safeStorage`

It must NEVER be:

- committed
- logged
- returned to renderer after storage
- written plaintext to settings
- written to `.env`
- placed in localStorage/sessionStorage
- included in diagnostics
- passed to the Codex child process

There must be no plaintext persistence fallback if secure storage is unavailable.

Session-only use is acceptable.

---

## 6. Codex → Bridge authentication

Desktop Codex must not receive the real EVREN API key.

Each application launch generates a random local Bridge credential.

Conceptually:

```text
Codex
→ per-launch local bearer token
→ local Bridge
→ EVREN API key owned by Electron Main
→ EVREN
```

The local Bridge token must:

- never be shown
- never be persisted
- never be logged
- never be forwarded upstream to EVREN

The Desktop Bridge must bind to:

```text
127.0.0.1
```

Desktop should use an ephemeral port.

---

## 7. Codex configuration

Desktop must not modify the user's global:

```text
~/.codex/config.toml
```

Use process-level Codex configuration overrides.

Production must not require:

- ChatGPT login
- OpenAI login
- OpenAI API key

The EVREN Desktop custom provider should remain configured as not requiring OpenAI authentication.

---

## 8. Codex App Server

Desktop communicates with Codex through App Server JSON-RPC.

Do NOT parse Codex TUI or ANSI output.

Current important methods include:

```text
initialize
thread/start
thread/list
thread/resume
thread/archive
thread/name/set
thread/turns/list
thread/items/list
turn/start
turn/interrupt
```

Relevant notifications include:

```text
thread/started
thread/status/changed
turn/started
turn/completed
turn/diff/updated
turn/plan/updated
item/started
item/completed
item/agentMessage/delta
item/commandExecution/outputDelta
item/fileChange/outputDelta
item/fileChange/patchUpdated
thread/tokenUsage/updated
thread/compacted
warning
error
```

Do not invent protocol shapes.

Unknown server requests must never be auto-approved.

---

## 9. Approval safety

Existing Desktop coding posture should remain safe.

Default behavior should stay equivalent to:

```text
approvalPolicy = on-request
approvalsReviewer = user
sandbox = workspace-write
```

Do not default to unrestricted execution.

Command/file approval decisions must map only to valid Codex protocol decisions.

Do not auto-approve unknown or malformed requests.

Cross-thread approval isolation must remain intact.

---

## 10. Never expose raw reasoning

Never expose, persist, log, or send raw chain-of-thought / hidden reasoning to the renderer.

The UI may show generic states such as:

```text
Thinking...
Working...
```

but not hidden reasoning content.

Renderer-safe DTO/projector code must exclude reasoning payloads.

---

## 11. Codex thread authority

Codex thread state is authoritative.

Desktop-local data is only:

- metadata
- UX index
- cache
- convenience state

It is NOT model memory.

Do not replay the whole local conversation history to EVREN just to continue work.

Continue work using the real Codex thread:

```text
thread/resume
```

---

## 12. Persistence / restart behavior

Normal Desktop chats must be persistent, not ephemeral.

Preserve the restart/discovery/resume hotfix.

A known Codex 0.157.1 behavior:

- EVREN Desktop thread provider can be `evren-desktop`
- `threadSource` can be `evren-codex-desktop`
- Codex `source` may appear as `vscode`

Do NOT restore the old:

```text
sourceKinds: ["appServer"]
```

filter, because it hid real persisted Desktop threads.

Desktop ownership should rely on stable provider metadata plus safe project/CWD matching.

Windows CWD comparison must account for:

- case differences
- slash direction
- trailing separators
- canonical normalization

---

## 13. Local history

Local history exists for long-task UX.

It may safely contain metadata such as:

- schemaVersion
- threadId
- project path
- project display name
- model/provider
- thread title
- timestamps
- last visible user preview
- last visible assistant preview
- pin/archive presentation metadata
- bounded visible-message cache

Never persist:

- raw reasoning
- hidden system/developer instructions
- API keys
- Bridge token
- Authorization headers
- raw JSON-RPC dumps
- huge command outputs
- image bytes

Local history belongs under Electron `userData`, not inside user projects.

Use:

- versioned structures
- atomic writes
- corruption recovery
- migration support

`Continue Work` must resume the real Codex thread and must not automatically send a new inference.

---

## 14. Projects and paths

The Desktop app must not crawl or index entire repositories just because a project was opened.

Codex is responsible for project exploration.

Normal UI should prefer friendly paths:

```text
smoke-test
src/App.tsx
evren-desktop-smoke.txt
Project root
```

instead of repeatedly showing:

```text
C:\Users\...\Desktop\smoke-test\src\App.tsx
```

Keep canonical absolute paths internally.

Full paths may appear in:

- tooltip
- details
- Copy full path
- diagnostics

Do not rewrite assistant-generated message text just to hide absolute paths.

Project/path containment must prevent traversal outside the selected workspace where appropriate.

---

## 15. Models

EVREN models are discovered dynamically through:

```text
GET /v1/models
```

Do not hard-code the live model catalog.

Only chat-capable models should be selectable for Codex chat.

Dedicated OCR/ASR/embedding/rerank models may be visible informationally but should not automatically become chat models.

Do not infer capabilities from model names.

Use live catalog metadata such as modalities where available.

For a thread, these must remain consistent:

```text
Desktop selected model
Bridge effective model
thread/start requested model
Codex authoritative model
```

Provider IDs must also remain consistent.

A real non-null mismatch must fail safely.

Model changes should apply to new threads rather than silently mutating an active thread.

---

## 16. Images

Desktop v2 supports local image input through Codex `localImage`.

Do not send image bytes/base64 through renderer IPC.

Use main-process validation and safe attachment metadata.

Supported image types currently target:

- PNG
- JPEG/JPG
- WebP

Respect image capability from the live EVREN model catalog.

Do not reintroduce historical placeholder behavior such as:

```text
[input_image omitted]
```

for supported image input.

---

## 17. Audio / Video / OCR / ASR

These are outside the current v2.0 Desktop scope unless the user explicitly expands scope.

Do not opportunistically implement them.

---

## 18. Usage / context / limits

Preserve existing Bridge capabilities including:

- thread-aware sessions
- cumulative vs active context tracking
- compaction support
- replay observability
- tool-catalog pruning
- native parallel tools
- polling visibility
- local usage limits
- positive CR pricing behavior

Do not invent usage values.

Do not present bytes as tokens.

Do not fabricate CR spend if the provider does not expose authoritative spend accounting.

Limit recovery must:

- require explicit user action
- only change the intended reached limit
- never automatically replay the failed request
- never silently raise limits

---

## 19. Bundled Codex runtime

Production distribution should prefer the bundled tested Codex runtime rather than an arbitrary system Codex.

Development may use a system Codex for convenience.

Current pinned target:

```text
Codex 0.157.1
Windows x64
```

The bundled runtime may include:

```text
codex.exe
codex-code-mode-host.exe
rg.exe
codex-command-runner.exe
codex-windows-sandbox-setup.exe
codex-package.json
```

Do not assume `codex.exe` alone is enough.

Preserve required upstream license/notice files.

Bundled executable files that need direct execution must remain outside ASAR.

Production Codex must not require OpenAI/ChatGPT login.

---

## 20. Update system

There are two separate update concepts:

1. EVREN Codex Desktop application update
2. bundled Codex runtime update

EVREN models are dynamic and should not require an app release to appear.

### Runtime update rules

Do not silently install arbitrary upstream latest Codex.

Distinguish:

```text
Installed
EVREN verified
Upstream latest
```

Only verified runtime versions should be offered for normal update.

Runtime update flow should preserve:

- trusted-source policy
- schema validation
- platform/architecture validation
- compatible Desktop version checks
- SHA-256 verification
- safe extraction
- runtime validation before activation
- atomic swap
- rollback
- active-turn protection

Never replace the known-good runtime before the new runtime has passed validation.

Do not silently update Codex while work is active.

### Desktop update rules

Only use the configured official project release source.

Do not claim code signing if artifacts are unsigned.

Report Windows SmartScreen/code-signing implications honestly.

---

## 21. Packaging

Target release platform:

```text
Windows x64
```

Normal end users should not need:

- Node.js
- npm
- system Codex CLI
- manual PATH configuration

Production package should include:

- Electron application
- Bridge/runtime code
- bundled Codex runtime
- required runtime helpers
- required licenses/notices

Do not install Windows services.

Normal production operation must not show visible cmd/PowerShell/Codex console windows.

Avoid shipping unnecessary:

- tests
- development-only sources/assets
- git metadata
- caches
- temporary outputs
- duplicate runtimes
- dev-only dependencies

Measure real package sizes. Never guess final artifact sizes.

---

## 22. Diagnostics and logging

Persistent diagnostics must remain sanitized.

Never include:

- EVREN API key
- Bridge token
- Authorization headers
- full environment
- prompt contents
- raw conversation
- hidden reasoning
- image contents
- large command outputs

Safe diagnostics may contain:

- Desktop version
- Codex version
- OS/platform
- selected model ID
- Bridge/Codex status
- safe limits
- non-secret error/status codes

---

## 23. Legacy Bridge compatibility

Do not break the existing legacy Bridge CLI unless explicitly approved.

Existing development interfaces should remain available conceptually:

```text
npm start
npm run bridge
npm run typecheck
npm test
npm run build
```

Preserve startup scripts where practical.

---

## 24. Testing rules

Never claim success without running relevant validation.

Automated tests must not consume real EVREN inference credits.

At important checkpoints run:

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
git diff --check
```

Also run relevant smokes:

```powershell
npm.cmd run smoke:codex-app-server
npm.cmd run smoke:bundled-codex
npm.cmd run smoke:desktop
```

When packaging exists, also run packaged-application smoke tests.

Distinguish clearly between:

```text
AUTOMATED PASS
HUMAN VALIDATION REQUIRED
```

Do not claim real EVREN/UI behavior from mocks alone.

---

## 25. Dependency hygiene

Prefer the smallest maintainable dependency change.

Before adding a package, check whether the existing stack already provides the capability.

Do not run:

```text
npm audit fix --force
```

without explicit user approval.

Report:

- `npm audit`
- `npm audit --omit=dev`

separately.

Avoid unrelated major dependency upgrades during focused work.

---

## 26. Git rules

Unless the user explicitly asks:

DO NOT:

- push
- tag
- publish a release
- force-push
- rewrite public history
- delete user work
- perform destructive reset/clean operations

Checkpoint commits are allowed only when explicitly requested.

Do not treat temporary development checkpoint commits as public release history.

The user may later squash local development commits before the v2 release.

---

## 27. Versioning

Do not automatically publish or tag:

```text
v2.0.0
```

The package version may intentionally remain on the previous public version during development.

At release-candidate stage, report readiness and let the user decide whether to move to:

```text
2.0.0-rc.1
```

or final:

```text
2.0.0
```

---

## 28. Documentation rules

Keep historical v1.3 claims intact unless evidence proves they are wrong.

Do not rewrite benchmark results as deterministic guarantees.

Development documentation must distinguish:

- implemented and tested
- mocked/tested only
- HUMAN VALIDATION REQUIRED
- future work

Do not document planned behavior as completed behavior.

---

## 29. Working-state recovery

Fresh AI coding sessions must not rely on prior chat memory.

Always recover current state from the repository.

Recommended sequence:

1. read `AGENTS.md`
2. inspect `git status --short`
3. inspect recent commits
4. inspect current docs
5. inspect relevant implementation
6. inspect generated artifacts if a previous session may have stopped mid-command
7. rerun only the validation needed to establish current state

If a previous command may have completed after an interrupted AI response, inspect its outputs before rerunning expensive work.

Do not redo an entire phase just because the previous conversation is unavailable.

---

## 30. Coding-agent working style

When assigned a task:

1. Read this file.
2. Inspect the actual current implementation before changing it.
3. Preserve already-working architecture.
4. Reuse existing services instead of duplicating them.
5. Verify exact external protocol contracts before coding against them.
6. Make focused changes.
7. Add regression coverage.
8. Run validation.
9. Report actual results and limitations.
10. Do not stop after only producing a plan when implementation was requested.

---

## 31. Product philosophy

Prefer:

```text
secure
explicit
recoverable
testable
local-first
Codex-authoritative
maintainable
```

Avoid:

- silent fallbacks
- fake success states
- duplicated sources of truth
- hidden model switching
- automatic approvals
- unnecessary repository crawling
- automatic failed-request replay
- fragile compatibility hacks

The Desktop app should remain a secure product layer around the existing Bridge + Codex architecture, not become a second agent runtime.
