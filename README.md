# MITM Antigravity

<p align="center">
  <strong>Local-first proxy and desktop control panel for routing Google Antigravity model requests to OpenAI-compatible upstreams.</strong>
</p>

<p align="center">
  <a href="#features">Features</a> ·
  <a href="#quick-start">Quick Start</a> ·
  <a href="#configuration">Configuration</a> ·
  <a href="#cli-reference">CLI</a> ·
  <a href="#build">Build</a> ·
  <a href="#safety">Safety</a>
</p>

<p align="center">
  <img alt="Node.js 18+" src="https://img.shields.io/badge/Node.js-18%2B-3c873a?style=flat-square">
  <img alt="Tauri" src="https://img.shields.io/badge/Desktop-Tauri-24c8db?style=flat-square">
  <img alt="Platform" src="https://img.shields.io/badge/Platform-macOS%20%7C%20Windows-lightgrey?style=flat-square">
  <img alt="Status" src="https://img.shields.io/badge/Status-Local--first-7c3aed?style=flat-square">
</p>

---

## Overview

**MITM Antigravity** runs a local HTTPS proxy for selected Google Antigravity traffic.
It can generate and trust a local TLS certificate, redirect configured Antigravity
hosts to your machine, inspect supported generation requests, and forward mapped
model calls to your own OpenAI-compatible endpoint.

Use it as either:

- **Desktop GUI** — visual control panel for setup, configuration, model mapping,
  proxy control, diagnostics, and logs.
- **CLI/backend binary** — standalone command-line tool for scripting or direct
  proxy operation.

> [!IMPORTANT]
> This tool can modify local networking and certificate trust settings. Use it only
> on machines you control, and review the safety notes before applying setup.

---

## Features

- 🔁 **Local HTTPS proxy** for selected Antigravity generation endpoints.
- 🧭 **Conservative routing**: unmapped and non-target traffic passes through.
- 🧩 **Explicit model mapping** from Antigravity aliases to upstream models.
- 🔌 **OpenAI-compatible upstream** endpoint support.
- 🖥️ **Desktop control panel** with configuration, logs, diagnostics, and themes.
- 🌐 **English/Vietnamese UI labels** for a smoother local workflow.
- 📦 **Import/export configuration** as portable JSON.
- 🧪 **Doctor diagnostics** for readiness checks and actionable troubleshooting.
- 🔐 **Secret-aware logging** with redaction for common sensitive values.
- 🛠️ **Cross-platform builds** via `pkg` and Tauri.

---

## Requirements

| Use case | Requirements |
| --- | --- |
| Source development | Node.js 18+, npm |
| Desktop build | Rust toolchain + Tauri prerequisites |
| System setup | Administrator privileges for certificate and hosts/DNS changes |
| Release binary | Matching platform build, no Node.js required |

---

## Quick Start

### 1. Install dependencies

```bash
npm install
```

### 2. Launch the GUI

```bash
node index.js gui
```

Open:

```text
http://127.0.0.1:20245/
```

Useful options:

```bash
node index.js gui --ui-port 20246
node index.js gui --no-open
```

### 3. Configure your upstream

In the GUI:

1. Open **Config**.
2. Enter your upstream endpoint and API key.
3. Load available upstream models.
4. Open **Model Mapping**.
5. Map Antigravity aliases to upstream models.
6. Save mapping and reload the proxy.

### 4. Apply local setup and start

Open **Proxy & System**:

- Click **Apply DNS & Cert** once to generate/trust the certificate and update hosts.
- Click **START** to start the local proxy.
- Click **STOP** to stop it.

The GUI does **not** store your administrator password. Your OS will prompt for
elevation when needed.

---

## Release Binary

The backend binary can run directly without installing Node.js.

### Windows

```powershell
.\mitm-antigravity-win-x64.exe --help
.\mitm-antigravity-win-x64.exe gui
```

Run PowerShell or Command Prompt as Administrator when applying certificate or
hosts setup.

### macOS

```bash
./mitm-antigravity-macos-arm64 --help
./mitm-antigravity-macos-arm64 gui
```

If macOS blocks an unsigned private build, allow it from **System Settings →
Privacy & Security**, or remove quarantine:

```bash
xattr -dr com.apple.quarantine ./mitm-antigravity-macos-arm64
```

---

## Configuration

Runtime settings are stored under the user profile:

```text
~/.mitm-antigravity/settings.json
```

Inspect config paths:

```bash
node index.js config paths
```

Initialize or print the redacted current configuration:

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
> Never publish personal configs, API keys, generated certificates, or private
> `settings.local.json` / `config.local.json` files.

---

## Import / Export

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

## Model Mapping

MITM Antigravity is intentionally conservative:

- Authentication and bootstrap traffic pass through.
- Unmapped model requests pass through to Google.
- Only explicitly mapped generation requests are routed to your upstream endpoint.

Built-in aliases:

```text
gemini-3.1-pro-high
gemini-3.1-pro-low
gemini-3-flash
claude-sonnet-4-6
claude-opus-4-6-thinking
gpt-oss-120b-medium
```

Start with one-off mappings:

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

## CLI Reference

```text
mitm-antigravity [command] [options]

Commands:
  start              Start the local HTTPS proxy
  setup              Apply DNS/hosts and certificate setup
  stop               Stop the proxy
  cleanup            Stop proxy and remove managed DNS entries
  doctor             Run diagnostics
  status             Print current status
  gui                Start the local GUI
  wizard             Run interactive setup wizard
  config             Manage runtime configuration
  export-config      Export configuration to JSON
  import-config      Import configuration from JSON
  uninstall-cert     Remove managed certificate
```

Recommended flow:

```bash
node index.js wizard
node index.js setup
node index.js start --skip-setup
node index.js doctor
node index.js stop
```

Common commands:

```bash
node index.js gui
node index.js wizard
node index.js status
node index.js doctor
node index.js cleanup
```

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

Build macOS arm64, macOS x64, and Windows x64 binaries:

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

Build the native desktop app for the current OS:

```bash
npm run build
```

On macOS, output is written under:

```text
src-tauri/target/release/bundle/macos/MITM AG.app
```

Tauri bundles are native-platform builds. Build Windows installers on Windows or
in a dedicated CI/cross-build environment.

---

## Project Structure

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

## Safety

- Setup installs a local TLS certificate.
- Hosts redirection affects configured target hosts system-wide.
- Only selected generation endpoints are intercepted; other paths pass through.
- If Antigravity or the runtime uses certificate pinning, interception may fail.
- Do not commit local secrets, API keys, generated certificates, or private configs.
- Review logs before sharing them publicly, even though common secrets are redacted.

To restore normal networking, stop the proxy and remove managed DNS entries:

```bash
node index.js cleanup
```

---

## License

Add your preferred license before publishing this repository.
