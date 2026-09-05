import {createServer} from 'node:http';
import {writeFile, mkdir} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {WebSocketServer, WebSocket} from 'ws';
import {createServer as createViteServer} from 'vite';

const execFileAsync = promisify(execFile);
const port = Number(process.env.PORT || 5173);
const host = '0.0.0.0';
const clients = new Map();
let latestRun = null;
let vite;

const server = createServer((req, res) => {
  if (req.url === '/api/lab/latest') {
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.end(JSON.stringify(latestRun ?? {status: 'NO_RUN'}, null, 2));
    return;
  }

  if (!vite) {
    res.statusCode = 503;
    res.end('OptiLink lab is starting');
    return;
  }

  vite.middlewares(req, res, () => {
    res.statusCode = 404;
    res.end('Not found');
  });
});

// Codespaces exposes the lab through https://<codespace>-5173.app.github.dev.
// In middleware mode we do not need Vite HMR for this physical-test harness.
// Disabling it avoids a second random forwarded port, while allowedHosts keeps
// Vite's host validation explicit instead of opening it to arbitrary hosts.
vite = await createViteServer({
  server: {
    middlewareMode: true,
    hmr: false,
    allowedHosts: ['.app.github.dev', 'localhost', '127.0.0.1'],
  },
  appType: 'spa',
});

const wss = new WebSocketServer({server, path: '/lab'});

function safeSend(ws, payload) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

function broadcast(payload, except) {
  for (const ws of clients.keys()) if (ws !== except) safeSend(ws, payload);
}

async function persistResult(run) {
  latestRun = run;
  await mkdir('results', {recursive: true});
  await writeFile('results/latest.json', JSON.stringify(run, null, 2));
  const stamp = new Date().toISOString().replaceAll(':', '-');
  await writeFile(`results/${stamp}.json`, JSON.stringify(run, null, 2));
}

async function tryPublishIssue(run) {
  if (process.env.OPTILINK_PUBLISH_GITHUB !== '1') return {published: false, reason: 'disabled'};
  const body = [
    '## TF-002 automated lab result',
    '',
    `- Time: ${run.finishedAt || new Date().toISOString()}`,
    `- Receiver: ${run.receiver?.device || 'moto razr 40 ultra'}`,
    `- Status: ${run.status}`,
    `- Best config: ${run.best ? JSON.stringify(run.best.config) : 'n/a'}`,
    `- Best unique-symbol rate: ${run.best?.metrics?.uniquePerSecond ?? 'n/a'} /s`,
    `- Best decoded QR rate: ${run.best?.metrics?.decodedPerSecond ?? 'n/a'} /s`,
    `- Best duplicate ratio: ${run.best?.metrics?.duplicateRatio ?? 'n/a'}`,
    '',
    '<details><summary>Machine-readable summary</summary>',
    '',
    '```json',
    JSON.stringify(run, null, 2).slice(0, 50000),
    '```',
    '</details>',
  ].join('\n');
  try {
    await writeFile('results/issue-comment.md', body);
    await execFileAsync('gh', ['issue', 'comment', '9', '--repo', 'jisuxingchen/optilink', '--body-file', 'results/issue-comment.md']);
    return {published: true};
  } catch (error) {
    return {published: false, reason: String(error)};
  }
}

wss.on('connection', ws => {
  clients.set(ws, {role: 'unknown'});
  safeSend(ws, {type: 'server', event: 'connected'});

  ws.on('message', async raw => {
    let message;
    try { message = JSON.parse(String(raw)); } catch { return; }
    const meta = clients.get(ws) || {role: 'unknown'};
    if (message.type === 'hello') {
      meta.role = message.role || 'unknown';
      clients.set(ws, meta);
      broadcast({type: 'peer', event: 'hello', role: meta.role}, ws);
      return;
    }
    if (message.type === 'telemetry' || message.type === 'command' || message.type === 'state') {
      broadcast(message, ws);
      return;
    }
    if (message.type === 'lab-result') {
      const run = {...message.run, receivedAt: new Date().toISOString()};
      await persistResult(run);
      const publish = await tryPublishIssue(run);
      latestRun = {...run, publish};
      safeSend(ws, {type: 'server', event: 'result-saved', publish});
    }
  });

  ws.on('close', () => clients.delete(ws));
});

server.listen(port, host, () => {
  console.log(`OptiLink TF-002 lab coordinator listening on http://${host}:${port}`);
  console.log('Receiver URL: ?role=receiver');
  console.log('Sender URL:   ?role=sender');
  console.log('Latest result endpoint: /api/lab/latest');
});