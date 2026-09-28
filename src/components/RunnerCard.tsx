import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
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
  Loader2,
} from 'lucide-react';
import { LogLine, stripAnsi, openUrlInBrowser } from '../utils/logParser';

export type RunnerStatus = 'idle' | 'starting' | 'running' | 'stopping';

export interface RunnerConfig {
  id: string;
  name: string;
  command: string;
  cwd: string;
  status?: RunnerStatus;
  isRunning: boolean;
  logs: Array<{ type: 'stdout' | 'stderr'; line: string }>;
  detectedUrls?: string[];
  generation?: number;
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
  const logDrawerRef = useRef<HTMLDivElement | null>(null);
  const isNearBottomRef = useRef(true);

  const status: RunnerStatus = runner.status || (runner.isRunning ? 'running' : 'idle');
  const isInputsDisabled = status !== 'idle';
  const hasCommand = runner.command.trim().length > 0;
  const detectedUrls = runner.detectedUrls || [];

  // Track if user is near bottom to avoid fighting scroll when reading previous logs
  const handleScroll = useCallback(() => {
    if (!logDrawerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = logDrawerRef.current;
    isNearBottomRef.current = scrollHeight - scrollTop - clientHeight < 60;
  }, []);

  // Controlled scroll without smooth animation to keep high-frequency output fluid
  useEffect(() => {
    if (!showLogs || !logDrawerRef.current) return;
    if (isNearBottomRef.current) {
      logDrawerRef.current.scrollTop = logDrawerRef.current.scrollHeight;
    }
  }, [runner.logs.length, showLogs]);

  // Prefer localhost or 127.0.0.1 as the primary live link
  const primaryUrl = useMemo(() => {
    if (detectedUrls.length === 0) return null;
    const local = detectedUrls.find((u) => u.includes('localhost') || u.includes('127.0.0.1'));
    return local || detectedUrls[0];
  }, [detectedUrls]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && hasCommand && status === 'idle') {
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
          <span className={`status-badge ${status}`}>
            {status === 'starting' && (
              <>
                <span className="pulse-dot starting"></span> Starting
              </>
            )}
            {status === 'running' && (
              <>
                <span className="pulse-dot running"></span> Running
              </>
            )}
            {status === 'stopping' && (
              <>
                <span className="pulse-dot stopping"></span> Stopping
              </>
            )}
            {status === 'idle' && 'Idle'}
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
            disabled={status === 'stopping'}
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
              disabled={isInputsDisabled}
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
              disabled={isInputsDisabled}
              onChange={(e) => onUpdate(runner.id, { cwd: e.target.value })}
              placeholder="Path / Directory (leave blank for system default directory)"
            />
          </div>
        </div>

        {/* Dynamic Start & Stop Button Logic */}
        <div className="action-column">
          {status === 'starting' && (
            <button
              className="btn-toggle-process starting"
              disabled
              title="Process is starting..."
            >
              <Loader2 size={20} className="spin-icon" />
              <span>STARTING...</span>
            </button>
          )}

          {status === 'stopping' && (
            <button
              className="btn-toggle-process stopping"
              disabled
              title="Process is stopping..."
            >
              <Loader2 size={20} className="spin-icon" />
              <span>STOPPING...</span>
            </button>
          )}

          {status === 'running' && (
            <button
              className="btn-toggle-process stop"
              onClick={() => onStop(runner.id)}
              title="Stop process"
            >
              <Square size={20} fill="currentColor" />
              <span>STOP</span>
            </button>
          )}

          {status === 'idle' && (
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
        <div className="log-drawer" ref={logDrawerRef} onScroll={handleScroll}>
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
        </div>
      )}
    </div>
  );
};
