import { AnimatePresence, motion } from "framer-motion";
import {
  AudioLines,
  Check,
  CirclePause,
  Copy,
  Download,
  FolderOpen,
  LoaderCircle,
  Mic,
  MicOff,
  RefreshCcw,
  Save,
  Search,
  Settings2,
  Share2,
  SlidersHorizontal,
  Trash2,
  X,
} from "lucide-react";
import {
  startTransition,
  useDeferredValue,
  useEffect,
  useRef,
  useState,
} from "react";

import { WaveformCanvas } from "./components/waveform-canvas";
import { Button } from "./components/ui/button";
import { formatClock, transcriptToPlainText } from "./lib/utils";
import type {
  AppSettings,
  MetaResponse,
  RecordingStatus,
  SessionDetail,
  SessionSummary,
  SettingsResponse,
  SocketMessage,
  TranscriptSegment,
} from "./types";

const EMPTY_WAVEFORM = Array.from({ length: 96 }, () => 0);
const LIVE_RECORD_ID = "__live__";

const LANGUAGE_LABELS: Record<string, string> = {
  ja: "Japanese",
  en: "English",
  es: "Spanish",
  ko: "Korean",
  zh: "Chinese",
  vi: "Vietnamese",
  uk: "Ukrainian",
  ar: "Arabic",
};

const STATUS_LABELS: Record<RecordingStatus, string> = {
  idle: "Ready",
  connecting: "Connecting",
  recording: "Recording",
  paused: "Paused",
  saving: "Saving",
  error: "Error",
};

const STATUS_HINTS: Record<RecordingStatus, string> = {
  idle: "The workspace is ready for a new capture.",
  connecting: "Opening the local microphone stream and websocket.",
  recording: "The transcript is updating in real time from the live input.",
  paused: "Capture is paused. Resume or stop to save the record.",
  saving: "Finalizing the local audio and session metadata.",
  error: "The last capture failed. Check the message and retry.",
};

const SPEAKER_SOURCE_LABELS: Record<string, string> = {
  moonshine: "Moonshine",
  "feature-fallback": "Feature fallback",
  "carry-forward": "Carry forward",
};

interface RecordView {
  id: string;
  title: string;
  createdAt: string;
  language: string;
  deviceLabel: string;
  durationSeconds: number;
  lineCount: number;
  audioUrl?: string | null;
  summary: string;
  badgeLabel: string;
  kind: "history" | "live";
}

function buildSocketUrl() {
  const url = new URL("/ws/transcribe", window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

async function apiFetch<T>(path: string, init?: RequestInit) {
  try {
    const response = await fetch(path, {
      headers: {
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
      ...init,
    });
    if (!response.ok) {
      const message = await response.text();
      throw new Error(message || `Request failed: ${path}`);
    }
    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof Error && error.message === "Failed to fetch") {
      throw new Error(
        `Unable to reach ${path}. Check that the backend and dev server are both running.`,
      );
    }
    throw error;
  }
}

function sortSegments(segments: TranscriptSegment[]) {
  return [...segments].sort((left, right) => left.startedAt - right.startedAt);
}

function mergeIncomingSegment(
  current: TranscriptSegment[],
  incoming: TranscriptSegment,
  dirtyIds: Set<string>,
) {
  const existingIndex = current.findIndex((segment) => segment.id === incoming.id);
  if (existingIndex === -1) {
    return sortSegments([...current, incoming]);
  }

  const existing = current[existingIndex];
  const next = [...current];
  next[existingIndex] = dirtyIds.has(incoming.id)
    ? { ...incoming, text: existing.text }
    : incoming;
  return sortSegments(next);
}

function toInt16Pcm(input: Float32Array) {
  const pcm = new Int16Array(input.length);
  for (let index = 0; index < input.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, input[index]));
    pcm[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return pcm;
}

function toHistoryRecord(session: SessionSummary): RecordView {
  return {
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    language: session.language,
    deviceLabel: session.deviceLabel,
    durationSeconds: session.durationSeconds,
    lineCount: session.lineCount,
    audioUrl: session.audioUrl ?? null,
    summary: session.deviceLabel,
    badgeLabel: "Completed",
    kind: "history",
  };
}

function parseDate(value?: string | null) {
  if (!value) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatRecordDate(value?: string | null) {
  const parsed = parseDate(value);
  if (!parsed) {
    return "NOW";
  }
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "2-digit",
  })
    .format(parsed)
    .toUpperCase();
}

function formatHeaderDate(value?: string | null) {
  const parsed = parseDate(value);
  if (!parsed) {
    return "No date";
  }
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(parsed);
}

function formatLongClock(seconds: number) {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600)
    .toString()
    .padStart(2, "0");
  const minutes = Math.floor((total % 3600) / 60)
    .toString()
    .padStart(2, "0");
  const secs = (total % 60).toString().padStart(2, "0");
  return `${hours}:${minutes}:${secs}`;
}

function formatRangeClock(startedAt: number, duration: number) {
  return `${formatLongClock(startedAt)} - ${formatLongClock(startedAt + duration)}`;
}

function formatRecordLength(seconds: number) {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours > 0 && minutes > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (hours > 0) {
    return `${hours}h`;
  }
  if (minutes > 0) {
    return `${minutes}m`;
  }
  return total > 0 ? "<1m" : "0m";
}

function formatReference(id?: string | null) {
  return `REF: ${(id ?? "live").slice(0, 10).toUpperCase()}`;
}

function sanitizeFilename(value: string) {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "transcript"
  );
}

function recordMatchesFilter(record: RecordView, filterText: string) {
  const query = filterText.trim().toLowerCase();
  if (!query) {
    return true;
  }
  const haystack = [
    record.title,
    record.language,
    record.deviceLabel,
    record.summary,
    formatRecordDate(record.createdAt),
  ]
    .join(" ")
    .toLowerCase();
  return haystack.includes(query);
}

function App() {
  const [settingsResponse, setSettingsResponse] = useState<SettingsResponse | null>(
    null,
  );
  const [draftSettings, setDraftSettings] = useState<AppSettings | null>(null);
  const [meta, setMeta] = useState<MetaResponse | null>(null);
  const [history, setHistory] = useState<SessionSummary[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [timelineSegments, setTimelineSegments] = useState<TranscriptSegment[]>([]);
  const [currentAudioUrl, setCurrentAudioUrl] = useState<string | null>(null);
  const [deviceId, setDeviceId] = useState("");
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [status, setStatus] = useState<RecordingStatus>("idle");
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [waveform, setWaveform] = useState<number[]>(EMPTY_WAVEFORM);
  const [savingSettings, setSavingSettings] = useState(false);
  const [copied, setCopied] = useState(false);
  const [editVersion, setEditVersion] = useState(0);
  const [recordFilter, setRecordFilter] = useState("");
  const [historySortOrder, setHistorySortOrder] = useState<"newest" | "oldest">(
    "newest",
  );
  const [recordsOpen, setRecordsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [liveSessionStartedAt, setLiveSessionStartedAt] = useState<string | null>(
    null,
  );

  const deferredSegments = useDeferredValue(timelineSegments);

  const wsRef = useRef<WebSocket | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const analyserNodeRef = useRef<AnalyserNode | null>(null);
  const processorNodeRef = useRef<ScriptProcessorNode | null>(null);
  const sinkNodeRef = useRef<GainNode | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const bootstrapRetryTimeoutRef = useRef<number | null>(null);
  const connectTimeoutRef = useRef<number | null>(null);
  const bootstrapInFlightRef = useRef(false);
  const dirtySegmentIdsRef = useRef<Set<string>>(new Set());
  const timelineSegmentsRef = useRef<TranscriptSegment[]>([]);
  const statusRef = useRef<RecordingStatus>("idle");
  const isLiveSessionRef = useRef(false);
  const bootstrapApplicationRef = useRef<() => Promise<void>>(async () => {});
  const refreshDevicesRef = useRef<() => Promise<void>>(async () => {});
  const teardownAudioRef = useRef<() => Promise<void>>(async () => {});
  const closeSocketRef = useRef<() => void>(() => {});
  const persistTranscriptRef = useRef<
    (sessionId: string, segments: TranscriptSegment[]) => Promise<void>
  >(async () => {});

  useEffect(() => {
    timelineSegmentsRef.current = timelineSegments;
  }, [timelineSegments]);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  const refreshDevices = async () => {
    if (!navigator.mediaDevices?.enumerateDevices) {
      return;
    }

    const availableDevices = await navigator.mediaDevices.enumerateDevices();
    const audioInputs = availableDevices.filter(
      (device) => device.kind === "audioinput",
    );
    setDevices(audioInputs);
    setDeviceId((current) => current || audioInputs[0]?.deviceId || "");
  };

  const refreshHistory = async () => {
    const sessions = await apiFetch<SessionSummary[]>("/api/sessions");
    startTransition(() => {
      setHistory(sessions);
    });
    return sessions;
  };

  const clearBootstrapRetry = () => {
    if (bootstrapRetryTimeoutRef.current !== null) {
      window.clearTimeout(bootstrapRetryTimeoutRef.current);
      bootstrapRetryTimeoutRef.current = null;
    }
  };

  const clearConnectionTimeout = () => {
    if (connectTimeoutRef.current !== null) {
      window.clearTimeout(connectTimeoutRef.current);
      connectTimeoutRef.current = null;
    }
  };

  const loadSession = async (sessionId: string) => {
    const detail = await apiFetch<SessionDetail>(`/api/sessions/${sessionId}`);
    dirtySegmentIdsRef.current.clear();
    startTransition(() => {
      setSelectedSessionId(sessionId);
      setTimelineSegments(sortSegments(detail.segments));
      setCurrentAudioUrl(detail.audioUrl ?? null);
    });
  };

  const persistTranscript = async (
    sessionId: string,
    segments: TranscriptSegment[],
  ) => {
    await apiFetch<SessionDetail>(`/api/sessions/${sessionId}/transcript`, {
      method: "PUT",
      body: JSON.stringify({ segments }),
    });
    dirtySegmentIdsRef.current.clear();
    await refreshHistory();
  };

  const bootstrapApplication = async () => {
    if (bootstrapInFlightRef.current) {
      return;
    }

    bootstrapInFlightRef.current = true;

    try {
      const [settingsPayload, metaPayload, sessions] = await Promise.all([
        apiFetch<SettingsResponse>("/api/settings"),
        apiFetch<MetaResponse>("/api/meta"),
        apiFetch<SessionSummary[]>("/api/sessions"),
      ]);

      clearBootstrapRetry();
      setError(null);
      setSettingsResponse(settingsPayload);
      setDraftSettings(settingsPayload.settings);
      setMeta(metaPayload);
      setHistory(sessions);

      if (sessions[0]) {
        await loadSession(sessions[0].id);
      } else {
        dirtySegmentIdsRef.current.clear();
        startTransition(() => {
          setSelectedSessionId(null);
          setTimelineSegments([]);
          setCurrentAudioUrl(null);
        });
      }
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Failed to load the application state.",
      );

      if (bootstrapRetryTimeoutRef.current === null) {
        bootstrapRetryTimeoutRef.current = window.setTimeout(() => {
          bootstrapRetryTimeoutRef.current = null;
          void bootstrapApplication();
        }, 1500);
      }
    } finally {
      bootstrapInFlightRef.current = false;
    }
  };

  const teardownAudio = async () => {
    clearConnectionTimeout();

    if (animationFrameRef.current !== null) {
      window.cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }

    processorNodeRef.current?.disconnect();
    analyserNodeRef.current?.disconnect();
    sourceNodeRef.current?.disconnect();
    sinkNodeRef.current?.disconnect();

    processorNodeRef.current = null;
    analyserNodeRef.current = null;
    sourceNodeRef.current = null;
    sinkNodeRef.current = null;

    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    mediaStreamRef.current = null;

    if (audioContextRef.current && audioContextRef.current.state !== "closed") {
      await audioContextRef.current.close();
    }
    audioContextRef.current = null;
    setWaveform(EMPTY_WAVEFORM);
  };

  const closeSocket = () => {
    clearConnectionTimeout();
    if (wsRef.current) {
      wsRef.current.close();
    }
    wsRef.current = null;
  };

  const animateWaveform = () => {
    const analyser = analyserNodeRef.current;
    if (!analyser) {
      return;
    }

    const buffer = new Float32Array(analyser.fftSize);
    const frame = () => {
      if (!analyserNodeRef.current) {
        return;
      }
      analyser.getFloatTimeDomainData(buffer);
      setWaveform(Array.from(buffer.slice(0, 96)));
      animationFrameRef.current = window.requestAnimationFrame(frame);
    };
    frame();
  };

  const handleSocketMessage = async (message: SocketMessage) => {
    if (message.type === "started") {
      clearConnectionTimeout();
      setCurrentSessionId(String(message.payload.sessionId ?? ""));
      setStatus("recording");
      return;
    }

    if (
      message.type === "line_started" ||
      message.type === "line_updated" ||
      message.type === "line_text_changed" ||
      message.type === "line_completed"
    ) {
      const incoming = message.payload as unknown as TranscriptSegment;
      startTransition(() => {
        setTimelineSegments((current) =>
          mergeIncomingSegment(current, incoming, dirtySegmentIdsRef.current),
        );
      });
      return;
    }

    if (message.type === "paused") {
      setStatus("paused");
      return;
    }

    if (message.type === "resumed") {
      setStatus("recording");
      return;
    }

    if (message.type === "session_saved") {
      clearConnectionTimeout();
      const session = message.payload.session as unknown as SessionSummary;
      isLiveSessionRef.current = false;
      setLiveSessionStartedAt(null);

      if (timelineSegmentsRef.current.length > 0) {
        await persistTranscript(session.id, timelineSegmentsRef.current);
      } else {
        await refreshHistory();
      }

      await loadSession(session.id);
      setCurrentSessionId(session.id);
      setStatus("idle");
      setError(null);
      closeSocket();
      return;
    }

    if (message.type === "error") {
      clearConnectionTimeout();
      setStatus("error");
      setError(String(message.payload.message ?? "Unknown websocket error"));
      isLiveSessionRef.current = false;
      setLiveSessionStartedAt(null);
      await teardownAudio();
      closeSocket();
    }
  };

  useEffect(() => {
    bootstrapApplicationRef.current = bootstrapApplication;
    refreshDevicesRef.current = refreshDevices;
    teardownAudioRef.current = teardownAudio;
    closeSocketRef.current = closeSocket;
    persistTranscriptRef.current = persistTranscript;
  });

  useEffect(() => {
    const handle = window.setTimeout(() => {
      void bootstrapApplicationRef.current();
      void refreshDevicesRef.current();
    }, 0);

    const onDeviceChange = () => {
      void refreshDevicesRef.current();
    };
    navigator.mediaDevices?.addEventListener?.("devicechange", onDeviceChange);
    return () => {
      window.clearTimeout(handle);
      navigator.mediaDevices?.removeEventListener?.("devicechange", onDeviceChange);
    };
  }, []);

  useEffect(() => {
    return () => {
      clearBootstrapRetry();
      clearConnectionTimeout();
      void teardownAudioRef.current();
      closeSocketRef.current();
    };
  }, []);

  useEffect(() => {
    if (
      status !== "idle" ||
      !selectedSessionId ||
      isLiveSessionRef.current ||
      dirtySegmentIdsRef.current.size === 0
    ) {
      return;
    }

    const handle = window.setTimeout(() => {
      void persistTranscriptRef.current(selectedSessionId, timelineSegmentsRef.current);
    }, 700);

    return () => {
      window.clearTimeout(handle);
    };
  }, [editVersion, selectedSessionId, status]);

  const startRecording = async () => {
    if (!draftSettings) {
      return;
    }

    clearConnectionTimeout();
    setError(null);
    setStatus("connecting");
    setCurrentSessionId(null);
    setCurrentAudioUrl(null);
    setSelectedSessionId(null);
    setRecordsOpen(false);
    dirtySegmentIdsRef.current.clear();
    isLiveSessionRef.current = true;
    setTimelineSegments([]);
    setLiveSessionStartedAt(new Date().toISOString());

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: deviceId ? { exact: deviceId } : undefined,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      mediaStreamRef.current = stream;
      await refreshDevices();

      const audioContext = new AudioContext();
      audioContextRef.current = audioContext;

      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 2048;

      const processor = audioContext.createScriptProcessor(4096, 1, 1);
      const sink = audioContext.createGain();
      sink.gain.value = 0;

      source.connect(analyser);
      analyser.connect(processor);
      processor.connect(sink);
      sink.connect(audioContext.destination);

      sourceNodeRef.current = source;
      analyserNodeRef.current = analyser;
      processorNodeRef.current = processor;
      sinkNodeRef.current = sink;

      const socket = new WebSocket(buildSocketUrl());
      socket.binaryType = "arraybuffer";
      wsRef.current = socket;

      socket.onmessage = (event) => {
        try {
          const payload = JSON.parse(String(event.data)) as SocketMessage;
          void handleSocketMessage(payload);
        } catch {
          clearConnectionTimeout();
          setStatus("error");
          setError("Failed to parse the transcription socket response.");
          isLiveSessionRef.current = false;
          setLiveSessionStartedAt(null);
          void teardownAudio();
          closeSocket();
        }
      };
      socket.onerror = () => {
        clearConnectionTimeout();
        setStatus("error");
        setError("WebSocket connection failed.");
        isLiveSessionRef.current = false;
        setLiveSessionStartedAt(null);
        void teardownAudio();
        closeSocket();
      };
      socket.onclose = () => {
        if (wsRef.current === socket) {
          wsRef.current = null;
        }
        if (statusRef.current === "recording" || statusRef.current === "paused") {
          setStatus("idle");
          return;
        }
        if (statusRef.current === "connecting") {
          clearConnectionTimeout();
          setStatus("error");
          setError("Backend closed the transcription socket during session startup.");
          isLiveSessionRef.current = false;
          setLiveSessionStartedAt(null);
          void teardownAudio();
        }
      };

      socket.onopen = () => {
        const selectedDevice = devices.find((entry) => entry.deviceId === deviceId);
        socket.send(
          JSON.stringify({
            type: "start_session",
            payload: {
              language: draftSettings.transcription.language,
              modelPreset: draftSettings.transcription.modelPreset,
              browserSampleRate: audioContext.sampleRate,
              channels: 1,
              deviceLabel: selectedDevice?.label || "Default Microphone",
              maxSpeakers: draftSettings.transcription.maxSpeakers,
            },
          }),
        );
      };

      connectTimeoutRef.current = window.setTimeout(() => {
        if (wsRef.current !== socket || statusRef.current !== "connecting") {
          return;
        }
        setStatus("error");
        setError(
          "Transcription session startup timed out. Check %LOCALAPPDATA%\\Voice2Text\\logs for backend/frontend logs.",
        );
        isLiveSessionRef.current = false;
        setLiveSessionStartedAt(null);
        void teardownAudio();
        closeSocket();
      }, 12000);

      processor.onaudioprocess = (event) => {
        if (
          !wsRef.current ||
          wsRef.current.readyState !== WebSocket.OPEN ||
          statusRef.current !== "recording"
        ) {
          return;
        }

        const input = event.inputBuffer.getChannelData(0);
        const clone = new Float32Array(input);
        wsRef.current.send(toInt16Pcm(clone).buffer);
      };

      animateWaveform();
    } catch (startError) {
      setStatus("error");
      setError(
        startError instanceof Error
          ? startError.message
          : "Unable to start microphone capture.",
      );
      clearConnectionTimeout();
      await teardownAudio();
      closeSocket();
      isLiveSessionRef.current = false;
      setLiveSessionStartedAt(null);
    }
  };

  const pauseRecording = async () => {
    if (status !== "recording") {
      return;
    }
    await audioContextRef.current?.suspend();
    wsRef.current?.send(JSON.stringify({ type: "pause_session", payload: {} }));
    setStatus("paused");
  };

  const resumeRecording = async () => {
    if (status !== "paused") {
      return;
    }
    await audioContextRef.current?.resume();
    wsRef.current?.send(JSON.stringify({ type: "resume_session", payload: {} }));
    setStatus("recording");
  };

  const stopRecording = async () => {
    if (status !== "recording" && status !== "paused") {
      return;
    }
    setStatus("saving");
    wsRef.current?.send(JSON.stringify({ type: "stop_session", payload: {} }));
    await teardownAudio();
  };

  const saveSettings = async () => {
    if (!draftSettings) {
      return;
    }
    setSavingSettings(true);
    try {
      const response = await apiFetch<SettingsResponse>("/api/settings", {
        method: "PUT",
        body: JSON.stringify(draftSettings),
      });
      setSettingsResponse(response);
      setDraftSettings(response.settings);
      setMeta(await apiFetch<MetaResponse>("/api/meta"));
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : "Failed to save settings.",
      );
    } finally {
      setSavingSettings(false);
    }
  };

  const copyTranscript = async () => {
    const plainText = transcriptToPlainText(timelineSegmentsRef.current);
    await navigator.clipboard.writeText(plainText);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  const downloadTranscript = () => {
    const plainText = transcriptToPlainText(timelineSegmentsRef.current);
    const activeTitle =
      history.find((session) => session.id === selectedSessionId)?.title ??
      (status !== "idle" && status !== "error" ? "live-record" : "transcript");
    const blob = new Blob([plainText], { type: "text/plain;charset=utf-8" });
    const url = window.URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${sanitizeFilename(activeTitle)}.txt`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.URL.revokeObjectURL(url);
  };

  const shareTranscript = async () => {
    const plainText = transcriptToPlainText(timelineSegmentsRef.current);
    const selectedTitle =
      history.find((session) => session.id === selectedSessionId)?.title ??
      "Voice2Text Transcript";
    if (navigator.share) {
      try {
        await navigator.share({
          title: selectedTitle,
          text: plainText,
        });
        return;
      } catch (shareError) {
        if (shareError instanceof Error && shareError.name === "AbortError") {
          return;
        }
      }
    }
    await copyTranscript();
  };

  const deleteSession = async (sessionId: string) => {
    await fetch(`/api/sessions/${sessionId}`, { method: "DELETE" });
    const sessions = await refreshHistory();
    if (selectedSessionId === sessionId) {
      const fallback = sessions[0];
      if (fallback) {
        await loadSession(fallback.id);
      } else {
        setSelectedSessionId(null);
        setTimelineSegments([]);
        setCurrentAudioUrl(null);
      }
    }
  };

  const onSegmentEdit = (segmentId: string, text: string) => {
    dirtySegmentIdsRef.current.add(segmentId);
    setTimelineSegments((current) =>
      current.map((segment) =>
        segment.id === segmentId
          ? { ...segment, text, updatedAt: new Date().toISOString() }
          : segment,
      ),
    );
    setEditVersion((version) => version + 1);
  };

  const updateDraftSettings = (updater: (current: AppSettings) => AppSettings) => {
    setDraftSettings((current) => (current ? updater(current) : current));
  };

  const activeModelOptions =
    meta?.availableModelsByLanguage[draftSettings?.transcription.language ?? "ja"] ??
    ["tiny"];
  const appReady = Boolean(draftSettings && meta);
  const hasActiveCapture = status !== "idle" && status !== "error";
  const totalDuration = deferredSegments.at(-1)
    ? deferredSegments.at(-1)!.startedAt + deferredSegments.at(-1)!.duration
    : 0;
  const selectedDevice =
    devices.find((entry) => entry.deviceId === deviceId) ?? devices[0] ?? null;
  const allHistoryRecords = history.map(toHistoryRecord);
  const selectedHistoryRecord =
    allHistoryRecords.find((record) => record.id === selectedSessionId) ?? null;

  const liveRecord: RecordView | null = hasActiveCapture
    ? {
        id: LIVE_RECORD_ID,
        title:
          currentSessionId !== null
            ? `Live Record ${currentSessionId.slice(0, 6)}`
            : "Live Record",
        createdAt: liveSessionStartedAt ?? new Date().toISOString(),
        language: draftSettings?.transcription.language ?? "ja",
        deviceLabel: selectedDevice?.label || "Current microphone",
        durationSeconds: totalDuration,
        lineCount: timelineSegments.length,
        audioUrl: null,
        summary: STATUS_HINTS[status],
        badgeLabel: STATUS_LABELS[status],
        kind: "live",
      }
    : null;

  const historyRecords = [...allHistoryRecords]
    .sort((left, right) =>
      historySortOrder === "newest"
        ? right.createdAt.localeCompare(left.createdAt)
        : left.createdAt.localeCompare(right.createdAt),
    )
    .filter((record) => recordMatchesFilter(record, recordFilter));

  const visibleRecords = liveRecord ? [liveRecord, ...historyRecords] : historyRecords;
  const activeRecord = liveRecord ?? selectedHistoryRecord;
  const transcriptAvailable = timelineSegments.length > 0;
  const showAudioPlayer = Boolean(currentAudioUrl && status === "idle");
  const canDeleteSelectedSession = Boolean(selectedSessionId && !hasActiveCapture);

  return (
    <div className="flex h-screen overflow-hidden bg-white text-slate-900">
      <aside className="hidden w-16 flex-shrink-0 flex-col items-center gap-8 bg-[#0a0a0b] py-6 lg:flex">
        <div className="text-xl font-black tracking-[-0.08em] text-white">V.</div>
        <div className="flex flex-1 flex-col gap-4">
          <button
            type="button"
            onClick={() => setRecordsOpen(true)}
            className="flex h-10 w-10 items-center justify-center rounded-lg bg-white/5 text-[#007aff] transition-colors"
            aria-label="Open records"
          >
            <FolderOpen className="size-5" />
          </button>
        </div>
        <button
          type="button"
          onClick={() => setSettingsOpen(true)}
          className="flex h-10 w-10 items-center justify-center rounded-lg text-slate-500 transition-colors hover:bg-white/5 hover:text-white"
          aria-label="Open settings"
        >
          <Settings2 className="size-5" />
        </button>
      </aside>

      <AnimatePresence>
        {recordsOpen ? (
          <motion.button
            type="button"
            aria-label="Close records panel"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setRecordsOpen(false)}
            className="fixed inset-0 z-30 bg-slate-950/20 md:hidden"
          />
        ) : null}
      </AnimatePresence>

      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-[min(88vw,20rem)] flex-col border-r border-slate-200 bg-[#f8f9fb] transition-transform duration-300 md:static md:z-auto md:w-80 md:translate-x-0 ${
          recordsOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="border-b border-slate-200 px-4 py-4">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-slate-400">
                Records
              </p>
              <p className="mt-1 text-sm text-slate-500">
                Saved transcripts and the current live capture.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void refreshHistory()}
                className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-500 transition-colors hover:border-slate-300 hover:text-slate-700"
                aria-label="Refresh records"
              >
                <RefreshCcw className="size-4" />
              </button>
              <button
                type="button"
                onClick={() =>
                  setHistorySortOrder((current) =>
                    current === "newest" ? "oldest" : "newest",
                  )
                }
                className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-500 transition-colors hover:border-slate-300 hover:text-slate-700"
                aria-label="Toggle sort order"
              >
                <SlidersHorizontal className="size-4" />
              </button>
            </div>
          </div>

          <Button
            className="w-full rounded-lg px-4 py-2.5"
            onClick={() => void startRecording()}
            disabled={!appReady || hasActiveCapture}
          >
            {status === "connecting" ? (
              <LoaderCircle className="size-4 animate-spin" />
            ) : (
              <Mic className="size-4" />
            )}
            {hasActiveCapture
              ? STATUS_LABELS[status]
              : appReady
                ? "New Record"
                : "Waiting for Backend"}
          </Button>
        </div>

        <div className="border-b border-slate-200 px-4 py-3">
          <label className="relative block">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              value={recordFilter}
              onChange={(event) => setRecordFilter(event.target.value)}
              placeholder="Filter transcripts..."
              className="w-full rounded-lg border border-slate-200 bg-white py-2 pl-9 pr-3 text-sm outline-none transition focus:border-[#007aff] focus:ring-2 focus:ring-[#007aff]/15"
            />
          </label>
        </div>

        <div className="app-scrollbar flex-1 overflow-y-auto">
          {visibleRecords.length === 0 ? (
            <div className="px-4 py-10 text-sm leading-6 text-slate-500">
              {recordFilter
                ? "No records match the current filter."
                : "No saved records yet. Start a new capture to create the first one."}
            </div>
          ) : (
            visibleRecords.map((record) => {
              const isSelected =
                record.kind === "live"
                  ? hasActiveCapture
                  : !hasActiveCapture && record.id === selectedSessionId;
              const isDisabled = record.kind === "history" && hasActiveCapture;
              const badgeClass =
                record.kind === "live"
                  ? "bg-blue-50 text-[#007aff]"
                  : "bg-slate-100 text-slate-500";
              return (
                <div
                  key={record.id}
                  className={`border-b border-slate-100 ${
                    isSelected ? "border-l-2 border-l-[#007aff] bg-white" : ""
                  }`}
                >
                  <button
                    type="button"
                    disabled={isDisabled}
                    onClick={() => {
                      if (record.kind === "history") {
                        setRecordsOpen(false);
                        void loadSession(record.id);
                      }
                    }}
                    className={`w-full px-4 py-4 text-left transition-colors ${
                      isDisabled
                        ? "cursor-not-allowed opacity-60"
                        : "hover:bg-white/80 active:bg-white"
                    }`}
                  >
                    <div className="mb-1 flex items-start justify-between gap-3">
                      <span
                        className={`app-mono inline-flex rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-[0.18em] ${badgeClass}`}
                      >
                        {record.badgeLabel}
                      </span>
                      <span className="app-mono text-[10px] tracking-[0.18em] text-slate-400">
                        {record.kind === "live" ? "NOW" : formatRecordDate(record.createdAt)}
                      </span>
                    </div>
                    <h3 className="truncate text-sm font-semibold text-slate-900">
                      {record.title}
                    </h3>
                    <p className="mt-1 line-clamp-1 text-[11px] text-slate-500">
                      {record.summary}
                    </p>
                    <div className="mt-3 flex items-center gap-3 text-[10px] uppercase tracking-[0.18em] text-slate-400">
                      <span className="app-mono flex items-center gap-1">
                        <AudioLines className="size-3" />
                        {formatRecordLength(record.durationSeconds)}
                      </span>
                      <span className="app-mono">{record.lineCount} lines</span>
                      <span className="app-mono">{record.language}</span>
                    </div>
                  </button>
                </div>
              );
            })
          )}
        </div>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <header className="flex h-16 flex-shrink-0 items-center justify-between border-b border-slate-200 bg-white/90 px-4 backdrop-blur-sm sm:px-6 lg:px-8">
          <div className="flex min-w-0 items-center gap-3">
            <button
              type="button"
              onClick={() => setRecordsOpen(true)}
              className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-600 md:hidden"
              aria-label="Open records"
            >
              <FolderOpen className="size-5" />
            </button>
            <div className="min-w-0">
              <h1 className="truncate text-lg font-bold text-slate-900">
                {activeRecord?.title ?? "Voice2Text Workspace"}
              </h1>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-slate-500">
                <span>{activeRecord?.deviceLabel ?? "Select a microphone to begin."}</span>
                <span className="hidden h-4 w-px bg-slate-200 sm:block" />
                <span>{formatHeaderDate(activeRecord?.createdAt)}</span>
                <span className="hidden h-4 w-px bg-slate-200 sm:block" />
                <span className="app-mono text-[11px] uppercase tracking-[0.24em] text-slate-400">
                  {formatReference(activeRecord?.id ?? currentSessionId)}
                </span>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void copyTranscript()}
              disabled={!transcriptAvailable}
              className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-500 transition-colors hover:border-slate-300 hover:text-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
              aria-label="Copy transcript"
            >
              {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
            </button>
            <button
              type="button"
              onClick={() => void downloadTranscript()}
              disabled={!transcriptAvailable}
              className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-500 transition-colors hover:border-slate-300 hover:text-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
              aria-label="Download transcript"
            >
              <Download className="size-4" />
            </button>
            <button
              type="button"
              onClick={() => void shareTranscript()}
              disabled={!transcriptAvailable}
              className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-500 transition-colors hover:border-slate-300 hover:text-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
              aria-label="Share transcript"
            >
              <Share2 className="size-4" />
            </button>
            <button
              type="button"
              onClick={() => {
                if (selectedSessionId) {
                  void deleteSession(selectedSessionId);
                }
              }}
              disabled={!canDeleteSelectedSession}
              className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-500 transition-colors hover:border-slate-300 hover:text-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
              aria-label="Delete session"
            >
              <Trash2 className="size-4" />
            </button>
            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-500 transition-colors hover:border-slate-300 hover:text-slate-700"
              aria-label="Open settings"
            >
              <Settings2 className="size-4" />
            </button>
          </div>
        </header>

        <div className="app-scrollbar flex-1 overflow-y-auto px-4 py-6 sm:px-6 lg:px-8">
          <div className="mx-auto w-full max-w-6xl pb-10">
            <div className="mb-6 grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
              <section className="rounded-2xl border border-slate-200 bg-[#fbfcff] p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-slate-400">
                      Capture Overview
                    </p>
                    <h2 className="mt-1 text-sm font-semibold text-slate-900">
                      Local microphone transcription workspace
                    </h2>
                  </div>
                  <span className="app-mono inline-flex rounded-full border border-blue-100 bg-blue-50 px-3 py-1 text-[11px] uppercase tracking-[0.18em] text-[#007aff]">
                    {STATUS_LABELS[status]}
                  </span>
                </div>

                <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                  <div className="rounded-xl border border-slate-200 bg-white p-4">
                    <p className="text-[11px] uppercase tracking-[0.24em] text-slate-400">
                      Language
                    </p>
                    <p className="mt-2 text-sm font-semibold text-slate-900">
                      {LANGUAGE_LABELS[draftSettings?.transcription.language ?? "ja"] ??
                        (draftSettings?.transcription.language ?? "ja")}
                    </p>
                  </div>
                  <div className="rounded-xl border border-slate-200 bg-white p-4">
                    <p className="text-[11px] uppercase tracking-[0.24em] text-slate-400">
                      Model
                    </p>
                    <p className="mt-2 text-sm font-semibold text-slate-900">
                      {draftSettings?.transcription.modelPreset ?? "tiny"}
                    </p>
                  </div>
                  <div className="rounded-xl border border-slate-200 bg-white p-4">
                    <p className="text-[11px] uppercase tracking-[0.24em] text-slate-400">
                      Speakers
                    </p>
                    <p className="mt-2 text-sm font-semibold text-slate-900">
                      Up to {draftSettings?.transcription.maxSpeakers ?? 3}
                    </p>
                  </div>
                  <div className="rounded-xl border border-slate-200 bg-white p-4">
                    <p className="text-[11px] uppercase tracking-[0.24em] text-slate-400">
                      Segments
                    </p>
                    <p className="mt-2 text-sm font-semibold text-slate-900">
                      {timelineSegments.length}
                    </p>
                  </div>
                </div>
              </section>

              <section className="rounded-2xl border border-slate-200 bg-white p-5">
                <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-slate-400">
                  Record Details
                </p>
                {showAudioPlayer ? (
                  <>
                    <p className="mt-2 text-sm font-semibold text-slate-900">
                      Recorded audio
                    </p>
                    <p className="mt-1 text-sm text-slate-500">
                      Review the saved local audio while editing the transcript.
                    </p>
                    <audio controls className="mt-4 w-full" src={currentAudioUrl ?? ""} />
                  </>
                ) : (
                  <div className="mt-3 space-y-3 text-sm leading-6 text-slate-500">
                    <p>
                      Microphone: {selectedDevice?.label || "No microphone selected"}
                    </p>
                    <p>Duration: {formatClock(totalDuration)}</p>
                    <p>
                      Recordings path:{" "}
                      {settingsResponse?.resolvedPaths.tempRecordingsRoot ?? "--"}
                    </p>
                  </div>
                )}
              </section>
            </div>

            <section className="rounded-2xl border border-slate-200 bg-white">
              <div className="hidden grid-cols-[96px_140px_minmax(0,1fr)] gap-8 border-b border-slate-100 px-6 py-4 text-[10px] font-bold uppercase tracking-[0.24em] text-slate-400 lg:grid">
                <div>Speaker</div>
                <div>Time</div>
                <div>Transcript Text</div>
              </div>

              <div className="space-y-4 p-4 lg:p-6">
                <AnimatePresence initial={false}>
                  {deferredSegments.length === 0 ? (
                    <motion.div
                      initial={{ opacity: 0, y: 16 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -10 }}
                      className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-6 py-14 text-center text-sm leading-7 text-slate-500"
                    >
                      The transcript will appear here once a live capture starts or an
                      existing record is opened.
                    </motion.div>
                  ) : (
                    deferredSegments.map((segment) => (
                      <motion.article
                        key={segment.id}
                        layout
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -10 }}
                        transition={{ duration: 0.2, ease: "easeOut" }}
                        className="rounded-2xl border border-slate-200 bg-white p-4 shadow-[0_1px_2px_rgba(15,23,42,0.04)] lg:grid lg:grid-cols-[96px_140px_minmax(0,1fr)] lg:gap-8"
                      >
                        <div className="flex items-start justify-between gap-3 lg:block">
                          <div>
                            <p className="text-xs font-semibold text-slate-900">
                              {segment.speakerLabel}
                            </p>
                            <p className="mt-1 text-[11px] uppercase tracking-[0.18em] text-slate-400">
                              {SPEAKER_SOURCE_LABELS[segment.speakerSource] ??
                                segment.speakerSource}
                            </p>
                          </div>
                          <span className="app-mono rounded bg-blue-50 px-2 py-1 text-[10px] uppercase tracking-[0.18em] text-[#007aff] lg:hidden">
                            {formatLongClock(segment.startedAt)}
                          </span>
                        </div>

                        <div className="mt-3 app-mono text-[11px] text-slate-400 lg:mt-0">
                          <p className="font-semibold text-slate-500">
                            {formatLongClock(segment.startedAt)}
                          </p>
                          <p className="mt-1 opacity-70">
                            {formatRangeClock(segment.startedAt, segment.duration)}
                          </p>
                        </div>

                        <div className="mt-4 lg:mt-0">
                          <textarea
                            value={segment.text}
                            rows={Math.max(3, Math.ceil(segment.text.length / 60))}
                            onChange={(event) =>
                              onSegmentEdit(segment.id, event.target.value)
                            }
                            className="min-h-24 w-full resize-y rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-[15px] leading-7 text-slate-800 outline-none transition focus:border-[#007aff] focus:bg-white focus:ring-4 focus:ring-[#007aff]/10"
                          />
                          <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-xs text-slate-400">
                            <span>
                              latency {segment.latencyMs}ms |{" "}
                              {segment.isComplete ? "complete" : "updating"}
                            </span>
                            <span>{new Date(segment.updatedAt).toLocaleTimeString()}</span>
                          </div>
                        </div>
                      </motion.article>
                    ))
                  )}
                </AnimatePresence>
              </div>
            </section>
          </div>
        </div>

        <footer className="border-t border-slate-200 bg-white px-4 py-4 shadow-[0_-4px_20px_rgba(15,23,42,0.03)] sm:px-6 lg:px-8">
          <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
            <div className="flex items-center gap-3 xl:w-[17rem]">
              <div
                className={`h-2.5 w-2.5 rounded-full ${
                  status === "recording"
                    ? "bg-red-500"
                    : status === "paused"
                      ? "bg-amber-400"
                      : status === "error"
                        ? "bg-rose-500"
                        : "bg-slate-300"
                }`}
              />
              <div>
                <p className="text-[11px] font-bold uppercase tracking-[0.28em] text-slate-900">
                  {STATUS_LABELS[status]}
                </p>
                <p className="text-xs text-slate-500">{STATUS_HINTS[status]}</p>
              </div>
            </div>

            <div className="flex flex-1 flex-col items-center gap-4 xl:flex-row xl:justify-center">
              <div className="w-full max-w-[240px]">
                <WaveformCanvas
                  samples={waveform}
                  status={status}
                  width={560}
                  height={56}
                  className="h-14 w-full rounded-xl border border-slate-200 bg-white"
                />
              </div>
              <div className="flex flex-wrap items-center justify-center gap-3">
                {status === "idle" || status === "error" ? (
                  <Button onClick={() => void startRecording()} disabled={!appReady}>
                    {appReady ? (
                      <Mic className="size-4" />
                    ) : (
                      <LoaderCircle className="size-4 animate-spin" />
                    )}
                    {appReady ? "Start" : "Waiting"}
                  </Button>
                ) : null}

                {status === "recording" ? (
                  <>
                    <Button variant="secondary" onClick={() => void pauseRecording()}>
                      <CirclePause className="size-4" />
                      Pause
                    </Button>
                    <Button variant="danger" onClick={() => void stopRecording()}>
                      <MicOff className="size-4" />
                      Stop
                    </Button>
                  </>
                ) : null}

                {status === "paused" ? (
                  <>
                    <Button variant="secondary" onClick={() => void resumeRecording()}>
                      <Mic className="size-4" />
                      Resume
                    </Button>
                    <Button variant="danger" onClick={() => void stopRecording()}>
                      <MicOff className="size-4" />
                      Stop
                    </Button>
                  </>
                ) : null}

                {status === "connecting" || status === "saving" ? (
                  <Button disabled>
                    <LoaderCircle className="size-4 animate-spin" />
                    {status === "connecting" ? "Connecting" : "Saving"}
                  </Button>
                ) : null}
              </div>
            </div>

            <div className="flex items-center justify-between xl:w-[17rem] xl:justify-end">
              <span className="app-mono text-2xl font-medium tabular-nums text-slate-900">
                {formatLongClock(totalDuration)}
              </span>
            </div>
          </div>
        </footer>
      </section>

      <AnimatePresence>
        {settingsOpen ? (
          <>
            <motion.button
              type="button"
              aria-label="Close settings panel"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setSettingsOpen(false)}
              className="fixed inset-0 z-40 bg-slate-950/30"
            />
            <motion.aside
              initial={{ x: "100%" }}
              animate={{ x: 0 }}
              exit={{ x: "100%" }}
              transition={{ duration: 0.24, ease: "easeOut" }}
              className="fixed inset-y-0 right-0 z-50 flex w-full max-w-[420px] flex-col border-l border-slate-200 bg-white shadow-[0_24px_80px_rgba(15,23,42,0.16)]"
            >
              <div className="flex items-center justify-between border-b border-slate-200 px-6 py-5">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-slate-400">
                    Settings
                  </p>
                  <h2 className="mt-1 text-lg font-semibold text-slate-900">
                    Capture and path configuration
                  </h2>
                </div>
                <button
                  type="button"
                  onClick={() => setSettingsOpen(false)}
                  className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-slate-200 text-slate-500 transition-colors hover:border-slate-300 hover:text-slate-700"
                  aria-label="Close settings"
                >
                  <X className="size-4" />
                </button>
              </div>

              <div className="app-scrollbar flex-1 space-y-6 overflow-y-auto px-6 py-6">
                <section className="space-y-4">
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-slate-400">
                      Capture
                    </p>
                    <p className="mt-1 text-sm text-slate-500">
                      Choose the input device and real-time transcription settings.
                    </p>
                  </div>

                  <div className="space-y-2">
                    <label className="field-label">Microphone</label>
                    <select
                      value={deviceId}
                      onChange={(event) => setDeviceId(event.target.value)}
                      className="field-input"
                    >
                      {devices.length === 0 ? (
                        <option value="">No microphone detected</option>
                      ) : (
                        devices.map((device) => (
                          <option key={device.deviceId} value={device.deviceId}>
                            {device.label || "Unnamed microphone"}
                          </option>
                        ))
                      )}
                    </select>
                  </div>

                  {draftSettings ? (
                    <>
                      <div className="grid gap-4 sm:grid-cols-2">
                        <div className="space-y-2">
                          <label className="field-label">Language</label>
                          <select
                            value={draftSettings.transcription.language}
                            onChange={(event) => {
                              const nextLanguage = event.target.value;
                              const nextModel =
                                meta?.availableModelsByLanguage[nextLanguage]?.[0] ??
                                "tiny";
                              updateDraftSettings((current) => ({
                                ...current,
                                transcription: {
                                  ...current.transcription,
                                  language: nextLanguage,
                                  modelPreset: nextModel,
                                },
                              }));
                            }}
                            className="field-input"
                          >
                            {meta?.supportedLanguages.map((language) => (
                              <option key={language} value={language}>
                                {LANGUAGE_LABELS[language] ?? language}
                              </option>
                            ))}
                          </select>
                        </div>

                        <div className="space-y-2">
                          <label className="field-label">Model</label>
                          <select
                            value={draftSettings.transcription.modelPreset}
                            onChange={(event) =>
                              updateDraftSettings((current) => ({
                                ...current,
                                transcription: {
                                  ...current.transcription,
                                  modelPreset: event.target.value,
                                },
                              }))
                            }
                            className="field-input"
                          >
                            {activeModelOptions.map((preset) => (
                              <option key={preset} value={preset}>
                                {preset}
                              </option>
                            ))}
                          </select>
                        </div>
                      </div>

                      <div className="grid gap-4 sm:grid-cols-2">
                        <div className="space-y-2">
                          <label className="field-label">Max Speakers</label>
                          <input
                            type="number"
                            min={1}
                            max={3}
                            value={draftSettings.transcription.maxSpeakers}
                            onChange={(event) =>
                              updateDraftSettings((current) => ({
                                ...current,
                                transcription: {
                                  ...current.transcription,
                                  maxSpeakers: Number(event.target.value),
                                },
                              }))
                            }
                            className="field-input"
                          />
                        </div>

                        <div className="space-y-2">
                          <label className="field-label">Update Interval ms</label>
                          <input
                            type="number"
                            min={100}
                            max={5000}
                            value={draftSettings.transcription.updateIntervalMs}
                            onChange={(event) =>
                              updateDraftSettings((current) => ({
                                ...current,
                                transcription: {
                                  ...current.transcription,
                                  updateIntervalMs: Number(event.target.value),
                                },
                              }))
                            }
                            className="field-input"
                          />
                        </div>
                      </div>

                      <label className="flex items-center justify-between rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
                        <div>
                          <p className="text-sm font-medium text-slate-900">
                            Enable word timestamps
                          </p>
                          <p className="mt-1 text-xs text-slate-500">
                            Pass word-level timestamp hints to the backend session.
                          </p>
                        </div>
                        <input
                          type="checkbox"
                          checked={draftSettings.transcription.enableWordTimestamps}
                          onChange={(event) =>
                            updateDraftSettings((current) => ({
                              ...current,
                              transcription: {
                                ...current.transcription,
                                enableWordTimestamps: event.target.checked,
                              },
                            }))
                          }
                          className="h-4 w-4 rounded border-slate-300 text-[#007aff] focus:ring-[#007aff]"
                        />
                      </label>
                    </>
                  ) : null}
                </section>

                {draftSettings ? (
                  <>
                    <section className="space-y-4">
                      <div>
                        <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-slate-400">
                          AI Providers
                        </p>
                        <p className="mt-1 text-sm text-slate-500">
                          Existing provider settings are preserved and editable here.
                        </p>
                      </div>

                      <div className="space-y-2">
                        <label className="field-label">OpenAI API Key</label>
                        <input
                          type="password"
                          value={draftSettings.apiSettings.providers.openai.apiKey}
                          onChange={(event) =>
                            updateDraftSettings((current) => ({
                              ...current,
                              apiSettings: {
                                ...current.apiSettings,
                                providers: {
                                  ...current.apiSettings.providers,
                                  openai: {
                                    ...current.apiSettings.providers.openai,
                                    apiKey: event.target.value,
                                  },
                                },
                              },
                            }))
                          }
                          className="field-input"
                        />
                      </div>

                      <div className="space-y-2">
                        <label className="field-label">OpenAI Model</label>
                        <input
                          type="text"
                          value={draftSettings.apiSettings.providers.openai.model}
                          onChange={(event) =>
                            updateDraftSettings((current) => ({
                              ...current,
                              apiSettings: {
                                ...current.apiSettings,
                                providers: {
                                  ...current.apiSettings.providers,
                                  openai: {
                                    ...current.apiSettings.providers.openai,
                                    model: event.target.value,
                                  },
                                },
                              },
                            }))
                          }
                          className="field-input"
                        />
                      </div>

                      <div className="space-y-2">
                        <label className="field-label">Anthropic API Key</label>
                        <input
                          type="password"
                          value={draftSettings.apiSettings.providers.anthropic.apiKey}
                          onChange={(event) =>
                            updateDraftSettings((current) => ({
                              ...current,
                              apiSettings: {
                                ...current.apiSettings,
                                providers: {
                                  ...current.apiSettings.providers,
                                  anthropic: {
                                    ...current.apiSettings.providers.anthropic,
                                    apiKey: event.target.value,
                                  },
                                },
                              },
                            }))
                          }
                          className="field-input"
                        />
                      </div>

                      <div className="space-y-2">
                        <label className="field-label">Anthropic Model</label>
                        <input
                          type="text"
                          value={draftSettings.apiSettings.providers.anthropic.model}
                          onChange={(event) =>
                            updateDraftSettings((current) => ({
                              ...current,
                              apiSettings: {
                                ...current.apiSettings,
                                providers: {
                                  ...current.apiSettings.providers,
                                  anthropic: {
                                    ...current.apiSettings.providers.anthropic,
                                    model: event.target.value,
                                  },
                                },
                              },
                            }))
                          }
                          className="field-input"
                        />
                      </div>

                      <div className="space-y-2">
                        <label className="field-label">Prompt Draft</label>
                        <textarea
                          value={draftSettings.apiSettings.systemPrompt}
                          onChange={(event) =>
                            updateDraftSettings((current) => ({
                              ...current,
                              apiSettings: {
                                ...current.apiSettings,
                                systemPrompt: event.target.value,
                              },
                            }))
                          }
                          className="field-input min-h-28 resize-y"
                        />
                      </div>
                    </section>

                    <section className="space-y-4">
                      <div>
                        <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-slate-400">
                          Paths
                        </p>
                        <p className="mt-1 text-sm text-slate-500">
                          These existing path settings were previously hidden in the UI.
                        </p>
                      </div>

                      <div className="space-y-2">
                        <label className="field-label">Models Root</label>
                        <input
                          type="text"
                          value={draftSettings.paths.modelsRoot}
                          onChange={(event) =>
                            updateDraftSettings((current) => ({
                              ...current,
                              paths: {
                                ...current.paths,
                                modelsRoot: event.target.value,
                              },
                            }))
                          }
                          className="field-input"
                        />
                      </div>

                      <div className="space-y-2">
                        <label className="field-label">Data Root</label>
                        <input
                          type="text"
                          value={draftSettings.paths.dataRoot}
                          onChange={(event) =>
                            updateDraftSettings((current) => ({
                              ...current,
                              paths: {
                                ...current.paths,
                                dataRoot: event.target.value,
                              },
                            }))
                          }
                          className="field-input"
                        />
                      </div>

                      <div className="space-y-2">
                        <label className="field-label">Temp Recordings Root</label>
                        <input
                          type="text"
                          value={draftSettings.paths.tempRecordingsRoot}
                          onChange={(event) =>
                            updateDraftSettings((current) => ({
                              ...current,
                              paths: {
                                ...current.paths,
                                tempRecordingsRoot: event.target.value,
                              },
                            }))
                          }
                          className="field-input"
                        />
                      </div>

                      <div className="space-y-2">
                        <label className="field-label">Frontend Dist</label>
                        <input
                          type="text"
                          value={draftSettings.paths.frontendDist}
                          onChange={(event) =>
                            updateDraftSettings((current) => ({
                              ...current,
                              paths: {
                                ...current.paths,
                                frontendDist: event.target.value,
                              },
                            }))
                          }
                          className="field-input"
                        />
                      </div>
                    </section>
                  </>
                ) : null}

                {settingsResponse ? (
                  <section className="space-y-4">
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-slate-400">
                        Resolved Paths
                      </p>
                      <p className="mt-1 text-sm text-slate-500">
                        Read-only paths resolved by the backend.
                      </p>
                    </div>
                    <div className="space-y-2 rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm leading-6 text-slate-600">
                      <p>Config: {settingsResponse.resolvedPaths.configPath}</p>
                      <p>Repo: {settingsResponse.resolvedPaths.repoRoot}</p>
                      <p>Models: {settingsResponse.resolvedPaths.modelsRoot}</p>
                      <p>Data: {settingsResponse.resolvedPaths.dataRoot}</p>
                      <p>Sessions: {settingsResponse.resolvedPaths.sessionsRoot}</p>
                      <p>
                        Temp recordings:{" "}
                        {settingsResponse.resolvedPaths.tempRecordingsRoot}
                      </p>
                      <p>Frontend dist: {settingsResponse.resolvedPaths.frontendDist}</p>
                    </div>
                  </section>
                ) : null}
              </div>

              <div className="flex gap-3 border-t border-slate-200 px-6 py-5">
                <Button
                  variant="secondary"
                  className="flex-1"
                  onClick={() => setSettingsOpen(false)}
                >
                  Close
                </Button>
                <Button
                  className="flex-1"
                  onClick={() => void saveSettings()}
                  disabled={savingSettings || !draftSettings}
                >
                  {savingSettings ? (
                    <LoaderCircle className="size-4 animate-spin" />
                  ) : (
                    <Save className="size-4" />
                  )}
                  Save Settings
                </Button>
              </div>
            </motion.aside>
          </>
        ) : null}
      </AnimatePresence>

      {error ? (
        <div className="fixed left-1/2 top-5 z-[60] w-[min(92vw,720px)] -translate-x-1/2 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700 shadow-[0_20px_50px_rgba(244,63,94,0.12)]">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span>{error}</span>
            {!appReady ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void bootstrapApplication()}
              >
                <RefreshCcw className="size-4" />
                Retry
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default App;
