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

  // Receiver can become ready before Sender opens. Coordinator must replay readiness to late Sender.
  const receiver=await openSocket();receiver.send(JSON.stringify({type:'hello',role:'tf007f-tiled-receiver'}));await sleep(30);
  receiver.send(JSON.stringify({type:'state',event:'tf007f-receiver-ready',receiver:{configuredDevice:'ci-camera'}}));await sleep(30);
  const sender=await openSocket();const replayed=waitMessage(sender,m=>m?.type==='state'&&m?.event==='tf007f-receiver-ready');sender.send(JSON.stringify({type:'hello',role:'tf007f-tiled-sender'}));const ready=await replayed;if(ready.receiver?.configuredDevice!=='ci-camera')throw new Error('receiver-ready replay mismatch');

  const config={id:'tf007f-176-15-ci1',matrixSize:176,symbolHz:15,displayRefreshHz:60,holdRefreshes:4,durationMs:10000,payloadBytes:3028,tileCount:3,control:false};
  const relayed=waitMessage(receiver,m=>m?.type==='command'&&m?.action==='tf007f-candidate-config');sender.send(JSON.stringify({type:'command',action:'tf007f-candidate-config',id:config.id,config}));const message=await relayed;if(message.config?.matrixSize!==176)throw new Error('candidate config relay mismatch');
  const rejected=waitMessage(sender,m=>m?.type==='server'&&m?.event==='policy-rejected');sender.send(JSON.stringify({type:'command',action:'tf007f-candidate-config',id:config.id,config,payload:[1,2,3]}));await rejected;
  sender.close();receiver.close();
  console.log('TF-007F lab smoke PASS: token, v5 route, late-sender readiness replay, control relay and payload rejection');
}finally{child.kill('SIGTERM');}
