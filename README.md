# mitm-antigravity

MITM app for Antigravity requests. It can:

1. Generate a TLS certificate for `daily-cloudcode-pa.googleapis.com` and `cloudcode-pa.googleapis.com`
2. Trust the certificate on macOS or Windows
3. Add a hosts/DNS redirect to the local proxy
4. Intercept Antigravity `:generateContent` and `:streamGenerateContent` requests
5. Forward intercepted requests to a configurable upstream endpoint with API key, model override, and model mapping

The Antigravity mapping behavior follows a conservative MITM flow: auth/bootstrap requests pass through, built-in Antigravity models pass through unless explicitly mapped, and custom aliases are merged into the model list then routed to your upstream endpoint.

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
The GUI is organized into two compact tabs:

- **Config & Models**: endpoint, API key, and custom model aliases.
- **Proxy & System**: proxy start, DNS/certificate actions, Antigravity trust, and live status cards.

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
- `--model-prefix`: prefix applied to custom aliases when no exact mapping exists. Built-in Antigravity models do not use this fallback.
- `--always-intercept`: intercept even when no mapping or prefix fallback exists. Default is off.
- `--mock-model-list`: return local custom aliases for `fetchAvailableModels`. Default is on for custom aliases; disable it to pass model-list requests through.
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

The `Model Mapping` tab is for built-in mappings and custom model aliases. Built-in Antigravity models use explicit mappings when configured, otherwise chat requests pass through to Google. Use `+ Create custom model` to define the Antigravity-visible name, upstream model, and optional `reasoning_effort`. Keep `Expose custom aliases to Antigravity model list` enabled to advertise these custom aliases to Antigravity.
Built-in Antigravity model rows cannot be deleted in the Mapping tab. Only custom models show a Remove action. Use `Save Mapping & Reload Proxy` after editing mappings so the running proxy process reloads the updated settings.
By default, `npm run build` and `npm run tauri:build` strip `apiKey` from packaged settings so packaged builds do not carry your local secret. Set `MITM_COPY_SETTINGS_WITH_SECRETS=true` only for a private build where you explicitly want to copy the key.

## Notes

- This app changes the system trust store and hosts file.
- If Antigravity uses certificate pinning, MITM will fail.
- Hosts redirection affects the whole target host, but only `:generateContent` and `:streamGenerateContent` are intercepted. Other paths are passed through.
- Existing legacy local mapping files can still be used as an optional backward-compatibility fallback.
- Built-in Antigravity aliases such as `gemini-3.1-pro-high`, `gemini-3-flash`, `claude-sonnet-4-6`, `claude-opus-4-6-thinking`, and `gpt-oss-120b-medium` can be mapped explicitly; otherwise chat requests pass through.
