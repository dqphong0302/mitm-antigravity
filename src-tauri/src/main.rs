use std::{
    env,
    fs::OpenOptions,
    io::{Read, Write},
    net::TcpStream,
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};

use tauri::Manager;
use tauri_plugin_updater::UpdaterExt;

fn js_escape(s: &str) -> String {
    s.replace('\\', "\\\\")
     .replace('`',  "\\`")
     .replace('$',  "\\$")
}

const GUI_ADDR: &str = "127.0.0.1:20245";
const GUI_URL: &str = "http://127.0.0.1:20245/";

struct BackendProcess(Arc<Mutex<Option<Child>>>);

fn backend_log_path() -> PathBuf {
    env::temp_dir().join("mitm-antigravity-backend.log")
}

fn proxy_log_path() -> PathBuf {
    env::temp_dir().join("mitm-antigravity-proxy.log")
}

fn resource_path(app: &tauri::App, name: &str) -> Result<PathBuf, String> {
    app.path()
        .resolve(
            format!("resources/{name}"),
            tauri::path::BaseDirectory::Resource,
        )
        .map_err(|error| error.to_string())
}

fn backend_resource_name() -> &'static str {
    if cfg!(windows) {
        "mitm-ag-backend.exe"
    } else {
        "mitm-ag-backend"
    }
}

fn start_backend(app: &tauri::App) -> Result<BackendProcess, String> {
    let backend = resource_path(app, backend_resource_name())?;
    let backend_log = backend_log_path();
    let log_file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&backend_log)
        .map_err(|error| format!("Failed to open backend log: {error}"))?;
    let stderr_log = log_file
        .try_clone()
        .map_err(|error| format!("Failed to clone backend log: {error}"))?;
    let mut command = Command::new(&backend);
    command
        .arg("gui")
        .arg("--no-open")
        .current_dir(backend.parent().unwrap_or_else(|| backend.as_path()))
        .env("MITM_APP_LOG", &backend_log)
        .env("MITM_PROXY_LOG", proxy_log_path())
        .stdin(Stdio::null())
        .stdout(Stdio::from(log_file))
        .stderr(Stdio::from(stderr_log));

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&backend, std::fs::Permissions::from_mode(0o755));
    }

    let child = command
        .spawn()
        .map_err(|error| format!("Failed to start backend: {error}"))?;
    Ok(BackendProcess(Arc::new(Mutex::new(Some(child)))))
}

fn read_gui_probe() -> Option<String> {
    let mut stream = TcpStream::connect(GUI_ADDR).ok()?;
    let timeout = Some(Duration::from_millis(350));
    let _ = stream.set_read_timeout(timeout);
    let _ = stream.set_write_timeout(timeout);
    stream
        .write_all(
            b"GET /api/bootstrap HTTP/1.1\r\nHost: 127.0.0.1:20245\r\nConnection: close\r\n\r\n",
        )
        .ok()?;

    let mut response = Vec::new();
    stream.read_to_end(&mut response).ok()?;
    Some(String::from_utf8_lossy(&response).into_owned())
}

fn is_mitm_gui_server() -> bool {
    read_gui_probe().is_some_and(|response| {
        response.starts_with("HTTP/1.1 200")
            && response.contains("\"antigravityAliases\"")
            && response.contains("\"settingsPath\"")
    })
}

fn wait_for_gui() -> bool {
    for _ in 0..80 {
        if is_mitm_gui_server() {
            return true;
        }
        thread::sleep(Duration::from_millis(125));
    }
    false
}

fn check_for_updates(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        // Kiểm tra update trong background – không block UI
        let Ok(updater) = app.updater() else { return };
        let Ok(Some(update)) = updater.check().await else { return };

        let version = js_escape(&update.version);
        let repo    = "https://github.com/dqphong0302/mitm-antigravity/releases/latest";

        // Inject banner vào GUI – không cần plugin dialog
        // Người dùng tự click "Download" để tải bản mới từ GitHub Releases.
        if let Some(window) = app.get_webview_window("main") {
            let script = format!(r#"(function(){{
  if(document.getElementById('mitm-update-banner'))return;
  var b=document.createElement('div');
  b.id='mitm-update-banner';
  b.style='position:fixed;top:0;left:0;right:0;z-index:99999;background:#0ea5e9;color:#fff;padding:8px 16px;display:flex;align-items:center;justify-content:space-between;font-size:13px;font-family:system-ui;box-shadow:0 2px 8px rgba(0,0,0,.25);';
  b.innerHTML='<span>📦 MITM AG <strong>`{version}`</strong> is available.</span>'
    +'<span><a href="`{repo}`" target="_blank" style="color:#fff;font-weight:700;margin-right:12px;">Download</a>'
    +'<button onclick="this.closest(\'#mitm-update-banner\').remove()" style="background:rgba(255,255,255,.2);border:none;color:#fff;padding:3px 10px;cursor:pointer;border-radius:4px;">✕</button></span>';
  document.body.prepend(b);
}})();"#);
            let _ = window.eval(&script);
        }
    });
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let backend = if is_mitm_gui_server() {
                BackendProcess(Arc::new(Mutex::new(None)))
            } else {
                start_backend(app)?
            };
            app.manage(backend);

            // Kiểm tra update sau khi window load xong (fire-and-forget)
            check_for_updates(app.handle().clone());

            if let Some(window) = app.get_webview_window("main") {
                if wait_for_gui() {
                    let _ = window.eval(&format!("window.location.replace('{}')", GUI_URL));
                } else {
                    let log_path = backend_log_path()
                        .to_string_lossy()
                        .replace('\\', "\\\\")
                        .replace('\'', "\\'");
                    let _ = window.eval(&format!("document.body.innerHTML = '<main style=\"font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;padding:28px;color:#f8fafc;background:#111827;min-height:100vh\"><h1>Backend did not start</h1><p>Close and reopen MITM AG, ensure port 20245 is free, or inspect the backend log:</p><pre style=\"white-space:pre-wrap;word-break:break-all;background:#020617;border:1px solid #334155;border-radius:8px;padding:12px\">{}</pre></main>'", log_path));
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                if let Some(state) = window.try_state::<BackendProcess>() {
                    if let Ok(mut child) = state.0.lock() {
                        if let Some(mut process) = child.take() {
                            // Trên Unix: gửi SIGTERM trước để backend Node.js đóng graceful
                            // (đóng HTTP server qua signal handler), rồi mới SIGKILL nếu cần.
                            #[cfg(unix)]
                            {
                                let pid = process.id();
                                let _ = Command::new("kill")
                                    .args(["-TERM", &pid.to_string()])
                                    .status();
                                // Chờ tối đa 2 giây để process thoát sạch
                                for _ in 0..20 {
                                    thread::sleep(Duration::from_millis(100));
                                    if let Ok(Some(_)) = process.try_wait() {
                                        return;
                                    }
                                }
                            }
                            // Fallback: force kill (cũng là đường duy nhất trên Windows)
                            let _ = process.kill();
                            let _ = process.wait();
                        }
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running MITM AG Tauri app");
}
