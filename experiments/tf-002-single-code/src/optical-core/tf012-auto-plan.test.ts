/**
 * TF-012 r13 — AUTO PHYSICAL TEST HARNESS: control-plane and plan tests.
 *
 * These are the tests the task asked for that can be proven without a phone:
 *   1  auto sequence order is deterministic
 *   2  phone holdMs declaration follows the active step automatically
 *   3  sender holdMs matches the same step
 *   7  no payload bytes are sent over the control channel
 *   8  every step creates an immutable frozen result
 *   9  final JSON contains all steps
 *  10  setup gate prevents running the sequence if no valid static decode occurs
 */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {
  TF012_AUTO_ALLOWED_FIELDS,
  TF012_AUTO_PLAN_VERSION,
  TF012_AUTO_STEPS,
  TF012_AUTO_STEP_COUNT,
  TF012_AUTO_SETUP_STEP,
  tf012AutoCommand,
  tf012AutoForbiddenFieldHits,
  tf012AutoPlanDurationMs,
  tf012AutoStep,
  tf012AutoStepLabel,
  validateTf012AutoControlMessage,
} from './tf012-auto-plan.ts';
import {
  createTf012AutoOrchestrator,
  emptyReceiverSample,
  evaluateTf012AutoSetupGate,
  type Tf012AutoReceiverSample,
  type Tf012AutoSenderSample,
  type Tf012AutoStepResult,
  type Tf012AutoRunResult,
} from './tf012-auto-orchestrator.ts';
import type {Tf012AutoEnvelope} from './tf012-auto-plan.ts';

// ---------------------------------------------------------------------------
// 1 — deterministic sequence order
// ---------------------------------------------------------------------------

test('r13 auto plan: the A1..A5 sequence is fixed and deterministic', () => {
  assert.equal(TF012_AUTO_PLAN_VERSION, 'tf012-auto-v1');
  assert.deepEqual(TF012_AUTO_STEPS.map((step) => step.id), ['A1', 'A2', 'A3', 'A4', 'A5']);
  assert.deepEqual(TF012_AUTO_STEPS.map((step) => step.index), [1, 2, 3, 4, 5]);
  assert.equal(TF012_AUTO_STEP_COUNT, 5);
  assert.equal(TF012_AUTO_SETUP_STEP.id, 'SETUP');

  // The exact plan the task specified.
  assert.deepEqual(
    TF012_AUTO_STEPS.map((step) => [step.id, step.mode, step.holdMs, step.durationMs]),
    [
      ['A1', 'static', null, 10000],
      ['A2', 'cyclic', 5000, 25000],
      ['A3', 'cyclic', 1000, 25000],
      ['A4', 'cyclic', 1000, 15000],
      ['A5', 'static', null, 10000],
    ],
  );
  // A4 is 5 s of cyclic then a 10 s frozen frame.
  assert.equal(tf012AutoStep('A4').runMs, 5000);
  assert.equal(tf012AutoStep('A4').pauseMs, 10000);
  assert.equal(tf012AutoPlanDurationMs(), 85000);

  // The plan is frozen data: a caller cannot mutate the shipped definition.
  assert.equal(Object.isFrozen(TF012_AUTO_STEPS), true);
  assert.equal(Object.isFrozen(TF012_AUTO_SETUP_STEP), true);
  for (const step of TF012_AUTO_STEPS) assert.equal(Object.isFrozen(step), true);
  assert.throws(() => {
    (TF012_AUTO_STEPS as unknown as Tf012AutoStepMutable[])[0].holdMs = 1;
  }, TypeError);
  assert.equal(TF012_AUTO_STEPS[0].holdMs, null);
  assert.match(tf012AutoStepLabel(tf012AutoStep('A2')), /Step A2 \/ 5 · CYCLIC 5000 ms/);
});

type Tf012AutoStepMutable = {holdMs: number | null};

// ---------------------------------------------------------------------------
// 2 + 3 — the phone declaration and the sender follow the SAME active step
// ---------------------------------------------------------------------------

interface RecordedRun {
  commands: Tf012AutoEnvelope[];
  frozen: Tf012AutoStepResult[];
  final: Tf012AutoRunResult | null;
  receiver: Tf012AutoReceiverSample;
  sender: Tf012AutoSenderSample;
}

function runPlan(options: {ready: boolean} = {ready: true}): RecordedRun {
  const commands: Tf012AutoEnvelope[] = [];
  const frozen: Tf012AutoStepResult[] = [];
  let final: Tf012AutoRunResult | null = null;
  const receiver = emptyReceiverSample();
  const sender: Tf012AutoSenderSample = {
    mode: 'static', holdMs: null, cursor: 0, paused: false, broadcasting: false,
    canvasDevicePx: 1020, canvasHash: 'aaaa', pausedAt: null, resumedAt: null,
  };
  const orchestrator = createTf012AutoOrchestrator({
    runId: 'run-test-1',
    buildId: 'tf012-r13-test',
    device: 'test-rig',
    ports: {
      send: (message) => {
        // Every outbound message must satisfy the strict control-plane validator.
        const check = validateTf012AutoControlMessage(message);
        assert.equal(check.ok, true, `orchestrator emitted an illegal message: ${check.reason}`);
        commands.push(message);
        // Apply the control effect to the simulated sender.
        if (message.action === 'SET_MODE') sender.mode = message.mode as 'static' | 'cyclic';
        if (message.action === 'SET_HOLD_MS') sender.holdMs = Number(message.holdMs);
        if (message.action === 'PAUSE') {
          sender.paused = true;
          sender.pausedAt = 1;
        }
        if (message.action === 'RESUME') sender.paused = false;
        if (message.action === 'START') sender.broadcasting = true;
        if (message.action === 'STOP') sender.broadcasting = false;
      },
      senderSample: () => {
        // The simulated cycle advances while running and is frozen while paused.
        if (sender.broadcasting && !sender.paused) sender.cursor = ((sender.cursor ?? 0) + 1) % 16;
        return {...sender};
      },
      receiverSample: () => {
        // The simulated receiver decodes while the sender is running, and — crucially —
        // also while it is PAUSED (that is the point of the A4 step).
        if (sender.broadcasting) {
          receiver.cameraFrames += 3;
          receiver.decodeAttempts += 3;
          if (options.ready) {
            receiver.successfulDecodes += 1;
            receiver.uniqueReceived = Math.min(16, receiver.uniqueReceived + 1);
            receiver.observedCodeWidthPx = 287.35;
            receiver.pixelsPerCellX = 2.99;
            receiver.pixelsPerCellY = 3.0;
            receiver.reservedPatternScore = 0.95;
            receiver.contrast = 168.65;
          } else {
            receiver.crcFailures += 3;
          }
        }
        return {...receiver};
      },
      resetReceiverMetrics: () => {
        receiver.cameraFrames = 0;
        receiver.decodeAttempts = 0;
        receiver.successfulDecodes = 0;
        receiver.crcFailures = 0;
        receiver.locateFailures = 0;
        receiver.uniqueReceived = 0;
      },
      onStepResult: (result) => frozen.push(result),
      onRunResult: (result) => {
        final = result;
      },
    },
  });

  let now = 1000;
  orchestrator.start(now);
  const limit = 200;
  for (let index = 0; index < limit && orchestrator.finalResult() === null; index += 1) {
    now += 500;
    orchestrator.tick(now);
  }
  return {commands, frozen, final, receiver, sender};
}

test('r13 auto plan: the declaration and the sender holdMs follow the active step', () => {
  const {commands, frozen} = runPlan();

  // For every cyclic step the SET_HOLD_MS sent to the sender and the declaration the
  // phone would show come from the SAME step object, so they cannot drift.
  const setHold = commands.filter((message) => message.action === 'SET_HOLD_MS');
  assert.deepEqual(setHold.map((message) => [message.stepId, message.holdMs]), [
    ['A2', 5000],
    ['A3', 1000],
    ['A4', 1000],
  ]);
  for (const message of setHold) {
    const step = tf012AutoStep(message.stepId as 'A2');
    assert.equal(message.holdMs, step.holdMs, `sender holdMs must equal the step holdMs for ${step.id}`);
  }

  // Static steps declare no hold time at all (the sender ignores holdMs in static mode).
  const modeMessages = commands.filter((message) => message.action === 'SET_MODE');
  assert.deepEqual(modeMessages.map((message) => [message.stepId, message.mode, message.chunkIndex]), [
    ['SETUP', 'static', 0],
    ['A1', 'static', 0],
    ['A2', 'cyclic', null],
    ['A3', 'cyclic', null],
    ['A4', 'cyclic', null],
    ['A5', 'static', 0],
  ]);

  // PAUSE reports the cursor that is actually frozen, so the frozen JSON records
  // which chunk the pause held rather than a plan-time guess.
  const pause = commands.find((message) => message.action === 'PAUSE');
  const a4Result = frozen.find((result) => result.stepId === 'A4');
  assert.equal(typeof pause?.chunkIndex, 'number', 'PAUSE must report the frozen cursor');
  assert.equal(pause?.chunkIndex, a4Result?.beforePause?.sender.cursor);

  // The command order is exactly the plan order, with SET_MODE before SET_HOLD_MS
  // before START inside each step.
  const sequence = commands
    .filter((message) => ['SET_MODE', 'SET_HOLD_MS', 'START', 'PAUSE', 'STEP_COMPLETE'].includes(String(message.action)))
    .map((message) => `${String(message.stepId)}:${String(message.action)}`);
  assert.deepEqual(sequence, [
    'SETUP:SET_MODE', 'SETUP:START',
    'A1:SET_MODE', 'A1:START', 'A1:STEP_COMPLETE',
    'A2:SET_MODE', 'A2:SET_HOLD_MS', 'A2:START', 'A2:STEP_COMPLETE',
    'A3:SET_MODE', 'A3:SET_HOLD_MS', 'A3:START', 'A3:STEP_COMPLETE',
    'A4:SET_MODE', 'A4:SET_HOLD_MS', 'A4:START', 'A4:PAUSE', 'A4:STEP_COMPLETE',
    'A5:SET_MODE', 'A5:START', 'A5:STEP_COMPLETE',
  ]);
});

// ---------------------------------------------------------------------------
// 7 — no payload can cross the control channel
// ---------------------------------------------------------------------------

test('r13 control channel: payload-shaped messages are rejected', () => {
  // The declared schema itself contains no payload-shaped field name.
  for (const [action, fields] of Object.entries(TF012_AUTO_ALLOWED_FIELDS)) {
    for (const field of fields) {
      assert.deepEqual(tf012AutoForbiddenFieldHits({[field]: 1}), [],
        `${action}.${field} must not look like a payload field`);
    }
  }

  const legal = tf012AutoCommand('SET_HOLD_MS', {runId: 'r1', stepId: 'A2', holdMs: 5000});
  assert.equal(validateTf012AutoControlMessage(legal).ok, true);

  const rejections: Array<[string, unknown]> = [
    ['chunk payload', {type: 'command', action: 'SET_HOLD_MS', holdMs: 5000, chunkPayload: 'AAEC'}],
    ['file bytes', {type: 'command', action: 'START', runId: 'r1', fileBytes: 'AAEC'}],
    ['frame bytes', {type: 'command', action: 'START', frameBytesHex: 'AAEC'}],
    ['CRC oracle', {type: 'command', action: 'START', expectedCrc: 12345}],
    ['decode oracle', {type: 'command', action: 'START', expectedDecodedChunk: 0}],
    ['reconstructed bytes', {type: 'command', action: 'START', reconstructed: 'AAAA'}],
    ['SHA payload', {type: 'command', action: 'START', shaPayload: 'AA'}],
    ['nested object', {type: 'command', action: 'START', extra: {a: 1}}],
    ['oversized string', {type: 'command', action: 'RUN_ABORTED', reason: 'x'.repeat(400)}],
    ['encoded blob in an allowed field', {type: 'command', action: 'RUN_ABORTED', reason: 'A'.repeat(200)}],
    ['hex blob in an allowed field', {type: 'command', action: 'RUN_ABORTED', reason: 'ab'.repeat(60)}],
    ['unknown action', {type: 'command', action: 'SEND_FILE'}],
    ['wrong payloadPath', {type: 'command', action: 'RECEIVER_METRICS', payloadPath: 'WEBSOCKET'}],
  ];
  for (const [label, message] of rejections) {
    assert.equal(validateTf012AutoControlMessage(message).ok, false, `${label} must be rejected`);
  }

  // A legal receiver-metrics message carries measurements only, and declares NONE.
  const metrics = tf012AutoCommand('RECEIVER_METRICS', {
    runId: 'r1', stepId: 'A3', phase: 'STEP', payloadPath: 'NONE',
    observedCodeWidthPx: 287.35, pixelsPerCellX: 2.99, pixelsPerCellY: 3.0,
    reservedPatternScore: 0.95, contrast: 168.65, frameRotationIndex: 0,
    callbackFps: 30.1, processingFps: 28.4, activeProcessAvgMs: 12.5,
    activeProcessP95Ms: 21.0, cameraFrames: 209, decodeAttempts: 209,
    successfulDecodes: 0, crcFailures: 209, locateFailures: 0, uniqueReceived: 0,
    decodedChunkIndexes: [],
  });
  assert.equal(validateTf012AutoControlMessage(metrics).ok, true);

  // The builder refuses to construct an illegal message at all.
  assert.throws(() => tf012AutoCommand('START', {fileBytes: 'AA'}), /Illegal TF-012 auto control message/);
});

// ---------------------------------------------------------------------------
// 10 — setup gate
// ---------------------------------------------------------------------------

test('r13 setup gate: evidence-based readiness without a hard px/cell threshold', () => {
  // 2.99 px/cell with a valid decode IS ready — the existing physical evidence proves
  // it decodes, so the gate must not reject it on a 4 px/cell rule.
  const marginal = evaluateTf012AutoSetupGate({
    ...emptyReceiverSample(),
    observedCodeWidthPx: 287.35, pixelsPerCellX: 2.99, pixelsPerCellY: 3.0,
    reservedPatternScore: 0.95, contrast: 168.65, cameraFrames: 300,
    decodeAttempts: 300, successfulDecodes: 214, crcFailures: 86, uniqueReceived: 1,
  });
  assert.equal(marginal.ready, true, 'a decoding 2.99 px/cell setup must pass the gate');
  assert.equal(marginal.label, 'SETUP READY / 取景条件就绪');

  const noDecode = evaluateTf012AutoSetupGate({
    ...emptyReceiverSample(),
    observedCodeWidthPx: 287.35, pixelsPerCellX: 2.99, reservedPatternScore: 0.95,
    cameraFrames: 300, decodeAttempts: 300, successfulDecodes: 0, crcFailures: 300,
  });
  assert.equal(noDecode.ready, false);
  assert.match(noDecode.reasons.join(' | '), /no valid decode yet/);
  assert.equal(noDecode.label, 'SETUP NOT READY / 取景条件未就绪');

  const noLock = evaluateTf012AutoSetupGate({
    ...emptyReceiverSample(),
    observedCodeWidthPx: 287, decodeAttempts: 120, locateFailures: 120,
    successfulDecodes: 0, reservedPatternScore: 0.9,
  });
  assert.equal(noLock.ready, false);
  assert.match(noLock.reasons.join(' | '), /locator never locked/);

  const badScore = evaluateTf012AutoSetupGate({
    ...emptyReceiverSample(),
    observedCodeWidthPx: 287, decodeAttempts: 100, successfulDecodes: 3,
    reservedPatternScore: 0.31,
  });
  assert.equal(badScore.ready, false);
  assert.match(badScore.reasons.join(' | '), /reserved pattern score 0.310 below/);
});

test('r13 setup gate: an unusable setup aborts before any step runs', () => {
  const {commands, frozen, final} = runPlan({ready: false});

  assert.equal(frozen.length, 0, 'no step may be frozen when the gate fails');
  assert.equal(final?.status, 'SETUP_NOT_READY');
  assert.equal(final?.stepsCompleted, 0);
  assert.match(final?.setupGate.label ?? '', /SETUP NOT READY/);
  // The run must STOP the sender and never issue A1.
  assert.equal(commands.some((message) => message.action === 'STOP'), true);
  assert.equal(commands.some((message) => message.stepId === 'A1'), false);
});

// ---------------------------------------------------------------------------
// 8 + 9 — immutable per-step results and a complete final JSON
// ---------------------------------------------------------------------------

test('r13 results: every step freezes once, immutably, and the final JSON holds all steps', () => {
  const {frozen, final, commands} = runPlan();

  assert.equal(final?.status, 'COMPLETE');
  assert.equal(frozen.length, 5);

  // Order is the plan order, and each frozen result is immutable.
  assert.deepEqual(frozen.map((result) => result.stepId), ['A1', 'A2', 'A3', 'A4', 'A5']);
  for (const result of frozen) {
    assert.equal(Object.isFrozen(result), true, `${result.stepId} must be frozen`);
  }

  // stepsCompleted == stepsPlanned and the final JSON embeds every step.
  assert.equal(final?.stepsCompleted, 5);
  assert.equal(final?.stepsPlanned, 5);
  assert.deepEqual(final?.steps.map((result) => result.stepId), ['A1', 'A2', 'A3', 'A4', 'A5']);
  for (const result of final?.steps ?? []) {
    assert.equal(Object.isFrozen(result), true);
  }

  // Each step carries the sender block the task specified.
  for (const result of frozen) {
    assert.equal(typeof result.sender.mode, 'string');
    assert.equal(typeof result.sender.cursor, 'number');
    assert.equal(typeof result.sender.canvasDevicePx, 'number');
    assert.equal(typeof result.sender.canvasHash, 'string');
    assert.equal(typeof result.startedAtIso, 'string');
    assert.equal(typeof result.finishedAtIso, 'string');
  }

  // A4 splits into beforePause / duringPause — the whole point of the step.
  const a4 = frozen.find((result) => result.stepId === 'A4');
  assert.ok(a4?.beforePause, 'A4 must carry beforePause metrics');
  assert.ok(a4?.duringPause, 'A4 must carry duringPause metrics');
  assert.equal(a4?.beforePause?.sender.paused, false, 'the beforePause snapshot is taken BEFORE the pause');
  assert.equal(a4?.duringPause?.sender.paused, true, 'the duringPause snapshot is taken while paused');

  // The run is append-only: a completed step is never overwritten.
  const ids = frozen.map((result) => result.stepId);
  assert.equal(new Set(ids).size, ids.length, 'each step appears exactly once');

  assert.equal(final?.networkPayloadPath, 'NONE');
  // RUN_COMPLETE declares all five step ids and nothing else.
  const complete = commands.find((message) => message.action === 'RUN_COMPLETE');
  assert.deepEqual(complete?.steps, ['A1', 'A2', 'A3', 'A4', 'A5']);
});
