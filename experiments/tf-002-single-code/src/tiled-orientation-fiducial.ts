export const TF007_FIDUCIAL_MARKER_PX = 84;
export const TF007_FIDUCIAL_HALO_PX = 132;
export const TF007_FIDUCIAL_OFFSET_Y_PX = -360;
export const TF007_TILE_TO_CENTER_SPACING = 540 / 630;
export const TF007_MARKER_TO_CENTER_SPACING = 84 / 630;
export const TF007_MARKER_OFFSET_TO_SPACING = -360 / 630;

export type FiducialComponent = {x:number;y:number;width:number;height:number;sampleCount:number;fillRatio:number};
export type FiducialPoint = {x:number;y:number;width:number;height:number};
export type FiducialLocatorDiagnostic = {
  method:'macro-marker-triplet-v4'; width:number; height:number; sampleStep:number;
  luma:{p02:number;p10:number;p50:number;p85:number;p98:number;dynamicRange:number;darkThreshold:number;inclusiveThreshold:number};
  thresholdMode:'conservative'|'inclusive'|null;
  componentCount:number; components:FiducialComponent[];
  conservativeComponentCount:number; inclusiveComponentCount:number|null; inclusiveEvaluated:boolean;
  triplet:null|{
    support:'triplet'|'outer-pair'; observedMarkerCount:2|3;
    markers:FiducialPoint[]; points:FiducialPoint[]; spacing:number; spacingError:number; ySpread:number; sizeSpread:number;
    markerSideRatio:number; markerGeometryError:number; estimatedTileSide:number; axis:{x:number;y:number}; normal:{x:number;y:number}; score:number;
  };
};

type Candidate=NonNullable<FiducialLocatorDiagnostic['triplet']>;

function sampleLuma(image:ImageData,x:number,y:number):number{
  const xx=Math.max(0,Math.min(image.width-1,Math.round(x))),yy=Math.max(0,Math.min(image.height-1,Math.round(y))),o=(yy*image.width+xx)*4;
  return image.data[o]*.2126+image.data[o+1]*.7152+image.data[o+2]*.0722;
}
function quantile(sorted:number[],fraction:number):number{if(!sorted.length)return 0;return sorted[Math.max(0,Math.min(sorted.length-1,Math.floor((sorted.length-1)*fraction)))];}
function center(c:FiducialComponent){return{x:c.x+c.width/2,y:c.y+c.height/2};}
function side(c:FiducialComponent){return(c.width+c.height)/2;}
function axisAndNormal(a:{x:number;y:number},b:{x:number;y:number}){
  const dx=b.x-a.x,dy=b.y-a.y,len=Math.max(1,Math.hypot(dx,dy)),axis={x:dx/len,y:dy/len};
  let normal={x:-axis.y,y:axis.x};if(normal.y<0)normal={x:-normal.x,y:-normal.y};
  return{axis,normal};
}
function projectPoints(markers:{x:number;y:number}[],spacing:number,normal:{x:number;y:number}){
  const projectedOffset=-TF007_MARKER_OFFSET_TO_SPACING*spacing,estimatedTileSide=spacing*TF007_TILE_TO_CENTER_SPACING;
  return{estimatedTileSide,points:markers.map(p=>({x:p.x+normal.x*projectedOffset,y:p.y+normal.y*projectedOffset,width:estimatedTileSide,height:estimatedTileSide}))};
}

function detectMarkerComponents(image:ImageData,darkThreshold:number,step:number):FiducialComponent[]{
  const cols=Math.max(1,Math.floor(image.width/step)),rows=Math.max(1,Math.floor(image.height/step)),active=new Uint8Array(cols*rows);
  for(let r=0;r<rows;r++)for(let c=0;c<cols;c++)if(sampleLuma(image,(c+.5)*step,(r+.5)*step)<darkThreshold)active[r*cols+c]=1;
  const dilated=new Uint8Array(active.length);
  for(let r=0;r<rows;r++)for(let c=0;c<cols;c++){
    let hit=false;for(let dy=-1;dy<=1&&!hit;dy++)for(let dx=-1;dx<=1;dx++){const rr=r+dy,cc=c+dx;if(rr>=0&&rr<rows&&cc>=0&&cc<cols&&active[rr*cols+cc]){hit=true;break;}}
    if(hit)dilated[r*cols+c]=1;
  }
  const seen=new Uint8Array(dilated.length),out:FiducialComponent[]=[];
  for(let r=0;r<rows;r++)for(let c=0;c<cols;c++){
    const start=r*cols+c;if(!dilated[start]||seen[start])continue;seen[start]=1;const q=[start];let minC=c,maxC=c,minR=r,maxR=r,count=0;
    for(let qi=0;qi<q.length;qi++){
      const idx=q[qi],rr=Math.floor(idx/cols),cc=idx%cols;count++;minC=Math.min(minC,cc);maxC=Math.max(maxC,cc);minR=Math.min(minR,rr);maxR=Math.max(maxR,rr);
      for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){if(!dx&&!dy)continue;const nr=rr+dy,nc=cc+dx;if(nr<0||nr>=rows||nc<0||nc>=cols)continue;const ni=nr*cols+nc;if(dilated[ni]&&!seen[ni]){seen[ni]=1;q.push(ni);}}
    }
    const width=(maxC-minC+1)*step,height=(maxR-minR+1)*step,componentSide=Math.max(width,height),aspect=width/Math.max(1,height),box=Math.max(1,(maxC-minC+1)*(maxR-minR+1)),fillRatio=count/box;
    if(count<10||aspect<.60||aspect>1.68)continue;
    if(componentSide<image.height*.012||componentSide>image.height*.20)continue;
    if(fillRatio<.28)continue;
    out.push({x:minC*step,y:minR*step,width,height,sampleCount:count,fillRatio});
  }
  return out.sort((a,b)=>b.sampleCount-a.sampleCount);
}

function chooseTriplet(image:ImageData,components:FiducialComponent[]):Candidate|null{
  const pool=components.slice(0,24),maxCount=Math.max(1,...pool.map(c=>c.sampleCount));let best:Candidate|null=null;
  for(let i=0;i<pool.length;i++)for(let j=i+1;j<pool.length;j++)for(let k=j+1;k<pool.length;k++){
    const items=[pool[i],pool[j],pool[k]].sort((a,b)=>center(a).x-center(b).x),markers=items.map(center);
    const x1=markers[1].x-markers[0].x,x2=markers[2].x-markers[1].x;if(x1<image.width*.055||x2<image.width*.055)continue;
    const e1=Math.hypot(markers[1].x-markers[0].x,markers[1].y-markers[0].y),e2=Math.hypot(markers[2].x-markers[1].x,markers[2].y-markers[1].y),spacing=(e1+e2)/2;
    if(spacing>image.width*.45)continue;
    const spacingError=Math.abs(e1-e2)/Math.max(1,spacing),ySpread=(Math.max(...markers.map(p=>p.y))-Math.min(...markers.map(p=>p.y)))/Math.max(1,spacing);
    const sides=items.map(side),meanSide=sides.reduce((a,b)=>a+b,0)/3,sizeSpread=(Math.max(...sides)-Math.min(...sides))/Math.max(1,meanSide),markerSideRatio=meanSide/Math.max(1,spacing);
    const markerGeometryError=Math.abs(markerSideRatio-TF007_MARKER_TO_CENTER_SPACING)/TF007_MARKER_TO_CENTER_SPACING;
    if(spacingError>.34||ySpread>.38||sizeSpread>.54||markerGeometryError>.62)continue;
    const {axis,normal}=axisAndNormal(markers[0],markers[2]);
    if(Math.abs(axis.x)<.82)continue;
    const meanCount=items.reduce((s,c)=>s+c.sampleCount,0)/3,strengthPenalty=Math.max(0,1-meanCount/maxCount);
    const meanY=markers.reduce((s,p)=>s+p.y,0)/3,lowerHalfPenalty=Math.max(0,meanY/image.height-.58)*4;
    const score=spacingError*8+ySpread*4+sizeSpread*3+markerGeometryError*2.4+strengthPenalty*3+lowerHalfPenalty;
    if(!best||score<best.score){
      const projected=projectPoints(markers,spacing,normal);
      best={support:'triplet',observedMarkerCount:3,markers:items.map((item,n)=>({x:markers[n].x,y:markers[n].y,width:item.width,height:item.height})),points:projected.points,
        spacing,spacingError,ySpread,sizeSpread,markerSideRatio,markerGeometryError,estimatedTileSide:projected.estimatedTileSide,axis,normal,score};
    }
  }
  return best;
}

function chooseOuterPair(image:ImageData,components:FiducialComponent[]):Candidate|null{
  const pool=components.slice(0,18),maxCount=Math.max(1,...pool.map(c=>c.sampleCount)),expectedOuterRatio=TF007_MARKER_TO_CENTER_SPACING/2;let best:Candidate|null=null;
  for(let i=0;i<pool.length;i++)for(let j=i+1;j<pool.length;j++){
    const items=[pool[i],pool[j]].sort((a,b)=>center(a).x-center(b).x),ends=items.map(center),dx=ends[1].x-ends[0].x,dy=ends[1].y-ends[0].y,distance=Math.hypot(dx,dy);
    if(dx<image.width*.16||distance>image.width*.58)continue;
    const {axis,normal}=axisAndNormal(ends[0],ends[1]);if(Math.abs(axis.x)<.82)continue;
    const sides=items.map(side),meanSide=(sides[0]+sides[1])/2,sizeSpread=Math.abs(sides[0]-sides[1])/Math.max(1,meanSide),outerRatio=meanSide/Math.max(1,distance),outerRatioError=Math.abs(outerRatio-expectedOuterRatio)/expectedOuterRatio;
    const ySpread=Math.abs(ends[1].y-ends[0].y)/Math.max(1,distance);
    if(sizeSpread>.38||ySpread>.30||outerRatioError>.38)continue;
    const meanCount=(items[0].sampleCount+items[1].sampleCount)/2,strengthPenalty=Math.max(0,1-meanCount/maxCount);
    const score=.55+ySpread*4+sizeSpread*3+outerRatioError*4+strengthPenalty*3;
    if(!best||score<best.score){
      const spacing=distance/2,middle={x:(ends[0].x+ends[1].x)/2,y:(ends[0].y+ends[1].y)/2},markers=[ends[0],middle,ends[1]],projected=projectPoints(markers,spacing,normal),markerSideRatio=meanSide/Math.max(1,spacing);
      best={support:'outer-pair',observedMarkerCount:2,markers:[
        {x:ends[0].x,y:ends[0].y,width:items[0].width,height:items[0].height},
        {x:middle.x,y:middle.y,width:meanSide,height:meanSide},
        {x:ends[1].x,y:ends[1].y,width:items[1].width,height:items[1].height},
      ],points:projected.points,spacing,spacingError:0,ySpread,sizeSpread,markerSideRatio,markerGeometryError:outerRatioError,estimatedTileSide:projected.estimatedTileSide,axis,normal,score};
    }
  }
  return best;
}

function chooseCandidate(image:ImageData,components:FiducialComponent[]):Candidate|null{
  const full=chooseTriplet(image,components),pair=chooseOuterPair(image,components);
  if(!full)return pair;if(!pair)return full;
  return full.score<=pair.score?full:pair;
}

export function locateOrientationFiducials(image:ImageData):FiducialLocatorDiagnostic{
  const step=Math.max(2,Math.floor(image.width/480)),values:number[]=[];
  for(let y=step/2;y<image.height;y+=step*2)for(let x=step/2;x<image.width;x+=step*2)values.push(sampleLuma(image,x,y));
  values.sort((a,b)=>a-b);
  const p02=quantile(values,.02),p10=quantile(values,.10),p50=quantile(values,.50),p85=quantile(values,.85),p98=quantile(values,.98),dynamicRange=p98-p02;
  const darkThreshold=Math.min(p50-5,p02+Math.max(18,Math.min(74,dynamicRange*.28)));
  const inclusiveThreshold=Math.min(p85-Math.max(10,dynamicRange*.08),p02+Math.max(32,Math.min(112,dynamicRange*.50)));
  const conservativeComponents=detectMarkerComponents(image,darkThreshold,step),conservativeCandidate=chooseCandidate(image,conservativeComponents);
  const inclusiveEvaluated=inclusiveThreshold>darkThreshold+4&&(!conservativeCandidate||conservativeComponents.length<3||conservativeCandidate.score>1.55);
  const inclusiveComponents=inclusiveEvaluated?detectMarkerComponents(image,inclusiveThreshold,step):null;
  const inclusiveCandidate=inclusiveComponents?chooseCandidate(image,inclusiveComponents):null;
  let thresholdMode:'conservative'|'inclusive'|null=null,components=conservativeComponents,triplet:Candidate|null=conservativeCandidate;
  if(inclusiveCandidate&&(!triplet||inclusiveCandidate.score+.12<triplet.score)){thresholdMode='inclusive';components=inclusiveComponents!;triplet=inclusiveCandidate;}
  else if(triplet)thresholdMode='conservative';
  else if(inclusiveCandidate){thresholdMode='inclusive';components=inclusiveComponents!;triplet=inclusiveCandidate;}
  return{method:'macro-marker-triplet-v4',width:image.width,height:image.height,sampleStep:step,luma:{p02,p10,p50,p85,p98,dynamicRange,darkThreshold,inclusiveThreshold},thresholdMode,
    componentCount:components.length,components:components.slice(0,14),conservativeComponentCount:conservativeComponents.length,inclusiveComponentCount:inclusiveComponents?.length??null,inclusiveEvaluated,triplet};
}
