from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable

import numpy as np

SPEAKER_LABELS = ["話者A", "話者B", "話者C"]


@dataclass(slots=True)
class SpeakerPrototype:
    index: int
    centroid: np.ndarray
    count: int = 1


class SpeakerLabeler:
    def __init__(self, max_speakers: int = 3) -> None:
        self.max_speakers = max(1, min(3, max_speakers))
        self._moonshine_index_map: dict[int, int] = {}
        self._line_assignments: dict[int, int] = {}
        self._prototypes: list[SpeakerPrototype] = []
        self._last_index = 0

    def assign(
        self,
        line_id: int,
        audio_data: Iterable[float] | None,
        sample_rate: int = 16000,
        moonshine_speaker_index: int | None = None,
    ) -> tuple[str, int, str]:
        if moonshine_speaker_index is not None:
            mapped_index = self._moonshine_index_map.setdefault(
                moonshine_speaker_index,
                min(len(self._moonshine_index_map), self.max_speakers - 1),
            )
            self._line_assignments[line_id] = mapped_index
            self._last_index = mapped_index
            return SPEAKER_LABELS[mapped_index], mapped_index, "moonshine"

        if line_id in self._line_assignments:
            idx = self._line_assignments[line_id]
            return SPEAKER_LABELS[idx], idx, "carry-forward"

        feature = self._extract_features(audio_data, sample_rate)
        if feature is None:
            idx = self._last_index
            self._line_assignments[line_id] = idx
            return SPEAKER_LABELS[idx], idx, "carry-forward"

        if not self._prototypes:
            self._prototypes.append(SpeakerPrototype(index=0, centroid=feature))
            self._line_assignments[line_id] = 0
            self._last_index = 0
            return SPEAKER_LABELS[0], 0, "feature-fallback"

        best_index = 0
        best_distance = float("inf")
        for prototype in self._prototypes:
            centroid = prototype.centroid
            cosine = 1.0 - float(
                np.dot(feature, centroid)
                / ((np.linalg.norm(feature) * np.linalg.norm(centroid)) + 1e-8)
            )
            euclidean = float(np.linalg.norm(feature - centroid))
            distance = cosine + (0.18 * euclidean)
            if distance < best_distance:
                best_distance = distance
                best_index = prototype.index

        if best_distance > 0.9 and len(self._prototypes) < self.max_speakers:
            best_index = len(self._prototypes)
            self._prototypes.append(
                SpeakerPrototype(index=best_index, centroid=feature.copy())
            )
        else:
            prototype = next(item for item in self._prototypes if item.index == best_index)
            prototype.centroid = (
                (prototype.centroid * prototype.count) + feature
            ) / (prototype.count + 1)
            prototype.count += 1

        self._line_assignments[line_id] = best_index
        self._last_index = best_index
        return SPEAKER_LABELS[best_index], best_index, "feature-fallback"

    def _extract_features(
        self, audio_data: Iterable[float] | None, sample_rate: int
    ) -> np.ndarray | None:
        if audio_data is None:
            return None

        samples = np.asarray(list(audio_data), dtype=np.float32)
        if samples.size < int(sample_rate * 0.15):
            return None

        peak = float(np.max(np.abs(samples)))
        if peak > 0:
            samples = samples / peak

        frame_size = min(1024, max(256, int(sample_rate * 0.032)))
        hop_size = max(128, frame_size // 2)
        if samples.size < frame_size:
            return None

        frame_count = 1 + (samples.size - frame_size) // hop_size
        window = np.hanning(frame_size).astype(np.float32)
        freqs = np.fft.rfftfreq(frame_size, d=1.0 / sample_rate)

        energies: list[float] = []
        zcrs: list[float] = []
        centroids: list[float] = []
        bandwidths: list[float] = []
        rolloffs: list[float] = []
        flatnesses: list[float] = []
        band_profiles: list[np.ndarray] = []

        for frame_index in range(frame_count):
            start = frame_index * hop_size
            frame = samples[start : start + frame_size]
            if frame.size < frame_size:
                break

            energies.append(float(np.mean(frame**2)))
            zcrs.append(float(np.mean(np.abs(np.diff(np.signbit(frame))))))

            spectrum = np.abs(np.fft.rfft(frame * window)) + 1e-8
            power = spectrum**2
            total_power = float(np.sum(power))
            if total_power <= 0:
                continue

            centroid = float(np.sum(freqs * power) / total_power)
            bandwidth = float(
                np.sqrt(np.sum(((freqs - centroid) ** 2) * power) / total_power)
            )
            cumulative = np.cumsum(power)
            rolloff_index = int(np.searchsorted(cumulative, 0.85 * cumulative[-1]))
            rolloff = float(freqs[min(rolloff_index, len(freqs) - 1)])
            flatness = float(np.exp(np.mean(np.log(spectrum))) / np.mean(spectrum))

            centroids.append(centroid)
            bandwidths.append(bandwidth)
            rolloffs.append(rolloff)
            flatnesses.append(flatness)

            split_bands = np.array_split(power, 10)
            band_profiles.append(
                np.array([float(np.mean(band)) for band in split_bands], dtype=np.float32)
            )

        if not centroids or not band_profiles:
            return None

        stats = np.array(
            [
                np.mean(energies),
                np.std(energies),
                np.mean(zcrs),
                np.std(zcrs),
                np.mean(centroids),
                np.std(centroids),
                np.mean(bandwidths),
                np.std(bandwidths),
                np.mean(rolloffs),
                np.std(rolloffs),
                np.mean(flatnesses),
                np.std(flatnesses),
            ],
            dtype=np.float32,
        )
        band_profile = np.mean(np.stack(band_profiles), axis=0).astype(np.float32)
        feature = np.concatenate([stats, np.log1p(band_profile)])

        norm = float(np.linalg.norm(feature))
        if norm <= 1e-8:
            return None
        return feature / norm

