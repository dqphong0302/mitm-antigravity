# mitm-antigravity

MITM app for Antigravity requests. It can:

1. Generate a TLS certificate for `daily-cloudcode-pa.googleapis.com` and `cloudcode-pa.googleapis.com`
2. Trust the certificate on macOS or Windows
3. Add a hosts/DNS redirect to the local proxy
4. Intercept Antigravity `:generateContent` and `:streamGenerateContent` requests
5. Forward intercepted requests to a configurable upstream endpoint with API key, model override, and model mapping

The Antigravity mapping behavior follows 9router's MITM flow: extract the model from the Gemini URL/body, look up an Antigravity alias mapping, allow prefix fallback matches, and only intercept when a mapping exists. You can still force interception with `alwaysIntercept=true`.

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

For the source tree, the file is `./settings.json`. For built binaries, `npm run build` copies it to `./dist/settings.json`.

Create or show the default config:

```bash
node mitm-oneclick.js config init
node mitm-oneclick.js config list
node mitm-oneclick.js config paths
```

Open the GUI to enter endpoint/API key, check the key, load available models, and choose Antigravity mappings:

```bash
node mitm-oneclick.js gui
```

The GUI runs at `http://127.0.0.1:20245/`. Use `--ui-port 20246` to change the port or `--no-open` to keep it from opening a browser automatically.
The GUI is organized into two compact tabs:

- **Config & Models**: endpoint, API key, 9router preset, and model mappings.
- **Proxy & System**: proxy start, DNS/certificate actions, Antigravity trust, and live status cards.

The `Apply 9router` preset fills `https://9router.phongdang.io.vn/v1`, sets the fallback prefix to `cx/`, and maps the built-in Antigravity aliases to `cx/gpt-5.5`. It does not embed an API key; enter the key in the GUI or keep it in your local `settings.json`.
Use `Apply DNS & Cert` in the **Proxy & System** tab to generate/trust the certificate and write the hosts redirect. On macOS/Linux, enter your sudo password in the GUI before clicking it.

Set the upstream endpoint, API key, and default Antigravity model mapping:

```bash
node mitm-oneclick.js config set \
  routerUrl=https://your-endpoint.example.com/v1/chat/completions \
  apiKey=sk-your-key \
  modelMap.gemini-3-flash=ag/gemini-3-flash \
  modelMap.claude-sonnet-4-6=ag/claude-sonnet-4-6
```

You can also force every intercepted request to one upstream model:

```bash
node mitm-oneclick.js config set model=ag/gemini-2.5-pro
```

## Run

macOS:

```bash
sudo node mitm-oneclick.js setup --force-cert
sudo node mitm-oneclick.js start
```

`setup` generates/trusts the certificate and rewrites the managed hosts block. `start` runs the HTTPS proxy on port 443.

Windows:

```bat
node mitm-oneclick.js start
```

Windows will prompt for UAC when it needs to install the certificate or edit the hosts file.

Stop DNS redirection:

```bash
node mitm-oneclick.js stop
```

Show status:

```bash
node mitm-oneclick.js status
```

Remove trusted certificate:

```bash
sudo node mitm-oneclick.js uninstall-cert
```

## One-off Options

All important settings can be overridden without editing config:

```bash
node mitm-oneclick.js start \
  --endpoint https://your-endpoint.example.com/v1/chat/completions \
  --api-key sk-your-key \
  --map gemini-2.5-pro=ag/gemini-2.5-pro \
  --map gemini-2.5-flash=ag/gemini-2.5-flash
```

Useful options:

- `--target-hosts`: Antigravity hosts to redirect. Default: `daily-cloudcode-pa.googleapis.com,cloudcode-pa.googleapis.com`
- `--target-host`: legacy single-host alias; the default host automatically expands to both Antigravity hosts
- `--skip-setup`: start the proxy without touching certificate or hosts entries
- `--remote-ip`: IP written to hosts. Default: `127.0.0.1`
- `--port`: local HTTPS proxy port. Default: `443`
- `--endpoint` or `--router-url`: upstream chat endpoint
- `--api-key`: upstream bearer token
- `--model`: force all intercepted requests to this upstream model
- `--map source=target`: add Antigravity model mapping; can be repeated
- `--model-map-file`: JSON mapping file, for example `{ "gemini-2.5-pro": "ag/gemini-2.5-pro" }`
- `--model-prefix`: prefix applied when no exact mapping exists. Default: `ag/`
- `--always-intercept`: intercept even when no mapping exists. Default is off, matching 9router behavior.
- `--mock-model-list`: return local Antigravity alias mappings for `fetchAvailableModels`. Default is off; model-list requests pass through to Google, matching 9router's MITM behavior.
- `gui`: starts the local configuration UI
- `--ui-port`: local GUI port. Default: `20245`
- `--no-open`: start the GUI server without opening a browser

## Build Windows and macOS Apps

```bash
npm run build
```

You can also run individual packaging steps:

```bash
npm run build:pkg
npm run build:mac-app
npm run build:win-portable
```

Outputs are written to `dist/` for:

- macOS Apple Silicon binary: `mitm-antigravity-macos-arm64`
- macOS Intel binary: `mitm-antigravity-macos-x64`
- Windows x64 binary: `mitm-antigravity-win-x64.exe`
- macOS Apple Silicon app: `MITM Antigravity-arm64.app`
- macOS Intel app: `MITM Antigravity-x64.app`
- Windows portable app folder: `MITM Antigravity Windows/`

Double-click a generated `.app` on macOS to start the local GUI. On Windows, open `MITM Antigravity Windows/` and double-click `Launch MITM Antigravity.bat`.

The built binary reads and writes `settings.json` next to the binary. The macOS `.app` bundles include `settings.json` under `Contents/Resources`; the Windows portable folder includes `settings.json` beside `MITM Antigravity.exe`. Certificates are kept in the user's home directory under `.mitm-antigravity`.
By default, `npm run build` strips `apiKey` from `dist/settings.json`, macOS app resources, and the Windows portable folder so packaged builds do not carry your local secret. Set `MITM_COPY_SETTINGS_WITH_SECRETS=true` only for a private build where you explicitly want to copy the key.

## Notes

- This app changes the system trust store and hosts file.
- If Antigravity uses certificate pinning, MITM will fail.
- Hosts redirection affects the whole target host, but only `:generateContent` and `:streamGenerateContent` are intercepted. Other paths are passed through.
- Existing `~/.9router/db.json` mappings under `mitmAlias.antigravity` are still used as a fallback.
- Default mappings use 9router-style Antigravity aliases such as `gemini-3.1-pro-high`, `gemini-3-flash`, `claude-sonnet-4-6`, `claude-opus-4-6-thinking`, and `gpt-oss-120b-medium`.
