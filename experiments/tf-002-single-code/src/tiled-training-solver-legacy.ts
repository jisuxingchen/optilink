import {homographyFromUnitSquare,mapHomography,type Quad} from './optigrid-geometry.ts';
import {OPTIGRID_V1_BORDER,reservedCellValueV1} from './optigrid-v1.ts';
import {
  acquireKnownTrainingLock as acquireCore,
  countKnownErrors,
  sampleLuma,
  trackReservedLock as trackCore,
  decodeWithPixelLock as decodeCore,
  type PixelLock,
  type Rect,
  type TrainingRegionDiagnostic,
} from './tiled-training-solver-core.ts';

export {countKnownErrors,sampleLuma};
export const decodeWithPixelLock=decodeCore;
export type {PixelLock,Rect,TrainingRegionDiagnostic};

type TextureComponent={x:number;y:number;width:number;height:number;count:number;strength:number};
type RatedLock={lock:PixelLock;errors:number;bits:number;score:number;contrast:number};
type ReservedSample={row:number;column:number;expected:0|1};

const tripletCache=new WeakMap<ImageData,TextureComponent[]|null>();
const reservedCache=new Map<number,ReservedSample[]>();

function clampRect(rect:Rect,width:number,height:number):Rect{
  const x=Math.max(0,rect.x),y=Math.max(0,rect.y),right=Math.min(width,rect.x+rect.width),bottom=Math.min(height,rect.y+rect.height);
  return{x,y,width:Math.max(1,right-x),height:Math.max(1,bottom-y)};
}
function center(component:TextureComponent){return{x:component.x+component.width/2,y:component.y+component.height/2};}
function side(component:TextureComponent){return Math.max(component.width,component.height);}
function quantile(sorted:number[],fraction:number){if(!sorted.length)return 0;return sorted[Math.min(sorted.length-1,Math.max(0,Math.floor((sorted.length-1)*fraction)))];}
function cloneLock(lock:PixelLock):PixelLock{return{...lock,quad:{tl:{...lock.quad.tl},tr:{...lock.quad.tr},br:{...lock.quad.br},bl:{...lock.quad.bl}}};}
function quadCenter(quad:Quad){return{x:(quad.tl.x+quad.tr.x+quad.br.x+quad.bl.x)/4,y:(quad.tl.y+quad.tr.y+quad.br.y+quad.bl.y)/4};}
function quadSide(quad:Quad){const edges=[Math.hypot(quad.tr.x-quad.tl.x,quad.tr.y-quad.tl.y),Math.hypot(quad.br.x-quad.bl.x,quad.br.y-quad.bl.y),Math.hypot(quad.bl.x-quad.tl.x,quad.bl.y-quad.tl.y),Math.hypot(quad.br.x-quad.tr.x,quad.br.y-quad.tr.y)];return edges.reduce((a,b)=>a+b,0)/edges.length;}

// Diagnostics intentionally use P01-P99 for dynamic range. A physically small tile can
// contribute less than 5% of a broad lane, so P05-P95 can collapse to the background and
// falsely report zero contrast even when a strong optical target is visible.
export function diagnoseTrainingRegion(image:ImageData,rect:Rect):TrainingRegionDiagnostic{
  const r=clampRect(rect,image.width,image.height),step=Math.max(2,Math.floor(image.width/640)),values:number[]=[];
  for(let y=Math.floor(r.y);y<Math.ceil(r.y+r.height);y+=step*2)for(let x=Math.floor(r.x);x<Math.ceil(r.x+r.width);x+=step*2)values.push(sampleLuma(image,x,y));
  values.sort((a,b)=>a-b);
  const p01=quantile(values,.01),p05=quantile(values,.05),p50=quantile(values,.50),p75=quantile(values,.75),p95=quantile(values,.95),p99=quantile(values,.99);
  const darkThreshold=p01+(p75-p01)*.34;
  let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity,darkPixelCount=0;
  for(let y=Math.floor(r.y);y<Math.ceil(r.y+r.height);y+=step)for(let x=Math.floor(r.x);x<Math.ceil(r.x+r.width);x+=step){if(sampleLuma(image,x,y)>=darkThreshold)continue;darkPixelCount++;minX=Math.min(minX,x);minY=Math.min(minY,y);maxX=Math.max(maxX,x);maxY=Math.max(maxY,y);}
  const total=Math.max(1,Math.ceil(r.width/step)*Math.ceil(r.height/step));
  return{rect:r,sampleCount:values.length,p05,p50,p75,p95,dynamicRange:p99-p01,darkThreshold,darkPixelCount,darkPixelRatio:darkPixelCount/total,darkBounds:darkPixelCount?{x:minX,y:minY,width:maxX-minX+1,height:maxY-minY+1}:null};
}

function findTextureComponents(image:ImageData):TextureComponent[]{
  const block=Math.max(6,Math.floor(image.width/160)),cols=Math.floor(image.width/block),rows=Math.floor(image.height/block);
  const active=new Uint8Array(cols*rows),strengths=new Float32Array(cols*rows);
  for(let row=0;row<rows;row++)for(let col=0;col<cols;col++){
    const cx=(col+.5)*block,cy=(row+.5)*block,d=block*.36;
    const values=[
      sampleLuma(image,cx,cy),sampleLuma(image,cx-d,cy),sampleLuma(image,cx+d,cy),sampleLuma(image,cx,cy-d),sampleLuma(image,cx,cy+d),
      sampleLuma(image,cx-d,cy-d),sampleLuma(image,cx+d,cy-d),sampleLuma(image,cx-d,cy+d),sampleLuma(image,cx+d,cy+d),
    ];
    let lo=255,hi=0;for(const value of values){lo=Math.min(lo,value);hi=Math.max(hi,value);}const range=hi-lo,index=row*cols+col;
    strengths[index]=range;if(range>=44)active[index]=1;
  }
  const dilated=new Uint8Array(active.length);
  for(let row=0;row<rows;row++)for(let col=0;col<cols;col++){
    let hit=false;for(let dy=-1;dy<=1&&!hit;dy++)for(let dx=-1;dx<=1;dx++){
      const rr=row+dy,cc=col+dx;if(rr>=0&&rr<rows&&cc>=0&&cc<cols&&active[rr*cols+cc]){hit=true;break;}
    }
    if(hit)dilated[row*cols+col]=1;
  }
  const seen=new Uint8Array(dilated.length),components:TextureComponent[]=[];
  for(let row=0;row<rows;row++)for(let col=0;col<cols;col++){
    const start=row*cols+col;if(!dilated[start]||seen[start])continue;seen[start]=1;const queue=[start];let minC=col,maxC=col,minR=row,maxR=row,count=0,strength=0;
    for(let qi=0;qi<queue.length;qi++){
      const index=queue[qi],rr=Math.floor(index/cols),cc=index%cols;count++;strength+=strengths[index];minC=Math.min(minC,cc);maxC=Math.max(maxC,cc);minR=Math.min(minR,rr);maxR=Math.max(maxR,rr);
      for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
        if(!dx&&!dy)continue;const nr=rr+dy,nc=cc+dx;if(nr<0||nr>=rows||nc<0||nc>=cols)continue;const ni=nr*cols+nc;
        if(dilated[ni]&&!seen[ni]){seen[ni]=1;queue.push(ni);}
      }
    }
    const width=(maxC-minC+1)*block,height=(maxR-minR+1)*block,aspect=width/height,componentSide=Math.max(width,height);
    if(count<18||aspect<.45||aspect>2.2||componentSide<image.height*.07||componentSide>image.height*.75)continue;
    components.push({x:minC*block,y:minR*block,width,height,count,strength});
  }
  return components.sort((a,b)=>(b.count+b.strength/180)-(a.count+a.strength/180));
}

function bestHorizontalTriplet(image:ImageData,components:TextureComponent[]):TextureComponent[]|null{
  const pool=components.slice(0,10),candidates:Array<{items:TextureComponent[];score:number}>=[];
  for(let i=0;i<pool.length;i++)for(let j=i+1;j<pool.length;j++)for(let k=j+1;k<pool.length;k++){
    const items=[pool[i],pool[j],pool[k]].sort((a,b)=>center(a).x-center(b).x),p=items.map(center),d1=p[1].x-p[0].x,d2=p[2].x-p[1].x,spacing=(d1+d2)/2;
    if(d1<image.width*.08||d2<image.width*.08||spacing>image.width*.42)continue;
    const spacingError=Math.abs(d1-d2)/Math.max(1,spacing),ySpread=(Math.max(...p.map(v=>v.y))-Math.min(...p.map(v=>v.y)))/Math.max(1,spacing);
    const sizes=items.map(side),meanSize=sizes.reduce((a,b)=>a+b,0)/3,sizeSpread=(Math.max(...sizes)-Math.min(...sizes))/Math.max(1,meanSize);
    if(spacingError>.38||ySpread>.55||sizeSpread>.65)continue;
    const strengthBonus=Math.min(1,items.reduce((sum,item)=>sum+item.count+item.strength/180,0)/900);
    candidates.push({items,score:spacingError*6+ySpread*3+sizeSpread*2-strengthBonus*.35});
  }
  candidates.sort((a,b)=>a.score-b.score);return candidates[0]?.items||null;
}
function tripletFor(image:ImageData){if(tripletCache.has(image))return tripletCache.get(image)||null;const value=bestHorizontalTriplet(image,findTextureComponents(image));tripletCache.set(image,value);return value;}

function geometryLocalRect(image:ImageData,component:TextureComponent,estimatedTileSide:number,coreScale:number):Rect{
  const p=center(component),windowSide=estimatedTileSide/coreScale;
  return clampRect({x:p.x-windowSide/2,y:p.y-windowSide/2,width:windowSide,height:windowSide},image.width,image.height);
}
function knownEval(image:ImageData,matrix:number,cells:Uint8Array,lock:PixelLock):RatedLock{
  const h=homographyFromUnitSquare(lock.quad);if(!h)return{lock,errors:Number.MAX_SAFE_INTEGER,bits:0,score:0,contrast:0};
  let blackSum=0,blackCount=0,whiteSum=0,whiteCount=0;const values:number[]=[],expected:number[]=[];
  for(let row=OPTIGRID_V1_BORDER;row<matrix-OPTIGRID_V1_BORDER;row++)for(let column=OPTIGRID_V1_BORDER;column<matrix-OPTIGRID_V1_BORDER;column++){
    const e=cells[row*matrix+column],p=mapHomography(h,(column+.5+lock.phaseX)/matrix,(row+.5+lock.phaseY)/matrix),v=sampleLuma(image,p.x,p.y);values.push(v);expected.push(e);if(e){blackSum+=v;blackCount++;}else{whiteSum+=v;whiteCount++;}
  }
  if(!blackCount||!whiteCount)return{lock,errors:Number.MAX_SAFE_INTEGER,bits:0,score:0,contrast:0};
  const black=blackSum/blackCount,white=whiteSum/whiteCount,contrast=white-black,threshold=(black+white)/2;let errors=0;
  for(let i=0;i<values.length;i++)if((values[i]<threshold?1:0)!==expected[i])errors++;
  const bits=values.length,score=bits?(bits-errors)/bits:0;return{lock:{...lock,threshold,score,contrast,bitErrors:errors,bits},errors,bits,score,contrast};
}
function better(a:RatedLock,b:RatedLock|null){if(!b)return true;if(a.errors!==b.errors)return a.errors<b.errors;if(Math.abs(a.contrast-b.contrast)>.25)return a.contrast>b.contrast;return a.score>b.score;}
function transformQuad(lock:PixelLock,dx:number,dy:number,scale:number,angle:number){
  const out=cloneLock(lock),c=quadCenter(lock.quad),cos=Math.cos(angle),sin=Math.sin(angle);
  for(const key of['tl','tr','br','bl'] as const){const p=lock.quad[key],x=(p.x-c.x)*scale,y=(p.y-c.y)*scale;out.quad[key].x=c.x+x*cos-y*sin+dx;out.quad[key].y=c.y+x*sin+y*cos+dy;}return out;
}
function microRefineKnown(image:ImageData,matrix:number,cells:Uint8Array,start:PixelLock):PixelLock{
  let best=knownEval(image,matrix,cells,start);if(best.errors===0||best.errors>256)return best.lock;
  const sidePx=Math.max(1,quadSide(best.lock.quad));
  // High-density residuals are often coherent sub-pixel transforms. Test whole-quad
  // translation/scale/rotation before corner-wise edits so one corner does not have to move
  // through a temporarily worse state to reach the correct geometry.
  for(const step of[.75,.375,.1875,.09375]){
    const origin=best.lock,scaleDelta=step/sidePx,angleDelta=step/sidePx;
    const candidates:Array<[number,number,number,number]>=[
      [step,0,1,0],[-step,0,1,0],[0,step,1,0],[0,-step,1,0],
      [step,step,1,0],[step,-step,1,0],[-step,step,1,0],[-step,-step,1,0],
      [0,0,1+scaleDelta,0],[0,0,1-scaleDelta,0],[0,0,1,angleDelta],[0,0,1,-angleDelta],
    ];
    for(const [dx,dy,scale,angle] of candidates){const rated=knownEval(image,matrix,cells,transformQuad(origin,dx,dy,scale,angle));if(better(rated,best))best=rated;if(best.errors===0)return best.lock;}
  }
  for(const step of[.5,.25,.125,.0625]){
    for(const corner of['tl','tr','br','bl'] as const)for(const axis of['x','y'] as const)for(const dir of[-1,1]){
      const lock=cloneLock(best.lock);lock.quad[corner][axis]+=step*dir;const candidate=knownEval(image,matrix,cells,lock);if(better(candidate,best))best=candidate;if(best.errors===0)return best.lock;
    }
  }
  for(const radius of[.03,.015,.0075,.00375]){
    const origin=best.lock;for(const dx of[-radius,0,radius])for(const dy of[-radius,0,radius]){
      const lock=cloneLock(origin);lock.phaseX=origin.phaseX+dx;lock.phaseY=origin.phaseY+dy;const candidate=knownEval(image,matrix,cells,lock);if(better(candidate,best))best=candidate;if(best.errors===0)return best.lock;
    }
  }
  return best.lock;
}

export function acquireKnownTrainingLock(image:ImageData,matrix:number,cells:Uint8Array,rect:Rect):PixelLock|null{
  // Prefer the explicit three-tile locator. This avoids paying for, and being polluted by,
  // a broad fixed-lane fallback when the monitor occupies only part of the camera frame.
  const triplet=tripletFor(image);let best:RatedLock|null=null;
  if(triplet){
    const tileIndex=Math.max(0,Math.min(2,Math.floor((rect.x+rect.width/2)/image.width*3))),points=triplet.map(center);
    const spacing=((points[1].x-points[0].x)+(points[2].x-points[1].x))/2;
    const estimatedTileSide=spacing*(540/630);
    for(const coreScale of[.82,.88,.76]){
      const lock=acquireCore(image,matrix,cells,geometryLocalRect(image,triplet[tileIndex],estimatedTileSide,coreScale));
      if(!lock)continue;const rated=knownEval(image,matrix,cells,microRefineKnown(image,matrix,cells,lock));
      if(rated.errors===0)return rated.lock;if(better(rated,best))best=rated;
      // Do not pay for two more full searches when the first structured lock is already
      // within a couple of bits; the micro-refiner is the intended high-density finisher.
      if(rated.errors<=2)break;
    }
    if(best)return best.lock;
  }
  const direct=acquireCore(image,matrix,cells,rect);if(!direct)return null;return microRefineKnown(image,matrix,cells,direct);
}

function reservedSamples(matrix:number){const cached=reservedCache.get(matrix);if(cached)return cached;const out:ReservedSample[]=[];for(let row=0;row<matrix;row++)for(let column=0;column<matrix;column++){
  const value=reservedCellValueV1(row,column,matrix);if(value===null)continue;const finder=(row<9||row>=matrix-9)&&(column<9||column>=matrix-9);if(!finder&&((row*7+column*11)%5!==0))continue;out.push({row,column,expected:value as 0|1});
}reservedCache.set(matrix,out);return out;}
function reservedAtExactPhase(image:ImageData,matrix:number,trainingLock:PixelLock):PixelLock|null{
  const h=homographyFromUnitSquare(trainingLock.quad);if(!h)return null;const samples=reservedSamples(matrix);let blackSum=0,blackCount=0,whiteSum=0,whiteCount=0;const values:number[]=[];
  for(const item of samples){const p=mapHomography(h,(item.column+.5+trainingLock.phaseX)/matrix,(item.row+.5+trainingLock.phaseY)/matrix),v=sampleLuma(image,p.x,p.y);values.push(v);if(item.expected){blackSum+=v;blackCount++;}else{whiteSum+=v;whiteCount++;}}
  if(!blackCount||!whiteCount)return null;const black=blackSum/blackCount,white=whiteSum/whiteCount,contrast=white-black;if(contrast<=0)return null;const threshold=(black+white)/2;let errors=0;
  for(let i=0;i<samples.length;i++)if((values[i]<threshold?1:0)!==samples[i].expected)errors++;const bits=samples.length,score=bits?(bits-errors)/bits:0;return{...trainingLock,threshold,contrast,score,bitErrors:errors,bits};
}
export function trackReservedLock(image:ImageData,matrix:number,trainingLock:PixelLock):PixelLock|null{
  // Preamble geometry and phase are authoritative. Re-estimate threshold at that exact phase
  // first; only search neighboring phases when the exact-phase frame does not pass CRC.
  const baseline=reservedAtExactPhase(image,matrix,trainingLock);
  if(baseline&&baseline.score>=.68&&baseline.contrast>=12&&decodeCore(image,matrix,baseline))return baseline;
  return trackCore(image,matrix,trainingLock);
}
