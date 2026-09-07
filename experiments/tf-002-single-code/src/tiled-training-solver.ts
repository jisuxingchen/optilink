import * as legacy from './tiled-training-solver-legacy.ts';
import {acquireKnownTrainingLock as acquireCore} from './tiled-training-solver-core.ts';
import {locateOrientationFiducials,type FiducialLocatorDiagnostic} from './tiled-orientation-fiducial.ts';
import type {PixelLock,Rect,TrainingRegionDiagnostic} from './tiled-training-solver-legacy.ts';

export const countKnownErrors=legacy.countKnownErrors;
export const sampleLuma=legacy.sampleLuma;
export const decodeWithPixelLock=legacy.decodeWithPixelLock;
export const diagnoseTrainingRegion=legacy.diagnoseTrainingRegion;
export const trackReservedLock=legacy.trackReservedLock;
export type {PixelLock,Rect,TrainingRegionDiagnostic};

export type PhysicalAcquisitionDiagnostic={
  sequence:number;
  timestampMs:number;
  fiducial:FiducialLocatorDiagnostic;
};

const diagCache=new WeakMap<ImageData,PhysicalAcquisitionDiagnostic>();
const history:PhysicalAcquisitionDiagnostic[]=[];
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
