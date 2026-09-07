import * as legacy from './tiled-training-solver-legacy.ts';
import {acquireKnownTrainingLock as acquireCore} from './tiled-training-solver-core.ts';
import {locateOrientationFiducials,type FiducialLocatorDiagnostic} from './tiled-orientation-fiducial.ts';
import {homographyFromUnitSquare,mapHomography,quadInside,type Quad} from './optigrid-geometry.ts';
import {reservedCellValueV1} from './optigrid-v1.ts';
import type {PixelLock,Rect,TrainingRegionDiagnostic} from './tiled-training-solver-legacy.ts';

export const countKnownErrors=legacy.countKnownErrors;
export const sampleLuma=legacy.sampleLuma;
export const decodeWithPixelLock=legacy.decodeWithPixelLock;
export const diagnoseTrainingRegion=legacy.diagnoseTrainingRegion;
export type {PixelLock,Rect,TrainingRegionDiagnostic};

export type PhysicalAcquisitionDiagnostic={
  sequence:number;
  timestampMs:number;
  fiducial:FiducialLocatorDiagnostic;
};

type ReservedSample={row:number;column:number;expected:0|1};

const diagCache=new WeakMap<ImageData,PhysicalAcquisitionDiagnostic>();
const history:PhysicalAcquisitionDiagnostic[]=[];
const reservedCache=new Map<number,ReservedSample[]>();
let sequence=0;

function diagnosticFor(image:ImageData):PhysicalAcquisitionDiagnostic{
  const cached=diagCache.get(image);if(cached)return cached;
  const value={sequence:++sequence,timestampMs:Date.now(),fiducial:locateOrientationFiducials(image)};
  diagCache.set(image,value);history.push(value);if(history.length>16)history.splice(0,history.length-16);return value;
}

export function getPhysicalAcquisitionDiagnostics():PhysicalAcquisitionDiagnostic[]{
  return history.map(item=>JSON.parse(JSON.stringify(item)) as PhysicalAcquisitionDiagnostic);
}
export function resetPhysicalAcquisitionDiagnostics():void{history.length=0;}

function clampRect(rect:Rect,width:number,height:number):Rect{
  const x=Math.max(0,rect.x),y=Math.max(0,rect.y),right=Math.min(width,rect.x+rect.width),bottom=Math.min(height,rect.y+rect.height);
  return{x,y,width:Math.max(1,right-x),height:Math.max(1,bottom-y)};
}

function betterLock(image:ImageData,matrix:number,cells:Uint8Array,candidate:PixelLock|null,best:{lock:PixelLock;errors:number}|null){
  if(!candidate)return best;const rated=legacy.countKnownErrors(image,matrix,cells,candidate);
  if(!best||rated.errors<best.errors||(rated.errors===best.errors&&candidate.contrast>best.lock.contrast))return{lock:candidate,errors:rated.errors};
  return best;
}

function cloneLock(lock:PixelLock):PixelLock{
  return{...lock,quad:{tl:{...lock.quad.tl},tr:{...lock.quad.tr},br:{...lock.quad.br},bl:{...lock.quad.bl}}};
}
function quadCenter(quad:Quad){return{x:(quad.tl.x+quad.tr.x+quad.br.x+quad.bl.x)/4,y:(quad.tl.y+quad.tr.y+quad.br.y+quad.bl.y)/4};}
function quadSide(quad:Quad){
  const edges=[Math.hypot(quad.tr.x-quad.tl.x,quad.tr.y-quad.tl.y),Math.hypot(quad.br.x-quad.bl.x,quad.br.y-quad.bl.y),Math.hypot(quad.bl.x-quad.tl.x,quad.bl.y-quad.tl.y),Math.hypot(quad.br.x-quad.tr.x,quad.br.y-quad.tr.y)];
  return edges.reduce((a,b)=>a+b,0)/edges.length;
}
function quadAxisAngle(quad:Quad){
  const dx=((quad.tr.x-quad.tl.x)+(quad.br.x-quad.bl.x))/2,dy=((quad.tr.y-quad.tl.y)+(quad.br.y-quad.bl.y))/2;
  return Math.atan2(dy,dx);
}
function normalizeAngle(value:number){while(value>Math.PI)value-=Math.PI*2;while(value<-Math.PI)value+=Math.PI*2;return value;}
function translateLock(lock:PixelLock,dx:number,dy:number):PixelLock{
  const out=cloneLock(lock);for(const key of['tl','tr','br','bl'] as const){out.quad[key].x+=dx;out.quad[key].y+=dy;}return out;
}
function transformLock(lock:PixelLock,target:{x:number;y:number},targetSide:number,targetAngle:number):PixelLock|null{
  const center=quadCenter(lock.quad),sourceSide=quadSide(lock.quad);if(sourceSide<1)return null;
  const scale=targetSide/sourceSide;if(!Number.isFinite(scale)||scale<.65||scale>1.5)return null;
  const angle=normalizeAngle(targetAngle-quadAxisAngle(lock.quad)),cos=Math.cos(angle),sin=Math.sin(angle),out=cloneLock(lock);
  for(const key of['tl','tr','br','bl'] as const){const p=lock.quad[key],x=(p.x-center.x)*scale,y=(p.y-center.y)*scale;out.quad[key].x=target.x+x*cos-y*sin;out.quad[key].y=target.y+x*sin+y*cos;}
  return out;
}

function reservedSamples(matrix:number):ReservedSample[]{
  const cached=reservedCache.get(matrix);if(cached)return cached;const out:ReservedSample[]=[];
  for(let row=0;row<matrix;row++)for(let column=0;column<matrix;column++){
    const expected=reservedCellValueV1(row,column,matrix);if(expected===null)continue;
    const finder=(row<9||row>=matrix-9)&&(column<9||column>=matrix-9);if(!finder&&((row*7+column*11)%5!==0))continue;
    out.push({row,column,expected:expected as 0|1});
  }
  reservedCache.set(matrix,out);return out;
}
function evaluateReserved(image:ImageData,matrix:number,lock:PixelLock):PixelLock|null{
  if(!quadInside(lock.quad,image.width,image.height,image.width*image.height*.006))return null;
  const h=homographyFromUnitSquare(lock.quad);if(!h)return null;const samples=reservedSamples(matrix);let blackSum=0,blackCount=0,whiteSum=0,whiteCount=0;const values:number[]=[];
  for(const sample of samples){const p=mapHomography(h,(sample.column+.5+lock.phaseX)/matrix,(sample.row+.5+lock.phaseY)/matrix),value=legacy.sampleLuma(image,p.x,p.y);values.push(value);if(sample.expected){blackSum+=value;blackCount++;}else{whiteSum+=value;whiteCount++;}}
  if(!blackCount||!whiteCount)return null;const black=blackSum/blackCount,white=whiteSum/whiteCount,contrast=white-black;if(contrast<=0)return null;const threshold=(black+white)/2;let errors=0;
  for(let i=0;i<samples.length;i++)if((values[i]<threshold?1:0)!==samples[i].expected)errors++;
  const bits=samples.length,score=bits?(bits-errors)/bits:0;return{...lock,threshold,contrast,score,bitErrors:errors,bits};
}
function betterTracked(candidate:PixelLock|null,best:PixelLock|null){
  if(!candidate)return best;if(!best)return candidate;if(candidate.score>best.score+1e-9)return candidate;if(Math.abs(candidate.score-best.score)<1e-9&&candidate.contrast>best.contrast)return candidate;return best;
}
function qualifiesTracked(lock:PixelLock|null){return Boolean(lock&&lock.score>=.68&&lock.contrast>=12);}

// Dynamic frames arrive after a static same-density preamble. A hand-held camera can move a
// few normalized pixels between those frames, which cell-phase search alone cannot absorb.
// Track whole-quad translation first, then finish with sub-cell phase refinement. The no-motion
// fast path is one reserved evaluation so stable frames stay cheap.
function trackLocalGeometry(image:ImageData,matrix:number,start:PixelLock):PixelLock|null{
  let best=evaluateReserved(image,matrix,start);if(best&&best.score>=.94&&best.contrast>=12)return best;
  for(const step of[6,3,1.5,.75]){
    const origin=best||start;
    for(const dx of[-step,0,step])for(const dy of[-step,0,step]){
      if(dx===0&&dy===0)continue;best=betterTracked(evaluateReserved(image,matrix,translateLock(origin,dx,dy)),best);
    }
  }
  if(best){
    for(const radius of[.3,.15,.075]){
      const origin=best as PixelLock;
      for(const dx of[-radius,0,radius])for(const dy of[-radius,0,radius]){
        const candidate=cloneLock(origin);candidate.phaseX=origin.phaseX+dx;candidate.phaseY=origin.phaseY+dy;best=betterTracked(evaluateReserved(image,matrix,candidate),best);
      }
    }
  }
  return qualifiesTracked(best)?best:null;
}

function fiducialAdaptedLock(start:PixelLock,triplet:NonNullable<FiducialLocatorDiagnostic['triplet']>):PixelLock|null{
  const center=quadCenter(start.quad);let index=0,bestDistance=Infinity;
  for(let i=0;i<triplet.points.length;i++){const point=triplet.points[i],distance=Math.hypot(point.x-center.x,point.y-center.y);if(distance<bestDistance){bestDistance=distance;index=i;}}
  const point=triplet.points[index],targetAngle=Math.atan2(triplet.axis.y,triplet.axis.x);
  return transformLock(start,{x:point.x,y:point.y},triplet.estimatedTileSide,targetAngle);
}

export function trackReservedLock(image:ImageData,matrix:number,trainingLock:PixelLock):PixelLock|null{
  const local=trackLocalGeometry(image,matrix,trainingLock);
  // High-confidence local geometry needs no full-frame scan. Lower-confidence/failed tracking
  // falls back to the macro fiducials, then is re-qualified by the unchanged reserved-cell gate.
  if(local&&local.score>=.90)return local;
  const triplet=diagnosticFor(image).fiducial.triplet;if(!triplet)return local;
  const adapted=fiducialAdaptedLock(local||trainingLock,triplet),recovered=adapted?trackLocalGeometry(image,matrix,adapted):null;
  const best=betterTracked(recovered,local);return qualifiesTracked(best)?best:null;
}

export function acquireKnownTrainingLock(image:ImageData,matrix:number,cells:Uint8Array,rect:Rect):PixelLock|null{
  const diagnostic=diagnosticFor(image),triplet=diagnostic.fiducial.triplet;
  let best:{lock:PixelLock;errors:number}|null=null;
  if(triplet){
    const tileIndex=Math.max(0,Math.min(2,Math.floor((rect.x+rect.width/2)/image.width*3)));
    const point=triplet.points[tileIndex],tileSide=triplet.estimatedTileSide;
    for(const coreScale of[.92,.86,.80,.74,.68]){
      const windowSide=tileSide/coreScale;
      const local=clampRect({x:point.x-windowSide/2,y:point.y-windowSide/2,width:windowSide,height:windowSide},image.width,image.height);
      best=betterLock(image,matrix,cells,acquireCore(image,matrix,cells,local),best);
      if(best?.errors===0)return best.lock;
    }
    if(best&&best.errors<=Math.max(8,Math.ceil((matrix-20)*(matrix-20)*.002)))return best.lock;
  }
  const fallback=legacy.acquireKnownTrainingLock(image,matrix,cells,rect);
  best=betterLock(image,matrix,cells,fallback,best);
  return best?.lock||null;
}
