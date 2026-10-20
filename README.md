# Breathwatch

Privacy-first harm-reduction breathing check. It runs as a static site from the repository root, including on GitHub Pages. There is no build step.

Breathwatch is a prototype. It is **not a medical device**. It cannot call for help.

## Use it

1. Serve the folder over HTTP (GitHub Pages, or any static server) and open `index.html`. The microphone and the screen wake lock need a secure page (`https://` or `localhost`).
2. Read the start screen. **Never use alone.** Call Never Use Alone at **1-800-484-3731** so a person can stay on the phone with you.
3. Tap **Start and stay here**. That same tap starts audio (so a later alarm is allowed to play) and asks the browser to keep the screen awake. Leave the page in the foreground with the screen on. If you switch away and come back, it asks for the wake lock again.
4. **Tap mode.** Tap the screen once per breath. After a few taps the rate is `60 / mean of the last 4 to 6 intervals`. Example: taps 5 seconds apart are 12 breaths/min. The phone vibrates on a tap when the browser allows it.
5. **Mic mode.** The microphone is band-limited to roughly 100–1000 Hz. For 10 seconds the page learns the room’s noise floor, then looks for breath-shaped peaks in a loudness envelope. A confidence number and a live waveform/glow show whether it is hearing you. If the signal is weak it says: “Signal low — consider moving closer or switching to Tap Mode.” Leaving Mic mode stops the microphone.
6. **Normal** is 12 breaths/min or more (calm green/blue). **Caution** is 8 up to 12: the screen pulses yellow, a soft chime repeats, and it asks “Are you OK? Tap to confirm”. **Critical** is under 8, or a check-in that goes unanswered: high-contrast red flash and a loud oscillator alarm.
7. If no breath or tap arrives for about 20 seconds, the check-in appears. If that goes unanswered for about 15 seconds, it becomes critical. Critical stays up until you press **Silence / I'm OK**. If the rate is still under 8, the alarm goes quiet but the emergency screen stays.
8. The critical screen shows the current or last rate, how long since the last breath, tap, or check-in, **Call 911**, **Never Use Alone**, naloxone nasal-spray steps, and recovery-position steps with a diagram. All of that text is in the page, so it works offline. The phone buttons only open the dialer. The app never places the call itself.

People who prefer reduced motion get a solid red critical screen instead of flashing.

## Run the tests

```bash
node test/logic.test.js
```

The tests cover the BPM formula, tap filtering, caution and critical thresholds, the 20s / 15s escalation, the “I’m OK” latch, noise-floor calibration, and breath-cycle detection (an inhale plus an exhale counts as one breath). They also check that the page keeps the emergency copy, relative URLs, and the privacy limits below.

## Privacy

- No accounts, no analytics, and no network calls from the page after it loads.
- No `localStorage`, `sessionStorage`, or `indexedDB`. Refreshing the page clears the session, including a running alarm.
- Microphone audio is analyzed in memory. The page keeps the current audio frame, a short loudness trace for the 10 second calibration (then throws it away), and the recent breath timings. It does not record a file and it does not upload anything.
- The service worker caches the app shell (HTML, CSS, JS, manifest, icons) so a later visit works offline. It does not cache microphone audio.
- `tel:` links run only when you press them.

## Limitations

- This cannot replace a person, naloxone, rescue breathing, or calling 911. It cannot detect an overdose. A quiet room, a pocket, or a bad microphone can miss breaths or invent them.
- Mic mode is a rough envelope follower. It is meant for slow breathing. Bursts closer than about 2 seconds are treated as one cycle, so very fast breathing can be under-counted. Trust Tap mode if the confidence stays low.
- The alarm and the timer only keep working while the page is in the foreground and the screen is on. Browsers suspend audio and timers in the background. The wake lock is a request; the browser can refuse it.
- Rates and cutoffs (12 and 8 breaths/min, 20 seconds, 15 seconds) are simple prototype rules, not a clinical standard.
- Naloxone and recovery-position text is general public information, not personal medical advice.

## GitHub Pages

Put the repository root on Pages (`main`, folder `/`). `.nojekyll` is included so the files are served as-is. Paths are relative, so a project site in a subpath works without a build.
