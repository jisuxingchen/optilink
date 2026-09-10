import {countKnownErrors,type PixelLock} from './tiled-training-solver.ts';

type Rated={lock:PixelLock;errors:number;bits:number;score:number;contrast:number};

function cloneLock(lock:PixelLock):PixelLock{return{...lock,quad:{tl:{...lock.quad.tl},tr:{...lock.quad.tr},br:{...lock.quad.br},bl:{...lock.quad.bl}}};}
function center(lock:PixelLock){return{x:(lock.quad.tl.x+lock.quad.tr.x+lock.quad.br.x+lock.quad.bl.x)/4,y:(lock.quad.tl.y+lock.quad.tr.y+lock.quad.br.y+lock.quad.bl.y)/4};}
function side(lock:PixelLock){const q=lock.quad,edges=[Math.hypot(q.tr.x-q.tl.x,q.tr.y-q.tl.y),Math.hypot(q.br.x-q.bl.x,q.br.y-q.bl.y),Math.hypot(q.bl.x-q.tl.x,q.bl.y-q.tl.y),Math.hypot(q.br.x-q.tr.x,q.br.y-q.tr.y)];return edges.reduce((a,b)=>a+b,0)/edges.length;}
function rate(image:ImageData,matrix:number,cells:Uint8Array,lock:PixelLock):Rated{const measured=countKnownErrors(image,matrix,cells,lock);return{lock,errors:measured.errors,bits:measured.bits,score:measured.score,contrast:measured.contrast};}
function better(candidate:Rated,best:Rated){if(candidate.errors!==best.errors)return candidate.errors<best.errors;if(Math.abs(candidate.score-best.score)>1e-9)return candidate.score>best.score;return candidate.contrast>best.contrast;}
function transformed(start:PixelLock,dx:number,dy:number,scale:number,angle:number){const out=cloneLock(start),c=center(start),cos=Math.cos(angle),sin=Math.sin(angle);for(const key of['tl','tr','br','bl'] as const){const p=start.quad[key],x=(p.x-c.x)*scale,y=(p.y-c.y)*scale;out.quad[key].x=c.x+x*cos-y*sin+dx;out.quad[key].y=c.y+x*sin+y*cos+dy;}return out;}

/**
 * Known training cells are the authority here. This is deliberately constrained:
 * it only explores sub-pixel/small whole-quad changes around an already acquired
 * lock and never turns a non-zero residual into an accepted result unless the
 * full known preamble reaches exactly zero errors.
 */
export function refineKnownTrainingResidual(image:ImageData,matrix:number,cells:Uint8Array,start:PixelLock){
  let best=rate(image,matrix,cells,cloneLock(start));const beforeErrors=best.errors;
  if(beforeErrors===0||!Number.isFinite(beforeErrors)||beforeErrors>64)return{lock:best.lock,beforeErrors,afterErrors:best.errors,improved:false};
  const sidePx=Math.max(1,side(best.lock));
  for(const step of[1,.5,.25,.125]){
    const origin=best.lock,scaleDelta=step/sidePx,angleDelta=step/sidePx;
    const transforms:Array<[number,number,number,number]>=[
      [step,0,1,0],[-step,0,1,0],[0,step,1,0],[0,-step,1,0],
      [step,step,1,0],[step,-step,1,0],[-step,step,1,0],[-step,-step,1,0],
      [0,0,1+scaleDelta,0],[0,0,1-scaleDelta,0],[0,0,1,angleDelta],[0,0,1,-angleDelta],
    ];
    for(const [dx,dy,scale,angle] of transforms){const candidate=rate(image,matrix,cells,transformed(origin,dx,dy,scale,angle));if(better(candidate,best))best=candidate;if(best.errors===0)return{lock:best.lock,beforeErrors,afterErrors:0,improved:true};}
  }
  for(const step of[.5,.25,.125,.0625]){
    const origin=best.lock;
    for(const corner of['tl','tr','br','bl'] as const)for(const axis of['x','y'] as const)for(const direction of[-1,1]){
      const lock=cloneLock(origin);lock.quad[corner][axis]+=step*direction;const candidate=rate(image,matrix,cells,lock);if(better(candidate,best))best=candidate;if(best.errors===0)return{lock:best.lock,beforeErrors,afterErrors:0,improved:true};
    }
  }
  for(const radius of[.04,.02,.01,.005]){
    const origin=best.lock;for(const dx of[-radius,0,radius])for(const dy of[-radius,0,radius]){const lock=cloneLock(origin);lock.phaseX=origin.phaseX+dx;lock.phaseY=origin.phaseY+dy;const candidate=rate(image,matrix,cells,lock);if(better(candidate,best))best=candidate;if(best.errors===0)return{lock:best.lock,beforeErrors,afterErrors:0,improved:true};}
  }
  return{lock:best.lock,beforeErrors,afterErrors:best.errors,improved:best.errors<beforeErrors};
}
