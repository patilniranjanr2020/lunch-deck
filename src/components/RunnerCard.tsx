import React, { useState, useRef, useEffect, useMemo } from 'react';
import {
  Play,
  Square,
  Terminal,
  Trash2,
  Folder,
  Command as CommandIcon,
  ChevronDown,
  ChevronUp,
  Globe,
  ExternalLink,
  Copy,
  Check,
} from 'lucide-react';
import { LogLine, extractUrls, stripAnsi, openUrlInBrowser } from '../utils/logParser';

export interface RunnerConfig {
  id: string;
  name: string;
  command: string;
  cwd: string;
  isRunning: boolean;
  logs: Array<{ type: 'stdout' | 'stderr'; line: string }>;
}

interface RunnerCardProps {
  runner: RunnerConfig;
  onUpdate: (id: string, updates: Partial<RunnerConfig>) => void;
  onRemove: (id: string) => void;
  onStart: (id: string) => void;
  onStop: (id: string) => void;
  onClearLogs: (id: string) => void;
}

export const RunnerCard: React.FC<RunnerCardProps> = ({
  runner,
  onUpdate,
  onRemove,
  onStart,
  onStop,
  onClearLogs,
}) => {
  const [showLogs, setShowLogs] = useState(false);
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);
  const [copiedLogs, setCopiedLogs] = useState(false);
  const logEndRef = useRef<HTMLDivElement | null>(null);

  // Command input text determines whether Start button dynamically appears
  const hasCommand = runner.command.trim().length > 0;

  // Auto-scroll to bottom of logs when new lines arrive
  useEffect(() => {
    if (showLogs && logEndRef.current) {
      logEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [runner.logs.length, showLogs]);

  // Extract all unique URLs detected across the runner's logs
  const detectedUrls = useMemo(() => {
    const list: string[] = [];
    for (const log of runner.logs) {
      const urls = extractUrls(log.line);
      for (const u of urls) {
        if (!list.includes(u)) {
          list.push(u);
        }
      }
    }
    return list;
  }, [runner.logs]);

  // Prefer localhost or 127.0.0.1 as the primary live link
  const primaryUrl = useMemo(() => {
    if (detectedUrls.length === 0) return null;
    const local = detectedUrls.find((u) => u.includes('localhost') || u.includes('127.0.0.1'));
    return local || detectedUrls[0];
  }, [detectedUrls]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && hasCommand && !runner.isRunning) {
      onStart(runner.id);
    }
  };

  const handleCopyUrl = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopiedUrl(url);
      setTimeout(() => setCopiedUrl(null), 2000);
    } catch (err) {
      console.error('Failed to copy URL:', err);
    }
  };

  const handleCopyAllLogs = async () => {
    const cleanAll = runner.logs.map((l) => stripAnsi(l.line)).join('\n');
    try {
      await navigator.clipboard.writeText(cleanAll);
      setCopiedLogs(true);
      setTimeout(() => setCopiedLogs(false), 2000);
    } catch (err) {
      console.error('Failed to copy logs:', err);
    }
  };

  // Friendly short display for header badge (e.g. localhost:5173)
  const formatUrlForBadge = (url: string) => {
    return url.replace(/^https?:\/\//, '').replace(/\/$/, '');
  };

  return (
    <div className={`runner-card ${runner.isRunning ? 'is-running' : ''}`}>
      {/* Top Bar: Title, Status, Live Web Link & Remove */}
      <div className="card-header-line">
        <div className="card-title-group">
          <input
            type="text"
            className="runner-name-input"
            value={runner.name}
            onChange={(e) => onUpdate(runner.id, { name: e.target.value })}
            placeholder="Runner Name"
          />
          <span className={`status-badge ${runner.isRunning ? 'running' : 'idle'}`}>
            {runner.isRunning ? (
              <>
                <span className="pulse-dot"></span> Running
              </>
            ) : (
              'Idle'
            )}
          </span>

          {/* Prominent Live Website Link Badge */}
          {primaryUrl && (
            <div className="live-url-badge-group">
              <button
                type="button"
                className="btn-live-pill"
                onClick={() => openUrlInBrowser(primaryUrl)}
                title={`Open ${primaryUrl} in default browser`}
              >
                <Globe size={13} className="pill-globe-icon" />
                <span className="pill-url-label">{formatUrlForBadge(primaryUrl)}</span>
                <ExternalLink size={12} className="pill-ext-icon" />
              </button>
              <button
                type="button"
                className="btn-pill-copy"
                onClick={() => handleCopyUrl(primaryUrl)}
                title="Copy live URL"
              >
                {copiedUrl === primaryUrl ? (
                  <Check size={12} className="text-success" />
                ) : (
                  <Copy size={12} />
                )}
              </button>
            </div>
          )}
        </div>

        <div className="card-top-actions">
          <button
            className="btn-icon danger"
            onClick={() => onRemove(runner.id)}
            title="Remove Launcher Box"
          >
            <Trash2 size={16} />
          </button>
        </div>
      </div>

      {/* Inputs & Dynamic Start/Stop Action Button Row */}
      <div className="card-main-row">
        <div className="inputs-column">
          {/* Command Input Field */}
          <div className="field-group">
            <CommandIcon size={16} className="field-icon" />
            <input
              type="text"
              className="field-input"
              value={runner.command}
              disabled={runner.isRunning}
              onChange={(e) => onUpdate(runner.id, { command: e.target.value })}
              onKeyDown={handleKeyDown}
              placeholder="Command (e.g., npm run dev, mvn spring-boot:run)"
            />
          </div>

          {/* Directory/Path Input Field */}
          <div className="field-group">
            <Folder size={16} className="field-icon" />
            <input
              type="text"
              className="field-input"
              value={runner.cwd}
              disabled={runner.isRunning}
              onChange={(e) => onUpdate(runner.id, { cwd: e.target.value })}
              placeholder="Path / Directory (leave blank for system default directory)"
            />
          </div>
        </div>

        {/* Dynamic Start & Stop Button Logic */}
        <div className="action-column">
          {runner.isRunning ? (
            <button
              className="btn-toggle-process stop"
              onClick={() => onStop(runner.id)}
              title="Stop process (Ctrl+C termination)"
            >
              <Square size={20} fill="currentColor" />
              <span>STOP</span>
            </button>
          ) : (
            hasCommand && (
              <button
                className="btn-toggle-process start"
                onClick={() => onStart(runner.id)}
                title="Start background process (or press Enter)"
              >
                <Play size={22} fill="currentColor" />
                <span>START</span>
              </button>
            )
          )}
        </div>
      </div>

      {/* Footer: Live Logs Toggle & Actions */}
      <div className="card-footer-row">
        <button
          className="log-toggle-btn"
          onClick={() => setShowLogs(!showLogs)}
        >
          <Terminal size={14} />
          <span>Output Logs ({runner.logs.length})</span>
          {showLogs ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>

        <div className="footer-right-actions">
          {runner.logs.length > 0 && (
            <>
              <button
                className="log-toggle-btn"
                onClick={handleCopyAllLogs}
                title="Copy clean output logs without escape codes"
              >
                {copiedLogs ? <Check size={13} className="text-success" /> : <Copy size={13} />}
                <span>{copiedLogs ? 'Copied' : 'Copy Logs'}</span>
              </button>
              <button
                className="log-toggle-btn"
                onClick={() => onClearLogs(runner.id)}
                title="Clear logs for this runner"
              >
                Clear Console
              </button>
            </>
          )}
        </div>
      </div>

      {/* Collapsible Log Terminal Drawer */}
      {showLogs && (
        <div className="log-drawer">
          {/* Quick banner if live server URLs were detected */}
          {detectedUrls.length > 0 && (
            <div className="log-drawer-banner">
              <div className="drawer-banner-title">
                <Globe size={14} className="drawer-banner-globe" />
                <span>Live Server Detected:</span>
              </div>
              <div className="drawer-banner-links">
                {detectedUrls.map((url) => (
                  <button
                    key={url}
                    type="button"
                    className="drawer-url-button"
                    onClick={() => openUrlInBrowser(url)}
                    title={`Click to open ${url} in default browser`}
                  >
                    <span>{url}</span>
                    <ExternalLink size={12} />
                  </button>
                ))}
              </div>
            </div>
          )}

          {runner.logs.length === 0 ? (
            <div className="log-empty">No log output recorded yet.</div>
          ) : (
            runner.logs.map((log, idx) => (
              <LogLine
                key={idx}
                line={log.line}
                type={log.type}
                onOpenUrl={openUrlInBrowser}
              />
            ))
          )}
          <div ref={logEndRef} />
        </div>
      )}
    </div>
  );
};

