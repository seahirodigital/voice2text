import { useEffect, useRef } from "react";

interface WaveformCanvasProps {
  samples: number[];
  status: "idle" | "recording" | "paused" | "saving" | "connecting" | "error";
}

export function WaveformCanvas({ samples, status }: WaveformCanvasProps) {
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

    const { width, height } = canvas;
    context.clearRect(0, 0, width, height);

    const bars = 48;
    const step = Math.max(1, Math.floor(samples.length / bars));
    const baseColor =
      status === "recording"
        ? "rgba(0, 113, 227, 0.95)"
        : status === "paused"
          ? "rgba(29, 29, 31, 0.28)"
          : "rgba(29, 29, 31, 0.14)";

    context.fillStyle = "rgba(255,255,255,0.85)";
    context.fillRect(0, 0, width, height);

    for (let index = 0; index < bars; index += 1) {
      const start = index * step;
      const chunk = samples.slice(start, start + step);
      const average =
        chunk.length === 0
          ? 0
          : chunk.reduce((sum, value) => sum + Math.abs(value), 0) / chunk.length;
      const barHeight = Math.max(12, average * height * 1.9);
      const x = (width / bars) * index + 2;
      const y = (height - barHeight) / 2;
      const w = width / bars - 6;

      context.fillStyle = baseColor;
      context.beginPath();
      context.roundRect(x, y, w, barHeight, 999);
      context.fill();
    }
  }, [samples, status]);

  return (
    <canvas
      ref={canvasRef}
      width={880}
      height={180}
      className="h-[180px] w-full rounded-[28px] bg-white/80"
    />
  );
}
