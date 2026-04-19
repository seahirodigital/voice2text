export type SpeakerSource =
  | "moonshine"
  | "feature-fallback"
  | "carry-forward";

export type RecordingStatus =
  | "idle"
  | "connecting"
  | "recording"
  | "paused"
  | "saving"
  | "error";

export interface ProviderConfig {
  apiKey: string;
  model: string;
}

export interface AppSettings {
  paths: {
    modelsRoot: string;
    dataRoot: string;
    tempRecordingsRoot: string;
    frontendDist: string;
  };
  transcription: {
    language: string;
    modelPreset: string;
    maxSpeakers: number;
    updateIntervalMs: number;
    enableWordTimestamps: boolean;
  };
  apiSettings: {
    systemPrompt: string;
    providers: {
      openai: ProviderConfig;
      anthropic: ProviderConfig;
    };
  };
}

export interface ResolvedPaths {
  configPath: string;
  repoRoot: string;
  modelsRoot: string;
  dataRoot: string;
  sessionsRoot: string;
  tempRecordingsRoot: string;
  frontendDist: string;
}

export interface SettingsResponse {
  settings: AppSettings;
  resolvedPaths: ResolvedPaths;
}

export interface TranscriptSegment {
  id: string;
  lineId: number;
  text: string;
  speakerLabel: string;
  speakerIndex: number;
  speakerSource: SpeakerSource;
  startedAt: number;
  duration: number;
  isComplete: boolean;
  latencyMs: number;
  updatedAt: string;
}

export interface SessionSummary {
  id: string;
  createdAt: string;
  updatedAt: string;
  language: string;
  deviceLabel: string;
  durationSeconds: number;
  lineCount: number;
  title: string;
  audioUrl?: string | null;
}

export interface SessionDetail extends SessionSummary {
  segments: TranscriptSegment[];
}

export interface MetaResponse {
  supportedLanguages: string[];
  availableModelsByLanguage: Record<string, string[]>;
  defaultLanguage: string;
  defaultModelPreset: string;
}

export interface SocketMessage {
  type: string;
  payload: Record<string, unknown>;
}

