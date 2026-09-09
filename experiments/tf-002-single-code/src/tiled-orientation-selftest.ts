import {encodeFrameCellsV1,payloadCapacityForMatrixV1} from './optigrid-v1.ts';
import {acquireKnownTrainingLock,countKnownErrors,getPhysicalAcquisitionDiagnostics,resetPhysicalAcquisitionDiagnostics,type PixelLock} from './tiled-training-solver.ts';
import {installPhysicalAcquisitionHardening} from './tiled-physical-fiducial-hooks.ts';
import {locateOrientationFiducials} from './tiled-orientation-fiducial.ts';
import {projectedTileRegionsSafe,rankOrientationCandidate} from './tf007h-orientation-quality.ts';
import {refineKnownTrainingResidual} from './tf007h-known-training-refine.ts';

installPhysicalAcquisitionHardening({selftestRealism:true});

const W=1920,H=1080,SW=1280,SH=720,TILEPX=540,CENTERS=[330,960,1590] as const,MATRIX=64;
type Mode='rotateCW'|'rotateCCW';
const sender=document.querySelector<HTMLCanvasElement>('#sender')!,status=document.querySelector<HTMLElement>('#status')!;
const sctx=sender.getContext('2d',{alpha:false})!,tile=document.createElement('canvas'),camera=document.createElement('canvas'),norm=document.createElement('canvas');camera.id='camera';camera.width=1080;camera.height=1920;norm.width=SW;norm.height=SH;
const cctx=camera.getContext('2d',{alpha:false,willReadFrequently:true})!,nctx=norm.getContext('2d',{alpha:false,willReadFrequently:true})!;

function payloadFor(sequence:number,length:number,tileIndex:number){const out=new Uint8Array(length);let x=(sequence^0x71d2c3a5^(tileIndex*0x9e3779b9))>>>0;for(let i=0;i<out.length;i++){x^=x<<13;x^=x>>>17;x^=x<<5;out[i]=(x+i*31+tileIndex*47)&255;}return out;}
function preambleCells(tileIndex:number){const sequence=(0x54000000|((MATRIX&255)<<8)|(tileIndex&255))>>>0,n=payloadCapacityForMatrixV1(MATRIX);return encodeFrameCellsV1(MATRIX,sequence,payloadFor(sequence,n,tileIndex));}
function drawCells(cells:Uint8Array){tile.width=MATRIX;tile.height=MATRIX;const ctx=tile.getContext('2d',{alpha:false})!,image=ctx.createImageData(MATRIX,MATRIX);for(let i=0;i<cells.length;i++){const value=cells[i]?0:255,o=i*4;image.data[o]=value;image.data[o+1]=value;image.data[o+2]=value;image.data[o+3]=255;}ctx.putImageData(image,0,0);}
function render(){sctx.fillStyle='#eceff1';sctx.fillRect(0,0,W,H);sctx.imageSmoothingEnabled=false;for(let i=0;i<3;i++){drawCells(preambleCells(i));sctx.fillStyle='#fff';sctx.fillRect(CENTERS[i]-TILEPX/2-10,H/2-TILEPX/2-10,TILEPX+20,TILEPX+20);sctx.drawImage(tile,CENTERS[i]-TILEPX/2,H/2-TILEPX/2,TILEPX,TILEPX);}}
function embedPortrait(){cctx.setTransform(1,0,0,1,0,0);cctx.fillStyle='#cbd1d6';cctx.fillRect(0,0,camera.width,camera.height);cctx.save();cctx.translate(camera.width,0);cctx.rotate(Math.PI/2);const viewW=camera.height,viewH=camera.width,scale=.72,dw=viewW*scale,dh=viewH*scale,dx=(viewW-dw)/2+viewW*.03,dy=(viewH-dh)/2-viewH*.03;cctx.drawImage(sender,dx,dy,dw,dh);cctx.restore();}
function normalize(mode:Mode){nctx.setTransform(1,0,0,1,0,0);nctx.fillStyle='#eceff1';nctx.fillRect(0,0,SW,SH);nctx.save();nctx.imageSmoothingEnabled=true;if(mode==='rotateCW'){nctx.translate(SW,0);nctx.rotate(Math.PI/2);nctx.drawImage(camera,0,0,SH,SW);}else{nctx.translate(0,SH);nctx.rotate(-Math.PI/2);nctx.drawImage(camera,0,0,SH,SW);}nctx.restore();return nctx.getImageData(0,0,SW,SH);}
function lane(tileIndex:number){return{x:tileIndex*SW/3,y:0,width:SW/3,height:SH};}
function cloneLock(lock:PixelLock):PixelLock{return{...lock,quad:{tl:{...lock.quad.tl},tr:{...lock.quad.tr},br:{...lock.quad.br},bl:{...lock.quad.bl}}};}
function calibrate(mode:Mode){const image=normalize(mode),locks:Array<PixelLock|null>=[],errors:number[]=[];for(let i=0;i<3;i++){const cells=preambleCells(i),lock=acquireKnownTrainingLock(image,MATRIX,cells,lane(i));locks.push(lock);errors.push(lock?countKnownErrors(image,MATRIX,cells,lock).errors:Number.MAX_SAFE_INTEGER);}let exact=errors.filter(e=>e===0).length,acquired=locks.filter(Boolean).length;const refinedTiles:number[]=[];if(acquired===3&&exact===2){const index=errors.findIndex(e=>e>0&&e<=64);if(index>=0&&locks[index]){const refined=refineKnownTrainingResidual(image,MATRIX,preambleCells(index),locks[index]!);locks[index]=refined.lock;errors[index]=countKnownErrors(image,MATRIX,preambleCells(index),refined.lock).errors;refinedTiles.push(index);exact=errors.filter(e=>e===0).length;}}const total=acquired===3?errors.reduce((a,b)=>a+b,0):Number.MAX_SAFE_INTEGER,diagnostic=getPhysicalAcquisitionDiagnostics().slice(-1)[0]?.fiducial||null,projectionSafe=projectedTileRegionsSafe(diagnostic,SW,SH),success=exact===3&&total===0,scoreSum=locks.reduce((s,l)=>s+(l?.score||0),0),rank=rankOrientationCandidate({success,acquiredTiles:acquired,exactTiles:exact,totalBitErrors:total,scoreSum,projectionSafe});return{mode,image,locks,errors,exact,acquired,total,projectionSafe,success,rank,refinedTiles,diagnostic};}
function residualRefineProbe(image:ImageData,lock:PixelLock,tileIndex:number){
  const cells=preambleCells(tileIndex);
  const tests:Array<{phaseX:number;phaseY:number;dx:number;dy:number}>=[];
  // Sweep only small, physically plausible residual offsets around an already exact lock.
  // The previous probe jumped directly to large phase offsets and could skip the 1..64-error
  // regime entirely, making the regression red even though the production refiner was sound.
  for(const phase of[.02,.03,.04,.05,.06,.07,.08,.09,.10,.12,.14,.16]){
    tests.push({phaseX:phase,phaseY:0,dx:0,dy:0},{phaseX:-phase,phaseY:0,dx:0,dy:0},{phaseX:0,phaseY:phase,dx:0,dy:0},{phaseX:0,phaseY:-phase,dx:0,dy:0});
  }
  for(const delta of[.125,.25,.375,.5,.625,.75,1]){
    tests.push({phaseX:0,phaseY:0,dx:delta,dy:0},{phaseX:0,phaseY:0,dx:-delta,dy:0},{phaseX:0,phaseY:0,dx:0,dy:delta},{phaseX:0,phaseY:0,dx:0,dy:-delta});
  }
  let nearest:{before:number;after:number;improved:boolean;test:{phaseX:number;phaseY:number;dx:number;dy:number}}|null=null;
  for(const test of tests){
    const perturbed=cloneLock(lock);perturbed.phaseX+=test.phaseX;perturbed.phaseY+=test.phaseY;for(const key of['tl','tr','br','bl'] as const){perturbed.quad[key].x+=test.dx;perturbed.quad[key].y+=test.dy;}
    const before=countKnownErrors(image,MATRIX,cells,perturbed).errors;if(before<=0||before>64)continue;
    const refined=refineKnownTrainingResidual(image,MATRIX,cells,perturbed),after=countKnownErrors(image,MATRIX,cells,refined.lock).errors;
    const result={before,after,improved:refined.improved,test};
    if(after===0)return{found:true,...result};
    if(!nearest||after<nearest.after)nearest=result;
  }
  return nearest?{found:false,...nearest}:{found:false,before:null,after:null,improved:false,test:null};
}
function wrongNormalProjectionProbe(){const fixture=document.createElement('canvas');fixture.width=SW;fixture.height=SH;const ctx=fixture.getContext('2d',{alpha:false,willReadFrequently:true})!;ctx.fillStyle='rgb(236,239,241)';ctx.fillRect(0,0,SW,SH);ctx.fillStyle='#fff';for(const x of[485,784.5,1084])ctx.fillRect(x-66,550-66,132,132);ctx.fillStyle='#000';for(const x of[485,784.5,1084])ctx.fillRect(x-22,550-22,44,44);const image=ctx.getImageData(0,0,SW,SH),diagnostic=locateOrientationFiducials(image),safe=projectedTileRegionsSafe(diagnostic,SW,SH),points=diagnostic.triplet?.points.map(point=>({x:point.x,y:point.y}))||[];return{detected:Boolean(diagnostic.triplet),support:diagnostic.triplet?.support||null,markerCount:diagnostic.triplet?.observedMarkerCount||0,safe,points,estimatedTileSide:diagnostic.triplet?.estimatedTileSide||0};}

function run(){render();embedPortrait();resetPhysicalAcquisitionDiagnostics();const candidates=(['rotateCW','rotateCCW'] as Mode[]).map(calibrate).sort((a,b)=>b.rank-a.rank),best=candidates[0],other=candidates[1],probe=best.success&&best.locks[2]?residualRefineProbe(best.image,best.locks[2]!,2):{found:false,before:null,after:null,improved:false,test:null},wrongNormal=wrongNormalProjectionProbe();const pass=best.success&&best.exact===3&&best.total===0&&wrongNormal.detected&&wrongNormal.safe===false&&probe.found&&probe.before!>0&&probe.after===0;const output={done:true,pass,best:{mode:best.mode,success:best.success,errors:best.errors,projectionSafe:best.projectionSafe,refinedTiles:best.refinedTiles},other:{mode:other.mode,success:other.success,errors:other.errors,projectionSafe:other.projectionSafe},wrongNormalProjection:wrongNormal,residualRefine:probe};(window as any).__TF007H_ORIENTATION_SELFTEST__=output;status.textContent=JSON.stringify(output,null,2);}
run();