import {homographyFromUnitSquare, mapHomography, type Point, type Quad} from './optigrid-geometry.ts';
import {decodeFrameCellsV1, encodeFrameCellsV1, OPTIGRID_V1_BORDER, payloadCapacityForMatrixV1, reservedCellValueV1} from './optigrid-v1.ts';

const PHYSICAL_DISPLAY_HZ = 60;
const TILE_COUNT = 3;
const FRAME_WIDTH = 1920;
const FRAME_HEIGHT = 1080;
const SAMPLE_WIDTH = 1280;
const CANDIDATE_SECONDS = 12;
const MIN_SCORE = 0.80;
const MIN_CONTRAST = 24;
const CANDIDATES = [
  {matrixSize: 96, targetHz: 60},
  {matrixSize: 112, targetHz: 45},
  {matrixSize: 120, targetHz: 45},
] as const;

type CandidateConfig = {
  id: string;
  matrixSize: number;
  targetHz: number;
  durationMs: number;
  payloadBytes: number;
  tileCount: 3;
};
type Rect = {x:number;y:number;width:number;height:number};
type Lock = {quad:Quad;threshold:number;score:number;contrast:number};
type TileState = {lock:Lock|null;acquisitions:number;reacquisitions:number;tracked:number};
type CandidateMetrics = {
  id:string;
  matrixSize:number;
  targetHz:number;
  payloadBytesPerTile:number;
  elapsedSeconds:number;
  cameraFrames:number;
  attemptedTiles:number;
  validTiles:number;
  validTileRatio:number;
  completeFrames:number;
  completeFrameRatio:number;
  uniqueDecodedSymbols:number;
  uniqueSymbolsPerSecond:number;
  rawUniqueOpticalIngressBytesPerSecond:number;
  alignmentRejects:number;
  crcRejects:number;
  payloadMismatchRejects:number;
  acquisitions:number;
  reacquisitions:number;
  trackedTiles:number;
  averageReservedScore:number;
  averageContrast:number;
  decodeP95Ms:number;
  cameraVideo:{width:number;height:number};
  sampleFrame:{width:number;height:number};
};
type Pending = {id:string;timer:number;resolve:(value?:CandidateMetrics)=>void;reject:(error:Error)=>void};

type ReceiverMeta = ReturnType<typeof receiverMetadata>;

const $ = <T extends HTMLElement>(id:string):T => {
  const node=document.getElementById(id);
  if(!node) throw new Error(`Missing #${id}`);
  return node as T;
};

const roleValue=new URLSearchParams(location.search).get('role');
const role:'sender'|'receiver'|'both'=roleValue==='sender'||roleValue==='receiver'?roleValue:'both';
const senderCanvas=$<HTMLCanvasElement>('senderCanvas');
const video=$<HTMLVideoElement>('camera');
const receiverStatus=$<HTMLPreElement>('receiverStatus');
const labStatus=$<HTMLPreElement>('labStatus');
const startButton=$<HTMLButtonElement>('startButton');
const stopButton=$<HTMLButtonElement>('stopButton');
const progress=$<HTMLElement>('progress');
const roleTitle=$<HTMLElement>('roleTitle');
const roleText=$<HTMLElement>('roleText');
const receiverView=$<HTMLElement>('receiverView');

senderCanvas.width=FRAME_WIDTH;
senderCanvas.height=FRAME_HEIGHT;
const sampleCanvas=document.createElement('canvas');
const sampleContextMaybe=sampleCanvas.getContext('2d',{alpha:false,willReadFrequently:true});
if(!sampleContextMaybe) throw new Error('sample canvas unavailable');
const sampleContext:CanvasRenderingContext2D=sampleContextMaybe;
const tileCanvas=document.createElement('canvas');

let socket:WebSocket|null=null;
let cameraStream:MediaStream|null=null;
let scanning=false;
let activeCandidate:CandidateConfig|null=null;
let candidateStartedAt=0;
let states:Array<TileState>=[];
let cameraFrames=0;
let validTiles=0;
let completeFrames=0;
let alignmentRejects=0;
let crcRejects=0;
let payloadMismatchRejects=0;
let scoreSum=0;
let contrastSum=0;
let scoreSamples=0;
let decodeTimes:number[]=[];
let seen:Array<Set<number>>=[];
let senderRunning=false;
let senderFrameHandle=0;
let senderSymbolBase=1;
let aborted=false;
let pendingConfig:Pending|null=null;
let pendingResult:Pending|null=null;
let latestReceiverMeta:ReceiverMeta|null=null;

function log(message:string):void{
  labStatus.textContent=`[${new Date().toLocaleTimeString()}] ${message}\n${labStatus.textContent||''}`.slice(0,22000);
}
function send(message:unknown):void{
  if(socket?.readyState===WebSocket.OPEN) socket.send(JSON.stringify(message));
}
function sameBytes(a:Uint8Array,b:Uint8Array):boolean{
  if(a.length!==b.length) return false;
  for(let i=0;i<a.length;i+=1) if(a[i]!==b[i]) return false;
  return true;
}
function percentile(values:number[],fraction:number):number{
  if(!values.length) return 0;
  const sorted=[...values].sort((a,b)=>a-b);
  return sorted[Math.min(sorted.length-1,Math.floor((sorted.length-1)*fraction))];
}
function formatRate(value:number):string{
  return `${(value/1000).toFixed(2)} KB/s`;
}
function payloadFor(sequence:number,length:number,tile:number):Uint8Array{
  const output=new Uint8Array(length);
  let x=(sequence^0x71d2c3a5^(tile*0x9e3779b9))>>>0;
  for(let i=0;i<output.length;i+=1){
    x^=x<<13; x^=x>>>17; x^=x<<5;
    output[i]=(x+i*31+tile*47)&255;
  }
  return output;
}
function receiverMetadata(){
  return {
    configuredDevice:'moto razr 40 ultra',
    userAgent:navigator.userAgent,
    platform:navigator.platform||'unknown',
    screen:{width:screen.width,height:screen.height,devicePixelRatio},
    cameraVideo:{width:video.videoWidth||0,height:video.videoHeight||0},
    orientation:screen.orientation?.type||'unknown',
    capturedAt:new Date().toISOString(),
    source:'tf007-tiled-physical-receiver' as const,
  };
}
function senderMetadata(){
  const rect=senderCanvas.getBoundingClientRect();
  return {
    userAgent:navigator.userAgent,
    screen:{width:screen.width,height:screen.height,devicePixelRatio},
    physicalDisplayRefreshHz:PHYSICAL_DISPLAY_HZ,
    physicalDisplayRefreshSource:'owner-confirmed',
    canvasBacking:{width:senderCanvas.width,height:senderCanvas.height},
    canvasCss:{width:rect.width,height:rect.height},
    capturedAt:new Date().toISOString(),
  };
}
function luma(data:Uint8ClampedArray,offset:number):number{
  return data[offset]*0.2126+data[offset+1]*0.7152+data[offset+2]*0.0722;
}
function sampleLuma(image:ImageData,x:number,y:number):number{
  const px=Math.max(0,Math.min(image.width-1,x));
  const py=Math.max(0,Math.min(image.height-1,y));
  const x0=Math.floor(px),y0=Math.floor(py),x1=Math.min(image.width-1,x0+1),y1=Math.min(image.height-1,y0+1);
  const tx=px-x0,ty=py-y0,stride=image.width*4;
  const a=luma(image.data,y0*stride+x0*4),b=luma(image.data,y0*stride+x1*4),c=luma(image.data,y1*stride+x0*4),d=luma(image.data,y1*stride+x1*4);
  return (a*(1-tx)+b*tx)*(1-ty)+(c*(1-tx)+d*tx)*ty;
}
function laneRects(width:number,height:number):Rect[]{
  const y=height*0.12,h=height*0.76;
  return [0,1,2].map(index=>({x:index*width/3+width*0.025,y,width:width/3-width*0.05,height:h}));
}
function laneThreshold(image:ImageData,rect:Rect):number{
  const values:number[]=[];
  const step=Math.max(3,Math.floor(image.width/320));
  for(let y=Math.floor(rect.y);y<rect.y+rect.height;y+=step){
    for(let x=Math.floor(rect.x);x<rect.x+rect.width;x+=step){
      values.push(sampleLuma(image,x,y));
    }
  }
  if(!values.length) return 120;
  values.sort((a,b)=>a-b);
  const low=values[Math.floor(values.length*0.08)]??0;
  const high=values[Math.floor(values.length*0.88)]??255;
  return (low+high)/2;
}
function findDarkQuad(image:ImageData,rect:Rect,matrixSize:number):Quad|null{
  const threshold=laneThreshold(image,rect);
  let tl:Point|null=null,tr:Point|null=null,br:Point|null=null,bl:Point|null=null;
  let tlScore=Infinity,trScore=-Infinity,brScore=-Infinity,blScore=Infinity;
  const step=Math.max(2,Math.floor(image.width/640));
  for(let y=Math.floor(rect.y);y<Math.ceil(rect.y+rect.height);y+=step){
    for(let x=Math.floor(rect.x);x<Math.ceil(rect.x+rect.width);x+=step){
      if(sampleLuma(image,x,y)>=threshold) continue;
      const sum=x+y,diff=x-y;
      if(sum<tlScore){tlScore=sum;tl={x,y};}
      if(diff>trScore){trScore=diff;tr={x,y};}
      if(sum>brScore){brScore=sum;br={x,y};}
      if(diff<blScore){blScore=diff;bl={x,y};}
    }
  }
  if(!tl||!tr||!br||!bl) return null;
  const cx=(tl.x+tr.x+br.x+bl.x)/4,cy=(tl.y+tr.y+br.y+bl.y)/4;
  const expand=matrixSize/Math.max(1,matrixSize-1);
  const ex=(point:Point):Point=>({x:cx+(point.x-cx)*expand,y:cy+(point.y-cy)*expand});
  return {tl:ex(tl),tr:ex(tr),br:ex(br),bl:ex(bl)};
}
type Reserved={row:number;column:number;expected:0|1};
const reservedCache=new Map<number,Reserved[]>();
function reservedSamples(matrixSize:number):Reserved[]{
  const cached=reservedCache.get(matrixSize); if(cached) return cached;
  const samples:Reserved[]=[];
  for(let row=0;row<matrixSize;row+=1){
    for(let column=0;column<matrixSize;column+=1){
      const expected=reservedCellValueV1(row,column,matrixSize);
      if(expected===null) continue;
      const finder=(row<9||row>=matrixSize-9)&&(column<9||column>=matrixSize-9);
      if(!finder&&((row*7+column*11)%5!==0)) continue;
      samples.push({row,column,expected:expected as 0|1});
    }
  }
  reservedCache.set(matrixSize,samples); return samples;
}
function evaluate(image:ImageData,quad:Quad,matrixSize:number):Lock|null{
  const h=homographyFromUnitSquare(quad); if(!h) return null;
  const samples=reservedSamples(matrixSize);
  let blackSum=0,blackCount=0,whiteSum=0,whiteCount=0;
  const measured=new Float64Array(samples.length);
  for(let i=0;i<samples.length;i+=1){
    const s=samples[i],p=mapHomography(h,(s.column+0.5)/matrixSize,(s.row+0.5)/matrixSize),value=sampleLuma(image,p.x,p.y);
    measured[i]=value;
    if(s.expected){blackSum+=value;blackCount+=1;}else{whiteSum+=value;whiteCount+=1;}
  }
  if(!blackCount||!whiteCount) return null;
  const black=blackSum/blackCount,white=whiteSum/whiteCount,contrast=white-black,threshold=(black+white)/2;
  let matches=0;
  for(let i=0;i<samples.length;i+=1) if((measured[i]<threshold?1:0)===samples[i].expected) matches+=1;
  return {quad,threshold,score:matches/samples.length,contrast};
}
function cloneQuad(q:Quad):Quad{return{tl:{...q.tl},tr:{...q.tr},br:{...q.br},bl:{...q.bl}};}
function objective(lock:Lock):number{return lock.score*1000+Math.min(160,Math.max(0,lock.contrast));}
function refine(image:ImageData,initial:Quad,matrixSize:number):Lock|null{
  let best=evaluate(image,initial,matrixSize); if(!best) return null;
  const base=Math.max(1,image.width/320);
  for(const step of[base*3,base*1.5,base,0.5]){
    for(const corner of ['tl','tr','br','bl'] as const){
      for(const axis of ['x','y'] as const){
        for(const dir of [-1,1]){
          const q=cloneQuad(best.quad); q[corner][axis]+=step*dir;
          const candidate=evaluate(image,q,matrixSize);
          if(candidate&&objective(candidate)>objective(best)) best=candidate;
        }
      }
    }
  }
  return best;
}
function acquire(image:ImageData,rect:Rect,matrixSize:number):Lock|null{
  const initial=findDarkQuad(image,rect,matrixSize); if(!initial) return null;
  const lock=refine(image,initial,matrixSize);
  return lock&&lock.score>=MIN_SCORE&&lock.contrast>=MIN_CONTRAST?lock:null;
}
function decodeTile(image:ImageData,matrixSize:number,lock:Lock){
  const h=homographyFromUnitSquare(lock.quad); if(!h) return null;
  const cells=new Uint8Array(matrixSize*matrixSize);
  for(let row=OPTIGRID_V1_BORDER;row<matrixSize-OPTIGRID_V1_BORDER;row+=1){
    for(let column=OPTIGRID_V1_BORDER;column<matrixSize-OPTIGRID_V1_BORDER;column+=1){
      const p=mapHomography(h,(column+0.5)/matrixSize,(row+0.5)/matrixSize);
      cells[row*matrixSize+column]=sampleLuma(image,p.x,p.y)<lock.threshold?1:0;
    }
  }
  return decodeFrameCellsV1(cells,matrixSize);
}
function resetMetrics(config:CandidateConfig|null):void{
  activeCandidate=config;
  candidateStartedAt=performance.now();
  states=Array.from({length:TILE_COUNT},()=>({lock:null,acquisitions:0,reacquisitions:0,tracked:0}));
  cameraFrames=0;validTiles=0;completeFrames=0;alignmentRejects=0;crcRejects=0;payloadMismatchRejects=0;scoreSum=0;contrastSum=0;scoreSamples=0;decodeTimes=[];
  seen=Array.from({length:TILE_COUNT},()=>new Set<number>());
  updateStatus();
}
function currentMetrics():CandidateMetrics|null{
  const config=activeCandidate; if(!config) return null;
  const elapsed=Math.max(0.001,(performance.now()-candidateStartedAt)/1000);
  const unique=seen.reduce((sum,set)=>sum+set.size,0);
  return {
    id:config.id,matrixSize:config.matrixSize,targetHz:config.targetHz,payloadBytesPerTile:config.payloadBytes,elapsedSeconds:elapsed,cameraFrames,
    attemptedTiles:cameraFrames*TILE_COUNT,validTiles,validTileRatio:cameraFrames?validTiles/(cameraFrames*TILE_COUNT):0,
    completeFrames,completeFrameRatio:cameraFrames?completeFrames/cameraFrames:0,uniqueDecodedSymbols:unique,uniqueSymbolsPerSecond:unique/elapsed,
    rawUniqueOpticalIngressBytesPerSecond:unique*config.payloadBytes/elapsed,alignmentRejects,crcRejects,payloadMismatchRejects,
    acquisitions:states.reduce((sum,state)=>sum+state.acquisitions,0),reacquisitions:states.reduce((sum,state)=>sum+state.reacquisitions,0),trackedTiles:states.reduce((sum,state)=>sum+state.tracked,0),
    averageReservedScore:scoreSamples?scoreSum/scoreSamples:0,averageContrast:scoreSamples?contrastSum/scoreSamples:0,decodeP95Ms:percentile(decodeTimes,0.95),
    cameraVideo:{width:video.videoWidth||0,height:video.videoHeight||0},sampleFrame:{width:sampleCanvas.width,height:sampleCanvas.height},
  };
}
function updateStatus():void{
  const metrics=currentMetrics();
  if(!metrics){receiverStatus.textContent='camera ready · waiting for sender candidate';return;}
  receiverStatus.textContent=[
    `candidate: 3×${metrics.matrixSize} @ ${metrics.targetHz} Hz · ${metrics.payloadBytesPerTile} B/tile`,
    `camera frames: ${metrics.cameraFrames} · complete ${(metrics.completeFrameRatio*100).toFixed(1)}%`,
    `valid tiles: ${metrics.validTiles}/${metrics.attemptedTiles} · ${(metrics.validTileRatio*100).toFixed(1)}%`,
    `unique symbols: ${metrics.uniqueDecodedSymbols} · ${metrics.uniqueSymbolsPerSecond.toFixed(1)}/s`,
    `RAW optical ingress: ${formatRate(metrics.rawUniqueOpticalIngressBytesPerSecond)}`,
    `rejects: alignment ${metrics.alignmentRejects} · CRC ${metrics.crcRejects} · payload ${metrics.payloadMismatchRejects}`,
    `locks: acquire ${metrics.acquisitions} · reacquire ${metrics.reacquisitions} · tracked ${metrics.trackedTiles}`,
    `reserved score ${(metrics.averageReservedScore*100).toFixed(1)}% · contrast ${metrics.averageContrast.toFixed(1)} · decode p95 ${metrics.decodeP95Ms.toFixed(1)} ms`,
    `video ${metrics.cameraVideo.width}×${metrics.cameraVideo.height} → sample ${metrics.sampleFrame.width}×${metrics.sampleFrame.height}`,
  ].join('\n');
  send({type:'telemetry',telemetry:{transport:'tf007-tiled-physical-v1',metrics,timestamp:performance.now()}});
}
function captureVideoFrame():ImageData|null{
  if(video.readyState<HTMLMediaElement.HAVE_CURRENT_DATA||!video.videoWidth||!video.videoHeight) return null;
  const aspect=video.videoWidth/video.videoHeight;
  sampleCanvas.width=SAMPLE_WIDTH;
  sampleCanvas.height=Math.max(360,Math.round(SAMPLE_WIDTH/aspect));
  sampleContext.setTransform(1,0,0,1,0,0);
  sampleContext.drawImage(video,0,0,sampleCanvas.width,sampleCanvas.height);
  return sampleContext.getImageData(0,0,sampleCanvas.width,sampleCanvas.height);
}
function processFrame():void{
  if(!scanning||!activeCandidate) return;
  const image=captureVideoFrame(); if(!image) return;
  const started=performance.now(),rects=laneRects(image.width,image.height);
  cameraFrames+=1;
  let frameValid=0;
  for(let tile=0;tile<TILE_COUNT;tile+=1){
    const state=states[tile]; let lock=state.lock;
    if(lock){
      const tracked=evaluate(image,lock.quad,activeCandidate.matrixSize);
      if(tracked&&tracked.score>=MIN_SCORE&&tracked.contrast>=MIN_CONTRAST){lock={...tracked,quad:lock.quad};state.lock=lock;state.tracked+=1;}
      else{state.lock=null;lock=null;state.reacquisitions+=1;}
    }
    if(!lock){lock=acquire(image,rects[tile],activeCandidate.matrixSize);if(lock){state.lock=lock;state.acquisitions+=1;}}
    if(!lock){alignmentRejects+=1;continue;}
    scoreSum+=lock.score;contrastSum+=lock.contrast;scoreSamples+=1;
    const decoded=decodeTile(image,activeCandidate.matrixSize,lock);
    if(!decoded){crcRejects+=1;continue;}
    const expected=payloadFor(decoded.sequence,decoded.payload.length,tile);
    if(!sameBytes(decoded.payload,expected)){payloadMismatchRejects+=1;continue;}
    validTiles+=1;frameValid+=1;seen[tile].add(decoded.sequence);
  }
  if(frameValid===TILE_COUNT) completeFrames+=1;
  decodeTimes.push(performance.now()-started); if(decodeTimes.length>1000) decodeTimes.shift();
  if(cameraFrames%2===0) updateStatus();
}
function scheduleVideoLoop():void{
  const anyVideo=video as HTMLVideoElement & {requestVideoFrameCallback?:(callback:(now:number,metadata:unknown)=>void)=>number};
  const tick=()=>{
    if(!scanning) return;
    processFrame();
    if(anyVideo.requestVideoFrameCallback) anyVideo.requestVideoFrameCallback(()=>tick());
    else requestAnimationFrame(tick);
  };
  if(anyVideo.requestVideoFrameCallback) anyVideo.requestVideoFrameCallback(()=>tick());
  else requestAnimationFrame(tick);
}
async function startCamera():Promise<void>{
  if(cameraStream) return;
  try{await document.documentElement.requestFullscreen?.();}catch{}
  try{await (screen.orientation as ScreenOrientation & {lock?:(orientation:string)=>Promise<void>}).lock?.('landscape');}catch{}
  cameraStream=await navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:{ideal:'environment'},width:{ideal:1920},height:{ideal:1080},frameRate:{ideal:60,max:60}}});
  video.srcObject=cameraStream; await video.play();
  scanning=true; scheduleVideoLoop();
}
function stopCamera():void{
  scanning=false; cameraStream?.getTracks().forEach(track=>track.stop()); cameraStream=null; video.srcObject=null;
}
function tilePixels(matrixSize:number):number{return matrixSize*Math.max(4,Math.floor(600/matrixSize));}
function drawTile(cells:Uint8Array,matrixSize:number):void{
  tileCanvas.width=matrixSize;tileCanvas.height=matrixSize;
  const ctx=tileCanvas.getContext('2d',{alpha:false});if(!ctx) throw new Error('tile canvas unavailable');
  const image=ctx.createImageData(matrixSize,matrixSize);
  for(let i=0;i<cells.length;i+=1){const value=cells[i]?0:255,offset=i*4;image.data[offset]=value;image.data[offset+1]=value;image.data[offset+2]=value;image.data[offset+3]=255;}
  ctx.putImageData(image,0,0);
}
function clearSender():void{
  const ctx=senderCanvas.getContext('2d',{alpha:false});if(!ctx) return;ctx.fillStyle='#eceff1';ctx.fillRect(0,0,FRAME_WIDTH,FRAME_HEIGHT);
}
function renderSymbol(config:CandidateConfig,symbol:number):void{
  const ctx=senderCanvas.getContext('2d',{alpha:false});if(!ctx) throw new Error('sender canvas unavailable');
  ctx.setTransform(1,0,0,1,0,0);ctx.fillStyle='#eceff1';ctx.fillRect(0,0,FRAME_WIDTH,FRAME_HEIGHT);ctx.imageSmoothingEnabled=false;
  const centers=[320,960,1600],pixels=tilePixels(config.matrixSize);
  for(let tile=0;tile<TILE_COUNT;tile+=1){
    const sequence=((senderSymbolBase+symbol)*16+tile+1)>>>0;
    const payload=payloadFor(sequence,config.payloadBytes,tile);
    drawTile(encodeFrameCellsV1(config.matrixSize,sequence,payload),config.matrixSize);
    ctx.fillStyle='#fff';ctx.fillRect(centers[tile]-pixels/2-10,FRAME_HEIGHT/2-pixels/2-10,pixels+20,pixels+20);
    ctx.drawImage(tileCanvas,centers[tile]-pixels/2,FRAME_HEIGHT/2-pixels/2,pixels,pixels);
  }
}
function makePending(id:string,kind:'config'|'result'):Promise<CandidateMetrics|undefined>{
  return new Promise((resolve,reject)=>{
    const timer=window.setTimeout(()=>{if(kind==='config')pendingConfig=null;else pendingResult=null;reject(new Error(`tiled physical ${kind} acknowledgement timed out`));},8000);
    const pending={id,timer,resolve,reject}; if(kind==='config')pendingConfig=pending;else pendingResult=pending;
  });
}
async function configureReceiver(config:CandidateConfig):Promise<void>{const ack=makePending(config.id,'config');send({type:'command',action:'tiled-physical-config',config});await ack;}
async function collectReceiverResult(id:string):Promise<CandidateMetrics>{const ack=makePending(id,'result');send({type:'command',action:'tiled-physical-finish-candidate',candidateId:id});const metrics=await ack;if(!metrics)throw new Error('missing receiver metrics');return metrics;}
async function renderCandidate(config:CandidateConfig):Promise<{renderedSymbols:number;elapsedSeconds:number;actualSymbolHz:number}>{
  await configureReceiver(config); await new Promise(resolve=>setTimeout(resolve,500));
  senderRunning=true; let renderedSymbols=0,lastSymbol=-1;const started=performance.now();
  await new Promise<void>((resolve,reject)=>{
    const frame=(now:number)=>{
      if(!senderRunning||aborted) return resolve();
      const elapsed=now-started;if(elapsed>=config.durationMs) return resolve();
      const symbol=Math.floor(elapsed*config.targetHz/1000);
      if(symbol!==lastSymbol){
        try{renderSymbol(config,symbol);renderedSymbols+=1;lastSymbol=symbol;}catch(error){senderRunning=false;reject(error);return;}
      }
      senderFrameHandle=requestAnimationFrame(frame);
    };
    senderFrameHandle=requestAnimationFrame(frame);
  });
  senderRunning=false;cancelAnimationFrame(senderFrameHandle);senderSymbolBase+=Math.max(100,renderedSymbols+20);clearSender();
  const elapsedSeconds=Math.max(0.001,(performance.now()-started)/1000);
  return {renderedSymbols,elapsedSeconds,actualSymbolHz:renderedSymbols/elapsedSeconds};
}
async function runPhysicalCalibration():Promise<void>{
  if(senderRunning) return; aborted=false;
  const results:Array<CandidateMetrics & {senderRenderedSymbols:number;senderActualSymbolHz:number;theoreticalGrossBytesPerSecond:number}>=[];
  try{
    log('TF-007 physical tiled calibration started. Payload remains optical; WebSocket carries control/telemetry only.');
    for(const candidate of CANDIDATES){
      if(aborted) break;
      const payloadBytes=payloadCapacityForMatrixV1(candidate.matrixSize);
      const config:CandidateConfig={id:`tf007-${candidate.matrixSize}-${candidate.targetHz}-${Date.now().toString(36)}`,matrixSize:candidate.matrixSize,targetHz:candidate.targetHz,durationMs:CANDIDATE_SECONDS*1000,payloadBytes,tileCount:3};
      log(`testing 3×${candidate.matrixSize} @ ${candidate.targetHz} Hz · gross ${formatRate(payloadBytes*TILE_COUNT*candidate.targetHz)}`);
      const sender=await renderCandidate(config);
      const receiver=await collectReceiverResult(config.id);
      results.push({...receiver,senderRenderedSymbols:sender.renderedSymbols,senderActualSymbolHz:sender.actualSymbolHz,theoreticalGrossBytesPerSecond:payloadBytes*TILE_COUNT*candidate.targetHz});
      log(`3×${candidate.matrixSize}@${candidate.targetHz}: raw ${formatRate(receiver.rawUniqueOpticalIngressBytesPerSecond)} · valid tiles ${(receiver.validTileRatio*100).toFixed(1)}% · complete ${(receiver.completeFrameRatio*100).toFixed(1)}%`);
      await new Promise(resolve=>setTimeout(resolve,500));
    }
    const best=results.reduce<(typeof results)[number]|null>((winner,row)=>!winner||row.rawUniqueOpticalIngressBytesPerSecond>winner.rawUniqueOpticalIngressBytesPerSecond?row:winner,null);
    const status=aborted?'ABORTED':best&&best.rawUniqueOpticalIngressBytesPerSecond>=100000?'PASS_RAW_100KBPS':'BELOW_100KBPS';
    const run={
      schema:'optilink.tf007.tiled.physical.v1',kind:'tf007-tiled-physical-calibration',issueNumber:27,evidenceClass:'physical-carrier-calibration',status,startedBy:'receiver-one-click',finishedAt:new Date().toISOString(),
      sender:senderMetadata(),receiver:latestReceiverMeta,displayBaseline:{physicalRefreshHz:PHYSICAL_DISPLAY_HZ},carrier:{name:'OptiGrid v1 tiled monochrome',tileCount:3,layout:'three horizontal independent tiles',integrity:'per-tile CRC32 + deterministic optical payload oracle'},
      candidates:results,best,target:{rawCarrierIngressBytesPerSecond:100000},controlPlane:'WebSocket carries commands/telemetry only; candidate payload bytes remain screen→camera optical',
      note:'Raw carrier calibration only. File-level Net Goodput still requires Fountain + reconstructed file SHA-256.',
    };
    send({type:'lab-result',run});send({type:'command',action:'tiled-physical-finished',status});
    log(best?`physical calibration ${status} · best ${best.matrixSize}@${best.targetHz} · ${formatRate(best.rawUniqueOpticalIngressBytesPerSecond)}`:`physical calibration finished without a valid candidate`);
  }catch(error){
    clearSender();senderRunning=false;send({type:'command',action:'tiled-physical-finished',status:'ERROR'});log(`physical calibration failed: ${String(error)}`);
  }
}
function connect():void{
  const protocol=location.protocol==='https:'?'wss:':'ws:';socket=new WebSocket(`${protocol}//${location.host}/lab`);
  socket.addEventListener('open',()=>{send({type:'hello',role:`tf007-tiled-${role}`});log(`coordinator connected as ${role}`);});
  socket.addEventListener('close',()=>{log('coordinator disconnected; reconnecting…');setTimeout(connect,1500);});
  socket.addEventListener('message',event=>{
    let message:any;try{message=JSON.parse(String(event.data));}catch{return;}
    if(role==='sender'&&message.type==='state'&&message.event==='tiled-physical-receiver-ready'){
      latestReceiverMeta=message.receiver as ReceiverMeta;void runPhysicalCalibration();return;
    }
    if(role==='receiver'&&message.type==='command'&&message.action==='tiled-physical-config'){
      const config=message.config as CandidateConfig;resetMetrics(config);latestReceiverMeta=receiverMetadata();send({type:'state',event:'tiled-physical-config-ready',candidateId:config.id,receiver:latestReceiverMeta});return;
    }
    if(role==='sender'&&message.type==='state'&&message.event==='tiled-physical-config-ready'){
      if(!pendingConfig||pendingConfig.id!==String(message.candidateId||''))return;clearTimeout(pendingConfig.timer);latestReceiverMeta=message.receiver as ReceiverMeta;const pending=pendingConfig;pendingConfig=null;pending.resolve();return;
    }
    if(role==='receiver'&&message.type==='command'&&message.action==='tiled-physical-finish-candidate'){
      const metrics=currentMetrics(),candidateId=String(message.candidateId||'');if(metrics&&metrics.id===candidateId)send({type:'state',event:'tiled-physical-candidate-result',candidateId,metrics});resetMetrics(null);return;
    }
    if(role==='sender'&&message.type==='state'&&message.event==='tiled-physical-candidate-result'){
      if(!pendingResult||pendingResult.id!==String(message.candidateId||''))return;clearTimeout(pendingResult.timer);const pending=pendingResult;pendingResult=null;pending.resolve(message.metrics as CandidateMetrics);return;
    }
    if(message.type==='command'&&message.action==='tiled-physical-stop'){
      aborted=true;senderRunning=false;cancelAnimationFrame(senderFrameHandle);if(role==='receiver')stopCamera();return;
    }
    if(role==='receiver'&&message.type==='command'&&message.action==='tiled-physical-finished'){
      stopCamera();startButton.disabled=false;stopButton.disabled=true;progress.textContent=String(message.status||'finished');log(`physical calibration finished: ${message.status}`);return;
    }
    if(message.type==='server'&&message.event==='result-saved') log(`result saved${message.publish?.published?` and posted to Issue #${message.publish.issueNumber}`:''}`);
  });
}
async function receiverStart():Promise<void>{
  resetMetrics(null);progress.textContent='starting camera';await startCamera();latestReceiverMeta=receiverMetadata();startButton.disabled=true;stopButton.disabled=false;progress.textContent='running';send({type:'state',event:'tiled-physical-receiver-ready',receiver:latestReceiverMeta});log('Camera started. Keep the full desktop sender area inside the reticle; the full sweep is automatic.');
}
function userStop():void{
  aborted=true;send({type:'command',action:'tiled-physical-stop'});if(role==='receiver')stopCamera();senderRunning=false;cancelAnimationFrame(senderFrameHandle);startButton.disabled=false;stopButton.disabled=true;progress.textContent='stopped';log('stopped by user');
}
startButton.addEventListener('click',()=>{if(role==='receiver')void receiverStart().catch(error=>log(`camera error: ${String(error)}`));});
stopButton.addEventListener('click',userStop);

if(role==='sender'){
  document.body.classList.add('sender-mode');senderCanvas.parentElement!.hidden=false;roleTitle.textContent='TF-007 tiled sender';roleText.textContent='手机 Start 后自动开始；电脑端无需点击。';
}else if(role==='receiver'){
  document.body.classList.add('receiver-mode');senderCanvas.parentElement!.hidden=true;roleTitle.textContent='TF-007 phone receiver';roleText.textContent='手机横屏，对准整个电脑发射画面，只点一次 Start。';
}else{
  document.body.classList.add('both-mode');senderCanvas.parentElement!.hidden=true;receiverView.hidden=false;startButton.disabled=true;roleTitle.textContent='Open role-specific TF-007 URLs';
}
clearSender();connect();
