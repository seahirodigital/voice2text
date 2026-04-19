import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

import type { TranscriptSegment } from "../types";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatClock(seconds: number) {
  const total = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(total / 60)
    .toString()
    .padStart(2, "0");
  const secs = (total % 60).toString().padStart(2, "0");
  return `${minutes}:${secs}`;
}

export function transcriptToPlainText(segments: TranscriptSegment[]) {
  return segments
    .slice()
    .sort((left, right) => left.startedAt - right.startedAt)
    .map(
      (segment) =>
        `[${formatClock(segment.startedAt)}] ${segment.speakerLabel}: ${segment.text}`,
    )
    .join("\n");
}

