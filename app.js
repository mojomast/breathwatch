'use strict';

var audioCtx = null;
var wakeLock = null;
var started = false;
var session = null;
var tapState = null;
var mode = 'tap';
var timer = 0;
var lastBpm = null;
var lastLevelKey = '';
var lastChimeAt = 0;
var alarm = null;
var mediaStream = null;
var micNodes = null;
var micFrame = 0;
var timeBuffer = null;
var waveContext = null;

var mic = {
  smoothed: 0,
  lastFrameMs: 0,
  calibrating: false,
  calStarted: 0,
  calSamples: [],
  lastCalSampleAt: 0,
  tracker: null,
  bpm: null,
  confidence: 0,
  threshold: 0
};

var startButton = document.getElementById('start-button');
var tapButton = document.getElementById('tap-button');
var modeTap = document.getElementById('mode-tap');
var modeMic = document.getElementById('mode-mic');
var confirmButton = document.getElementById('confirm-ok');
var imOkButton = document.getElementById('im-ok');
var waveCanvas = document.getElementById('wave');
var themeMeta = document.querySelector('meta[name="theme-color"]');

function setWake(state) {
  document.documentElement.dataset.wake = state;
  var note = document.getElementById('wake-note');
  if (!note) return;
  note.hidden = state === 'granted';
}

function requestWakeLock() {
  if (!('wakeLock' in navigator)) {
    setWake('missing');
    return;
  }
  navigator.wakeLock.request('screen').then(function (sentinel) {
    wakeLock = sentinel;
    setWake('granted');
  }).catch(function () {
    wakeLock = null;
    setWake('denied');
  });
}

function unlockAudioAndWakeLock() {
  var AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!audioCtx && AudioCtx) {
    audioCtx = new AudioCtx();
  }
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
  requestWakeLock();
}

document.addEventListener('visibilitychange', function () {
  if (!started) return;
  if (document.visibilityState === 'visible') {
    requestWakeLock();
    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
  }
});

function playChime() {
  if (!audioCtx) return;
  var osc = audioCtx.createOscillator();
  var gain = audioCtx.createGain();
  var now = audioCtx.currentTime;
  osc.type = 'sine';
  osc.frequency.value = 523.25;
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.05, now + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.35);
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.start(now);
  osc.stop(now + 0.4);
}

function maybeChime(now) {
  if (now - lastChimeAt < 4000) return;
  lastChimeAt = now;
  playChime();
}

function ensureAlarm() {
  if (!audioCtx) return;
  if (audioCtx.state === 'suspended') audioCtx.resume();
  if (alarm) return;
  var osc = audioCtx.createOscillator();
  var gain = audioCtx.createGain();
  var now = audioCtx.currentTime;
  osc.type = 'square';
  osc.frequency.value = 440;
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.28, now + 0.05);
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.start(now);
  alarm = { osc: osc, gain: gain };
}

function pulseAlarm() {
  if (!alarm || !audioCtx) return;
  var t = audioCtx.currentTime;
  var high = Math.floor(t * 2) % 2 === 0;
  try {
    alarm.osc.frequency.setTargetAtTime(high ? 880 : 440, t, 0.015);
    alarm.gain.gain.setTargetAtTime(high ? 0.28 : 0.12, t, 0.02);
  } catch (err) {
    stopAlarm();
  }
}

function stopAlarm() {
  if (!alarm || !audioCtx) {
    alarm = null;
    return;
  }
  try {
    var now = audioCtx.currentTime;
    alarm.gain.gain.cancelScheduledValues(now);
    alarm.gain.gain.setTargetAtTime(0.0001, now, 0.02);
    alarm.osc.stop(now + 0.08);
  } catch (err) { /* already stopped */ }
  alarm = null;
}

function formatBpm(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return (Math.round(value * 10) / 10).toFixed(1);
}

function formatSpan(ms) {
  var seconds = Math.max(0, Math.floor(ms / 1000));
  var minutes = Math.floor(seconds / 60);
  var rest = seconds % 60;
  if (minutes <= 0) return seconds + 's';
  return minutes + 'm ' + (rest < 10 ? '0' : '') + rest + 's';
}

function activeBpm() {
  if (mode === 'tap') return BreathLogic.bpmFromIntervals(tapState.intervals);
  return mic.bpm;
}

function reasonText(reason) {
  if (reason === 'slow-bpm') return 'Breathing is under 12 a minute.';
  if (reason === 'inactivity') return 'No breath or tap for about 20 seconds.';
  if (reason === 'low-bpm') return 'Breathing is under 8 a minute.';
  if (reason === 'unanswered-checkin') return 'A check-in went unanswered.';
  return '';
}

function statusLabel(level) {
  if (level === 'normal') return 'Normal';
  if (level === 'caution') return 'Caution';
  if (level === 'critical') return 'Critical';
  return 'Listening';
}

function paintBpm(numId, labelId, bpm, stale) {
  var number = document.getElementById(numId);
  var label = document.getElementById(labelId);
  var shown = bpm;
  var current = typeof bpm === 'number' && Number.isFinite(bpm);
  if (!current) shown = lastBpm;
  number.textContent = formatBpm(shown);
  if (label) {
    label.textContent = current && !stale ? 'Current' : 'Last';
  }
}

function render(view, now, bpm) {
  document.body.dataset.level = view.showDashboard ? 'critical' : view.level;
  if (themeMeta) {
    themeMeta.setAttribute('content', view.showDashboard || view.level === 'critical' ? '#ff2b2b' : '#121820');
  }

  var watchBpm = mode === 'tap' || (typeof bpm === 'number' && Number.isFinite(bpm)) ? bpm : null;
  paintBpm('bpm-num', 'bpm-label', watchBpm, view.stale);
  paintBpm('checkin-bpm', 'checkin-label', bpm, view.stale);
  paintBpm('critical-bpm', 'critical-bpm-label', bpm, view.stale || bpm == null);

  document.getElementById('status-pill').textContent = statusLabel(view.level);
  document.getElementById('checkin-reason').textContent = reasonText(view.reason);
  document.getElementById('critical-reason').textContent = reasonText(view.reason);
  document.getElementById('alarm-state').textContent = view.alarm ? 'Alarm sounding' : 'Alarm silenced';

  var sinceValue = document.getElementById('since-response');
  var sinceLabel = document.getElementById('since-label');
  if (session.lastResponseAt == null) {
    sinceLabel.textContent = 'Time since start';
    sinceValue.textContent = formatSpan(now - session.sessionStartedAt);
  } else {
    sinceLabel.textContent = 'Time since last response';
    sinceValue.textContent = formatSpan(now - session.lastResponseAt);
  }

  if (mode === 'tap') {
    var count = tapState.intervals.length;
    document.getElementById('tap-hint').textContent = count < BreathLogic.LIMITS.minIntervals
      ? 'Tap each breath. A rate appears after a few taps.'
      : 'Based on the last ' + count + ' intervals.';
  }

  document.getElementById('start').hidden = started;
  document.getElementById('watch').hidden = !started || view.showDashboard || view.showCheckIn;
  document.getElementById('checkin').hidden = !view.showCheckIn || view.showDashboard;
  document.getElementById('critical').hidden = !view.showDashboard;

  var key = view.level + (view.showCheckIn ? '-check' : '') + (view.showDashboard ? '-dash' : '');
  if (key !== lastLevelKey) {
    var live = statusLabel(view.level);
    if (view.showCheckIn) live = BreathLogic.COPY.checkIn;
    if (view.showDashboard) live = 'Critical. ' + reasonText(view.reason);
    document.getElementById('live').textContent = live;
    if (view.showCheckIn && !view.showDashboard) confirmButton.focus();
    if (view.showDashboard) document.getElementById('critical-heading').focus();
    lastLevelKey = key;
  }
}

function syncAudio(view) {
  if (view.alarm) {
    ensureAlarm();
    pulseAlarm();
  } else {
    stopAlarm();
  }
  if (view.chime) maybeChime(Date.now());
}

function tick() {
  if (!session || !tapState) return;
  var now = Date.now();
  var bpm = activeBpm();
  var result = BreathLogic.present(session, { now: now, bpm: bpm });
  session = result.session;
  if (typeof bpm === 'number' && Number.isFinite(bpm)) lastBpm = bpm;
  render(result.view, now, bpm);
  syncAudio(result.view);
  document.documentElement.dataset.audio = audioCtx ? audioCtx.state : 'missing';
}

function onStart() {
  unlockAudioAndWakeLock();
  if (started) return;
  started = true;
  document.documentElement.dataset.started = 'true';
  document.documentElement.dataset.audio = audioCtx ? audioCtx.state : 'missing';
  if (!audioCtx) document.getElementById('audio-note').hidden = false;
  var now = Date.now();
  session = BreathLogic.createSession(now);
  tapState = BreathLogic.createTapState();
  setMode('tap');
  tick();
  timer = window.setInterval(tick, 250);
  tapButton.focus();
}

function pulseTap() {
  tapButton.classList.remove('is-pulsing');
  void tapButton.offsetWidth;
  tapButton.classList.add('is-pulsing');
}

function onTap() {
  if (!started || mode !== 'tap') return;
  var now = Date.now();
  var next = BreathLogic.recordTap(tapState, now);
  tapState = next;
  if (!next.accepted) return;
  session = BreathLogic.noteSignal(session, now);
  if (typeof navigator.vibrate === 'function') {
    try { navigator.vibrate(35); } catch (err) { /* unsupported */ }
  }
  pulseTap();
  tick();
}

function onRespond() {
  if (!session) return;
  stopAlarm();
  var now = Date.now();
  var bpm = activeBpm();
  var result = BreathLogic.respondOk(session, { now: now, bpm: bpm });
  session = result.session;
  if (typeof bpm === 'number' && Number.isFinite(bpm)) lastBpm = bpm;
  render(result.view, now, bpm);
  syncAudio(result.view);
  if (!result.view.showDashboard && !result.view.showCheckIn && mode === 'tap') {
    tapButton.focus();
  }
}

function showMicError(message) {
  var errorEl = document.getElementById('mic-error');
  errorEl.hidden = false;
  errorEl.textContent = message;
}

function stopMic() {
  if (micFrame) cancelAnimationFrame(micFrame);
  micFrame = 0;
  if (mediaStream) {
    mediaStream.getTracks().forEach(function (track) { track.stop(); });
    mediaStream = null;
  }
  if (micNodes) {
    try {
      micNodes.source.disconnect();
      micNodes.highpass.disconnect();
      micNodes.lowpass.disconnect();
      micNodes.analyser.disconnect();
    } catch (err) { /* already disconnected */ }
    micNodes = null;
  }
  mic.tracker = null;
  mic.bpm = null;
  mic.confidence = 0;
  mic.calibrating = false;
  mic.calSamples = [];
  mic.smoothed = 0;
  timeBuffer = null;
}

function rmsOf(buffer) {
  var sum = 0;
  var i;
  for (i = 0; i < buffer.length; i += 1) sum += buffer[i] * buffer[i];
  return Math.sqrt(sum / buffer.length);
}

function fitCanvas() {
  if (!waveCanvas) return;
  var rect = waveCanvas.getBoundingClientRect();
  var dpr = Math.min(2, window.devicePixelRatio || 1);
  var width = Math.max(1, Math.floor(rect.width * dpr));
  var height = Math.max(1, Math.floor((rect.height || 144) * dpr));
  if (waveCanvas.width !== width || waveCanvas.height !== height) {
    waveCanvas.width = width;
    waveCanvas.height = height;
    waveContext = null;
  }
}

function drawWave(buffer) {
  fitCanvas();
  if (!waveContext) waveContext = waveCanvas.getContext('2d');
  var ctx = waveContext;
  var w = waveCanvas.width;
  var h = waveCanvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.beginPath();
  var step = Math.max(1, Math.floor(buffer.length / w));
  var x;
  for (x = 0; x < w; x += 1) {
    var i = Math.min(buffer.length - 1, x * step);
    var y = (0.5 - buffer[i] * 1.6) * h;
    if (x === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = '#b7f0d4';
  ctx.lineWidth = Math.max(2, Math.floor(h / 90));
  ctx.stroke();
}

function setGlow(envelope, threshold) {
  var scale = threshold > 0 ? threshold * 3 : 0.05;
  var amount = scale > 0 ? envelope / scale : 0;
  var bucket = Math.round(Math.max(0, Math.min(1, amount)) * 10);
  document.getElementById('mic-glow').dataset.level = String(bucket);
}

function updateMicCopy() {
  var banner = document.getElementById('signal-banner');
  banner.textContent = BreathLogic.COPY.lowSignal;
  var calibrated = !mic.calibrating && !!mic.tracker;
  banner.hidden = !BreathLogic.signalIsLow({ calibrated: calibrated, confidence: mic.confidence });
  document.getElementById('cal-panel').hidden = !mic.calibrating;
  var confidenceEl = document.getElementById('confidence');
  if (mic.calibrating) {
    var elapsed = Date.now() - mic.calStarted;
    var left = Math.max(0, Math.ceil((BreathLogic.LIMITS.calibrationMs - elapsed) / 1000));
    document.getElementById('cal-label').textContent = 'Calibrating the room — ' + left + 's. Breathe normally.';
    document.getElementById('cal-bar').style.width = Math.round(BreathLogic.calibrationProgress(elapsed) * 100) + '%';
    confidenceEl.textContent = 'Learning the noise floor';
  } else if (mic.tracker) {
    confidenceEl.textContent = 'Confidence ' + Math.round(mic.confidence * 100) + '%';
  }
}

function onMicFrame(ts) {
  if (!micNodes || mode !== 'mic') return;
  try {
    micNodes.analyser.getFloatTimeDomainData(timeBuffer);
    var rms = rmsOf(timeBuffer);
    var dt = mic.lastFrameMs ? Math.min(80, ts - mic.lastFrameMs) : 16;
    mic.lastFrameMs = ts;
    mic.smoothed = BreathLogic.smoothEnvelope(mic.smoothed, rms, dt);
    drawWave(timeBuffer);
    setGlow(mic.smoothed, mic.threshold);

    var now = Date.now();
    if (mic.calibrating) {
      if (now - mic.lastCalSampleAt >= 50) {
        mic.calSamples.push(mic.smoothed);
        mic.lastCalSampleAt = now;
      }
      if (now - mic.calStarted >= BreathLogic.LIMITS.calibrationMs) {
        var cal = BreathLogic.calibrateNoise(mic.calSamples);
        mic.calSamples = [];
        mic.threshold = cal.threshold;
        mic.tracker = BreathLogic.createBreathTracker({
          threshold: cal.threshold,
          noiseFloor: cal.noiseFloor,
          minIntervalMs: BreathLogic.LIMITS.minBreathIntervalMs
        });
        mic.calibrating = false;
        mic.bpm = null;
        mic.confidence = 0;
      }
    } else if (mic.tracker) {
      var heard = mic.tracker.push(ts, mic.smoothed);
      mic.confidence = heard.confidence;
      mic.bpm = heard.bpm;
      if (heard.accepted) {
        session = BreathLogic.noteSignal(session, now);
        tick();
      }
    }
    updateMicCopy();
  } catch (err) {
    stopMic();
    showMicError('Microphone analysis stopped. Tap Mode still works. Nothing was recorded.');
    return;
  }
  micFrame = requestAnimationFrame(onMicFrame);
}

function attachMic(stream) {
  mediaStream = stream;
  var source = audioCtx.createMediaStreamSource(stream);
  var highpass = audioCtx.createBiquadFilter();
  highpass.type = 'highpass';
  highpass.frequency.value = 100;
  highpass.Q.value = 0.707;
  var lowpass = audioCtx.createBiquadFilter();
  lowpass.type = 'lowpass';
  lowpass.frequency.value = 1000;
  lowpass.Q.value = 0.707;
  var analyser = audioCtx.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.2;
  source.connect(highpass);
  highpass.connect(lowpass);
  lowpass.connect(analyser);
  micNodes = { source: source, highpass: highpass, lowpass: lowpass, analyser: analyser };
  timeBuffer = new Float32Array(analyser.fftSize);
  mic.smoothed = 0;
  mic.lastFrameMs = 0;
  mic.calibrating = true;
  mic.calStarted = Date.now();
  mic.calSamples = [];
  mic.lastCalSampleAt = 0;
  mic.tracker = null;
  mic.bpm = null;
  mic.confidence = 0;
  mic.threshold = 0;
  updateMicCopy();
  requestAnimationFrame(function () {
    fitCanvas();
    micFrame = requestAnimationFrame(onMicFrame);
  });
}

function startMic() {
  stopMic();
  document.getElementById('mic-error').hidden = true;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showMicError('This browser has no microphone API. Tap Mode still works. Nothing was recorded.');
    return;
  }
  if (!audioCtx) unlockAudioAndWakeLock();
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
  var audioConstraints = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false
  };
  navigator.mediaDevices.getUserMedia({ audio: audioConstraints, video: false }).catch(function () {
    return navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  }).then(function (stream) {
    if (mode !== 'mic') {
      stream.getTracks().forEach(function (track) { track.stop(); });
      return;
    }
    if (!audioCtx) {
      stream.getTracks().forEach(function (track) { track.stop(); });
      showMicError('Audio did not start. Tap Mode still works. Nothing was recorded.');
      return;
    }
    attachMic(stream);
  }).catch(function () {
    if (mode === 'mic') {
      showMicError('Microphone unavailable. Tap Mode still works. Nothing was recorded.');
    }
  });
}

function setMode(next) {
  mode = next;
  var tap = next === 'tap';
  modeTap.setAttribute('aria-pressed', tap ? 'true' : 'false');
  modeMic.setAttribute('aria-pressed', tap ? 'false' : 'true');
  document.getElementById('stage-tap').hidden = !tap;
  document.getElementById('stage-mic').hidden = tap;
  if (tap) stopMic();
  else startMic();
}

startButton.addEventListener('click', onStart);
tapButton.addEventListener('click', onTap);
confirmButton.addEventListener('click', onRespond);
imOkButton.addEventListener('click', onRespond);
modeTap.addEventListener('click', function () { setMode('tap'); });
modeMic.addEventListener('click', function () { setMode('mic'); });
document.getElementById('mic-back').addEventListener('click', function () { setMode('tap'); });
window.addEventListener('resize', fitCanvas);

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(function () { /* offline shell optional */ });
}
