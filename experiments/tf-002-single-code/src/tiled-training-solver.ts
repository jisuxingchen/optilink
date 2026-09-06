import {homographyFromUnitSquare,mapHomography,quadInside,type Quad} from './optigrid-geometry.ts';
import {decodeFrameCellsV1,OPTIGRID_V1_BORDER,reservedCellValueV1} from './optigrid-v1.ts';

export type PixelLock={quad:Quad;phaseX:number;phaseY:number;threshold:number;score:number;contrast:number;bitErrors:number;bits:number};
export type Rect={x:number;y:number;width:number;height:number};

type Eval={lock:PixelLock;errorRate:number};

function luma(d:Uint8ClampedArray,o:number){return d[o]*0.2126+d[o+1]*0.7152+d[o+2]*0.0722;}
export function sampleLuma(image:ImageData,x:number,y:number){
  const px=Math.max(0,Math.min(image.width-1,x)),py=Math.max(0,Math.min(image.height-1,y));
  const x0=Math.floor(px),y0=Math.floor(py),x1=Math.min(image.width-1,x0+1),y1=Math.min(image.height-1,y0+1),tx=px-x0,ty=py-y0,str=image.width*4;
  const a=luma(image.data,y0*str+x0*4),b=luma(image.data,y0*str+x1*4),c=luma(image.data,y1*str+x0*4),d=luma(image.data,y1*str+x1*4);
  return(a*(1-tx)+b*tx)*(1-ty)+(c*(1-tx)+d*tx)*ty;
}
function clone(q:Quad):Quad{return{tl:{...q.tl},tr:{...q.tr},br:{...q.br},bl:{...q.bl}};}
function axisQuad(r:Rect,scale:number,ox:number,oy:number):Quad{const side=Math.min(r.width,r.height)*scale,cx=r.x+r.width/2+r.width*ox,cy=r.y+r.height/2+r.height*oy,left=cx-side/2,top=cy-side/2;return{tl:{x:left,y:top},tr:{x:left+side,y:top},br:{x:left+side,y:top+side},bl:{x:left,y:top+side}};}

function evaluateKnown(image:ImageData,matrix:number,cells:Uint8Array,quad:Quad,phaseX:number,phaseY:number,stride:number):Eval|null{
  if(!quadInside(quad,image.width,image.height,image.width*image.height*.006))return null;
  const h=homographyFromUnitSquare(quad);if(!h)return null;
  const values:Array<{v:number;e:number}>=[];let bs=0,bc=0,ws=0,wc=0;
  const start=OPTIGRID_V1_BORDER,end=matrix-OPTIGRID_V1_BORDER;
  for(let r=start;r<end;r+=stride)for(let c=start;c<end;c+=stride){const e=cells[r*matrix+c],p=mapHomography(h,(c+.5+phaseX)/matrix,(r+.5+phaseY)/matrix),v=sampleLuma(image,p.x,p.y);values.push({v,e});if(e){bs+=v;bc++;}else{ws+=v;wc++;}}
  if(!bc||!wc)return null;const black=bs/bc,white=ws/wc,contrast=white-black;if(contrast<1)return null;const threshold=(black+white)/2;let errors=0;for(const x of values)if((x.v<threshold?1:0)!==x.e)errors++;
  const bits=values.length,score=bits?(bits-errors)/bits:0;return{lock:{quad,phaseX,phaseY,threshold,score,contrast,bitErrors:errors,bits},errorRate:bits?errors/bits:1};
}
function better(a:Eval|null,b:Eval|null){if(!a)return b;if(!b)return a;if(b.errorRate<a.errorRate-1e-9)return b;if(a.errorRate<b.errorRate-1e-9)return a;if(b.lock.contrast>a.lock.contrast+0.5)return b;if(a.lock.contrast>b.lock.contrast+0.5)return a;return b.lock.score>a.lock.score?b:a;}

function refine(image:ImageData,matrix:number,cells:Uint8Array,initial:PixelLock):PixelLock{
  let best=evaluateKnown(image,matrix,cells,initial.quad,initial.phaseX,initial.phaseY,1)!;
  for(const step of[10,6,3,1.5,.75,.35]){
    let changed=true;let passes=0;
    while(changed&&passes++<2){changed=false;
      for(const corner of['tl','tr','br','bl'] as const)for(const axis of['x','y'] as const)for(const dir of[-1,1]){const q=clone(best.lock.quad);q[corner][axis]+=step*dir;const candidate=evaluateKnown(image,matrix,cells,q,best.lock.phaseX,best.lock.phaseY,1);const winner=better(best,candidate);if(winner!==best){best=winner!;changed=true;}}
    }
  }
  for(const radius of[.4,.2,.1,.05]){let phaseBest=best;for(const dx of[-radius,0,radius])for(const dy of[-radius,0,radius]){const candidate=evaluateKnown(image,matrix,cells,best.lock.quad,best.lock.phaseX+dx,best.lock.phaseY+dy,1);phaseBest=better(phaseBest,candidate)!;}best=phaseBest;}
  return best.lock;
}

export function acquireKnownTrainingLock(image:ImageData,matrix:number,cells:Uint8Array,rect:Rect):PixelLock|null{
  let best:Eval|null=null;
  for(let scale=.48;scale<=.9601;scale+=.04)for(let ox=-.14;ox<=.1401;ox+=.04)for(let oy=-.22;oy<=.2201;oy+=.055){const candidate=evaluateKnown(image,matrix,cells,axisQuad(rect,Number(scale.toFixed(3)),Number(ox.toFixed(3)),Number(oy.toFixed(3))),0,0,4);best=better(best,candidate);}
  if(!best||best.lock.score<.54||best.lock.contrast<6)return null;
  const refined=refine(image,matrix,cells,best.lock);
  return refined.score>=.72&&refined.contrast>=10?refined:null;
}

export function countKnownErrors(image:ImageData,matrix:number,cells:Uint8Array,lock:PixelLock){const e=evaluateKnown(image,matrix,cells,lock.quad,lock.phaseX,lock.phaseY,1);return e?{errors:e.lock.bitErrors,bits:e.lock.bits,score:e.lock.score,contrast:e.lock.contrast}:{errors:Number.MAX_SAFE_INTEGER,bits:0,score:0,contrast:0};}

type Reserved={row:number;column:number;expected:0|1};
const reservedCache=new Map<number,Reserved[]>();
function reserved(matrix:number){const cached=reservedCache.get(matrix);if(cached)return cached;const out:Reserved[]=[];for(let r=0;r<matrix;r++)for(let c=0;c<matrix;c++){const e=reservedCellValueV1(r,c,matrix);if(e===null)continue;const finder=(r<9||r>=matrix-9)&&(c<9||c>=matrix-9);if(!finder&&((r*7+c*11)%5!==0))continue;out.push({row:r,column:c,expected:e as 0|1});}reservedCache.set(matrix,out);return out;}
function evalReserved(image:ImageData,matrix:number,lock:PixelLock,phaseX:number,phaseY:number):PixelLock|null{const h=homographyFromUnitSquare(lock.quad);if(!h)return null;const ss=reserved(matrix);let bs=0,bc=0,ws=0,wc=0;const vals:number[]=[];for(const s of ss){const p=mapHomography(h,(s.column+.5+phaseX)/matrix,(s.row+.5+phaseY)/matrix),v=sampleLuma(image,p.x,p.y);vals.push(v);if(s.expected){bs+=v;bc++;}else{ws+=v;wc++;}}if(!bc||!wc)return null;const black=bs/bc,white=ws/wc,contrast=white-black;if(contrast<=0)return null;const threshold=(black+white)/2;let errors=0;for(let i=0;i<ss.length;i++)if((vals[i]<threshold?1:0)!==ss[i].expected)errors++;const bits=ss.length,score=(bits-errors)/bits;return{...lock,phaseX,phaseY,threshold,contrast,score,bitErrors:errors,bits};}
export function trackReservedLock(image:ImageData,matrix:number,trainingLock:PixelLock){let best:PixelLock|null=null;for(const dx of[-.3,-.15,0,.15,.3])for(const dy of[-.3,-.15,0,.15,.3]){const c=evalReserved(image,matrix,trainingLock,trainingLock.phaseX+dx,trainingLock.phaseY+dy);if(c&&(!best||c.score>best.score+1e-9||(Math.abs(c.score-best.score)<1e-9&&c.contrast>best.contrast)))best=c;}return best&&best.score>=.68&&best.contrast>=12?best:null;}
export function decodeWithPixelLock(image:ImageData,matrix:number,lock:PixelLock){const h=homographyFromUnitSquare(lock.quad);if(!h)return null;const cells=new Uint8Array(matrix*matrix);for(let r=OPTIGRID_V1_BORDER;r<matrix-OPTIGRID_V1_BORDER;r++)for(let c=OPTIGRID_V1_BORDER;c<matrix-OPTIGRID_V1_BORDER;c++){const p=mapHomography(h,(c+.5+lock.phaseX)/matrix,(r+.5+lock.phaseY)/matrix);cells[r*matrix+c]=sampleLuma(image,p.x,p.y)<lock.threshold?1:0;}return decodeFrameCellsV1(cells,matrix);}
