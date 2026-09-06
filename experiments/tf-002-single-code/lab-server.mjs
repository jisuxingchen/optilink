import {createServer} from 'node:http';
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {WebSocketServer, WebSocket} from 'ws';
import {createServer as createViteServer} from 'vite';

const execFileAsync = promisify(execFile);
const port = Number(process.env.PORT || 5173);
const host = process.env.HOST || '0.0.0.0';
const labToken = process.env.OPTILINK_LAB_TOKEN || '';
const requestedMode = process.env.OPTILINK_LAB_PAGE || 'baseline';
const labMode = ['baseline', 'fountain', 'optigrid'].includes(requestedMode) ? requestedMode : 'baseline';
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

function htmlEntryForPath(pathname) {
  if (pathname === '/fountain.html') return 'fountain.html';
  if (pathname === '/optigrid.html') return 'optigrid.html';
  return 'index.html';
}

async function serveHtml(req, res, pathname) {
  try {
    const url = req.url || '/';
    const entry = htmlEntryForPath(pathname);
    const source = await readFile(entry, 'utf-8');
    const html = await vite.transformIndexHtml(url, source);
    res.statusCode = 200;
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.end(html);
  } catch (error) {
    vite?.ssrFixStacktrace?.(error);
    res.statusCode = 500;
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    res.end(`OptiLink lab HTML error\n${error?.stack || String(error)}`);
  }
}

const server = createServer((req, res) => {
  const pathname = new URL(req.url || '/', 'http://localhost').pathname;
  if (pathname === '/api/lab/health') {
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.end(JSON.stringify({status: 'OK', service: 'optilink-lab', port, protected: Boolean(labToken), mode: labMode, instanceId: labInstanceId || null}, null, 2));
    return;
  }
  if (!requestAuthorized(req)) {
    res.statusCode = 401;
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.end('OptiLink lab token required');
    return;
  }
  maybeSetAuthCookie(req, res);
  if (pathname === '/api/lab/latest') {
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
  vite.middlewares(req, res, () => void serveHtml(req, res, pathname));
});

vite = await createViteServer({server: {middlewareMode: true, hmr: false, allowedHosts: ['.app.github.dev', '.trycloudflare.com', 'localhost', '127.0.0.1']}, appType: 'custom'});
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

function resultSummaryLines(run) {
  const receiverLabel = run.receiver?.configuredDevice || run.receiver?.device || 'moto razr 40 ultra';
  const receiverUa = run.receiver?.userAgent || 'n/a';
  const fountain = run.kind === 'benchmark-1mib-fountain';
  const optigrid = run.kind === 'optigrid-calibration';
  const title = optigrid ? 'TF-004 OptiGrid' : fountain ? 'TF-002B Fountain' : 'TF-002';
  const common = [
    `## ${title} automated lab result`, '',
    `- Time: ${run.finishedAt || new Date().toISOString()}`,
    `- Kind: ${run.kind || 'legacy-calibration'}`,
    `- Evidence class: ${run.evidenceClass || 'legacy-functional-validation'}`,
    `- Receiver baseline: ${receiverLabel}`,
    `- Receiver UA (captured on receiver page): ${receiverUa}`,
    `- Status: ${run.status}`,
  ];

  if (optigrid) {
    const display = run.displayBaseline || {};
    const best = run.best || null;
    return common.concat([
      `- Physical display refresh: ${display.physicalRefreshHz ?? 'n/a'} Hz`,
      `- OptiLink visual update: ${display.targetOpticalVisualUpdateHz ?? 'n/a'} Hz`,
      `- Carrier: ${run.carrier?.name ?? 'OptiGrid v0'} · ${run.carrier?.modulation ?? 'monochrome'}`,
      `- Candidates: ${(run.candidates || []).map(candidate => `${candidate.matrixSize}²:${Number(candidate.uniquePayloadBytesPerSecond || 0).toFixed(0)} B/s`).join(' · ') || 'n/a'}`,
      `- Best matrix: ${best?.matrixSize ?? 'n/a'} × ${best?.matrixSize ?? 'n/a'}`,
      `- Best payload/frame: ${best?.payloadBytesPerFrame ?? 'n/a'} B`,
      `- Best unique frame rate: ${Number.isFinite(best?.uniqueFramesPerSecond) ? best.uniqueFramesPerSecond.toFixed(2) : 'n/a'} /s`,
      `- Best raw unique optical ingress: ${Number.isFinite(best?.uniquePayloadBytesPerSecond) ? best.uniquePayloadBytesPerSecond.toFixed(2) : 'n/a'} B/s`,
      `- Best reserved/pilot score: ${Number.isFinite(best?.averageReservedScore) ? (best.averageReservedScore * 100).toFixed(1) : 'n/a'}%`,
      `- Best decode CPU: avg ${Number.isFinite(best?.averageDecodeMs) ? best.averageDecodeMs.toFixed(2) : 'n/a'} ms · p95 ${Number.isFinite(best?.p95DecodeMs) ? best.p95DecodeMs.toFixed(2) : 'n/a'} ms`,
      `- Note: calibration measures carrier ingress only; 1 MiB Fountain + SHA-256 is the next gate.`,
    ]);
  }

  if (fountain) {
    const result = run.result || {};
    const config = run.config || {};
    const display = run.displayBaseline || {};
    return common.concat([
      `- Physical display refresh: ${display.physicalRefreshHz ?? run.sender?.physicalDisplayRefreshHz ?? 'n/a'} Hz`,
      `- OptiLink visual update: ${display.targetOpticalVisualUpdateHz ?? config.targetHz ?? 'n/a'} Hz`,
      `- Carrier: ${config.carrier ?? 'single-standard-qr'} · ${config.blockSize ?? 'n/a'} B source block · ${config.qrSize ?? 'n/a'} px · ECC ${config.ecc ?? 'n/a'}`,
      `- Payload: ${run.payload?.bytes ?? 'n/a'} bytes deterministic incompressible`,
      `- Source blocks solved: ${result.solvedSourceBlocks ?? 'n/a'} / ${result.totalSourceBlocks ?? 'n/a'} (${Number.isFinite(result.completionRatio) ? (result.completionRatio * 100).toFixed(2) : 'n/a'}%)`,
      `- Fountain symbols: accepted ${result.acceptedSymbols ?? 'n/a'} / displayed ${result.displayedSymbols ?? 'n/a'} · duplicate decodes ${result.duplicateSymbolDecodes ?? 'n/a'} · redundant ${result.redundantSymbols ?? 'n/a'}`,
      `- SHA-256: ${result.hashOk ? 'PASS' : 'not verified'}`,
      `- Sender-observed elapsed: ${Number.isFinite(result.senderObservedElapsedSeconds) ? result.senderObservedElapsedSeconds.toFixed(3) : 'n/a'} s`,
      `- Lab end-to-end goodput: ${Number.isFinite(result.labEndToEndGoodputBytesPerSecond) ? result.labEndToEndGoodputBytesPerSecond.toFixed(2) : 'n/a'} B/s`,
    ]);
  }

  if (run.kind === 'benchmark-1mib') {
    const result = run.result || {};
    const config = run.config || {};
    return common.concat([
      `- Config: ${config.chunkSize ?? 'n/a'} B/frame · ${config.qrSize ?? 'n/a'} px · ECC ${config.ecc ?? 'n/a'}`,
      `- Completion: ${result.uniqueChunks ?? 'n/a'} / ${result.totalChunks ?? 'n/a'} chunks (${Number.isFinite(result.completionRatio) ? (result.completionRatio * 100).toFixed(2) : 'n/a'}%)`,
      `- SHA-256: ${result.hashOk ? 'PASS' : 'not verified'}`,
    ]);
  }

  return common.concat([
    `- Best config: ${run.best ? JSON.stringify(run.best.config) : 'n/a'}`,
    `- Best unique-symbol rate: ${run.best?.metrics?.uniquePerSecond ?? 'n/a'} /s`,
  ]);
}

async function tryPublishIssue(run) {
  if (process.env.OPTILINK_PUBLISH_GITHUB !== '1') return {published: false, reason: 'disabled'};
  const body = [...resultSummaryLines(run), '', '<details><summary>Machine-readable summary</summary>', '', '```json', JSON.stringify(run, null, 2).slice(0, 50000), '```', '</details>'].join('\n');
  const issueNumber = run.kind === 'optigrid-calibration' ? '16' : run.kind === 'benchmark-1mib-fountain' ? '13' : '9';
  try {
    await writeFile('results/issue-comment.md', body);
    await execFileAsync('gh', ['issue', 'comment', issueNumber, '--repo', 'jisuxingchen/optilink', '--body-file', 'results/issue-comment.md']);
    return {published: true, issueNumber: Number(issueNumber)};
  } catch (error) {
    return {published: false, reason: String(error)};
  }
}

wss.on('connection', (ws, req) => {
  if (!requestAuthorized(req)) {
    ws.close(1008, 'OptiLink lab token required');
    return;
  }
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
  console.log(`OptiLink lab coordinator listening on http://${host}:${port}`);
  console.log(`Lab mode: ${labMode}${labInstanceId ? ` · instance ${labInstanceId}` : ''}`);
  console.log(`Lab control protection: ${labToken ? 'token enabled' : 'disabled'}`);
  console.log('Health URL:   /api/lab/health');
  console.log('Baseline:     /?role=sender|receiver');
  console.log('Fountain:     /fountain.html?role=sender|receiver');
  console.log('OptiGrid:     /optigrid.html?role=sender|receiver');
  console.log('Latest result endpoint: /api/lab/latest');
});
