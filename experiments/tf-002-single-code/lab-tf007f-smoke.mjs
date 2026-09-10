import {spawn} from 'node:child_process';
import {WebSocket} from 'ws';

const port=5197,token='ci-tf007f-secret',instance='ci-tf007f';
const child=spawn(process.execPath,['lab-server-tf007f.mjs'],{stdio:['ignore','pipe','pipe'],env:{...process.env,PORT:String(port),HOST:'127.0.0.1',OPTILINK_LAB_TOKEN:token,OPTILINK_LAB_INSTANCE_ID:instance,OPTILINK_PUBLISH_GITHUB:'0'}});
let stderr='';child.stderr.on('data',chunk=>{stderr+=String(chunk);});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitHealth(){const deadline=Date.now()+15000;while(Date.now()<deadline){try{const response=await fetch(`http://127.0.0.1:${port}/api/lab/health`);if(response.ok){const health=await response.json();if(health.status==='OK'&&health.mode==='tf007f'&&health.instanceId===instance)return;}}catch{}await sleep(150);}throw new Error(`TF-007F health timeout\n${stderr}`);}
function openSocket(){return new Promise((resolve,reject)=>{const ws=new WebSocket(`ws://127.0.0.1:${port}/lab?token=${token}`);ws.once('open',()=>resolve(ws));ws.once('error',reject);});}
function waitMessage(ws,predicate,timeout=4000){return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{cleanup();reject(new Error('WebSocket message timeout'));},timeout);const onMessage=raw=>{let value;try{value=JSON.parse(String(raw));}catch{return;}if(!predicate(value))return;cleanup();resolve(value);};const cleanup=()=>{clearTimeout(timer);ws.off('message',onMessage);};ws.on('message',onMessage);});}
try{
  await waitHealth();
  const denied=await fetch(`http://127.0.0.1:${port}/tiled-physical-v5.html?role=sender`);if(denied.status!==401)throw new Error(`expected 401 without token, got ${denied.status}`);
  const page=await fetch(`http://127.0.0.1:${port}/tiled-physical-v5.html?role=sender&token=${token}`);const html=await page.text();if(!page.ok||!html.includes('TF-007F buffered physical gate'))throw new Error('v5 sender HTML smoke failed');

  // LAN HTTP regression: plain-HTTP cookie must NOT be Secure, so the browser can send it for module requests.
  const plainCookie=page.headers.get('set-cookie')||'';
  if(/;\s*Secure\b/i.test(plainCookie))throw new Error('plain HTTP cookie must not carry Secure');
  const cookiePair=plainCookie.split(';')[0];
  // Simulated HTTPS (Cloudflare tunnel sets x-forwarded-proto): cookie must remain Secure.
  const httpsPage=await fetch(`http://127.0.0.1:${port}/tiled-physical-v5.html?role=sender&token=${token}`,{headers:{'x-forwarded-proto':'https'}});
  const httpsCookie=httpsPage.headers.get('set-cookie')||'';
  if(!/;\s*Secure\b/i.test(httpsCookie))throw new Error('HTTPS cookie must remain Secure');
  // Sub-resource (JS module) must load using only the cookie, no token in URL — what the browser does over HTTP.
  const moduleResp=await fetch(`http://127.0.0.1:${port}/src/tiled-physical-v5-main.ts`,{headers:{cookie:cookiePair}});
  if(!moduleResp.ok)throw new Error(`sub-resource with cookie failed: ${moduleResp.status}`);
  // Unauthorized /lab WebSocket must still be rejected with close code 1008.
  const rejectedClose=await new Promise(resolve=>{let settled=false;const ws=new WebSocket(`ws://127.0.0.1:${port}/lab`);const done=(code,reason)=>{if(settled)return;settled=true;resolve({code,reason:String(reason)});try{ws.terminate();}catch{}};ws.on('close',(code,reason)=>done(code,reason));ws.on('error',()=>done(-1,'error'));setTimeout(()=>done(-1,'timeout'),4000);});
  if(rejectedClose.code!==1008)throw new Error(`unauthorized /lab must close 1008, got ${rejectedClose.code}`);

  // Receiver can become ready before Sender opens. Coordinator must replay readiness to late Sender.
  const receiver=await openSocket();receiver.send(JSON.stringify({type:'hello',role:'tf007f-tiled-receiver'}));await sleep(30);
  receiver.send(JSON.stringify({type:'state',event:'tf007f-receiver-ready',receiver:{configuredDevice:'ci-camera'}}));await sleep(30);
  const sender=await openSocket();const replayed=waitMessage(sender,m=>m?.type==='state'&&m?.event==='tf007f-receiver-ready');sender.send(JSON.stringify({type:'hello',role:'tf007f-tiled-sender'}));const ready=await replayed;if(ready.receiver?.configuredDevice!=='ci-camera')throw new Error('receiver-ready replay mismatch');

  const config={id:'tf007f-176-15-ci1',matrixSize:176,symbolHz:15,displayRefreshHz:60,holdRefreshes:4,durationMs:10000,payloadBytes:3028,tileCount:3,control:false};
  const relayed=waitMessage(receiver,m=>m?.type==='command'&&m?.action==='tf007f-candidate-config');sender.send(JSON.stringify({type:'command',action:'tf007f-candidate-config',id:config.id,config}));const message=await relayed;if(message.config?.matrixSize!==176)throw new Error('candidate config relay mismatch');
  const rejected=waitMessage(sender,m=>m?.type==='server'&&m?.event==='policy-rejected');sender.send(JSON.stringify({type:'command',action:'tf007f-candidate-config',id:config.id,config,payload:[1,2,3]}));await rejected;

  // TF-007G Manifest contract: dwellMs=600 must relay, wrong dwell must be rejected.
  const manifestId='tf007f-manifest-ci1';
  const manifestRelayed=waitMessage(receiver,m=>m?.type==='command'&&m?.action==='tf007f-manifest-read'&&m?.id===manifestId);sender.send(JSON.stringify({type:'command',action:'tf007f-manifest-read',id:manifestId,matrixSize:96,repetitions:3,dwellMs:600}));const manifestMessage=await manifestRelayed;if(manifestMessage.dwellMs!==600)throw new Error('TF-007G manifest dwell relay mismatch');
  const wrongDwellRejected=waitMessage(sender,m=>m?.type==='server'&&m?.event==='policy-rejected');sender.send(JSON.stringify({type:'command',action:'tf007f-manifest-read',id:manifestId,matrixSize:96,repetitions:3,dwellMs:300}));await wrongDwellRejected;
  const manifestPayloadRejected=waitMessage(sender,m=>m?.type==='server'&&m?.event==='policy-rejected');sender.send(JSON.stringify({type:'command',action:'tf007f-manifest-read',id:manifestId,matrixSize:96,repetitions:3,dwellMs:600,manifestBytes:[1,2,3]}));await manifestPayloadRejected;

  // TF-007G result must be accepted only for the exact schema/kind/Issue #34 route.
  const resultSaved=waitMessage(sender,m=>m?.type==='server'&&m?.event==='result-saved');sender.send(JSON.stringify({type:'lab-result',run:{schema:'optilink.tf007g.manifest-recovery.physical.v1',kind:'tf007g-manifest-recovery-physical',issueNumber:34,evidenceClass:'physical-manifest-recovery',status:'MANIFEST_RECOVERY_FAILED',finishedAt:new Date().toISOString(),manifestResult:{success:false}}}));await resultSaved;
  const latestResponse=await fetch(`http://127.0.0.1:${port}/api/lab/latest?token=${token}`);const latest=await latestResponse.json();if(latest.kind!=='tf007g-manifest-recovery-physical'||Number(latest.issueNumber)!==34)throw new Error('TF-007G latest-result routing mismatch');
  const wrongIssueRejected=waitMessage(sender,m=>m?.type==='server'&&m?.event==='policy-rejected');sender.send(JSON.stringify({type:'lab-result',run:{schema:'optilink.tf007g.manifest-recovery.physical.v1',kind:'tf007g-manifest-recovery-physical',issueNumber:32,status:'ERROR'}}));await wrongIssueRejected;

  sender.close();receiver.close();
  console.log('TF-007F/TF-007G lab smoke PASS: token, v5 route, LAN HTTP cookie (non-Secure), HTTPS cookie (Secure), cookie-only sub-resource auth, unauthorized /lab 1008 rejection, late-sender replay, candidate relay, Manifest dwell contract, payload rejection and Issue #34 result routing');
}finally{child.kill('SIGTERM');}