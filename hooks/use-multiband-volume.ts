"use client";

import { useEffect, useMemo, useRef, useState } from "react";

/**
 * Extracts per-band frequency volume from a MediaStream using the Web Audio API.
 *
 * Returns an array of `bands` normalized values (0..1) representing the volume
 * in each frequency band. Returns all zeros when the stream is null or has
 * no audio tracks.
 */
export function useMultibandVolume(
  mediaStream: MediaStream | null,
  bands: number,
): number[] {
  const zeroVolumes = useMemo(() => new Array(bands).fill(0), [bands]);
  const [volumes, setVolumes] = useState<number[]>(zeroVolumes);

  const contextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!mediaStream) {
      return;
    }

    let cancelled = false;

    function setup(stream: MediaStream) {
      if (cancelled) return;

      // Need at least one audio track
      if (stream.getAudioTracks().length === 0) return;

      const ctx = new AudioContext();
      // Chrome suspends new AudioContexts until user interaction.
      // By the time we get here the user has already clicked "Start Briefing",
      // so resume() will succeed and unlock the context for analysis.
      void ctx.resume();

      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.4;

      const source = ctx.createMediaStreamSource(stream);
      source.connect(analyser);

      contextRef.current = ctx;
      analyserRef.current = analyser;
      sourceRef.current = source;

      const freqData = new Float32Array(analyser.frequencyBinCount);

      intervalRef.current = setInterval(() => {
        if (cancelled) return;

        analyser.getFloatFrequencyData(freqData);

        const binCount = freqData.length;
        const binsPerBand = Math.floor(binCount / bands);
        const result: number[] = [];

        for (let b = 0; b < bands; b++) {
          const start = b * binsPerBand;
          const end =
            b === bands - 1 ? binCount : start + binsPerBand;

          let sum = 0;
          for (let i = start; i < end; i++) {
            // freqData values are in dB, typically -100 to 0
            // Normalize to 0..1
            const normalized = (freqData[i] + 100) / 100;
            sum += Math.max(0, Math.min(1, normalized));
          }
          result.push(sum / (end - start));
        }

        setVolumes(result);
      }, 32);
    }

    // If the stream already has audio tracks, set up immediately
    if (mediaStream.getAudioTracks().length > 0) {
      setup(mediaStream);
    }

    // Listen for tracks being added (deferred track attachment)
    const handleAddTrack = (event: MediaStreamTrackEvent) => {
      if (event.track.kind === "audio" && !contextRef.current) {
        setup(mediaStream);
      }
    };

    mediaStream.addEventListener("addtrack", handleAddTrack);

    return () => {
      cancelled = true;
      mediaStream.removeEventListener("addtrack", handleAddTrack);

      if (intervalRef.current !== null) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      if (sourceRef.current) {
        sourceRef.current.disconnect();
        sourceRef.current = null;
      }
      if (analyserRef.current) {
        analyserRef.current = null;
      }
      if (contextRef.current) {
        void contextRef.current.close();
        contextRef.current = null;
      }

    };
  }, [mediaStream, bands]);

  return mediaStream && volumes.length === bands ? volumes : zeroVolumes;
}
