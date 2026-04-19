import { AnimatePresence, motion } from "framer-motion";
import {
  AudioLines,
  Check,
  CirclePause,
  Copy,
  LoaderCircle,
  Mic,
  MicOff,
  RefreshCcw,
  Save,
  Settings2,
  Sparkles,
  Trash2,
  Waves,
} from "lucide-react";
import {
  startTransition,
  useDeferredValue,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react";

import { WaveformCanvas } from "./components/waveform-canvas";
import { Button } from "./components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "./components/ui/card";
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

  useEffect(() => {
    timelineSegmentsRef.current = timelineSegments;
  }, [timelineSegments]);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  const refreshDevices = useEffectEvent(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) {
      return;
    }

    const availableDevices = await navigator.mediaDevices.enumerateDevices();
    const audioInputs = availableDevices.filter(
      (device) => device.kind === "audioinput",
    );
    setDevices(audioInputs);
    setDeviceId((current) => current || audioInputs[0]?.deviceId || "");
  });

  const refreshHistory = useEffectEvent(async () => {
    const sessions = await apiFetch<SessionSummary[]>("/api/sessions");
    startTransition(() => {
      setHistory(sessions);
    });
    return sessions;
  });

  const clearBootstrapRetry = useEffectEvent(() => {
    if (bootstrapRetryTimeoutRef.current !== null) {
      window.clearTimeout(bootstrapRetryTimeoutRef.current);
      bootstrapRetryTimeoutRef.current = null;
    }
  });

  const clearConnectionTimeout = useEffectEvent(() => {
    if (connectTimeoutRef.current !== null) {
      window.clearTimeout(connectTimeoutRef.current);
      connectTimeoutRef.current = null;
    }
  });

  const loadSession = useEffectEvent(async (sessionId: string) => {
    const detail = await apiFetch<SessionDetail>(`/api/sessions/${sessionId}`);
    dirtySegmentIdsRef.current.clear();
    startTransition(() => {
      setSelectedSessionId(sessionId);
      setTimelineSegments(sortSegments(detail.segments));
      setCurrentAudioUrl(detail.audioUrl ?? null);
    });
  });

  const persistTranscript = useEffectEvent(
    async (sessionId: string, segments: TranscriptSegment[]) => {
      await apiFetch<SessionDetail>(`/api/sessions/${sessionId}/transcript`, {
        method: "PUT",
        body: JSON.stringify({ segments }),
      });
      dirtySegmentIdsRef.current.clear();
      await refreshHistory();
    },
  );

  const bootstrapApplication = useEffectEvent(async () => {
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
  });

  const teardownAudio = useEffectEvent(async () => {
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
  });

  const closeSocket = useEffectEvent(() => {
    clearConnectionTimeout();
    if (wsRef.current) {
      wsRef.current.close();
    }
    wsRef.current = null;
  });

  const animateWaveform = useEffectEvent(() => {
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
  });

  const handleSocketMessage = useEffectEvent(async (message: SocketMessage) => {
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
      await teardownAudio();
      closeSocket();
    }
  });

  useEffect(() => {
    void bootstrapApplication();
    void refreshDevices();

    const onDeviceChange = () => {
      void refreshDevices();
    };
    navigator.mediaDevices?.addEventListener?.("devicechange", onDeviceChange);
    return () => {
      navigator.mediaDevices?.removeEventListener?.("devicechange", onDeviceChange);
    };
  }, []);

  useEffect(() => {
    return () => {
      clearBootstrapRetry();
      clearConnectionTimeout();
      void teardownAudio();
      closeSocket();
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
      void persistTranscript(selectedSessionId, timelineSegmentsRef.current);
    }, 700);

    return () => {
      window.clearTimeout(handle);
    };
  }, [editVersion, selectedSessionId, status]);

  const startRecording = useEffectEvent(async () => {
    if (!draftSettings) {
      return;
    }

    clearConnectionTimeout();
    setError(null);
    setStatus("connecting");
    setCurrentSessionId(null);
    setCurrentAudioUrl(null);
    setSelectedSessionId(null);
    dirtySegmentIdsRef.current.clear();
    isLiveSessionRef.current = true;
    setTimelineSegments([]);

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
          void teardownAudio();
          closeSocket();
        }
      };
      socket.onerror = () => {
        clearConnectionTimeout();
        setStatus("error");
        setError("WebSocket connection failed.");
        isLiveSessionRef.current = false;
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
    }
  });

  const pauseRecording = useEffectEvent(async () => {
    if (status !== "recording") {
      return;
    }
    await audioContextRef.current?.suspend();
    wsRef.current?.send(JSON.stringify({ type: "pause_session", payload: {} }));
    setStatus("paused");
  });

  const resumeRecording = useEffectEvent(async () => {
    if (status !== "paused") {
      return;
    }
    await audioContextRef.current?.resume();
    wsRef.current?.send(JSON.stringify({ type: "resume_session", payload: {} }));
    setStatus("recording");
  });

  const stopRecording = useEffectEvent(async () => {
    if (status !== "recording" && status !== "paused") {
      return;
    }
    setStatus("saving");
    wsRef.current?.send(JSON.stringify({ type: "stop_session", payload: {} }));
    await teardownAudio();
  });

  const saveSettings = useEffectEvent(async () => {
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
  });

  const copyTranscript = useEffectEvent(async () => {
    const plainText = transcriptToPlainText(timelineSegmentsRef.current);
    await navigator.clipboard.writeText(plainText);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  });

  const deleteSession = useEffectEvent(async (sessionId: string) => {
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
  });

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

  const activeModelOptions =
    meta?.availableModelsByLanguage[draftSettings?.transcription.language ?? "ja"] ??
    ["tiny"];
  const appReady = Boolean(draftSettings && meta);

  const totalDuration = deferredSegments.at(-1)
    ? deferredSegments.at(-1)!.startedAt + deferredSegments.at(-1)!.duration
    : 0;

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top,rgba(0,113,227,0.07),transparent_32%),linear-gradient(180deg,#fbfbfd_0%,#f5f5f7_100%)] px-4 py-5 text-[#1d1d1f] sm:px-6 lg:px-8">
      <div className="mx-auto grid max-w-[1680px] gap-6 xl:grid-cols-[360px_minmax(0,1fr)]">
        <aside className="space-y-6">
          <Card className="overflow-hidden">
            <CardHeader className="border-b border-black/6 pb-5">
              <div>
                <p className="text-xs font-medium uppercase tracking-[0.24em] text-[#0071e3]">
                  Voice2Text
                </p>
                <CardTitle className="mt-3 text-[2rem]">
                  Moonshine Local Transcriber
                </CardTitle>
                <CardDescription className="mt-3">
                  軽量・高速・プライバシーを軸にした、ローカル音声文字起こし。
                </CardDescription>
              </div>
              <div className="rounded-full border border-black/8 bg-black/[0.03] p-3 text-[#0071e3]">
                <Sparkles className="size-5" />
              </div>
            </CardHeader>
            <CardContent className="space-y-4 pt-5">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-[24px] bg-[#f5f5f7] p-4">
                  <p className="text-xs uppercase tracking-[0.22em] text-black/45">
                    Status
                  </p>
                  <p className="mt-2 text-lg font-semibold capitalize">{status}</p>
                </div>
                <div className="rounded-[24px] bg-[#f5f5f7] p-4">
                  <p className="text-xs uppercase tracking-[0.22em] text-black/45">
                    Duration
                  </p>
                  <p className="mt-2 text-lg font-semibold">
                    {formatClock(totalDuration)}
                  </p>
                </div>
              </div>
              <div className="rounded-[24px] bg-[#f5f5f7] p-4">
                <p className="text-xs uppercase tracking-[0.22em] text-black/45">
                  Session
                </p>
                <p className="mt-2 text-sm leading-6 text-black/70">
                  {currentSessionId ?? "Not recording"}
                </p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div>
                <CardTitle className="text-[1.3rem]">履歴</CardTitle>
                <CardDescription className="mt-2">
                  保存済みセッションを開き、再生と編集を行えます。
                </CardDescription>
              </div>
              <Button variant="ghost" size="sm" onClick={() => void refreshHistory()}>
                <RefreshCcw className="size-4" />
              </Button>
            </CardHeader>
            <CardContent className="space-y-3">
              {history.length === 0 ? (
                <div className="rounded-[24px] border border-dashed border-black/10 bg-[#f5f5f7] px-4 py-6 text-sm leading-6 text-black/56">
                  保存済みセッションはまだありません。
                </div>
              ) : (
                history.map((session) => (
                  <div
                    key={session.id}
                    className={`rounded-[24px] border px-4 py-4 transition-colors ${
                      selectedSessionId === session.id
                        ? "border-[#0071e3]/30 bg-[#eef5ff]"
                        : "border-black/6 bg-[#f8f8fa]"
                    }`}
                  >
                    <button
                      type="button"
                      className="w-full text-left"
                      disabled={status === "recording" || status === "paused"}
                      onClick={() => void loadSession(session.id)}
                    >
                      <div className="flex items-center justify-between gap-4">
                        <p className="font-medium tracking-[-0.01em]">
                          {session.title}
                        </p>
                        <span className="rounded-full bg-white px-3 py-1 text-[11px] uppercase tracking-[0.18em] text-black/45">
                          {session.language}
                        </span>
                      </div>
                      <p className="mt-2 text-sm leading-6 text-black/56">
                        {session.deviceLabel}
                      </p>
                      <div className="mt-3 flex items-center justify-between text-xs text-black/45">
                        <span>{session.lineCount} lines</span>
                        <span>{formatClock(session.durationSeconds)}</span>
                      </div>
                    </button>
                    <div className="mt-3 flex justify-end">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => void deleteSession(session.id)}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  </div>
                ))
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div>
                <CardTitle className="flex items-center gap-2 text-[1.3rem]">
                  <Settings2 className="size-5 text-[#0071e3]" />
                  設定
                </CardTitle>
                <CardDescription className="mt-2">
                  Phase 2 用 API 設定を含め、保存まで実装済みです。
                </CardDescription>
              </div>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="space-y-2">
                <label className="field-label">Microphone</label>
                <select
                  value={deviceId}
                  onChange={(event) => setDeviceId(event.target.value)}
                  className="field-input"
                >
                  {devices.map((device) => (
                    <option key={device.deviceId} value={device.deviceId}>
                      {device.label || "Unnamed microphone"}
                    </option>
                  ))}
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
                          setDraftSettings((current) =>
                            current
                              ? {
                                  ...current,
                                  transcription: {
                                    ...current.transcription,
                                    language: nextLanguage,
                                    modelPreset: nextModel,
                                  },
                                }
                              : current,
                          );
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
                          setDraftSettings((current) =>
                            current
                              ? {
                                  ...current,
                                  transcription: {
                                    ...current.transcription,
                                    modelPreset: event.target.value,
                                  },
                                }
                              : current,
                          )
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
                          setDraftSettings((current) =>
                            current
                              ? {
                                  ...current,
                                  transcription: {
                                    ...current.transcription,
                                    maxSpeakers: Number(event.target.value),
                                  },
                                }
                              : current,
                          )
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
                          setDraftSettings((current) =>
                            current
                              ? {
                                  ...current,
                                  transcription: {
                                    ...current.transcription,
                                    updateIntervalMs: Number(event.target.value),
                                  },
                                }
                              : current,
                          )
                        }
                        className="field-input"
                      />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <label className="field-label">OpenAI API Key</label>
                    <input
                      type="password"
                      value={draftSettings.apiSettings.providers.openai.apiKey}
                      onChange={(event) =>
                        setDraftSettings((current) =>
                          current
                            ? {
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
                              }
                            : current,
                        )
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
                        setDraftSettings((current) =>
                          current
                            ? {
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
                              }
                            : current,
                        )
                      }
                      className="field-input"
                    />
                  </div>

                  <div className="space-y-2">
                    <label className="field-label">Prompt Draft</label>
                    <textarea
                      value={draftSettings.apiSettings.systemPrompt}
                      onChange={(event) =>
                        setDraftSettings((current) =>
                          current
                            ? {
                                ...current,
                                apiSettings: {
                                  ...current.apiSettings,
                                  systemPrompt: event.target.value,
                                },
                              }
                            : current,
                        )
                      }
                      className="field-input min-h-28 resize-y rounded-[26px] py-4"
                    />
                  </div>

                  <div className="rounded-[24px] bg-[#f5f5f7] p-4 text-xs leading-6 text-black/56">
                    <p>Models: {settingsResponse?.resolvedPaths.modelsRoot}</p>
                    <p>Recordings: {settingsResponse?.resolvedPaths.tempRecordingsRoot}</p>
                  </div>
                  <Button
                    className="w-full"
                    onClick={() => void saveSettings()}
                    disabled={savingSettings}
                  >
                    {savingSettings ? (
                      <LoaderCircle className="size-4 animate-spin" />
                    ) : (
                      <Save className="size-4" />
                    )}
                    Save Settings
                  </Button>
                </>
              ) : null}
            </CardContent>
          </Card>
        </aside>

        <main className="space-y-6">
          <Card className="overflow-hidden">
            <CardHeader className="items-center border-b border-black/6 pb-6">
              <div>
                <p className="text-xs uppercase tracking-[0.24em] text-[#0071e3]">
                  Real-Time Timeline
                </p>
                <CardTitle className="mt-3 text-[2.4rem]">
                  白基調のタイムライン文字起こし
                </CardTitle>
                <CardDescription className="mt-3 max-w-3xl text-base">
                  Moonshine を使って、USB マイクやオーディオインターフェースの入力をローカルで文字起こしします。
                  タイムラインはその場で編集でき、保存後も再生と追記が可能です。
                </CardDescription>
              </div>
              <div className="rounded-full border border-black/8 bg-white px-4 py-2 text-sm tracking-[-0.01em] text-black/60">
                {timelineSegments.length} segments
              </div>
            </CardHeader>
            <CardContent className="space-y-6 pt-6">
              <div className="grid gap-6 xl:grid-cols-[1.3fr_0.9fr]">
                <div className="rounded-[30px] border border-black/6 bg-[linear-gradient(180deg,rgba(255,255,255,0.96),rgba(245,245,247,0.92))] p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.6)]">
                  <div className="mb-4 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="rounded-full bg-[#eef5ff] p-2 text-[#0071e3]">
                        <Waves className="size-4" />
                      </div>
                      <div>
                        <p className="text-sm font-medium tracking-[-0.01em]">
                          Waveform
                        </p>
                        <p className="text-xs text-black/45">
                          Visualizer linked to the live microphone stream.
                        </p>
                      </div>
                    </div>
                    <span className="rounded-full border border-black/6 bg-white px-3 py-1 text-xs uppercase tracking-[0.18em] text-black/45">
                      {status}
                    </span>
                  </div>
                  <WaveformCanvas samples={waveform} status={status} />
                </div>

                <div className="rounded-[30px] border border-black/6 bg-[#f8f8fa] p-5">
                  <div className="flex items-center gap-3">
                    <div className="rounded-full bg-white p-2 text-[#0071e3] shadow-sm">
                      <AudioLines className="size-4" />
                    </div>
                    <div>
                      <p className="text-sm font-medium tracking-[-0.01em]">
                        Session Notes
                      </p>
                      <p className="text-xs leading-5 text-black/45">
                        日本語は Moonshine の `tiny-ja` / `base-ja` を中心に構成し、低遅延更新へ寄せています。
                      </p>
                    </div>
                  </div>
                  <div className="mt-5 space-y-3 text-sm leading-6 text-black/64">
                    <p>Language: {draftSettings?.transcription.language ?? "ja"}</p>
                    <p>Model preset: {draftSettings?.transcription.modelPreset ?? "tiny"}</p>
                    <p>Speaker labeling: Moonshine + feature fallback</p>
                    <p>
                      Local audio path: {settingsResponse?.resolvedPaths.tempRecordingsRoot ?? "-"}
                    </p>
                  </div>
                  {currentAudioUrl && status === "idle" ? (
                    <div className="mt-6 rounded-[24px] border border-black/6 bg-white p-4">
                      <p className="mb-3 text-sm font-medium tracking-[-0.01em]">
                        Recorded Audio
                      </p>
                      <audio controls className="w-full" src={currentAudioUrl} />
                    </div>
                  ) : null}
                </div>
              </div>

              <div className="rounded-[30px] border border-black/6 bg-white">
                <div className="grid grid-cols-[112px_140px_minmax(0,1fr)] gap-4 border-b border-black/6 px-6 py-4 text-xs uppercase tracking-[0.18em] text-black/45">
                  <span>Elapsed</span>
                  <span>Speaker</span>
                  <span>Editable Text</span>
                </div>

                <div className="max-h-[720px] overflow-y-auto px-3 py-3">
                  <AnimatePresence initial={false}>
                    {deferredSegments.length === 0 ? (
                      <motion.div
                        initial={{ opacity: 0, y: 16 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -10 }}
                        className="m-3 rounded-[28px] border border-dashed border-black/10 bg-[#f8f8fa] px-6 py-14 text-center text-sm leading-7 text-black/50"
                      >
                        まだ文字起こしはありません。録音を始めると、ここに
                        `[経過時間] | [話者ラベル] | [編集可能なテキスト]`
                        形式で流れます。
                      </motion.div>
                    ) : (
                      deferredSegments.map((segment) => (
                        <motion.div
                          key={segment.id}
                          layout
                          initial={{ opacity: 0, y: 12 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, y: -12 }}
                          transition={{ duration: 0.22, ease: "easeOut" }}
                          className="m-3 grid grid-cols-[112px_140px_minmax(0,1fr)] gap-4 rounded-[28px] border border-black/6 bg-[#fcfcfd] px-4 py-4"
                        >
                          <div className="pt-2 text-sm font-medium tracking-[-0.01em] text-black/60">
                            {formatClock(segment.startedAt)}
                          </div>
                          <div className="pt-1">
                            <span className="inline-flex rounded-full border border-[#0071e3]/12 bg-[#eef5ff] px-3 py-1 text-xs font-medium tracking-[0.02em] text-[#0071e3]">
                              {segment.speakerLabel}
                            </span>
                            <p className="mt-2 text-[11px] uppercase tracking-[0.18em] text-black/38">
                              {segment.speakerSource}
                            </p>
                          </div>
                          <div className="space-y-2">
                            <textarea
                              value={segment.text}
                              rows={Math.max(2, Math.ceil(segment.text.length / 34))}
                              onChange={(event) =>
                                onSegmentEdit(segment.id, event.target.value)
                              }
                              className="min-h-16 w-full resize-y rounded-[22px] border border-transparent bg-[#f5f5f7] px-4 py-3 text-[15px] leading-7 tracking-[-0.02em] text-[#1d1d1f] outline-none transition focus:border-[#0071e3]/25 focus:bg-white focus:ring-4 focus:ring-[#0071e3]/10"
                            />
                            <div className="flex items-center justify-between text-xs text-black/42">
                              <span>
                                latency {segment.latencyMs}ms
                                {segment.isComplete ? " | complete" : " | updating"}
                              </span>
                              <span>
                                {new Date(segment.updatedAt).toLocaleTimeString()}
                              </span>
                            </div>
                          </div>
                        </motion.div>
                      ))
                    )}
                  </AnimatePresence>
                </div>
              </div>
            </CardContent>
          </Card>
        </main>
      </div>

      <div className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex justify-center px-4">
        <motion.div
          layout
          className="pointer-events-auto flex w-full max-w-[880px] items-center justify-between gap-4 rounded-full border border-black/8 bg-white/94 px-4 py-3 shadow-[0_30px_90px_rgba(0,0,0,0.14)] backdrop-blur-xl"
        >
          <div className="flex items-center gap-3">
            <div
              className={`rounded-full p-3 ${
                status === "recording"
                  ? "bg-[#0071e3] text-white"
                  : status === "paused"
                    ? "bg-black/[0.08] text-[#1d1d1f]"
                    : "bg-[#eef5ff] text-[#0071e3]"
              }`}
            >
              {status === "recording" ? (
                <Mic className="size-5" />
              ) : status === "paused" ? (
                <CirclePause className="size-5" />
              ) : (
                <MicOff className="size-5" />
              )}
            </div>
            <div>
              <p className="text-sm font-medium tracking-[-0.01em]">
                Recording Controls
              </p>
              <p className="text-xs leading-5 text-black/45">
                Start, pause, resume, stop, and copy the full transcript.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-end gap-3">
            <Button
              variant="secondary"
              onClick={() => void copyTranscript()}
              disabled={timelineSegments.length === 0}
            >
              {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
              {copied ? "Copied" : "Copy"}
            </Button>

            {status === "idle" || status === "error" ? (
              <Button onClick={() => void startRecording()} disabled={!appReady}>
                {appReady ? (
                  <Mic className="size-4" />
                ) : (
                  <LoaderCircle className="size-4 animate-spin" />
                )}
                {appReady ? "Start Recording" : "Waiting for Backend"}
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
        </motion.div>
      </div>

      {error ? (
        <div className="fixed left-1/2 top-5 z-50 w-[min(92vw,720px)] -translate-x-1/2 rounded-[28px] border border-[#d92d20]/10 bg-[#fff5f4] px-4 py-3 text-sm text-[#b42318] shadow-[0_18px_50px_rgba(217,45,32,0.12)]">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span>{error}</span>
            {!appReady ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void bootstrapApplication()}
              >
                <RefreshCcw className="size-4" />
                Retry Connection
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default App;
