import { useState, useEffect, useMemo, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Plus, Square, Cpu, Layers } from 'lucide-react';
import { RunnerCard, RunnerConfig, RunnerStatus } from './components/RunnerCard';
import { extractUrls } from './utils/logParser';
import './styles.css';

const LOCAL_STORAGE_KEY = 'launchdeck_runners_v2';
const LEGACY_STORAGE_KEY = 'medflow_launcher_runners_v2';

const DEFAULT_RUNNERS: RunnerConfig[] = [
  {
    id: 'runner-1',
    name: 'Frontend Server',
    command: 'npm run dev',
    cwd: '',
    status: 'idle',
    isRunning: false,
    logs: [],
    detectedUrls: [],
    generation: 0,
  },
  {
    id: 'runner-2',
    name: 'Backend Service',
    command: 'mvn spring-boot:run',
    cwd: '',
    status: 'idle',
    isRunning: false,
    logs: [],
    detectedUrls: [],
    generation: 0,
  },
];

interface ProcessBatchPayload {
  id: string;
  generation: number;
  entries: Array<{ log_type: 'stdout' | 'stderr'; line: string }>;
}

interface ProcessExitPayload {
  id: string;
  generation: number;
  exit_code: number | null;
}

export function App() {
  const [runners, setRunners] = useState<RunnerConfig[]>(() => {
    try {
      const saved = localStorage.getItem(LOCAL_STORAGE_KEY) || localStorage.getItem(LEGACY_STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        // Ensure log array, running states, and generation counters reset on fresh app start
        return parsed.map((item: Partial<RunnerConfig>) => ({
          id: item.id || `runner-${Date.now()}-${Math.random()}`,
          name: item.name || 'Launcher Box',
          command: item.command || '',
          cwd: item.cwd || '',
          status: 'idle' as RunnerStatus,
          isRunning: false,
          logs: [],
          detectedUrls: [],
          generation: 0,
        }));
      }
    } catch (e) {
      console.error('Failed to load saved launchers:', e);
    }
    return DEFAULT_RUNNERS;
  });

  // Reference to always access current runners inside asynchronous event listeners
  const runnersRef = useRef<RunnerConfig[]>(runners);
  runnersRef.current = runners;

  // Persist configurations only when user-configured fields change (NOT on every log update)
  const configSignature = useMemo(() => {
    return JSON.stringify(
      runners.map(({ id, name, command, cwd }) => ({
        id,
        name,
        command,
        cwd,
      }))
    );
  }, [runners]);

  useEffect(() => {
    try {
      localStorage.setItem(LOCAL_STORAGE_KEY, configSignature);
    } catch (err) {
      console.error('Failed to save launcher configs:', err);
    }
  }, [configSignature]);

  // Setup Tauri event listeners for batched logs, legacy logs, and process-exit
  useEffect(() => {
    let isMounted = true;
    const cleanups: Array<() => void> = [];

    async function setupListeners() {
      try {
        // High-performance batched log listener
        const unlistenLogs = await listen<ProcessBatchPayload>('process-logs', (event) => {
          if (!isMounted) return;
          const { id, generation, entries } = event.payload;
          if (!entries || entries.length === 0) return;

          setRunners((prev) =>
            prev.map((r) => {
              if (r.id === id) {
                // Reject logs from older process generations
                if (generation !== undefined && r.generation !== undefined && generation < r.generation) {
                  return r;
                }

                // Incrementally extract URLs from newly arrived lines only
                const newUrls: string[] = [];
                for (const entry of entries) {
                  const found = extractUrls(entry.line);
                  for (const u of found) {
                    if (!r.detectedUrls?.includes(u) && !newUrls.includes(u)) {
                      newUrls.push(u);
                    }
                  }
                }

                const formattedEntries: Array<{ type: 'stdout' | 'stderr'; line: string }> = entries.map((e) => ({
                  type: e.log_type,
                  line: e.line,
                }));

                const nextLogs = [...r.logs, ...formattedEntries].slice(-300);
                const currentUrls = r.detectedUrls || [];
                const updatedUrls = newUrls.length > 0 ? [...currentUrls, ...newUrls] : currentUrls;

                return {
                  ...r,
                  logs: nextLogs,
                  detectedUrls: updatedUrls,
                };
              }
              return r;
            })
          );
        });
        if (isMounted) cleanups.push(unlistenLogs);
        else unlistenLogs();

        // Process exit listener with generation race protection
        const unlistenExit = await listen<ProcessExitPayload>('process-exit', (event) => {
          if (!isMounted) return;
          const { id, generation, exit_code } = event.payload;

          setRunners((prev) =>
            prev.map((r) => {
              if (r.id === id) {
                // Ignore stale exit event if a newer generation has already started
                if (generation !== undefined && r.generation !== undefined && generation < r.generation) {
                  return r;
                }

                const exitMsg = `[Process finished${exit_code !== null && exit_code !== undefined ? ` with exit code ${exit_code}` : ''}]`;
                return {
                  ...r,
                  status: 'idle',
                  isRunning: false,
                  logs: [...r.logs, { type: 'stdout' as const, line: exitMsg }].slice(-300),
                };
              }
              return r;
            })
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
          const nextLogs = [...r.logs, { type, line }].slice(-300);
          const currentUrls = r.detectedUrls || [];
          const newUrls = extractUrls(line).filter((u) => !currentUrls.includes(u));
          return {
            ...r,
            logs: nextLogs,
            detectedUrls: newUrls.length > 0 ? [...currentUrls, ...newUrls] : currentUrls,
          };
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
      status: 'idle',
      isRunning: false,
      logs: [],
      detectedUrls: [],
      generation: 0,
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
    if (target && (target.status === 'running' || target.status === 'starting' || target.status === 'stopping')) {
      await handleStopProcess(id);
    }
    setRunners((prev) => prev.filter((r) => r.id !== id));
  };

  const handleStartProcess = async (id: string) => {
    const target = runners.find((r) => r.id === id);
    if (!target || !target.command.trim()) return;

    // Prevent duplicate start attempts if already starting, running, or stopping
    if (target.status === 'starting' || target.status === 'running' || target.status === 'stopping') {
      return;
    }

    const nextGen = (target.generation || 0) + 1;

    // Immediately mark as Starting
    setRunners((prev) =>
      prev.map((r) =>
        r.id === id
          ? {
              ...r,
              status: 'starting' as RunnerStatus,
              isRunning: true,
              generation: nextGen,
              detectedUrls: [],
              logs: [
                ...r.logs,
                { type: 'stdout' as const, line: `[Starting process: ${target.command.trim()}...]` },
              ].slice(-300),
            }
          : r
      )
    );

    try {
      const res = await invoke<{ pid: number; generation: number }>('spawn_process', {
        id,
        command: target.command.trim(),
        cwd: target.cwd.trim() || null,
        generation: nextGen,
      });

      // Update to Running state with generation confirmed
      setRunners((prev) =>
        prev.map((r) =>
          r.id === id && r.generation === nextGen
            ? {
                ...r,
                status: 'running',
                isRunning: true,
                generation: res?.generation ?? nextGen,
              }
            : r
        )
      );
    } catch (err: any) {
      console.error(`Failed to start process for ${id}:`, err);
      const errMsg = err?.toString() || String(err);
      appendLog(id, 'stderr', `[LAUNCH FAILURE]: ${errMsg}`);
      setRunners((prev) =>
        prev.map((r) =>
          r.id === id && r.generation === nextGen
            ? { ...r, status: 'idle', isRunning: false }
            : r
        )
      );
    }
  };

  const handleStopProcess = async (id: string) => {
    const target = runners.find((r) => r.id === id);
    if (!target) return;

    // Avoid duplicate stops or stopping idle runners
    if (target.status === 'idle' || target.status === 'stopping') {
      return;
    }

    const currentGen = target.generation;

    // Immediately reflect Stopping state so button disables and indicates activity
    setRunners((prev) =>
      prev.map((r) =>
        r.id === id
          ? {
              ...r,
              status: 'stopping',
            }
          : r
      )
    );

    try {
      await invoke('stop_process', { id });
      // Reset runner state when stop command returns
      setRunners((prev) =>
        prev.map((r) =>
          r.id === id && r.generation === currentGen
            ? {
                ...r,
                status: 'idle',
                isRunning: false,
              }
            : r
        )
      );
    } catch (err: any) {
      console.error(`Failed to stop process for ${id}:`, err);
      const errMsg = err?.toString() || String(err);
      appendLog(id, 'stderr', `[STOP FAILURE]: ${errMsg}`);
      setRunners((prev) =>
        prev.map((r) =>
          r.id === id && r.generation === currentGen
            ? {
                ...r,
                status: 'idle',
                isRunning: false,
              }
            : r
        )
      );
    }
  };

  const handleClearLogs = (id: string) => {
    setRunners((prev) =>
      prev.map((r) => (r.id === id ? { ...r, logs: [], detectedUrls: [] } : r))
    );
  };

  const activeCount = runners.filter(
    (r) => r.status === 'running' || r.status === 'starting' || r.isRunning
  ).length;

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
          {runners.length > 0 && activeCount > 0 && (
            <button
              className="btn-secondary"
              onClick={() =>
                runners
                  .filter((r) => r.status === 'running' || r.status === 'starting')
                  .forEach((r) => handleStopProcess(r.id))
              }
            >
              <Square size={14} /> Stop All ({activeCount})
            </button>
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
