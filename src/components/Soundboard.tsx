import { useEffect, useRef, useState } from "react";
import { Box, Flex, Grid } from "../ui/ThemeProvider";
import {
  SOUND_DEFINITIONS,
  createBrowserAudioContext,
  scheduleSound,
  type SoundDefinition,
} from "./soundboardAudio";
import "./Soundboard.css";

type AudioMessage = "" | "Audio is unavailable in this browser." | "Audio could not start. Check your browser audio permissions.";

export function Soundboard() {
  const audioContextRef = useRef<AudioContext | null>(null);
  const [audioMessage, setAudioMessage] = useState<AudioMessage>("");

  useEffect(() => () => {
    const audioContext = audioContextRef.current;
    if (audioContext && audioContext.state !== "closed") void audioContext.close();
  }, []);

  async function playSound(sound: SoundDefinition) {
    let audioContext = audioContextRef.current;
    if (!audioContext || audioContext.state === "closed") {
      audioContext = createBrowserAudioContext();
      if (!audioContext) {
        setAudioMessage("Audio is unavailable in this browser.");
        return;
      }
      audioContextRef.current = audioContext;
    }

    try {
      if (audioContext.state === "suspended") await audioContext.resume();
      scheduleSound(audioContext, sound);
      setAudioMessage("");
    } catch {
      setAudioMessage("Audio could not start. Check your browser audio permissions.");
    }
  }

  return (
    <Box className="soundboard" aria-labelledby="soundboard-title">
      <Flex className="soundboard__heading" style={{ alignItems: "baseline", justifyContent: "space-between" }}>
        <Box>
          <h2 id="soundboard-title">Soundboard</h2>
          <p>Four locally generated sounds.</p>
        </Box>
      </Flex>
      <p className="soundboard__status" id="soundboard-audio-status" role="status" aria-live="polite">
        {audioMessage}
      </p>
      <Grid className="soundboard__grid" style={{ gridTemplateColumns: "repeat(2, minmax(0, 1fr))" }}>
        {SOUND_DEFINITIONS.map((sound) => (
          <button
            aria-describedby="soundboard-audio-status"
            className="soundboard__button"
            key={sound.id}
            onClick={() => void playSound(sound)}
            type="button"
          >
            <span className="soundboard__button-label">{sound.label}</span>
            <span className="soundboard__button-description">{sound.description}</span>
          </button>
        ))}
      </Grid>
    </Box>
  );
}
