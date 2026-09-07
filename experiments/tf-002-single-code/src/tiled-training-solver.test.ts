import test from 'node:test';
import assert from 'node:assert/strict';
import {encodeFrameCellsV1,payloadCapacityForMatrixV1} from './optigrid-v1.ts';
import {acquireKnownTrainingLock,countKnownErrors,diagnoseTrainingRegion,type Rect} from './tiled-training-solver.ts';

const W=1280,H=720,MATRIX=64;
const CENTERS=[220,640,1060] as const;
function payloadFor(sequence:number,length:number,tile:number){const out=new Uint8Array(length);let x=(sequence^0x71d2c3a5^(tile*0x9e3779b9))>>>0;for(let i=0;i<out.length;i++){x^=x<<13;x^=x>>>17;x^=x<<5;out[i]=(x+i*31+tile*47)&255;}return out;}
function preambleCells(tile:number){const seq=(0x54000000|((MATRIX&255)<<8)|(tile&255))>>>0,n=payloadCapacityForMatrixV1(MATRIX);return encodeFrameCellsV1(MATRIX,seq,payloadFor(seq,n,tile));}
function lane(tile:number):Rect{return{x:tile*W/3,y:0,width:W/3,height:H};}
function makeImage(scale:number,offsetX:number,offsetY:number){
  const data=new Uint8ClampedArray(W*H*4);for(let i=0;i<W*H;i++){const o=i*4;data[o]=236;data[o+1]=239;data[o+2]=241;data[o+3]=255;}
  const tileSide=360*scale;
  for(let tile=0;tile<3;tile++){
    const cells=preambleCells(tile),cx=W/2+(CENTERS[tile]-W/2)*scale+offsetX,cy=H/2+offsetY,left=cx-tileSide/2,top=cy-tileSide/2;
    const x0=Math.max(0,Math.floor(left)),x1=Math.min(W,Math.ceil(left+tileSide)),y0=Math.max(0,Math.floor(top)),y1=Math.min(H,Math.ceil(top+tileSide));
    for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++){
      const c=Math.max(0,Math.min(MATRIX-1,Math.floor((x-left)/tileSide*MATRIX))),r=Math.max(0,Math.min(MATRIX-1,Math.floor((y-top)/tileSide*MATRIX))),v=cells[r*MATRIX+c]?0:255,o=(y*W+x)*4;data[o]=v;data[o+1]=v;data[o+2]=v;
    }
  }
  return{width:W,height:H,data} as ImageData;
}

test('TF-007 acquisition diagnostic reports optical contrast in a stressed lane',()=>{
  const image=makeImage(.55,90,36),diag=diagnoseTrainingRegion(image,lane(0));
  assert.ok(diag.dynamicRange>100,`dynamicRange=${diag.dynamicRange}`);
  assert.ok(diag.darkPixelCount>100,`darkPixelCount=${diag.darkPixelCount}`);
  assert.ok(diag.darkBounds);
});

test('TF-007 overlapping fallback reacquires three small inward-shifted tiles exactly',()=>{
  const image=makeImage(.55,90,36);
  for(let tile=0;tile<3;tile++){
    const expected=preambleCells(tile),lock=acquireKnownTrainingLock(image,MATRIX,expected,lane(tile));
    assert.ok(lock,`tile ${tile} did not acquire`);
    const errors=countKnownErrors(image,MATRIX,expected,lock!);
    assert.equal(errors.errors,0,`tile ${tile} errors=${errors.errors}/${errors.bits}`);
  }
});
