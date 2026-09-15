import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Plus, Square, Cpu, Layers } from 'lucide-react';
import { RunnerCard, RunnerConfig } from './components/RunnerCard';
import './styles.css';

const LOCAL_STORAGE_KEY = 'launchdeck_runners_v2';
const LEGACY_STORAGE_KEY = 'medflow_launcher_runners_v2';

const DEFAULT_RUNNERS: RunnerConfig[] = [
  {
    id: 'runner-1',
    name: 'Frontend Server',
    command: 'npm run dev',
    cwd: '',
    isRunning: false,
    logs: [],
  },
  {
    id: 'runner-2',
    name: 'Backend Service',
    command: 'mvn spring-boot:run',
    cwd: '',
    isRunning: false,
    logs: [],
  },
];

export function App() {
  const [runners, setRunners] = useState<RunnerConfig[]>(() => {
    try {
      const saved = localStorage.getItem(LOCAL_STORAGE_KEY) || localStorage.getItem(LEGACY_STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        // Ensure log array and running state reset on fresh app start
        return parsed.map((item: Partial<RunnerConfig>) => ({
          id: item.id || `runner-${Date.now()}-${Math.random()}`,
          name: item.name || 'Launcher Box',
          command: item.command || '',
          cwd: item.cwd || '',
          isRunning: false,
          logs: [],
        }));
      }
    } catch (e) {
      console.error('Failed to load saved launchers:', e);
    }
    return DEFAULT_RUNNERS;
  });

  // Save configurations (name, command, cwd) to local storage
  useEffect(() => {
    const toSave = runners.map(({ id, name, command, cwd }) => ({
      id,
      name,
      command,
      cwd,
    }));
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(toSave));
  }, [runners]);

  // Setup Tauri event listeners for stdout, stderr, process-exit
  useEffect(() => {
    let isMounted = true;
    const cleanups: Array<() => void> = [];

    async function setupListeners() {
      try {
        const unlistenStdout = await listen<{ id: string; line: string }>('process-stdout', (event) => {
          if (!isMounted) return;
          const { id, line } = event.payload;
          appendLog(id, 'stdout', line);
        });
        if (isMounted) cleanups.push(unlistenStdout);
        else unlistenStdout();

        const unlistenStderr = await listen<{ id: string; line: string }>('process-stderr', (event) => {
          if (!isMounted) return;
          const { id, line } = event.payload;
          appendLog(id, 'stderr', line);
        });
        if (isMounted) cleanups.push(unlistenStderr);
        else unlistenStderr();

        const unlistenExit = await listen<{ id: string; exit_code: number | null }>('process-exit', (event) => {
          if (!isMounted) return;
          const { id, exit_code } = event.payload;
          setRunners((prev) =>
            prev.map((r) =>
              r.id === id
                ? {
                    ...r,
                    isRunning: false,
                    logs: [
                      ...r.logs,
                      {
                        type: 'stdout' as const,
                        line: `[Process finished${exit_code !== null && exit_code !== undefined ? ` with exit code ${exit_code}` : ''}]`,
                      },
                    ].slice(-300),
                  }
                : r
            )
          );
        });
        if (isMounted) cleanups.push(unlistenExit);
        else unlistenExit();
      } catch (err) {
        console.warn('Tauri event listener setup warning (likely non-Tauri browser context):', err);
      }
    }

    setupListeners();

    return () => {
      isMounted = false;
      cleanups.forEach((unlisten) => unlisten());
    };
  }, []);

  const appendLog = (id: string, type: 'stdout' | 'stderr', line: string) => {
    setRunners((prev) =>
      prev.map((r) => {
        if (r.id === id) {
          // Limit logs buffer to latest 300 lines
          const nextLogs = [...r.logs, { type, line }].slice(-300);
          return { ...r, logs: nextLogs };
        }
        return r;
      })
    );
  };

  // Dynamically add a new runner box
  const handleAddRunner = (presetName?: string, presetCmd?: string) => {
    const newId = `runner-${Date.now()}`;
    const newRunner: RunnerConfig = {
      id: newId,
      name: presetName || `Runner ${runners.length + 1}`,
      command: presetCmd || '',
      cwd: '',
      isRunning: false,
      logs: [],
    };
    setRunners((prev) => [...prev, newRunner]);
  };

  const handleUpdateRunner = (id: string, updates: Partial<RunnerConfig>) => {
    setRunners((prev) =>
      prev.map((r) => (r.id === id ? { ...r, ...updates } : r))
    );
  };

  const handleRemoveRunner = async (id: string) => {
    const target = runners.find((r) => r.id === id);
    if (target?.isRunning) {
      await handleStopProcess(id);
    }
    setRunners((prev) => prev.filter((r) => r.id !== id));
  };

  const handleStartProcess = async (id: string) => {
    const target = runners.find((r) => r.id === id);
    if (!target || !target.command.trim()) return;

    try {
      // Mark running in state
      setRunners((prev) =>
        prev.map((r) => (r.id === id ? { ...r, isRunning: true } : r))
      );

      await invoke('spawn_process', {
        id,
        command: target.command.trim(),
        cwd: target.cwd.trim() || null,
      });
    } catch (err: any) {
      console.error(`Failed to start process for ${id}:`, err);
      appendLog(id, 'stderr', `[LAUNCH FAILURE]: ${err?.toString() || err}`);
      setRunners((prev) =>
        prev.map((r) => (r.id === id ? { ...r, isRunning: false } : r))
      );
    }
  };

  const handleStopProcess = async (id: string) => {
    try {
      await invoke('stop_process', { id });
      setRunners((prev) =>
        prev.map((r) => (r.id === id ? { ...r, isRunning: false } : r))
      );
    } catch (err) {
      console.error(`Failed to stop process for ${id}:`, err);
    }
  };

  const handleClearLogs = (id: string) => {
    setRunners((prev) =>
      prev.map((r) => (r.id === id ? { ...r, logs: [] } : r))
    );
  };

  const activeCount = runners.filter((r) => r.isRunning).length;

  return (
    <div className="app-container">
      {/* App Header */}
      <header className="app-header">
        <div className="brand-section">
          <div className="brand-icon-wrapper">
            <Cpu size={24} />
          </div>
          <div className="brand-text">
            <h1>LaunchDeck</h1>
            <p>Multi-Process Developer Launcher</p>
          </div>
        </div>

        <div className="header-actions">
          {runners.length > 0 && (
            <>
              {activeCount > 0 && (
                <button
                  className="btn-secondary"
                  onClick={() => runners.filter((r) => r.isRunning).forEach((r) => handleStopProcess(r.id))}
                >
                  <Square size={14} /> Stop All ({activeCount})
                </button>
              )}
            </>
          )}

          {/* Primary "Add" Button dynamically creates new configuration row/box */}
          <button
            className="btn-add-primary"
            onClick={() => handleAddRunner()}
          >
            <Plus size={18} /> Add Runner Box
          </button>
        </div>
      </header>

      {/* Dashboard Status Bar */}
      <div className="dashboard-bar">
        <div className="bar-stats">
          <span className="stat-pill">
            <span className="stat-dot running"></span> {activeCount} Active
          </span>
          <span className="stat-pill">
            <span className="stat-dot idle"></span> {runners.length - activeCount} Idle
          </span>
          <span className="stat-pill">
            <Layers size={14} /> {runners.length} Total Configured
          </span>
        </div>
      </div>

      {/* Main Launcher Dashboard Area */}
      {runners.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon-circle">
            <Plus size={32} />
          </div>
          <h3>No Process Runners Added</h3>
          <p>
            Click the "Add Runner Box" button above to configure and launch your background dev commands independently.
          </p>
          <button className="btn-add-primary" onClick={() => handleAddRunner()}>
            <Plus size={18} /> Add First Launcher Box
          </button>
        </div>
      ) : (
        <div className="runner-list">
          {runners.map((runner) => (
            <RunnerCard
              key={runner.id}
              runner={runner}
              onUpdate={handleUpdateRunner}
              onRemove={handleRemoveRunner}
              onStart={handleStartProcess}
              onStop={handleStopProcess}
              onClearLogs={handleClearLogs}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default App;
