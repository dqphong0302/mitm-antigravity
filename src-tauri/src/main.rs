use std::{
  path::PathBuf,
  process::{Child, Command, Stdio},
  sync::{Arc, Mutex},
  thread,
  time::Duration,
};

use tauri::Manager;

const GUI_URL: &str = "http://127.0.0.1:20245/";

struct BackendProcess(Arc<Mutex<Option<Child>>>);

fn resource_path(app: &tauri::App, name: &str) -> Result<PathBuf, String> {
  app.path()
    .resolve(format!("resources/{name}"), tauri::path::BaseDirectory::Resource)
    .map_err(|error| error.to_string())
}

fn backend_resource_name() -> &'static str {
  if cfg!(windows) {
    "mitm-antigravity-backend.exe"
  } else {
    "mitm-antigravity-backend"
  }
}

fn start_backend(app: &tauri::App) -> Result<BackendProcess, String> {
  let backend = resource_path(app, backend_resource_name())?;
  let mut command = Command::new(&backend);
  command
    .arg("gui")
    .arg("--no-open")
    .current_dir(backend.parent().unwrap_or_else(|| backend.as_path()))
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::null());

  #[cfg(unix)]
  {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(&backend, std::fs::Permissions::from_mode(0o755));
  }

  let child = command.spawn().map_err(|error| format!("Failed to start backend: {error}"))?;
  Ok(BackendProcess(Arc::new(Mutex::new(Some(child)))))
}

fn wait_for_gui() {
  thread::spawn(|| {
    for _ in 0..80 {
      if let Ok(response) = std::net::TcpStream::connect("127.0.0.1:20245") {
        drop(response);
        break;
      }
      thread::sleep(Duration::from_millis(125));
    }
  });
}

fn main() {
  tauri::Builder::default()
    .setup(|app| {
      let backend = start_backend(app)?;
      app.manage(backend);
      wait_for_gui();
      if let Some(window) = app.get_webview_window("main") {
        let _ = window.eval(&format!("window.location.replace('{}')", GUI_URL));
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
    .expect("error while running MITM Antigravity Tauri app");
}
