/**
 * TF-012 r13 — Mini Program AUTO TEST adapter.
 *
 * Thin platform glue only: it owns the WebSocket control client and the mapping from
 * the phone's live receiver metrics to the shared orchestrator's sample type. All the
 * sequencing, gating, holdMs synchronisation, pause splitting and result freezing live
 * in the SHARED orchestrator (utils/optical-core.js), so the phone and the browser
 * sender cannot disagree about the plan.
 *
 * Network rule: this adapter sends CONTROL and TELEMETRY only, and every outbound
 * message is validated by the shared schema before it leaves the device. No payload,
 * no frame bytes, no oracle, no SHA path.
 */
const {
  validateTf012AutoControlMessage,
  tf012AutoCommand,
  createTf012AutoOrchestrator,
  TF012_AUTO_RECEIVER_ROLE,
} = require('./optical-core.js');

/** Control client over wx.connectSocket. Control/telemetry only. */
function createControlClient(options) {
  const {url, token, onMessage, onStatus, onLog} = options;
  let socket = null;
  let connected = false;
  const status = {connected: false, url, lastError: null, sent: 0, received: 0};

  const publish = (message) => {
    const check = validateTf012AutoControlMessage(message);
    if (!check.ok) {
      status.lastError = 'rejected outbound: ' + check.reason;
      if (onStatus) onStatus({...status});
      return false;
    }
    if (!connected || !socket) return false;
    try {
      socket.send({data: JSON.stringify(message)});
      status.sent += 1;
      if (onStatus) onStatus({...status});
      return true;
    } catch (err) {
      status.lastError = 'send failed: ' + (err && err.message);
      if (onStatus) onStatus({...status});
      return false;
    }
  };

  const connect = () => {
    if (socket) return;
    const full = token ? `${url}${url.indexOf('?') >= 0 ? '&' : '?'}token=${encodeURIComponent(token)}` : url;
    try {
      socket = wx.connectSocket({url: full});
    } catch (err) {
      status.lastError = 'connect failed: ' + (err && err.message);
      if (onStatus) onStatus({...status});
      return;
    }
    socket.onOpen(() => {
      connected = true;
      status.connected = true;
      status.lastError = null;
      if (onLog) onLog('control channel open');
      publish(tf012AutoCommand('HELLO', {
        role: TF012_AUTO_RECEIVER_ROLE, runId: null, buildId: null, planVersion: null,
      }));
      if (onStatus) onStatus({...status});
    });
    socket.onMessage((event) => {
      status.received += 1;
      let message = null;
      try {
        message = JSON.parse(event.data);
      } catch (err) {
        status.lastError = 'malformed control message';
        if (onStatus) onStatus({...status});
        return;
      }
      if (message && message.type === 'command') {
        const check = validateTf012AutoControlMessage(message);
        if (!check.ok) {
          status.lastError = 'rejected inbound: ' + check.reason;
          if (onStatus) onStatus({...status});
          return;
        }
      }
      if (onMessage) onMessage(message);
      if (onStatus) onStatus({...status});
    });
    socket.onClose(() => {
      connected = false;
      status.connected = false;
      socket = null;
      if (onLog) onLog('control channel closed');
      if (onStatus) onStatus({...status});
    });
    socket.onError(() => {
      connected = false;
      status.connected = false;
      if (onStatus) onStatus({...status});
    });
  };

  return {
    connect,
    publish,
    status: () => ({...status}),
    close: () => {
      if (socket) socket.close({});
      socket = null;
      connected = false;
      status.connected = false;
    },
  };
}

/**
 * Wire the shared orchestrator to the phone.
 *
 * `ports.receiverSample()` is supplied by the page and reads the LOCAL optical
 * receiver; nothing about the metrics comes from the network.
 */
function createAutoTestRunner(options) {
  const {
    url, token, buildId, device, runId,
    receiverSample, resetReceiverMetrics,
    onProgress, onStepResult, onRunResult, onStatus, onLog,
    setDeclaredHoldMs,
  } = options;

  let orchestrator = null;
  let timer = null;
  let lastSenderSample = {
    mode: 'static', holdMs: null, cursor: null, paused: false, broadcasting: false,
    canvasDevicePx: null, canvasHash: null, pausedAt: null, resumedAt: null,
  };

  const client = createControlClient({
    url, token,
    onMessage: (message) => {
      if (!message || message.type !== 'command') return;
      // The sender reports telemetry; the orchestrator owns everything else.
      if (message.action === 'TELEMETRY') {
        lastSenderSample = {
          mode: message.mode === 'static' ? 'static' : 'cyclic',
          holdMs: typeof message.holdMs === 'number' ? message.holdMs : null,
          cursor: typeof message.cursor === 'number' ? message.cursor : null,
          paused: Boolean(message.paused),
          broadcasting: Boolean(message.broadcasting),
          canvasDevicePx: typeof message.canvasDevicePx === 'number' ? message.canvasDevicePx : null,
          canvasHash: typeof message.canvasHash === 'string' ? message.canvasHash : null,
          pausedAt: typeof message.pausedAt === 'number' ? message.pausedAt : null,
          resumedAt: typeof message.resumedAt === 'number' ? message.resumedAt : null,
        };
      }
      if (message.action === 'HELLO' || message.type === 'peer') {
        if (onLog) onLog('sender connected');
      }
    },
    onStatus, onLog,
  });

  const publish = (message) => client.publish(message);

  function buildPorts() {
    return {
      send: (message) => publish(message),
      senderSample: () => ({...lastSenderSample}),
      receiverSample: () => receiverSample(),
      resetReceiverMetrics: () => resetReceiverMetrics(),
      onStepResult: (result) => {
        if (onStepResult) onStepResult(result);
      },
      onRunResult: (result) => {
        // Publish the frozen run to the lab so the PC keeps a copy, then hand it to the
        // page for local display/copy. The publisher validates that it carries no payload.
        publish({type: 'lab-result', run: {...result, kind: 'tf012-auto-physical'}});
        if (onRunResult) onRunResult(result);
      },
      onProgress: (progress) => {
        // The phone's DECLARED hold time follows the active step automatically: one
        // source of truth (the shared plan), no manual selection on either side.
        if (setDeclaredHoldMs) setDeclaredHoldMs(progress.holdMs);
        if (onProgress) onProgress(progress);
      },
    };
  }

  return {
    connect: () => client.connect(),
    status: () => client.status(),
    senderSample: () => ({...lastSenderSample}),
    /** Start the automated A1..A5 sequence. */
    start: () => {
      if (orchestrator) return false;
      orchestrator = createTf012AutoOrchestrator({
        runId: runId || ('tf012-' + Date.now()),
        buildId: buildId || null,
        device: device || null,
        ports: buildPorts(),
        senderConnected: () => client.status().connected,
      });
      orchestrator.start(Date.now());
      if (timer) clearInterval(timer);
      timer = setInterval(() => {
        if (!orchestrator) return;
        orchestrator.tick(Date.now());
        if (orchestrator.finalResult()) {
          clearInterval(timer);
          timer = null;
        }
      }, 250);
      return true;
    },
    abort: (reason) => {
      if (orchestrator) orchestrator.abort(reason || 'ABORTED_BY_PO');
      if (timer) clearInterval(timer);
      timer = null;
    },
    isRunning: () => Boolean(orchestrator) && !orchestrator.finalResult(),
    stepResults: () => (orchestrator ? orchestrator.stepResults() : []),
    finalResult: () => (orchestrator ? orchestrator.finalResult() : null),
    dispose: () => {
      if (timer) clearInterval(timer);
      timer = null;
      orchestrator = null;
      client.close();
    },
  };
}

module.exports = {createControlClient, createAutoTestRunner};
