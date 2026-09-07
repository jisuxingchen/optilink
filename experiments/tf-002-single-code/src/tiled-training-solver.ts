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
    const width=(maxC-minC+1)*block,height=(maxR-minR+1)*block,aspect=width/height,side=Math.max(width,height);
    if(count<18||aspect<.45||aspect>2.2||side<image.height*.07||side>image.height*.75)continue;
    components.push({x:minC*block,y:minR*block,width,height,count,strength});
  }
  return components.sort((a,b)=>(b.count+b.strength/180)-(a.count+a.strength/180));
}

function localRect(component:TextureComponent,factor:number,image:ImageData):Rect{
  const cx=component.x+component.width/2,cy=component.y+component.height/2,side=Math.max(component.width,component.height)*factor;
  return clampRect({x:cx-side/2,y:cy-side/2,width:side,height:side},image.width,image.height);
}

export function acquireKnownTrainingLock(image:ImageData,matrix:number,cells:Uint8Array,rect:Rect):PixelLock|null{
  const direct=acquireCore(image,matrix,cells,rect);
  if(direct){const check=countKnownErrors(image,matrix,cells,direct);if(check.errors===0)return direct;}

  const expectedX=rect.x+rect.width/2,expectedY=rect.y+rect.height/2,components=findTextureComponents(image);
  const ranked=[...components].sort((a,b)=>{
    const acx=a.x+a.width/2,acy=a.y+a.height/2,bcx=b.x+b.width/2,bcy=b.y+b.height/2;
    const ad=Math.abs(acx-expectedX)*.45+Math.abs(acy-expectedY)*.18-Math.min(a.count,300)*.35;
    const bd=Math.abs(bcx-expectedX)*.45+Math.abs(bcy-expectedY)*.18-Math.min(b.count,300)*.35;
    return ad-bd;
  }).slice(0,4);

  let best:PixelLock|null=direct,bestRate=Infinity,bestContrast=0;
  if(direct){const check=countKnownErrors(image,matrix,cells,direct);bestRate=check.bits?check.errors/check.bits:Infinity;bestContrast=check.contrast;}
  // A texture component can correspond either to the complete grid or mostly to the
  // high-frequency inner data area. Try progressively larger isolated windows. The
  // largest factor covers the 64x64 inner/full ratio: 64/(64-20) ~= 1.455, with margin.
  for(const component of ranked){
    for(const factor of[1.15,1.35,1.55,1.75]){
      const lock=acquireCore(image,matrix,cells,localRect(component,factor,image));
      if(!lock)continue;const check=countKnownErrors(image,matrix,cells,lock),rate=check.bits?check.errors/check.bits:Infinity;
      if(check.errors===0)return{...lock,score:check.score,contrast:check.contrast,bitErrors:check.errors,bits:check.bits};
      if(rate<bestRate-1e-9||(Math.abs(rate-bestRate)<1e-9&&check.contrast>bestContrast)){
        best={...lock,score:check.score,contrast:check.contrast,bitErrors:check.errors,bits:check.bits};bestRate=rate;bestContrast=check.contrast;
      }
    }
  }
  return best;
}
