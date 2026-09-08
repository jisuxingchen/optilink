import test from 'node:test';
import assert from 'node:assert/strict';
import {projectedTileRegionsSafe,rankOrientationCandidate} from './tf007h-orientation-quality.ts';
import type {FiducialLocatorDiagnostic} from './tiled-orientation-fiducial.ts';

function diagnostic(points: Array<{x:number;y:number}>): FiducialLocatorDiagnostic {
  return {
    method:'macro-marker-triplet-v4',width:1280,height:720,sampleStep:2,
    luma:{p02:0,p10:10,p50:80,p85:240,p98:255,dynamicRange:255,darkThreshold:70,inclusiveThreshold:112},
    thresholdMode:'inclusive',componentCount:3,components:[],conservativeComponentCount:3,inclusiveComponentCount:3,inclusiveEvaluated:true,
    triplet:{
      support:'triplet',observedMarkerCount:3,
      markers:points.map(p=>({...p,width:44,height:44})),
      points:points.map(p=>({...p,width:256,height:256})),
      spacing:300,spacingError:0,ySpread:0,sizeSpread:0,markerSideRatio:.14,markerGeometryError:.05,
      estimatedTileSide:256,axis:{x:1,y:0},normal:{x:0,y:1},score:.1,
    },
  };
}

test('TF-007H rejects wrong-normal projected tile centers outside the normalized frame', () => {
  const wrong = diagnostic([{x:184,y:721},{x:640,y:721},{x:1096,y:721}]);
  assert.equal(projectedTileRegionsSafe(wrong,1280,720), false);
});

test('TF-007H accepts canonical projected tile regions with useful edge margin', () => {
  const upright = diagnostic([{x:184,y:360},{x:640,y:360},{x:1096,y:360}]);
  assert.equal(projectedTileRegionsSafe(upright,1280,720), true);
});

test('TF-007H exact optical evidence outranks geometry heuristics, otherwise unsafe projection loses', () => {
  const exact = rankOrientationCandidate({success:true,acquiredTiles:3,exactTiles:3,totalBitErrors:0,scoreSum:2.8,projectionSafe:false});
  const plausible = rankOrientationCandidate({success:false,acquiredTiles:2,exactTiles:2,totalBitErrors:Number.MAX_SAFE_INTEGER,scoreSum:2.5,projectionSafe:true});
  const impossible = rankOrientationCandidate({success:false,acquiredTiles:3,exactTiles:2,totalBitErrors:15,scoreSum:3,projectionSafe:false});
  assert.ok(exact > plausible);
  assert.ok(plausible > impossible);
});
