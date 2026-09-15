import React from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ExternalLink } from 'lucide-react';

/**
 * Regex to identify ANSI CSI sequences, OSC sequences, and non-printable control characters.
 */
export const ANSI_REGEX = /\u001b\[[0-9;?]*[a-zA-Z]|\u001b\].*?(?:\u001b\\|\u0007)|\u001b[@-Z\\-_]|[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/**
 * Strips all ANSI escape sequences and control characters from text.
 */
export function stripAnsi(text: string): string {
  if (!text) return '';
  return text.replace(ANSI_REGEX, '');
}

/**
 * Regex to detect HTTP and HTTPS URLs (including localhost, 127.0.0.1, IPv6, private network IPs, etc.).
 */
export const URL_REGEX = /(https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|[a-zA-Z0-9.-]+)(?::[0-9]{1,5})?(?:\/[^\s"'`()<>]*)?)/gi;

/**
 * Strips trailing punctuation characters that may inadvertently be captured with the URL.
 */
export function cleanUrl(url: string): string {
  return url.replace(/[.,;:)\]]+$/, '');
}

/**
 * Extracts all unique, valid URLs from a raw or formatted line of text.
 */
export function extractUrls(rawText: string): string[] {
  if (!rawText) return [];
  const clean = stripAnsi(rawText);
  const matches = clean.match(URL_REGEX);
  if (!matches) return [];

  const results: string[] = [];
  for (const m of matches) {
    const cleaned = cleanUrl(m);
    if (cleaned && !results.includes(cleaned)) {
      results.push(cleaned);
    }
  }
  return results;
}

/**
 * Safely opens a URL in the user's default system browser.
 * Works natively in Tauri desktop environment via custom Rust command,
 * with fallback to window.open for web browser preview.
 */
export async function openUrlInBrowser(url: string): Promise<void> {
  let targetUrl = url.trim();
  // Standardize 0.0.0.0 to localhost for Windows browser navigation
  if (targetUrl.includes('://0.0.0.0')) {
    targetUrl = targetUrl.replace('://0.0.0.0', '://localhost');
  }

  try {
    await invoke('open_url', { url: targetUrl });
  } catch (err) {
    console.warn('Tauri open_url command failed, falling back to window.open:', err);
    window.open(targetUrl, '_blank', 'noopener,noreferrer');
  }
}

/**
 * ANSI Color Map for standard terminal styling
 */
const ANSI_COLOR_MAP: Record<number, string> = {
  30: '#64748b', // Black / Slate
  31: '#f87171', // Red
  32: '#34d399', // Green
  33: '#fbbf24', // Yellow
  34: '#60a5fa', // Blue
  35: '#c084fc', // Magenta
  36: '#38bdf8', // Cyan
  37: '#f1f5f9', // White
  90: '#94a3b8', // Bright Black / Gray
  91: '#fca5a5', // Bright Red
  92: '#86efac', // Bright Green
  93: '#fde047', // Bright Yellow
  94: '#93c5fd', // Bright Blue
  95: '#e879f9', // Bright Magenta
  96: '#67e8f9', // Bright Cyan
  97: '#ffffff', // Bright White
};

interface TextSegment {
  text: string;
  style: React.CSSProperties;
}

/**
 * Parses raw ANSI terminal text into styled segments
 */
export function parseAnsiLine(raw: string): TextSegment[] {
  const segments: TextSegment[] = [];
  let currentStyle: React.CSSProperties = {};

  const regex = /\u001b\[([0-9;?]*)m/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(raw)) !== null) {
    const textBefore = raw.substring(lastIndex, match.index);
    if (textBefore) {
      const cleanText = textBefore.replace(ANSI_REGEX, '');
      if (cleanText) {
        segments.push({ text: cleanText, style: { ...currentStyle } });
      }
    }

    const codeStr = match[1] || '0';
    const codes = codeStr.split(';').map((c) => parseInt(c, 10) || 0);

    for (const code of codes) {
      if (code === 0) {
        currentStyle = {};
      } else if (code === 1) {
        currentStyle.fontWeight = 'bold';
      } else if (code === 2) {
        currentStyle.opacity = 0.65;
      } else if (code === 3) {
        currentStyle.fontStyle = 'italic';
      } else if (code === 4) {
        currentStyle.textDecoration = 'underline';
      } else if (code === 22) {
        delete currentStyle.fontWeight;
        delete currentStyle.opacity;
      } else if (code === 23) {
        delete currentStyle.fontStyle;
      } else if (code === 24) {
        delete currentStyle.textDecoration;
      } else if (ANSI_COLOR_MAP[code]) {
        currentStyle.color = ANSI_COLOR_MAP[code];
      } else if (code === 39) {
        delete currentStyle.color;
      }
    }

    lastIndex = regex.lastIndex;
  }

  const remaining = raw.substring(lastIndex);
  if (remaining) {
    const cleanRemaining = remaining.replace(ANSI_REGEX, '');
    if (cleanRemaining) {
      segments.push({ text: cleanRemaining, style: { ...currentStyle } });
    }
  }

  return segments;
}

interface LogLineProps {
  line: string;
  type: 'stdout' | 'stderr';
  onOpenUrl?: (url: string) => void;
}

/**
 * Component that renders a single log line cleanly.
 * Strips corrupted escape codes, formats ANSI colors, and transforms
 * detected URLs into clickable, interactive links.
 */
export const LogLine: React.FC<LogLineProps> = ({ line, type, onOpenUrl = openUrlInBrowser }) => {
  const detectedUrls = extractUrls(line);

  // If no URLs detected, render ANSI styled segments directly
  if (detectedUrls.length === 0) {
    const segments = parseAnsiLine(line);
    if (segments.length === 0) {
      const clean = stripAnsi(line);
      return <div className={`log-line ${type}`}>{clean || '\u00A0'}</div>;
    }
    return (
      <div className={`log-line ${type}`}>
        {segments.map((seg, i) => (
          <span key={i} style={seg.style}>
            {seg.text}
          </span>
        ))}
      </div>
    );
  }

  // When URLs exist on this line, render cleanly with URLs as interactive links
  const cleanLineText = stripAnsi(line);
  
  // Break cleanLineText into parts around each detected URL
  const parts: React.ReactNode[] = [];
  let remainingText = cleanLineText;

  detectedUrls.forEach((url, urlIdx) => {
    const idx = remainingText.indexOf(url);
    if (idx !== -1) {
      const before = remainingText.substring(0, idx);
      if (before) {
        parts.push(<span key={`before-${urlIdx}`}>{before}</span>);
      }

      parts.push(
        <button
          key={`url-${urlIdx}-${url}`}
          type="button"
          className="log-url-chip"
          onClick={(e) => {
            e.stopPropagation();
            onOpenUrl(url);
          }}
          title={`Click to open ${url} in default browser`}
        >
          <span className="log-url-text">{url}</span>
          <ExternalLink size={11} className="log-url-icon" />
        </button>
      );

      remainingText = remainingText.substring(idx + url.length);
    }
  });

  if (remainingText) {
    parts.push(<span key="remaining">{remainingText}</span>);
  }

  return <div className={`log-line ${type} has-url`}>{parts}</div>;
};
