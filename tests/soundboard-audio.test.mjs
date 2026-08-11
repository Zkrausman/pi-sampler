import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const audioModulePath = join(repositoryRoot, "src", "components", "soundboardAudio.ts");

async function loadAudioModule(cacheKey = "") {
  const source = readFileSync(audioModulePath, "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: audioModulePath,
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}#${cacheKey}`);
}

function createMockContext() {
  const sounds = [];
  const destination = {};

  return {
    currentTime: 4,
    destination,
    sounds,
    createOscillator() {
      const record = { frequency: [], type: null, startedAt: null, stoppedAt: null, connectedTo: null, disconnected: false };
      sounds.push(record);
      return {
        get type() { return record.type; },
        set type(value) { record.type = value; },
        frequency: { setValueAtTime: (...call) => record.frequency.push(call) },
        connect: (node) => { record.connectedTo = node; },
        disconnect: () => { record.disconnected = true; },
        start: (time) => { record.startedAt = time; },
        stop: (time) => { record.stoppedAt = time; },
        onended: null,
      };
    },
    createGain() {
      const gainCalls = [];
      return {
        gain: {
          cancelScheduledValues: (...call) => gainCalls.push(["cancel", ...call]),
          setValueAtTime: (...call) => gainCalls.push(["set", ...call]),
          linearRampToValueAtTime: (...call) => gainCalls.push(["linear", ...call]),
          exponentialRampToValueAtTime: (...call) => gainCalls.push(["exponential", ...call]),
        },
        connect: (node) => {
          assert.equal(node, destination);
          sounds.at(-1).gainCalls = gainCalls;
        },
        disconnect: () => {},
      };
    },
  };
}

test("defines exactly four distinct generated sounds", async () => {
  const { SOUND_DEFINITIONS } = await loadAudioModule("definitions");

  assert.equal(SOUND_DEFINITIONS.length, 4);
  assert.equal(new Set(SOUND_DEFINITIONS.map((sound) => sound.id)).size, 4);
  assert.equal(new Set(SOUND_DEFINITIONS.map((sound) => sound.label)).size, 4);
  assert.equal(new Set(SOUND_DEFINITIONS.map((sound) => sound.oscillatorType)).size, 4);
  assert.equal(new Set(SOUND_DEFINITIONS.map((sound) => `${sound.frequency}/${sound.duration}/${sound.attack}/${sound.release}`)).size, 4);
});

test("schedules a distinct oscillator and gain envelope for every sound", async () => {
  const { SOUND_DEFINITIONS, scheduleSound } = await loadAudioModule("scheduling");
  const context = createMockContext();

  for (const sound of SOUND_DEFINITIONS) scheduleSound(context, sound);

  assert.equal(context.sounds.length, 4);
  for (const [index, sound] of SOUND_DEFINITIONS.entries()) {
    const scheduled = context.sounds[index];
    const startAt = context.currentTime;
    const releaseAt = startAt + sound.duration - sound.release;
    const endAt = startAt + sound.duration;

    assert.equal(scheduled.type, sound.oscillatorType);
    assert.deepEqual(scheduled.frequency, [[sound.frequency, startAt]]);
    assert.equal(scheduled.startedAt, startAt);
    assert.equal(scheduled.stoppedAt, endAt);
    assert.deepEqual(scheduled.gainCalls, [
      ["cancel", startAt],
      ["set", 0.0001, startAt],
      ["linear", sound.peakGain, startAt + sound.attack],
      ["set", sound.peakGain, releaseAt],
      ["exponential", 0.0001, endAt],
    ]);
  }
});

test("does not construct browser audio until explicitly requested", async () => {
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  let constructions = 0;
  class FakeAudioContext {
    constructor() { constructions += 1; }
  }

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { AudioContext: FakeAudioContext },
  });
  try {
    const { createBrowserAudioContext } = await loadAudioModule("lazy-context");
    assert.equal(constructions, 0);
    assert.ok(createBrowserAudioContext() instanceof FakeAudioContext);
    assert.equal(constructions, 1);
  } finally {
    if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor);
    else delete globalThis.window;
  }
});

test("Soundboard uses local layout primitives and communicates audio failures", () => {
  const component = readFileSync(join(repositoryRoot, "src", "components", "Soundboard.tsx"), "utf8");

  assert.match(component, /import \{ Box, Flex, Grid \} from "\.\.\/ui\/ThemeProvider"/);
  assert.match(component, /gridTemplateColumns: "repeat\(2, minmax\(0, 1fr\)\)"/);
  assert.match(component, /role="status"/);
  assert.match(component, /aria-live="polite"/);
  assert.match(component, /Audio is unavailable in this browser\./);
  assert.match(component, /Audio could not start\. Check your browser audio permissions\./);
});
