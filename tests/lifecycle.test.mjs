import test from 'node:test';
import assert from 'node:assert/strict';

// ANSI regex and URL regex from logParser
const ANSI_REGEX = /\u001b\[[0-9;?]*[a-zA-Z]|\u001b\].*?(?:\u001b\\|\u0007)|\u001b[@-Z\\-_]|[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const URL_REGEX = /(https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|[a-zA-Z0-9.-]+)(?::[0-9]{1,5})?(?:\/[^\s"'`()<>]*)?)/gi;

function stripAnsi(text) {
  if (!text) return '';
  return text.replace(ANSI_REGEX, '');
}

function cleanUrl(url) {
  return url.replace(/[.,;:)\]]+$/, '');
}

function extractUrls(rawText) {
  if (!rawText) return [];
  const clean = stripAnsi(rawText);
  const matches = clean.match(URL_REGEX);
  if (!matches) return [];

  const results = [];
  for (const m of matches) {
    const cleaned = cleanUrl(m);
    if (cleaned && !results.includes(cleaned)) {
      results.push(cleaned);
    }
  }
  return results;
}

// Reducer functions simulating App.tsx state management
function handleStartProcess(runners, id) {
  const target = runners.find((r) => r.id === id);
  if (!target || !target.command.trim()) return runners;
  if (target.status === 'starting' || target.status === 'running' || target.status === 'stopping') {
    return runners; // Prevent duplicate start
  }

  const nextGen = (target.generation || 0) + 1;
  return runners.map((r) =>
    r.id === id
      ? {
          ...r,
          status: 'starting',
          isRunning: true,
          generation: nextGen,
          detectedUrls: [],
          logs: [...r.logs, { type: 'stdout', line: `[Starting process: ${target.command.trim()}...]` }].slice(-300),
        }
      : r
  );
}

function handleProcessSpawnSuccess(runners, id, generation, pid) {
  return runners.map((r) =>
    r.id === id && r.generation === generation
      ? { ...r, status: 'running', isRunning: true }
      : r
  );
}

function handleStartProcessFailure(runners, id, generation, errMsg) {
  return runners.map((r) =>
    r.id === id && r.generation === generation
      ? {
          ...r,
          status: 'idle',
          isRunning: false,
          logs: [...r.logs, { type: 'stderr', line: `[LAUNCH FAILURE]: ${errMsg}` }].slice(-300),
        }
      : r
  );
}

function handleStopProcess(runners, id) {
  const target = runners.find((r) => r.id === id);
  if (!target || target.status === 'idle' || target.status === 'stopping') {
    return runners; // Prevent duplicate stop
  }

  return runners.map((r) =>
    r.id === id ? { ...r, status: 'stopping' } : r
  );
}

function handleStopProcessResolved(runners, id, generation) {
  return runners.map((r) =>
    r.id === id && r.generation === generation
      ? { ...r, status: 'idle', isRunning: false }
      : r
  );
}

function handleProcessExit(runners, id, generation, exitCode) {
  return runners.map((r) => {
    if (r.id === id) {
      // Discard stale exit event
      if (generation !== undefined && r.generation !== undefined && generation < r.generation) {
        return r;
      }
      return {
        ...r,
        status: 'idle',
        isRunning: false,
        logs: [
          ...r.logs,
          {
            type: 'stdout',
            line: `[Process finished${exitCode !== null && exitCode !== undefined ? ` with exit code ${exitCode}` : ''}]`,
          },
        ].slice(-300),
      };
    }
    return r;
  });
}

function handleIncomingBatchLogs(runners, id, generation, entries) {
  return runners.map((r) => {
    if (r.id === id) {
      // Discard stale logs
      if (generation !== undefined && r.generation !== undefined && generation < r.generation) {
        return r;
      }

      // Incremental URL extraction
      const newUrls = [];
      for (const entry of entries) {
        const found = extractUrls(entry.line);
        for (const u of found) {
          if (!r.detectedUrls?.includes(u) && !newUrls.includes(u)) {
            newUrls.push(u);
          }
        }
      }

      const formattedEntries = entries.map((e) => ({
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
  });
}

// ---------------------- TESTS ----------------------

test('State transitions: idle -> starting -> running -> stopping -> idle', () => {
  let runners = [
    {
      id: 'runner-1',
      name: 'Vite Server',
      command: 'npm run dev',
      cwd: '',
      status: 'idle',
      isRunning: false,
      logs: [],
      detectedUrls: [],
      generation: 0,
    },
  ];

  // 1. User clicks Start
  runners = handleStartProcess(runners, 'runner-1');
  assert.equal(runners[0].status, 'starting');
  assert.equal(runners[0].isRunning, true);
  assert.equal(runners[0].generation, 1);
  assert.equal(runners[0].logs.length, 1);
  assert.match(runners[0].logs[0].line, /Starting process/);

  // 2. Spawn succeeds from Tauri backend
  runners = handleProcessSpawnSuccess(runners, 'runner-1', 1, 1234);
  assert.equal(runners[0].status, 'running');
  assert.equal(runners[0].isRunning, true);

  // 3. User clicks Stop
  runners = handleStopProcess(runners, 'runner-1');
  assert.equal(runners[0].status, 'stopping');

  // 4. Process exits
  runners = handleProcessExit(runners, 'runner-1', 1, 0);
  assert.equal(runners[0].status, 'idle');
  assert.equal(runners[0].isRunning, false);
  assert.match(runners[0].logs[runners[0].logs.length - 1].line, /Process finished with exit code 0/);
});

test('Prevents duplicate start calls while starting or running', () => {
  let runners = [
    {
      id: 'runner-1',
      name: 'Vite Server',
      command: 'npm run dev',
      cwd: '',
      status: 'idle',
      isRunning: false,
      logs: [],
      detectedUrls: [],
      generation: 0,
    },
  ];

  runners = handleStartProcess(runners, 'runner-1');
  assert.equal(runners[0].status, 'starting');
  assert.equal(runners[0].generation, 1);

  // Second start click should be a no-op
  const secondAttempt = handleStartProcess(runners, 'runner-1');
  assert.equal(secondAttempt[0].generation, 1);
  assert.equal(secondAttempt[0].logs.length, 1);
});

test('Prevents duplicate stop calls while already stopping or idle', () => {
  let runners = [
    {
      id: 'runner-1',
      name: 'Server',
      command: 'npm run dev',
      cwd: '',
      status: 'running',
      isRunning: true,
      logs: [],
      detectedUrls: [],
      generation: 1,
    },
  ];

  runners = handleStopProcess(runners, 'runner-1');
  assert.equal(runners[0].status, 'stopping');

  // Second stop call should be a no-op
  const secondAttempt = handleStopProcess(runners, 'runner-1');
  assert.equal(secondAttempt[0].status, 'stopping');
});

test('Race protection: Stale exit event from older generation does NOT overwrite new process state', () => {
  let runners = [
    {
      id: 'runner-1',
      name: 'Server',
      command: 'npm run dev',
      cwd: '',
      status: 'idle',
      isRunning: false,
      logs: [],
      detectedUrls: [],
      generation: 0,
    },
  ];

  // Run generation 1
  runners = handleStartProcess(runners, 'runner-1'); // gen 1
  runners = handleProcessSpawnSuccess(runners, 'runner-1', 1, 1001);
  runners = handleStopProcess(runners, 'runner-1');
  runners = handleStopProcessResolved(runners, 'runner-1', 1);

  // User starts generation 2
  runners = handleStartProcess(runners, 'runner-1'); // gen 2
  runners = handleProcessSpawnSuccess(runners, 'runner-1', 2, 2002);
  assert.equal(runners[0].status, 'running');
  assert.equal(runners[0].generation, 2);

  // Now delayed exit event from generation 1 arrives!
  runners = handleProcessExit(runners, 'runner-1', 1, 143);

  // The runner MUST STILL BE RUNNING in generation 2!
  assert.equal(runners[0].status, 'running');
  assert.equal(runners[0].generation, 2);
  assert.equal(runners[0].isRunning, true);
});

test('Race protection: Stale logs from older generation are discarded', () => {
  let runners = [
    {
      id: 'runner-1',
      name: 'Server',
      command: 'npm run dev',
      cwd: '',
      status: 'running',
      isRunning: true,
      logs: [],
      detectedUrls: [],
      generation: 2,
    },
  ];

  // Old log arrives from generation 1
  runners = handleIncomingBatchLogs(runners, 'runner-1', 1, [
    { log_type: 'stdout', line: 'Old generation 1 leftover log' },
  ]);
  assert.equal(runners[0].logs.length, 0);

  // Log arrives from current generation 2
  runners = handleIncomingBatchLogs(runners, 'runner-1', 2, [
    { log_type: 'stdout', line: 'Generation 2 active output' },
  ]);
  assert.equal(runners[0].logs.length, 1);
  assert.equal(runners[0].logs[0].line, 'Generation 2 active output');
});

test('Log batching preserves order across stdout and stderr and respects buffer bound', () => {
  let runners = [
    {
      id: 'runner-1',
      name: 'Server',
      command: 'build',
      cwd: '',
      status: 'running',
      isRunning: true,
      logs: [],
      detectedUrls: [],
      generation: 1,
    },
  ];

  // Batch of interleaved stdout and stderr
  const batch = [
    { log_type: 'stdout', line: 'Compiling module 1...' },
    { log_type: 'stderr', line: 'Warning: unused variable x' },
    { log_type: 'stdout', line: 'Compiling module 2...' },
    { log_type: 'stdout', line: 'Build completed successfully.' },
  ];

  runners = handleIncomingBatchLogs(runners, 'runner-1', 1, batch);
  assert.equal(runners[0].logs.length, 4);
  assert.equal(runners[0].logs[0].type, 'stdout');
  assert.equal(runners[0].logs[0].line, 'Compiling module 1...');
  assert.equal(runners[0].logs[1].type, 'stderr');
  assert.equal(runners[0].logs[1].line, 'Warning: unused variable x');
  assert.equal(runners[0].logs[2].type, 'stdout');
  assert.equal(runners[0].logs[3].line, 'Build completed successfully.');

  // High-volume 350 lines batch - must be capped to latest 300
  const largeBatch = Array.from({ length: 350 }, (_, i) => ({
    log_type: 'stdout',
    line: `Line ${i + 1}`,
  }));
  runners = handleIncomingBatchLogs(runners, 'runner-1', 1, largeBatch);
  assert.equal(runners[0].logs.length, 300);
  assert.equal(runners[0].logs[299].line, 'Line 350');
});

test('Incremental URL extraction correctly detects URLs and deduplicates across batches', () => {
  let runners = [
    {
      id: 'runner-1',
      name: 'Server',
      command: 'dev',
      cwd: '',
      status: 'running',
      isRunning: true,
      logs: [],
      detectedUrls: [],
      generation: 1,
    },
  ];

  // Batch 1 has localhost:5173
  runners = handleIncomingBatchLogs(runners, 'runner-1', 1, [
    { log_type: 'stdout', line: '  ➜  Local:   http://localhost:5173/' },
    { log_type: 'stdout', line: '  ➜  Network: http://192.168.1.100:5173/' },
  ]);
  assert.deepEqual(runners[0].detectedUrls, ['http://localhost:5173/', 'http://192.168.1.100:5173/']);

  // Batch 2 repeats localhost:5173 and adds a new one
  runners = handleIncomingBatchLogs(runners, 'runner-1', 1, [
    { log_type: 'stdout', line: 'Re-opened http://localhost:5173/ and http://127.0.0.1:8080' },
  ]);
  assert.deepEqual(runners[0].detectedUrls, [
    'http://localhost:5173/',
    'http://192.168.1.100:5173/',
    'http://127.0.0.1:8080',
  ]);
});

test('ANSI strip and URL extraction cleans escape sequences properly', () => {
  const coloredText = '\u001b[32m✔\u001b[39m \u001b[1mReady in 150ms\u001b[22m: \u001b[34mhttp://localhost:3000\u001b[39m.';
  const stripped = stripAnsi(coloredText);
  assert.equal(stripped, '✔ Ready in 150ms: http://localhost:3000.');

  const urls = extractUrls(coloredText);
  assert.deepEqual(urls, ['http://localhost:3000']);
});
