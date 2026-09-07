import {
  TF007_FIDUCIAL_HALO_PX,
  TF007_FIDUCIAL_MARKER_PX,
  TF007_FIDUCIAL_OFFSET_Y_PX,
  TF007_TILE_TO_CENTER_SPACING,
  locateOrientationFiducials,
} from './tiled-orientation-fiducial.ts';

const FRAME_W=1280,FRAME_H=720,SENDER_W=1920,SENDER_H=1080,TILE_Y=540;
const TILE_X=[330,960,1590] as const;
const canvas=document.getElementById('locatorFrame') as HTMLCanvasElement;
const status=document.getElementById('locatorStatus') as HTMLElement;
const rawCtx=canvas.getContext('2d',{alpha:false,willReadFrequently:true});
if(!rawCtx)throw new Error('locator canvas unavailable');
const ctx:CanvasRenderingContext2D=rawCtx;

type Scenario={name:string;scale:number;offsetX:number;offsetY:number;angleDeg:number;shearX:number;shearY:number;blur:number;contrast:number;brightness:number;noise:number;background:string;glare:number};
type Point={x:number;y:number};
type Result={name:string;seed:number;pass:boolean;triplet:boolean;componentCount:number;locatorMs:number;maxCenterErrorPx:number;centerErrorRatio:number;sideErrorRatio:number;spacingError:number|null;score:number|null;dynamicRange:number;estimatedTileSide:number|null;expectedTileSide:number;diagnostic:ReturnType<typeof locateOrientationFiducials>};

declare global{interface Window{__TF007_LOCATOR_TORTURE__?:{done:boolean;pass:boolean;profile:string;results:Result[];summary:any}}}

const scenarios:Scenario[]=[
  {name:'normalized-from-portrait-cw-tiny-dark',scale:.40,offsetX:.18,offsetY:-.12,angleDeg:3.5,shearX:.025,shearY:-.015,blur:1.4,contrast:.72,brightness:.93,noise:6,background:'#30363d',glare:.08},
  {name:'normalized-from-portrait-ccw-tiny-dark',scale:.42,offsetX:-.18,offsetY:.13,angleDeg:-4,shearX:-.03,shearY:.02,blur:1.5,contrast:.68,brightness:1.04,noise:7,background:'#20252b',glare:.10},
  {name:'normalized-from-landscape-small-skew',scale:.45,offsetX:.14,offsetY:.10,angleDeg:5,shearX:.045,shearY:.025,blur:1.6,contrast:.74,brightness:.94,noise:7,background:'#555b61',glare:.12},
  {name:'normalized-from-landscape-180-small-skew',scale:.48,offsetX:-.14,offsetY:-.10,angleDeg:-5,shearX:-.05,shearY:.02,blur:1.3,contrast:.65,brightness:1.02,noise:8,background:'#171b20',glare:.10},
  {name:'small-low-contrast-a',scale:.50,offsetX:.10,offsetY:.14,angleDeg:2,shearX:.06,shearY:-.025,blur:1.7,contrast:.62,brightness:.90,noise:8,background:'#454b52',glare:.14},
  {name:'small-low-contrast-b',scale:.55,offsetX:-.10,offsetY:-.14,angleDeg:-3,shearX:-.055,shearY:.03,blur:1.8,contrast:.60,brightness:1.08,noise:9,background:'#262b31',glare:.14},
  {name:'rotated-heavy-blur-a',scale:.60,offsetX:.06,offsetY:.08,angleDeg:6,shearX:.035,shearY:-.02,blur:1.8,contrast:.58,brightness:.92,noise:9,background:'#3b4147',glare:.16},
  {name:'rotated-heavy-blur-b',scale:.70,offsetX:-.06,offsetY:-.08,angleDeg:-6,shearX:-.04,shearY:.025,blur:2.0,contrast:.55,brightness:1.06,noise:10,background:'#1d2228',glare:.16},
];

function senderSource():HTMLCanvasElement{
  const source=document.createElement('canvas');source.width=SENDER_W;source.height=SENDER_H;const c=source.getContext('2d',{alpha:false})!;
  c.fillStyle='#eceff1';c.fillRect(0,0,SENDER_W,SENDER_H);
  for(const x of TILE_X){
    const markerY=TILE_Y+TF007_FIDUCIAL_OFFSET_Y_PX;
    c.fillStyle='#fff';c.fillRect(x-TF007_FIDUCIAL_HALO_PX/2,markerY-TF007_FIDUCIAL_HALO_PX/2,TF007_FIDUCIAL_HALO_PX,TF007_FIDUCIAL_HALO_PX);
    c.fillStyle='#000';c.fillRect(x-TF007_FIDUCIAL_MARKER_PX/2,markerY-TF007_FIDUCIAL_MARKER_PX/2,TF007_FIDUCIAL_MARKER_PX,TF007_FIDUCIAL_MARKER_PX);
  }
  c.fillStyle='#111';
  for(let i=0;i<24;i++){
    const tile=i%3,local=(i*83)%430-215,y=350+((i*137)%380),size=22+((i*11)%30);
    c.fillRect(TILE_X[tile]+local-size/2,y-size/2,size,size);
  }
  return source;
}

function mapper(s:Scenario){
  const scalePx=FRAME_W*s.scale/SENDER_W,angle=s.angleDeg*Math.PI/180,cos=Math.cos(angle),sin=Math.sin(angle),cx=FRAME_W/2+s.offsetX*FRAME_W,cy=FRAME_H/2+s.offsetY*FRAME_H;
  return(p:Point):Point=>{
    const sx=(p.x-SENDER_W/2)*scalePx,sy=(p.y-SENDER_H/2)*scalePx;
    const hx=sx+s.shearX*sy,hy=s.shearY*sx+sy;
    return{x:cx+cos*hx-sin*hy,y:cy+sin*hx+cos*hy};
  };
}

function addNoise(image:ImageData,amount:number,seed:number):void{
  let state=(seed*2654435761)>>>0;
  const next=()=>{state^=state<<13;state^=state>>>17;state^=state<<5;return(state>>>0)/4294967295;};
  for(let i=0;i<image.data.length;i+=4){const n=(next()*2-1)*amount;image.data[i]=Math.max(0,Math.min(255,image.data[i]+n));image.data[i+1]=Math.max(0,Math.min(255,image.data[i+1]+n));image.data[i+2]=Math.max(0,Math.min(255,image.data[i+2]+n));}
}

function renderScenario(source:HTMLCanvasElement,s:Scenario,seed:number):{image:ImageData;tileCenters:Point[];expectedSide:number}{
  ctx.setTransform(1,0,0,1,0,0);ctx.filter='none';ctx.fillStyle=s.background;ctx.fillRect(0,0,FRAME_W,FRAME_H);
  const scalePx=FRAME_W*s.scale/SENDER_W,angle=s.angleDeg*Math.PI/180,cx=FRAME_W/2+s.offsetX*FRAME_W,cy=FRAME_H/2+s.offsetY*FRAME_H;
  ctx.save();ctx.translate(cx,cy);ctx.rotate(angle);ctx.transform(1,s.shearY,s.shearX,1,0,0);ctx.scale(scalePx,scalePx);ctx.translate(-SENDER_W/2,-SENDER_H/2);
  ctx.filter=`blur(${s.blur}px) contrast(${s.contrast}) brightness(${s.brightness})`;ctx.drawImage(source,0,0);ctx.restore();ctx.filter='none';
  const map=mapper(s),tileCenters=TILE_X.map(x=>map({x,y:TILE_Y}));
  if(s.glare>0){const middle=tileCenters[1];ctx.save();ctx.globalAlpha=s.glare;ctx.fillStyle='#fff';ctx.fillRect(middle.x-22,0,44,FRAME_H);ctx.restore();}
  const image=ctx.getImageData(0,0,FRAME_W,FRAME_H);addNoise(image,s.noise,seed);ctx.putImageData(image,0,0);
  const spacing=(Math.hypot(tileCenters[1].x-tileCenters[0].x,tileCenters[1].y-tileCenters[0].y)+Math.hypot(tileCenters[2].x-tileCenters[1].x,tileCenters[2].y-tileCenters[1].y))/2;
  return{image,tileCenters:[...tileCenters],expectedSide:spacing*TF007_TILE_TO_CENTER_SPACING};
}

function evaluate(s:Scenario,seed:number,source:HTMLCanvasElement):Result{
  const rendered=renderScenario(source,s,seed),t0=performance.now(),diagnostic=locateOrientationFiducials(rendered.image),locatorMs=performance.now()-t0,triplet=diagnostic.triplet;
  let maxCenterErrorPx=Number.POSITIVE_INFINITY,centerErrorRatio=Number.POSITIVE_INFINITY,sideErrorRatio=Number.POSITIVE_INFINITY;
  if(triplet){
    const expected=[...rendered.tileCenters].sort((a,b)=>a.x-b.x),found=[...triplet.points].sort((a,b)=>a.x-b.x);
    maxCenterErrorPx=Math.max(...found.map((p,i)=>Math.hypot(p.x-expected[i].x,p.y-expected[i].y)));
    centerErrorRatio=maxCenterErrorPx/Math.max(1,rendered.expectedSide);
    sideErrorRatio=Math.abs(triplet.estimatedTileSide-rendered.expectedSide)/Math.max(1,rendered.expectedSide);
  }
  const pass=Boolean(triplet)&&diagnostic.componentCount>=3&&centerErrorRatio<=.12&&sideErrorRatio<=.12&&(triplet?.spacingError??1)<=.08&&locatorMs<=150;
  return{name:s.name,seed,pass,triplet:Boolean(triplet),componentCount:diagnostic.componentCount,locatorMs,maxCenterErrorPx,centerErrorRatio,sideErrorRatio,spacingError:triplet?.spacingError??null,score:triplet?.score??null,dynamicRange:diagnostic.luma.dynamicRange,estimatedTileSide:triplet?.estimatedTileSide??null,expectedTileSide:rendered.expectedSide,diagnostic};
}

const source=senderSource(),results:Result[]=[];
for(const scenario of scenarios)for(const seed of[17,91])results.push(evaluate(scenario,seed,source));
const finite=results.filter(r=>Number.isFinite(r.centerErrorRatio));
const summary={
  scenarios:scenarios.length,runs:results.length,passes:results.filter(r=>r.pass).length,
  worstCenterErrorRatio:finite.length?Math.max(...finite.map(r=>r.centerErrorRatio)):null,
  worstSideErrorRatio:finite.length?Math.max(...finite.map(r=>r.sideErrorRatio)):null,
  worstLocatorMs:Math.max(...results.map(r=>r.locatorMs)),
  minDynamicRange:Math.min(...results.map(r=>r.dynamicRange)),
  minScale:Math.min(...scenarios.map(s=>s.scale)),maxBlur:Math.max(...scenarios.map(s=>s.blur)),minContrast:Math.min(...scenarios.map(s=>s.contrast)),maxNoise:Math.max(...scenarios.map(s=>s.noise)),
};
const output={done:true,pass:results.every(r=>r.pass),profile:'post-normalization macro-marker locator-only torture; no OptiGrid payload/cell oracle',results,summary};
window.__TF007_LOCATOR_TORTURE__=output;status.textContent=JSON.stringify(output,null,2);
