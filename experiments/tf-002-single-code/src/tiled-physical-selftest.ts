import {homographyFromUnitSquare,mapHomography,quadInside,type Quad} from './optigrid-geometry.ts';
import {decodeFrameCellsV1,encodeFrameCellsV1,OPTIGRID_V1_BORDER,payloadCapacityForMatrixV1,reservedCellValueV1} from './optigrid-v1.ts';

const W=1920,H=1080,SW=1280,SH=720,TILES=3,TILEPX=540,CENTERS=[330,960,1590] as const,TRAIN=64;
type Mode='native'|'rotate180'|'rotateCW'|'rotateCCW';
type Lock={quad:Quad;phaseX:number;phaseY:number;threshold:number;score:number;contrast:number};
type Rect={x:number;y:number;width:number;height:number};
type Scenario={name:string;sourceW:number;sourceH:number;embed:'native'|'rotCW'|'rotCCW'|'rot180'};

const sender=document.querySelector<HTMLCanvasElement>('#sender')!;
const camera=document.querySelector<HTMLCanvasElement>('#camera')!;
const status=document.querySelector<HTMLElement>('#status')!;
const sctx=sender.getContext('2d',{alpha:false})!;
const cctx=camera.getContext('2d',{alpha:false,willReadFrequently:true})!;
const tmp=document.createElement('canvas');tmp.width=W;tmp.height=H;const tctx=tmp.getContext('2d',{alpha:false})!;
const norm=document.createElement('canvas');norm.width=SW;norm.height=SH;const nctx=norm.getContext('2d',{alpha:false,willReadFrequently:true})!;
const tile=document.createElement('canvas');

function payloadFor(sequence:number,length:number,tileIndex:number){
  const out=new Uint8Array(length);let x=(sequence^0x71d2c3a5^(tileIndex*0x9e3779b9))>>>0;
  for(let i=0;i<out.length;i++){x^=x<<13;x^=x>>>17;x^=x<<5;out[i]=(x+i*31+tileIndex*47)&255;}return out;
}
const trainingSequence=(tileIndex:number)=>(0x54463720+tileIndex)>>>0;
function trainingCells(tileIndex:number){const n=payloadCapacityForMatrixV1(TRAIN),seq=trainingSequence(tileIndex);return encodeFrameCellsV1(TRAIN,seq,payloadFor(seq,n,tileIndex));}
function drawCells(cells:Uint8Array,matrix:number){
  tile.width=matrix;tile.height=matrix;const ctx=tile.getContext('2d',{alpha:false})!;const image=ctx.createImageData(matrix,matrix);
  for(let i=0;i<cells.length;i++){const v=cells[i]?0:255,o=i*4;image.data[o]=v;image.data[o+1]=v;image.data[o+2]=v;image.data[o+3]=255;}ctx.putImageData(image,0,0);
}
function render(matrix:number,sequences:number[]|null){
  sctx.fillStyle='#eceff1';sctx.fillRect(0,0,W,H);sctx.imageSmoothingEnabled=false;
  for(let ti=0;ti<TILES;ti++){
    const cells=sequences?encodeFrameCellsV1(matrix,sequences[ti],payloadFor(sequences[ti],payloadCapacityForMatrixV1(matrix),ti)):trainingCells(ti);
    drawCells(cells,matrix);sctx.fillStyle='#fff';sctx.fillRect(CENTERS[ti]-TILEPX/2-10,H/2-TILEPX/2-10,TILEPX+20,TILEPX+20);
    sctx.drawImage(tile,CENTERS[ti]-TILEPX/2,H/2-TILEPX/2,TILEPX,TILEPX);
  }
}
function degradeLandscape(){
  tctx.setTransform(1,0,0,1,0,0);tctx.fillStyle='#dfe3e7';tctx.fillRect(0,0,W,H);tctx.save();tctx.translate(W/2,H/2);tctx.rotate(1.1*Math.PI/180);tctx.scale(0.95,0.95);tctx.translate(-W/2,-H/2);tctx.imageSmoothingEnabled=true;tctx.drawImage(sender,0,0);tctx.restore();
}
function embed(s:Scenario){
  camera.width=s.sourceW;camera.height=s.sourceH;cctx.setTransform(1,0,0,1,0,0);cctx.fillStyle='#dfe3e7';cctx.fillRect(0,0,camera.width,camera.height);cctx.save();
  if(s.embed==='native') cctx.drawImage(tmp,0,0,camera.width,camera.height);
  else if(s.embed==='rot180'){cctx.translate(camera.width,camera.height);cctx.rotate(Math.PI);cctx.drawImage(tmp,0,0,camera.width,camera.height);}
  else if(s.embed==='rotCW'){cctx.translate(camera.width,0);cctx.rotate(Math.PI/2);cctx.drawImage(tmp,0,0,camera.height,camera.width);}
  else {cctx.translate(0,camera.height);cctx.rotate(-Math.PI/2);cctx.drawImage(tmp,0,0,camera.height,camera.width);}
  cctx.restore();
}
function captureNormalized(mode:Mode){
  norm.width=SW;norm.height=SH;nctx.setTransform(1,0,0,1,0,0);nctx.fillStyle='#eceff1';nctx.fillRect(0,0,SW,SH);nctx.save();nctx.imageSmoothingEnabled=true;
  if(mode==='native')nctx.drawImage(camera,0,0,SW,SH);
  else if(mode==='rotate180'){nctx.translate(SW,SH);nctx.rotate(Math.PI);nctx.drawImage(camera,0,0,SW,SH);}
  else if(mode==='rotateCW'){nctx.translate(SW,0);nctx.rotate(Math.PI/2);nctx.drawImage(camera,0,0,SH,SW);}
  else{nctx.translate(0,SH);nctx.rotate(-Math.PI/2);nctx.drawImage(camera,0,0,SH,SW);}
  nctx.restore();return nctx.getImageData(0,0,SW,SH);
}
function candidates(){return camera.width<camera.height?['rotateCW','rotateCCW'] as Mode[]:['native','rotate180'] as Mode[];}
function luma(d:Uint8ClampedArray,o:number){return d[o]*.2126+d[o+1]*.7152+d[o+2]*.0722;}
function sample(image:ImageData,x:number,y:number){const px=Math.max(0,Math.min(image.width-1,x)),py=Math.max(0,Math.min(image.height-1,y));const x0=Math.floor(px),y0=Math.floor(py),x1=Math.min(image.width-1,x0+1),y1=Math.min(image.height-1,y0+1),tx=px-x0,ty=py-y0,str=image.width*4;const a=luma(image.data,y0*str+x0*4),b=luma(image.data,y0*str+x1*4),c=luma(image.data,y1*str+x0*4),d=luma(image.data,y1*str+x1*4);return(a*(1-tx)+b*tx)*(1-ty)+(c*(1-tx)+d*tx)*ty;}
function lane(tileIndex:number,w:number,h:number):Rect{const lw=w/TILES;return{x:tileIndex*lw,y:0,width:lw,height:h};}
function axisQuad(r:Rect,scale:number,ox:number,oy:number):Quad{const side=Math.min(r.width,r.height)*scale,cx=r.x+r.width/2+r.width*ox,cy=r.y+r.height/2+r.height*oy,left=cx-side/2,top=cy-side/2;return{tl:{x:left,y:top},tr:{x:left+side,y:top},br:{x:left+side,y:top+side},bl:{x:left,y:top+side}};}
function clone(q:Quad):Quad{return{tl:{...q.tl},tr:{...q.tr},br:{...q.br},bl:{...q.bl}};}
function samples(matrix:number,cells:Uint8Array,fine:boolean){const target=fine?30:16,stride=Math.max(1,Math.floor(matrix/target)),out:Array<{row:number;column:number;expected:number}>=[];for(let r=0;r<matrix;r+=stride)for(let c=0;c<matrix;c+=stride)out.push({row:r,column:c,expected:cells[r*matrix+c]});return out;}
function evaluate(image:ImageData,matrix:number,quad:Quad,cells:Uint8Array,px:number,py:number,fine:boolean):Lock|null{
  if(!quadInside(quad,image.width,image.height,image.width*image.height*.008))return null;const h=homographyFromUnitSquare(quad);if(!h)return null;const ss=samples(matrix,cells,fine);let bs=0,bc=0,ws=0,wc=0;const vals:number[]=[];
  for(const s of ss){const p=mapHomography(h,(s.column+.5+px)/matrix,(s.row+.5+py)/matrix),v=sample(image,p.x,p.y);vals.push(v);if(s.expected){bs+=v;bc++;}else{ws+=v;wc++;}}
  if(!bc||!wc)return null;const black=bs/bc,white=ws/wc,contrast=white-black;if(!(contrast>0))return null;const threshold=(black+white)/2;let match=0;for(let i=0;i<ss.length;i++)if((vals[i]<threshold?1:0)===ss[i].expected)match++;return{quad,phaseX:px,phaseY:py,threshold,score:match/ss.length,contrast};
}
const obj=(l:Lock)=>l.score*1000+Math.min(160,Math.max(0,l.contrast));
function refine(image:ImageData,matrix:number,cells:Uint8Array,initial:Lock){let best=initial;for(const step of[8,4,2,1])for(const corner of['tl','tr','br','bl'] as const)for(const axis of['x','y'] as const)for(const dir of[-1,1]){const q=clone(best.quad);q[corner][axis]+=step*dir;const c=evaluate(image,matrix,q,cells,best.phaseX,best.phaseY,true);if(c&&obj(c)>obj(best))best=c;}let phase=best;for(const px of[-.3,-.15,0,.15,.3])for(const py of[-.3,-.15,0,.15,.3]){const c=evaluate(image,matrix,best.quad,cells,px,py,true);if(c&&obj(c)>obj(phase))phase=c;}return phase;}
function acquire(image:ImageData,tileIndex:number){const cells=trainingCells(tileIndex),r=lane(tileIndex,image.width,image.height);let best:Lock|null=null;for(const scale of[.52,.62,.72,.82,.92])for(const ox of[-.12,-.06,0,.06,.12])for(const oy of[-.20,-.10,0,.10,.20]){const c=evaluate(image,TRAIN,axisQuad(r,scale,ox,oy),cells,0,0,false);if(c&&(!best||obj(c)>obj(best)))best=c;}if(!best||best.score<.56||best.contrast<10)return null;return refine(image,TRAIN,cells,best);}
function countErrors(image:ImageData,tileIndex:number,lock:Lock){const expected=trainingCells(tileIndex),h=homographyFromUnitSquare(lock.quad);if(!h)return 1e9;let errors=0;for(let r=OPTIGRID_V1_BORDER;r<TRAIN-OPTIGRID_V1_BORDER;r++)for(let c=OPTIGRID_V1_BORDER;c<TRAIN-OPTIGRID_V1_BORDER;c++){const p=mapHomography(h,(c+.5+lock.phaseX)/TRAIN,(r+.5+lock.phaseY)/TRAIN),bit=sample(image,p.x,p.y)<lock.threshold?1:0;if(bit!==expected[r*TRAIN+c])errors++;}return errors;}
function calibrate(mode:Mode){const image=captureNormalized(mode),locks:Array<Lock|null>=[],errs:number[]=[];for(let i=0;i<TILES;i++){const l=acquire(image,i);locks.push(l);errs.push(l?countErrors(image,i,l):1e9);}const acquired=locks.filter(Boolean).length,exact=errs.filter(e=>e===0).length,total=acquired===TILES?errs.reduce((a,b)=>a+b,0):1e9,score=locks.reduce((a,l)=>a+(l?.score||0),0);return{mode,image,locks,errs,acquired,exact,total,rank:acquired*1e9-total*1e5+exact*1e6+score*1e4};}
function reserved(matrix:number){const out:Array<{row:number;column:number;expected:0|1}>=[];for(let r=0;r<matrix;r++)for(let c=0;c<matrix;c++){const e=reservedCellValueV1(r,c,matrix);if(e===null)continue;const finder=(r<9||r>=matrix-9)&&(c<9||c>=matrix-9);if(!finder&&((r*7+c*11)%5!==0))continue;out.push({row:r,column:c,expected:e as 0|1});}return out;}
function track(image:ImageData,matrix:number,lock:Lock){const h=homographyFromUnitSquare(lock.quad);if(!h)return null;const ss=reserved(matrix);let bs=0,bc=0,ws=0,wc=0;const vals:number[]=[];for(const s of ss){const p=mapHomography(h,(s.column+.5+lock.phaseX)/matrix,(s.row+.5+lock.phaseY)/matrix),v=sample(image,p.x,p.y);vals.push(v);if(s.expected){bs+=v;bc++;}else{ws+=v;wc++;}}if(!bc||!wc)return null;const black=bs/bc,white=ws/wc,contrast=white-black,threshold=(black+white)/2;let m=0;for(let i=0;i<ss.length;i++)if((vals[i]<threshold?1:0)===ss[i].expected)m++;return{...lock,threshold,score:m/ss.length,contrast};}
function decode(image:ImageData,matrix:number,lock:Lock){const h=homographyFromUnitSquare(lock.quad);if(!h)return null;const cells=new Uint8Array(matrix*matrix);for(let r=OPTIGRID_V1_BORDER;r<matrix-OPTIGRID_V1_BORDER;r++)for(let c=OPTIGRID_V1_BORDER;c<matrix-OPTIGRID_V1_BORDER;c++){const p=mapHomography(h,(c+.5+lock.phaseX)/matrix,(r+.5+lock.phaseY)/matrix);cells[r*matrix+c]=sample(image,p.x,p.y)<lock.threshold?1:0;}return decodeFrameCellsV1(cells,matrix);}

const scenarios:Scenario[]=[
  {name:'portrait-camera-CW',sourceW:1080,sourceH:1920,embed:'rotCW'},
  {name:'portrait-camera-CCW',sourceW:1080,sourceH:1920,embed:'rotCCW'},
  {name:'landscape-native',sourceW:1920,sourceH:1080,embed:'native'},
  {name:'landscape-upside-down',sourceW:1920,sourceH:1080,embed:'rot180'},
];

async function run(){const results:any[]=[];for(const scenario of scenarios){render(TRAIN,null);degradeLandscape();embed(scenario);const modes=candidates(),trials=modes.map(calibrate),best=trials.sort((a,b)=>b.rank-a.rank)[0];const trainingPass=best.acquired===3&&best.total===0;
    const dynamic:any[]=[];if(trainingPass){for(const matrix of[80,96,112,120]){const seqs=[0x1000+matrix,0x2000+matrix,0x3000+matrix];render(matrix,seqs);degradeLandscape();embed(scenario);const image=captureNormalized(best.mode);let pass=true;const perTile:any[]=[];for(let ti=0;ti<3;ti++){const tracked=track(image,matrix,best.locks[ti]!);const decoded=tracked?decode(image,matrix,tracked):null;const ok=!!decoded&&decoded.sequence===seqs[ti]&&decoded.payload.every((v,i)=>v===payloadFor(seqs[ti],decoded.payload.length,ti)[i]);pass&&=ok;perTile.push({tile:ti,score:tracked?.score||0,contrast:tracked?.contrast||0,ok});}dynamic.push({matrix,pass,perTile});}}
    results.push({scenario:scenario.name,chosenMode:best.mode,trainingPass,trainingErrors:best.errs,dynamic});}
  (window as any).__TF007_PHYSICAL_SELFTEST__={done:true,results,pass:results.every(r=>r.trainingPass&&r.dynamic.every((d:any)=>d.pass))};status.textContent=JSON.stringify((window as any).__TF007_PHYSICAL_SELFTEST__,null,2);
}
void run();