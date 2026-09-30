# Bundled Codex Runtime

EVREN Codex Desktop production packages include the official OpenAI Codex `0.157.1` Windows x64 standalone runtime payload. The file set follows the completeness check in the upstream `rust-v0.157.1` Windows installer: `codex.exe`, `codex-code-mode-host.exe`, `rg.exe`, `codex-command-runner.exe`, `codex-windows-sandbox-setup.exe`, and `codex-package.json`.

The runtime is licensed under Apache-2.0. `LICENSE-OPENAI-CODEX.txt` is the unmodified upstream license. `bundle-manifest.json` records the exact packaged file sizes and SHA-256 hashes. EVREN does not modify these upstream binaries.

Source release: <https://github.com/openai/codex/releases/tag/rust-v0.157.1>
