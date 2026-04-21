import { AnimatePresence, motion } from "framer-motion";
import {
  AlignLeft,
  Check,
  CirclePause,
  Copy,
  Download,
  FileText,
  FolderOpen,
  LoaderCircle,
  Mic,
  MicOff,
  Pencil,
  Play,
  RefreshCcw,
  Save,
  Search,
  Square,
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
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent,
  PointerEvent as ReactPointerEvent,
} from "react";

import { WaveformCanvas } from "./components/waveform-canvas";
import { Button } from "./components/ui/button";
import { transcriptToPlainText } from "./lib/utils";
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
const MIN_UPDATE_INTERVAL_MS = 100;
const MAX_UPDATE_INTERVAL_MS = 5000;
const SEGMENT_AUDIO_PREROLL_SECONDS = 0.2;
const INPUT_GAIN_MIN_DB = 0;
const INPUT_GAIN_MAX_DB = 24;
const INPUT_GAIN_STEP_DB = 1;
const INPUT_GAIN_DEFAULT_DB = 5;
const INPUT_GAIN_DIAL_START_DEG = -150;
const INPUT_GAIN_DIAL_SWEEP_DEG = 270;
const SIDEBAR_MIN_WIDTH = 240;
const SIDEBAR_MAX_WIDTH = 520;
const MINUTES_PANE_MIN_WIDTH = 280;
const TRANSCRIPT_GRID_CLASS =
  "lg:grid lg:grid-cols-[88px_132px_minmax(0,1fr)_minmax(0,1fr)] lg:gap-4";
const LLM_MODEL_OPTIONS = ["gemma4:e2b", "gemma4:e4b"];

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

const BATCH_ENGINE_LABELS: Record<string, string> = {
  "faster-whisper": "Faster Whisper",
  moonshine: "Moonshine",
};

const STATUS_LABELS: Record<RecordingStatus, string> = {
  idle: "Ready",
  connecting: "Connecting",
  recording: "Recording",
  paused: "Paused",
  saving: "Saving",
  error: "Error",
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
  minutesStatus?: "idle" | "processing" | "complete" | "error";
  minutesUpdatedAt?: string | null;
  summary: string;
  badgeLabel: string;
  kind: "history" | "live";
}

interface SidebarContextMenuState {
  recordId: string;
  x: number;
  y: number;
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
    minutesStatus: session.minutesStatus ?? "idle",
    minutesUpdatedAt: session.minutesUpdatedAt ?? null,
    summary: session.deviceLabel,
    badgeLabel: "Completed",
    kind: "history",
  };
}

function toSessionSummary(detail: SessionDetail): SessionSummary {
  return {
    id: detail.id,
    createdAt: detail.createdAt,
    updatedAt: detail.updatedAt,
    language: detail.language,
    deviceLabel: detail.deviceLabel,
    durationSeconds: detail.durationSeconds,
    lineCount: detail.lineCount,
    title: detail.title,
    audioUrl: detail.audioUrl ?? null,
    minutesStatus: detail.minutesStatus,
    minutesUpdatedAt: detail.minutesUpdatedAt,
    minutesModel: detail.minutesModel,
    minutesError: detail.minutesError,
  };
}

function parseDate(value?: string | null) {
  if (!value) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatSidebarDate(value?: string | null) {
  const parsed = parseDate(value);
  if (!parsed) {
    return new Intl.DateTimeFormat("ja-JP", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .format(new Date())
      .replace(/\//g, "/");
  }
  return new Intl.DateTimeFormat("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(parsed);
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

function formatSessionTitle(value?: string | null) {
  const parsed = parseDate(value);
  const date = parsed ?? new Date();
  const parts = new Intl.DateTimeFormat("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((entry) => entry.type === type)?.value ?? "";
  return `${part("year")}/${part("month")}/${part("day")} ${part("hour")}:${part(
    "minute",
  )}`;
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

function normalizeTitleInput(value: string, fallback: string) {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized || fallback;
}

function normalizeSpeakerName(value: string, fallback: string) {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized || fallback;
}

function clampUpdateInterval(value: number) {
  return Math.min(MAX_UPDATE_INTERVAL_MS, Math.max(MIN_UPDATE_INTERVAL_MS, value));
}

function clampInputGainDb(value: number) {
  return Math.min(INPUT_GAIN_MAX_DB, Math.max(INPUT_GAIN_MIN_DB, value));
}

function clampNumber(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function dbToLinearGain(db: number) {
  return 10 ** (db / 20);
}

function formatInputGainDb(db: number) {
  return db === 0 ? "0 dB" : `+${db} dB`;
}

function gainDbToDialAngle(db: number) {
  const ratio =
    (clampInputGainDb(db) - INPUT_GAIN_MIN_DB) /
    (INPUT_GAIN_MAX_DB - INPUT_GAIN_MIN_DB);
  return INPUT_GAIN_DIAL_START_DEG + ratio * INPUT_GAIN_DIAL_SWEEP_DEG;
}

function angleToInputGainDb(angle: number) {
  let normalized = angle - INPUT_GAIN_DIAL_START_DEG;
  while (normalized < 0) {
    normalized += 360;
  }
  while (normalized > 360) {
    normalized -= 360;
  }

  const clamped = Math.min(INPUT_GAIN_DIAL_SWEEP_DEG, normalized);
  const ratio = clamped / INPUT_GAIN_DIAL_SWEEP_DEG;
  const nextDb =
    INPUT_GAIN_MIN_DB + ratio * (INPUT_GAIN_MAX_DB - INPUT_GAIN_MIN_DB);
  return clampInputGainDb(Math.round(nextDb / INPUT_GAIN_STEP_DB) * INPUT_GAIN_STEP_DB);
}

function coerceUpdateInterval(value: string, fallback: number) {
  const digits = value.replace(/[^\d]/g, "");
  if (!digits) {
    return fallback;
  }
  const parsed = Number(digits);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return clampUpdateInterval(parsed);
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
    formatSidebarDate(record.createdAt),
  ]
    .join(" ")
    .toLowerCase();
  return haystack.includes(query);
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderMarkdown(markdown: string) {
  const lines = markdown.split(/\r?\n/);
  const html: string[] = [];
  let inList = false;

  const closeList = () => {
    if (inList) {
      html.push("</ul>");
      inList = false;
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (!line.trim()) {
      closeList();
      html.push("<br />");
      continue;
    }
    if (line.startsWith("### ")) {
      closeList();
      html.push(`<h3>${escapeHtml(line.slice(4))}</h3>`);
      continue;
    }
    if (line.startsWith("## ")) {
      closeList();
      html.push(`<h2>${escapeHtml(line.slice(3))}</h2>`);
      continue;
    }
    if (line.startsWith("# ")) {
      closeList();
      html.push(`<h1>${escapeHtml(line.slice(2))}</h1>`);
      continue;
    }
    if (line.startsWith("- ") || line.startsWith("* ")) {
      if (!inList) {
        html.push("<ul>");
        inList = true;
      }
      html.push(`<li>${escapeHtml(line.slice(2))}</li>`);
      continue;
    }
    if (line.startsWith("> ")) {
      closeList();
      html.push(`<blockquote>${escapeHtml(line.slice(2))}</blockquote>`);
      continue;
    }
    closeList();
    html.push(`<p>${escapeHtml(line)}</p>`);
  }
  closeList();
  return html.join("");
}

function refinedBlocksToPlainText(segments: TranscriptSegment[]) {
  const seen = new Set<string>();
  return sortSegments(segments)
    .filter((segment) => {
      const text = segment.llmText?.trim();
      if (!text) {
        return false;
      }
      const key = segment.llmBlockId || segment.id;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .map((segment) => segment.llmText?.trim() ?? "")
    .join("\n\n");
}

function buildExportText(segments: TranscriptSegment[], minutesMarkdown: string) {
  const refined = minutesMarkdown.trim() || refinedBlocksToPlainText(segments);
  const raw = transcriptToPlainText(segments);
  return [
    "# 整形済み文章",
    refined || "整形済み文章はまだありません。",
    "---",
    "# 時系列の生データ",
    raw || "生データはまだありません。",
  ].join("\n\n");
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
  const [minutesDraft, setMinutesDraft] = useState("");
  const [activeTranscriptView, setActiveTranscriptView] = useState<
    "realtime" | "minutes"
  >("realtime");
  const [showLlmRefined, setShowLlmRefined] = useState(true);
  const [currentAudioUrl, setCurrentAudioUrl] = useState<string | null>(null);
  const [deviceId, setDeviceId] = useState("");
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [status, setStatus] = useState<RecordingStatus>("idle");
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [waveform, setWaveform] = useState<number[]>(EMPTY_WAVEFORM);
  const [savingSettings, setSavingSettings] = useState(false);
  const [choosingRecordingsRoot, setChoosingRecordingsRoot] = useState(false);
  const [openingRecordingId, setOpeningRecordingId] = useState<string | null>(null);
  const [minutesProcessingIds, setMinutesProcessingIds] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);
  const [editVersion, setEditVersion] = useState(0);
  const [recordFilter, setRecordFilter] = useState("");
  const [updateIntervalDraft, setUpdateIntervalDraft] = useState("");
  const [inputGainDb, setInputGainDb] = useState(INPUT_GAIN_DEFAULT_DB);
  const [sidebarWidth, setSidebarWidth] = useState(320);
  const [minutesEditorPercent, setMinutesEditorPercent] = useState(50);
  const [sidebarSelectedRecordIds, setSidebarSelectedRecordIds] = useState<string[]>(
    [],
  );
  const [sidebarContextMenu, setSidebarContextMenu] =
    useState<SidebarContextMenuState | null>(null);
  const [historySortOrder, setHistorySortOrder] = useState<"newest" | "oldest">(
    "newest",
  );
  const [recordsOpen, setRecordsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [liveSessionStartedAt, setLiveSessionStartedAt] = useState<string | null>(
    null,
  );
  const [liveTitleOverride, setLiveTitleOverride] = useState<string | null>(null);
  const [titleDraft, setTitleDraft] = useState("");
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [savingTitle, setSavingTitle] = useState(false);

  const deferredSegments = useDeferredValue(timelineSegments);

  const wsRef = useRef<WebSocket | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const inputGainNodeRef = useRef<GainNode | null>(null);
  const analyserNodeRef = useRef<AnalyserNode | null>(null);
  const processorNodeRef = useRef<ScriptProcessorNode | null>(null);
  const sinkNodeRef = useRef<GainNode | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const bootstrapRetryTimeoutRef = useRef<number | null>(null);
  const connectTimeoutRef = useRef<number | null>(null);
  const bootstrapInFlightRef = useRef(false);
  const dirtySegmentIdsRef = useRef<Set<string>>(new Set());
  const timelineSegmentsRef = useRef<TranscriptSegment[]>([]);
  const transcriptScrollRef = useRef<HTMLDivElement | null>(null);
  const recordsPanelRef = useRef<HTMLElement | null>(null);
  const minutesSplitRef = useRef<HTMLDivElement | null>(null);
  const segmentRowRefs = useRef<Map<string, HTMLElement>>(new Map());
  const lastLiveSegmentIdRef = useRef<string | null>(null);
  const audioPlayerRef = useRef<HTMLAudioElement | null>(null);
  const speakerNameOverridesRef = useRef<Map<number, string>>(new Map());
  const lastSidebarSelectedRecordIdRef = useRef<string | null>(null);
  const inputGainDbRef = useRef(INPUT_GAIN_DEFAULT_DB);
  const statusRef = useRef<RecordingStatus>("idle");
  const isLiveSessionRef = useRef(false);
  const pendingLiveTitleRef = useRef<string | null>(null);
  const bootstrapApplicationRef = useRef<() => Promise<void>>(async () => {});
  const refreshDevicesRef = useRef<() => Promise<void>>(async () => {});
  const teardownAudioRef = useRef<() => Promise<void>>(async () => {});
  const closeSocketRef = useRef<() => void>(() => {});
  const persistTranscriptRef = useRef<
    (sessionId: string, segments: TranscriptSegment[]) => Promise<void>
  >(async () => {});
  const minutesSaveTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    timelineSegmentsRef.current = timelineSegments;
  }, [timelineSegments]);

  useEffect(
    () => () => {
      if (minutesSaveTimeoutRef.current !== null) {
        window.clearTimeout(minutesSaveTimeoutRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    inputGainDbRef.current = inputGainDb;
    const audioContext = audioContextRef.current;
    const inputGain = inputGainNodeRef.current;
    if (!audioContext || !inputGain) {
      return;
    }

    inputGain.gain.setTargetAtTime(
      dbToLinearGain(inputGainDb),
      audioContext.currentTime,
      0.015,
    );
  }, [inputGainDb]);

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
    speakerNameOverridesRef.current.clear();
    setIsEditingTitle(false);
    startTransition(() => {
      setSelectedSessionId(sessionId);
      setTimelineSegments(sortSegments(detail.segments));
      setMinutesDraft(detail.minutesMarkdown ?? "");
      setActiveTranscriptView(detail.minutesMarkdown ? "minutes" : "realtime");
      setCurrentAudioUrl(detail.audioUrl ?? null);
    });
  };

  const persistTranscript = async (
    sessionId: string,
    segments: TranscriptSegment[],
    title?: string,
  ) => {
    await apiFetch<SessionDetail>(`/api/sessions/${sessionId}/transcript`, {
      method: "PUT",
      body: JSON.stringify({ segments, title }),
    });
    dirtySegmentIdsRef.current.clear();
    await refreshHistory();
  };

  const updateSessionTitle = async (sessionId: string, title: string) => {
    const payload = JSON.stringify({ title });
    let detail: SessionDetail | null = null;

    for (const method of ["PUT", "PATCH", "POST"] as const) {
      try {
        detail = await apiFetch<SessionDetail>(`/api/sessions/${sessionId}/title`, {
          method,
          body: payload,
        });
        break;
      } catch (updateError) {
        if (
          !(updateError instanceof Error) ||
          !updateError.message.includes("Method Not Allowed") ||
          method === "POST"
        ) {
          throw updateError;
        }
      }
    }

    if (!detail) {
      const transcriptDetail = await apiFetch<SessionDetail>(
        `/api/sessions/${sessionId}/transcript`,
        {
          method: "PUT",
          body: JSON.stringify({
            segments: timelineSegmentsRef.current,
            title,
          }),
        },
      );
      if (normalizeTitleInput(transcriptDetail.title, transcriptDetail.title) === title) {
        detail = transcriptDetail;
      } else {
        throw new Error(
          "Title update endpoint is unavailable. Restart the backend and try again.",
        );
      }
    }

    if (!detail) {
      throw new Error("Failed to save the title.");
    }

    startTransition(() => {
      setHistory((current) => {
        const summary = toSessionSummary(detail);
        const next = current.filter((entry) => entry.id !== detail.id);
        next.unshift(summary);
        return next;
      });
      setSelectedSessionId(detail.id);
      setTimelineSegments(sortSegments(detail.segments));
      setCurrentAudioUrl(detail.audioUrl ?? null);
    });
    return detail;
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
      setUpdateIntervalDraft(
        String(settingsPayload.settings.transcription.updateIntervalMs),
      );
      speakerNameOverridesRef.current.clear();
      setMeta(metaPayload);
      setHistory(sessions);

      if (sessions[0]) {
        await loadSession(sessions[0].id);
      } else {
        dirtySegmentIdsRef.current.clear();
        startTransition(() => {
          setSelectedSessionId(null);
          setTimelineSegments([]);
          setMinutesDraft("");
          setActiveTranscriptView("realtime");
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
    inputGainNodeRef.current?.disconnect();
    sourceNodeRef.current?.disconnect();
    sinkNodeRef.current?.disconnect();

    processorNodeRef.current = null;
    analyserNodeRef.current = null;
    inputGainNodeRef.current = null;
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
      const sessionId = String(message.payload.sessionId ?? "");
      const createdAt = String(message.payload.createdAt ?? new Date().toISOString());
      const title = String(message.payload.title ?? formatSessionTitle(createdAt));
      setCurrentSessionId(sessionId);
      setLiveSessionStartedAt(createdAt);
      setLiveTitleOverride(title);
      setTitleDraft(title);
      setStatus("recording");
      return;
    }

    if (
      message.type === "line_started" ||
      message.type === "line_updated" ||
      message.type === "line_text_changed" ||
      message.type === "line_completed" ||
      message.type === "llm_refinement_started" ||
      message.type === "llm_refinement_updated" ||
      message.type === "llm_refinement_error"
    ) {
      const incoming = (() => {
        const segment = message.payload as unknown as TranscriptSegment;
        const override = speakerNameOverridesRef.current.get(segment.speakerIndex);
        return override ? { ...segment, speakerLabel: override } : segment;
      })();
      if (
        message.type === "line_started" ||
        message.type === "line_updated" ||
        message.type === "line_text_changed" ||
        message.type === "line_completed"
      ) {
        lastLiveSegmentIdRef.current = incoming.id;
      }
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

      const pendingTitle = pendingLiveTitleRef.current?.trim();
      if (pendingTitle && pendingTitle !== session.title) {
        const updatedDetail = await updateSessionTitle(session.id, pendingTitle);
        setTitleDraft(updatedDetail.title);
      } else {
        await loadSession(session.id);
      }
      pendingLiveTitleRef.current = null;
      setLiveTitleOverride(null);
      setCurrentSessionId(session.id);
      lastLiveSegmentIdRef.current = null;
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
      pendingLiveTitleRef.current = null;
      lastLiveSegmentIdRef.current = null;
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
    speakerNameOverridesRef.current.clear();
    setTimelineSegments([]);
    setMinutesDraft("");
    setActiveTranscriptView("realtime");
    setIsEditingTitle(false);
    setLiveSessionStartedAt(new Date().toISOString());
    setLiveTitleOverride(null);
    pendingLiveTitleRef.current = null;
    lastLiveSegmentIdRef.current = null;

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
      const inputGain = audioContext.createGain();
      inputGain.gain.value = dbToLinearGain(inputGainDbRef.current);

      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 2048;

      const processor = audioContext.createScriptProcessor(4096, 1, 1);
      const sink = audioContext.createGain();
      sink.gain.value = 0;

      source.connect(inputGain);
      inputGain.connect(analyser);
      analyser.connect(processor);
      processor.connect(sink);
      sink.connect(audioContext.destination);

      sourceNodeRef.current = source;
      inputGainNodeRef.current = inputGain;
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
              llm: draftSettings.llm,
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
      pendingLiveTitleRef.current = null;
      setLiveTitleOverride(null);
      lastLiveSegmentIdRef.current = null;
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

  const saveSettings = async (nextSettings?: AppSettings | null) => {
    const settingsToSave = nextSettings ?? draftSettings;
    if (!settingsToSave) {
      return;
    }
    setSavingSettings(true);
    try {
      const response = await apiFetch<SettingsResponse>("/api/settings", {
        method: "PUT",
        body: JSON.stringify(settingsToSave),
      });
      setSettingsResponse(response);
      setDraftSettings(response.settings);
      setUpdateIntervalDraft(String(response.settings.transcription.updateIntervalMs));
      setMeta(await apiFetch<MetaResponse>("/api/meta"));
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(
          JSON.stringify({
            type: "update_llm_settings",
            payload: response.settings.llm,
          }),
        );
      }
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

  const chooseRecordingsRoot = async () => {
    const baseSettings = settingsResponse?.settings ?? draftSettings;
    if (!baseSettings || hasActiveCapture) {
      return;
    }

    setChoosingRecordingsRoot(true);
    try {
      const response = await apiFetch<{ path?: string | null }>(
        "/api/system/pick-recordings-root",
        {
          method: "POST",
        },
      );
      if (!response.path) {
        return;
      }

      const nextSettings: AppSettings = {
        ...baseSettings,
        paths: {
          ...baseSettings.paths,
          tempRecordingsRoot: response.path,
        },
      };

      setDraftSettings(nextSettings);
      await saveSettings(nextSettings);
    } catch (pickError) {
      setError(
        pickError instanceof Error
          ? pickError.message
          : "Failed to choose the recordings folder.",
      );
    } finally {
      setChoosingRecordingsRoot(false);
    }
  };

  const copyTranscript = async () => {
    const plainText =
      activeTranscriptView === "minutes"
        ? minutesDraft
        : transcriptToPlainText(timelineSegmentsRef.current);
    await navigator.clipboard.writeText(plainText);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  const downloadTranscript = () => {
    const plainText = buildExportText(timelineSegmentsRef.current, minutesDraft);
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
    const plainText =
      activeTranscriptView === "minutes"
        ? minutesDraft
        : transcriptToPlainText(timelineSegmentsRef.current);
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

  const updateHistoryFromDetail = (detail: SessionDetail) => {
    setHistory((current) => {
      const summary = toSessionSummary(detail);
      const next = current.filter((entry) => entry.id !== detail.id);
      next.unshift(summary);
      return next;
    });
  };

  const saveMinutesMarkdown = async (sessionId: string, markdown: string) => {
    const detail = await apiFetch<SessionDetail>(`/api/sessions/${sessionId}/minutes`, {
      method: "PUT",
      body: JSON.stringify({ minutesMarkdown: markdown }),
    });
    updateHistoryFromDetail(detail);
    return detail;
  };

  const scheduleMinutesSave = (markdown: string) => {
    if (!selectedSessionId || status !== "idle") {
      return;
    }
    if (minutesSaveTimeoutRef.current !== null) {
      window.clearTimeout(minutesSaveTimeoutRef.current);
    }
    const sessionId = selectedSessionId;
    minutesSaveTimeoutRef.current = window.setTimeout(() => {
      minutesSaveTimeoutRef.current = null;
      void saveMinutesMarkdown(sessionId, markdown).catch((saveError) => {
        setError(
          saveError instanceof Error
            ? saveError.message
            : "Failed to save minutes.",
        );
      });
    }, 800);
  };

  const onMinutesEdit = (markdown: string) => {
    setMinutesDraft(markdown);
    scheduleMinutesSave(markdown);
  };

  const applyMinutesDetail = (detail: SessionDetail) => {
    updateHistoryFromDetail(detail);
    if (detail.id === selectedSessionId) {
      setTimelineSegments(sortSegments(detail.segments));
      setMinutesDraft(detail.minutesMarkdown ?? "");
      setCurrentAudioUrl(detail.audioUrl ?? null);
      setActiveTranscriptView("minutes");
    }
  };

  const generateMinutesForSession = async (sessionId: string) => {
    setMinutesProcessingIds((current) => [...new Set([...current, sessionId])]);
    try {
      const detail = await apiFetch<SessionDetail>(`/api/sessions/${sessionId}/minutes`, {
        method: "POST",
      });
      applyMinutesDetail(detail);
      await refreshHistory();
      return detail;
    } catch (minutesError) {
      setError(
        minutesError instanceof Error
          ? minutesError.message
          : "Failed to generate minutes.",
      );
      throw minutesError;
    } finally {
      setMinutesProcessingIds((current) =>
        current.filter((entry) => entry !== sessionId),
      );
    }
  };

  const generateMinutesForSessions = async (sessionIds: string[]) => {
    const requested = new Set(sessionIds);
    const candidates = [...allHistoryRecords]
      .filter(
        (record) =>
          requested.has(record.id) &&
          record.audioUrl &&
          (record.minutesStatus ?? "idle") !== "complete",
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));

    if (candidates.length === 0) {
      setError("未処理の録音ファイルがありません。");
      return;
    }

    for (const record of candidates) {
      await generateMinutesForSession(record.id);
    }
  };

  const deleteSession = async (sessionId: string) => {
    await deleteSessions([sessionId]);
  };

  const deleteSessions = async (sessionIds: string[]) => {
    const uniqueIds = [...new Set(sessionIds)];
    if (uniqueIds.length === 0) {
      return;
    }

    const titles = uniqueIds.map(
      (sessionId) =>
        history.find((session) => session.id === sessionId)?.title ?? sessionId,
    );
    const previewTitles = titles.slice(0, 6).map((title) => `- ${title}`);
    if (titles.length > previewTitles.length) {
      previewTitles.push(`- ...and ${titles.length - previewTitles.length} more`);
    }
    const confirmed = window.confirm(
      uniqueIds.length === 1
        ? `Delete "${titles[0]}"?`
        : `Delete ${uniqueIds.length} selected records?\n\n${previewTitles.join("\n")}`,
    );
    if (!confirmed) {
      return;
    }

    try {
      for (const sessionId of uniqueIds) {
        await apiFetch<{ deleted: boolean }>(`/api/sessions/${sessionId}`, {
          method: "DELETE",
        });
      }
    } catch (deleteError) {
      setError(
        deleteError instanceof Error
          ? deleteError.message
          : "Failed to delete the selected records.",
      );
      await refreshHistory();
      return;
    }

    setSidebarSelectedRecordIds((current) =>
      current.filter((sessionId) => !uniqueIds.includes(sessionId)),
    );

    const sessions = await refreshHistory();
    if (selectedSessionId && uniqueIds.includes(selectedSessionId)) {
      const fallback = sessions[0];
      if (fallback) {
        await loadSession(fallback.id);
      } else {
        setSelectedSessionId(null);
        setTimelineSegments([]);
        setMinutesDraft("");
        setActiveTranscriptView("realtime");
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

  const renameSpeaker = (speakerIndex: number, currentLabel: string) => {
    const requestedName = window.prompt(
      "Rename this speaker across the transcript",
      currentLabel,
    );
    if (requestedName === null) {
      return;
    }

    const nextLabel = normalizeSpeakerName(requestedName, currentLabel);
    speakerNameOverridesRef.current.set(speakerIndex, nextLabel);
    const affectedSegmentIds = timelineSegmentsRef.current
      .filter((segment) => segment.speakerIndex === speakerIndex)
      .map((segment) => segment.id);
    if (statusRef.current === "idle" && selectedSessionId) {
      affectedSegmentIds.forEach((segmentId) => {
        dirtySegmentIdsRef.current.add(segmentId);
      });
    }
    setTimelineSegments((current) =>
      current.map((segment) =>
        segment.speakerIndex === speakerIndex
          ? { ...segment, speakerLabel: nextLabel, updatedAt: new Date().toISOString() }
          : segment,
      ),
    );
    setEditVersion((version) => version + 1);
  };

  const playSegmentAudio = async (startedAt: number) => {
    const audio = audioPlayerRef.current;
    if (!audio || !currentAudioUrl || status !== "idle") {
      return;
    }

    const nextTime = Math.max(0, startedAt - SEGMENT_AUDIO_PREROLL_SECONDS);
    try {
      audio.pause();
      audio.currentTime = nextTime;
      await audio.play();
    } catch (playError) {
      setError(
        playError instanceof Error
          ? playError.message
          : "Unable to start audio playback for this segment.",
      );
    }
  };

  const openRecordingInExplorer = async (sessionId: string) => {
    setOpeningRecordingId(sessionId);
    try {
      await apiFetch<{ opened: boolean }>(`/api/sessions/${sessionId}/open-recording`, {
        method: "POST",
      });
    } catch (openError) {
      setError(
        openError instanceof Error
          ? openError.message
          : "Failed to open the recording in Explorer.",
      );
    } finally {
      setOpeningRecordingId((current) => (current === sessionId ? null : current));
    }
  };

  const toggleSidebarRecordSelection = (sessionId: string) => {
    lastSidebarSelectedRecordIdRef.current = sessionId;
    setSidebarSelectedRecordIds((current) =>
      current.includes(sessionId)
        ? current.filter((entry) => entry !== sessionId)
        : [...current, sessionId],
    );
  };

  const updateDraftSettings = (updater: (current: AppSettings) => AppSettings) => {
    setDraftSettings((current) => (current ? updater(current) : current));
  };

  const activeModelOptions =
    meta?.availableModelsByLanguage[draftSettings?.transcription.language ?? "ja"] ??
    ["tiny"];
  const appReady = Boolean(draftSettings && meta);
  const hasActiveCapture = status !== "idle" && status !== "error";
  const generatedLiveTitle = formatSessionTitle(liveSessionStartedAt);
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
        title: liveTitleOverride?.trim() || generatedLiveTitle,
        createdAt: liveSessionStartedAt ?? new Date().toISOString(),
        language: draftSettings?.transcription.language ?? "ja",
        deviceLabel: selectedDevice?.label || "Current microphone",
        durationSeconds: totalDuration,
        lineCount: timelineSegments.length,
        audioUrl: null,
        summary: selectedDevice?.label || "Live capture",
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
  const minutesAvailable = minutesDraft.trim().length > 0;
  const exportAvailable = transcriptAvailable || minutesAvailable;
  const showAudioPlayer = Boolean(currentAudioUrl && status === "idle");
  const canGenerateSelectedMinutes = Boolean(
    selectedSessionId && currentAudioUrl && status === "idle",
  );
  const selectedMinutesProcessing = Boolean(
    selectedSessionId && minutesProcessingIds.includes(selectedSessionId),
  );
  const canDeleteSelectedSession = Boolean(selectedSessionId && !hasActiveCapture);
  const activeTitle = activeRecord?.title ?? "Voice2Text Workspace";
  const renderedMinutesHtml = renderMarkdown(minutesDraft);
  const transcriptGridClass = showLlmRefined
    ? TRANSCRIPT_GRID_CLASS
    : "lg:grid lg:grid-cols-[88px_132px_minmax(0,1fr)] lg:gap-4";
  const inputGainDialAngle = gainDbToDialAngle(inputGainDb);
  const inputGainSweepDegrees =
    ((inputGainDb - INPUT_GAIN_MIN_DB) /
      (INPUT_GAIN_MAX_DB - INPUT_GAIN_MIN_DB)) *
    INPUT_GAIN_DIAL_SWEEP_DEG;
  const sidebarHistoryRecordMap = new Map(
    historyRecords.map((record) => [record.id, record] as const),
  );
  const validSidebarSelectedRecordIds = sidebarSelectedRecordIds.filter((sessionId) =>
    sidebarHistoryRecordMap.has(sessionId),
  );
  const sidebarSelectedRecordIdSet = new Set(validSidebarSelectedRecordIds);
  const sidebarContextRecord = sidebarContextMenu
    ? sidebarHistoryRecordMap.get(sidebarContextMenu.recordId) ?? null
    : null;
  const sidebarContextRecordIsSelected = sidebarContextRecord
    ? sidebarSelectedRecordIdSet.has(sidebarContextRecord.id)
    : false;
  const sidebarContextDeleteIds =
    sidebarContextRecord && validSidebarSelectedRecordIds.length > 0
      ? validSidebarSelectedRecordIds
      : sidebarContextRecord
        ? [sidebarContextRecord.id]
        : [];
  const sidebarContextActionIds = sidebarContextDeleteIds;
  const sidebarContextMinutesCount = sidebarContextActionIds.filter((sessionId) => {
    const record = sidebarHistoryRecordMap.get(sessionId);
    return (
      record?.audioUrl &&
      (record.minutesStatus ?? "idle") !== "complete" &&
      !minutesProcessingIds.includes(sessionId)
    );
  }).length;

  const selectSidebarRecordRange = (targetId: string) => {
    const orderedIds = historyRecords.map((record) => record.id);
    const targetIndex = orderedIds.indexOf(targetId);
    if (targetIndex === -1) {
      return;
    }

    const anchorIndex = lastSidebarSelectedRecordIdRef.current
      ? orderedIds.indexOf(lastSidebarSelectedRecordIdRef.current)
      : -1;
    if (anchorIndex === -1) {
      setSidebarSelectedRecordIds([targetId]);
      lastSidebarSelectedRecordIdRef.current = targetId;
      return;
    }

    const start = Math.min(anchorIndex, targetIndex);
    const end = Math.max(anchorIndex, targetIndex);
    const rangeIds = orderedIds.slice(start, end + 1);
    setSidebarSelectedRecordIds((current) => [...new Set([...current, ...rangeIds])]);
    lastSidebarSelectedRecordIdRef.current = targetId;
  };

  const handleSidebarRecordClick = (
    record: RecordView,
    event: MouseEvent<HTMLButtonElement>,
  ) => {
    setSidebarContextMenu(null);
    if (record.kind !== "history") {
      setSidebarSelectedRecordIds([]);
      lastSidebarSelectedRecordIdRef.current = null;
      return;
    }

    if (event.shiftKey) {
      event.preventDefault();
      selectSidebarRecordRange(record.id);
      return;
    }

    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      toggleSidebarRecordSelection(record.id);
      return;
    }

    setSidebarSelectedRecordIds([]);
    lastSidebarSelectedRecordIdRef.current = record.id;
    setRecordsOpen(false);
    void loadSession(record.id);
  };

  const adjustInputGain = (deltaDb: number) => {
    setInputGainDb((current) => clampInputGainDb(current + deltaDb));
  };

  const updateInputGainFromPointer = (
    element: HTMLButtonElement,
    clientX: number,
    clientY: number,
  ) => {
    const rect = element.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const angle = (Math.atan2(clientY - centerY, clientX - centerX) * 180) / Math.PI + 90;
    setInputGainDb(angleToInputGainDb(angle));
  };

  const handleInputGainDialPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    updateInputGainFromPointer(event.currentTarget, event.clientX, event.clientY);
  };

  const handleInputGainDialPointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) {
      return;
    }
    updateInputGainFromPointer(event.currentTarget, event.clientX, event.clientY);
  };

  const handleInputGainDialPointerUp = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const handleInputGainDialKeyDown = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) => {
    if (event.key === "ArrowRight" || event.key === "ArrowUp") {
      event.preventDefault();
      adjustInputGain(INPUT_GAIN_STEP_DB);
    } else if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
      event.preventDefault();
      adjustInputGain(-INPUT_GAIN_STEP_DB);
    } else if (event.key === "Home") {
      event.preventDefault();
      setInputGainDb(INPUT_GAIN_MIN_DB);
    } else if (event.key === "End") {
      event.preventDefault();
      setInputGainDb(INPUT_GAIN_MAX_DB);
    }
  };

  const updateSidebarWidthFromPointer = (clientX: number) => {
    const panel = recordsPanelRef.current;
    if (!panel) {
      return;
    }

    const panelLeft = panel.getBoundingClientRect().left;
    setSidebarWidth(
      clampNumber(clientX - panelLeft, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH),
    );
  };

  const handleSidebarResizePointerDown = (
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    updateSidebarWidthFromPointer(event.clientX);
  };

  const handleSidebarResizePointerMove = (
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) {
      return;
    }
    updateSidebarWidthFromPointer(event.clientX);
  };

  const handleSidebarResizePointerUp = (
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const updateMinutesSplitFromPointer = (clientX: number) => {
    const split = minutesSplitRef.current;
    if (!split) {
      return;
    }

    const rect = split.getBoundingClientRect();
    const maxEditorWidth = Math.max(
      MINUTES_PANE_MIN_WIDTH,
      rect.width - MINUTES_PANE_MIN_WIDTH,
    );
    const editorWidth = clampNumber(
      clientX - rect.left,
      MINUTES_PANE_MIN_WIDTH,
      maxEditorWidth,
    );
    setMinutesEditorPercent((editorWidth / rect.width) * 100);
  };

  const handleMinutesResizePointerDown = (
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    updateMinutesSplitFromPointer(event.clientX);
  };

  const handleMinutesResizePointerMove = (
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) {
      return;
    }
    updateMinutesSplitFromPointer(event.clientX);
  };

  const handleMinutesResizePointerUp = (
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  useEffect(() => {
    if (!sidebarContextMenu) {
      return;
    }

    const closeContextMenu = () => {
      setSidebarContextMenu(null);
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeContextMenu();
      }
    };

    window.addEventListener("pointerdown", closeContextMenu);
    window.addEventListener("resize", closeContextMenu);
    window.addEventListener("keydown", handleEscape);
    return () => {
      window.removeEventListener("pointerdown", closeContextMenu);
      window.removeEventListener("resize", closeContextMenu);
      window.removeEventListener("keydown", handleEscape);
    };
  }, [sidebarContextMenu]);

  useEffect(() => {
    if (!hasActiveCapture || deferredSegments.length === 0) {
      return;
    }

    const container = transcriptScrollRef.current;
    if (!container) {
      return;
    }

    const latestIncomplete =
      [...deferredSegments].reverse().find((segment) => !segment.isComplete) ??
      deferredSegments.at(-1) ??
      null;
    const preferredId =
      (lastLiveSegmentIdRef.current &&
        deferredSegments.some((segment) => segment.id === lastLiveSegmentIdRef.current) &&
        lastLiveSegmentIdRef.current) ||
      latestIncomplete?.id ||
      null;

    if (!preferredId) {
      return;
    }

    const targetElement = segmentRowRefs.current.get(preferredId);
    if (!targetElement) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      const containerRect = container.getBoundingClientRect();
      const targetRect = targetElement.getBoundingClientRect();
      const targetTop = targetRect.top - containerRect.top + container.scrollTop;
      const desiredTop = container.clientHeight * 0.78;
      const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
      const nextScrollTop = Math.min(
        maxScrollTop,
        Math.max(0, targetTop - desiredTop),
      );

      if (Math.abs(container.scrollTop - nextScrollTop) > 4) {
        container.scrollTo({
          top: nextScrollTop,
          behavior: status === "recording" ? "smooth" : "auto",
        });
      }
    });

    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [deferredSegments, hasActiveCapture, status]);

  const beginTitleEdit = () => {
    setTitleDraft(activeTitle);
    setIsEditingTitle(true);
  };

  const cancelTitleEdit = () => {
    setTitleDraft(activeTitle);
    setIsEditingTitle(false);
  };

  const saveTitle = async () => {
    const nextTitle = normalizeTitleInput(titleDraft, activeTitle);
    setTitleDraft(nextTitle);
    setSavingTitle(true);

    try {
      if (hasActiveCapture) {
        setLiveTitleOverride(nextTitle);
        pendingLiveTitleRef.current = nextTitle;
        setIsEditingTitle(false);
        return;
      }

      if (!selectedSessionId) {
        setIsEditingTitle(false);
        return;
      }

      const detail = await updateSessionTitle(selectedSessionId, nextTitle);
      setTitleDraft(detail.title);
      setIsEditingTitle(false);
    } catch (saveError) {
      setError(
        saveError instanceof Error ? saveError.message : "Failed to save the title.",
      );
    } finally {
      setSavingTitle(false);
    }
  };

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
        ref={recordsPanelRef}
        style={{ width: sidebarWidth }}
        className={`fixed inset-y-0 left-0 z-40 flex max-w-[88vw] flex-col border-r border-slate-200 bg-[#f8f9fb] transition-transform duration-300 md:static md:z-auto md:max-w-none md:translate-x-0 ${
          recordsOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="border-b border-slate-200 px-4 py-3">
          <div className="flex items-center gap-2">
            <Button
              className="min-w-[6.75rem] rounded-lg px-3 py-2.5"
              onClick={() => void startRecording()}
              disabled={!appReady || hasActiveCapture}
            >
              {status === "connecting" ? (
                <LoaderCircle className="size-4 animate-spin" />
              ) : (
                <Mic className="size-4" />
              )}
              {hasActiveCapture ? STATUS_LABELS[status] : appReady ? "New" : "Wait"}
            </Button>
            <button
              type="button"
              onClick={() => void refreshHistory()}
              className="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-500 transition-colors hover:border-slate-300 hover:text-slate-700"
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
              className="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-500 transition-colors hover:border-slate-300 hover:text-slate-700"
              aria-label="Toggle sort order"
            >
              <SlidersHorizontal className="size-4" />
            </button>
            <button
              type="button"
              onClick={() => void chooseRecordingsRoot()}
              disabled={!draftSettings || hasActiveCapture || savingSettings}
              title={
                settingsResponse?.resolvedPaths.tempRecordingsRoot ??
                draftSettings?.paths.tempRecordingsRoot
              }
              className="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-500 transition-colors hover:border-slate-300 hover:text-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
              aria-label="Choose recordings folder"
            >
              {choosingRecordingsRoot ? (
                <LoaderCircle className="size-4 animate-spin" />
              ) : (
                <Save className="size-4" />
              )}
            </button>
          </div>
          <label className="relative mt-3 block">
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
              const isBulkSelected =
                record.kind === "history" && sidebarSelectedRecordIdSet.has(record.id);
              const badgeClass =
                record.kind === "live"
                  ? "bg-blue-50 text-[#007aff]"
                  : "bg-slate-100 text-slate-500";
              return (
                <div
                  key={record.id}
                  className={`border-b border-slate-100 ${
                    isSelected
                      ? "border-l-2 border-l-[#007aff] bg-white"
                      : isBulkSelected
                        ? "bg-[#eef5ff]"
                        : ""
                  }`}
                  onContextMenu={(event) => {
                    if (record.kind !== "history" || isDisabled) {
                      return;
                    }
                    event.preventDefault();
                    if (!sidebarSelectedRecordIdSet.has(record.id)) {
                      setSidebarSelectedRecordIds([record.id]);
                      lastSidebarSelectedRecordIdRef.current = record.id;
                    }
                    setSidebarContextMenu({
                      recordId: record.id,
                      x: event.clientX,
                      y: event.clientY,
                    });
                  }}
                >
                  <div className="flex items-start gap-3 px-4 py-3">
                    {record.kind === "history" ? (
                      <button
                        type="button"
                        disabled={isDisabled}
                        onClick={() => toggleSidebarRecordSelection(record.id)}
                        className={`mt-6 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md border transition-colors ${
                          isBulkSelected
                            ? "border-[#007aff] bg-[#007aff] text-white"
                            : "border-slate-200 bg-white text-transparent hover:border-slate-300 hover:text-slate-300"
                        } ${isDisabled ? "cursor-not-allowed opacity-60" : ""}`}
                        aria-label={
                          isBulkSelected
                            ? `Deselect ${record.title}`
                            : `Select ${record.title}`
                        }
                      >
                        <Check className="size-3.5" />
                      </button>
                    ) : null}
                    <button
                      type="button"
                      disabled={isDisabled}
                      onClick={(event) => handleSidebarRecordClick(record, event)}
                      className={`min-w-0 flex-1 text-left transition-colors ${
                        isDisabled
                          ? "cursor-not-allowed opacity-60"
                          : "hover:text-slate-950 active:text-slate-950"
                      }`}
                    >
                      <div className="mb-1 flex items-center gap-3">
                        <span
                          className={`app-mono inline-flex rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-[0.18em] ${badgeClass}`}
                        >
                          {record.badgeLabel}
                        </span>
                      </div>
                      <h3 className="truncate text-sm font-semibold text-slate-900">
                        {record.title}
                      </h3>
                    </button>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      <span className="app-mono text-[10px] tracking-[0.12em] text-slate-400">
                        {formatSidebarDate(record.createdAt)}
                      </span>
                      {isBulkSelected ? (
                        <span className="app-mono text-[10px] tracking-[0.12em] text-[#007aff]">
                          Selected
                        </span>
                      ) : (
                        <div aria-hidden className="h-[14px]" />
                      )}
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>

        <div className="border-t border-slate-200 px-4 py-3">
          <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-slate-400">
            Recorded Audio
          </p>
          {showAudioPlayer ? (
            <>
              <p className="mt-1 truncate text-sm font-medium text-slate-900">
                {selectedHistoryRecord?.title ?? activeTitle}
              </p>
              <audio
                ref={audioPlayerRef}
                controls
                className="mt-2 w-full"
                src={currentAudioUrl ?? ""}
              />
            </>
          ) : (
            <p className="mt-2 text-sm leading-6 text-slate-500">
              Select a saved record to listen to the captured audio.
            </p>
          )}
        </div>
      </aside>

      <div
        role="separator"
        aria-label="Resize records panel"
        aria-orientation="vertical"
        tabIndex={-1}
        onPointerDown={handleSidebarResizePointerDown}
        onPointerMove={handleSidebarResizePointerMove}
        onPointerUp={handleSidebarResizePointerUp}
        onPointerCancel={handleSidebarResizePointerUp}
        className="group hidden w-2 shrink-0 touch-none cursor-col-resize items-stretch justify-center bg-white md:flex"
      >
        <div className="h-full w-px bg-slate-200 transition-colors group-hover:bg-[#007aff] group-active:bg-[#007aff]" />
      </div>

      <section className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <header className="flex h-16 flex-shrink-0 items-center justify-between border-b border-slate-200 bg-white/90 px-4 backdrop-blur-sm sm:px-6 lg:px-8">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <button
              type="button"
              onClick={() => setRecordsOpen(true)}
              className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-600 md:hidden"
              aria-label="Open records"
            >
              <FolderOpen className="size-5" />
            </button>
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 max-w-[56rem] items-center gap-2">
                {isEditingTitle ? (
                  <input
                    value={titleDraft}
                    onChange={(event) => setTitleDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        void saveTitle();
                      }
                      if (event.key === "Escape") {
                        event.preventDefault();
                        cancelTitleEdit();
                      }
                    }}
                    className="min-w-0 flex-1 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-lg font-bold text-slate-900 outline-none focus:border-[#007aff] focus:ring-4 focus:ring-[#007aff]/10"
                    placeholder="Session title"
                  />
                ) : (
                  <h1 className="truncate text-lg font-bold text-slate-900 sm:text-xl">
                    {activeTitle}
                  </h1>
                )}
                {isEditingTitle ? (
                  <>
                    <button
                      type="button"
                      onClick={() => void saveTitle()}
                      disabled={savingTitle}
                      className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-500 transition-colors hover:border-slate-300 hover:text-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
                      aria-label="Save title"
                    >
                      {savingTitle ? (
                        <LoaderCircle className="size-4 animate-spin" />
                      ) : (
                        <Save className="size-4" />
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={cancelTitleEdit}
                      className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-500 transition-colors hover:border-slate-300 hover:text-slate-700"
                      aria-label="Cancel title edit"
                    >
                      <X className="size-4" />
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={beginTitleEdit}
                    className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-500 transition-colors hover:border-slate-300 hover:text-slate-700"
                    aria-label="Edit title"
                  >
                    <Pencil className="size-4" />
                  </button>
                )}
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-slate-500">
                <span>{formatHeaderDate(activeRecord?.createdAt)}</span>
                <span className="hidden h-4 w-px bg-slate-200 sm:block" />
                <span className="app-mono text-[11px] uppercase tracking-[0.24em] text-slate-400">
                  {formatReference(activeRecord?.id ?? currentSessionId)}
                </span>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {selectedSessionId ? (
              <div className="inline-flex rounded-xl border border-slate-200 bg-white p-1">
                <button
                  type="button"
                  onClick={() => setActiveTranscriptView("realtime")}
                  className={`inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-sm font-semibold transition-colors ${
                    activeTranscriptView === "realtime"
                      ? "bg-[#007aff] text-white"
                      : "text-[#007aff] hover:bg-[#007aff]/10"
                  }`}
                >
                  <AlignLeft className="size-3.5" />
                  リアルタイム
                </button>
                <button
                  type="button"
                  onClick={() => setActiveTranscriptView("minutes")}
                  className={`inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-sm font-semibold transition-colors ${
                    activeTranscriptView === "minutes"
                      ? "bg-[#007aff] text-white"
                      : "text-[#007aff] hover:bg-[#007aff]/10"
                  }`}
                >
                  <FileText className="size-3.5" />
                  ミニッツ
                </button>
              </div>
            ) : null}
            <button
              type="button"
              onClick={() => void copyTranscript()}
              disabled={!exportAvailable}
              className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-500 transition-colors hover:border-slate-300 hover:text-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
              aria-label="Copy transcript"
            >
              {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
            </button>
            <button
              type="button"
              onClick={() => void downloadTranscript()}
              disabled={!exportAvailable}
              className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-500 transition-colors hover:border-slate-300 hover:text-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
              aria-label="Download transcript"
            >
              <Download className="size-4" />
            </button>
            <button
              type="button"
              onClick={() => void shareTranscript()}
              disabled={!exportAvailable}
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

        <div
          ref={transcriptScrollRef}
          className="app-scrollbar flex-1 overflow-y-auto px-4 py-6 sm:px-6 lg:px-8"
        >
          {activeTranscriptView === "minutes" ? (
            <div
              ref={minutesSplitRef}
              className="mx-auto flex w-full max-w-[1380px] flex-col overflow-hidden pb-10 lg:min-h-[calc(100vh-12rem)] lg:flex-row"
            >
              <section
                className="flex min-h-[26rem] min-w-0 flex-col bg-white lg:min-h-0"
                style={{ flexBasis: `${minutesEditorPercent}%` }}
              >
                <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2">
                  <div className="flex items-center gap-2 text-xs font-semibold text-slate-500">
                    <FileText className="size-4" />
                    Markdown Editor
                  </div>
                  <button
                    type="button"
                    onClick={() => void copyTranscript()}
                    disabled={!minutesDraft.trim()}
                    className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-semibold text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                    Copy All
                  </button>
                </div>
                <textarea
                  value={minutesDraft}
                  onChange={(event) => onMinutesEdit(event.target.value)}
                  className="app-scrollbar min-h-[26rem] flex-1 resize-none bg-white p-4 font-mono text-sm leading-7 text-slate-700 outline-none lg:min-h-0"
                  placeholder="一括文字起こし整形を実行すると、Markdown形式のミニッツがここに表示されます。"
                  spellCheck={false}
                />
              </section>
              <div
                role="separator"
                aria-label="Resize Markdown and preview panes"
                aria-orientation="vertical"
                tabIndex={-1}
                onPointerDown={handleMinutesResizePointerDown}
                onPointerMove={handleMinutesResizePointerMove}
                onPointerUp={handleMinutesResizePointerUp}
                onPointerCancel={handleMinutesResizePointerUp}
                className="group hidden w-3 shrink-0 touch-none cursor-col-resize items-stretch justify-center bg-white lg:flex"
              >
                <div className="h-full w-px bg-slate-200 transition-colors group-hover:bg-[#007aff] group-active:bg-[#007aff]" />
              </div>
              <section
                className="flex min-h-[26rem] min-w-0 flex-col border-t border-slate-200 bg-white lg:min-h-0 lg:border-t-0"
                style={{ flexBasis: `${100 - minutesEditorPercent}%` }}
              >
                <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-2 text-xs font-semibold text-slate-500">
                  <AlignLeft className="size-4" />
                  Preview
                </div>
                <div
                  className="markdown-preview flex-1 overflow-y-auto p-6 text-sm leading-7 text-slate-700"
                  dangerouslySetInnerHTML={{ __html: renderedMinutesHtml }}
                />
              </section>
            </div>
          ) : (
          <div className="mx-auto w-full max-w-[1380px] pb-10">
            <div
              className={`hidden border-b border-slate-200 pb-3 text-[10px] font-bold uppercase tracking-[0.24em] text-slate-400 ${transcriptGridClass}`}
            >
              <div>Speaker</div>
              <div>Time</div>
              <div className="flex items-center gap-2">
                <span>Transcript Text</span>
                {!showLlmRefined ? (
                  <button
                    type="button"
                    onClick={() => setShowLlmRefined(true)}
                    className="rounded-full border border-[#007aff] px-2 py-0.5 text-[10px] font-bold text-[#007aff]"
                    aria-label="Show LLM Refined column"
                  >
                    LLM
                  </button>
                ) : null}
              </div>
              {showLlmRefined ? (
                <div className="flex items-center gap-2">
                  <span>LLM Refined</span>
                  <button
                    type="button"
                    onClick={() => setShowLlmRefined((current) => !current)}
                    className="relative h-4 w-7 rounded-full bg-[#007aff]"
                    aria-label="Hide LLM Refined column"
                  >
                    <span className="absolute right-0.5 top-0.5 h-3 w-3 rounded-full bg-white" />
                  </button>
                </div>
              ) : null}
            </div>

            <div>
              <AnimatePresence initial={false}>
                {deferredSegments.length === 0 ? (
                  <motion.div
                    initial={{ opacity: 0, y: 16 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    className="py-14 text-center text-sm leading-7 text-slate-500"
                  >
                    The transcript will appear here once a live capture starts or an
                    existing record is opened.
                  </motion.div>
                ) : (
                  deferredSegments.map((segment) => (
                    <motion.article
                      key={segment.id}
                      ref={(node) => {
                        if (node) {
                          segmentRowRefs.current.set(segment.id, node);
                        } else {
                          segmentRowRefs.current.delete(segment.id);
                        }
                      }}
                      layout
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -8 }}
                      transition={{ duration: 0.18, ease: "easeOut" }}
                      className={`border-b border-slate-100 py-1.5 ${transcriptGridClass}`}
                    >
                      <div className="flex items-center justify-between gap-2 lg:block">
                        <div className="flex items-center gap-1">
                          <p
                            className="truncate text-[11px] font-semibold text-slate-900"
                            title={segment.speakerLabel}
                          >
                            {segment.speakerLabel}
                          </p>
                          <button
                            type="button"
                            onClick={() =>
                              renameSpeaker(segment.speakerIndex, segment.speakerLabel)
                            }
                            className="inline-flex h-5 w-5 items-center justify-center rounded text-slate-300 transition-colors hover:bg-slate-100 hover:text-slate-500"
                            aria-label={`Rename speaker ${segment.speakerLabel}`}
                          >
                            <Pencil className="size-3" />
                          </button>
                        </div>
                        <span className="app-mono text-[11px] font-semibold text-slate-500 lg:hidden">
                          {formatLongClock(segment.startedAt)}
                        </span>
                      </div>

                      <div className="mt-1 app-mono text-[11px] text-slate-400 lg:mt-0">
                        <div className="flex items-center gap-2">
                          <p className="font-semibold text-slate-500">
                            {formatLongClock(segment.startedAt)}
                          </p>
                          {showAudioPlayer ? (
                            <button
                              type="button"
                              onClick={() => void playSegmentAudio(segment.startedAt)}
                              className="inline-flex h-6 w-6 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-400 transition-colors hover:border-slate-300 hover:text-slate-600"
                              aria-label={`Play audio near ${formatLongClock(segment.startedAt)}`}
                            >
                              <Play className="ml-0.5 size-3" />
                            </button>
                          ) : null}
                        </div>
                      </div>

                      <div className="mt-1 min-w-0 lg:mt-0">
                        <textarea
                          value={segment.text}
                          rows={Math.max(
                            1,
                            Math.ceil(Math.max(segment.text.length, 1) / 340),
                          )}
                          onChange={(event) =>
                            onSegmentEdit(segment.id, event.target.value)
                          }
                          className="w-full resize-none border-0 bg-transparent px-0 py-0 text-slate-900 outline-none transition focus:bg-[#f8fbff]"
                          style={{
                            fontSize: "11px",
                            fontWeight: 600,
                            lineHeight: "16px",
                          }}
                        />
                      </div>

                      {showLlmRefined ? (
                        <div className="mt-2 min-w-0 rounded-lg bg-slate-50 px-3 py-2 lg:mt-0">
                          {segment.llmStatus === "pending" ? (
                            <p className="text-[11px] font-semibold text-slate-400">
                              Refining with {segment.llmModel ?? "Gemma"}
                            </p>
                          ) : segment.llmStatus === "error" ? (
                            <p
                              className="text-[11px] font-semibold text-rose-500"
                              title={segment.llmError ?? undefined}
                            >
                              LLM refinement failed
                            </p>
                          ) : segment.llmText ? (
                            <>
                              <p
                                className="whitespace-pre-wrap text-slate-900"
                                style={{
                                  fontSize: "11px",
                                  fontWeight: 600,
                                  lineHeight: "16px",
                                }}
                              >
                                {segment.llmText}
                              </p>
                              <p className="mt-1 app-mono text-[10px] font-semibold text-slate-400">
                                {segment.llmModel}
                                {segment.llmLatencyMs
                                  ? ` / ${segment.llmLatencyMs} ms`
                                  : ""}
                              </p>
                            </>
                          ) : segment.llmStatus === "complete" ? (
                            <p className="text-[11px] font-semibold text-slate-300">
                              Included in block above
                            </p>
                          ) : (
                            <p className="text-[11px] font-semibold text-slate-300">
                              Not refined
                            </p>
                          )}
                        </div>
                      ) : null}
                    </motion.article>
                  ))
                )}
              </AnimatePresence>
              {hasActiveCapture ? <div aria-hidden className="h-[24vh]" /> : null}
            </div>
          </div>
          )}
        </div>

        <footer className="border-t border-slate-200 bg-white px-4 py-4 shadow-[0_-4px_20px_rgba(15,23,42,0.03)] sm:px-6 lg:px-8">
          <div className="mx-auto flex w-full max-w-[1380px] flex-wrap items-center gap-4">
            <div className="flex min-w-[172px] items-center gap-3">
              <button
                type="button"
                onPointerDown={handleInputGainDialPointerDown}
                onPointerMove={handleInputGainDialPointerMove}
                onPointerUp={handleInputGainDialPointerUp}
                onPointerCancel={handleInputGainDialPointerUp}
                onKeyDown={handleInputGainDialKeyDown}
                className="relative h-14 w-14 shrink-0 touch-none rounded-full border border-slate-200 shadow-sm outline-none transition hover:border-slate-300 focus:ring-2 focus:ring-[#007aff]/20"
                style={{
                  background: `conic-gradient(from 210deg, rgba(0,122,255,0.95) 0deg ${inputGainSweepDegrees}deg, rgba(226,232,240,0.95) ${inputGainSweepDegrees}deg ${INPUT_GAIN_DIAL_SWEEP_DEG}deg, transparent ${INPUT_GAIN_DIAL_SWEEP_DEG}deg 360deg)`,
                }}
                aria-label={`Input gain ${formatInputGainDb(inputGainDb)}. Drag the knob to adjust gain.`}
                title="Drag to adjust gain"
              >
                <span className="absolute inset-1.5 rounded-full bg-white shadow-inner" />
                <span
                  className="absolute inset-0"
                  style={{ transform: `rotate(${inputGainDialAngle}deg)` }}
                >
                  <span className="absolute left-1/2 top-2 h-5 w-0.5 -translate-x-1/2 rounded-full bg-slate-950" />
                </span>
                <span className="absolute left-1/2 top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-slate-950" />
              </button>
              <div className="min-w-0">
                <p className="text-[10px] font-bold uppercase tracking-[0.24em] text-slate-400">
                  Gain
                </p>
                <p className="app-mono mt-1 text-sm font-semibold tabular-nums text-slate-900">
                  {formatInputGainDb(inputGainDb)}
                </p>
                <p className="mt-0.5 text-[10px] text-slate-400">Drag to boost</p>
              </div>
            </div>

            <div className="min-w-[200px] flex-1 max-w-[320px]">
              <WaveformCanvas
                samples={waveform}
                status={status}
                width={560}
                height={56}
                className="h-14 w-full rounded-xl border border-slate-200 bg-white"
              />
            </div>

            <div className="flex shrink-0 items-center gap-3">
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

            {canGenerateSelectedMinutes ? (
              <button
                type="button"
                onClick={() =>
                  selectedSessionId && void generateMinutesForSession(selectedSessionId)
                }
                disabled={selectedMinutesProcessing}
                className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-[#007aff] bg-white px-4 text-sm font-semibold text-[#007aff] transition-colors hover:bg-[#007aff]/10 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {selectedMinutesProcessing ? (
                  <LoaderCircle className="size-4 animate-spin" />
                ) : (
                  <FileText className="size-4" />
                )}
                文字起こし整形
              </button>
            ) : null}

            <div className="ml-auto flex items-center">
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
                                  batchMoonshineModelPreset: nextModel,
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
                          <label className="field-label">Batch Engine</label>
                          <select
                            value={draftSettings.transcription.batchTranscriptionEngine}
                            onChange={(event) =>
                              updateDraftSettings((current) => ({
                                ...current,
                                transcription: {
                                  ...current.transcription,
                                  batchTranscriptionEngine: event.target.value as
                                    | "faster-whisper"
                                    | "moonshine",
                                },
                              }))
                            }
                            className="field-input"
                          >
                            {(meta?.batchTranscriptionEngines ?? [
                              "faster-whisper",
                              "moonshine",
                            ]).map((engine) => (
                              <option key={engine} value={engine}>
                                {BATCH_ENGINE_LABELS[engine] ?? engine}
                              </option>
                            ))}
                          </select>
                          <p className="text-xs leading-5 text-slate-500">
                            Used by the saved-audio transcript refinement button.
                          </p>
                        </div>

                        <div className="space-y-2">
                          <label className="field-label">Batch Model</label>
                          {draftSettings.transcription.batchTranscriptionEngine ===
                          "moonshine" ? (
                            <select
                              value={draftSettings.transcription.batchMoonshineModelPreset}
                              onChange={(event) =>
                                updateDraftSettings((current) => ({
                                  ...current,
                                  transcription: {
                                    ...current.transcription,
                                    batchMoonshineModelPreset: event.target.value,
                                  },
                                }))
                              }
                              className="field-input"
                            >
                              {activeModelOptions.map((preset) => (
                                <option key={preset} value={preset}>
                                  Moonshine {preset}
                                </option>
                              ))}
                            </select>
                          ) : (
                            <select
                              value={draftSettings.transcription.fasterWhisperModel}
                              onChange={(event) =>
                                updateDraftSettings((current) => ({
                                  ...current,
                                  transcription: {
                                    ...current.transcription,
                                    fasterWhisperModel: event.target.value,
                                  },
                                }))
                              }
                              className="field-input"
                            >
                              {(meta?.fasterWhisperModels ?? [
                                "tiny",
                                "base",
                                "small",
                                "medium",
                                "large-v3",
                              ]).map((model) => (
                                <option key={model} value={model}>
                                  Faster Whisper {model}
                                </option>
                              ))}
                            </select>
                          )}
                          <p className="text-xs leading-5 text-slate-500">
                            Faster Whisper models are stored under LocalAppData, not
                            OneDrive.
                          </p>
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
                            type="text"
                            inputMode="numeric"
                            value={updateIntervalDraft}
                            onChange={(event) => {
                              const rawValue = event.target.value.replace(/[^\d]/g, "");
                              setUpdateIntervalDraft(rawValue);
                              if (!rawValue) {
                                return;
                              }
                              updateDraftSettings((current) => ({
                                ...current,
                                transcription: {
                                  ...current.transcription,
                                  updateIntervalMs: coerceUpdateInterval(
                                    rawValue,
                                    current.transcription.updateIntervalMs,
                                  ),
                                },
                              }));
                            }}
                            onBlur={() => {
                              const nextInterval = coerceUpdateInterval(
                                updateIntervalDraft,
                                draftSettings.transcription.updateIntervalMs,
                              );
                              setUpdateIntervalDraft(String(nextInterval));
                              updateDraftSettings((current) => ({
                                ...current,
                                transcription: {
                                  ...current.transcription,
                                  updateIntervalMs: nextInterval,
                                },
                              }));
                            }}
                            className="field-input"
                            placeholder="100 - 5000"
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
                          Local LLM
                        </p>
                        <p className="mt-1 text-sm text-slate-500">
                          Ollama refinement runs locally and appears beside the raw
                          transcript.
                        </p>
                      </div>

                      <label className="flex items-center justify-between rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
                        <div>
                          <p className="text-sm font-medium text-slate-900">
                            Enable refinement
                          </p>
                          <p className="mt-1 text-xs text-slate-500">
                            Keep Moonshine text intact while writing the LLM result in a
                            separate column.
                          </p>
                        </div>
                        <input
                          type="checkbox"
                          checked={draftSettings.llm.enabled}
                          onChange={(event) =>
                            updateDraftSettings((current) => ({
                              ...current,
                              llm: {
                                ...current.llm,
                                enabled: event.target.checked,
                              },
                            }))
                          }
                          className="h-4 w-4 rounded border-slate-300 text-[#007aff] focus:ring-[#007aff]"
                        />
                      </label>

                      <div className="grid gap-4 sm:grid-cols-2">
                        <div className="space-y-2">
                          <label className="field-label">Gemma Model</label>
                          <select
                            value={draftSettings.llm.model}
                            onChange={(event) =>
                              updateDraftSettings((current) => ({
                                ...current,
                                llm: {
                                  ...current.llm,
                                  model: event.target.value,
                                },
                              }))
                            }
                            className="field-input"
                          >
                            {LLM_MODEL_OPTIONS.map((model) => (
                              <option key={model} value={model}>
                                {model}
                              </option>
                            ))}
                          </select>
                        </div>

                        <div className="space-y-2">
                          <label className="field-label">Context Before</label>
                          <input
                            type="number"
                            min={0}
                            max={20}
                            value={draftSettings.llm.contextBeforeLines}
                            onChange={(event) =>
                              updateDraftSettings((current) => ({
                                ...current,
                                llm: {
                                  ...current.llm,
                                  contextBeforeLines: Math.min(
                                    20,
                                    Math.max(0, Number(event.target.value) || 0),
                                  ),
                                },
                              }))
                            }
                            className="field-input"
                          />
                        </div>

                        <div className="space-y-2">
                          <label className="field-label">Block Lines After</label>
                          <input
                            type="number"
                            min={0}
                            max={10}
                            value={draftSettings.llm.contextAfterLines}
                            onChange={(event) =>
                              updateDraftSettings((current) => ({
                                ...current,
                                llm: {
                                  ...current.llm,
                                  contextAfterLines: Math.min(
                                    10,
                                    Math.max(0, Number(event.target.value) || 0),
                                  ),
                                },
                              }))
                            }
                            className="field-input"
                          />
                        </div>

                        <div className="space-y-2">
                          <label className="field-label">Debounce ms</label>
                          <input
                            type="number"
                            min={0}
                            max={10000}
                            step={100}
                            value={draftSettings.llm.debounceMs}
                            onChange={(event) =>
                              updateDraftSettings((current) => ({
                                ...current,
                                llm: {
                                  ...current.llm,
                                  debounceMs: Math.min(
                                    10000,
                                    Math.max(0, Number(event.target.value) || 0),
                                  ),
                                },
                              }))
                            }
                            className="field-input"
                          />
                        </div>

                        <div className="space-y-2">
                          <label className="field-label">Max Wait ms</label>
                          <input
                            type="number"
                            min={0}
                            max={30000}
                            step={100}
                            value={draftSettings.llm.maxWaitMs}
                            onChange={(event) =>
                              updateDraftSettings((current) => ({
                                ...current,
                                llm: {
                                  ...current.llm,
                                  maxWaitMs: Math.min(
                                    30000,
                                    Math.max(0, Number(event.target.value) || 0),
                                  ),
                                },
                              }))
                            }
                            className="field-input"
                          />
                        </div>

                        <div className="space-y-2">
                          <label className="field-label">Ollama URL</label>
                          <input
                            type="text"
                            value={draftSettings.llm.baseUrl}
                            onChange={(event) =>
                              updateDraftSettings((current) => ({
                                ...current,
                                llm: {
                                  ...current.llm,
                                  baseUrl: event.target.value,
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
                            Complete lines only
                          </p>
                          <p className="mt-1 text-xs text-slate-500">
                            Wait until Moonshine marks a line complete before refinement.
                          </p>
                        </div>
                        <input
                          type="checkbox"
                          checked={draftSettings.llm.completeOnly}
                          onChange={(event) =>
                            updateDraftSettings((current) => ({
                              ...current,
                              llm: {
                                ...current.llm,
                                completeOnly: event.target.checked,
                              },
                            }))
                          }
                          className="h-4 w-4 rounded border-slate-300 text-[#007aff] focus:ring-[#007aff]"
                        />
                      </label>
                    </section>

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
                      <p>
                        Faster Whisper:{" "}
                        {settingsResponse.resolvedPaths.fasterWhisperModelsRoot}
                      </p>
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

      {sidebarContextMenu && sidebarContextRecord ? (
        <div
          onPointerDown={(event) => event.stopPropagation()}
          className="fixed z-[65] min-w-[220px] rounded-xl border border-slate-200 bg-white p-1.5 shadow-[0_16px_40px_rgba(15,23,42,0.16)]"
          style={{
            left: Math.min(sidebarContextMenu.x, window.innerWidth - 236),
            top: Math.min(sidebarContextMenu.y, window.innerHeight - 214),
          }}
        >
          <button
            type="button"
            onClick={() => {
              toggleSidebarRecordSelection(sidebarContextRecord.id);
              setSidebarContextMenu(null);
            }}
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-slate-600 transition-colors hover:bg-slate-50 hover:text-slate-900"
          >
            {sidebarContextRecordIsSelected ? (
              <Check className="size-4" />
            ) : (
              <Square className="size-4" />
            )}
            {sidebarContextRecordIsSelected ? "Remove From Selection" : "Add To Selection"}
          </button>
          {validSidebarSelectedRecordIds.length > 0 ? (
            <button
              type="button"
              onClick={() => {
                setSidebarSelectedRecordIds([]);
                lastSidebarSelectedRecordIdRef.current = null;
                setSidebarContextMenu(null);
              }}
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-slate-600 transition-colors hover:bg-slate-50 hover:text-slate-900"
            >
              <X className="size-4" />
              Clear Selection
            </button>
          ) : null}
          {sidebarContextRecord.audioUrl ? (
            <button
              type="button"
              onClick={() => {
                void generateMinutesForSessions(sidebarContextActionIds);
                setSidebarContextMenu(null);
              }}
              disabled={sidebarContextMinutesCount === 0}
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-slate-600 transition-colors hover:bg-slate-50 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <FileText className="size-4" />
              {sidebarContextMinutesCount > 1
                ? `文字起こし整形 (${sidebarContextMinutesCount})`
                : "文字起こし整形"}
            </button>
          ) : null}
          {sidebarContextRecord.audioUrl ? (
            <button
              type="button"
              onClick={() => {
                void openRecordingInExplorer(sidebarContextRecord.id);
                setSidebarContextMenu(null);
              }}
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-slate-600 transition-colors hover:bg-slate-50 hover:text-slate-900"
            >
              {openingRecordingId === sidebarContextRecord.id ? (
                <LoaderCircle className="size-4 animate-spin" />
              ) : (
                <FolderOpen className="size-4" />
              )}
              Open In Explorer
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => {
              void deleteSessions(sidebarContextDeleteIds);
              setSidebarContextMenu(null);
            }}
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-rose-600 transition-colors hover:bg-rose-50"
          >
            <Trash2 className="size-4" />
            {sidebarContextDeleteIds.length > 1
              ? `Delete Selected (${sidebarContextDeleteIds.length})`
              : "Delete"}
          </button>
        </div>
      ) : null}
    </div>
  );
}

export default App;
