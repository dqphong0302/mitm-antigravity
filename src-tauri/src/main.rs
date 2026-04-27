use std::{
    env,
    fs::OpenOptions,
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};

use tauri::Manager;

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

fn wait_for_gui() -> bool {
    for _ in 0..80 {
        if let Ok(response) = std::net::TcpStream::connect("127.0.0.1:20245") {
            drop(response);
            return true;
        }
        thread::sleep(Duration::from_millis(125));
    }
    false
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let backend = start_backend(app)?;
            app.manage(backend);
            if let Some(window) = app.get_webview_window("main") {
                if wait_for_gui() {
                    let _ = window.eval(&format!("window.location.replace('{}')", GUI_URL));
                } else {
                    let log_path = backend_log_path()
                        .to_string_lossy()
                        .replace('\\', "\\\\")
                        .replace('\'', "\\'");
                    let _ = window.eval(&format!("document.body.innerHTML = '<main style=\"font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;padding:28px;color:#f8fafc;background:#111827;min-height:100vh\"><h1>Backend did not start</h1><p>Close and reopen MITM AG, or inspect the backend log:</p><pre style=\"white-space:pre-wrap;word-break:break-all;background:#020617;border:1px solid #334155;border-radius:8px;padding:12px\">{}</pre></main>'", log_path));
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                if let Some(state) = window.try_state::<BackendProcess>() {
                    if let Ok(mut child) = state.0.lock() {
                        if let Some(mut process) = child.take() {
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
