import {installPhysicalAcquisitionHardening} from './tiled-physical-fiducial-hooks.ts';

// Keep the buffered browser gate on the same sender/acquisition hardening path
// as Physical v5 before loading the actual test program.
installPhysicalAcquisitionHardening();
void import('./tiled-buffered-selftest-main.ts');
