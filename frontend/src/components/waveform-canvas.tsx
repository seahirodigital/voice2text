import { useEffect, useRef } from "react";

import { cn } from "../lib/utils";
import type { RecordingStatus } from "../types";

interface WaveformCanvasProps {
  samples: number[];
  status: RecordingStatus;
  className?: string;
  width?: number;
  height?: number;
  background?: string;
}

export function WaveformCanvas({
  samples,
  status,
  className,
  width = 880,
  height = 180,
  background = "rgba(255,255,255,0.88)",
}: WaveformCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const context = canvas.getContext("2d");
    if (!context) {
      return;
    }

    const { width: canvasWidth, height: canvasHeight } = canvas;
    context.clearRect(0, 0, canvasWidth, canvasHeight);

    const bars = 48;
    const step = Math.max(1, Math.floor(samples.length / bars));
    const baseColor =
      status === "recording"
        ? "rgba(0, 113, 227, 0.95)"
        : status === "paused"
          ? "rgba(29, 29, 31, 0.28)"
          : status === "error"
            ? "rgba(225, 29, 72, 0.68)"
            : "rgba(29, 29, 31, 0.14)";

    context.fillStyle = background;
    context.fillRect(0, 0, canvasWidth, canvasHeight);

    for (let index = 0; index < bars; index += 1) {
      const start = index * step;
      const chunk = samples.slice(start, start + step);
      const average =
        chunk.length === 0
          ? 0
          : chunk.reduce((sum, value) => sum + Math.abs(value), 0) / chunk.length;
      const barHeight = Math.max(
        Math.max(4, canvasHeight * 0.16),
        average * canvasHeight * 1.9,
      );
      const x = (canvasWidth / bars) * index + 2;
      const y = (canvasHeight - barHeight) / 2;
      const w = canvasWidth / bars - 6;

      context.fillStyle = baseColor;
      context.beginPath();
      context.roundRect(x, y, w, barHeight, 999);
      context.fill();
    }
  }, [background, height, samples, status, width]);

  return (
    <canvas
      ref={canvasRef}
      width={width}
      height={height}
      className={cn("h-[180px] w-full rounded-[28px] bg-white/80", className)}
    />
  );
}
