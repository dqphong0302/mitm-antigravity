# MITM Antigravity

**A local proxy and desktop control panel for routing Google Antigravity model requests to your own compatible upstream endpoint.**

[Features](#features) · [Quick start](#quick-start) · [Configuration](#configuration) · [Model mapping](#model-mapping) · [Build](#build) · [Safety notes](#safety-notes)

---

## Overview

MITM Antigravity runs a local HTTPS proxy for selected Google Antigravity traffic.
It can generate and trust a local TLS certificate, redirect Antigravity hosts to your
machine, inspect supported generation requests, and forward mapped model calls to a
configurable OpenAI-compatible upstream endpoint.

The project includes two ways to use the tool:

- **Desktop GUI**: a Tauri control panel for configuration, model mapping, proxy
  control, system setup, and logs.
- **CLI/backend binary**: a standalone command-line executable that can run the
  proxy directly on macOS, Windows, or Linux-like environments.

> [!IMPORTANT]
> This tool modifies local networking and certificate trust settings when setup is
> applied. Use it only on machines you control and understand the implications of
> installing a local trusted certificate.

---

## Features

- Local HTTPS proxy for Antigravity generation endpoints.
- Conservative routing: non-target traffic passes through by default.
- Explicit model mapping for supported Antigravity aliases.
- OpenAI-compatible upstream endpoint support.
- API key, endpoint, model, retry, and mapping configuration.
- Import/export configuration as portable JSON.
- Compact GUI with light/dark/system themes and English/Vietnamese labels.
- Backend and proxy logs with secret redaction.
- Cross-platform CLI binary build using `pkg`.
- Native desktop app build using Tauri.

---

## Requirements

For source development:

- Node.js 18+
- npm
- Rust toolchain and Tauri prerequisites, only if building the desktop app

For release users:

- Windows x64: use the Windows `.exe` build.
- macOS Apple Silicon: use the macOS arm64 build.
- Administrator privileges may be required for certificate and hosts/DNS setup.

---

## Quick start

### 1. Install dependencies

```bash
npm install
```

### 2. Open the GUI

```bash
node index.js gui
```

The GUI runs at:

```text
http://127.0.0.1:20245/
```

Useful GUI options:

```bash
node index.js gui --ui-port 20246
node index.js gui --no-open
```

### 3. Configure endpoint and models

In the GUI:

1. Open **Config**.
2. Enter your upstream endpoint and API key.
3. Load available upstream models.
4. Open **Model Mapping**.
5. Map the Antigravity model aliases you want to route.
6. Save mapping and reload the proxy.

### 4. Apply local system setup

Open **Proxy & System**, then run:

- **Apply DNS & Cert** once to generate/trust the certificate and update hosts.
- **START** to start the local proxy.
- **STOP** to stop the proxy.

The GUI does not store your administrator password. macOS/Windows/Linux will prompt
for elevation when needed.

---

## Using the release binary

The backend binary can be run directly without installing Node.js.

### Windows

Open PowerShell in the release folder:

```powershell
.\mitm-antigravity-win-x64.exe --help
.\mitm-antigravity-win-x64.exe gui
```

For certificate/hosts setup, run PowerShell or Command Prompt as Administrator.

### macOS

```bash
./mitm-antigravity-macos-arm64 --help
./mitm-antigravity-macos-arm64 gui
```

If macOS blocks the unsigned binary, allow it from **System Settings → Privacy &
Security**, or remove quarantine for your private build:

```bash
xattr -dr com.apple.quarantine ./mitm-antigravity-macos-arm64
```

---

## Configuration

The app stores runtime settings under the user profile:

```text
~/.mitm-antigravity/settings.json
```

You can inspect paths with:

```bash
node index.js config paths
```

Initialize or print the current redacted configuration:

```bash
node index.js config init
node index.js config list
```

Set values from the CLI:

```bash
node index.js config set \
  routerUrl=https://your-endpoint.example.com/v1/chat/completions \
  apiKey=sk-your-key \
  modelMap.gemini-3-flash=your-upstream-model
```

Example shape:

```json
{
  "activeMachine": "your-machine-name",
  "machines": {
    "your-machine-name": {
      "routerUrl": "https://your-endpoint.example.com/v1/chat/completions",
      "apiKey": "sk-your-key",
      "modelMap": {
        "gemini-3-flash": "your-upstream-model"
      }
    }
  }
}
```

> [!WARNING]
> Do not publish your personal `settings.local.json`, `config.local.json`, or any
> file containing API keys. Release builds should ship with a stripped sample
> `settings.json` only.

---

## Import and export

Export current configuration:

```bash
node index.js export-config
node index.js export-config --output backup.json
```

Import configuration:

```bash
node index.js import-config backup.json
```

Exported metadata is included for traceability. Runtime-only metadata is ignored
when importing.

---

## Model mapping

MITM Antigravity is intentionally conservative:

- Authentication and bootstrap traffic pass through.
- Unmapped model requests pass through to Google.
- Only explicitly mapped generation requests are routed to your upstream endpoint.

Supported built-in aliases:

```text
gemini-3.1-pro-high
gemini-3.1-pro-low
gemini-3-flash
claude-sonnet-4-6
claude-opus-4-6-thinking
gpt-oss-120b-medium
```

Example one-off start command:

```bash
node index.js start \
  --endpoint https://your-endpoint.example.com/v1/chat/completions \
  --api-key sk-your-key \
  --map gemini-3-flash=your-upstream-model \
  --map claude-sonnet-4-6=your-other-upstream-model
```

Force all intercepted requests to one upstream model:

```bash
node index.js config set model=your-upstream-model
```

Enable broad interception only if you understand the behavior:

```bash
node index.js start --always-intercept
```

---

## CLI reference

```text
mitm-antigravity [start|setup|stop|cleanup|doctor|status|gui|wizard|config|export-config|import-config|uninstall-cert] [options]
mitm-antigravity wizard
mitm-antigravity doctor
mitm-antigravity cleanup
mitm-antigravity config [list|path|paths|init|set key=value ...]
```

Recommended CLI flow:

```bash
node index.js wizard
node index.js setup --password '<sudo-password>'
node index.js start --skip-setup
node index.js doctor
node index.js stop --password '<sudo-password>'
```

Interactive setup wizard:

```bash
node index.js wizard
```

The wizard guides users through endpoint, API key, forced model, built-in model
mappings, save confirmation, and optional GUI launch.

Common commands:

```bash
node index.js wizard
node index.js gui
node index.js setup
node index.js start
node index.js start --skip-setup
node index.js status
node index.js doctor
node index.js stop
node index.js cleanup
node index.js uninstall-cert
```

`stop`, `cleanup`, and `stop-cleanup` all stop the proxy and remove managed DNS
entries, which restores Antigravity's normal networking when you no longer use
the tool.

Useful options:

| Option | Description |
| --- | --- |
| `--target-hosts` | Comma-separated Antigravity hosts to redirect. |
| `--remote-ip` | IP written to hosts. Default: `127.0.0.1`. |
| `--port` | Local HTTPS proxy port. Default: `443`. |
| `--endpoint`, `--router-url` | Upstream chat completion endpoint. |
| `--api-key` | Upstream bearer token. |
| `--model` | Force intercepted requests to one upstream model. |
| `--map source=target` | Add a model mapping. Can be repeated. |
| `--model-map-file` | Read mappings from a JSON file. |
| `--skip-setup` | Start proxy without modifying cert or hosts. |
| `--ui-port` | Local GUI port. Default: `20245`. |
| `--no-open` | Start GUI server without opening a browser. |

---

## Build

### CLI/backend binaries

Build macOS arm64, macOS x64, and Windows x64 backend binaries:

```bash
npm run build:pkg
```

Output:

```text
dist/mitm-antigravity-macos-arm64
dist/mitm-antigravity-macos-x64
dist/mitm-antigravity-win-x64.exe
dist/settings.json
```

`dist/settings.json` is a stripped release settings file by default.

### Tauri desktop app

Build the native app for the current OS:

```bash
npm run build
```

On macOS, output is written under:

```text
src-tauri/target/release/bundle/macos/MITM AG.app
```

Tauri desktop bundles are native-platform builds. Build Windows installers on
Windows or in a dedicated CI/cross-build environment.

---

## Project structure

| Path | Purpose |
| --- | --- |
| `index.js` | CLI entrypoint. |
| `src/cli.js` | Command parsing and dispatch. |
| `src/config.js` | Runtime settings, import/export, machine profiles. |
| `src/proxy.js` | Main HTTPS proxy and request routing. |
| `src/proxy-helpers.js` | URL checks, passthrough handling, retry helpers. |
| `src/proxy-logger.js` | Compact proxy event logging. |
| `src/proxy-control.js` | Start/stop/health-check helpers. |
| `src/models.js` | Model alias and mapping logic. |
| `src/cert.js` | Certificate generation and trust store integration. |
| `src/dns.js` | Hosts/DNS redirect management. |
| `src/gui.js` | Local GUI server. |
| `src/gui/` | GUI template, CSS, client logic, routes, i18n. |
| `src-tauri/` | Tauri desktop app wrapper. |
| `tauri-ui/` | Static frontend used by Tauri builds. |
| `test/` | Node.js test suite. |

---

## Development

Run syntax checks:

```bash
npm run check
```

Run tests:

```bash
npm test
```

Start Tauri development mode:

```bash
npm run tauri:dev
```

---

## Roadmap

Planned improvements for public users:

- Add an interactive terminal UI for users who prefer a guided CLI flow over flags.
- Add safer first-run setup prompts for endpoint, API key, and model mapping.
- Add release checks that prevent accidental packaging of local secrets.
- Add signed installers for supported desktop platforms.

---

## Safety notes

- This project installs a local TLS certificate when setup is applied.
- Hosts redirection affects the configured target hosts system-wide.
- Only selected generation endpoints are intercepted; other paths pass through.
- If Antigravity or the runtime uses certificate pinning, interception may fail.
- Never commit or publish local secrets, API keys, generated certificates, or private
  `settings.local.json` files.
- Review logs before sharing them publicly; the logger redacts common secrets, but
  you should still verify sensitive content manually.

---

## License

Add your preferred license before publishing this repository.
