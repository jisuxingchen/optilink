import {TF007_FIDUCIAL_MARGIN_PX,TF007_FIDUCIAL_RING_PX} from './tiled-orientation-fiducial.ts';
import {getPhysicalAcquisitionDiagnostics,resetPhysicalAcquisitionDiagnostics} from './tiled-training-solver.ts';

let installed=false;
let selftestMatrix=0;

function drawFiducial(ctx:CanvasRenderingContext2D,left:number,top:number,width:number,height:number):void{
  const m=TF007_FIDUCIAL_MARGIN_PX,r=TF007_FIDUCIAL_RING_PX;
  ctx.save();ctx.fillStyle='#000';
  ctx.fillRect(left-m,top-m,width+2*m,r);
  ctx.fillRect(left-m,top+height+m-r,width+2*m,r);
  ctx.fillRect(left-m,top-m,r,height+2*m);
  ctx.fillRect(left+width+m-r,top-m,r,height+2*m);
  ctx.restore();
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
        drawFiducial(this,left,top,width,height);
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
          message.value.locatorDiagnostics=history.at(-1)||null;
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
          message.run.acquisitionHardening={profile:'macro-fiducial-v1',fiducialMarginPx:TF007_FIDUCIAL_MARGIN_PX,fiducialRingPx:TF007_FIDUCIAL_RING_PX,exactPreambleStillAuthoritative:true};
          data=JSON.stringify(message);
        }
      }catch{}
    }
    return original.call(this,data);
  };
  proto.__tf007DiagnosticPatched=true;
}

export function installPhysicalAcquisitionHardening(options:{selftestRealism?:boolean}={}):void{
  if(installed)return;installed=true;
  installDrawHook(Boolean(options.selftestRealism));
  installWebSocketHook();
}
