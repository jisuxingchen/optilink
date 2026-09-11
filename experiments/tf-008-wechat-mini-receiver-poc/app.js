App({
  onLaunch() {
    // No network is used. Payload is optical-only.
    console.log('[OptiLink PoC] launched');
  },
  globalData: {
    opticalOnly: true
  }
});
