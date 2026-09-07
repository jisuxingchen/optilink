import {TF007_FIDUCIAL_MARKER_PX,TF007_FIDUCIAL_OFFSET_Y_PX} from './tiled-orientation-fiducial.ts';
import {getPhysicalAcquisitionDiagnostics,resetPhysicalAcquisitionDiagnostics} from './tiled-training-solver.ts';

let installed=false;
let selftestMatrix=0;

function drawFiducialMarker(ctx:CanvasRenderingContext2D,left:number,top:number,width:number,height:number):void{
  const size=TF007_FIDUCIAL_MARKER_PX;
  const cx=left+width/2,cy=top+height/2+TF007_FIDUCIAL_OFFSET_Y_PX;
  ctx.save();ctx.fillStyle='#000';ctx.fillRect(cx-size/2,cy-size/2,size,size);ctx.restore();
}

function installDrawHook(enableSelftestRealism:boolean):void{
  const proto=CanvasRenderingContext2D.prototype as any;
  if(proto.__tf007FiducialPatched)return;
  const original=proto.drawImage;
  proto.drawImage=function(...args:any[]){
    const destId=String(this.canvas?.id||'');
    const source=args[0];
    if(enableSelftestRealism&&destId==='camera'&&selftestMatrix===64){
      const previous=this.filter;
      this.filter='blur(0.7px) contrast(0.90) brightness(0.98)';
      const result=original.apply(this,args);
      this.filter=previous;
      return result;
    }
    const result=original.apply(this,args);
    if((destId==='senderCanvas'||destId==='sender')&&source instanceof HTMLCanvasElement&&args.length===5){
      const left=Number(args[1]),top=Number(args[2]),width=Number(args[3]),height=Number(args[4]);
      if(Number.isFinite(width)&&Number.isFinite(height)&&width>=400&&height>=400&&width<=620&&height<=620){
        if(destId==='sender')selftestMatrix=source.width||0;
        drawFiducialMarker(this,left,top,width,height);
      }
    }
    return result;
  };
  proto.__tf007FiducialPatched=true;
}

function installWebSocketHook():void{
  if(typeof WebSocket==='undefined')return;
  const proto=WebSocket.prototype as any;
  if(proto.__tf007DiagnosticPatched)return;
  const original=proto.send;
  proto.send=function(data:any){
    if(typeof data==='string'){
      try{
        const message=JSON.parse(data);
        if(message?.type==='state'&&message?.event==='tf007v3-receiver-ready')resetPhysicalAcquisitionDiagnostics();
        if(message?.type==='state'&&message?.event==='tf007v3-calibration-result'&&message.value&&typeof message.value==='object'){
          const history=getPhysicalAcquisitionDiagnostics();
          message.value.locatorDiagnostics=history.length?history[history.length-1]:null;
          if(String(message.id||'').includes('-orientation-')){
            message.value.locatorDiagnosticHistory=history.slice(-4);
            message.value.orientationResolved=Boolean(message.value.success);
            if(!message.value.success&&message.value.orientationMode){
              message.value.attemptedOrientationMode=message.value.orientationMode;
              message.value.orientationMode=null;
            }
          }
          data=JSON.stringify(message);
        }else if(message?.type==='lab-result'&&message.run?.schema==='optilink.tf007.tiled.physical.v3'){
          message.run.acquisitionHardening={profile:'macro-marker-triplet-v2',markerPx:TF007_FIDUCIAL_MARKER_PX,markerOffsetYPx:TF007_FIDUCIAL_OFFSET_Y_PX,exactPreambleStillAuthoritative:true};
          data=JSON.stringify(message);
        }
      }catch{}
    }
    return original.call(this,data);
  };
  proto.__tf007DiagnosticPatched=true;
}

function installSelftestEvidenceHook():void{
  const key='__TF007_PHYSICAL_SELFTEST__';
  let stored:any;
  try{
    Object.defineProperty(window,key,{configurable:true,get(){return stored;},set(value){
      if(value&&typeof value==='object'&&value.done)value.acquisitionDiagnostics=getPhysicalAcquisitionDiagnostics();
      stored=value;
    }});
  }catch{}
}

export function installPhysicalAcquisitionHardening(options:{selftestRealism?:boolean}={}):void{
  if(installed)return;installed=true;
  installDrawHook(Boolean(options.selftestRealism));
  installWebSocketHook();
  if(options.selftestRealism)installSelftestEvidenceHook();
}
