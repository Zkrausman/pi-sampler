export type SoundDefinition = Readonly<{
  id: string;
  label: string;
  description: string;
  oscillatorType: OscillatorType;
  frequency: number;
  duration: number;
  attack: number;
  release: number;
  peakGain: number;
}>;

/** The complete local sound library. No sound files or network resources are used. */
export const SOUND_DEFINITIONS: readonly SoundDefinition[] = [
  {
    id: "chime",
    label: "Chime",
    description: "A bright rising notification tone.",
    oscillatorType: "sine",
    frequency: 523.25,
    duration: 0.55,
    attack: 0.01,
    release: 0.42,
    peakGain: 0.24,
  },
  {
    id: "pop",
    label: "Pop",
    description: "A short, soft confirmation pop.",
    oscillatorType: "triangle",
    frequency: 180,
    duration: 0.18,
    attack: 0.005,
    release: 0.14,
    peakGain: 0.18,
  },
  {
    id: "pulse",
    label: "Pulse",
    description: "A compact low pulse.",
    oscillatorType: "square",
    frequency: 110,
    duration: 0.28,
    attack: 0.01,
    release: 0.2,
    peakGain: 0.08,
  },
  {
    id: "sparkle",
    label: "Sparkle",
    description: "A crisp, energetic sparkle.",
    oscillatorType: "sawtooth",
    frequency: 880,
    duration: 0.38,
    attack: 0.008,
    release: 0.29,
    peakGain: 0.09,
  },
];

type SchedulableAudioContext = Pick<AudioContext, "currentTime" | "destination" | "createGain" | "createOscillator">;

/**
 * Creates an AudioContext only in response to a browser interaction. Keeping
 * construction here prevents SSR and module evaluation from touching audio.
 */
export function createBrowserAudioContext(): AudioContext | null {
  if (typeof window === "undefined" || typeof window.AudioContext !== "function") return null;

  try {
    return new window.AudioContext();
  } catch {
    return null;
  }
}

/**
 * Adds this sound's oscillator and gain envelope to the Web Audio timeline.
 * Scheduling is asynchronous in the audio engine, so overlapping clicks never
 * wait for a preceding sound to finish on the main thread.
 */
export function scheduleSound(context: SchedulableAudioContext, sound: SoundDefinition): void {
  const startedAt = context.currentTime;
  const releaseStartsAt = startedAt + sound.duration - sound.release;
  const endsAt = startedAt + sound.duration;
  const oscillator = context.createOscillator();
  const gain = context.createGain();

  oscillator.type = sound.oscillatorType;
  oscillator.frequency.setValueAtTime(sound.frequency, startedAt);
  gain.gain.cancelScheduledValues(startedAt);
  gain.gain.setValueAtTime(0.0001, startedAt);
  gain.gain.linearRampToValueAtTime(sound.peakGain, startedAt + sound.attack);
  gain.gain.setValueAtTime(sound.peakGain, releaseStartsAt);
  gain.gain.exponentialRampToValueAtTime(0.0001, endsAt);

  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.onended = () => {
    oscillator.disconnect();
    gain.disconnect();
  };
  oscillator.start(startedAt);
  oscillator.stop(endsAt);
}
