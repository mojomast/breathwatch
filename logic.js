/*
 * Breathwatch decision logic.
 * Pure functions: no DOM, no audio, no storage, no network.
 * The page and the node tests both use this file.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.BreathLogic = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var LIMITS = Object.freeze({
    minIntervals: 4,
    maxIntervals: 6,
    normalMinBpm: 12,
    cautionMinBpm: 8,
    inactivityMs: 20000,
    unansweredMs: 15000,
    minTapIntervalMs: 400,
    maxTapIntervalMs: 15000,
    minBreathIntervalMs: 2000,
    calibrationMs: 10000,
    lowConfidence: 0.35,
    envelopeAttackMs: 160,
    envelopeReleaseMs: 500
  });

  var COPY = Object.freeze({
    lowSignal: 'Signal low — consider moving closer or switching to Tap Mode.',
    checkIn: 'Are you OK? Tap to confirm'
  });

  function clamp01(value) {
    if (value < 0) return 0;
    if (value > 1) return 1;
    return value;
  }

  function average(values) {
    var sum = 0;
    var i;
    for (i = 0; i < values.length; i += 1) sum += values[i];
    return sum / values.length;
  }

  function finitePositive(value) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0;
  }

  /**
   * BPM = 60 / mean(last 4 to 6 intervals).
   * Intervals are seconds between taps or breath peaks.
   * Returns null until there are at least 4 usable intervals.
   */
  function bpmFromIntervals(intervals, limits) {
    var bounds = limits || LIMITS;
    var recent;
    var i;
    var mean;
    if (!intervals || !intervals.length || intervals.length < bounds.minIntervals) {
      return null;
    }
    recent = intervals.slice(-bounds.maxIntervals);
    for (i = 0; i < recent.length; i += 1) {
      if (!finitePositive(recent[i])) return null;
    }
    mean = average(recent);
    if (!(mean > 0)) return null;
    return 60 / mean;
  }

  /**
   * normal >= 12, caution 8 up to (but not including) 12, critical below 8.
   * Missing or non-numeric rates are "unknown" so the UI does not pretend
   * someone is fine before it has a measurement.
   */
  function levelFromBpm(bpm, limits) {
    var bounds = limits || LIMITS;
    if (typeof bpm !== 'number' || !Number.isFinite(bpm)) return 'unknown';
    if (bpm >= bounds.normalMinBpm) return 'normal';
    if (bpm >= bounds.cautionMinBpm) return 'caution';
    return 'critical';
  }

  function createTapState() {
    return { intervals: [], lastTapAt: null };
  }

  /**
   * Record one tap. Very fast double-taps are ignored.
   * A gap longer than maxTapIntervalMs starts a new rhythm instead of
   * dragging the average down; the inactivity check-in covers that gap.
   */
  function recordTap(tapState, now, limits) {
    var bounds = limits || LIMITS;
    var intervals = (tapState && tapState.intervals) ? tapState.intervals.slice() : [];
    var last = tapState ? tapState.lastTapAt : null;
    var dt;
    if (last == null) {
      return { intervals: intervals, lastTapAt: now, accepted: true, ignored: false, reset: false };
    }
    dt = now - last;
    if (dt < bounds.minTapIntervalMs) {
      return { intervals: intervals, lastTapAt: last, accepted: false, ignored: true, reset: false };
    }
    if (dt > bounds.maxTapIntervalMs) {
      return { intervals: [], lastTapAt: now, accepted: true, ignored: false, reset: true };
    }
    intervals.push(dt / 1000);
    if (intervals.length > bounds.maxIntervals) {
      intervals = intervals.slice(-bounds.maxIntervals);
    }
    return { intervals: intervals, lastTapAt: now, accepted: true, ignored: false, reset: false };
  }

  function createSession(now) {
    return {
      sessionStartedAt: now,
      lastSignalAt: null,
      lastResponseAt: null,
      lastOkAt: null,
      attentionStartedAt: null,
      latchedCritical: false,
      latchReason: null,
      alarmSilenced: false
    };
  }

  function noteSignal(session, now) {
    return {
      sessionStartedAt: session.sessionStartedAt,
      lastSignalAt: now,
      lastResponseAt: now,
      lastOkAt: session.lastOkAt,
      attentionStartedAt: session.attentionStartedAt,
      latchedCritical: session.latchedCritical,
      latchReason: session.latchReason,
      alarmSilenced: session.alarmSilenced
    };
  }

  function msSinceSignal(input) {
    if (input.lastSignalAt == null) {
      return Math.max(0, input.now - input.sessionStartedAt);
    }
    return Math.max(0, input.now - input.lastSignalAt);
  }

  /**
   * One evaluation step. Does not latch.
   * Check-in starts immediately when BPM is in the caution band, or when
   * no breath/tap has arrived for inactivityMs. If that check-in is still
   * unanswered after unansweredMs, the level becomes critical.
   */
  function evaluateMonitor(input, limits) {
    var bounds = limits || LIMITS;
    var bpmLevel = levelFromBpm(input.bpm, bounds);
    var since = msSinceSignal(input);
    var inactive = since >= bounds.inactivityMs;
    var slow = bpmLevel === 'caution';
    var needsAttention;
    var attentionStartedAt;
    var clockStart;
    var waiting;

    if (bpmLevel === 'critical') {
      return {
        level: 'critical',
        reason: 'low-bpm',
        showCheckIn: false,
        chime: false,
        alarm: true,
        attentionStartedAt: input.attentionStartedAt,
        stale: inactive,
        msSinceSignal: since
      };
    }

    needsAttention = slow || inactive;
    if (!needsAttention) {
      return {
        level: bpmLevel === 'normal' ? 'normal' : 'listening',
        reason: bpmLevel === 'normal' ? 'stable' : 'no-data',
        showCheckIn: false,
        chime: false,
        alarm: false,
        attentionStartedAt: null,
        stale: false,
        msSinceSignal: since
      };
    }

    attentionStartedAt = input.attentionStartedAt == null ? input.now : input.attentionStartedAt;
    clockStart = attentionStartedAt;
    if (input.lastOkAt != null && input.lastOkAt >= attentionStartedAt) {
      clockStart = input.lastOkAt;
    }
    waiting = input.now - clockStart;

    if (waiting >= bounds.unansweredMs) {
      return {
        level: 'critical',
        reason: 'unanswered-checkin',
        showCheckIn: false,
        chime: false,
        alarm: true,
        attentionStartedAt: attentionStartedAt,
        stale: inactive,
        msSinceSignal: since
      };
    }

    return {
      level: 'caution',
      reason: slow ? 'slow-bpm' : 'inactivity',
      showCheckIn: true,
      chime: true,
      alarm: false,
      attentionStartedAt: attentionStartedAt,
      stale: inactive,
      msSinceSignal: since
    };
  }

  function viewFromEvaluation(evaluation, extras) {
    return {
      level: evaluation.level,
      reason: evaluation.reason,
      showCheckIn: extras.showDashboard ? false : evaluation.showCheckIn,
      showDashboard: extras.showDashboard,
      chime: extras.showDashboard ? false : evaluation.chime,
      alarm: extras.alarm,
      stale: evaluation.stale,
      msSinceSignal: evaluation.msSinceSignal
    };
  }

  /**
   * Apply latch policy on top of evaluateMonitor.
   * Critical stays up until the person responds. "I'm OK" silences the
   * alarm immediately. The dashboard stays if the rate is still under 8.
   * After they have responded, a later non-critical rate stands the
   * dashboard down.
   */
  function present(session, sample, limits) {
    var evaluation = evaluateMonitor({
      now: sample.now,
      bpm: sample.bpm,
      lastSignalAt: session.lastSignalAt,
      sessionStartedAt: session.sessionStartedAt,
      attentionStartedAt: session.attentionStartedAt,
      lastOkAt: session.lastOkAt
    }, limits);
    var recovered;
    var reason;
    var next;

    recovered = session.latchedCritical
      && session.alarmSilenced
      && evaluation.level !== 'critical'
      && typeof sample.bpm === 'number'
      && Number.isFinite(sample.bpm);

    if (recovered) {
      next = {
        sessionStartedAt: session.sessionStartedAt,
        lastSignalAt: session.lastSignalAt,
        lastResponseAt: session.lastResponseAt,
        lastOkAt: session.lastOkAt,
        attentionStartedAt: evaluation.attentionStartedAt,
        latchedCritical: false,
        latchReason: null,
        alarmSilenced: false
      };
      return { session: next, view: viewFromEvaluation(evaluation, { alarm: false, showDashboard: false }) };
    }

    if (evaluation.level === 'critical' || session.latchedCritical) {
      reason = evaluation.level === 'critical'
        ? evaluation.reason
        : (session.latchReason || evaluation.reason);
      next = {
        sessionStartedAt: session.sessionStartedAt,
        lastSignalAt: session.lastSignalAt,
        lastResponseAt: session.lastResponseAt,
        lastOkAt: session.lastOkAt,
        attentionStartedAt: session.attentionStartedAt,
        latchedCritical: true,
        latchReason: reason,
        alarmSilenced: session.alarmSilenced
      };
      return {
        session: next,
        view: {
          level: 'critical',
          reason: reason,
          showCheckIn: false,
          showDashboard: true,
          chime: false,
          alarm: !session.alarmSilenced,
          stale: evaluation.stale,
          msSinceSignal: evaluation.msSinceSignal
        }
      };
    }

    next = {
      sessionStartedAt: session.sessionStartedAt,
      lastSignalAt: session.lastSignalAt,
      lastResponseAt: session.lastResponseAt,
      lastOkAt: session.lastOkAt,
      attentionStartedAt: evaluation.attentionStartedAt,
      latchedCritical: false,
      latchReason: null,
      alarmSilenced: false
    };
    return { session: next, view: viewFromEvaluation(evaluation, { alarm: false, showDashboard: false }) };
  }

  /** Caution confirm and the critical "Silence / I'm OK" control. */
  function respondOk(session, sample, limits) {
    var responded = {
      sessionStartedAt: session.sessionStartedAt,
      lastSignalAt: sample.now,
      lastResponseAt: sample.now,
      lastOkAt: sample.now,
      attentionStartedAt: null,
      latchedCritical: false,
      latchReason: null,
      alarmSilenced: true
    };
    return present(responded, sample, limits);
  }

  function percentile(sorted, p) {
    var index;
    if (!sorted.length) return 0;
    index = Math.round((sorted.length - 1) * p);
    if (index < 0) index = 0;
    if (index > sorted.length - 1) index = sorted.length - 1;
    return sorted[index];
  }

  /**
   * 10s noise calibration. Samples are envelope levels, not audio.
   * Threshold sits above the quiet part of the recording and, when the
   * recording also contains louder breaths, below those peaks.
   */
  function calibrateNoise(samples) {
    var values = [];
    var i;
    var sorted;
    var noiseFloor;
    var loud;
    var spread;
    var threshold;
    var raised;
    if (samples && samples.length) {
      for (i = 0; i < samples.length; i += 1) {
        if (typeof samples[i] === 'number' && Number.isFinite(samples[i]) && samples[i] >= 0) {
          values.push(samples[i]);
        }
      }
    }
    if (!values.length) {
      return { noiseFloor: 0, threshold: 0.004, spread: 0, loud: 0 };
    }
    sorted = values.slice().sort(function (a, b) { return a - b; });
    noiseFloor = percentile(sorted, 0.2);
    loud = percentile(sorted, 0.95);
    spread = Math.max(0, loud - noiseFloor);
    threshold = noiseFloor + Math.max(0.004, noiseFloor * 0.75);
    if (spread > 0.02) {
      raised = noiseFloor + spread * 0.35;
      if (raised > threshold) threshold = raised;
    }
    return { noiseFloor: noiseFloor, threshold: threshold, spread: spread, loud: loud };
  }

  function confidenceScore(input) {
    var peaks = (input && input.recentPeakValues) ? input.recentPeakValues : [];
    var intervals = (input && input.intervals) ? input.intervals : [];
    var noiseFloor = input && input.noiseFloor ? input.noiseFloor : 0;
    var meanPeak;
    var snrScore;
    var regularity = 0.35;
    var mean;
    var variance;
    var i;
    var cv;
    var countScore;
    if (!peaks.length) return 0;
    meanPeak = average(peaks);
    if (noiseFloor <= 1e-8) {
      snrScore = meanPeak > 0 ? 1 : 0;
    } else {
      snrScore = clamp01((meanPeak / noiseFloor - 1.2) / 2.5);
    }
    if (intervals.length >= 2) {
      mean = average(intervals);
      variance = 0;
      for (i = 0; i < intervals.length; i += 1) {
        variance += (intervals[i] - mean) * (intervals[i] - mean);
      }
      variance /= intervals.length;
      cv = mean > 0 ? Math.sqrt(variance) / mean : 1;
      regularity = clamp01(1 - cv);
    }
    countScore = clamp01(peaks.length / 4);
    return clamp01(0.5 * snrScore + 0.35 * regularity + 0.15 * countScore);
  }

  function signalIsLow(input, limits) {
    var bounds = limits || LIMITS;
    if (!input || !input.calibrated) return false;
    return input.confidence < bounds.lowConfidence;
  }

  function calibrationProgress(elapsedMs, limits) {
    var total = (limits || LIMITS).calibrationMs;
    if (!(total > 0)) return 1;
    return clamp01(elapsedMs / total);
  }

  /**
   * Slow envelope so an inhale and the exhale that follows it become one
   * breath hump instead of two rates.
   */
  function smoothEnvelope(prev, value, dtMs, timing) {
    var attack = LIMITS.envelopeAttackMs;
    var release = LIMITS.envelopeReleaseMs;
    var tau;
    var dt;
    var alpha;
    var safePrev = typeof prev === 'number' && Number.isFinite(prev) ? prev : 0;
    var safeValue = typeof value === 'number' && Number.isFinite(value) ? value : 0;
    if (timing) {
      if (timing.attackMs != null) attack = timing.attackMs;
      if (timing.releaseMs != null) release = timing.releaseMs;
    }
    tau = safeValue >= safePrev ? attack : release;
    if (!(tau > 0)) return safeValue;
    dt = typeof dtMs === 'number' && dtMs > 0 ? dtMs : 0;
    alpha = 1 - Math.exp(-dt / tau);
    return safePrev + (safeValue - safePrev) * alpha;
  }

  function createBreathTracker(options) {
    var threshold = options.threshold;
    var noiseFloor = options.noiseFloor || 0;
    var minIntervalMs = options.minIntervalMs == null ? LIMITS.minBreathIntervalMs : options.minIntervalMs;
    var releaseRatio = options.releaseRatio == null ? 0.8 : options.releaseRatio;
    var above = false;
    var peakValue = 0;
    var peakTime = 0;
    var lastAccepted = null;
    var intervals = [];
    var peakValues = [];

    function snapshot(accepted) {
      return {
        accepted: accepted,
        intervals: intervals.slice(),
        recentPeakValues: peakValues.slice(),
        confidence: confidenceScore({
          noiseFloor: noiseFloor,
          recentPeakValues: peakValues,
          intervals: intervals
        }),
        lastPeakAt: lastAccepted,
        bpm: bpmFromIntervals(intervals)
      };
    }

    return {
      push: function (timeMs, value) {
        var release = threshold * releaseRatio;
        var accepted = false;
        if (!above) {
          if (value >= threshold) {
            above = true;
            peakValue = value;
            peakTime = timeMs;
          }
        } else if (value > peakValue) {
          peakValue = value;
          peakTime = timeMs;
        } else if (value <= release) {
          above = false;
          if (lastAccepted == null || peakTime - lastAccepted >= minIntervalMs) {
            if (lastAccepted != null) {
              intervals = intervals.concat([(peakTime - lastAccepted) / 1000]).slice(-LIMITS.maxIntervals);
            }
            lastAccepted = peakTime;
            peakValues = peakValues.concat([peakValue]).slice(-LIMITS.maxIntervals);
            accepted = true;
          }
        }
        return snapshot(accepted);
      }
    };
  }

  return {
    LIMITS: LIMITS,
    COPY: COPY,
    bpmFromIntervals: bpmFromIntervals,
    levelFromBpm: levelFromBpm,
    createTapState: createTapState,
    recordTap: recordTap,
    createSession: createSession,
    noteSignal: noteSignal,
    evaluateMonitor: evaluateMonitor,
    present: present,
    respondOk: respondOk,
    calibrateNoise: calibrateNoise,
    confidenceScore: confidenceScore,
    signalIsLow: signalIsLow,
    calibrationProgress: calibrationProgress,
    smoothEnvelope: smoothEnvelope,
    createBreathTracker: createBreathTracker
  };
});
