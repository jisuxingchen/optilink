import {homographyFromUnitSquare,mapHomography,quadInside,type Point,type Quad} from './optigrid-geometry.ts';
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
function scaleQuad(q:Quad,factor:number):Quad{const cx=(q.tl.x+q.tr.x+q.br.x+q.bl.x)/4,cy=(q.tl.y+q.tr.y+q.br.y+q.bl.y)/4;const p=(v:Point):Point=>({x:cx+(v.x-cx)*factor,y:cy+(v.y-cy)*factor});return{tl:p(q.tl),tr:p(q.tr),br:p(q.br),bl:p(q.bl)};}

function darkQuadSeed(image:ImageData,rect:Rect):Quad|null{
  const step=Math.max(2,Math.floor(image.width/640));
  const values:number[]=[];
  for(let y=Math.floor(rect.y);y<Math.ceil(rect.y+rect.height);y+=step*2)for(let x=Math.floor(rect.x);x<Math.ceil(rect.x+rect.width);x+=step*2)values.push(sampleLuma(image,x,y));
  if(values.length<40)return null;values.sort((a,b)=>a-b);const low=values[Math.floor(values.length*.05)]??0,high=values[Math.floor(values.length*.75)]??255,threshold=low+(high-low)*.34;
  let tl:Point|null=null,tr:Point|null=null,br:Point|null=null,bl:Point|null=null,tlScore=Infinity,trScore=-Infinity,brScore=-Infinity,blScore=Infinity,count=0;
  for(let y=Math.floor(rect.y);y<Math.ceil(rect.y+rect.height);y+=step)for(let x=Math.floor(rect.x);x<Math.ceil(rect.x+rect.width);x+=step){if(sampleLuma(image,x,y)>=threshold)continue;count++;const sum=x+y,diff=x-y;if(sum<tlScore){tlScore=sum;tl={x,y};}if(diff>trScore){trScore=diff;tr={x,y};}if(sum>brScore){brScore=sum;br={x,y};}if(diff<blScore){blScore=diff;bl={x,y};}}
  if(count<80||!tl||!tr||!br||!bl)return null;return{tl,tr,br,bl};
}

function evaluateKnown(image:ImageData,matrix:number,cells:Uint8Array,quad:Quad,phaseX:number,phaseY:number,stride:number):Eval|null{
  if(!quadInside(quad,image.width,image.height,image.width*image.height*.006))return null;
  const h=homographyFromUnitSquare(quad);if(!h)return null;
  let bs=0,bc=0,ws=0,wc=0;const values:number[]=[],expected:number[]=[];
  const start=OPTIGRID_V1_BORDER,end=matrix-OPTIGRID_V1_BORDER;
  for(let r=start;r<end;r+=stride)for(let c=start;c<end;c+=stride){const e=cells[r*matrix+c],p=mapHomography(h,(c+.5+phaseX)/matrix,(r+.5+phaseY)/matrix),v=sampleLuma(image,p.x,p.y);values.push(v);expected.push(e);if(e){bs+=v;bc++;}else{ws+=v;wc++;}}
  if(!bc||!wc)return null;const black=bs/bc,white=ws/wc,contrast=white-black;if(contrast<1)return null;const threshold=(black+white)/2;let errors=0;for(let i=0;i<values.length;i++)if((values[i]<threshold?1:0)!==expected[i])errors++;
  const bits=values.length,score=bits?(bits-errors)/bits:0;return{lock:{quad,phaseX,phaseY,threshold,score,contrast,bitErrors:errors,bits},errorRate:bits?errors/bits:1};
}
function compareEval(a:Eval,b:Eval){if(Math.abs(a.errorRate-b.errorRate)>1e-9)return a.errorRate-b.errorRate;if(Math.abs(a.lock.contrast-b.lock.contrast)>.5)return b.lock.contrast-a.lock.contrast;return b.lock.score-a.lock.score;}
function bestOf(items:Array<Eval|null>){const valid=items.filter((x):x is Eval=>Boolean(x));valid.sort(compareEval);return valid[0]||null;}
function pushTop(list:Eval[],candidate:Eval|null,limit:number){if(!candidate)return;list.push(candidate);list.sort(compareEval);if(list.length>limit)list.length=limit;}

function localRefine(image:ImageData,matrix:number,cells:Uint8Array,start:PixelLock,stride:number,steps:number[],passes=1):PixelLock{
  let best=evaluateKnown(image,matrix,cells,start.quad,start.phaseX,start.phaseY,stride);if(!best)return start;
  for(const step of steps){for(let pass=0;pass<passes;pass++){let changed=false;for(const corner of['tl','tr','br','bl'] as const)for(const axis of['x','y'] as const)for(const dir of[-1,1]){const q=clone(best.lock.quad);q[corner][axis]+=step*dir;const c=evaluateKnown(image,matrix,cells,q,best.lock.phaseX,best.lock.phaseY,stride);if(c&&compareEval(c,best)<0){best=c;changed=true;}}if(!changed)break;}}
  return best.lock;
}
function phaseRefine(image:ImageData,matrix:number,cells:Uint8Array,start:PixelLock,stride:number,radii:number[]):PixelLock{
  let best=evaluateKnown(image,matrix,cells,start.quad,start.phaseX,start.phaseY,stride);if(!best)return start;
  for(const radius of radii){const candidates:Array<Eval|null>=[];for(const dx of[-radius,0,radius])for(const dy of[-radius,0,radius])candidates.push(evaluateKnown(image,matrix,cells,best.lock.quad,best.lock.phaseX+dx,best.lock.phaseY+dy,stride));const winner=bestOf([best,...candidates]);if(winner)best=winner;}
  return best.lock;
}
function fullRefine(image:ImageData,matrix:number,cells:Uint8Array,start:PixelLock){
  let lock=localRefine(image,matrix,cells,start,2,[4,2,1],1);lock=phaseRefine(image,matrix,cells,lock,2,[.3,.15]);lock=localRefine(image,matrix,cells,lock,1,[1,.5,.25],1);lock=phaseRefine(image,matrix,cells,lock,1,[.12,.06,.03]);return evaluateKnown(image,matrix,cells,lock.quad,lock.phaseX,lock.phaseY,1)?.lock||lock;
}

export function acquireKnownTrainingLock(image:ImageData,matrix:number,cells:Uint8Array,rect:Rect):PixelLock|null{
  const coarse:Eval[]=[];
  // OptiGrid v1 has black outer finder edges in all four corners. Use those physical
  // dark-pixel extrema as projective seeds before the generic axis-grid fallback.
  const dark=darkQuadSeed(image,rect);
  if(dark)for(const factor of[.97,.985,1,1.015,1.03])pushTop(coarse,evaluateKnown(image,matrix,cells,scaleQuad(dark,factor),0,0,3),12);
  for(const scale of[.52,.58,.64,.70,.76,.82,.88,.94])for(const ox of[-.12,-.08,-.04,0,.04,.08,.12])for(const oy of[-.18,-.12,-.06,0,.06,.12,.18])pushTop(coarse,evaluateKnown(image,matrix,cells,axisQuad(rect,scale,ox,oy),0,0,6),12);
  if(!coarse.length||coarse[0].lock.score<.52||coarse[0].lock.contrast<5)return null;

  const middle:Eval[]=[];
  for(const hypothesis of coarse){let lock=localRefine(image,matrix,cells,hypothesis.lock,3,[8,4,2],1);lock=phaseRefine(image,matrix,cells,lock,3,[.3,.15]);pushTop(middle,evaluateKnown(image,matrix,cells,lock.quad,lock.phaseX,lock.phaseY,2),5);}
  if(!middle.length)return null;

  const finals:Eval[]=[];
  for(const candidate of middle){const lock=fullRefine(image,matrix,cells,candidate.lock);pushTop(finals,evaluateKnown(image,matrix,cells,lock.quad,lock.phaseX,lock.phaseY,1),2);}
  const best=finals[0];return best&&best.lock.score>=.80&&best.lock.contrast>=10?best.lock:null;
}

export function countKnownErrors(image:ImageData,matrix:number,cells:Uint8Array,lock:PixelLock){const e=evaluateKnown(image,matrix,cells,lock.quad,lock.phaseX,lock.phaseY,1);return e?{errors:e.lock.bitErrors,bits:e.lock.bits,score:e.lock.score,contrast:e.lock.contrast}:{errors:Number.MAX_SAFE_INTEGER,bits:0,score:0,contrast:0};}

type Reserved={row:number;column:number;expected:0|1};
const reservedCache=new Map<number,Reserved[]>();
function reserved(matrix:number){const cached=reservedCache.get(matrix);if(cached)return cached;const out:Reserved[]=[];for(let r=0;r<matrix;r++)for(let c=0;c<matrix;c++){const e=reservedCellValueV1(r,c,matrix);if(e===null)continue;const finder=(r<9||r>=matrix-9)&&(c<9||c>=matrix-9);if(!finder&&((r*7+c*11)%5!==0))continue;out.push({row:r,column:c,expected:e as 0|1});}reservedCache.set(matrix,out);return out;}
function evalReserved(image:ImageData,matrix:number,lock:PixelLock,phaseX:number,phaseY:number):PixelLock|null{const h=homographyFromUnitSquare(lock.quad);if(!h)return null;const ss=reserved(matrix);let bs=0,bc=0,ws=0,wc=0;const vals:number[]=[];for(const s of ss){const p=mapHomography(h,(s.column+.5+phaseX)/matrix,(s.row+.5+phaseY)/matrix),v=sampleLuma(image,p.x,p.y);vals.push(v);if(s.expected){bs+=v;bc++;}else{ws+=v;wc++;}}if(!bc||!wc)return null;const black=bs/bc,white=ws/wc,contrast=white-black;if(contrast<=0)return null;const threshold=(black+white)/2;let errors=0;for(let i=0;i<ss.length;i++)if((vals[i]<threshold?1:0)!==ss[i].expected)errors++;const bits=ss.length,score=(bits-errors)/bits;return{...lock,phaseX,phaseY,threshold,contrast,score,bitErrors:errors,bits};}
export function trackReservedLock(image:ImageData,matrix:number,trainingLock:PixelLock){let best:PixelLock|null=null;for(const dx of[-.3,-.15,0,.15,.3])for(const dy of[-.3,-.15,0,.15,.3]){const c=evalReserved(image,matrix,trainingLock,trainingLock.phaseX+dx,trainingLock.phaseY+dy);if(c&&(!best||c.score>best.score+1e-9||(Math.abs(c.score-best.score)<1e-9&&c.contrast>best.contrast)))best=c;}return best&&best.score>=.68&&best.contrast>=12?best:null;}
export function decodeWithPixelLock(image:ImageData,matrix:number,lock:PixelLock){const h=homographyFromUnitSquare(lock.quad);if(!h)return null;const cells=new Uint8Array(matrix*matrix);for(let r=OPTIGRID_V1_BORDER;r<matrix-OPTIGRID_V1_BORDER;r++)for(let c=OPTIGRID_V1_BORDER;c<matrix-OPTIGRID_V1_BORDER;c++){const p=mapHomography(h,(c+.5+lock.phaseX)/matrix,(r+.5+lock.phaseY)/matrix);cells[r*matrix+c]=sampleLuma(image,p.x,p.y)<lock.threshold?1:0;}return decodeFrameCellsV1(cells,matrix);}
