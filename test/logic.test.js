'use strict';

var assert = require('assert').strict;
var fs = require('fs');
var path = require('path');
var logic = require('../logic.js');

var passed = 0;

function test(name, fn) {
  fn();
  passed += 1;
  console.log('ok - ' + name);
}

function near(actual, expected, epsilon) {
  assert.ok(
    Math.abs(actual - expected) <= (epsilon == null ? 1e-9 : epsilon),
    'expected ' + expected + ' got ' + actual
  );
}

test('bpm is 60 divided by the mean of the last 4 to 6 intervals', function () {
  assert.equal(logic.bpmFromIntervals(null), null);
  assert.equal(logic.bpmFromIntervals([]), null);
  assert.equal(logic.bpmFromIntervals([5, 5, 5]), null);
  assert.equal(logic.bpmFromIntervals([5, 5, 0, 5]), null);
  assert.equal(logic.bpmFromIntervals([5, 5, -1, 5, 5]), null);
  near(logic.bpmFromIntervals([5, 5, 5, 5]), 12);
  near(logic.bpmFromIntervals([4, 4, 4, 4]), 15);
  near(logic.bpmFromIntervals([4, 5, 4, 5, 4]), 60 / 4.4);
  near(logic.bpmFromIntervals([6, 6, 6, 6]), 10);
  near(logic.bpmFromIntervals([8, 8, 8, 8]), 7.5);
  near(logic.bpmFromIntervals([7.5, 7.5, 7.5, 7.5]), 8);
  // 8 intervals: only the last 6 count. [10, 10, 5, 5, 5, 5] mean 40/6.
  near(logic.bpmFromIntervals([10, 10, 10, 10, 5, 5, 5, 5]), 60 / (40 / 6));
  near(logic.bpmFromIntervals([3, 3, 3, 3, 3, 3]), 20);
});

test('level boundaries partition normal, caution, and critical', function () {
  assert.equal(logic.levelFromBpm(null), 'unknown');
  assert.equal(logic.levelFromBpm(undefined), 'unknown');
  assert.equal(logic.levelFromBpm(Number.NaN), 'unknown');
  assert.equal(logic.levelFromBpm(12), 'normal');
  assert.equal(logic.levelFromBpm(18.4), 'normal');
  assert.equal(logic.levelFromBpm(11.999), 'caution');
  assert.equal(logic.levelFromBpm(11), 'caution');
  assert.equal(logic.levelFromBpm(8), 'caution');
  assert.equal(logic.levelFromBpm(7.999), 'critical');
  assert.equal(logic.levelFromBpm(0), 'critical');
});

test('taps build a rate and ignore bounces and long gaps', function () {
  var taps = logic.createTapState();
  var i;
  taps = logic.recordTap(taps, 0);
  assert.equal(taps.accepted, true);
  assert.deepEqual(taps.intervals, []);
  for (i = 1; i <= 4; i += 1) {
    taps = logic.recordTap(taps, i * 5000);
  }
  assert.equal(taps.intervals.length, 4);
  near(logic.bpmFromIntervals(taps.intervals), 12);

  var bounced = logic.recordTap(taps, 20000 + 200);
  assert.equal(bounced.accepted, false);
  assert.equal(bounced.lastTapAt, 20000);
  assert.equal(bounced.intervals.length, 4);

  var reset = logic.recordTap(taps, 20000 + 15001);
  assert.equal(reset.accepted, true);
  assert.equal(reset.reset, true);
  assert.deepEqual(reset.intervals, []);

  taps = logic.createTapState();
  taps = logic.recordTap(taps, 0);
  for (i = 1; i <= 8; i += 1) {
    taps = logic.recordTap(taps, i * 1000);
  }
  assert.equal(taps.intervals.length, 6);
  assert.deepEqual(taps.intervals, [1, 1, 1, 1, 1, 1]);
  near(logic.bpmFromIntervals(taps.intervals), 60);
});

function step(session, now, bpm) {
  return logic.present(session, { now: now, bpm: bpm });
}

test('listening until there is a rate, then normal when the rate is at least 12', function () {
  var session = logic.createSession(0);
  var view = step(session, 0, null);
  assert.equal(view.view.level, 'listening');
  assert.equal(view.view.showCheckIn, false);
  session = logic.noteSignal(view.session, 0);
  view = step(session, 1000, 14);
  assert.equal(view.view.level, 'normal');
  assert.equal(view.view.reason, 'stable');
  assert.equal(view.view.alarm, false);
  assert.equal(session.lastResponseAt, 0);
});

test('caution band shows the check-in immediately and escalates after 15s', function () {
  var session = logic.noteSignal(logic.createSession(0), 0);
  var view = step(session, 0, 9);
  assert.equal(view.view.level, 'caution');
  assert.equal(view.view.reason, 'slow-bpm');
  assert.equal(view.view.showCheckIn, true);
  assert.equal(view.view.chime, true);
  assert.equal(view.view.showDashboard, false);
  session = view.session;
  view = step(session, 14999, 9);
  assert.equal(view.view.level, 'caution');
  session = view.session;
  view = step(session, 15000, 9);
  assert.equal(view.view.level, 'critical');
  assert.equal(view.view.reason, 'unanswered-checkin');
  assert.equal(view.view.alarm, true);
  assert.equal(view.view.showDashboard, true);
  assert.equal(view.view.showCheckIn, false);
});

test('confirming the check-in restarts the 15s clock', function () {
  var session = step(logic.noteSignal(logic.createSession(0), 0), 0, 10).session;
  var view = logic.respondOk(session, { now: 10000, bpm: 10 });
  assert.equal(view.view.level, 'caution');
  assert.equal(view.view.showCheckIn, true);
  assert.equal(view.view.alarm, false);
  session = view.session;
  view = step(session, 24999, 10);
  assert.equal(view.view.level, 'caution');
  session = view.session;
  view = step(session, 25000, 10);
  assert.equal(view.view.level, 'critical');
  assert.equal(view.view.reason, 'unanswered-checkin');
});

test('no breath or tap for 20s opens a check-in, and 15s more goes critical', function () {
  var session = logic.createSession(0);
  var view = step(session, 19999, null);
  assert.equal(view.view.level, 'listening');
  assert.equal(view.view.showCheckIn, false);
  session = view.session;
  view = step(session, 20000, null);
  assert.equal(view.view.level, 'caution');
  assert.equal(view.view.reason, 'inactivity');
  assert.equal(view.view.showCheckIn, true);
  session = view.session;
  view = step(session, 34999, 16);
  assert.equal(view.view.level, 'caution');
  assert.equal(view.view.reason, 'inactivity');
  session = view.session;
  view = step(session, 35000, 16);
  assert.equal(view.view.level, 'critical');
  assert.equal(view.view.reason, 'unanswered-checkin');
});

test('a recent normal rate does not check in just before 20s', function () {
  var session = logic.noteSignal(logic.createSession(0), 10000);
  var view = step(session, 29999, 15);
  assert.equal(view.view.level, 'normal');
  view = step(session, 30000, 15);
  assert.equal(view.view.level, 'caution');
  assert.equal(view.view.reason, 'inactivity');
});

test('bpm under 8 is critical immediately and the dashboard latches', function () {
  var session = logic.noteSignal(logic.createSession(0), 0);
  var view = step(session, 1000, 7.9);
  assert.equal(view.view.level, 'critical');
  assert.equal(view.view.reason, 'low-bpm');
  assert.equal(view.view.alarm, true);
  session = view.session;
  view = step(session, 2000, 18);
  assert.equal(view.view.showDashboard, true);
  assert.equal(view.view.alarm, true);
  assert.equal(view.view.reason, 'low-bpm');
});

test('Silence / I am OK mutes a still-low rate and clears once the rate recovers', function () {
  var session = step(logic.noteSignal(logic.createSession(0), 0), 1000, 6).session;
  var view = logic.respondOk(session, { now: 2500, bpm: 6 });
  assert.equal(view.view.showDashboard, true);
  assert.equal(view.view.alarm, false);
  assert.equal(view.view.level, 'critical');
  session = view.session;
  view = step(session, 3000, null);
  assert.equal(view.view.showDashboard, true, 'a missing rate is not recovery');
  assert.equal(view.view.alarm, false);
  session = view.session;
  view = step(session, 4000, 16);
  assert.equal(view.view.showDashboard, false);
  assert.equal(view.view.level, 'normal');
  assert.equal(view.view.alarm, false);
});

test('responding during a latched critical with a normal rate leaves the dashboard', function () {
  var session = step(logic.noteSignal(logic.createSession(0), 0), 1000, 5).session;
  session = step(session, 2000, 18).session;
  var view = logic.respondOk(session, { now: 2500, bpm: 18 });
  assert.equal(view.view.showDashboard, false);
  assert.equal(view.view.level, 'normal');
  assert.equal(view.view.alarm, false);
});

test('exactly 8 BPM stays caution and exactly 12 stays normal', function () {
  var session = logic.noteSignal(logic.createSession(0), 0);
  assert.equal(step(session, 0, 8).view.level, 'caution');
  assert.equal(step(session, 0, 12).view.level, 'normal');
});

test('noise calibration threshold sits above the floor and below real breaths', function () {
  var empty = logic.calibrateNoise([]);
  assert.equal(empty.noiseFloor, 0);
  assert.equal(empty.threshold, 0.004);

  var flat = [];
  var mixed = [];
  var i;
  for (i = 0; i < 50; i += 1) flat.push(0.02);
  var constant = logic.calibrateNoise(flat);
  near(constant.noiseFloor, 0.02);
  near(constant.threshold, 0.035);

  for (i = 0; i < 90; i += 1) mixed.push(0.02);
  for (i = 0; i < 10; i += 1) mixed.push(0.2);
  var varied = logic.calibrateNoise(mixed.concat([Number.NaN, -1]));
  near(varied.noiseFloor, 0.02);
  near(varied.threshold, 0.083);
  assert.ok(varied.threshold < 0.2);
});

test('confidence is high for loud regular peaks and low for a weak signal', function () {
  var strong = logic.confidenceScore({
    noiseFloor: 0.02,
    recentPeakValues: [0.2, 0.2, 0.2, 0.2, 0.2],
    intervals: [5, 5, 5, 5]
  });
  var weak = logic.confidenceScore({
    noiseFloor: 0.02,
    recentPeakValues: [0.025],
    intervals: []
  });
  near(strong, 1);
  near(weak, 0.17);
  assert.equal(logic.confidenceScore({ noiseFloor: 0.02, recentPeakValues: [], intervals: [] }), 0);
  assert.equal(logic.signalIsLow({ calibrated: false, confidence: 0 }), false);
  assert.equal(logic.signalIsLow({ calibrated: true, confidence: weak }), true);
  assert.equal(logic.signalIsLow({ calibrated: true, confidence: strong }), false);
  near(logic.calibrationProgress(0), 0);
  near(logic.calibrationProgress(5000), 0.5);
  near(logic.calibrationProgress(20000), 1);
});

function runScenario(rawAt, totalMs) {
  var dt = 50;
  var noise = [];
  var t;
  var cal;
  var tracker;
  var env = 0;
  var accepted = 0;
  var last = null;
  for (t = 0; t < 10000; t += dt) {
    noise.push(0.008 + (t % 200 === 0 ? 0.003 : 0));
  }
  cal = logic.calibrateNoise(noise);
  tracker = logic.createBreathTracker({
    threshold: cal.threshold,
    noiseFloor: cal.noiseFloor,
    minIntervalMs: logic.LIMITS.minBreathIntervalMs
  });
  for (t = 0; t <= totalMs; t += dt) {
    env = logic.smoothEnvelope(env, rawAt(t), dt);
    last = tracker.push(t, env);
    if (last.accepted) accepted += 1;
  }
  return { accepted: accepted, last: last, cal: cal };
}

test('envelope peak detection counts breath cycles, not inhale plus exhale', function () {
  var result = runScenario(function (t) {
    var phase = t % 5000;
    if (phase < 350) return 0.25;
    if (phase >= 800 && phase < 1200) return 0.18;
    return 0.008;
  }, 30000);
  assert.ok(result.cal.threshold < 0.05, 'threshold ' + result.cal.threshold);
  assert.equal(result.accepted, 6);
  assert.equal(result.last.intervals.length, 5);
  result.last.intervals.forEach(function (interval) {
    assert.ok(interval > 4.2 && interval < 5.8, 'interval ' + interval);
  });
  near(result.last.bpm, 12, 0.6);
  assert.ok(result.last.confidence > 0.7);
});

test('breaths about 3s apart stay separate and land near 20 BPM', function () {
  var result = runScenario(function (t) {
    var phase = t % 3000;
    if (phase < 400) return 0.22;
    return 0.008;
  }, 15000);
  assert.ok(result.accepted >= 4);
  assert.ok(result.accepted <= 6);
  near(result.last.bpm, 20, 2);
});

test('chatter around the threshold cannot invent a fast rate', function () {
  var tracker = logic.createBreathTracker({
    threshold: 0.05,
    noiseFloor: 0.01,
    minIntervalMs: 2000
  });
  var accepted = 0;
  var t;
  var value;
  var out = null;
  for (t = 0; t <= 10000; t += 50) {
    value = t % 100 === 0 ? 0.08 : 0.01;
    out = tracker.push(t, value);
    if (out.accepted) accepted += 1;
  }
  assert.ok(accepted <= 5, 'accepted ' + accepted);
  if (out.bpm != null) assert.ok(out.bpm <= 30);
});

test('required copy strings stay exact', function () {
  assert.equal(
    logic.COPY.lowSignal,
    'Signal low — consider moving closer or switching to Tap Mode.'
  );
  assert.equal(logic.COPY.checkIn, 'Are you OK? Tap to confirm');
});

test('static app keeps privacy, offline shell, and emergency copy', function () {
  var root = path.join(__dirname, '..');
  function read(name) {
    return fs.readFileSync(path.join(root, name), 'utf8');
  }
  var html = read('index.html');
  var css = read('styles.css');
  var app = read('app.js');
  var sw = read('sw.js');
  var manifest = JSON.parse(read('manifest.json'));
  var assets = [
    './index.html',
    './styles.css',
    './app.js',
    './logic.js',
    './manifest.json',
    './sw.js',
    './icon.svg',
    './icon-192.png',
    './icon-512.png'
  ];

  assert.ok(fs.existsSync(path.join(root, '.nojekyll')));
  assets.forEach(function (asset) {
    assert.ok(fs.existsSync(path.join(root, asset.slice(2))), 'missing ' + asset);
    assert.ok(sw.indexOf(asset) !== -1, 'service worker does not cache ' + asset);
  });

  assert.ok(html.indexOf(logic.COPY.lowSignal) !== -1);
  assert.ok(html.indexOf(logic.COPY.checkIn) !== -1);
  assert.ok(/not a medical device/i.test(html));
  assert.ok(/cannot call for help/i.test(html));
  assert.ok(/foreground/i.test(html));
  assert.ok(/screen on/i.test(html));
  assert.ok(/never use alone/i.test(html));
  assert.ok(html.indexOf('1-800-484-3731') !== -1);
  assert.ok(html.indexOf('href="tel:18004843731"') !== -1);
  assert.ok(html.indexOf('href="tel:911"') !== -1);
  assert.ok(html.indexOf('Silence / I\'m OK') !== -1);
  assert.ok(/nostril/i.test(html));
  assert.ok(/rescue breaths/i.test(html));
  assert.ok(/2–3 minutes/i.test(html));
  assert.ok(/recovery position/i.test(html));
  assert.ok(html.indexOf('src="./logic.js"') !== -1);
  assert.ok(html.indexOf('src="./app.js"') !== -1);
  assert.ok(html.indexOf('href="./styles.css"') !== -1);
  assert.ok(html.indexOf('href="./manifest.json"') !== -1);
  assert.equal(html.indexOf('type="module"'), -1);
  assert.ok(!/href="\//.test(html));
  assert.ok(!/src="\//.test(html));
  assert.ok(!/https?:\/\//.test(html));
  assert.ok(!/https?:\/\//.test(css));
  assert.ok(!/https?:\/\//.test(app));

  ['localStorage', 'sessionStorage', 'indexedDB', 'sendBeacon', 'XMLHttpRequest', 'WebSocket', 'fetch('].forEach(function (token) {
    assert.equal(app.indexOf(token), -1, 'app.js should not use ' + token);
  });

  var unlockAt = app.indexOf('function unlockAudioAndWakeLock');
  assert.ok(unlockAt !== -1);
  var unlock = app.slice(unlockAt, unlockAt + 600);
  assert.ok(unlock.indexOf('AudioContext') !== -1);
  assert.ok(unlock.indexOf('resume()') !== -1);
  assert.ok(unlock.indexOf('requestWakeLock()') !== -1);
  assert.ok(unlock.indexOf('AudioContext') < unlock.indexOf('requestWakeLock()'));
  var startAt = app.indexOf('function onStart');
  var start = app.slice(startAt, startAt + 500);
  assert.ok(start.indexOf('unlockAudioAndWakeLock()') !== -1);
  assert.ok(app.indexOf('visibilitychange') !== -1);
  assert.ok(app.indexOf("register('./sw.js')") !== -1);
  assert.ok(app.indexOf('highpass') !== -1);
  assert.ok(app.indexOf('lowpass') !== -1);
  assert.ok(css.indexOf('prefers-reduced-motion') !== -1);
  assert.ok(css.indexOf('alarm-flash') !== -1);

  assert.equal(manifest.start_url, './');
  assert.equal(manifest.scope, './');
  assert.equal(manifest.display, 'standalone');
  assert.ok(manifest.icons.length >= 2);
  manifest.icons.forEach(function (icon) {
    assert.ok(icon.src.indexOf('./') === 0);
  });
});

console.log('\n' + passed + ' tests passed');
