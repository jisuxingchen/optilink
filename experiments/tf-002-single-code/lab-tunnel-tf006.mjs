import {spawn, execFileSync} from 'node:child_process';
import {createWriteStream} from 'node:fs';
import {access, chmod, mkdir} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {createServer as createNetServer} from 'node:net';
import {pipeline} from 'node:stream/promises';
import {Readable} from 'node:stream';

const token = process.env.OPTILINK_LAB_TOKEN || randomBytes(18).toString('hex');
const instanceId = randomBytes(8).toString('hex');
const cacheDir = join(homedir(), '.cache', 'optilink');
const binary = join(cacheDir, 'cloudflared');
const pageRoute = '/optigrid-v1-physical.html';
const expectedMarker = 'OptiGrid v1 · physical high-density gate';

function cloudflaredDownloadUrl() {
  if (process.platform !== 'linux') throw new Error(`Unsupported platform for automatic cloudflared install: ${process.platform}`);
  if (process.arch === 'x64') return 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64';
  if (process.arch === 'arm64') return 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64';
  throw new Error(`Unsupported architecture: ${process.arch}`);
}
async function ensureCloudflared() {
  try { await access(binary); return binary; } catch {}
  await mkdir(cacheDir, {recursive: true});
  const response = await fetch(cloudflaredDownloadUrl(), {redirect: 'follow'});
  if (!response.ok || !response.body) throw new Error(`cloudflared download failed: HTTP ${response.status}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(binary));
  await chmod(binary, 0o755);
  return binary;
}
function cleanupStaleProcesses() {
  if (process.platform !== 'linux') return;
  const commands = [
    ['pkill', ['-f', 'node .*lab-server-tf006\\.mjs']],
    ['pkill', ['-f', 'cloudflared .*tunnel .*--url http://127\\.0\\.0\\.1:8084']],
  ];
  for (const [command, args] of commands) { try { execFileSync(command, args, {stdio: 'ignore'}); } catch {} }
}
function portAvailable(port) {
  return new Promise(resolve => {
    const probe = createNetServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, '127.0.0.1');
  });
}
async function choosePort() {
  if (process.env.PORT) {
    const explicit = Number(process.env.PORT);
    if (!Number.isInteger(explicit) || explicit < 1 || explicit > 65535) throw new Error(`Invalid PORT: ${process.env.PORT}`);
    if (!await portAvailable(explicit)) throw new Error(`Requested PORT ${explicit} is already in use.`);
    return explicit;
  }
  for (let port = 8084; port < 8104; port += 1) if (await portAvailable(port)) return port;
  throw new Error('No free TF-006 lab port found in 8084-8103');
}

console.log('Stopping stale TF-006 lab/tunnel processes ...');
cleanupStaleProcesses();
await new Promise(resolve => setTimeout(resolve, 300));
const port = await choosePort();
const cloudflared = await ensureCloudflared();

const lab = spawn(process.execPath, ['lab-server-tf006.mjs'], {
  stdio: ['inherit', 'pipe', 'pipe'],
  env: {
    ...process.env,
    PORT: String(port),
    HOST: '127.0.0.1',
    OPTILINK_LAB_TOKEN: token,
    OPTILINK_LAB_INSTANCE_ID: instanceId,
    OPTILINK_PUBLISH_GITHUB: process.env.OPTILINK_PUBLISH_GITHUB ?? '1',
  },
});
lab.stdout.on('data', chunk => process.stdout.write(`[lab] ${chunk}`));
lab.stderr.on('data', chunk => process.stderr.write(`[lab] ${chunk}`));
lab.on('exit', code => { if (code && code !== 0) console.error(`TF-006 lab server exited with code ${code}`); });

async function waitForHealth() {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/lab/health`);
      if (response.ok) {
        const health = await response.json();
        if (health.status === 'OK' && health.mode === 'optigrid-v1-physical' && health.instanceId === instanceId) return;
      }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`TF-006 local health check timed out on port ${port}`);
}
async function verifyLocalPage() {
  const url = new URL(`http://127.0.0.1:${port}${pageRoute}`);
  url.searchParams.set('role', 'sender');
  url.searchParams.set('token', token);
  url.searchParams.set('run', instanceId);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`TF-006 local page check failed: HTTP ${response.status}`);
  const html = await response.text();
  if (!html.includes(expectedMarker)) throw new Error(`TF-006 marker missing: ${expectedMarker}`);
  console.log(`Verified local HTML entry: TF-006 (${expectedMarker})`);
}

await waitForHealth();
await verifyLocalPage();
console.log(`Local TF-006 lab healthy on 127.0.0.1:${port} · instance ${instanceId}`);
console.log('Starting temporary HTTPS tunnel ...');

const tunnel = spawn(cloudflared, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], {stdio: ['inherit', 'pipe', 'pipe']});
let printed = false;
const urlPattern = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/gi;
function inspectTunnelOutput(text) {
  process.stdout.write(`[tunnel] ${text}`);
  if (printed) return;
  const match = text.match(urlPattern)?.[0];
  if (!match) return;
  printed = true;
  const sender = `${match}${pageRoute}?role=sender&token=${token}&run=${instanceId}`;
  const receiver = `${match}${pageRoute}?role=receiver&token=${token}&run=${instanceId}`;
  console.log('\n============================================================');
  console.log('OptiLink TF-006 Physical Auto Lab is ready');
  console.log(`Instance : ${instanceId} · local port ${port}`);
  console.log(`Sender   : ${sender}`);
  console.log(`Receiver : ${receiver}`);
  console.log(`Health   : ${match}/api/lab/health`);
  console.log('Use ONLY these two fresh URLs. Keep this terminal running.');
  console.log('On the phone: tap Start once, align during the 6-second preflight, then leave it fixed.');
  console.log('Payload bytes remain optical; tunnel/WebSocket is control + telemetry only.');
  console.log('============================================================\n');
}
tunnel.stdout.on('data', chunk => inspectTunnelOutput(String(chunk)));
tunnel.stderr.on('data', chunk => inspectTunnelOutput(String(chunk)));
tunnel.on('exit', code => { if (code && code !== 0) console.error(`cloudflared exited with code ${code}`); lab.kill('SIGTERM'); process.exit(code ?? 0); });
function shutdown() { tunnel.kill('SIGTERM'); lab.kill('SIGTERM'); }
process.on('SIGINT', () => { shutdown(); process.exit(130); });
process.on('SIGTERM', () => { shutdown(); process.exit(143); });
