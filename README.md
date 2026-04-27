# mitm-antigravity

MITM app for Antigravity requests. It can:

1. Generate a TLS certificate for `daily-cloudcode-pa.googleapis.com` and `cloudcode-pa.googleapis.com`
2. Trust the certificate on macOS or Windows
3. Add a hosts/DNS redirect to the local proxy
4. Intercept Antigravity `:generateContent` and `:streamGenerateContent` requests
5. Forward intercepted requests to a configurable upstream endpoint with API key, model override, and model mapping
6. Import/export configuration as portable JSON files

The Antigravity mapping behavior follows a conservative MITM flow: auth/bootstrap requests pass through, built-in Antigravity models pass through unless one of the six supported model aliases is explicitly mapped.

## Install

```bash
npm install
```

Requires Node.js 18+ because the proxy uses the built-in `fetch` API.

## Configure

The app reads config from:

```bash
mitm-antigravity config path
```

Config is now saved in a visible `settings.json` file beside the source or binary. It stores a separate profile per machine hostname:

```json
{
  "activeMachine": "your-machine-name",
  "machines": {
    "your-machine-name": {
      "routerUrl": "https://your-endpoint.example.com/v1/chat/completions",
      "apiKey": "sk-your-key",
      "modelMap": {
        "gemini-3-flash": "ag/gemini-3-flash"
      }
    }
  }
}
```

For the source tree, the file is `./settings.json`. Tauri builds bundle a stripped first-run `settings.json` resource, then save runtime settings under the user profile.

Create or show the default config:

```bash
node index.js config init
node index.js config list
node index.js config paths
```

Open the GUI to enter endpoint/API key, check the key, load available models, and choose Antigravity mappings:

```bash
node index.js gui
```

The GUI runs at `http://127.0.0.1:20245/`. Use `--ui-port 20246` to change the port or `--no-open` to keep it from opening a browser automatically.
The GUI is organized into compact tabs:

- **Config**: endpoint, API key, forced model, and endpoint model loading.
- **Model Mapping**: mappings for the six supported Antigravity model aliases.
- **Proxy & System**: proxy start, DNS/certificate actions, Antigravity trust, and live status cards.
- **Logs**: backend and proxy logs for debugging.
- **Settings**: runtime paths, plus persistent light/dark/system theme and English/Vietnamese language controls in the header.

Use `Apply DNS & Cert` in the **Proxy & System** tab to generate/trust the certificate and write the hosts redirect. The GUI never asks for your sudo password; the operating system prompts for administrator approval when required.

Set the upstream endpoint, API key, and default Antigravity model mapping:

```bash
node index.js config set \
  routerUrl=https://your-endpoint.example.com/v1/chat/completions \
  apiKey=sk-your-key \
  modelMap.gemini-3-flash=ag/gemini-3-flash \
  modelMap.claude-sonnet-4-6=ag/claude-sonnet-4-6
```

You can also force every intercepted request to one upstream model:

```bash
node index.js config set model=ag/gemini-2.5-pro
```

## Import / Export Config

Export the current configuration (endpoint, API key, model mappings) to a portable JSON file:

```bash
# Print to stdout
node index.js export-config

# Save to file
node index.js export-config --output backup.json
```

Import a previously exported config:

```bash
node index.js import-config backup.json
```

The GUI also exposes `GET /api/config/export` and `POST /api/config/import` endpoints for programmatic use.

Exported fields: `routerUrl`, `apiKey`, `model`, `alwaysIntercept`, `modelMap`. Metadata fields (`_format`, `_version`, `_exportedAt`, `_machine`) are included for traceability but ignored during import.

## Run

During development, open the Tauri desktop app:

```bash
npm run tauri:dev
```

The app window starts the local backend automatically and loads the control panel. Use the **Proxy & System** tab to apply DNS/certificate setup, start/stop the proxy, and manage auto-start.

The backend CLI is still available for low-level debugging:

```bash
node index.js status
node index.js stop
```

Remove the trusted certificate manually if needed:

```bash
sudo node index.js uninstall-cert
```

## One-off Options

All important settings can be overridden without editing config:

```bash
node index.js start \
  --endpoint https://your-endpoint.example.com/v1/chat/completions \
  --api-key sk-your-key \
  --map gemini-2.5-pro=ag/gemini-2.5-pro \
  --map gemini-2.5-flash=ag/gemini-2.5-flash
```

Useful options:

- `--target-hosts`: Antigravity hosts to redirect. Default: `daily-cloudcode-pa.googleapis.com,cloudcode-pa.googleapis.com`
- `--target-host`: single-host alias; the default host automatically expands to both Antigravity hosts
- `--skip-setup`: start the proxy without touching certificate or hosts entries
- `--remote-ip`: IP written to hosts. Default: `127.0.0.1`
- `--port`: local HTTPS proxy port. Default: `443`
- `--endpoint` or `--router-url`: upstream chat endpoint
- `--api-key`: upstream bearer token
- `--model`: force all intercepted requests to this upstream model
- `--map source=target`: add Antigravity model mapping; can be repeated
- `--model-map-file`: JSON mapping file, for example `{ "gemini-2.5-pro": "ag/gemini-2.5-pro" }`
- `--always-intercept`: intercept even when no explicit mapping exists. Default is off.
- `gui`: starts the local configuration UI
- `--ui-port`: local GUI port. Default: `20245`
- `--no-open`: start the GUI server without opening a browser

## Build Tauri App

```bash
npm run build
```

or directly:

```bash
npm run tauri:build
```

The macOS app bundle is written to:

```text
src-tauri/target/release/bundle/macos/MITM AG.app
```

The Tauri app starts the bundled backend with `gui --no-open` and displays `http://127.0.0.1:20245/` inside a native desktop window. The bundled backend resource also receives a stripped `settings.json` by default, so packaged builds do not carry your local API key.

Runtime settings are saved persistently under the user profile at `~/.mitm-antigravity/settings.json`. A bundled or local `settings.json` is only used as a first-run fallback/import source, so app updates or moving the app bundle should not delete your saved configuration.
Certificates are kept in the user's home directory under `.mitm-antigravity`.

The Tauri app's main screen includes `Start Proxy & Trust` and `Stop Proxy` controls. `Start Proxy & Trust` applies Antigravity Node trust before starting the proxy. Auto-start runs `start --skip-setup` after user login using a macOS LaunchAgent, Windows Scheduled Task, or Linux user systemd service. Run `Apply DNS & Cert` once before relying on auto-start so the OS trust/DNS setup is already in place.

The GUI never asks for or stores your sudo password. Privileged actions use the operating system's native administrator prompt when elevation is needed.

The GUI supports light, dark, and system theme modes, plus English and Vietnamese labels. These display preferences are stored locally in the Tauri/WebView profile and do not affect proxy routing config.

The `Model Mapping` tab maps only these six built-in Antigravity aliases: `gemini-3.1-pro-high`, `gemini-3.1-pro-low`, `gemini-3-flash`, `claude-sonnet-4-6`, `claude-opus-4-6-thinking`, and `gpt-oss-120b-medium`. Unmapped models pass through to Google. Use `Save Mapping & Reload Proxy` after editing mappings so the running proxy process reloads the updated settings.
By default, `npm run build` and `npm run tauri:build` strip `apiKey` from packaged settings so packaged builds do not carry your local secret. Set `MITM_COPY_SETTINGS_WITH_SECRETS=true` only for a private build where you explicitly want to copy the key.

## Project Structure

| Module | Responsibility |
|--------|---------------|
| `src/proxy.js` | Main HTTPS proxy server, request interception |
| `src/proxy-helpers.js` | URL pattern matching, header building, retry logic |
| `src/proxy-control.js` | Proxy start/stop/health-check |
| `src/autostart.js` | LaunchAgent, Scheduled Task, systemd auto-start |
| `src/models.js` | Model alias resolution, mapping, routing core |
| `src/model-list.js` | Antigravity model list build/merge |
| `src/model-serialization.js` | Response decoding, log summarization |
| `src/config.js` | Settings read/write, import/export |
| `src/cert.js` | TLS certificate generation and trust |
| `src/dns.js` | Hosts file and DNS redirect management |
| `src/gui.js` | GUI backend API routes |
| `src/gui/` | GUI HTML template, CSS, client JS, i18n |
| `src/cli.js` | CLI argument parsing and command dispatch |
| `src/logging.js` | File logging with secret redaction |
| `src/system.js` | Shell execution, sudo elevation |
| `src/constants.js` | Shared defaults and alias lists |
| `src/http.js` | HTTP body collection and JSON response |
| `src/args.js` | Argument parser |

## Notes

- This app changes the system trust store and hosts file.
- If Antigravity uses certificate pinning, MITM will fail.
- Hosts redirection affects the whole target host, but only `:generateContent` and `:streamGenerateContent` are intercepted. Other paths are passed through.
- Existing legacy local mapping files can still be used as an optional backward-compatibility fallback.
- Built-in Antigravity aliases such as `gemini-3.1-pro-high`, `gemini-3-flash`, `claude-sonnet-4-6`, `claude-opus-4-6-thinking`, and `gpt-oss-120b-medium` can be mapped explicitly; otherwise chat requests pass through.
- Global `uncaughtException` and `unhandledRejection` handlers prevent silent crashes and log errors to the backend log file.
