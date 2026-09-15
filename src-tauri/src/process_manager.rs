use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::{AppHandle, Emitter, State};
use serde::{Deserialize, Serialize};

pub struct ProcessState {
    pub processes: Arc<Mutex<HashMap<String, u32>>>, // runner_id -> pid
}

impl ProcessState {
    pub fn new() -> Self {
        Self {
            processes: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
pub struct ProcessLogPayload {
    pub id: String,
    pub line: String,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct ProcessExitPayload {
    pub id: String,
    pub exit_code: Option<i32>,
}

#[tauri::command]
pub fn spawn_process(
    id: String,
    command: String,
    cwd: Option<String>,
    app: AppHandle,
    state: State<'_, ProcessState>,
) -> Result<u32, String> {
    if command.trim().is_empty() {
        return Err("Command cannot be empty".into());
    }

    // Stop existing process with this ID if any
    let existing_pid = {
        let map = state.processes.lock().unwrap();
        map.get(&id).cloned()
    };
    if let Some(pid) = existing_pid {
        let _ = kill_pid(pid);
    }

    #[cfg(target_os = "windows")]
    let mut cmd = Command::new("cmd");
    #[cfg(target_os = "windows")]
    cmd.args(["/C", &command]);

    #[cfg(not(target_os = "windows"))]
    let mut cmd = Command::new("sh");
    #[cfg(not(target_os = "windows"))]
    cmd.args(["-c", &command]);

    // Set working directory if provided and valid
    if let Some(ref dir) = cwd {
        let trimmed = dir.trim();
        if !trimmed.is_empty() {
            cmd.current_dir(trimmed);
        }
    }

    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let mut child: Child = cmd.spawn().map_err(|e| format!("Failed to spawn command: {}", e))?;
    let pid = child.id();

    // Store PID
    {
        let mut map = state.processes.lock().unwrap();
        map.insert(id.clone(), pid);
    }

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    // Stream STDOUT
    if let Some(stdout) = stdout {
        let app_handle = app.clone();
        let runner_id = id.clone();
        thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                if let Ok(line_str) = line {
                    let _ = app_handle.emit(
                        "process-stdout",
                        ProcessLogPayload {
                            id: runner_id.clone(),
                            line: line_str,
                        },
                    );
                }
            }
        });
    }

    // Stream STDERR
    if let Some(stderr) = stderr {
        let app_handle = app.clone();
        let runner_id = id.clone();
        thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines() {
                if let Ok(line_str) = line {
                    let _ = app_handle.emit(
                        "process-stderr",
                        ProcessLogPayload {
                            id: runner_id.clone(),
                            line: line_str,
                        },
                    );
                }
            }
        });
    }

    // Wait thread to clean up PID map and emit exit signal
    let processes_ref = Arc::clone(&state.processes);
    let app_handle = app.clone();
    let runner_id = id.clone();
    thread::spawn(move || {
        let exit_status = child.wait();
        let code = exit_status.ok().and_then(|s| s.code());

        {
            let mut map = processes_ref.lock().unwrap();
            if map.get(&runner_id) == Some(&pid) {
                map.remove(&runner_id);
            }
        }

        let _ = app_handle.emit(
            "process-exit",
            ProcessExitPayload {
                id: runner_id,
                exit_code: code,
            },
        );
    });

    Ok(pid)
}

#[tauri::command]
pub fn stop_process(id: String, state: State<'_, ProcessState>) -> Result<bool, String> {
    let pid = {
        let mut map = state.processes.lock().unwrap();
        map.remove(&id)
    };

    if let Some(pid) = pid {
        kill_pid(pid)?;
        Ok(true)
    } else {
        Ok(false)
    }
}

fn kill_pid(pid: u32) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let output = Command::new("taskkill")
            .args(["/F", "/T", "/PID", &pid.to_string()])
            .output();
        match output {
            Ok(_) => Ok(()),
            Err(e) => Err(format!("Taskkill failed: {}", e)),
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let output = Command::new("kill")
            .args(["-9", &pid.to_string()])
            .output();
        match output {
            Ok(_) => Ok(()),
            Err(e) => Err(format!("Kill failed: {}", e)),
        }
    }
}

#[tauri::command]
pub fn open_url(url: String) -> Result<(), String> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return Err("URL cannot be empty".into());
    }

    #[cfg(target_os = "windows")]
    {
        Command::new("cmd")
            .args(["/C", "start", "", trimmed])
            .spawn()
            .map_err(|e| format!("Failed to open URL in browser: {}", e))?;
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(trimmed)
            .spawn()
            .map_err(|e| format!("Failed to open URL in browser: {}", e))?;
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        Command::new("xdg-open")
            .arg(trimmed)
            .spawn()
            .map_err(|e| format!("Failed to open URL in browser: {}", e))?;
    }

    Ok(())
}

