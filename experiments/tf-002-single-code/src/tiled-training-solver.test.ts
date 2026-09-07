import test from 'node:test';
import assert from 'node:assert/strict';
import {diagnoseTrainingRegion,type Rect} from './tiled-training-solver.ts';

const W=1280,H=720;
function lane(tile:number):Rect{return{x:tile*W/3,y:0,width:W/3,height:H};}
function makeDiagnosticImage(){
  const data=new Uint8ClampedArray(W*H*4);for(let i=0;i<W*H;i++){const o=i*4;data[o]=236;data[o+1]=239;data[o+2]=241;data[o+3]=255;}
  for(let y=250;y<470;y++)for(let x=300;x<520;x++){const dark=((Math.floor((x-300)/8)+Math.floor((y-250)/8))&1)===0,o=(y*W+x)*4,v=dark?8:248;data[o]=v;data[o+1]=v;data[o+2]=v;}
  return{width:W,height:H,data} as ImageData;
}

test('TF-007 acquisition diagnostic catches a small high-contrast tile inside a large lane',()=>{
  const image=makeDiagnosticImage(),diag=diagnoseTrainingRegion(image,lane(0));
  assert.ok(diag.dynamicRange>100,`dynamicRange=${diag.dynamicRange}`);
  assert.ok(diag.darkPixelCount>100,`darkPixelCount=${diag.darkPixelCount}`);
  assert.ok(diag.darkBounds);
  assert.ok(diag.darkPixelRatio>0&&diag.darkPixelRatio<.5,`darkPixelRatio=${diag.darkPixelRatio}`);
});
