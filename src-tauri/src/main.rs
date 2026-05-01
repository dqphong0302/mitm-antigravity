#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    collections::BTreeSet,
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
use tauri::Url;
use tauri::WebviewUrl;
use tauri::WebviewWindowBuilder;
use tauri_plugin_updater::UpdaterExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[cfg(windows)]
fn hide_command_window(command: &mut Command) -> &mut Command {
    use std::os::windows::process::CommandExt;
    command.creation_flags(CREATE_NO_WINDOW)
}

fn js_escape(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('`', "\\`")
        .replace('$', "\\$")
}

const GUI_ADDR: &str = "127.0.0.1:20245";
const GUI_URL: &str = "http://127.0.0.1:20245/";
const GUI_PORT: &str = "20245";
const PROCESS_WAIT_ATTEMPTS: usize = 20;
const PROCESS_WAIT_DELAY: Duration = Duration::from_millis(100);
const GUI_WAIT_ATTEMPTS: usize = 80;
const GUI_WAIT_DELAY: Duration = Duration::from_millis(125);
const GUI_PROBE_TIMEOUT: Duration = Duration::from_millis(350);

struct BackendProcess(Arc<Mutex<Option<Child>>>);

fn backend_log_path() -> PathBuf {
    env::temp_dir().join("mitm-antigravity-backend.log")
}

fn proxy_log_path() -> PathBuf {
    env::temp_dir().join("mitm-antigravity-proxy.log")
}

fn append_startup_log(level: &str, message: &str) {
    let path = backend_log_path();
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "[tauri:{level}] {message}");
    }
}

#[cfg(windows)]
fn is_elevated() -> bool {
    let mut command = Command::new("net");
    hide_command_window(
        command
            .arg("session")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null()),
    )
    .status()
    .map(|status| status.success())
    .unwrap_or(false)
}

#[cfg(windows)]
fn relaunch_as_admin() {
    let Ok(exe) = std::env::current_exe() else {
        append_startup_log("error", "Failed to resolve current exe for elevation");
        return;
    };
    let exe_arg = exe.to_string_lossy().replace('\'', "''");
    let script = format!(
        "$psi = [System.Diagnostics.ProcessStartInfo]::new(); \
         $psi.FileName = '{exe_arg}'; \
         $psi.UseShellExecute = $true; \
         $psi.Verb = 'runas'; \
         $psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden; \
         [System.Diagnostics.Process]::Start($psi) | Out-Null"
    );
    let mut command = Command::new("powershell");
    let _ = hide_command_window(
        command
            .args(["-NoProfile", "-WindowStyle", "Hidden", "-Command", &script])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null()),
    )
    .spawn();
}

#[cfg(unix)]
fn old_app_instance_pids() -> Vec<u32> {
    let Ok(output) = Command::new("ps").args(["-axo", "pid=,command="]).output() else {
        return Vec::new();
    };
    let current_pid = std::process::id();

    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let trimmed = line.trim();
            let (pid_text, command) = trimmed.split_once(char::is_whitespace)?;
            let pid = pid_text.trim().parse::<u32>().ok()?;
            if pid == current_pid {
                return None;
            }
            let is_mitm_app = command.contains("MITM AG.app/Contents/MacOS/")
                || command.contains("MITM Antigravity.app/Contents/MacOS/");
            is_mitm_app.then_some(pid)
        })
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

#[cfg(windows)]
fn old_app_instance_pids() -> Vec<u32> {
    let current_pid = std::process::id().to_string();
    let script = format!(
        "$current = {current_pid}; \
         Get-CimInstance Win32_Process | \
         Where-Object {{ $_.ProcessId -ne $current -and ( \
           $_.Name -eq 'MITM AG.exe' -or \
           $_.Name -eq 'mitm-ag-tauri.exe' -or \
           ($_.ExecutablePath -like '*\\MITM AG.exe') -or \
           ($_.CommandLine -like '*MITM AG.exe*') -or \
           ($_.CommandLine -like '*mitm-ag-tauri.exe*') \
         ) }} | Select-Object -ExpandProperty ProcessId"
    );
    let mut command = Command::new("powershell");
    let Ok(output) = hide_command_window(
        command.args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            &script,
        ]),
    )
    .output()
    else {
        return Vec::new();
    };

    String::from_utf8_lossy(&output.stdout)
        .split_whitespace()
        .filter_map(|item| item.trim().parse::<u32>().ok())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

fn wait_until_pids_exit(pids: &[u32]) -> bool {
    for _ in 0..PROCESS_WAIT_ATTEMPTS {
        let remaining: BTreeSet<u32> = old_app_instance_pids()
            .into_iter()
            .filter(|pid| pids.contains(pid))
            .collect();
        if remaining.is_empty() {
            return true;
        }
        thread::sleep(PROCESS_WAIT_DELAY);
    }
    false
}

fn terminate_old_app_instances() {
    let pids = old_app_instance_pids();
    if pids.is_empty() {
        return;
    }

    append_startup_log(
        "info",
        &format!("Terminating older MITM AG app instances: {pids:?}"),
    );

    #[cfg(unix)]
    {
        for pid in &pids {
            let _ = Command::new("kill")
                .args(["-TERM", &pid.to_string()])
                .status();
        }
        if !wait_until_pids_exit(&pids) {
            for pid in &pids {
                let _ = Command::new("kill")
                    .args(["-KILL", &pid.to_string()])
                    .status();
            }
            let _ = wait_until_pids_exit(&pids);
        }
    }

    #[cfg(windows)]
    {
        for pid in &pids {
            let mut command = Command::new("taskkill");
            let _ = hide_command_window(
                command
                    .args(["/PID", &pid.to_string(), "/T", "/F"])
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null()),
            )
            .status();
        }
        let _ = wait_until_pids_exit(&pids);
    }
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

    #[cfg(windows)]
    {
        hide_command_window(&mut command);
    }

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

#[cfg(unix)]
fn gui_port_owner_pids() -> Vec<u32> {
    let Ok(output) = Command::new("lsof")
        .args(["-nP", &format!("-tiTCP:{GUI_PORT}"), "-sTCP:LISTEN"])
        .output()
    else {
        return Vec::new();
    };

    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| line.trim().parse::<u32>().ok())
        .filter(|pid| *pid != std::process::id())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

#[cfg(windows)]
fn gui_port_owner_pids() -> Vec<u32> {
    let mut command = Command::new("netstat");
    let Ok(output) = hide_command_window(command.args(["-ano", "-p", "tcp"]))
        .output()
    else {
        return Vec::new();
    };

    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter(|line| line.contains("LISTENING"))
        .filter(|line| {
            let fields: Vec<&str> = line.split_whitespace().collect();
            fields
                .get(1)
                .is_some_and(|local| local.ends_with(&format!(":{GUI_PORT}")))
        })
        .filter_map(|line| line.split_whitespace().last()?.parse::<u32>().ok())
        .filter(|pid| *pid != std::process::id())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

fn wait_until_gui_port_free() -> bool {
    for _ in 0..PROCESS_WAIT_ATTEMPTS {
        if gui_port_owner_pids().is_empty() {
            return true;
        }
        thread::sleep(PROCESS_WAIT_DELAY);
    }
    false
}

fn free_gui_port() {
    let pids = gui_port_owner_pids();
    if pids.is_empty() {
        return;
    }

    append_startup_log(
        "info",
        &format!("Freeing GUI port {GUI_PORT}; terminating owners: {pids:?}"),
    );

    #[cfg(unix)]
    {
        for pid in &pids {
            let _ = Command::new("kill")
                .args(["-TERM", &pid.to_string()])
                .status();
        }
        if !wait_until_gui_port_free() {
            for pid in gui_port_owner_pids() {
                let _ = Command::new("kill")
                    .args(["-KILL", &pid.to_string()])
                    .status();
            }
            let _ = wait_until_gui_port_free();
        }
    }

    #[cfg(windows)]
    {
        for pid in &pids {
            let mut command = Command::new("taskkill");
            let _ = hide_command_window(
                command
                    .args(["/PID", &pid.to_string(), "/T", "/F"])
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null()),
            )
            .status();
        }
        let _ = wait_until_gui_port_free();
    }

    let remaining = gui_port_owner_pids();
    if remaining.is_empty() {
        append_startup_log("info", &format!("GUI port {GUI_PORT} is free"));
    } else {
        append_startup_log(
            "warn",
            &format!("GUI port {GUI_PORT} is still occupied by: {remaining:?}"),
        );
    }
}

fn read_gui_probe() -> Option<String> {
    let mut stream = TcpStream::connect(GUI_ADDR).ok()?;
    let _ = stream.set_read_timeout(Some(GUI_PROBE_TIMEOUT));
    let _ = stream.set_write_timeout(Some(GUI_PROBE_TIMEOUT));
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
            && (response.contains("\"configPath\"") || response.contains("\"settingsPath\""))
    })
}

fn wait_for_gui() -> bool {
    for _ in 0..GUI_WAIT_ATTEMPTS {
        if is_mitm_gui_server() {
            return true;
        }
        thread::sleep(GUI_WAIT_DELAY);
    }
    false
}

fn backend_error_script(log_path: &str) -> String {
    let log_path = js_escape(log_path);
    format!(
        r#"(function(){{
  var target = '{GUI_URL}';
  function retry() {{
    fetch(target + 'api/bootstrap', {{ cache: 'no-store' }})
      .then(function(response) {{
        if (response.ok) window.location.replace(target);
      }})
      .catch(function() {{}});
  }}
  document.body.innerHTML = `<main style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;padding:28px;color:#f8fafc;background:#111827;min-height:100vh">
    <h1>Backend did not start</h1>
    <p>MITM AG is freeing port {GUI_PORT} and waiting for the backend. This page will open automatically when it is ready.</p>
    <pre style="white-space:pre-wrap;word-break:break-all;background:#020617;border:1px solid #334155;border-radius:8px;padding:12px">{log_path}</pre>
  </main>`;
  retry();
  setInterval(retry, 750);
}})();"#
    )
}

fn navigate_to_gui(window: &tauri::WebviewWindow) {
    if let Ok(url) = Url::parse(GUI_URL) {
        let _ = window.navigate(url);
    }
    let _ = window.eval(&format!("window.location.replace('{GUI_URL}')"));
    let retry_window = window.clone();
    tauri::async_runtime::spawn(async move {
        thread::sleep(Duration::from_millis(350));
        if let Ok(url) = Url::parse(GUI_URL) {
            let _ = retry_window.navigate(url);
        }
        let _ = retry_window.eval(&format!("window.location.replace('{GUI_URL}')"));
    });
}

fn create_main_window(app: &tauri::App) -> Result<tauri::WebviewWindow, String> {
    let url = Url::parse(GUI_URL).map_err(|error| error.to_string())?;
    WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
        .title("MITM AG")
        .inner_size(1180.0, 820.0)
        .min_inner_size(980.0, 680.0)
        .build()
        .map_err(|error| error.to_string())
}

fn check_for_updates(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        // Kiểm tra update trong background – không block UI
        let Ok(updater) = app.updater() else { return };
        let Ok(Some(update)) = updater.check().await else {
            return;
        };

        let version = js_escape(&update.version);
        let repo = "https://github.com/dqphong0302/mitm-antigravity/releases/latest";

        // Inject banner vào GUI – không cần plugin dialog
        // Người dùng tự click "Download" để tải bản mới từ GitHub Releases.
        if let Some(window) = app.get_webview_window("main") {
            let script = format!(
                r#"(function(){{
  if(document.getElementById('mitm-update-banner'))return;
  var b=document.createElement('div');
  b.id='mitm-update-banner';
  b.style='position:fixed;top:0;left:0;right:0;z-index:99999;background:#0ea5e9;color:#fff;padding:8px 16px;display:flex;align-items:center;justify-content:space-between;font-size:13px;font-family:system-ui;box-shadow:0 2px 8px rgba(0,0,0,.25);';
  b.innerHTML='<span>📦 MITM AG <strong>`{version}`</strong> is available.</span>'
    +'<span><a href="`{repo}`" target="_blank" style="color:#fff;font-weight:700;margin-right:12px;">Download</a>'
    +'<button onclick="this.closest(\'#mitm-update-banner\').remove()" style="background:rgba(255,255,255,.2);border:none;color:#fff;padding:3px 10px;cursor:pointer;border-radius:4px;">✕</button></span>';
  document.body.prepend(b);
}})();"#
            );
            let _ = window.eval(&script);
        }
    });
}

fn main() {
    #[cfg(windows)]
    if !is_elevated() {
        append_startup_log("info", "Relaunching MITM AG as administrator");
        relaunch_as_admin();
        return;
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            terminate_old_app_instances();
            free_gui_port();
            let backend = start_backend(app)?;
            app.manage(backend);

            // Kiểm tra update sau khi window load xong (fire-and-forget)
            let window = create_main_window(app)?;
            if wait_for_gui() {
                navigate_to_gui(&window);
                check_for_updates(app.handle().clone());
            } else {
                let log_path = backend_log_path()
                    .to_string_lossy()
                    .replace('\\', "\\\\")
                    .replace('\'', "\\'");
                let _ = window.eval(&backend_error_script(&log_path));
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
                                for _ in 0..PROCESS_WAIT_ATTEMPTS {
                                    thread::sleep(PROCESS_WAIT_DELAY);
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
