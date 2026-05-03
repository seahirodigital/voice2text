import { AnimatePresence, motion } from "framer-motion";
import {
  AlignLeft,
  Check,
  CircleHelp,
  CirclePause,
  Copy,
  Download,
  FileText,
  Filter,
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
  Tag,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import {
  startTransition,
  useCallback,
  useDeferredValue,
  useEffect,
  useRef,
  useState,
} from "react";
import type {
  ChangeEvent as ReactChangeEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent,
  PointerEvent as ReactPointerEvent,
} from "react";

import { WaveformCanvas } from "./components/waveform-canvas";
import { Button } from "./components/ui/button";
import { transcriptToPlainText } from "./lib/utils";
import type {
  AppSettings,
  GroqUsageResponse,
  MetaResponse,
  PromptPreset,
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
const SETTINGS_AUTOSAVE_DELAY_MS = 450;
const TRANSCRIPT_COLUMN_GAP_PX = 16;
const OLLAMA_LLM_MODEL_OPTIONS = ["gemma4:e2b", "gemma4:e4b"];
const DEFAULT_OLLAMA_LLM_MODEL = OLLAMA_LLM_MODEL_OPTIONS[0];
const DEFAULT_OLLAMA_BATCH_SUMMARY_MODEL = "gemma4:e4b";
const DEFAULT_GROQ_TRANSCRIPTION_MODEL = "whisper-large-v3-turbo";
const FALLBACK_REALTIME_TRANSCRIPTION_ENGINES = ["moonshine", "groq"] as const;
const FALLBACK_BATCH_TRANSCRIPTION_ENGINES = [
  "faster-whisper",
  "moonshine",
  "groq",
] as const;
const FALLBACK_GROQ_TRANSCRIPTION_MODELS = [
  DEFAULT_GROQ_TRANSCRIPTION_MODEL,
  "whisper-large-v3",
];
const DEFAULT_GROQ_LLM_MODEL = "openai/gpt-oss-20b";
const FALLBACK_GROQ_LLM_MODELS = [
  DEFAULT_GROQ_LLM_MODEL,
  "openai/gpt-oss-120b",
  "llama-3.1-8b-instant",
  "llama-3.3-70b-versatile",
];
const FALLBACK_LLM_PROVIDERS = ["ollama", "groq"] as const;
const DEVICE_ID_STORAGE_KEY = "voice2text.device-id";
const DEFAULT_PROMPT_ID = "meeting-minutes";
const DEFAULT_PROMPT_NAME = "打ち合わせ議事録（汎用）";
const DEFAULT_PROMPT_CONTENT =
  "会議・打ち合わせの記録として、読み返してすぐ状況が分かる議事録に整形してください。\n\n## 出力形式\n- `# タイトル`\n- `## サマリー`\n- `## 決定事項`\n- `## TODO`\n- `## 論点・保留事項`\n- `## 詳細メモ`\n\n## 整形方針\n- 発言の重複や言い直しは整理してください。\n- 決定事項と未決事項を分けてください。\n- TODOは担当者、期限、内容が分かる場合だけ具体化してください。\n- 不明な担当者や期限は推測せず、`未定` と書いてください。";

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
  groq: "Groq",
};
const REALTIME_ENGINE_LABELS: Record<string, string> = {
  moonshine: "Moonshine",
  groq: "Groq",
};
const LLM_PROVIDER_LABELS: Record<string, string> = {
  ollama: "Gemma4 (Ollama)",
  groq: "Groq",
};
const DEFAULT_FASTER_WHISPER_MODEL = "small";
const DEFAULT_MOONSHINE_BATCH_MODEL = "base";
const DEFAULT_BATCH_TRANSCRIPTION_ENGINE = "faster-whisper";
const FALLBACK_FASTER_WHISPER_MODELS = [
  DEFAULT_FASTER_WHISPER_MODEL,
  "tiny",
  "base",
  "medium",
  "large-v3",
];
const DEFAULT_TRANSCRIPT_COLUMN_WIDTHS = {
  speaker: 100,
  time: 100,
  transcript: 400,
  llm: 400,
} as const;
const MIN_TRANSCRIPT_COLUMN_WIDTHS = {
  speaker: 72,
  time: 88,
  transcript: 180,
  llm: 160,
} as const;

type TranscriptColumnKey = "speaker" | "time" | "transcript" | "llm";
type TranscriptColumnWidths = Record<TranscriptColumnKey, number>;
type DownloadFormat = "txt" | "md";

type SettingsHelpTopic =
  | "transcription"
  | "batch"
  | "batchModel"
  | "localLlm"
  | "providers";

const SETTINGS_HELP_TITLES: Record<SettingsHelpTopic, string> = {
  transcription: "文字起こし設定",
  batch: "バッチ処理",
  batchModel: "バッチ文字起こしモデル",
  localLlm: "LLM整形",
  providers: "AIプロバイダー",
};

const FASTER_WHISPER_MODEL_ROWS = [
  {
    model: "tiny",
    speed: "最速",
    accuracy: "低",
    description: "短い確認や動作テスト向け。精度より速度を優先します。",
  },
  {
    model: "base",
    speed: "高速",
    accuracy: "標準",
    description: "軽めの録音に向いたバランス型です。",
  },
  {
    model: "small",
    speed: "中速",
    accuracy: "高",
    description: "既定モデル。日本語の精度と処理時間のバランスを重視します。",
  },
  {
    model: "medium",
    speed: "低速",
    accuracy: "より高い",
    description: "長めの会話や精度比較向けです。",
  },
  {
    model: "large-v3",
    speed: "最も低速",
    accuracy: "最高",
    description: "品質検証向け。処理時間とメモリ使用量が大きくなります。",
  },
];

const MOONSHINE_MODEL_ROWS = [
  {
    model: "tiny",
    speed: "高速",
    accuracy: "低",
    description: "リアルタイム軽量処理向けです。",
  },
  {
    model: "base",
    speed: "中速",
    accuracy: "標準",
    description: "現在のMoonshine比較用の基準モデルです。",
  },
  {
    model: "small-streaming",
    speed: "低速",
    accuracy: "高",
    description: "ストリーミング向けの高精度候補です。",
  },
  {
    model: "medium-streaming",
    speed: "最も低速",
    accuracy: "より高い",
    description: "精度比較用。負荷は高めです。",
  },
];

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
  minutesProgress?: number;
  minutesUpdatedAt?: string | null;
  summary: string;
  badgeLabel: string;
  kind: "history" | "live";
}

interface SidebarContextMenuState {
  recordId: string;
  targetIds: string[];
  x: number;
  y: number;
}

interface DeletedSessionsUndoEntry {
  sessionIds: string[];
  preferredSessionId: string | null;
}

interface SpeakerRenameState {
  speakerIndex: number;
  currentLabel: string;
  draft: string;
}

function SettingsHelpContent({ topic }: { topic: SettingsHelpTopic }) {
  if (topic === "batchModel") {
    return (
      <div className="space-y-5">
        <p className="text-sm leading-7 text-slate-600">
          `文字起こし整形` ボタンで録音済み音声を一括処理するときのモデルです。
          Faster Whisper はローカルの AppData 配下に保存され、OneDrive 配下には置きません。
        </p>
        <div className="overflow-hidden rounded-xl border border-slate-200">
          <table className="w-full border-collapse text-left text-sm">
            <thead className="bg-slate-50 text-[11px] font-bold uppercase tracking-[0.18em] text-slate-400">
              <tr>
                <th className="px-3 py-2">Faster Whisper</th>
                <th className="px-3 py-2">速さ</th>
                <th className="px-3 py-2">精度</th>
                <th className="px-3 py-2">説明</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {FASTER_WHISPER_MODEL_ROWS.map((row) => (
                <tr key={row.model}>
                  <td className="px-3 py-2 font-semibold text-slate-900">
                    {row.model}
                  </td>
                  <td className="px-3 py-2 text-slate-600">{row.speed}</td>
                  <td className="px-3 py-2 text-slate-600">{row.accuracy}</td>
                  <td className="px-3 py-2 text-slate-600">{row.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="overflow-hidden rounded-xl border border-slate-200">
          <table className="w-full border-collapse text-left text-sm">
            <thead className="bg-slate-50 text-[11px] font-bold uppercase tracking-[0.18em] text-slate-400">
              <tr>
                <th className="px-3 py-2">Moonshine</th>
                <th className="px-3 py-2">速さ</th>
                <th className="px-3 py-2">精度</th>
                <th className="px-3 py-2">説明</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {MOONSHINE_MODEL_ROWS.map((row) => (
                <tr key={row.model}>
                  <td className="px-3 py-2 font-semibold text-slate-900">
                    {row.model}
                  </td>
                  <td className="px-3 py-2 text-slate-600">{row.speed}</td>
                  <td className="px-3 py-2 text-slate-600">{row.accuracy}</td>
                  <td className="px-3 py-2 text-slate-600">{row.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  if (topic === "batch") {
    return (
      <div className="space-y-3 text-sm leading-7 text-slate-600">
        <p>
          バッチ処理は録音停止後に表示される `文字起こし整形` ボタンで使う
          一括処理の設定です。
        </p>
        <p>
          文字起こしエンジンでは一括文字起こしの処理方法を選びます。Faster Whisper、
          Moonshine、Groqを選択できます。GroqではAPI経由のWhisperモデルを使います。
          文字起こしモデルでは、そのエンジンで使うモデルを選びます。
        </p>
      </div>
    );
  }

  if (topic === "transcription") {
    return (
      <div className="space-y-3 text-sm leading-7 text-slate-600">
        <p>
          リアルタイムは録音中の文字起こしに使う設定です。言語は認識対象の言語、
          モデルは選択中の文字起こしエンジンで使うモデルを表します。
        </p>
        <p>
          バッチ処理の設定とは別です。バッチ処理は録音停止後の `文字起こし整形`
          で使います。
        </p>
      </div>
    );
  }

  if (topic === "localLlm") {
    return (
      <div className="space-y-3 text-sm leading-7 text-slate-600">
        <p>
          LLM整形は選択したプロバイダーのモデルを使い、リアルタイムの整形列や
          一括整形後のミニッツ生成を補助します。
        </p>
        <p>
          `LLM整形を有効化` をONにすると、文字起こしとは別列に
          LLM整形結果を表示します。
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3 text-sm leading-7 text-slate-600">
      <p>
        AIプロバイダーは外部AIサービス用の設定欄です。現在のローカルGemma/Ollama
        処理とは別に、将来の比較や拡張用として保持しています。
      </p>
      <p>通常のローカル利用では空欄のままで問題ありません。</p>
    </div>
  );
}

function buildSocketUrl() {
  const url = new URL("/ws/transcribe", window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function toPortableWindowsPath(rawPath: string | null | undefined) {
  if (!rawPath) {
    return "";
  }

  let normalized = rawPath.replace(/\//g, "\\");
  normalized = normalized.replace(
    /^[A-Za-z]:\\Users\\[^\\]+\\AppData\\Local/i,
    "%LOCALAPPDATA%",
  );
  normalized = normalized.replace(
    /^[A-Za-z]:\\Users\\[^\\]+\\OneDrive/i,
    "%USERPROFILE%\\OneDrive",
  );
  normalized = normalized.replace(/^[A-Za-z]:\\Users\\[^\\]+/i, "%USERPROFILE%");
  return normalized;
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
    minutesProgress: session.minutesProgress ?? 0,
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
    minutesProgress: detail.minutesProgress ?? 0,
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

function isEditableEventTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  const tagName = target.tagName.toLowerCase();
  return (
    tagName === "input" ||
    tagName === "textarea" ||
    tagName === "select" ||
    target.isContentEditable
  );
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

function getTranscriptionModelLabel(segment: TranscriptSegment) {
  const explicitLabel = segment.transcriptionModel?.trim();
  if (explicitLabel) {
    return explicitLabel;
  }
  if (segment.speakerSource === "groq") {
    return "Groq";
  }
  if (segment.speakerSource === "moonshine") {
    return "Moonshine";
  }
  if (segment.speakerSource === "faster-whisper") {
    return "Faster Whisper";
  }
  return null;
}

function sanitizeFilename(value: string) {
  return (
    value
      .replace(/[<>:"/\\|?*]+/g, "-")
      .replace(/\s+/g, " ")
      .trim()
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

function createDefaultPrompt(): PromptPreset {
  return {
    id: DEFAULT_PROMPT_ID,
    name: DEFAULT_PROMPT_NAME,
    content: DEFAULT_PROMPT_CONTENT,
  };
}

function normalizePromptName(value: string, fallback = "Untitled Template") {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized || fallback;
}

function createPromptId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `prompt-${crypto.randomUUID()}`;
  }
  return `prompt-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

function normalizePromptSettings(
  promptSettings?: AppSettings["promptSettings"] | null,
): AppSettings["promptSettings"] {
  const sourcePrompts = promptSettings?.prompts?.length
    ? promptSettings.prompts
    : [createDefaultPrompt()];
  const seenIds = new Set<string>();
  const prompts = sourcePrompts.map((prompt) => {
    let id = String(prompt.id || "").trim() || createPromptId();
    while (seenIds.has(id)) {
      id = createPromptId();
    }
    seenIds.add(id);
    return {
      id,
      name: normalizePromptName(prompt.name, DEFAULT_PROMPT_NAME),
      content: String(prompt.content ?? ""),
    };
  });
  const activePromptId = prompts.some(
    (prompt) => prompt.id === promptSettings?.activePromptId,
  )
    ? promptSettings?.activePromptId ?? prompts[0].id
    : prompts[0].id;
  return { activePromptId, prompts };
}

function settingsWithRuntimePrompt(settings: AppSettings): AppSettings {
  const promptSettings = normalizePromptSettings(settings.promptSettings);
  const activePrompt =
    promptSettings.prompts.find(
      (prompt) => prompt.id === promptSettings.activePromptId,
    ) ?? promptSettings.prompts[0];
  return {
    ...settings,
    promptSettings,
    llm: {
      ...settings.llm,
      systemPrompt: activePrompt.content,
    },
  };
}

function downloadTextFile(filename: string, text: string, type = "application/json") {
  const blob = new Blob([text], { type });
  const url = window.URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.URL.revokeObjectURL(url);
}

function parsePromptImport(raw: string): PromptPreset[] {
  const parsed = JSON.parse(raw) as unknown;
  const promptCandidates =
    Array.isArray(parsed)
      ? parsed
      : parsed &&
          typeof parsed === "object" &&
          "prompts" in parsed &&
          Array.isArray((parsed as { prompts: unknown }).prompts)
        ? (parsed as { prompts: unknown[] }).prompts
        : [];

  return promptCandidates
    .map((candidate) => {
      if (!candidate || typeof candidate !== "object") {
        return null;
      }
      const prompt = candidate as Partial<PromptPreset>;
      const name = normalizePromptName(String(prompt.name ?? ""), "");
      const content = String(prompt.content ?? "");
      if (!name && !content.trim()) {
        return null;
      }
      return {
        id: String(prompt.id ?? "").trim() || createPromptId(),
        name: name || "Imported Template",
        content,
      };
    })
    .filter((prompt): prompt is PromptPreset => Boolean(prompt));
}

function normalizeBatchSettings(
  settings: AppSettings,
  fasterWhisperModels: string[] = FALLBACK_FASTER_WHISPER_MODELS,
  moonshineModels: string[] = [],
  groqTranscriptionModels: string[] = FALLBACK_GROQ_TRANSCRIPTION_MODELS,
): AppSettings {
  const engine = FALLBACK_BATCH_TRANSCRIPTION_ENGINES.includes(
    settings.transcription.batchTranscriptionEngine,
  )
    ? settings.transcription.batchTranscriptionEngine
    : DEFAULT_BATCH_TRANSCRIPTION_ENGINE;
  const fasterModel = fasterWhisperModels.includes(
    settings.transcription.fasterWhisperModel,
  )
    ? settings.transcription.fasterWhisperModel
    : DEFAULT_FASTER_WHISPER_MODEL;
  const moonshineFallback =
    moonshineModels.includes(DEFAULT_MOONSHINE_BATCH_MODEL)
      ? DEFAULT_MOONSHINE_BATCH_MODEL
      : moonshineModels[0] || DEFAULT_MOONSHINE_BATCH_MODEL;
  const moonshineModel = moonshineModels.includes(
    settings.transcription.batchMoonshineModelPreset,
  )
    ? settings.transcription.batchMoonshineModelPreset
    : moonshineFallback;
  const groqFallback =
    groqTranscriptionModels.includes(DEFAULT_GROQ_TRANSCRIPTION_MODEL)
      ? DEFAULT_GROQ_TRANSCRIPTION_MODEL
      : groqTranscriptionModels[0] || DEFAULT_GROQ_TRANSCRIPTION_MODEL;
  const groqModel = groqTranscriptionModels.includes(
    settings.transcription.batchGroqTranscriptionModel,
  )
    ? settings.transcription.batchGroqTranscriptionModel
    : groqFallback;

  return {
    ...settings,
    transcription: {
      ...settings.transcription,
      batchTranscriptionEngine: engine,
      fasterWhisperModel: fasterModel,
      batchMoonshineModelPreset: moonshineModel,
      batchGroqTranscriptionModel: groqModel,
    },
  };
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
    "整形済み本文",
    refined || "整形済み本文はまだありません。",
    "---",
    "文字起こし原文",
    raw || "文字起こし原文はまだありません。",
  ].join("\n\n");
}

function buildExportMarkdown(
  title: string,
  segments: TranscriptSegment[],
  minutesMarkdown: string,
) {
  const refined = minutesMarkdown.trim() || refinedBlocksToPlainText(segments);
  const raw = transcriptToPlainText(segments);
  return [
    `# ${title}`,
    "## 整形済み本文",
    refined || "整形済み本文はまだありません。",
    "---",
    "## 文字起こし原文",
    raw ? `\`\`\`text\n${raw}\n\`\`\`` : "文字起こし原文はまだありません。",
  ].join("\n\n");
}

function formatCompactNumber(value: number | string | null | undefined) {
  const numericValue =
    typeof value === "number"
      ? value
      : Number(String(value ?? "").replace(/[^\d.-]/g, ""));
  if (!Number.isFinite(numericValue)) {
    return String(value ?? "-");
  }
  return new Intl.NumberFormat("ja-JP", {
    maximumFractionDigits: numericValue >= 100 ? 0 : 1,
  }).format(numericValue);
}

function formatUsageSeconds(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return "0秒";
  }
  if (seconds < 60) {
    return `${formatCompactNumber(seconds)}秒`;
  }
  const minutes = Math.floor(seconds / 60);
  const restSeconds = Math.round(seconds % 60);
  return restSeconds > 0 ? `${minutes}分${restSeconds}秒` : `${minutes}分`;
}

function parseUsageLimitValue(value: number | string | null | undefined) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  const normalized = String(value ?? "").replace(/[^\d.-]/g, "");
  if (!normalized) {
    return null;
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatUsageMeterValue(
  value: number,
  unit: "count" | "seconds" = "count",
) {
  return unit === "seconds" ? formatUsageSeconds(value) : formatCompactNumber(value);
}

function formatGroqLimitMetric(metric: string) {
  if (metric === "requests") {
    return "リクエスト";
  }
  if (metric === "tokens") {
    return "トークン";
  }
  return metric.replace(/-/g, " ");
}

function isSecondBasedRateLimit(metric: string) {
  return /second|audio/i.test(metric);
}

function parseGroqResetSeconds(value: string | null | undefined) {
  if (!value) {
    return null;
  }
  const normalized = value.trim();
  if (!normalized) {
    return null;
  }

  let totalSeconds = 0;
  let matched = false;
  const minuteMatch = normalized.match(/(\d+(?:\.\d+)?)m/i);
  if (minuteMatch) {
    totalSeconds += Number(minuteMatch[1]) * 60;
    matched = true;
  }
  const secondMatch = normalized.match(/(\d+(?:\.\d+)?)s/i);
  if (secondMatch) {
    totalSeconds += Number(secondMatch[1]);
    matched = true;
  }
  if (matched) {
    return Number.isFinite(totalSeconds) ? totalSeconds : null;
  }

  const fallback = Number(normalized.replace(/[^\d.]/g, ""));
  return Number.isFinite(fallback) ? fallback : null;
}

function formatCountdownSeconds(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return "0秒";
  }
  if (seconds < 10) {
    return `${seconds.toFixed(1)}秒`;
  }
  if (seconds < 60) {
    return `${Math.ceil(seconds)}秒`;
  }
  const minutes = Math.floor(seconds / 60);
  const restSeconds = Math.ceil(seconds % 60);
  return restSeconds > 0 ? `${minutes}分${restSeconds}秒` : `${minutes}分`;
}

const GROQ_RATE_LIMIT_LABELS: Record<string, string> = {
  "remaining-requests": "残りリクエスト",
  "limit-requests": "上限リクエスト",
  "reset-requests": "リクエスト復帰",
  "remaining-tokens": "残りトークン",
  "limit-tokens": "上限トークン",
  "reset-tokens": "トークン復帰",
};

function GroqUsageMeter({
  label,
  used,
  remaining,
  limit,
  resetAt,
  windowLabel,
  unit = "count",
}: {
  label: string;
  used: number;
  remaining: number;
  limit: number;
  resetAt?: string | null;
  windowLabel?: string | null;
  unit?: "count" | "seconds";
}) {
  const [now, setNow] = useState(() => Date.now());
  const safeLimit = Math.max(0, limit);
  const safeRemaining = Math.max(0, remaining);
  const safeUsed = Math.max(0, Math.min(safeLimit, used));
  const usagePercent =
    safeLimit > 0 ? clampNumber((safeUsed / safeLimit) * 100, 0, 100) : 0;
  const resetSeconds = parseGroqResetSeconds(resetAt);
  const [resetStartedAt, setResetStartedAt] = useState(() => Date.now());
  const effectiveResetSeconds =
    resetSeconds === null ? null : Math.max(0, resetSeconds - (now - resetStartedAt) / 1000);

  useEffect(() => {
    if (resetSeconds === null) {
      return;
    }
    const startedAt = Date.now();
    setResetStartedAt(startedAt);
    setNow(startedAt);
    const handle = window.setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => window.clearInterval(handle);
  }, [resetSeconds]);

  return (
    <div className="rounded-md border border-white/10 bg-white/[0.04] p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold text-slate-300">{label}</p>
          {windowLabel ? (
            <p className="mt-1 text-[10px] text-slate-500">{windowLabel}</p>
          ) : null}
          <p className="mt-1 text-sm font-semibold tabular-nums text-white">
            {formatUsageMeterValue(safeUsed, unit)} /{" "}
            {formatUsageMeterValue(safeLimit, unit)}
          </p>
        </div>
        <div className="shrink-0 text-right">
          <p className="text-[11px] font-semibold text-[#7ab8ff]">
            残り {formatUsageMeterValue(safeRemaining, unit)}
          </p>
          {effectiveResetSeconds !== null ? (
            <p className="mt-1 text-[10px] text-slate-500">
              リセットまで {formatCountdownSeconds(effectiveResetSeconds)}
            </p>
          ) : null}
        </div>
      </div>
      <div className="mt-3 h-2 overflow-hidden rounded-full bg-white/10">
        <div
          className="h-full rounded-full bg-gradient-to-r from-[#0a84ff] to-[#64c3ff] transition-[width] duration-300"
          style={{ width: `${usagePercent}%` }}
        />
      </div>
      <div className="mt-2 flex items-center justify-between text-[10px] text-slate-500">
        <span>{Math.round(usagePercent)}% 使用</span>
        <span>{formatUsageMeterValue(safeRemaining, unit)} 残り</span>
      </div>
    </div>
  );
}

function GroqUsagePopover({
  usage,
  loading,
  fetchedAt,
  onRefresh,
  onClose,
}: {
  usage: GroqUsageResponse | null;
  loading: boolean;
  fetchedAt: string | null;
  onRefresh: () => void;
  onClose: () => void;
}) {
  const today = usage?.today;
  const rateLimitEntries = Object.entries(usage?.rateLimits ?? {}).slice(0, 6);
  const rateLimitMeters = Object.entries(usage?.rateLimits ?? {})
    .filter(([key]) => key.startsWith("limit-"))
    .map(([key, value]) => {
      const metric = key.slice("limit-".length);
      const limit = parseUsageLimitValue(value);
      const remaining = parseUsageLimitValue(
        usage?.rateLimits?.[`remaining-${metric}`] ?? null,
      );
      if (limit === null || remaining === null || limit <= 0) {
        return null;
      }
      return {
        metric,
        limit,
        remaining,
        used: Math.max(0, limit - remaining),
        resetAt: usage?.rateLimits?.[`reset-${metric}`] ?? null,
        unit: isSecondBasedRateLimit(metric) ? ("seconds" as const) : ("count" as const),
        windowLabel: metric === "tokens" ? "1分あたりの上限" : metric === "requests" ? "1日あたりの上限" : null,
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  const modelEntries = Object.entries(usage?.models ?? {})
    .sort(([, left], [, right]) => right.requests - left.requests)
    .slice(0, 3);

  return (
    <div className="w-[23rem] max-w-[calc(100vw-5rem)] rounded-lg border border-white/10 bg-[#111114] p-4 text-left text-white shadow-2xl">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-[#7ab8ff]">
            Groq使用量
          </p>
          <p className="mt-1 text-xs text-slate-400">
            {usage?.updatedAt
              ? `更新 ${new Date(usage.updatedAt).toLocaleString("ja-JP")}`
              : "まだ記録がありません"}
          </p>
          <p className="mt-1 text-[10px] text-slate-500">
            {fetchedAt
              ? `表示更新 ${new Date(fetchedAt).toLocaleTimeString("ja-JP")}`
              : "保存済みの使用量を表示"}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-white/10 hover:text-white"
          aria-label="Groq使用量を閉じる"
        >
          <X className="size-3.5" />
        </button>
      </div>

      <div className="mt-4">
        <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-slate-500">
          今日の累計
        </p>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2">
        <div className="rounded-md bg-white/5 p-3">
          <p className="text-[11px] font-semibold text-slate-400">今日のリクエスト</p>
          <p className="mt-1 text-lg font-semibold tabular-nums">
            {formatCompactNumber(today?.requests ?? 0)}
          </p>
        </div>
        <div className="rounded-md bg-white/5 p-3">
          <p className="text-[11px] font-semibold text-slate-400">今日の音声</p>
          <p className="mt-1 text-lg font-semibold tabular-nums">
            {formatUsageSeconds(today?.audioSeconds ?? 0)}
          </p>
        </div>
        <div className="rounded-md bg-white/5 p-3">
          <p className="text-[11px] font-semibold text-slate-400">今日のトークン</p>
          <p className="mt-1 text-lg font-semibold tabular-nums">
            {formatCompactNumber(today?.totalTokens ?? 0)}
          </p>
        </div>
        <div className="rounded-md bg-white/5 p-3">
          <p className="text-[11px] font-semibold text-slate-400">制限到達</p>
          <p className="mt-1 text-lg font-semibold tabular-nums">
            {formatCompactNumber(today?.rateLimitHits ?? 0)}
          </p>
        </div>
      </div>

      <div className="mt-4 space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-slate-500">
            現在のGroq制限
          </p>
          <button
            type="button"
            onClick={onRefresh}
            className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[11px] font-semibold text-[#7ab8ff] transition-colors hover:bg-white/10"
          >
            {loading ? (
              <LoaderCircle className="size-3 animate-spin" />
            ) : (
              <RefreshCcw className="size-3" />
            )}
            更新
          </button>
        </div>
        {rateLimitMeters.length > 0 ? (
          <div className="space-y-2">
            {rateLimitMeters.map((entry) => (
              <GroqUsageMeter
                key={entry.metric}
                label={formatGroqLimitMetric(entry.metric)}
                used={entry.used}
                remaining={entry.remaining}
                limit={entry.limit}
                resetAt={entry.resetAt}
                unit={entry.unit}
                windowLabel={entry.windowLabel}
              />
            ))}
          </div>
        ) : rateLimitEntries.length > 0 ? (
          <div className="space-y-1">
            {rateLimitEntries.map(([key, value]) => (
              <div
                key={key}
                className="flex items-center justify-between gap-3 text-xs text-slate-300"
              >
                <span>{GROQ_RATE_LIMIT_LABELS[key] ?? key}</span>
                <span className="app-mono text-slate-100">{value}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs leading-5 text-slate-400">
            Groq APIを呼び出すと、レスポンスヘッダーから残り制限がここに表示されます。
          </p>
        )}
      </div>

      {usage?.latest ? (
        <div className="mt-4 rounded-md border border-white/10 p-3 text-xs text-slate-300">
          <p className="font-semibold text-slate-100">直近の呼び出し</p>
          <p className="mt-1">{usage.latest.model}</p>
          <p className="mt-1 app-mono">
            {usage.latest.endpoint} / {usage.latest.statusCode} /{" "}
            {usage.latest.latencyMs}ms
          </p>
        </div>
      ) : null}

      {modelEntries.length > 0 ? (
        <div className="mt-4 space-y-1">
          <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-slate-500">
            Model
          </p>
          {modelEntries.map(([model, totals]) => (
            <div key={model} className="flex items-center justify-between gap-3 text-xs">
              <span className="truncate text-slate-300">{model}</span>
              <span className="app-mono text-slate-100">{totals.requests}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
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
  const [showRawTranscript, setShowRawTranscript] = useState(true);
  const [showLlmRefined, setShowLlmRefined] = useState(true);
  const [currentAudioUrl, setCurrentAudioUrl] = useState<string | null>(null);
  const [deviceId, setDeviceId] = useState(() =>
    typeof window === "undefined"
      ? ""
      : window.localStorage.getItem(DEVICE_ID_STORAGE_KEY) ?? "",
  );
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [status, setStatus] = useState<RecordingStatus>("idle");
  const [recognitionStopped, setRecognitionStopped] = useState(false);
  const [, setCurrentSessionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [waveform, setWaveform] = useState<number[]>(EMPTY_WAVEFORM);
  const [savingSettings, setSavingSettings] = useState(false);
  const [choosingRecordingsRoot, setChoosingRecordingsRoot] = useState(false);
  const [openingRecordingId, setOpeningRecordingId] = useState<string | null>(null);
  const [minutesProcessingIds, setMinutesProcessingIds] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);
  const [downloadFormatMenuOpen, setDownloadFormatMenuOpen] = useState(false);
  const [editVersion, setEditVersion] = useState(0);
  const [recordFilter, setRecordFilter] = useState("");
  const [updateIntervalDraft, setUpdateIntervalDraft] = useState("");
  const [inputGainDb, setInputGainDb] = useState(INPUT_GAIN_DEFAULT_DB);
  const [sidebarWidth, setSidebarWidth] = useState(320);
  const [minutesEditorPercent, setMinutesEditorPercent] = useState(50);
  const [sidebarSelectionMode, setSidebarSelectionMode] = useState(false);
  const [sidebarSelectedRecordIds, setSidebarSelectedRecordIds] = useState<string[]>(
    [],
  );
  const [sidebarContextMenu, setSidebarContextMenu] =
    useState<SidebarContextMenuState | null>(null);
  const [deletedSessionsUndoStack, setDeletedSessionsUndoStack] = useState<
    DeletedSessionsUndoEntry[]
  >([]);
  const [historySortOrder, setHistorySortOrder] = useState<"newest" | "oldest">(
    "newest",
  );
  const [recordsOpen, setRecordsOpen] = useState(false);
  const [promptEditorOpen, setPromptEditorOpen] = useState(false);
  const [editingPromptId, setEditingPromptId] = useState<string | null>(null);
  const [promptNameEditState, setPromptNameEditState] = useState<{
    promptId: string;
    draft: string;
  } | null>(null);
  const [promptCopied, setPromptCopied] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsHelpTopic, setSettingsHelpTopic] =
    useState<SettingsHelpTopic | null>(null);
  const [groqUsage, setGroqUsage] = useState<GroqUsageResponse | null>(null);
  const [groqUsageLoading, setGroqUsageLoading] = useState(false);
  const [groqUsageHovered, setGroqUsageHovered] = useState(false);
  const [groqUsagePinned, setGroqUsagePinned] = useState(false);
  const [groqUsageFetchedAt, setGroqUsageFetchedAt] = useState<string | null>(null);
  const [transcriptColumnWidths, setTranscriptColumnWidths] =
    useState<TranscriptColumnWidths>({
      ...DEFAULT_TRANSCRIPT_COLUMN_WIDTHS,
    });
  const [playbackActiveSegmentId, setPlaybackActiveSegmentId] = useState<
    string | null
  >(null);
  const [isAudioPlaying, setIsAudioPlaying] = useState(false);
  const [speakerEditMode, setSpeakerEditMode] = useState(false);
  const [speakerRenameState, setSpeakerRenameState] = useState<SpeakerRenameState | null>(
    null,
  );
  const [liveSessionStartedAt, setLiveSessionStartedAt] = useState<string | null>(
    null,
  );
  const [liveCaptureElapsedMs, setLiveCaptureElapsedMs] = useState(0);
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
  const promptImportInputRef = useRef<HTMLInputElement | null>(null);
  const speakerRenameInputRef = useRef<HTMLInputElement | null>(null);
  const groqUsageContainerRef = useRef<HTMLDivElement | null>(null);
  const segmentRowRefs = useRef<Map<string, HTMLElement>>(new Map());
  const lastLiveSegmentIdRef = useRef<string | null>(null);
  const audioPlayerRef = useRef<HTMLAudioElement | null>(null);
  const speakerNameOverridesRef = useRef<Map<number, string>>(new Map());
  const lastSidebarSelectedRecordIdRef = useRef<string | null>(null);
  const inputGainDbRef = useRef(INPUT_GAIN_DEFAULT_DB);
  const statusRef = useRef<RecordingStatus>("idle");
  const isLiveSessionRef = useRef(false);
  const liveCaptureBaseElapsedMsRef = useRef(0);
  const liveCaptureStartedPerfRef = useRef<number | null>(null);
  const restoreDeletedSessionsInFlightRef = useRef(false);
  const pendingLiveTitleRef = useRef<string | null>(null);
  const draftSettingsRef = useRef<AppSettings | null>(null);
  const settingsAutoSaveTimeoutRef = useRef<number | null>(null);
  const lastSavedSettingsSnapshotRef = useRef<string | null>(null);
  const transcriptColumnResizeRef = useRef<{
    column: TranscriptColumnKey;
    startX: number;
    startWidth: number;
  } | null>(null);
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
      if (settingsAutoSaveTimeoutRef.current !== null) {
        window.clearTimeout(settingsAutoSaveTimeoutRef.current);
      }
    },
    [],
  );

  const resetLiveCaptureTimer = useCallback((nextElapsedMs = 0) => {
    liveCaptureBaseElapsedMsRef.current = nextElapsedMs;
    liveCaptureStartedPerfRef.current = null;
    setLiveCaptureElapsedMs(nextElapsedMs);
  }, []);

  const pauseLiveCaptureTimer = useCallback(() => {
    const startedPerf = liveCaptureStartedPerfRef.current;
    if (startedPerf === null) {
      setLiveCaptureElapsedMs(liveCaptureBaseElapsedMsRef.current);
      return;
    }

    const nextElapsedMs =
      liveCaptureBaseElapsedMsRef.current + (performance.now() - startedPerf);
    liveCaptureBaseElapsedMsRef.current = nextElapsedMs;
    liveCaptureStartedPerfRef.current = null;
    setLiveCaptureElapsedMs(nextElapsedMs);
  }, []);

  const updateLiveCaptureTimer = useCallback(() => {
    const startedPerf = liveCaptureStartedPerfRef.current;
    if (startedPerf === null) {
      setLiveCaptureElapsedMs(liveCaptureBaseElapsedMsRef.current);
      return;
    }

    setLiveCaptureElapsedMs(
      liveCaptureBaseElapsedMsRef.current + (performance.now() - startedPerf),
    );
  }, []);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    if (status !== "recording") {
      return;
    }

    const resumeRecordingContext = () => {
      const audioContext = audioContextRef.current;
      if (!audioContext || statusRef.current !== "recording") {
        return;
      }
      if (audioContext.state === "running" || audioContext.state === "closed") {
        return;
      }
      void audioContext.resume().catch(() => {
        // Browsers can reject resume while the page is backgrounded. We retry on focus.
      });
    };

    const handleVisibilityChange = () => {
      if (!document.hidden) {
        resumeRecordingContext();
      }
    };

    const handleWindowFocus = () => {
      resumeRecordingContext();
    };

    const audioContext = audioContextRef.current;
    const handleAudioContextStateChange = () => {
      resumeRecordingContext();
    };

    const watchdog = window.setInterval(() => {
      resumeRecordingContext();
    }, 1000);

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("focus", handleWindowFocus);
    window.addEventListener("pageshow", handleWindowFocus);
    audioContext?.addEventListener?.("statechange", handleAudioContextStateChange);

    return () => {
      window.clearInterval(watchdog);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("focus", handleWindowFocus);
      window.removeEventListener("pageshow", handleWindowFocus);
      audioContext?.removeEventListener?.(
        "statechange",
        handleAudioContextStateChange,
      );
    };
  }, [status]);

  useEffect(() => {
    draftSettingsRef.current = draftSettings;
  }, [draftSettings]);

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

  useEffect(() => {
    if (status !== "recording") {
      pauseLiveCaptureTimer();
      return;
    }

    if (liveCaptureStartedPerfRef.current === null) {
      liveCaptureStartedPerfRef.current = performance.now();
    }

    updateLiveCaptureTimer();
    const handle = window.setInterval(updateLiveCaptureTimer, 250);

    return () => {
      window.clearInterval(handle);
      pauseLiveCaptureTimer();
    };
  }, [pauseLiveCaptureTimer, status, updateLiveCaptureTimer]);

  useEffect(() => {
    if (typeof window === "undefined" || !deviceId) {
      return;
    }
    window.localStorage.setItem(DEVICE_ID_STORAGE_KEY, deviceId);
  }, [deviceId]);

  useEffect(() => {
    if (minutesProcessingIds.length === 0) {
      return;
    }

    const handle = window.setInterval(() => {
      void apiFetch<SessionSummary[]>("/api/sessions")
        .then((sessions) => {
          startTransition(() => {
            setHistory(sessions);
          });
        })
        .catch(() => {
          // Keep the current UI state if polling fails mid-process.
        });
    }, 900);

    return () => {
      window.clearInterval(handle);
    };
  }, [minutesProcessingIds]);

  const refreshDevices = async () => {
    if (!navigator.mediaDevices?.enumerateDevices) {
      return;
    }

    const availableDevices = await navigator.mediaDevices.enumerateDevices();
    const audioInputs = availableDevices.filter(
      (device) => device.kind === "audioinput",
    );
    setDevices(audioInputs);
    setDeviceId((current) =>
      audioInputs.some((device) => device.deviceId === current)
        ? current
        : audioInputs[0]?.deviceId || "",
    );
  };

  const normalizeSettingsForPersistence = useCallback(
    (settings: AppSettings, metaOverride?: MetaResponse | null) => {
      const effectiveMeta = metaOverride ?? meta;
      const fasterWhisperModels =
        effectiveMeta?.fasterWhisperModels ?? FALLBACK_FASTER_WHISPER_MODELS;
      const moonshineModels =
        effectiveMeta?.availableModelsByLanguage[settings.transcription.language] ??
        (effectiveMeta
          ? effectiveMeta.availableModelsByLanguage[effectiveMeta.defaultLanguage]
          : undefined) ??
        ["tiny"];
      const groqTranscriptionModels =
        effectiveMeta?.groqTranscriptionModels ?? FALLBACK_GROQ_TRANSCRIPTION_MODELS;
      return settingsWithRuntimePrompt(
        normalizeBatchSettings(
          settings,
          fasterWhisperModels,
          moonshineModels,
          groqTranscriptionModels,
        ),
      );
    },
    [meta],
  );

  const getSettingsSnapshot = useCallback(
    (settings: AppSettings, metaOverride?: MetaResponse | null) =>
      JSON.stringify(normalizeSettingsForPersistence(settings, metaOverride)),
    [normalizeSettingsForPersistence],
  );

  const refreshHistory = async () => {
    const sessions = await apiFetch<SessionSummary[]>("/api/sessions");
    startTransition(() => {
      setHistory(sessions);
    });
    return sessions;
  };

  const refreshGroqUsage = useCallback(async () => {
    setGroqUsageLoading(true);
    try {
      const usage = await apiFetch<GroqUsageResponse>("/api/groq/usage");
      setGroqUsage(usage);
      setGroqUsageFetchedAt(new Date().toISOString());
    } catch {
      setGroqUsage((current) => current);
      setGroqUsageFetchedAt(new Date().toISOString());
    } finally {
      setGroqUsageLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshGroqUsage();
  }, [refreshGroqUsage]);

  useEffect(() => {
    if (!groqUsageHovered && !groqUsagePinned) {
      return;
    }

    void refreshGroqUsage();
    const handle = window.setInterval(() => {
      void refreshGroqUsage();
    }, 15000);

    return () => {
      window.clearInterval(handle);
    };
  }, [groqUsageHovered, groqUsagePinned, refreshGroqUsage]);

  useEffect(() => {
    if (!groqUsagePinned) {
      return;
    }

    const handlePointerDown = (event: Event) => {
      const target = event.target as Node | null;
      if (!target) {
        return;
      }
      if (groqUsageContainerRef.current?.contains(target)) {
        return;
      }
      setGroqUsagePinned(false);
      setGroqUsageHovered(false);
    };

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("touchstart", handlePointerDown);

    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("touchstart", handlePointerDown);
    };
  }, [groqUsagePinned]);

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

      const normalizedSettings = normalizeBatchSettings(
        settingsPayload.settings,
        metaPayload.fasterWhisperModels,
        metaPayload.availableModelsByLanguage[
          settingsPayload.settings.transcription.language
        ] ??
          metaPayload.availableModelsByLanguage[metaPayload.defaultLanguage] ??
          ["tiny"],
        metaPayload.groqTranscriptionModels,
      );
      lastSavedSettingsSnapshotRef.current = JSON.stringify(normalizedSettings);

      clearBootstrapRetry();
      setError(null);
      setSettingsResponse({
        ...settingsPayload,
        settings: normalizedSettings,
      });
      setDraftSettings(normalizedSettings);
      setUpdateIntervalDraft(
        String(normalizedSettings.transcription.updateIntervalMs),
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
      const createdAtMs = Date.parse(createdAt);
      setCurrentSessionId(sessionId);
      setLiveSessionStartedAt(createdAt);
      resetLiveCaptureTimer(
        Number.isNaN(createdAtMs) ? 0 : Math.max(0, Date.now() - createdAtMs),
      );
      setLiveTitleOverride(title);
      setTitleDraft(title);
      setStatus("recording");
      setRecognitionStopped(false);
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

    if (message.type === "recognition_stopped") {
      setRecognitionStopped(true);
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
      setRecognitionStopped(false);
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
      setRecognitionStopped(false);
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
    resetLiveCaptureTimer();
    setError(null);
    setStatus("connecting");
    setRecognitionStopped(false);
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
          setRecognitionStopped(false);
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
        setRecognitionStopped(false);
        void teardownAudio();
        closeSocket();
      };
      socket.onclose = () => {
        if (wsRef.current === socket) {
          wsRef.current = null;
        }
        if (statusRef.current === "recording" || statusRef.current === "paused") {
          setStatus("idle");
          setRecognitionStopped(false);
          return;
        }
        if (statusRef.current === "connecting") {
          clearConnectionTimeout();
          setStatus("error");
          setError("Backend closed the transcription socket during session startup.");
          isLiveSessionRef.current = false;
          setLiveSessionStartedAt(null);
          setRecognitionStopped(false);
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
              realtimeTranscriptionEngine:
                draftSettings.transcription.realtimeTranscriptionEngine,
              modelPreset: draftSettings.transcription.modelPreset,
              groqTranscriptionModel:
                draftSettings.transcription.groqTranscriptionModel,
              browserSampleRate: audioContext.sampleRate,
              channels: 1,
              deviceLabel: selectedDevice?.label || "Default Microphone",
              maxSpeakers: draftSettings.transcription.maxSpeakers,
              llm: settingsWithRuntimePrompt(draftSettings).llm,
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
        setRecognitionStopped(false);
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
      setRecognitionStopped(false);
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

  const stopRecognitionOnly = () => {
    if (
      status !== "recording" ||
      recognitionStopped ||
      !wsRef.current ||
      wsRef.current.readyState !== WebSocket.OPEN
    ) {
      return;
    }
    wsRef.current.send(JSON.stringify({ type: "stop_recognition", payload: {} }));
    setRecognitionStopped(true);
  };

  const stopRecording = async () => {
    if (status !== "recording" && status !== "paused") {
      return;
    }
    setStatus("saving");
    wsRef.current?.send(JSON.stringify({ type: "stop_session", payload: {} }));
    await teardownAudio();
  };

  const saveSettings = useCallback(
    async (
      nextSettings?: AppSettings | null,
      options?: { closePanelOnSuccess?: boolean },
    ) => {
      const rawSettings = nextSettings ?? draftSettings;
      if (!rawSettings) {
        if (options?.closePanelOnSuccess) {
          setSettingsOpen(false);
        }
        return;
      }

      const settingsToSave = normalizeSettingsForPersistence(rawSettings);
      const nextSnapshot = JSON.stringify(settingsToSave);
      if (nextSnapshot === lastSavedSettingsSnapshotRef.current) {
        setDraftSettings((current) => {
          if (!current) {
            return settingsToSave;
          }
          return JSON.stringify(normalizeSettingsForPersistence(current)) ===
            nextSnapshot
            ? settingsToSave
            : current;
        });
        if (options?.closePanelOnSuccess) {
          setSettingsOpen(false);
        }
        return;
      }

      if (settingsAutoSaveTimeoutRef.current !== null) {
        window.clearTimeout(settingsAutoSaveTimeoutRef.current);
        settingsAutoSaveTimeoutRef.current = null;
      }

      setDraftSettings((current) => {
        if (!current) {
          return settingsToSave;
        }
        return JSON.stringify(normalizeSettingsForPersistence(current)) ===
          nextSnapshot
          ? settingsToSave
          : current;
      });
      setSavingSettings(true);
      try {
        const response = await apiFetch<SettingsResponse>("/api/settings", {
          method: "PUT",
          body: JSON.stringify(settingsToSave),
        });
        const nextMeta = await apiFetch<MetaResponse>("/api/meta");
        const normalizedResponseSettings = normalizeSettingsForPersistence(
          response.settings,
          nextMeta,
        );
        lastSavedSettingsSnapshotRef.current = JSON.stringify(
          normalizedResponseSettings,
        );
        setSettingsResponse({
          ...response,
          settings: normalizedResponseSettings,
        });
        const latestDraft = draftSettingsRef.current;
        const latestSnapshot = latestDraft
          ? JSON.stringify(normalizeSettingsForPersistence(latestDraft, nextMeta))
          : nextSnapshot;
        if (latestSnapshot === nextSnapshot) {
          setDraftSettings(normalizedResponseSettings);
          setUpdateIntervalDraft(
            String(normalizedResponseSettings.transcription.updateIntervalMs),
          );
        }
        setMeta(nextMeta);
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(
            JSON.stringify({
              type: "update_llm_settings",
              payload: normalizedResponseSettings.llm,
            }),
          );
        }
        if (options?.closePanelOnSuccess) {
          setSettingsOpen(false);
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
    },
    [draftSettings, normalizeSettingsForPersistence],
  );

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

  const downloadTranscriptFile = (
    title: string,
    segments: TranscriptSegment[],
    markdown: string,
    format: DownloadFormat,
  ) => {
    const safeTitle = sanitizeFilename(title);
    if (format === "md") {
      downloadTextFile(
        `${safeTitle}.md`,
        buildExportMarkdown(title, segments, markdown),
        "text/markdown;charset=utf-8",
      );
      return;
    }
    downloadTextFile(
      `${safeTitle}.txt`,
      buildExportText(segments, markdown),
      "text/plain;charset=utf-8",
    );
  };

  const downloadTranscripts = async (format: DownloadFormat) => {
    setDownloadFormatMenuOpen(false);
    try {
      const bulkIds = validSidebarSelectedRecordIds;
      if (bulkIds.length > 0) {
        for (const sessionId of bulkIds) {
          const detail =
            sessionId === selectedSessionId
              ? null
              : await apiFetch<SessionDetail>(`/api/sessions/${sessionId}`);
          const sourceDetail =
            detail ??
            ({
              title:
                history.find((session) => session.id === sessionId)?.title ??
                activeTitle,
              segments: timelineSegmentsRef.current,
              minutesMarkdown: minutesDraft,
            } as Pick<SessionDetail, "title" | "segments" | "minutesMarkdown">);
          downloadTranscriptFile(
            sourceDetail.title,
            sortSegments(sourceDetail.segments),
            sourceDetail.minutesMarkdown ?? "",
            format,
          );
        }
        return;
      }

      const currentTitle =
        selectedHistoryRecord?.title ??
        (status !== "idle" && status !== "error" ? "live-record" : activeTitle);
      downloadTranscriptFile(
        currentTitle,
        timelineSegmentsRef.current,
        minutesDraft,
        format,
      );
    } catch (downloadError) {
      setError(
        downloadError instanceof Error
          ? downloadError.message
          : "ダウンロードに失敗しました。",
      );
    }
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
    setHistory((current) =>
      current.map((entry) =>
        entry.id === sessionId
          ? {
              ...entry,
              minutesStatus: "processing",
              minutesProgress: 0,
              minutesError: null,
            }
          : entry,
      ),
    );
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

    const deletedIds: string[] = [];
    try {
      for (const sessionId of uniqueIds) {
        await apiFetch<{ deleted: boolean }>(`/api/sessions/${sessionId}`, {
          method: "DELETE",
        });
        deletedIds.push(sessionId);
      }
    } catch (deleteError) {
      if (deletedIds.length > 0) {
        setDeletedSessionsUndoStack((current) => [
          ...current,
          {
            sessionIds: deletedIds,
            preferredSessionId:
              selectedSessionId && deletedIds.includes(selectedSessionId)
                ? selectedSessionId
                : null,
          },
        ]);
      }
      setError(
        deleteError instanceof Error
          ? deletedIds.length > 0
            ? `Some selected records were deleted before the request failed. Press Ctrl+Z to restore them.\n${deleteError.message}`
            : deleteError.message
          : "Failed to delete the selected records.",
      );
      await refreshHistory();
      return;
    }

    setDeletedSessionsUndoStack((current) => [
      ...current,
      {
        sessionIds: uniqueIds,
        preferredSessionId:
          selectedSessionId && uniqueIds.includes(selectedSessionId)
            ? selectedSessionId
            : null,
      },
    ]);
    setSidebarSelectedRecordIds((current) =>
      current.filter((sessionId) => !uniqueIds.includes(sessionId)),
    );
    if (
      lastSidebarSelectedRecordIdRef.current &&
      uniqueIds.includes(lastSidebarSelectedRecordIdRef.current)
    ) {
      lastSidebarSelectedRecordIdRef.current = null;
    }

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

  const restoreDeletedSessions = async () => {
    const undoEntry = deletedSessionsUndoStack.at(-1);
    if (!undoEntry || restoreDeletedSessionsInFlightRef.current) {
      return;
    }

    restoreDeletedSessionsInFlightRef.current = true;
    setDeletedSessionsUndoStack((current) => current.slice(0, -1));

    try {
      for (const sessionId of undoEntry.sessionIds) {
        await apiFetch<SessionDetail>(`/api/sessions/${sessionId}/restore`, {
          method: "POST",
        });
      }

      const sessions = await refreshHistory();
      const restoredIds = undoEntry.sessionIds.filter((sessionId) =>
        sessions.some((session) => session.id === sessionId),
      );
      if (restoredIds.length === 0) {
        return;
      }

      setSidebarSelectionMode(restoredIds.length > 1);
      setSidebarSelectedRecordIds(restoredIds);
      lastSidebarSelectedRecordIdRef.current = restoredIds.at(-1) ?? null;

      if (
        undoEntry.preferredSessionId &&
        restoredIds.includes(undoEntry.preferredSessionId)
      ) {
        await loadSession(undoEntry.preferredSessionId);
      }
    } catch (restoreError) {
      setDeletedSessionsUndoStack((current) => [...current, undoEntry]);
      setError(
        restoreError instanceof Error
          ? restoreError.message
          : "Failed to restore the deleted records.",
      );
      await refreshHistory();
    } finally {
      restoreDeletedSessionsInFlightRef.current = false;
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

  const applySpeakerRename = useCallback(
    (speakerIndex: number, currentLabel: string, requestedName: string) => {
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
    },
    [selectedSessionId],
  );

  const openSpeakerRenameModal = useCallback((speakerIndex: number, currentLabel: string) => {
    setSpeakerRenameState({
      speakerIndex,
      currentLabel,
      draft: currentLabel,
    });
  }, []);

  const closeSpeakerRenameModal = useCallback(() => {
    setSpeakerRenameState(null);
  }, []);

  const submitSpeakerRename = useCallback(() => {
    if (!speakerRenameState) {
      return;
    }

    applySpeakerRename(
      speakerRenameState.speakerIndex,
      speakerRenameState.currentLabel,
      speakerRenameState.draft,
    );
    setSpeakerRenameState(null);
  }, [applySpeakerRename, speakerRenameState]);

  useEffect(() => {
    if (!speakerRenameState) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      speakerRenameInputRef.current?.focus();
      speakerRenameInputRef.current?.select();
    });

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSpeakerRenameState(null);
      }
    };

    window.addEventListener("keydown", handleEscape);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("keydown", handleEscape);
    };
  }, [speakerRenameState]);

  const findPlaybackSegmentId = useCallback((currentTime: number) => {
    const segments = timelineSegmentsRef.current;
    if (segments.length === 0) {
      return null;
    }

    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      const nextSegment = segments[index + 1];
      const segmentEnd =
        nextSegment?.startedAt ??
        segment.startedAt + Math.max(segment.duration, 2);
      if (currentTime >= segment.startedAt && currentTime < segmentEnd) {
        return segment.id;
      }
    }

    if (currentTime >= segments.at(-1)!.startedAt) {
      return segments.at(-1)!.id;
    }
    return null;
  }, []);

  const playSegmentAudio = async (segment: TranscriptSegment) => {
    const audio = audioPlayerRef.current;
    if (!audio || !currentAudioUrl || status !== "idle") {
      return;
    }

    if (isAudioPlaying && playbackActiveSegmentId === segment.id) {
      audio.pause();
      audio.currentTime = Math.max(
        0,
        segment.startedAt - SEGMENT_AUDIO_PREROLL_SECONDS,
      );
      setIsAudioPlaying(false);
      setPlaybackActiveSegmentId(null);
      return;
    }

    const nextTime = Math.max(
      0,
      segment.startedAt - SEGMENT_AUDIO_PREROLL_SECONDS,
    );
    try {
      audio.pause();
      audio.currentTime = nextTime;
      setPlaybackActiveSegmentId(segment.id);
      await audio.play();
    } catch (playError) {
      setError(
        playError instanceof Error
          ? playError.message
          : "Unable to start audio playback for this segment.",
      );
    }
  };

  useEffect(() => {
    const audio = audioPlayerRef.current;
    if (!audio) {
      return;
    }

    const syncPlaybackSegment = () => {
      const nextSegmentId = findPlaybackSegmentId(audio.currentTime);
      setPlaybackActiveSegmentId(nextSegmentId);
    };
    const handlePlay = () => {
      setIsAudioPlaying(true);
      syncPlaybackSegment();
    };
    const handlePause = () => {
      setIsAudioPlaying(false);
      setPlaybackActiveSegmentId(null);
    };
    const handleEnded = () => {
      setIsAudioPlaying(false);
      setPlaybackActiveSegmentId(null);
    };

    audio.addEventListener("play", handlePlay);
    audio.addEventListener("pause", handlePause);
    audio.addEventListener("ended", handleEnded);
    audio.addEventListener("timeupdate", syncPlaybackSegment);
    audio.addEventListener("seeked", syncPlaybackSegment);
    return () => {
      audio.removeEventListener("play", handlePlay);
      audio.removeEventListener("pause", handlePause);
      audio.removeEventListener("ended", handleEnded);
      audio.removeEventListener("timeupdate", syncPlaybackSegment);
      audio.removeEventListener("seeked", syncPlaybackSegment);
    };
  }, [findPlaybackSegmentId, currentAudioUrl]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      setIsAudioPlaying(false);
      setPlaybackActiveSegmentId(null);
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [currentAudioUrl, selectedSessionId]);

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
    setSidebarSelectionMode(true);
    lastSidebarSelectedRecordIdRef.current = sessionId;
    setSidebarSelectedRecordIds((current) =>
      current.includes(sessionId)
        ? current.filter((entry) => entry !== sessionId)
        : [...current, sessionId],
    );
  };

  const exitSidebarSelectionMode = () => {
    setSidebarSelectionMode(false);
    setSidebarSelectedRecordIds([]);
    lastSidebarSelectedRecordIdRef.current = null;
  };

  const updateDraftSettings = (updater: (current: AppSettings) => AppSettings) => {
    setDraftSettings((current) => (current ? updater(current) : current));
  };

  const updatePromptSettings = (
    updater: (
      current: AppSettings["promptSettings"],
    ) => AppSettings["promptSettings"],
  ) => {
    updateDraftSettings((current) => {
      const promptSettings = normalizePromptSettings(
        updater(normalizePromptSettings(current.promptSettings)),
      );
      const activePrompt =
        promptSettings.prompts.find(
          (prompt) => prompt.id === promptSettings.activePromptId,
        ) ?? promptSettings.prompts[0];
      return {
        ...current,
        promptSettings,
        llm: {
          ...current.llm,
          systemPrompt: activePrompt.content,
        },
      };
    });
  };

  const openPromptEditor = () => {
    const promptSettings = draftSettings
      ? normalizePromptSettings(draftSettings.promptSettings)
      : null;
    setEditingPromptId((current) => current ?? promptSettings?.activePromptId ?? null);
    setPromptEditorOpen(true);
  };

  const togglePromptEditor = () => {
    if (promptEditorOpen) {
      closePromptEditor();
      return;
    }
    openPromptEditor();
  };

  const selectActivePrompt = (promptId: string) => {
    const baseSettings = draftSettingsRef.current ?? draftSettings;
    if (!baseSettings) {
      return;
    }
    const promptSettings = normalizePromptSettings({
      ...normalizePromptSettings(baseSettings.promptSettings),
      activePromptId: promptId,
    });
    const activePrompt =
      promptSettings.prompts.find(
        (prompt) => prompt.id === promptSettings.activePromptId,
      ) ?? promptSettings.prompts[0];
    const nextSettings: AppSettings = {
      ...baseSettings,
      promptSettings,
      llm: {
        ...baseSettings.llm,
        systemPrompt: activePrompt.content,
      },
    };
    setDraftSettings(nextSettings);
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(
        JSON.stringify({
          type: "update_llm_settings",
          payload: nextSettings.llm,
        }),
      );
    }
  };

  const addPrompt = () => {
    const prompt: PromptPreset = {
      id: createPromptId(),
      name: "新しい用途テンプレート",
      content: "",
    };
    updatePromptSettings((current) => ({
      ...current,
      prompts: [...current.prompts, prompt],
    }));
    setEditingPromptId(prompt.id);
  };

  const updatePrompt = (promptId: string, patch: Partial<PromptPreset>) => {
    updatePromptSettings((current) => ({
      ...current,
      prompts: current.prompts.map((prompt) =>
        prompt.id === promptId ? { ...prompt, ...patch } : prompt,
      ),
    }));
  };

  const beginPromptNameEdit = (prompt: PromptPreset) => {
    setPromptNameEditState({
      promptId: prompt.id,
      draft: prompt.name,
    });
  };

  const cancelPromptNameEdit = () => {
    setPromptNameEditState(null);
  };

  const savePromptNameEdit = () => {
    if (!promptNameEditState) {
      return;
    }
    updatePrompt(promptNameEditState.promptId, {
      name: normalizePromptName(promptNameEditState.draft, DEFAULT_PROMPT_NAME),
    });
    setPromptNameEditState(null);
  };

  const movePrompt = (promptId: string, direction: -1 | 1) => {
    updatePromptSettings((current) => {
      const promptIndex = current.prompts.findIndex((prompt) => prompt.id === promptId);
      const nextIndex = promptIndex + direction;
      if (
        promptIndex === -1 ||
        nextIndex < 0 ||
        nextIndex >= current.prompts.length
      ) {
        return current;
      }
      const prompts = [...current.prompts];
      const [prompt] = prompts.splice(promptIndex, 1);
      prompts.splice(nextIndex, 0, prompt);
      return { ...current, prompts };
    });
  };

  const deletePrompt = (promptId: string) => {
    if (!draftSettings) {
      return;
    }
    const promptSettings = normalizePromptSettings(draftSettings.promptSettings);
    if (promptSettings.prompts.length <= 1) {
      setError("用途テンプレートは最低1つ必要です。");
      return;
    }
    const targetPrompt = promptSettings.prompts.find((prompt) => prompt.id === promptId);
    const confirmed = window.confirm(
      `用途テンプレート「${targetPrompt?.name ?? promptId}」を削除しますか？`,
    );
    if (!confirmed) {
      return;
    }
    const nextEditingPromptId =
      promptSettings.prompts.find((prompt) => prompt.id !== promptId)?.id ??
      DEFAULT_PROMPT_ID;
    updatePromptSettings((current) => {
      const prompts = current.prompts.filter((prompt) => prompt.id !== promptId);
      return {
        activePromptId:
          current.activePromptId === promptId
            ? prompts[0]?.id ?? DEFAULT_PROMPT_ID
            : current.activePromptId,
        prompts,
      };
    });
    setEditingPromptId((current) => (current === promptId ? nextEditingPromptId : current));
  };

  const exportPrompts = () => {
    if (!draftSettings) {
      return;
    }
    const promptSettings = normalizePromptSettings(draftSettings.promptSettings);
    downloadTextFile(
      "voice2text-prompt-templates.json",
      JSON.stringify(promptSettings, null, 2),
    );
  };

  const copyAllPrompts = async () => {
    if (!draftSettings) {
      return;
    }
    try {
      await navigator.clipboard.writeText(
        JSON.stringify(normalizePromptSettings(draftSettings.promptSettings), null, 2),
      );
      setPromptCopied(true);
      window.setTimeout(() => setPromptCopied(false), 1600);
    } catch (copyError) {
      setError(
        copyError instanceof Error
          ? copyError.message
          : "用途テンプレートのコピーに失敗しました。",
      );
    }
  };

  const importPrompts = async (event: ReactChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !draftSettings) {
      return;
    }
    try {
      const importedPrompts = parsePromptImport(await file.text());
      if (importedPrompts.length === 0) {
        setError("インポートできる用途テンプレートが見つかりませんでした。");
        return;
      }
      const existingIds = new Set(
        normalizePromptSettings(draftSettings.promptSettings).prompts.map(
          (prompt) => prompt.id,
        ),
      );
      const promptsToAdd = importedPrompts.map((prompt) => {
        let id = prompt.id;
        while (existingIds.has(id)) {
          id = createPromptId();
        }
        existingIds.add(id);
        return {
          ...prompt,
          id,
          name: normalizePromptName(prompt.name, "Imported Template"),
        };
      });
      setEditingPromptId(promptsToAdd[0]?.id ?? null);
      updatePromptSettings((current) => ({
        ...current,
        prompts: [...current.prompts, ...promptsToAdd],
      }));
    } catch (importError) {
      setError(
        importError instanceof Error
          ? importError.message
          : "用途テンプレートのインポートに失敗しました。",
      );
    }
  };

  const closeSettingsPanel = useCallback(() => {
    setSettingsOpen(false);
    if (!draftSettings || savingSettings) {
      return;
    }
    const nextSnapshot = getSettingsSnapshot(draftSettings);
    if (nextSnapshot !== lastSavedSettingsSnapshotRef.current) {
      void saveSettings(draftSettings);
    }
  }, [draftSettings, getSettingsSnapshot, saveSettings, savingSettings]);

  const saveSettingsAndClose = useCallback(() => {
    void saveSettings(draftSettings, { closePanelOnSuccess: true });
  }, [draftSettings, saveSettings]);

  const closePromptEditor = useCallback(() => {
    setPromptEditorOpen(false);
    if (!draftSettings || savingSettings) {
      return;
    }
    const nextSnapshot = getSettingsSnapshot(draftSettings);
    if (nextSnapshot !== lastSavedSettingsSnapshotRef.current) {
      void saveSettings(draftSettings);
    }
  }, [draftSettings, getSettingsSnapshot, saveSettings, savingSettings]);

  useEffect(() => {
    if (!draftSettings || !meta || savingSettings) {
      return;
    }

    const nextSnapshot = getSettingsSnapshot(draftSettings);
    if (nextSnapshot === lastSavedSettingsSnapshotRef.current) {
      return;
    }

    if (settingsAutoSaveTimeoutRef.current !== null) {
      window.clearTimeout(settingsAutoSaveTimeoutRef.current);
    }

    settingsAutoSaveTimeoutRef.current = window.setTimeout(() => {
      settingsAutoSaveTimeoutRef.current = null;
      void saveSettings(draftSettings);
    }, SETTINGS_AUTOSAVE_DELAY_MS);

    return () => {
      if (settingsAutoSaveTimeoutRef.current !== null) {
        window.clearTimeout(settingsAutoSaveTimeoutRef.current);
        settingsAutoSaveTimeoutRef.current = null;
      }
    };
  }, [draftSettings, getSettingsSnapshot, meta, saveSettings, savingSettings]);

  const activeModelOptions =
    meta?.availableModelsByLanguage[draftSettings?.transcription.language ?? "ja"] ??
    ["tiny"];
  const effectiveTranscriptColumnWidths: TranscriptColumnWidths = {
    ...transcriptColumnWidths,
  };
  if (!showRawTranscript && showLlmRefined) {
    effectiveTranscriptColumnWidths.llm += effectiveTranscriptColumnWidths.transcript;
  }
  if (showRawTranscript && !showLlmRefined) {
    effectiveTranscriptColumnWidths.transcript += effectiveTranscriptColumnWidths.llm;
  }

  const visibleTranscriptColumns: TranscriptColumnKey[] = [
    "speaker",
    "time",
    ...(showRawTranscript ? (["transcript"] as const) : []),
    ...(showLlmRefined ? (["llm"] as const) : []),
  ];
  const flexibleTranscriptColumn = showLlmRefined
    ? "llm"
    : showRawTranscript
      ? "transcript"
      : null;
  const transcriptGridTemplate = visibleTranscriptColumns
    .map((column) =>
      column === flexibleTranscriptColumn
        ? `minmax(${effectiveTranscriptColumnWidths[column]}px, 1fr)`
        : `${effectiveTranscriptColumnWidths[column]}px`,
    )
    .join(" ");
  const transcriptTableMinWidth =
    visibleTranscriptColumns.reduce(
      (total, column) => total + effectiveTranscriptColumnWidths[column],
      0,
    ) +
    Math.max(0, visibleTranscriptColumns.length - 1) * TRANSCRIPT_COLUMN_GAP_PX;
  const transcriptGridStyle = {
    gridTemplateColumns: transcriptGridTemplate,
  };

  const updateTranscriptColumnWidthFromPointer = useCallback((clientX: number) => {
    const resizeState = transcriptColumnResizeRef.current;
    if (!resizeState) {
      return;
    }

    const delta = clientX - resizeState.startX;
    setTranscriptColumnWidths((current) => ({
      ...current,
      [resizeState.column]: clampNumber(
        resizeState.startWidth + delta,
        MIN_TRANSCRIPT_COLUMN_WIDTHS[resizeState.column],
        1200,
      ),
    }));
  }, []);

  const handleTranscriptColumnResizePointerDown = useCallback(
    (
      column: TranscriptColumnKey,
      event: ReactPointerEvent<HTMLButtonElement>,
    ) => {
      event.preventDefault();
      event.stopPropagation();
      transcriptColumnResizeRef.current = {
        column,
        startX: event.clientX,
        startWidth: transcriptColumnWidths[column],
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [transcriptColumnWidths],
  );

  const handleTranscriptColumnResizePointerMove = (
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) {
      return;
    }
    updateTranscriptColumnWidthFromPointer(event.clientX);
  };

  const handleTranscriptColumnResizePointerUp = (
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    transcriptColumnResizeRef.current = null;
  };

  const appReady = Boolean(draftSettings && meta);
  const hasActiveCapture = status !== "idle" && status !== "error";
  const promptSettings = draftSettings
    ? normalizePromptSettings(draftSettings.promptSettings)
    : null;
  const promptList = promptSettings?.prompts ?? [];
  const activePromptId = promptSettings?.activePromptId ?? "";
  const editingPrompt =
    promptList.find((prompt) => prompt.id === editingPromptId) ??
    promptList.find((prompt) => prompt.id === activePromptId) ??
    promptList[0] ??
    null;
  const generatedLiveTitle = formatSessionTitle(liveSessionStartedAt);
  const transcriptDuration = deferredSegments.at(-1)
    ? deferredSegments.at(-1)!.startedAt + deferredSegments.at(-1)!.duration
    : 0;
  const liveCaptureDurationSeconds = liveCaptureElapsedMs / 1000;
  const selectedDevice =
    devices.find((entry) => entry.deviceId === deviceId) ?? devices[0] ?? null;
  const allHistoryRecords = history.map(toHistoryRecord);
  const selectedHistoryRecord =
    allHistoryRecords.find((record) => record.id === selectedSessionId) ?? null;
  const totalDuration = hasActiveCapture
    ? liveCaptureDurationSeconds
    : (selectedHistoryRecord?.durationSeconds ?? transcriptDuration);

  const liveRecord: RecordView | null = hasActiveCapture
    ? {
        id: LIVE_RECORD_ID,
        title: liveTitleOverride?.trim() || generatedLiveTitle,
        createdAt: liveSessionStartedAt ?? new Date().toISOString(),
        language: draftSettings?.transcription.language ?? "ja",
        deviceLabel: selectedDevice?.label || "Current microphone",
        durationSeconds: liveCaptureDurationSeconds,
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
  const selectedMinutesProgress = selectedHistoryRecord?.minutesProgress ?? 0;
  const canDeleteSelectedSession = Boolean(selectedSessionId && !hasActiveCapture);
  const activeTitle = activeRecord?.title ?? "Voice2Text Workspace";
  const renderedMinutesHtml = renderMarkdown(minutesDraft);
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
  const downloadAvailable = exportAvailable || validSidebarSelectedRecordIds.length > 0;
  const sidebarSelectedRecordIdSet = new Set(validSidebarSelectedRecordIds);
  const sidebarContextRecord = sidebarContextMenu
    ? sidebarHistoryRecordMap.get(sidebarContextMenu.recordId) ?? null
    : null;
  const sidebarContextActionIds =
    sidebarContextMenu?.targetIds.filter((sessionId) =>
      sidebarHistoryRecordMap.has(sessionId),
    ) ?? [];
  const sidebarContextDeleteIds = sidebarContextActionIds;
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

    if (sidebarSelectionMode && event.shiftKey) {
      event.preventDefault();
      selectSidebarRecordRange(record.id);
      return;
    }

    if (sidebarSelectionMode && (event.ctrlKey || event.metaKey)) {
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
    const handleUndoDeletedSessions = (event: KeyboardEvent) => {
      if (
        deletedSessionsUndoStack.length === 0 ||
        event.altKey ||
        event.shiftKey ||
        !(event.ctrlKey || event.metaKey) ||
        event.key.toLowerCase() !== "z" ||
        isEditableEventTarget(event.target)
      ) {
        return;
      }

      event.preventDefault();
      void restoreDeletedSessions();
    };

    window.addEventListener("keydown", handleUndoDeletedSessions);
    return () => {
      window.removeEventListener("keydown", handleUndoDeletedSessions);
    };
  }, [deletedSessionsUndoStack, restoreDeletedSessions]);

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
            onClick={() => {
              if (promptEditorOpen) {
                closePromptEditor();
              }
              setRecordsOpen(true);
            }}
            className="flex h-10 w-10 items-center justify-center rounded-lg bg-white/5 text-[#007aff] transition-colors"
            aria-label="Open records"
          >
            <FolderOpen className="size-5" />
          </button>
          <button
            type="button"
            onClick={togglePromptEditor}
            className={`flex h-10 w-10 items-center justify-center rounded-lg transition-colors ${
              promptEditorOpen
                ? "bg-white/10 text-white"
                : "text-slate-500 hover:bg-white/5 hover:text-white"
            }`}
            aria-label="Open prompt settings"
          >
            <FileText className="size-5" />
          </button>
        </div>
        <div
          ref={groqUsageContainerRef}
          className="relative"
          onMouseEnter={() => {
            setGroqUsageHovered(true);
            void refreshGroqUsage();
          }}
          onMouseLeave={() => setGroqUsageHovered(false)}
        >
          <button
            type="button"
            onClick={() => {
              setGroqUsagePinned((current) => !current);
              void refreshGroqUsage();
            }}
            className={`flex h-10 w-10 items-center justify-center rounded-lg transition-colors ${
              groqUsageHovered || groqUsagePinned
                ? "bg-white/10 text-white"
                : "text-slate-500 hover:bg-white/5 hover:text-white"
            }`}
            aria-label="設定とGroq使用量を開く"
          >
            <Settings2 className="size-5" />
          </button>
          <AnimatePresence>
            {groqUsageHovered || groqUsagePinned ? (
              <motion.div
                initial={{ opacity: 0, x: -4, scale: 0.98 }}
                animate={{ opacity: 1, x: 0, scale: 1 }}
                exit={{ opacity: 0, x: -4, scale: 0.98 }}
                transition={{ duration: 0.14, ease: "easeOut" }}
                className="absolute bottom-0 left-12 z-[80]"
              >
                <GroqUsagePopover
                  usage={groqUsage}
                  loading={groqUsageLoading}
                  fetchedAt={groqUsageFetchedAt}
                  onRefresh={() => void refreshGroqUsage()}
                  onClose={() => {
                    setGroqUsagePinned(false);
                    setGroqUsageHovered(false);
                  }}
                />
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>
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
              className="min-w-[8.5rem] rounded-lg px-4 py-2.5"
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
              onClick={() =>
                setHistorySortOrder((current) =>
                  current === "newest" ? "oldest" : "newest",
                )
              }
              className="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-500 transition-colors hover:border-slate-300 hover:text-slate-700"
              aria-label="Toggle sort order"
            >
              <Filter className="size-4" />
            </button>
            <button
              type="button"
              onClick={() => void chooseRecordingsRoot()}
              disabled={!draftSettings || hasActiveCapture || savingSettings}
              title={
                toPortableWindowsPath(
                  settingsResponse?.resolvedPaths.tempRecordingsRoot ??
                    draftSettings?.paths.tempRecordingsRoot,
                ) ||
                (settingsResponse?.resolvedPaths.tempRecordingsRoot ??
                  draftSettings?.paths.tempRecordingsRoot)
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
                    const targetIds =
                      sidebarSelectionMode &&
                      isBulkSelected &&
                      validSidebarSelectedRecordIds.length > 0
                        ? validSidebarSelectedRecordIds
                        : [record.id];
                    setSidebarContextMenu({
                      recordId: record.id,
                      targetIds,
                      x: event.clientX,
                      y: event.clientY,
                    });
                  }}
                >
                  <div className="flex items-start gap-3 px-4 py-3">
                    {record.kind === "history" && sidebarSelectionMode ? (
                      <button
                        type="button"
                        disabled={isDisabled}
                        onClick={() => toggleSidebarRecordSelection(record.id)}
                        className={`mt-5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md border transition-colors ${
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
                      <div className="mb-1 flex items-center justify-between gap-3">
                        <span
                          className={`app-mono inline-flex shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-[0.18em] ${badgeClass}`}
                        >
                          {record.badgeLabel}
                        </span>
                        <span className="app-mono shrink-0 text-[10px] tracking-[0.12em] text-slate-400">
                          {formatSidebarDate(record.createdAt)}
                        </span>
                      </div>
                      <h3 className="break-words text-sm font-semibold leading-5 text-slate-900">
                        {record.title}
                      </h3>
                    </button>
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

      <AnimatePresence>
        {promptEditorOpen ? (
          <>
            <motion.button
              type="button"
              aria-label="Close prompt editor"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={closePromptEditor}
              className="fixed inset-0 z-40 bg-slate-950/30"
            />
            <motion.section
              role="dialog"
              aria-modal="true"
              aria-labelledby="prompt-editor-title"
              initial={{ x: -28, opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: -18, opacity: 0 }}
              transition={{ duration: 0.22, ease: "easeOut" }}
              className="fixed inset-y-0 left-0 right-0 z-50 flex flex-col overflow-hidden bg-white shadow-[0_24px_90px_rgba(15,23,42,0.22)] lg:left-16"
            >
              <div className="flex flex-col gap-4 border-b border-slate-200 bg-white px-5 py-4 lg:flex-row lg:items-center lg:justify-between">
                <div>
                  <h2
                    id="prompt-editor-title"
                    className="text-xl font-semibold text-slate-900"
                  >
                    用途テンプレート設定
                  </h2>
                </div>
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  <select
                    value={activePromptId}
                    onChange={(event) => selectActivePrompt(event.target.value)}
                    className="field-input min-w-[16rem]"
                    disabled={!draftSettings || promptList.length === 0}
                  >
                    {promptList.map((prompt) => (
                      <option key={prompt.id} value={prompt.id}>
                        {prompt.name}
                      </option>
                    ))}
                  </select>
                  <Button
                    type="button"
                    className="rounded-xl"
                    onClick={() => void saveSettings(draftSettings)}
                    disabled={!draftSettings || savingSettings}
                  >
                    {savingSettings ? (
                      <LoaderCircle className="size-4 animate-spin" />
                    ) : (
                      <Save className="size-4" />
                    )}
                    保存
                  </Button>
                  <button
                    type="button"
                    onClick={() => promptImportInputRef.current?.click()}
                    disabled={!draftSettings}
                    className="inline-flex h-11 w-11 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-500 transition-colors hover:border-slate-300 hover:text-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
                    aria-label="用途テンプレートをインポート"
                  >
                    <Upload className="size-4" />
                  </button>
                  <button
                    type="button"
                    onClick={exportPrompts}
                    disabled={!draftSettings || promptList.length === 0}
                    className="inline-flex h-11 w-11 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-500 transition-colors hover:border-slate-300 hover:text-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
                    aria-label="用途テンプレートをエクスポート"
                  >
                    <Download className="size-4" />
                  </button>
                </div>
              </div>

              <div className="flex min-h-0 flex-1 flex-col md:flex-row">
                <aside className="flex w-full flex-col border-b border-slate-200 bg-[#f8f9fb] md:w-80 md:border-b-0 md:border-r">
                  <div className="border-b border-slate-200 p-4">
                    <Button
                      type="button"
                      className="w-full rounded-xl"
                      onClick={addPrompt}
                      disabled={!draftSettings}
                    >
                      <FileText className="size-4" />
                      新規テンプレート
                    </Button>
                    <input
                      ref={promptImportInputRef}
                      type="file"
                      accept="application/json,.json"
                      onChange={(event) => void importPrompts(event)}
                      className="hidden"
                    />
                  </div>

                  <div className="app-scrollbar min-h-0 flex-1 overflow-y-auto">
                    {promptList.length === 0 ? (
                      <div className="border-b border-slate-200 px-4 py-5 text-sm leading-6 text-slate-500">
                        用途テンプレートがまだありません。
                      </div>
                    ) : (
                      promptList.map((prompt, index) => {
                        const isSelected = prompt.id === editingPrompt?.id;
                        const isActive = prompt.id === activePromptId;
                        return (
                          <div
                            key={prompt.id}
                            className={`border-b border-slate-200 px-4 py-3 transition-colors ${
                              isSelected
                                ? "border-l-2 border-l-[#007aff] bg-white"
                                : "hover:bg-white/70"
                            }`}
                          >
                            <button
                              type="button"
                              onClick={() => setEditingPromptId(prompt.id)}
                              className="block w-full text-left"
                            >
                              <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                  <p className="truncate text-sm font-semibold text-slate-900">
                                    {prompt.name}
                                  </p>
                                  <p className="mt-1 line-clamp-2 text-xs leading-5 text-slate-500">
                                    {prompt.content.trim() || "内容未入力"}
                                  </p>
                                </div>
                                {isActive ? (
                                  <span className="rounded-full bg-blue-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.16em] text-[#007aff]">
                                    Active
                                  </span>
                                ) : null}
                              </div>
                            </button>
                            <div className="mt-3 flex items-center gap-1.5">
                              <button
                              type="button"
                              onClick={() => movePrompt(prompt.id, -1)}
                              disabled={index === 0}
                              className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-xs font-bold text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
                              aria-label={`${prompt.name} を上へ移動`}
                            >
                              ↑
                              </button>
                              <button
                              type="button"
                              onClick={() => movePrompt(prompt.id, 1)}
                              disabled={index === promptList.length - 1}
                              className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-xs font-bold text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
                              aria-label={`${prompt.name} を下へ移動`}
                            >
                              ↓
                            </button>
                            <button
                              type="button"
                              onClick={() => deletePrompt(prompt.id)}
                              disabled={promptList.length <= 1}
                              className="ml-auto inline-flex h-8 w-8 items-center justify-center rounded-lg text-rose-500 transition-colors hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-40"
                              aria-label={`${prompt.name} を削除`}
                            >
                              <Trash2 className="size-4" />
                            </button>
                            <button
                              type="button"
                              onClick={() => selectActivePrompt(prompt.id)}
                              className="inline-flex h-8 items-center justify-center rounded-lg px-2.5 text-xs font-semibold text-slate-600 transition-colors hover:bg-blue-50 hover:text-[#007aff]"
                            >
                              使用
                            </button>
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                </aside>

                <main className="min-h-0 flex-1 overflow-hidden bg-white">
                  {editingPrompt ? (
                    <div className="flex h-full flex-col">
                      <div className="border-b border-slate-200 px-5 py-4">
                        <p className="field-label">テンプレート名</p>
                        {promptNameEditState?.promptId === editingPrompt.id ? (
                          <div className="mt-2 flex min-w-0 items-center gap-2">
                            <input
                              value={promptNameEditState.draft}
                              onChange={(event) =>
                                setPromptNameEditState((current) =>
                                  current
                                    ? { ...current, draft: event.target.value }
                                    : current,
                                )
                              }
                              onKeyDown={(event) => {
                                if (event.key === "Enter") {
                                  event.preventDefault();
                                  savePromptNameEdit();
                                }
                                if (event.key === "Escape") {
                                  event.preventDefault();
                                  cancelPromptNameEdit();
                                }
                              }}
                              className="min-w-0 flex-1 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-lg font-bold text-slate-900 outline-none focus:border-[#007aff] focus:ring-4 focus:ring-[#007aff]/10"
                              placeholder="テンプレート名"
                            />
                            <button
                              type="button"
                              onClick={savePromptNameEdit}
                              className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-500 transition-colors hover:border-slate-300 hover:text-slate-700"
                              aria-label="テンプレート名を保存"
                            >
                              <Check className="size-4" />
                            </button>
                            <button
                              type="button"
                              onClick={cancelPromptNameEdit}
                              className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-500 transition-colors hover:border-slate-300 hover:text-slate-700"
                              aria-label="テンプレート名の編集をキャンセル"
                            >
                              <X className="size-4" />
                            </button>
                          </div>
                        ) : (
                          <div className="mt-2 flex min-w-0 items-center gap-2">
                            <h3 className="truncate text-xl font-bold text-slate-900">
                              {editingPrompt.name}
                            </h3>
                            <button
                              type="button"
                              onClick={() => beginPromptNameEdit(editingPrompt)}
                              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
                              aria-label="テンプレート名を編集"
                            >
                              <Pencil className="size-4" />
                            </button>
                          </div>
                        )}
                      </div>

                      <div className="grid min-h-0 flex-1 grid-rows-2 md:grid-cols-2 md:grid-rows-1">
                        <section className="flex min-h-0 flex-col border-b border-slate-200 md:border-b-0 md:border-r">
                          <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3">
                            <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-slate-400">
                              Edit
                            </p>
                            <button
                              type="button"
                              onClick={() => void copyAllPrompts()}
                              disabled={!draftSettings || promptList.length === 0}
                              className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
                              aria-label="全用途テンプレートをコピー"
                              title={promptCopied ? "コピーしました" : "全用途テンプレートをコピー"}
                            >
                              <Copy className="size-4" />
                            </button>
                          </div>
                          <textarea
                            value={editingPrompt.content}
                            onChange={(event) =>
                              updatePrompt(editingPrompt.id, {
                                content: event.target.value,
                              })
                            }
                            className="app-scrollbar min-h-0 flex-1 resize-none border-0 bg-white p-5 text-sm leading-7 text-slate-800 outline-none"
                            placeholder="ここに用途別の整形テンプレートを書いてください。"
                          />
                        </section>

                        <section className="flex min-h-0 flex-col bg-slate-50">
                          <div className="border-b border-slate-100 bg-white px-5 py-3">
                            <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-slate-400">
                              Markdown Preview
                            </p>
                          </div>
                          <div className="app-scrollbar min-h-0 flex-1 overflow-y-auto bg-white p-5">
                            {editingPrompt.content.trim() ? (
                              <div
                                className="markdown-preview text-sm leading-7 text-slate-700"
                                dangerouslySetInnerHTML={{
                                  __html: renderMarkdown(editingPrompt.content),
                                }}
                              />
                            ) : (
                              <div className="text-sm leading-6 text-slate-500">
                                プレビューする内容がまだありません。
                              </div>
                            )}
                          </div>
                        </section>
                      </div>
                    </div>
                  ) : (
                    <div className="flex h-full items-center justify-center p-8 text-sm text-slate-500">
                      左側から用途テンプレートを選択してください。
                    </div>
                  )}
                </main>
              </div>
            </motion.section>
          </>
        ) : null}
      </AnimatePresence>

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
            </div>
          </div>

          <div className="flex items-center gap-2">
            {promptList.length > 0 ? (
              <label className="hidden items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 sm:flex">
                <span className="whitespace-nowrap text-[12px] font-bold uppercase tracking-[0.18em] text-slate-400">
                  用途
                </span>
                <select
                  value={activePromptId}
                  onChange={(event) => selectActivePrompt(event.target.value)}
                  disabled={!draftSettings || promptList.length === 0}
                  className="max-w-[14rem] bg-transparent pr-6 text-[12px] font-semibold leading-none text-slate-700 outline-none disabled:cursor-not-allowed disabled:opacity-40"
                  aria-label="用途を選択"
                  style={{ fontSize: "12px" }}
                >
                  {promptList.map((prompt) => (
                    <option key={prompt.id} value={prompt.id} style={{ fontSize: "12px" }}>
                      {prompt.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {selectedSessionId ? (
              <div className="inline-flex rounded-xl border border-slate-200 bg-white p-1">
                <button
                  type="button"
                  onClick={() => setActiveTranscriptView("realtime")}
                  className={`inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[12px] font-semibold transition-colors ${
                    activeTranscriptView === "realtime"
                      ? "bg-[#007aff] text-white"
                      : "text-[#007aff] hover:bg-[#007aff]/10"
                  }`}
                  style={{ fontSize: "12px" }}
                >
                  <AlignLeft className="size-3.5" />
                  リアルタイム
                </button>
                <button
                  type="button"
                  onClick={() => setActiveTranscriptView("minutes")}
                  className={`inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[12px] font-semibold transition-colors ${
                    activeTranscriptView === "minutes"
                      ? "bg-[#007aff] text-white"
                      : "text-[#007aff] hover:bg-[#007aff]/10"
                  }`}
                  style={{ fontSize: "12px" }}
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
            <div className="relative">
              <button
                type="button"
                onClick={() =>
                  setDownloadFormatMenuOpen((current) =>
                    downloadAvailable ? !current : false,
                  )
                }
                disabled={!downloadAvailable}
                className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-500 transition-colors hover:border-slate-300 hover:text-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
                aria-label="Download transcript"
              >
                <Download className="size-4" />
              </button>
              {downloadFormatMenuOpen ? (
                <div className="absolute right-0 top-12 z-40 w-36 overflow-hidden rounded-xl border border-slate-200 bg-white py-1 shadow-[0_18px_40px_rgba(15,23,42,0.14)]">
                  <button
                    type="button"
                    onClick={() => void downloadTranscripts("txt")}
                    className="block w-full px-3 py-2 text-left text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-50"
                  >
                    text形式
                  </button>
                  <button
                    type="button"
                    onClick={() => void downloadTranscripts("md")}
                    className="block w-full px-3 py-2 text-left text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-50"
                  >
                    md形式
                  </button>
                </div>
              ) : null}
            </div>
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
          className="app-scrollbar flex-1 overflow-auto px-4 pb-6 pt-0 sm:px-6 lg:px-8"
        >
          {activeTranscriptView === "minutes" ? (
            <div
              ref={minutesSplitRef}
              className="mx-auto flex w-full max-w-[1380px] flex-col overflow-hidden pb-10 pt-6 lg:min-h-[calc(100vh-12rem)] lg:flex-row"
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
              <div className="min-w-full pr-4" style={{ minWidth: `${transcriptTableMinWidth}px` }}>
                <div
                  className="sticky top-0 z-30 hidden border-b border-slate-200 bg-white px-0 py-4 text-[10px] font-bold uppercase tracking-[0.24em] text-slate-400 shadow-[0_1px_0_rgba(226,232,240,1)] lg:grid lg:gap-4"
                  style={transcriptGridStyle}
                >
<div className="relative min-w-0 pr-3">
  <div className="flex items-center gap-2">
    <span>{"\u8a71\u8005"}</span>
    <button
      type="button"
      onClick={() => setSpeakerEditMode((current) => !current)}
      className={`inline-flex h-5 w-5 items-center justify-center rounded border transition-colors ${
        speakerEditMode
          ? "border-[#007aff] bg-[#007aff]/10 text-[#007aff]"
          : "border-slate-200 text-slate-400 hover:border-[#007aff] hover:text-[#007aff]"
      }`}
      aria-label={"\u8a71\u8005\u540d\u306e\u7de8\u96c6\u3092\u5207\u308a\u66ff\u3048"}
    >
      <Pencil className="size-3" />
    </button>
  </div>
  <button
    type="button"
    onPointerDown={(event) =>
      handleTranscriptColumnResizePointerDown("speaker", event)
    }
    onPointerMove={handleTranscriptColumnResizePointerMove}
    onPointerUp={handleTranscriptColumnResizePointerUp}
    onPointerCancel={handleTranscriptColumnResizePointerUp}
    className="group absolute -right-2 top-0 h-full w-4 cursor-col-resize touch-none"
    aria-label={"\u8a71\u8005\u5217\u306e\u5e45\u3092\u5909\u66f4"}
  >
    <span className="absolute left-1/2 top-0 h-full w-px -translate-x-1/2 bg-slate-200 transition-colors group-hover:bg-[#007aff] group-active:bg-[#007aff]" />
  </button>
</div>
<div className="relative min-w-0 pr-3">
  <span>{"\u6642\u523b"}</span>
  <button
    type="button"
    onPointerDown={(event) =>
      handleTranscriptColumnResizePointerDown("time", event)
    }
    onPointerMove={handleTranscriptColumnResizePointerMove}
    onPointerUp={handleTranscriptColumnResizePointerUp}
    onPointerCancel={handleTranscriptColumnResizePointerUp}
    className="group absolute -right-2 top-0 h-full w-4 cursor-col-resize touch-none"
    aria-label={"\u6642\u523b\u5217\u306e\u5e45\u3092\u5909\u66f4"}
  >
    <span className="absolute left-1/2 top-0 h-full w-px -translate-x-1/2 bg-slate-200 transition-colors group-hover:bg-[#007aff] group-active:bg-[#007aff]" />
  </button>
</div>
{showRawTranscript ? (
  <div className="relative min-w-0 pr-3">
    <div className="flex items-center justify-between gap-3">
      <div className="flex items-center gap-2">
        <span>{"\u6587\u5b57\u8d77\u3053\u3057"}</span>
        <button
          type="button"
          onClick={() => {
            if (!showLlmRefined) {
              return;
            }
            setShowRawTranscript(false);
          }}
          disabled={!showLlmRefined}
          className={`relative h-4 w-7 rounded-full transition-colors ${
            showRawTranscript ? "bg-[#007aff]" : "bg-slate-300"
          } ${!showLlmRefined ? "cursor-not-allowed opacity-40" : ""}`}
          aria-label={"\u6587\u5b57\u8d77\u3053\u3057\u5217\u306e\u8868\u793a\u3092\u5207\u308a\u66ff\u3048"}
        >
          <span className="absolute right-0.5 top-0.5 h-3 w-3 rounded-full bg-white" />
        </button>
      </div>
      {!showLlmRefined ? (
        <button
          type="button"
          onClick={() => setShowLlmRefined(true)}
          className="rounded-full border border-[#007aff] px-2 py-0.5 text-[10px] font-bold text-[#007aff]"
          aria-label={"LLM\u6574\u5f62\u5217\u3092\u518d\u8868\u793a"}
        >
          {"LLM\u6574\u5f62\u3092\u8868\u793a"}
        </button>
      ) : null}
    </div>
    <button
      type="button"
      onPointerDown={(event) =>
        handleTranscriptColumnResizePointerDown("transcript", event)
      }
      onPointerMove={handleTranscriptColumnResizePointerMove}
      onPointerUp={handleTranscriptColumnResizePointerUp}
      onPointerCancel={handleTranscriptColumnResizePointerUp}
      className="group absolute -right-2 top-0 h-full w-4 cursor-col-resize touch-none"
      aria-label={"\u6587\u5b57\u8d77\u3053\u3057\u5217\u306e\u5e45\u3092\u5909\u66f4"}
    >
      <span className="absolute left-1/2 top-0 h-full w-px -translate-x-1/2 bg-slate-200 transition-colors group-hover:bg-[#007aff] group-active:bg-[#007aff]" />
    </button>
  </div>
) : null}
{showLlmRefined ? (
  <div className="min-w-0 pr-4">
    <div className="flex items-center gap-2">
      <span>{"LLM\u6574\u5f62"}</span>
      <button
        type="button"
        onClick={() => {
          if (!showRawTranscript) {
            return;
          }
          setShowLlmRefined(false);
        }}
        disabled={!showRawTranscript}
        className={`relative h-4 w-7 rounded-full transition-colors ${
          showLlmRefined ? "bg-[#007aff]" : "bg-slate-300"
        } ${!showRawTranscript ? "cursor-not-allowed opacity-40" : ""}`}
        aria-label={"LLM\u6574\u5f62\u5217\u306e\u8868\u793a\u3092\u5207\u308a\u66ff\u3048"}
      >
        <span className="absolute right-0.5 top-0.5 h-3 w-3 rounded-full bg-white" />
      </button>
      {!showRawTranscript ? (
        <button
          type="button"
          onClick={() => setShowRawTranscript(true)}
          className="rounded-full border border-[#007aff] px-2 py-0.5 text-[10px] font-bold text-[#007aff]"
          aria-label={"\u6587\u5b57\u8d77\u3053\u3057\u5217\u3092\u518d\u8868\u793a"}
        >
          {"\u6587\u5b57\u8d77\u3053\u3057\u3092\u8868\u793a"}
        </button>
      ) : null}
    </div>
  </div>
) : (
  <div className="min-w-0" aria-hidden />
)}
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
                      deferredSegments.map((segment, index) => {
                        const isPlaybackActive = playbackActiveSegmentId === segment.id;
                        const isPlaybackButtonActive =
                          isAudioPlaying && playbackActiveSegmentId === segment.id;
                        const timePlaybackCellClass = isPlaybackActive
                          ? "playback-cell playback-cell-active"
                          : "playback-cell";
                        const transcriptionModelLabel =
                          getTranscriptionModelLabel(segment);
                        const previousTranscriptionModelLabel =
                          index > 0
                            ? getTranscriptionModelLabel(deferredSegments[index - 1])
                            : null;
                        const showTranscriptionModelTag =
                          transcriptionModelLabel !== null &&
                          transcriptionModelLabel !== previousTranscriptionModelLabel;

                        return (
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
                            className="border-b border-slate-100 py-1.5 lg:grid lg:gap-4"
                            style={transcriptGridStyle}
                          >
                            <div
                              className="flex min-w-0 items-center justify-between gap-2 rounded-xl px-2 py-2 lg:block"
                            >
                              <div className="flex items-center gap-1">
                                <p
                                  className="truncate text-[11px] font-semibold text-slate-900"
                                  title={segment.speakerLabel}
                                >
                                  {segment.speakerLabel}
                                </p>
                                {speakerEditMode ? (
                                  <button
                                    type="button"
                                    onClick={() =>
                                      openSpeakerRenameModal(
                                        segment.speakerIndex,
                                        segment.speakerLabel,
                                      )
                                    }
                                    className="inline-flex h-5 w-5 items-center justify-center rounded text-slate-300 transition-colors hover:bg-slate-100 hover:text-slate-500"
                                    aria-label={`${segment.speakerLabel} \u3092\u7de8\u96c6`}
                                  >
                                    <Pencil className="size-3" />
                                  </button>
                                ) : null}
                              </div>
                              <span className="app-mono text-[11px] font-semibold text-slate-500 lg:hidden">
                                {formatLongClock(segment.startedAt)}
                              </span>
                            </div>

                            <div
                              className={`mt-1 min-w-0 rounded-xl px-2 py-2 app-mono text-[11px] text-slate-400 lg:mt-0 ${timePlaybackCellClass}`}
                            >
                              <div className="flex items-center gap-2">
                                <p className="font-semibold text-slate-500">
                                  {formatLongClock(segment.startedAt)}
                                </p>
                                {showAudioPlayer ? (
                                  <button
                                    type="button"
                                    onClick={() => void playSegmentAudio(segment)}
                                    className={`inline-flex h-6 w-6 items-center justify-center rounded-full border transition-colors ${
                                      isPlaybackButtonActive
                                        ? "border-[#007aff] bg-[#007aff] text-white hover:border-[#0062cc] hover:bg-[#0062cc]"
                                        : "border-slate-200 bg-white text-slate-400 hover:border-slate-300 hover:text-slate-600"
                                    }`}
                                    aria-label={
                                      isPlaybackButtonActive
                                        ? `${formatLongClock(segment.startedAt)} の再生を停止`
                                        : `${formatLongClock(segment.startedAt)} から再生`
                                    }
                                  >
                                    {isPlaybackButtonActive ? (
                                      <Square className="size-2.5" />
                                    ) : (
                                      <Play className="ml-0.5 size-3" />
                                    )}
                                  </button>
                                ) : null}
                              </div>
                              {showTranscriptionModelTag ? (
                                <span
                                  className="mt-1 inline-flex max-w-full items-center gap-1 rounded-md bg-[#007aff] px-1.5 py-0.5 text-[11px] font-bold text-white"
                                  title={transcriptionModelLabel ?? undefined}
                                >
                                  <Tag className="size-3 shrink-0" />
                                  <span className="truncate">
                                    {transcriptionModelLabel}
                                  </span>
                                </span>
                              ) : null}
                            </div>
                            {showRawTranscript ? (
                              <div className="mt-1 min-w-0 rounded-xl px-3 py-2 lg:mt-0">
                                <textarea
                                  value={segment.text}
                                  rows={Math.max(
                                    1,
                                    Math.ceil(Math.max(segment.text.length, 1) / 340),
                                  )}
                                  onChange={(event) =>
                                    onSegmentEdit(segment.id, event.target.value)
                                  }
                                  className="w-full resize-none border-0 bg-transparent px-0 py-0 text-slate-900 outline-none transition focus:bg-white/50"
                                  style={{
                                    fontSize: "11px",
                                    fontWeight: 600,
                                    lineHeight: "16px",
                                  }}
                                />
                              </div>
                            ) : null}

                            {showLlmRefined &&
                            (segment.llmText ||
                              segment.llmStatus === "pending" ||
                              segment.llmStatus === "error") ? (
                              <div className="mt-2 min-w-0 overflow-hidden rounded-xl bg-slate-50 px-3 py-2 pr-4 transition-all duration-300 lg:mt-0">
                                {segment.llmStatus === "pending" ? (
                                  <p className="text-[11px] font-semibold text-slate-400">
                                    整形中...
                                  </p>
                                ) : segment.llmStatus === "error" ? (
                                  <p
                                    className="text-[11px] font-semibold text-rose-500"
                                    title={segment.llmError ?? undefined}
                                  >
                                    整形に失敗しました
                                  </p>
                                ) : (
                                  <p
                                    className="w-full min-w-0 max-w-full whitespace-pre-wrap break-words text-slate-900 [overflow-wrap:anywhere]"
                                    style={{
                                      fontSize: "11px",
                                      fontWeight: 600,
                                      lineHeight: "16px",
                                    }}
                                  >
                                    {segment.llmText}
                                  </p>
                                )}
                              </div>
                            ) : null}
                          </motion.article>
                        );
                      })
                    )}
                  </AnimatePresence>
                  {hasActiveCapture ? <div aria-hidden className="h-[24vh]" /> : null}
                </div>
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

            {hasActiveCapture ? (
              recognitionStopped ? (
                <div className="inline-flex h-10 items-center rounded-lg border border-amber-200 bg-amber-50 px-3 text-xs font-semibold text-amber-700">
                  録音のみ継続中
                </div>
              ) : (
                <Button
                  type="button"
                  variant="secondary"
                  className="border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100"
                  onClick={stopRecognitionOnly}
                  disabled={status !== "recording"}
                >
                  <MicOff className="size-4" />
                  認識中止
                </Button>
              )
            ) : null}

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
                className="relative inline-flex h-10 overflow-hidden rounded-lg border border-[#007aff] bg-white px-4 text-[11px] font-semibold text-[#007aff] transition-colors hover:bg-[#007aff]/10 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {selectedMinutesProcessing ? (
                  <span
                    aria-hidden
                    className="absolute inset-y-0 left-0 bg-[#007aff]/14 transition-[width] duration-300"
                    style={{
                      width: `${Math.max(0, Math.min(100, selectedMinutesProgress))}%`,
                    }}
                  />
                ) : null}
                <span className="relative z-10 inline-flex items-center justify-center gap-2">
                  {selectedMinutesProcessing ? (
                    <LoaderCircle className="size-4 animate-spin" />
                  ) : (
                    <FileText className="size-4" />
                  )}
{selectedMinutesProcessing
  ? `文字起こし整形 ${Math.max(0, Math.min(100, selectedMinutesProgress))}%`
  : "文字起こし整形"}
                </span>
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
              aria-label="設定パネルを閉じる"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={closeSettingsPanel}
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
                    設定
                  </p>
                  <h2 className="mt-1 text-lg font-semibold text-slate-900">
                    録音とAI処理の設定
                  </h2>
                </div>
                <button
                  type="button"
                  onClick={closeSettingsPanel}
                  className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-slate-200 text-slate-500 transition-colors hover:border-slate-300 hover:text-slate-700"
                  aria-label="設定を閉じる"
                >
                  <X className="size-4" />
                </button>
              </div>

              <div className="app-scrollbar flex-1 space-y-6 overflow-y-auto px-6 py-6">
                <section className="space-y-4">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-slate-400">
                    マイク設定
                  </p>

                  <div className="space-y-2">
                    <label className="field-label">マイク</label>
                    <select
                      value={deviceId}
                      onChange={(event) => setDeviceId(event.target.value)}
                      className="field-input"
                    >
                      {devices.length === 0 ? (
                        <option value="">マイクが見つかりません</option>
                      ) : (
                        devices.map((device) => (
                          <option key={device.deviceId} value={device.deviceId}>
                            {device.label || "名前のないマイク"}
                          </option>
                        ))
                      )}
                    </select>
                  </div>

                  {draftSettings ? (
                    <>
                      <div className="border-t border-slate-100 pt-4">
                        <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-slate-400">
                          リアルタイム
                        </p>
                      </div>

                      <div className="grid gap-4 sm:grid-cols-2">
                        <div className="space-y-2">
                          <label className="field-label">言語</label>
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
                          <label className="field-label">リアルタイム文字起こし</label>
                          <select
                            value={
                              draftSettings.transcription.realtimeTranscriptionEngine
                            }
                            onChange={(event) => {
                              const nextEngine = event.target.value as
                                | "moonshine"
                                | "groq";
                              updateDraftSettings((current) => ({
                                ...current,
                                transcription: {
                                  ...current.transcription,
                                  realtimeTranscriptionEngine: nextEngine,
                                  groqTranscriptionModel:
                                    current.transcription.groqTranscriptionModel ||
                                    DEFAULT_GROQ_TRANSCRIPTION_MODEL,
                                },
                              }));
                            }}
                            className="field-input"
                          >
                            {(
                              meta?.realtimeTranscriptionEngines ??
                              FALLBACK_REALTIME_TRANSCRIPTION_ENGINES
                            ).map((engine) => (
                              <option key={engine} value={engine}>
                                {REALTIME_ENGINE_LABELS[engine] ?? engine}
                              </option>
                            ))}
                          </select>
                        </div>
                      </div>

                      <div className="grid gap-4 sm:grid-cols-2">
                        <div className="space-y-2">
                          <label className="field-label">
                            {draftSettings.transcription.realtimeTranscriptionEngine ===
                            "groq"
                              ? "Groq文字起こしモデル"
                              : "Moonshineモデル"}
                          </label>
                          {draftSettings.transcription.realtimeTranscriptionEngine ===
                          "groq" ? (
                            <select
                              value={draftSettings.transcription.groqTranscriptionModel}
                              onChange={(event) =>
                                updateDraftSettings((current) => ({
                                  ...current,
                                  transcription: {
                                    ...current.transcription,
                                    groqTranscriptionModel: event.target.value,
                                  },
                                }))
                              }
                              className="field-input"
                            >
                              {(
                                meta?.groqTranscriptionModels ??
                                FALLBACK_GROQ_TRANSCRIPTION_MODELS
                              ).map((model) => (
                                <option key={model} value={model}>
                                  Groq {model}
                                </option>
                              ))}
                            </select>
                          ) : (
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
                          )}
                        </div>
                      </div>

                      <div className="grid gap-4 sm:grid-cols-2">
                        <div className="space-y-2">
                          <label className="field-label">話者数</label>
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
                          <label className="field-label">更新間隔 ms</label>
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
                            単語タイムスタンプを有効化
                          </p>
                          <p className="mt-1 text-xs text-slate-500">
                            Moonshineに単語単位の時刻ヒントを渡します。
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
                        <div className="flex items-center gap-2">
                          <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-slate-400">
                            LLM整形
                          </p>
                          <button
                            type="button"
                            onClick={() => setSettingsHelpTopic("localLlm")}
                            className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-slate-200 text-slate-400 transition-colors hover:border-[#007aff] hover:text-[#007aff]"
                            aria-label="LLM整形の説明"
                          >
                            <CircleHelp className="size-3.5" />
                          </button>
                        </div>
                      </div>

                      <label className="flex items-center justify-between rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
                        <div>
                          <p className="text-sm font-medium text-slate-900">
                            LLM整形を有効化
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
                          <label className="field-label">LLMプロバイダー</label>
                          <select
                            value={draftSettings.llm.provider}
                            onChange={(event) => {
                              const nextProvider = event.target.value as
                                | "ollama"
                                | "groq";
                              updateDraftSettings((current) => ({
                                ...current,
                                llm: {
                                  ...current.llm,
                                  provider: nextProvider,
                                  model:
                                    nextProvider === "groq"
                                      ? DEFAULT_GROQ_LLM_MODEL
                                      : DEFAULT_OLLAMA_LLM_MODEL,
                                },
                              }));
                            }}
                            className="field-input"
                          >
                            {(meta?.llmProviders ?? FALLBACK_LLM_PROVIDERS).map(
                              (provider) => (
                                <option key={provider} value={provider}>
                                  {LLM_PROVIDER_LABELS[provider] ?? provider}
                                </option>
                              ),
                            )}
                          </select>
                        </div>

                        <div className="space-y-2">
                          <label className="field-label">
                            {draftSettings.llm.provider === "groq"
                              ? "Groqモデル"
                              : "Gemmaモデル"}
                          </label>
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
                            {(draftSettings.llm.provider === "groq"
                              ? meta?.groqLlmModels ?? FALLBACK_GROQ_LLM_MODELS
                              : meta?.ollamaLlmModels ?? OLLAMA_LLM_MODEL_OPTIONS
                            ).map((model) => (
                              <option key={model} value={model}>
                                {model}
                              </option>
                            ))}
                          </select>
                        </div>

                        <div className="space-y-2">
                          <label className="field-label">前の文脈行数</label>
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
                          <label className="field-label">後ろの文脈行数</label>
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
                          <label className="field-label">待機時間 ms</label>
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
                          <label className="field-label">最大待機 ms</label>
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
                          <label className="field-label">
                            {draftSettings.llm.provider === "groq"
                              ? "Groq APIベースURL"
                              : "Ollama URL"}
                          </label>
                          <input
                            type="text"
                            value={
                              draftSettings.llm.provider === "groq"
                                ? draftSettings.llm.groqBaseUrl
                                : draftSettings.llm.baseUrl
                            }
                            onChange={(event) =>
                              updateDraftSettings((current) => ({
                                ...current,
                                llm: {
                                  ...current.llm,
                                  ...(current.llm.provider === "groq"
                                    ? { groqBaseUrl: event.target.value }
                                    : { baseUrl: event.target.value }),
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
                            完了行のみ整形
                          </p>
                          <p className="mt-1 text-xs text-slate-500">
                            文字起こしエンジンが行を完了扱いにしてから整形します。
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
                      <div className="flex items-center gap-2">
                        <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-slate-400">
                          バッチ処理（文字起こし→整形）
                        </p>
                        <button
                          type="button"
                          onClick={() => setSettingsHelpTopic("batch")}
                          className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-slate-200 text-slate-400 transition-colors hover:border-[#007aff] hover:text-[#007aff]"
                          aria-label="バッチ処理設定の説明"
                        >
                          <CircleHelp className="size-3.5" />
                        </button>
                      </div>

                      <div className="grid gap-4 sm:grid-cols-2">
                        <div className="space-y-2">
                          <label className="field-label">文字起こしエンジン</label>
                          <select
                            value={draftSettings.transcription.batchTranscriptionEngine}
                            onChange={(event) =>
                              updateDraftSettings((current) => ({
                                ...current,
                                transcription: {
                                  ...current.transcription,
                                  batchTranscriptionEngine: event.target.value as
                                    | "faster-whisper"
                                    | "moonshine"
                                    | "groq",
                                },
                              }))
                            }
                            className="field-input"
                          >
                            {(
                              meta?.batchTranscriptionEngines ??
                              FALLBACK_BATCH_TRANSCRIPTION_ENGINES
                            ).map((engine) => (
                              <option key={engine} value={engine}>
                                {BATCH_ENGINE_LABELS[engine] ?? engine}
                              </option>
                            ))}
                          </select>
                        </div>

                        <div className="space-y-2">
                          <label className="field-label">文字起こしモデル</label>
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
                          ) : draftSettings.transcription.batchTranscriptionEngine ===
                            "groq" ? (
                            <select
                              value={
                                draftSettings.transcription.batchGroqTranscriptionModel
                              }
                              onChange={(event) =>
                                updateDraftSettings((current) => ({
                                  ...current,
                                  transcription: {
                                    ...current.transcription,
                                    batchGroqTranscriptionModel: event.target.value,
                                  },
                                }))
                              }
                              className="field-input"
                            >
                              {(
                                meta?.groqTranscriptionModels ??
                                FALLBACK_GROQ_TRANSCRIPTION_MODELS
                              ).map((model) => (
                                <option key={model} value={model}>
                                  Groq {model}
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
                              {(meta?.fasterWhisperModels ??
                                FALLBACK_FASTER_WHISPER_MODELS).map((model) => (
                                <option key={model} value={model}>
                                  Faster Whisper {model}
                                </option>
                              ))}
                            </select>
                          )}
                        </div>

                        <div className="space-y-2">
                          <label className="field-label">整形LLM</label>
                          <select
                            value={draftSettings.llm.batchSummaryProvider}
                            onChange={(event) => {
                              const nextProvider = event.target.value as
                                | "ollama"
                                | "groq";
                              updateDraftSettings((current) => ({
                                ...current,
                                llm: {
                                  ...current.llm,
                                  batchSummaryProvider: nextProvider,
                                  batchSummaryModel:
                                    nextProvider === "groq"
                                      ? DEFAULT_GROQ_LLM_MODEL
                                      : DEFAULT_OLLAMA_BATCH_SUMMARY_MODEL,
                                },
                              }));
                            }}
                            className="field-input"
                          >
                            {(meta?.llmProviders ?? FALLBACK_LLM_PROVIDERS).map(
                              (provider) => (
                                <option key={provider} value={provider}>
                                  {LLM_PROVIDER_LABELS[provider] ?? provider}
                                </option>
                              ),
                            )}
                          </select>
                        </div>

                        <div className="space-y-2">
                          <label className="field-label">整形モデル</label>
                          <select
                            value={draftSettings.llm.batchSummaryModel}
                            onChange={(event) =>
                              updateDraftSettings((current) => ({
                                ...current,
                                llm: {
                                  ...current.llm,
                                  batchSummaryModel: event.target.value,
                                },
                              }))
                            }
                            className="field-input"
                          >
                            {(draftSettings.llm.batchSummaryProvider === "groq"
                              ? meta?.groqLlmModels ?? FALLBACK_GROQ_LLM_MODELS
                              : meta?.ollamaLlmModels ?? OLLAMA_LLM_MODEL_OPTIONS
                            ).map((model) => (
                              <option key={model} value={model}>
                                {model}
                              </option>
                            ))}
                          </select>
                        </div>

                        <div className="space-y-2 rounded-xl border border-slate-200 bg-slate-50 p-4 sm:col-span-2">
                          <label className="field-label">使用プロンプト</label>
                          <div className="flex gap-2">
                            <select
                              value={activePromptId}
                              onChange={(event) => selectActivePrompt(event.target.value)}
                              className="field-input"
                            >
                              {promptList.map((prompt) => (
                                <option key={prompt.id} value={prompt.id}>
                                  {prompt.name}
                                </option>
                              ))}
                            </select>
                            <Button
                              type="button"
                              variant="secondary"
                              className="h-11 shrink-0 rounded-xl px-4 text-sm"
                              onClick={() => void saveSettings(draftSettings)}
                              disabled={savingSettings || promptList.length === 0}
                            >
                              {savingSettings ? (
                                <LoaderCircle className="size-4 animate-spin" />
                              ) : (
                                <Save className="size-4" />
                              )}
                              保存
                            </Button>
                          </div>
                          <p className="text-xs leading-5 text-slate-500">
                            バッチ処理の整形で使う用途テンプレートです。
                          </p>
                        </div>
                      </div>
                    </section>

                    <section className="space-y-4">
                      <div>
                        <div className="flex items-center gap-2">
                          <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-slate-400">
                            AIプロバイダー
                          </p>
                          <button
                            type="button"
                            onClick={() => setSettingsHelpTopic("providers")}
                            className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-slate-200 text-slate-400 transition-colors hover:border-[#007aff] hover:text-[#007aff]"
                            aria-label="AIプロバイダーの説明"
                          >
                            <CircleHelp className="size-3.5" />
                          </button>
                        </div>
                      </div>

                      <div className="space-y-2">
                        <label className="field-label">OpenAI APIキー</label>
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
                        <label className="field-label">OpenAIモデル</label>
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
                        <label className="field-label">Anthropic APIキー</label>
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
                        <label className="field-label">Anthropicモデル</label>
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
                        <label className="field-label">Groq APIキー</label>
                        <input
                          type="password"
                          value={draftSettings.apiSettings.providers.groq.apiKey}
                          onChange={(event) =>
                            updateDraftSettings((current) => ({
                              ...current,
                              apiSettings: {
                                ...current.apiSettings,
                                providers: {
                                  ...current.apiSettings.providers,
                                  groq: {
                                    ...current.apiSettings.providers.groq,
                                    apiKey: event.target.value,
                                  },
                                },
                              },
                            }))
                          }
                          className="field-input"
                          autoComplete="off"
                          placeholder="gsk_..."
                        />
                      </div>

                      <div className="space-y-2">
                        <label className="field-label">プロンプト下書き</label>
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
                      <p>
                        Config:{" "}
                        {toPortableWindowsPath(
                          settingsResponse.resolvedPaths.configPath,
                        )}
                      </p>
                      <p>
                        Repo:{" "}
                        {toPortableWindowsPath(settingsResponse.resolvedPaths.repoRoot)}
                      </p>
                      <p>
                        Models:{" "}
                        {toPortableWindowsPath(
                          settingsResponse.resolvedPaths.modelsRoot,
                        )}
                      </p>
                      <p>
                        Faster Whisper:{" "}
                        {toPortableWindowsPath(
                          settingsResponse.resolvedPaths.fasterWhisperModelsRoot,
                        )}
                      </p>
                      <p>
                        Data:{" "}
                        {toPortableWindowsPath(settingsResponse.resolvedPaths.dataRoot)}
                      </p>
                      <p>
                        Sessions:{" "}
                        {toPortableWindowsPath(
                          settingsResponse.resolvedPaths.sessionsRoot,
                        )}
                      </p>
                      <p>
                        Temp recordings:{" "}
                        {toPortableWindowsPath(
                          settingsResponse.resolvedPaths.tempRecordingsRoot,
                        )}
                      </p>
                      <p>
                        Frontend dist:{" "}
                        {toPortableWindowsPath(
                          settingsResponse.resolvedPaths.frontendDist,
                        )}
                      </p>
                    </div>
                  </section>
                ) : null}
              </div>

              <div className="flex gap-3 border-t border-slate-200 px-6 py-5">
                <Button
                  variant="secondary"
                  className="flex-1"
                  onClick={closeSettingsPanel}
                >
                  Close
                </Button>
                <Button
                  className="flex-1"
                  onClick={saveSettingsAndClose}
                  disabled={savingSettings || !draftSettings}
                >
                  {savingSettings ? (
                    <LoaderCircle className="size-4 animate-spin" />
                  ) : (
                    <Save className="size-4" />
                  )}
                  保存して閉じる
                </Button>
              </div>
            </motion.aside>
          </>
        ) : null}
      </AnimatePresence>

      <AnimatePresence>
        {settingsHelpTopic ? (
          <>
            <motion.button
              type="button"
              aria-label="Close help modal"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setSettingsHelpTopic(null)}
              className="fixed inset-0 z-[70] bg-slate-950/35"
            />
            <motion.div
              role="dialog"
              aria-modal="true"
              aria-labelledby="settings-help-title"
              initial={{ opacity: 0, y: 18, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 12, scale: 0.98 }}
              transition={{ duration: 0.18, ease: "easeOut" }}
              className="fixed left-1/2 top-1/2 z-[80] flex max-h-[82vh] w-[min(92vw,760px)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_24px_90px_rgba(15,23,42,0.22)]"
            >
              <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-5 py-4">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-slate-400">
                    Help
                  </p>
                  <h3
                    id="settings-help-title"
                    className="mt-1 text-lg font-semibold text-slate-900"
                  >
                    {SETTINGS_HELP_TITLES[settingsHelpTopic]}
                  </h3>
                </div>
                <button
                  type="button"
                  onClick={() => setSettingsHelpTopic(null)}
                  className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-slate-200 text-slate-500 transition-colors hover:border-slate-300 hover:text-slate-700"
                  aria-label="Close help"
                >
                  <X className="size-4" />
                </button>
              </div>
              <div className="app-scrollbar overflow-y-auto px-5 py-5">
                <SettingsHelpContent topic={settingsHelpTopic} />
              </div>
            </motion.div>
          </>
        ) : null}
      </AnimatePresence>

      <AnimatePresence>
        {speakerRenameState ? (
          <>
            <motion.button
              type="button"
              aria-label="Close speaker rename modal"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={closeSpeakerRenameModal}
              className="fixed inset-0 z-[70] bg-slate-950/35"
            />
            <motion.div
              role="dialog"
              aria-modal="true"
              aria-labelledby="speaker-rename-title"
              initial={{ opacity: 0, y: 18, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 12, scale: 0.98 }}
              transition={{ duration: 0.18, ease: "easeOut" }}
              className="fixed left-1/2 top-1/2 z-[80] flex w-[min(92vw,520px)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_24px_90px_rgba(15,23,42,0.22)]"
            >
              <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-5 py-4">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-slate-400">
                    {"\u8a71\u8005"}
                  </p>
                  <h3
                    id="speaker-rename-title"
                    className="mt-1 text-lg font-semibold text-slate-900"
                  >
                    {"\u8a71\u8005\u540d\u3092\u5909\u66f4"}
                  </h3>
                </div>
                <button
                  type="button"
                  onClick={closeSpeakerRenameModal}
                  className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-slate-200 text-slate-500 transition-colors hover:border-slate-300 hover:text-slate-700"
                  aria-label="Close speaker rename"
                >
                  <X className="size-4" />
                </button>
              </div>
              <form
                className="space-y-4 px-5 py-5"
                onSubmit={(event) => {
                  event.preventDefault();
                  submitSpeakerRename();
                }}
              >
                <div className="space-y-2">
                  <label
                    htmlFor="speaker-rename-input"
                    className="text-[11px] font-semibold uppercase tracking-[0.24em] text-slate-400"
                  >
                    {"\u8868\u793a\u540d"}
                  </label>
                  <input
                    id="speaker-rename-input"
                    ref={speakerRenameInputRef}
                    value={speakerRenameState.draft}
                    onChange={(event) =>
                      setSpeakerRenameState((current) =>
                        current ? { ...current, draft: event.target.value } : current,
                      )
                    }
                    className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm font-medium text-slate-900 outline-none transition focus:border-[#007aff] focus:ring-4 focus:ring-[#007aff]/10"
                    placeholder={speakerRenameState.currentLabel}
                  />
                  <p className="text-sm leading-6 text-slate-500">
                    {
                      "\u540c\u3058\u8a71\u8005\u3068\u3057\u3066\u6271\u308f\u308c\u3066\u3044\u308b\u884c\u306b\u307e\u3068\u3081\u3066\u53cd\u6620\u3055\u308c\u307e\u3059\u3002"
                    }
                  </p>
                </div>
                <div className="flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={closeSpeakerRenameModal}
                    className="inline-flex h-10 items-center justify-center rounded-xl border border-slate-200 bg-white px-4 text-sm font-semibold text-slate-600 transition-colors hover:border-slate-300 hover:text-slate-800"
                  >
                    {"\u30ad\u30e3\u30f3\u30bb\u30eb"}
                  </button>
                  <Button type="submit" className="h-10 rounded-xl px-4 text-sm">
                    {"\u5909\u66f4"}
                  </Button>
                </div>
              </form>
            </motion.div>
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
if (sidebarSelectionMode) {
  exitSidebarSelectionMode();
} else {
  setSidebarSelectionMode(true);
  setSidebarSelectedRecordIds([sidebarContextRecord.id]);
  lastSidebarSelectedRecordIdRef.current = sidebarContextRecord.id;
}
              setSidebarContextMenu(null);
            }}
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-slate-600 transition-colors hover:bg-slate-50 hover:text-slate-900"
          >
            {sidebarSelectionMode ? <X className="size-4" /> : <Square className="size-4" />}
            {sidebarSelectionMode ? "選択を終了" : "選択"}
          </button>
          {sidebarSelectionMode && validSidebarSelectedRecordIds.length > 0 ? (
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
              選択解除
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
