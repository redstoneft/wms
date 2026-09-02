// Audible + haptic feedback for warehouse mode. Pure WebAudio, no assets.
//  - OK    : one short high beep
//  - ERROR : two long low beeps
//  - WARN  : one medium beep

let ctx: AudioContext | null = null;

function audio(): AudioContext | null {
  try {
    if (!ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return null;
      ctx = new Ctor();
    }
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

function tone(freq: number, durationMs: number, startOffsetMs = 0, type: OscillatorType = 'square', gain = 0.15) {
  const ac = audio();
  if (!ac) return;
  const osc = ac.createOscillator();
  const g = ac.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  g.gain.value = gain;
  osc.connect(g);
  g.connect(ac.destination);
  const t0 = ac.currentTime + startOffsetMs / 1000;
  osc.start(t0);
  g.gain.setValueAtTime(gain, t0);
  g.gain.exponentialRampToValueAtTime(0.001, t0 + durationMs / 1000);
  osc.stop(t0 + durationMs / 1000 + 0.02);
}

function vibrate(pattern: number | number[]) {
  try {
    if ('vibrate' in navigator) navigator.vibrate(pattern);
  } catch {
    /* ignore */
  }
}

export const feedback = {
  /** Unlock audio on first user gesture (mobile browsers). */
  prime() {
    audio();
  },
  ok() {
    tone(1600, 90);
    vibrate(40);
  },
  warn() {
    tone(900, 180, 0, 'triangle');
    vibrate([60, 40, 60]);
  },
  error() {
    tone(220, 350, 0, 'sawtooth', 0.2);
    tone(220, 350, 420, 'sawtooth', 0.2);
    vibrate([200, 100, 200]);
  },
  tick() {
    tone(1200, 40, 0, 'sine', 0.08);
  },
};
