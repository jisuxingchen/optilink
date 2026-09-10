import test from 'node:test';
import assert from 'node:assert/strict';
import {acquireKnownTrainingLock,countKnownErrors,diagnoseTrainingRegion,getPhysicalAcquisitionDiagnostics,resetPhysicalAcquisitionDiagnostics,type Rect} from './tiled-training-solver.ts';
import {locateOrientationFiducials} from './tiled-orientation-fiducial.ts';
import {encodeFrameCellsV1,payloadCapacityForMatrixV1} from './optigrid-v1.ts';

const W=1280,H=720,MATRIX=64;
function lane(tile:number):Rect{return{x:tile*W/3,y:0,width:W/3,height:H};}
function makeDiagnosticImage(){
  const data=new Uint8ClampedArray(W*H*4);for(let i=0;i<W*H;i++){const o=i*4;data[o]=236;data[o+1]=239;data[o+2]=241;data[o+3]=255;}
  for(let y=250;y<470;y++)for(let x=300;x<520;x++){const dark=((Math.floor((x-300)/8)+Math.floor((y-250)/8))&1)===0,o=(y*W+x)*4,v=dark?8:248;data[o]=v;data[o+1]=v;data[o+2]=v;}
  return{width:W,height:H,data} as ImageData;
}
function makeImage(){
  const data=new Uint8ClampedArray(W*H*4);for(let i=0;i<W*H;i++){const o=i*4;data[o]=236;data[o+1]=239;data[o+2]=241;data[o+3]=255;}
  return{width:W,height:H,data} as ImageData;
}
function fillRect(image:ImageData,x:number,y:number,width:number,height:number,value:number){
  for(let yy=Math.max(0,Math.floor(y));yy<Math.min(image.height,Math.floor(y+height));yy++)for(let xx=Math.max(0,Math.floor(x));xx<Math.min(image.width,Math.floor(x+width));xx++){const o=(yy*image.width+xx)*4;image.data[o]=value;image.data[o+1]=value;image.data[o+2]=value;image.data[o+3]=255;}
}
function payloadFor(sequence:number,length:number,tileIndex:number){const out=new Uint8Array(length);let x=(sequence^0x71d2c3a5^(tileIndex*0x9e3779b9))>>>0;for(let i=0;i<out.length;i++){x^=x<<13;x^=x>>>17;x^=x<<5;out[i]=(x+i*31+tileIndex*47)&255;}return out;}
function preambleCells(tileIndex:number){const sequence=(0x54000000|((MATRIX&255)<<8)|(tileIndex&255))>>>0,count=payloadCapacityForMatrixV1(MATRIX);return encodeFrameCellsV1(MATRIX,sequence,payloadFor(sequence,count,tileIndex));}
function drawScaledTile(image:ImageData,cells:Uint8Array,centerX:number,centerY:number,side:number,quiet:number){
  const left=centerX-side/2,top=centerY-side/2;
  fillRect(image,left-quiet,top-quiet,side+quiet*2,quiet,255);fillRect(image,left-quiet,top+side,side+quiet*2,quiet,255);
  fillRect(image,left-quiet,top,quiet,side,255);fillRect(image,left+side,top,quiet,side,255);
  for(let py=0;py<side;py++)for(let px=0;px<side;px++){const mx=Math.min(MATRIX-1,Math.floor(px/side*MATRIX)),my=Math.min(MATRIX-1,Math.floor(py/side*MATRIX));fillRect(image,left+px,top+py,1,1,cells[my*MATRIX+mx]?0:255);}
}
function applyNoise(image:ImageData,seed:number){let x=seed>>>0;for(let i=0;i<image.width*image.height;i++){x^=x<<13;x^=x>>>17;x^=x<<5;const delta=((x>>>0)%9)-4,o=i*4;for(let channel=0;channel<3;channel++)image.data[o+channel]=Math.max(0,Math.min(255,image.data[o+channel]+delta));}}
function lastSupport(){return getPhysicalAcquisitionDiagnostics().slice(-1)[0]?.fiducial.triplet?.support??null;}

test('TF-007 acquisition diagnostic catches a small high-contrast tile inside a large lane',()=>{
  const image=makeDiagnosticImage(),diag=diagnoseTrainingRegion(image,lane(0));
  assert.ok(diag.dynamicRange>100,`dynamicRange=${diag.dynamicRange}`);
  assert.ok(diag.darkPixelCount>100,`darkPixelCount=${diag.darkPixelCount}`);
  assert.ok(diag.darkBounds);
  assert.ok(diag.darkPixelRatio>0&&diag.darkPixelRatio<.5,`darkPixelRatio=${diag.darkPixelRatio}`);
});

test('TF-007 acquisition does not seed macro-triplet geometry from an untrusted outer-pair result',()=>{
  const image=makeImage(),cells=preambleCells(2);
  // Two outer markers, no middle marker: the locator can only report outer-pair support.
  fillRect(image,320-10,300-10,20,20,0);
  fillRect(image,20-10,300-10,20,20,0);
  const projected=locateOrientationFiducials(image).triplet?.points[2];
  assert.ok(projected,'outer-pair locator must still recover two-marker geometry');
  drawScaledTile(image,cells,projected!.x,projected!.y,140,6);
  resetPhysicalAcquisitionDiagnostics();
  const lock=acquireKnownTrainingLock(image,MATRIX,cells,lane(2));
  assert.equal(lastSupport(),'outer-pair');
  // Outer-pair geometry must fall through to the lane fallback. The true tile sits outside
  // lane 2, so a trusted-triplet-only seed must not return a false macro lock here.
  assert.equal(lock,null);
});

test('TF-007 acquisition still seeds and exactly locks from a true three-marker triplet',()=>{
  const image=makeImage(),cells=preambleCells(2);
  const spacing=300,markerSide=Math.round(spacing*84/630);
  for(const x of [320-spacing,320,320+spacing])fillRect(image,x-markerSide/2,300-markerSide/2,markerSide,markerSide,0);
  const projected=locateOrientationFiducials(image).triplet?.points[2];
  assert.ok(projected,'exact three-marker fixture must localize a triplet');
  drawScaledTile(image,cells,projected!.x,projected!.y,280,6);
  applyNoise(image,12345);
  resetPhysicalAcquisitionDiagnostics();
  const lock=acquireKnownTrainingLock(image,MATRIX,cells,lane(2));
  assert.equal(lastSupport(),'triplet');
  assert.ok(lock,'a true three-marker triplet must still seed acquisition');
  assert.equal(countKnownErrors(image,MATRIX,cells,lock!).errors,0);
});
