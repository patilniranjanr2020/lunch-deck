use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};
use serde::{Deserialize, Serialize};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[cfg(unix)]
use std::os::unix::process::CommandExt;

pub struct ProcessEntry {
    pub pid: u32,
    pub generation: u64,
    pub is_stopping: bool,
}

#[derive(Clone)]
pub struct ProcessState {
    pub processes: Arc<Mutex<HashMap<String, ProcessEntry>>>,
    pub next_generation: Arc<AtomicU64>,
}

impl ProcessState {
    pub fn new() -> Self {
        Self {
            processes: Arc::new(Mutex::new(HashMap::new())),
            next_generation: Arc::new(AtomicU64::new(1)),
        }
    }

    pub fn stop_all(&self) {
        let pids: Vec<u32> = {
            let mut map = match self.processes.lock() {
                Ok(guard) => guard,
                Err(poisoned) => poisoned.into_inner(),
            };
            let pids = map.values().map(|entry| entry.pid).collect();
            map.clear();
            pids
        };

        for pid in pids {
            let _ = kill_pid(pid);
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
pub struct ProcessLogEntry {
    pub log_type: String,
    pub line: String,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct ProcessBatchLogPayload {
    pub id: String,
    pub generation: u64,
    pub entries: Vec<ProcessLogEntry>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct ProcessExitPayload {
    pub id: String,
    pub generation: u64,
    pub exit_code: Option<i32>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct SpawnResult {
    pub pid: u32,
    pub generation: u64,
}

#[tauri::command]
pub async fn spawn_process(
    id: String,
    command: String,
    cwd: Option<String>,
    generation: Option<u64>,
    app: AppHandle,
    state: State<'_, ProcessState>,
) -> Result<SpawnResult, String> {
    if command.trim().is_empty() {
        return Err("Command cannot be empty".into());
    }

    // Allocate generation ID
    let current_gen = match generation {
        Some(g) if g > 0 => {
            state.next_generation.fetch_max(g + 1, Ordering::SeqCst);
            g
        }
        _ => state.next_generation.fetch_add(1, Ordering::SeqCst),
    };

    // If an existing process exists for this runner ID, stop it without holding mutex
    let old_pid = {
        let mut map = state.processes.lock().map_err(|e| e.to_string())?;
        map.remove(&id).map(|entry| entry.pid)
    };
    if let Some(pid) = old_pid {
        let _ = tauri::async_runtime::spawn_blocking(move || {
            let _ = kill_pid(pid);
        }).await;
    }

    #[cfg(target_os = "windows")]
    let mut cmd = Command::new("cmd");
    #[cfg(target_os = "windows")]
    {
        cmd.args(["/C", &command]);
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    #[cfg(not(target_os = "windows"))]
    let mut cmd = Command::new("sh");
    #[cfg(not(target_os = "windows"))]
    {
        cmd.args(["-c", &command]);
        cmd.process_group(0);
    }

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

    // Store PID and generation in state
    {
        let mut map = state.processes.lock().map_err(|e| e.to_string())?;
        map.insert(
            id.clone(),
            ProcessEntry {
                pid,
                generation: current_gen,
                is_stopping: false,
            },
        );
    }

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    // Shared channel for ordered log batching
    let (tx, rx) = std::sync::mpsc::channel::<ProcessLogEntry>();

    // Stdout reader thread
    if let Some(stdout) = stdout {
        let tx_stdout = tx.clone();
        thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                match line {
                    Ok(line_str) => {
                        if tx_stdout
                            .send(ProcessLogEntry {
                                log_type: "stdout".into(),
                                line: line_str,
                            })
                            .is_err()
                        {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        });
    }

    // Stderr reader thread
    if let Some(stderr) = stderr {
        let tx_stderr = tx.clone();
        thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines() {
                match line {
                    Ok(line_str) => {
                        if tx_stderr
                            .send(ProcessLogEntry {
                                log_type: "stderr".into(),
                                line: line_str,
                            })
                            .is_err()
                        {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        });
    }

    // Drop initial sender so rx can detect EOF when both reader threads exit
    drop(tx);

    // Batching and emitting thread
    let app_handle_logs = app.clone();
    let runner_id_logs = id.clone();
    let gen_logs = current_gen;
    thread::spawn(move || {
        while let Ok(first_entry) = rx.recv() {
            let mut batch = vec![first_entry];
            let start = Instant::now();
            // Collect up to 50 lines or max 25ms delay to prevent IPC flooding while staying responsive
            while batch.len() < 50 && start.elapsed() < Duration::from_millis(25) {
                match rx.recv_timeout(Duration::from_millis(5)) {
                    Ok(entry) => batch.push(entry),
                    Err(_) => break,
                }
            }
            let _ = app_handle_logs.emit(
                "process-logs",
                ProcessBatchLogPayload {
                    id: runner_id_logs.clone(),
                    generation: gen_logs,
                    entries: batch,
                },
            );
        }
    });

    // Wait thread to clean up PID map and emit exit signal
    let processes_ref = Arc::clone(&state.processes);
    let app_handle_exit = app.clone();
    let runner_id_exit = id.clone();
    let gen_exit = current_gen;
    thread::spawn(move || {
        let exit_status = child.wait();
        let code = exit_status.ok().and_then(|s| s.code());

        {
            if let Ok(mut map) = processes_ref.lock() {
                if let Some(entry) = map.get(&runner_id_exit) {
                    if entry.generation == gen_exit {
                        map.remove(&runner_id_exit);
                    }
                }
            }
        }

        let _ = app_handle_exit.emit(
            "process-exit",
            ProcessExitPayload {
                id: runner_id_exit,
                generation: gen_exit,
                exit_code: code,
            },
        );
    });

    Ok(SpawnResult {
        pid,
        generation: current_gen,
    })
}

#[tauri::command]
pub async fn stop_process(id: String, state: State<'_, ProcessState>) -> Result<bool, String> {
    let target = {
        let mut map = state.processes.lock().map_err(|e| e.to_string())?;
        if let Some(entry) = map.get_mut(&id) {
            if entry.is_stopping {
                return Ok(true); // Stop is already in progress
            }
            entry.is_stopping = true;
            Some((entry.pid, entry.generation))
        } else {
            None
        }
    };

    if let Some((pid, generation)) = target {
        let processes_ref = Arc::clone(&state.processes);
        let id_clone = id.clone();

        // Perform OS termination on a background blocking worker so Tauri/UI is never blocked
        tauri::async_runtime::spawn_blocking(move || {
            let _ = kill_pid(pid);
            if let Ok(mut map) = processes_ref.lock() {
                if let Some(entry) = map.get(&id_clone) {
                    if entry.generation == generation {
                        map.remove(&id_clone);
                    }
                }
            }
        })
        .await
        .map_err(|e| format!("Termination worker failed: {}", e))?;

        Ok(true)
    } else {
        Ok(false)
    }
}

fn kill_pid(pid: u32) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let mut kill_cmd = Command::new("taskkill");
        kill_cmd.args(["/F", "/T", "/PID", &pid.to_string()]);
        kill_cmd.creation_flags(CREATE_NO_WINDOW);

        // Spawn taskkill and wait with a bounded timeout
        let mut child = kill_cmd.spawn().map_err(|e| format!("Failed to spawn taskkill: {}", e))?;

        let start = Instant::now();
        let timeout = Duration::from_secs(3);
        loop {
            match child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) => {
                    if start.elapsed() > timeout {
                        let _ = child.kill();
                        break;
                    }
                    thread::sleep(Duration::from_millis(50));
                }
                Err(_) => break,
            }
        }
        Ok(())
    }

    #[cfg(not(target_os = "windows"))]
    {
        let pgid_str = format!("-{}", pid);

        // Graceful termination first: SIGTERM to process group
        let _ = Command::new("kill").args(["-TERM", &pgid_str]).output();

        // Wait bounded time up to 1.5 seconds
        let start = Instant::now();
        let mut exited = false;
        while start.elapsed() < Duration::from_millis(1500) {
            if let Ok(status) = Command::new("kill").args(["-0", &pgid_str]).status() {
                if !status.success() {
                    exited = true;
                    break;
                }
            } else {
                exited = true;
                break;
            }
            thread::sleep(Duration::from_millis(50));
        }

        // Escalate to SIGKILL if still running
        if !exited {
            let _ = Command::new("kill").args(["-KILL", &pgid_str]).output();
        }
        Ok(())
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
        let mut cmd = Command::new("cmd");
        cmd.args(["/C", "start", "", trimmed]);
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd.spawn()
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
