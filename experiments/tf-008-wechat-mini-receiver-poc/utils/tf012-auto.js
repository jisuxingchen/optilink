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
  validateTf012AutoPeerNotice,
  tf012AutoCommand,
  tf012AutoHelloMessage,
  createTf012AutoOrchestrator,
  TF012_AUTO_RECEIVER_ROLE,
  TF012_AUTO_SENDER_ROLE,
} = require('./optical-core.js');

/**
 * Dedicated validation for the ONE message that is a RESULT rather than a control
 * envelope. The control-message validator is deliberately NOT loosened for it: r13
 * funnelled the lab-result through `publish()`, which rejected it (`unexpected message
 * type lab-result`) and the run JSON never reached the lab.
 */
function validateAutoLabResult(message) {
  if (!message || typeof message !== 'object' || message.type !== 'lab-result') {
    return {ok: false, reason: 'not a lab-result message'};
  }
  const run = message.run;
  if (!run || typeof run !== 'object' || Array.isArray(run)) {
    return {ok: false, reason: 'lab-result must carry a run object'};
  }
  if (run.networkPayloadPath !== 'NONE') {
    return {ok: false, reason: 'networkPayloadPath must be NONE'};
  }
  if (run.kind !== 'tf012-auto-physical') {
    return {ok: false, reason: 'kind must be tf012-auto-physical'};
  }
  if (typeof run.runId !== 'string' || run.runId.length === 0 || run.runId.length > 64) {
    return {ok: false, reason: 'runId must be a short string'};
  }
  // Payload-shaped keys are structurally impossible here, but the check is cheap and
  // keeps the "no payload over the network" rule enforced on the device as well.
  // `payloadPath` / `networkPayloadPath` are the sanctioned DECLARATIONS that the path is
  // NONE — they name the payload, they do not carry it, so they are exempt.
  const exempt = new Set(['payloadpath', 'networkpayloadpath']);
  const offenders = [];
  const walk = (value, path) => {
    if (Array.isArray(value)) { value.forEach((entry, index) => walk(entry, path + '[' + index + ']')); return; }
    if (!value || typeof value !== 'object') return;
    Object.keys(value).forEach((key) => {
      const lowered = key.toLowerCase();
      if (!exempt.has(lowered)
        && ['payload', 'filebytes', 'filecontent', 'filedata', 'chunkbytes', 'framebytes',
          'imagedata', 'bitmap', 'reconstructed', 'oracle', 'expected'].some((f) => lowered.indexOf(f) >= 0)) {
        offenders.push(path + '.' + key);
      }
      walk(value[key], path + '.' + key);
    });
  };
  walk(run, 'run');
  if (offenders.length > 0) return {ok: false, reason: 'payload-shaped keys: ' + offenders.join(', ')};
  return {ok: true, reason: 'ok'};
}

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
    return send(message);
  };

  /** Publish a RESULT (not a control envelope) through its own validator. */
  const publishResult = (message) => {
    const check = validateAutoLabResult(message);
    if (!check.ok) {
      status.lastError = 'rejected result: ' + check.reason;
      if (onStatus) onStatus({...status});
      return false;
    }
    return send(message);
  };

  /**
   * Register with the relay. r15: this is its OWN message class ({type:'hello'}), not a
   * control envelope. Sending it as `{type:'command', action:'HELLO'}` — as r13/r14 did —
   * meant the relay never registered the role, so nothing was ever relayed and both ends
   * sat at "waiting for peer" while appearing connected.
   */
  const sendHello = () => send(tf012AutoHelloMessage(TF012_AUTO_RECEIVER_ROLE, {
    runId: null, buildId: options.buildId || null, planVersion: null,
  }));

  const send = (message) => {
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
      sendHello();
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
    publishResult,
    sendHello,
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
    setDeclaredHoldMs, onUploadStatus, onPeerChange,
  } = options;

  let orchestrator = null;
  let timer = null;
  /** Relay-confirmed sender peer present (see the peer notice handler). */
  let senderPeerPresent = false;
  /** Relay-confirmed sender HELLO (host clock) — NOT the phone's own socket state. */
  let senderHelloAt = null;
  /** Last sender TELEMETRY (host clock); the freshness rule depends on it. */
  let telemetryAt = null;
  let resultUpload = 'pending';
  let lastSenderSample = {
    mode: 'static', holdMs: null, cursor: null, paused: false, broadcasting: false,
    canvasDevicePx: null, canvasHash: null, pausedAt: null, resumedAt: null,
  };

  const client = createControlClient({
    url, token, buildId,
    onMessage: (message) => {
      if (!message || typeof message !== 'object') return;
      // r15 — MESSAGE CLASS 2: peer presence. Checked BEFORE the "must be a command"
      // filter, because a presence notice is deliberately not a command. r14's code could
      // never reach its `type === 'peer'` branch for exactly that reason.
      const notice = validateTf012AutoPeerNotice(message);
      if (notice.ok) {
        if (message.role === TF012_AUTO_SENDER_ROLE) {
          if (message.event === 'hello') {
            senderPeerPresent = true;
            senderHelloAt = Date.now();
            if (onLog) onLog('sender peer confirmed by relay');
          } else {
            senderPeerPresent = false;
            if (onLog) onLog('sender peer left');
          }
          if (onPeerChange) onPeerChange({senderPeerPresent, senderHelloAt});
        }
        return;
      }
      if (message.type === 'server') {
        if (message.event === 'result-saved') {
          resultUpload = 'success';
          if (onUploadStatus) onUploadStatus(resultUpload);
          if (onLog) onLog('run result saved to the lab');
        } else if (message.event === 'policy-rejected') {
          resultUpload = 'failed';
          if (onUploadStatus) onUploadStatus(resultUpload);
          if (onLog) onLog('lab rejected a message: ' + String(message.reason));
        } else if (message.event === 'registered') {
          if (onLog) onLog('registered with the lab as ' + String(message.role));
        }
        return;
      }
      if (message.type !== 'command') return;
      // The sender reports telemetry; the orchestrator owns everything else.
      if (message.action === 'TELEMETRY') {
        telemetryAt = Date.now();
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
      // Handshake + freshness: the orchestrator refuses to measure anything until a
      // REAL sender peer has announced itself AND sent fresh telemetry.
      link: {
        controlConnected: () => client.status().connected,
        senderHelloAt: () => senderHelloAt,
        telemetryAt: () => telemetryAt,
      },      onStepResult: (result) => {
        if (onStepResult) onStepResult(result);
      },
      onRunResult: (result) => {
        // Publish the frozen run to the lab through the DEDICATED result path, then hand
        // it to the page for local display/copy. The JSON stays available locally either
        // way: an upload failure never costs the PO the run.
        const ok = client.publishResult({type: 'lab-result', run: {...result, kind: 'tf012-auto-physical'}});
        resultUpload = ok ? 'pending' : 'failed';
        if (onUploadStatus) onUploadStatus(resultUpload);
        if (!ok && onLog) onLog('lab-result upload unavailable: ' + String(client.status().lastError));
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
    senderHelloAt: () => senderHelloAt,
    /** r15: relay-confirmed sender peer present (peer discovery, not command traffic). */
    peerPresent: () => senderPeerPresent,
    telemetryAt: () => telemetryAt,
    uploadStatus: () => resultUpload,
    /** Start the automated A1..A5 sequence. The run waits for the sender peer. */
    start: () => {
      if (orchestrator) return false;
      orchestrator = createTf012AutoOrchestrator({
        runId: runId || ('tf012-' + Date.now()),
        buildId: buildId || null,
        device: device || null,
        ports: buildPorts(),
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

module.exports = {createControlClient, createAutoTestRunner, validateAutoLabResult};
