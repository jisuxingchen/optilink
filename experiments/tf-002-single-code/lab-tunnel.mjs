import {spawn} from 'node:child_process';
import {createWriteStream} from 'node:fs';
import {access, chmod, mkdir} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {pipeline} from 'node:stream/promises';
import {Readable} from 'node:stream';

const port = Number(process.env.PORT || 8080);
const token = process.env.OPTILINK_LAB_TOKEN || randomBytes(18).toString('hex');
const page = process.env.OPTILINK_LAB_PAGE === 'fountain' ? 'fountain' : 'baseline';
const cacheDir = join(homedir(), '.cache', 'optilink');
const binary = join(cacheDir, 'cloudflared');

function cloudflaredDownloadUrl() {
  if (process.platform !== 'linux') throw new Error(`Unsupported platform for automatic cloudflared install: ${process.platform}`);
  if (process.arch === 'x64') return 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64';
  if (process.arch === 'arm64') return 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64';
  throw new Error(`Unsupported architecture for automatic cloudflared install: ${process.arch}`);
}

async function ensureCloudflared() {
  try { await access(binary); return binary; } catch {}
  await mkdir(cacheDir, {recursive: true});
  const url = cloudflaredDownloadUrl();
  console.log(`Downloading cloudflared once to ${binary} ...`);
  const response = await fetch(url, {redirect: 'follow'});
  if (!response.ok || !response.body) throw new Error(`cloudflared download failed: HTTP ${response.status}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(binary));
  await chmod(binary, 0o755);
  return binary;
}

function waitForLocalHealth() {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 15000;
    const check = async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/lab/health`);
        if (response.ok) return resolve();
      } catch {}
      if (Date.now() > deadline) return reject(new Error('Local lab health check timed out'));
      setTimeout(check, 250);
    };
    void check();
  });
}

const cloudflared = await ensureCloudflared();
const lab = spawn(process.execPath, ['lab-server.mjs'], {
  stdio: ['inherit', 'pipe', 'pipe'],
  env: {...process.env, PORT: String(port), HOST: '127.0.0.1', OPTILINK_LAB_TOKEN: token, OPTILINK_PUBLISH_GITHUB: process.env.OPTILINK_PUBLISH_GITHUB ?? '1'},
});

lab.stdout.on('data', chunk => process.stdout.write(`[lab] ${chunk}`));
lab.stderr.on('data', chunk => process.stderr.write(`[lab] ${chunk}`));
lab.on('exit', code => { if (code && code !== 0) console.error(`Lab server exited with code ${code}`); });

await waitForLocalHealth();
console.log(`Local lab healthy on 127.0.0.1:${port}`);
console.log(`Starting temporary HTTPS tunnel for ${page} mode ...`);

const tunnel = spawn(cloudflared, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], {stdio: ['inherit', 'pipe', 'pipe']});
let printed = false;
const urlPattern = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/gi;

function inspectTunnelOutput(text) {
  process.stdout.write(`[tunnel] ${text}`);
  if (printed) return;
  const match = text.match(urlPattern)?.[0];
  if (!match) return;
  printed = true;
  const basePath = page === 'fountain' ? '/fountain.html' : '/';
  const sender = `${match}${basePath}?role=sender&token=${token}`;
  const receiver = `${match}${basePath}?role=receiver&token=${token}`;
  console.log('\n============================================================');
  console.log(page === 'fountain' ? 'OptiLink Fountain Auto Lab is ready' : 'OptiLink Auto Lab is ready');
  console.log(`Sender   : ${sender}`);
  console.log(`Receiver : ${receiver}`);
  console.log(`Health   : ${match}/api/lab/health`);
  console.log('Keep this terminal running during the physical test.');
  console.log('The URL is temporary; lab control is protected by a random token.');
  console.log('============================================================\n');
}

tunnel.stdout.on('data', chunk => inspectTunnelOutput(String(chunk)));
tunnel.stderr.on('data', chunk => inspectTunnelOutput(String(chunk)));
tunnel.on('exit', code => {
  if (code && code !== 0) console.error(`cloudflared exited with code ${code}`);
  lab.kill('SIGTERM');
  process.exit(code ?? 0);
});

function shutdown() {
  tunnel.kill('SIGTERM');
  lab.kill('SIGTERM');
}

process.on('SIGINT', () => { shutdown(); process.exit(130); });
process.on('SIGTERM', () => { shutdown(); process.exit(143); });
