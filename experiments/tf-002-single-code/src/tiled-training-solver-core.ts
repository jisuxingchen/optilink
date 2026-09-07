import {homographyFromUnitSquare,mapHomography,quadInside,type Point,type Quad} from './optigrid-geometry.ts';
import {decodeFrameCellsV1,OPTIGRID_V1_BORDER,reservedCellValueV1} from './optigrid-v1.ts';

export type PixelLock={quad:Quad;phaseX:number;phaseY:number;threshold:number;score:number;contrast:number;bitErrors:number;bits:number};
export type Rect={x:number;y:number;width:number;height:number};
export type TrainingRegionDiagnostic={
  rect:Rect;
  sampleCount:number;
  p01:number;
  p05:number;
  p50:number;
  p75:number;
  p95:number;
  p99:number;
  dynamicRange:number;
  darkThreshold:number;
  darkPixelCount:number;
  darkPixelRatio:number;
  darkBounds:Rect|null;
};
type Eval={lock:PixelLock;errorRate:number};
type TextureSeed={quad:Quad;strength:number};

function luma(d:Uint8ClampedArray,o:number){return d[o]*0.2126+d[o+1]*0.7152+d[o+2]*0.0722;}
export function sampleLuma(image:ImageData,x:number,y:number){
  const px=Math.max(0,Math.min(image.width-1,x)),py=Math.max(0,Math.min(image.height-1,y));
  const x0=Math.floor(px),y0=Math.floor(py),x1=Math.min(image.width-1,x0+1),y1=Math.min(image.height-1,y0+1),tx=px-x0,ty=py-y0,str=image.width*4;
  const a=luma(image.data,y0*str+x0*4),b=luma(image.data,y0*str+x1*4),c=luma(image.data,y1*str+x0*4),d=luma(image.data,y1*str+x1*4);
  return(a*(1-tx)+b*tx)*(1-ty)+(c*(1-tx)+d*tx)*ty;
}
function clone(q:Quad):Quad{return{tl:{...q.tl},tr:{...q.tr},br:{...q.br},bl:{...q.bl}};}
function axisQuad(r:Rect,scale:number,ox:number,oy:number):Quad{const side=Math.min(r.width,r.height)*scale,cx=r.x+r.width/2+r.width*ox,cy=r.y+r.height/2+r.height*oy,left=cx-side/2,top=cy-side/2;return{tl:{x:left,y:top},tr:{x:left+side,y:top},br:{x:left+side,y:top+side},bl:{x:left,y:top+side}};}
function squareQuad(cx:number,cy:number,side:number):Quad{const h=side/2;return{tl:{x:cx-h,y:cy-h},tr:{x:cx+h,y:cy-h},br:{x:cx+h,y:cy+h},bl:{x:cx-h,y:cy+h}};}
function scaleQuad(q:Quad,factor:number):Quad{const cx=(q.tl.x+q.tr.x+q.br.x+q.bl.x)/4,cy=(q.tl.y+q.tr.y+q.br.y+q.bl.y)/4;const p=(v:Point):Point=>({x:cx+(v.x-cx)*factor,y:cy+(v.y-cy)*factor});return{tl:p(q.tl),tr:p(q.tr),br:p(q.br),bl:p(q.bl)};}
function translateQuad(q:Quad,dx:number,dy:number):Quad{const p=(v:Point):Point=>({x:v.x+dx,y:v.y+dy});return{tl:p(q.tl),tr:p(q.tr),br:p(q.br),bl:p(q.bl)};}
function clampRect(r:Rect,width:number,height:number):Rect{const x=Math.max(0,r.x),y=Math.max(0,r.y),right=Math.min(width,r.x+r.width),bottom=Math.min(height,r.y+r.height);return{x,y,width:Math.max(1,right-x),height:Math.max(1,bottom-y)};}
function expandRect(r:Rect,image:ImageData,xFraction:number,yFraction:number):Rect{return clampRect({x:r.x-r.width*xFraction,y:r.y-r.height*yFraction,width:r.width*(1+xFraction*2),height:r.height*(1+yFraction*2)},image.width,image.height);}
function quantile(sorted:number[],fraction:number){if(!sorted.length)return 0;return sorted[Math.min(sorted.length-1,Math.max(0,Math.floor((sorted.length-1)*fraction)))];}

export function diagnoseTrainingRegion(image:ImageData,rect:Rect):TrainingRegionDiagnostic{
  const r=clampRect(rect,image.width,image.height),step=Math.max(2,Math.floor(image.width/640)),values:number[]=[];
  for(let y=Math.floor(r.y);y<Math.ceil(r.y+r.height);y+=step*2)for(let x=Math.floor(r.x);x<Math.ceil(r.x+r.width);x+=step*2)values.push(sampleLuma(image,x,y));
  values.sort((a,b)=>a-b);
  const p01=quantile(values,.01),p05=quantile(values,.05),p50=quantile(values,.50),p75=quantile(values,.75),p95=quantile(values,.95),p99=quantile(values,.99),darkThreshold=p01+(p75-p01)*.36;
  let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity,darkPixelCount=0,total=0;
  for(let y=Math.floor(r.y);y<Math.ceil(r.y+r.height);y+=step)for(let x=Math.floor(r.x);x<Math.ceil(r.x+r.width);x+=step){total++;if(sampleLuma(image,x,y)>=darkThreshold)continue;darkPixelCount++;minX=Math.min(minX,x);minY=Math.min(minY,y);maxX=Math.max(maxX,x);maxY=Math.max(maxY,y);}
  return{rect:r,sampleCount:values.length,p01,p05,p50,p75,p95,p99,dynamicRange:p99-p01,darkThreshold,darkPixelCount,darkPixelRatio:darkPixelCount/Math.max(1,total),darkBounds:darkPixelCount?{x:minX,y:minY,width:maxX-minX+1,height:maxY-minY+1}:null};
}

function darkQuadSeed(image:ImageData,rect:Rect):Quad|null{
  const diag=diagnoseTrainingRegion(image,rect),r=diag.rect,step=Math.max(2,Math.floor(image.width/640));
  let tl:Point|null=null,tr:Point|null=null,br:Point|null=null,bl:Point|null=null,tlScore=Infinity,trScore=-Infinity,brScore=-Infinity,blScore=Infinity,count=0;
  for(let y=Math.floor(r.y);y<Math.ceil(r.y+r.height);y+=step)for(let x=Math.floor(r.x);x<Math.ceil(r.x+r.width);x+=step){if(sampleLuma(image,x,y)>=diag.darkThreshold)continue;count++;const sum=x+y,diff=x-y;if(sum<tlScore){tlScore=sum;tl={x,y};}if(diff>trScore){trScore=diff;tr={x,y};}if(sum>brScore){brScore=sum;br={x,y};}if(diff<blScore){blScore=diff;bl={x,y};}}
  if(count<80||!tl||!tr||!br||!bl)return null;return{tl,tr,br,bl};
}

function textureQuadSeeds(image:ImageData,rect:Rect):TextureSeed[]{
  // OptiGrid is a dense high-frequency square on a comparatively smooth transmitter
  // background. Locate texture components first, independent of cell phase/payload, then
  // let the known optical preamble prove identity and exact geometry.
  const r=clampRect(rect,image.width,image.height),block=Math.max(6,Math.floor(image.width/160));
  const cols=Math.max(1,Math.floor(r.width/block)),rows=Math.max(1,Math.floor(r.height/block)),active=new Uint8Array(cols*rows),strengths=new Float32Array(cols*rows);
  for(let row=0;row<rows;row++)for(let col=0;col<cols;col++){
    const cx=r.x+(col+.5)*block,cy=r.y+(row+.5)*block,d=block*.34;
    const values=[sampleLuma(image,cx,cy),sampleLuma(image,cx-d,cy),sampleLuma(image,cx+d,cy),sampleLuma(image,cx,cy-d),sampleLuma(image,cx,cy+d),sampleLuma(image,cx-d,cy-d),sampleLuma(image,cx+d,cy-d),sampleLuma(image,cx-d,cy+d),sampleLuma(image,cx+d,cy+d)];
    let lo=255,hi=0;for(const v of values){lo=Math.min(lo,v);hi=Math.max(hi,v);}const range=hi-lo,index=row*cols+col;strengths[index]=range;if(range>=48)active[index]=1;
  }
  // One-block dilation bridges uniform cells/finder interiors without joining separate tiles.
  const dilated=new Uint8Array(active.length);
  for(let row=0;row<rows;row++)for(let col=0;col<cols;col++){let hit=0;for(let dy=-1;dy<=1&&!hit;dy++)for(let dx=-1;dx<=1;dx++){const rr=row+dy,cc=col+dx;if(rr>=0&&rr<rows&&cc>=0&&cc<cols&&active[rr*cols+cc]){hit=1;break;}}if(hit)dilated[row*cols+col]=1;}
  const seen=new Uint8Array(dilated.length),components:Array<{minC:number;maxC:number;minR:number;maxR:number;count:number;strength:number}>=[];
  for(let row=0;row<rows;row++)for(let col=0;col<cols;col++){
    const start=row*cols+col;if(!dilated[start]||seen[start])continue;seen[start]=1;const queue=[start];let minC=col,maxC=col,minR=row,maxR=row,count=0,strength=0;
    for(let qi=0;qi<queue.length;qi++){const index=queue[qi],rr=Math.floor(index/cols),cc=index%cols;count++;strength+=strengths[index];minC=Math.min(minC,cc);maxC=Math.max(maxC,cc);minR=Math.min(minR,rr);maxR=Math.max(maxR,rr);for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){if(!dx&&!dy)continue;const nr=rr+dy,nc=cc+dx;if(nr<0||nr>=rows||nc<0||nc>=cols)continue;const ni=nr*cols+nc;if(dilated[ni]&&!seen[ni]){seen[ni]=1;queue.push(ni);}}}
    const bw=maxC-minC+1,bh=maxR-minR+1,aspect=bw/bh;if(count<18||aspect<.45||aspect>2.2)continue;components.push({minC,maxC,minR,maxR,count,strength});
  }
  components.sort((a,b)=>(b.count+b.strength/160)-(a.count+a.strength/160));
  const seeds:TextureSeed[]=[];
  for(const component of components.slice(0,10)){
    const left=r.x+component.minC*block,right=r.x+(component.maxC+1)*block,top=r.y+component.minR*block,bottom=r.y+(component.maxR+1)*block,cx=(left+right)/2,cy=(top+bottom)/2,base=Math.max(right-left,bottom-top)+block*2;
    for(const factor of[.88,.94,1,1.06,1.12])for(const dx of[-block,0,block])for(const dy of[-block,0,block])seeds.push({quad:squareQuad(cx+dx,cy+dy,base*factor),strength:component.count+component.strength/160});
  }
  seeds.sort((a,b)=>b.strength-a.strength);return seeds.slice(0,240);
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

function searchKnownTraining(image:ImageData,matrix:number,cells:Uint8Array,rect:Rect,broad:boolean):Eval|null{
  const coarse:Eval[]=[];
  const dark=darkQuadSeed(image,rect),darkFactors=broad?[.86,.90,.94,.98,1,1.04]:[.97,.985,1,1.015,1.03];
  if(dark)for(const factor of darkFactors)pushTop(coarse,evaluateKnown(image,matrix,cells,scaleQuad(dark,factor),0,0,broad?4:3),24);
  if(broad){for(const seed of textureQuadSeeds(image,rect)){for(const factor of[.97,1,1.03])for(const shift of[-4,0,4]){pushTop(coarse,evaluateKnown(image,matrix,cells,translateQuad(scaleQuad(seed.quad,factor),shift,0),0,0,4),24);pushTop(coarse,evaluateKnown(image,matrix,cells,translateQuad(scaleQuad(seed.quad,factor),0,shift),0,0,4),24);}}}
  const scales=broad?[.22,.28,.34,.40,.46,.52,.58,.64,.70,.76,.82,.88,.94]:[.52,.58,.64,.70,.76,.82,.88,.94];
  const offsetsX=broad?[-.32,-.24,-.16,-.08,0,.08,.16,.24,.32]:[-.12,-.08,-.04,0,.04,.08,.12];
  const offsetsY=broad?[-.30,-.20,-.10,0,.10,.20,.30]:[-.18,-.12,-.06,0,.06,.12,.18];
  for(const scale of scales)for(const ox of offsetsX)for(const oy of offsetsY)pushTop(coarse,evaluateKnown(image,matrix,cells,axisQuad(rect,scale,ox,oy),0,0,broad?8:6),24);
  if(!coarse.length||coarse[0].lock.score<(broad?.38:.52)||coarse[0].lock.contrast<(broad?3:5))return null;
  const middle:Eval[]=[];
  for(const hypothesis of coarse){let lock=localRefine(image,matrix,cells,hypothesis.lock,3,broad?[12,8,4,2]:[8,4,2],2);lock=phaseRefine(image,matrix,cells,lock,3,[.3,.15]);pushTop(middle,evaluateKnown(image,matrix,cells,lock.quad,lock.phaseX,lock.phaseY,2),8);}
  if(!middle.length)return null;
  const finals:Eval[]=[];
  for(const candidate of middle){const lock=fullRefine(image,matrix,cells,candidate.lock);pushTop(finals,evaluateKnown(image,matrix,cells,lock.quad,lock.phaseX,lock.phaseY,1),3);}
  return finals[0]||null;
}

export function acquireKnownTrainingLock(image:ImageData,matrix:number,cells:Uint8Array,rect:Rect):PixelLock|null{
  const primary=searchKnownTraining(image,matrix,cells,clampRect(rect,image.width,image.height),false);
  if(primary&&primary.lock.score>=.80&&primary.lock.contrast>=10)return primary.lock;
  const expanded=expandRect(rect,image,.70,.08);
  const fallback=searchKnownTraining(image,matrix,cells,expanded,true);
  const best=bestOf([primary,fallback]);
  return best&&best.lock.score>=.80&&best.lock.contrast>=10?best.lock:null;
}

export function countKnownErrors(image:ImageData,matrix:number,cells:Uint8Array,lock:PixelLock){const e=evaluateKnown(image,matrix,cells,lock.quad,lock.phaseX,lock.phaseY,1);return e?{errors:e.lock.bitErrors,bits:e.lock.bits,score:e.lock.score,contrast:e.lock.contrast}:{errors:Number.MAX_SAFE_INTEGER,bits:0,score:0,contrast:0};}

type Reserved={row:number;column:number;expected:0|1};
const reservedCache=new Map<number,Reserved[]>();
function reserved(matrix:number){const cached=reservedCache.get(matrix);if(cached)return cached;const out:Reserved[]=[];for(let r=0;r<matrix;r++)for(let c=0;c<matrix;c++){const e=reservedCellValueV1(r,c,matrix);if(e===null)continue;const finder=(r<9||r>=matrix-9)&&(c<9||c>=matrix-9);if(!finder&&((r*7+c*11)%5!==0))continue;out.push({row:r,column:c,expected:e as 0|1});}reservedCache.set(matrix,out);return out;}
function evalReserved(image:ImageData,matrix:number,lock:PixelLock,phaseX:number,phaseY:number):PixelLock|null{const h=homographyFromUnitSquare(lock.quad);if(!h)return null;const ss=reserved(matrix);let bs=0,bc=0,ws=0,wc=0;const vals:number[]=[];for(const s of ss){const p=mapHomography(h,(s.column+.5+phaseX)/matrix,(s.row+.5+phaseY)/matrix),v=sampleLuma(image,p.x,p.y);vals.push(v);if(s.expected){bs+=v;bc++;}else{ws+=v;wc++;}}if(!bc||!wc)return null;const black=bs/bc,white=ws/wc,contrast=white-black;if(contrast<=0)return null;const threshold=(black+white)/2;let errors=0;for(let i=0;i<ss.length;i++)if((vals[i]<threshold?1:0)!==ss[i].expected)errors++;const bits=ss.length,score=(bits-errors)/bits;return{...lock,phaseX,phaseY,threshold,contrast,score,bitErrors:errors,bits};}
export function trackReservedLock(image:ImageData,matrix:number,trainingLock:PixelLock){let best:PixelLock|null=null;for(const dx of[-.3,-.15,0,.15,.3])for(const dy of[-.3,-.15,0,.15,.3]){const c=evalReserved(image,matrix,trainingLock,trainingLock.phaseX+dx,trainingLock.phaseY+dy);if(c&&(!best||c.score>best.score+1e-9||(Math.abs(c.score-best.score)<1e-9&&c.contrast>best.contrast)))best=c;}return best&&best.score>=.68&&best.contrast>=12?best:null;}
export function decodeWithPixelLock(image:ImageData,matrix:number,lock:PixelLock){const h=homographyFromUnitSquare(lock.quad);if(!h)return null;const cells=new Uint8Array(matrix*matrix);for(let r=OPTIGRID_V1_BORDER;r<matrix-OPTIGRID_V1_BORDER;r++)for(let c=OPTIGRID_V1_BORDER;c<matrix-OPTIGRID_V1_BORDER;c++){const p=mapHomography(h,(c+.5+lock.phaseX)/matrix,(r+.5+lock.phaseY)/matrix);cells[r*matrix+c]=sampleLuma(image,p.x,p.y)<lock.threshold?1:0;}return decodeFrameCellsV1(cells,matrix);}
