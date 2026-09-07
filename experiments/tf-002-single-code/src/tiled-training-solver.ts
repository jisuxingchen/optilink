import {
  acquireKnownTrainingLock as acquireCore,
  countKnownErrors,
  diagnoseTrainingRegion,
  sampleLuma,
  trackReservedLock,
  decodeWithPixelLock,
  type PixelLock,
  type Rect,
  type TrainingRegionDiagnostic,
} from './tiled-training-solver-core.ts';

export {countKnownErrors,diagnoseTrainingRegion,sampleLuma,trackReservedLock,decodeWithPixelLock};
export type {PixelLock,Rect,TrainingRegionDiagnostic};

type TextureComponent={x:number;y:number;width:number;height:number;count:number;strength:number};

function clampRect(rect:Rect,width:number,height:number):Rect{
  const x=Math.max(0,rect.x),y=Math.max(0,rect.y),right=Math.min(width,rect.x+rect.width),bottom=Math.min(height,rect.y+rect.height);
  return{x,y,width:Math.max(1,right-x),height:Math.max(1,bottom-y)};
}
function center(component:TextureComponent){return{x:component.x+component.width/2,y:component.y+component.height/2};}
function side(component:TextureComponent){return Math.max(component.width,component.height);}

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

function geometryLocalRect(image:ImageData,component:TextureComponent,estimatedTileSide:number,coreScale:number):Rect{
  const p=center(component),windowSide=estimatedTileSide/coreScale;
  return clampRect({x:p.x-windowSide/2,y:p.y-windowSide/2,width:windowSide,height:windowSide},image.width,image.height);
}

export function acquireKnownTrainingLock(image:ImageData,matrix:number,cells:Uint8Array,rect:Rect):PixelLock|null{
  const direct=acquireCore(image,matrix,cells,rect);
  if(direct){const check=countKnownErrors(image,matrix,cells,direct);if(check.errors===0)return direct;}

  const triplet=bestHorizontalTriplet(image,findTextureComponents(image));
  if(!triplet)return direct;
  const tileIndex=Math.max(0,Math.min(2,Math.floor((rect.x+rect.width/2)/image.width*3))),points=triplet.map(center);
  const spacing=((points[1].x-points[0].x)+(points[2].x-points[1].x))/2;
  // Protocol layout is fixed: sender center spacing is 630 px and tile side is 540 px.
  // Recover projected tile size from detected center spacing instead of trusting the
  // texture component's own bounding box, which can represent only the 44x44 inner area.
  const estimatedTileSide=spacing*(540/630);

  let best:PixelLock|null=direct,bestRate=Infinity,bestContrast=0;
  if(direct){const check=countKnownErrors(image,matrix,cells,direct);bestRate=check.bits?check.errors/check.bits:Infinity;bestContrast=check.contrast;}
  for(const coreScale of[.86,.80,.74]){
    const lock=acquireCore(image,matrix,cells,geometryLocalRect(image,triplet[tileIndex],estimatedTileSide,coreScale));
    if(!lock)continue;const check=countKnownErrors(image,matrix,cells,lock),rate=check.bits?check.errors/check.bits:Infinity;
    if(check.errors===0)return{...lock,score:check.score,contrast:check.contrast,bitErrors:check.errors,bits:check.bits};
    if(rate<bestRate-1e-9||(Math.abs(rate-bestRate)<1e-9&&check.contrast>bestContrast)){
      best={...lock,score:check.score,contrast:check.contrast,bitErrors:check.errors,bits:check.bits};bestRate=rate;bestContrast=check.contrast;
    }
  }
  return best;
}
