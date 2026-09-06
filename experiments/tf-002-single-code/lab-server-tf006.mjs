import {createServer} from 'node:http';
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {WebSocketServer, WebSocket} from 'ws';
import {createServer as createViteServer} from 'vite';

const execFileAsync = promisify(execFile);
const port = Number(process.env.PORT || 8084);
const host = process.env.HOST || '0.0.0.0';
const labToken = process.env.OPTILINK_LAB_TOKEN || '';
const labInstanceId = process.env.OPTILINK_LAB_INSTANCE_ID || '';
const clients = new Map();
let latestRun = null;
let vite;

function parseCookies(req) {
  const result = new Map();
  for (const part of String(req.headers.cookie || '').split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    result.set(part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim()));
  }
  return result;
}
function tokenFromUrl(req) {
  try { return new URL(req.url || '/', 'http://localhost').searchParams.get('token') || ''; }
  catch { return ''; }
}
function requestAuthorized(req) {
  if (!labToken) return true;
  if (tokenFromUrl(req) === labToken) return true;
  return parseCookies(req).get('optilink_lab_token') === labToken;
}
function maybeSetAuthCookie(req, res) {
  if (!labToken || tokenFromUrl(req) !== labToken) return;
  res.setHeader('set-cookie', `optilink_lab_token=${encodeURIComponent(labToken)}; Path=/; HttpOnly; Secure; SameSite=Strict`);
}

async function serveHtml(req, res) {
  try {
    const source = await readFile('optigrid-v1-physical.html', 'utf-8');
    const html = await vite.transformIndexHtml(req.url || '/', source);
    res.statusCode = 200;
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.end(html);
  } catch (error) {
    vite?.ssrFixStacktrace?.(error);
    res.statusCode = 500;
    res.end(`TF-006 lab HTML error\n${error?.stack || String(error)}`);
  }
}

const server = createServer((req, res) => {
  const pathname = new URL(req.url || '/', 'http://localhost').pathname;
  if (pathname === '/api/lab/health') {
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.end(JSON.stringify({status: 'OK', service: 'optilink-tf006-lab', mode: 'optigrid-v1-physical', instanceId: labInstanceId || null, port, protected: Boolean(labToken)}, null, 2));
    return;
  }
  if (!requestAuthorized(req)) {
    res.statusCode = 401;
    res.setHeader('cache-control', 'no-store');
    res.end('OptiLink TF-006 lab token required');
    return;
  }
  maybeSetAuthCookie(req, res);
  if (pathname === '/api/lab/latest') {
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.end(JSON.stringify(latestRun ?? {status: 'NO_RUN'}, null, 2));
    return;
  }
  if (!vite) { res.statusCode = 503; res.end('TF-006 lab is starting'); return; }
  vite.middlewares(req, res, () => void serveHtml(req, res));
});

vite = await createViteServer({server: {middlewareMode: true, hmr: false, allowedHosts: ['.app.github.dev', '.trycloudflare.com', 'localhost', '127.0.0.1']}, appType: 'custom'});
const wss = new WebSocketServer({server, path: '/lab'});

function safeSend(ws, payload) { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload)); }
function broadcast(payload, except) { for (const ws of clients.keys()) if (ws !== except) safeSend(ws, payload); }

async function persistResult(run) {
  latestRun = run;
  await mkdir('results', {recursive: true});
  await writeFile('results/latest-tf006.json', JSON.stringify(run, null, 2));
  const stamp = new Date().toISOString().replaceAll(':', '-');
  await writeFile(`results/tf006-${stamp}.json`, JSON.stringify(run, null, 2));
}

function summary(run) {
  const candidateLines = (run.candidates || []).map(candidate =>
    `- ${candidate.matrixSize}×${candidate.matrixSize}: raw unique optical ingress ${Number(candidate.uniquePayloadBytesPerSecond || 0).toFixed(2)} B/s · valid ${(Number(candidate.validRatio || 0) * 100).toFixed(1)}% · unique ${candidate.uniqueFrames ?? 0}/${candidate.attempts ?? 0} scans · total decode p95 ${Number(candidate.totalDecodeP95Ms || 0).toFixed(1)} ms · reacq ${candidate.reacquisitionCount ?? 0}`
  );
  const best = run.best || null;
  return [
    '## TF-006 physical OptiGrid v1 automated result', '',
    `- Time: ${run.finishedAt || new Date().toISOString()}`,
    `- Schema: ${run.schema || 'n/a'}`,
    `- Evidence class: ${run.evidenceClass || 'n/a'}`,
    `- Status: ${run.status || 'n/a'}`,
    `- Receiver: ${run.receiver?.configuredDevice || 'n/a'} · camera ${run.receiver?.cameraVideo?.width || 0}×${run.receiver?.cameraVideo?.height || 0}`,
    `- Physical display: ${run.displayBaseline?.physicalRefreshHz ?? 'n/a'} Hz · target optical update ${run.displayBaseline?.targetOpticalVisualUpdateHz ?? 'n/a'} Hz`,
    `- Carrier: ${run.carrier?.name || 'OptiGrid v1'} · ${run.carrier?.receiverPipeline || 'n/a'}`,
    ...candidateLines,
    `- Auto-selected: ${best ? `${best.matrixSize}×${best.matrixSize} · ${Number(best.uniquePayloadBytesPerSecond || 0).toFixed(2)} B/s raw unique optical ingress` : 'none'}`,
    '- Boundary: this is a short network-assisted physical carrier gate, not final file Net Goodput and not official offline acceptance.',
    '- Control plane: WebSocket carries control/telemetry only; frame payload bytes remain screen→camera optical.',
  ];
}

async function tryPublishIssue(run) {
  if (process.env.OPTILINK_PUBLISH_GITHUB !== '1') return {published: false, reason: 'disabled'};
  const body = [...summary(run), '', '<details><summary>Machine-readable result</summary>', '', '```json', JSON.stringify(run, null, 2).slice(0, 50000), '```', '</details>'].join('\n');
  try {
    await writeFile('results/tf006-issue-comment.md', body);
    await execFileAsync('gh', ['issue', 'comment', '23', '--repo', 'jisuxingchen/optilink', '--body-file', 'results/tf006-issue-comment.md']);
    return {published: true, issueNumber: 23};
  } catch (error) { return {published: false, reason: String(error)}; }
}

wss.on('connection', (ws, req) => {
  if (!requestAuthorized(req)) { ws.close(1008, 'TF-006 lab token required'); return; }
  clients.set(ws, {role: 'unknown'});
  safeSend(ws, {type: 'server', event: 'connected'});
  ws.on('message', async raw => {
    let message;
    try { message = JSON.parse(String(raw)); } catch { return; }
    const meta = clients.get(ws) || {role: 'unknown'};
    if (message.type === 'hello') { meta.role = message.role || 'unknown'; clients.set(ws, meta); broadcast({type: 'peer', event: 'hello', role: meta.role}, ws); return; }
    if (message.type === 'telemetry' || message.type === 'command' || message.type === 'state') { broadcast(message, ws); return; }
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
  console.log(`OptiLink TF-006 lab listening on http://${host}:${port}`);
  console.log(`Instance: ${labInstanceId || 'n/a'} · protection: ${labToken ? 'token enabled' : 'disabled'}`);
  console.log('Page: /optigrid-v1-physical.html?role=sender|receiver');
  console.log('Health: /api/lab/health');
});
