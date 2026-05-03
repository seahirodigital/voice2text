from __future__ import annotations

import io
import json
import os
import platform
import queue
import re
import subprocess
import sys
import threading
import time
import wave
import webbrowser
from dataclasses import asdict, dataclass, field
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlparse

import httpx


APP_ROOT = Path(__file__).resolve().parent
CONFIG_PATH = APP_ROOT / "aqua_voice_config.json"
GROQ_BASE_URL = "https://api.groq.com/openai/v1"
GROQ_API_KEY_RE = re.compile(r"gsk_[A-Za-z0-9_-]+")
SERVER_HOST = "127.0.0.1"
SERVER_PORT = 8766


@dataclass
class DictionaryEntry:
    spoken: str
    replacement: str


@dataclass
class AquaVoiceSettings:
    language: str = "ja"
    transcription_model: str = "whisper-large-v3-turbo"
    llm_model: str = "llama-3.1-8b-instant"
    groq_api_key: str = ""
    shortcut_key: str = "option"
    sample_rate: int = 16000
    chunk_seconds: float = 1.2
    double_tap_ms: int = 350
    hold_start_ms: int = 160
    paste_after_refine: bool = True
    dictionary: list[DictionaryEntry] = field(default_factory=list)


@dataclass
class RuntimeState:
    status: str = "待機中"
    recording: bool = False
    locked_recording: bool = False
    processing: bool = False
    input_level: float = 0.0
    transcription_latency_ms: int | None = None
    llm_latency_ms: int | None = None
    last_error: str = ""
    raw_lines: list[str] = field(default_factory=list)
    refined_lines: list[str] = field(default_factory=list)
    final_text: str = ""
    hotkey_enabled: bool = False
    server_url: str = f"http://{SERVER_HOST}:{SERVER_PORT}"
    paste_target_name: str = ""
    paste_target_detail: str = ""


@dataclass
class PasteTarget:
    platform: str
    name: str = ""
    bundle_id: str = ""
    process_id: int = 0
    window_handle: int = 0


def normalize_groq_api_key(raw_value: str | None) -> str:
    value = (raw_value or "").strip()
    if not value:
        return ""
    if "=" in value:
        maybe_name, maybe_value = value.split("=", 1)
        if maybe_name.strip() == "GROQ_API_KEY":
            value = maybe_value.strip()
    if value.lower().startswith("bearer "):
        value = value[7:].strip()
    match = GROQ_API_KEY_RE.search(value)
    return match.group(0) if match else value


def mask_secret(value: str) -> str:
    if not value:
        return ""
    if len(value) <= 10:
        return "保存済み"
    return f"{value[:6]}...{value[-4:]}"


def load_settings() -> AquaVoiceSettings:
    if not CONFIG_PATH.exists():
        return AquaVoiceSettings()
    try:
        payload = json.loads(CONFIG_PATH.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError):
        return AquaVoiceSettings()

    dictionary = [
        DictionaryEntry(
            spoken=str(item.get("spoken", "")),
            replacement=str(item.get("replacement", "")),
        )
        for item in payload.get("dictionary", [])
        if isinstance(item, dict)
    ]
    payload["dictionary"] = dictionary
    allowed = set(AquaVoiceSettings.__dataclass_fields__)
    filtered = {key: value for key, value in payload.items() if key in allowed}
    return AquaVoiceSettings(**filtered)


def save_settings(settings: AquaVoiceSettings) -> None:
    CONFIG_PATH.write_text(
        json.dumps(asdict(settings), ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def pcm16_wav_bytes(frame_bytes: bytes, *, sample_rate: int, channels: int = 1) -> bytes:
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav_file:
        wav_file.setnchannels(channels)
        wav_file.setsampwidth(2)
        wav_file.setframerate(sample_rate)
        wav_file.writeframes(frame_bytes)
    return buffer.getvalue()


def apply_dictionary(text: str, dictionary: list[DictionaryEntry]) -> str:
    corrected = text
    for entry in dictionary:
        spoken = entry.spoken.strip()
        replacement = entry.replacement.strip()
        if spoken and replacement:
            corrected = corrected.replace(spoken, replacement)
    return corrected


class GroqClient:
    def __init__(self, api_key_provider: Callable[[], str]) -> None:
        self.api_key_provider = api_key_provider

    def _headers(self) -> dict[str, str]:
        api_key = normalize_groq_api_key(self.api_key_provider())
        if not api_key:
            raise ValueError("Groq APIキーが未設定です。Web UI上部に入力してください。")
        if not GROQ_API_KEY_RE.fullmatch(api_key):
            raise ValueError("Groq APIキーは gsk_ から始まる値だけを指定してください。")
        return {"Authorization": f"Bearer {api_key}"}

    def transcribe(
        self,
        *,
        wav_bytes: bytes,
        filename: str,
        language: str,
        model: str,
    ) -> tuple[str, int]:
        started = time.perf_counter()
        with httpx.Client(timeout=30.0) as client:
            response = client.post(
                f"{GROQ_BASE_URL}/audio/transcriptions",
                headers=self._headers(),
                data={
                    "model": model,
                    "language": language,
                    "response_format": "json",
                    "temperature": "0",
                },
                files={"file": (filename, wav_bytes, "audio/wav")},
            )
            latency_ms = int((time.perf_counter() - started) * 1000)
            response.raise_for_status()
        payload = response.json()
        text = payload.get("text") if isinstance(payload, dict) else ""
        return str(text or "").strip(), latency_ms

    def refine(
        self,
        *,
        text: str,
        settings: AquaVoiceSettings,
        final: bool,
    ) -> tuple[str, int]:
        dictionary_lines = [
            f"- {entry.spoken.strip()} => {entry.replacement.strip()}"
            for entry in settings.dictionary
            if entry.spoken.strip() and entry.replacement.strip()
        ]
        dictionary_block = "\n".join(dictionary_lines) if dictionary_lines else "なし"
        final_rule = (
            "最終貼り付け用です。自然な一文または短い段落にしてください。"
            if final
            else "ライブ確認用です。短く素早く整えてください。"
        )
        system_prompt = (
            "あなたは超低遅延の日本語音声入力整形エンジンです。"
            "音声認識結果の言い淀み、重複、明らかな句読点不足だけを直します。"
            "意味を増やさず、説明や前置きは出さず、貼り付ける本文だけを返します。"
            f"{final_rule}\n"
            "辞書登録:\n"
            f"{dictionary_block}"
        )
        started = time.perf_counter()
        with httpx.Client(timeout=30.0) as client:
            response = client.post(
                f"{GROQ_BASE_URL}/chat/completions",
                headers={**self._headers(), "Content-Type": "application/json"},
                json={
                    "model": settings.llm_model,
                    "stream": False,
                    "temperature": 0.1,
                    "max_completion_tokens": 256 if not final else 512,
                    "messages": [
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": text},
                    ],
                },
            )
            latency_ms = int((time.perf_counter() - started) * 1000)
            response.raise_for_status()
        payload = response.json()
        choices = payload.get("choices") if isinstance(payload, dict) else []
        choice = choices[0] if choices else {}
        message = choice.get("message") if isinstance(choice, dict) else {}
        refined = message.get("content") if isinstance(message, dict) else ""
        return str(refined or "").strip(), latency_ms


class AudioRecorder:
    def __init__(
        self,
        *,
        sample_rate: int,
        level_callback: Callable[[float], None],
    ) -> None:
        self.sample_rate = sample_rate
        self.level_callback = level_callback
        self.frames: queue.Queue[bytes] = queue.Queue()
        self.stream: object | None = None
        self.recording = False
        self._lock = threading.Lock()

    def start(self) -> None:
        import sounddevice as sd

        with self._lock:
            if self.recording:
                return
            self._clear_queue()
            self.recording = True
            self.stream = sd.InputStream(
                samplerate=self.sample_rate,
                channels=1,
                dtype="int16",
                blocksize=1024,
                callback=self._on_audio,
            )
            self.stream.start()

    def stop(self) -> bytes:
        with self._lock:
            self.recording = False
            if self.stream is not None:
                self.stream.stop()
                self.stream.close()
            self.stream = None
            return self.pop_all()

    def pop_all(self) -> bytes:
        chunks: list[bytes] = []
        while True:
            try:
                chunks.append(self.frames.get_nowait())
            except queue.Empty:
                break
        return b"".join(chunks)

    def _clear_queue(self) -> None:
        while True:
            try:
                self.frames.get_nowait()
            except queue.Empty:
                return

    def _on_audio(self, indata, frames, time_info, status) -> None:  # type: ignore[no-untyped-def]
        frame_bytes = bytes(indata)
        self.frames.put(frame_bytes)
        self.level_callback(self._estimate_level(frame_bytes))

    @staticmethod
    def _estimate_level(frame_bytes: bytes) -> float:
        if not frame_bytes:
            return 0.0
        sample_count = len(frame_bytes) // 2
        if sample_count <= 0:
            return 0.0
        total = 0
        for index in range(0, len(frame_bytes), 2):
            sample = int.from_bytes(frame_bytes[index : index + 2], "little", signed=True)
            total += abs(sample)
        return min(1.0, (total / sample_count) / 12000.0)


class AutoPaste:
    BROWSER_BUNDLE_IDS = {
        "com.google.Chrome",
        "com.apple.Safari",
        "com.microsoft.edgemac",
        "org.mozilla.firefox",
        "com.brave.Browser",
        "com.vivaldi.Vivaldi",
        "com.operasoftware.Opera",
    }
    BROWSER_NAMES = {
        "Google Chrome",
        "Chrome",
        "Safari",
        "Microsoft Edge",
        "Firefox",
        "Brave Browser",
        "Vivaldi",
        "Opera",
    }

    @staticmethod
    def capture_target() -> PasteTarget | None:
        system = platform.system()
        if system == "Darwin":
            return AutoPaste._capture_macos_target()
        if system == "Windows":
            return AutoPaste._capture_windows_target()
        return None

    @staticmethod
    def paste(text: str, target: PasteTarget | None = None) -> None:
        if not text.strip():
            return
        system = platform.system()
        if system == "Darwin":
            subprocess.run(["pbcopy"], input=text.encode("utf-8"), check=True)
            time.sleep(0.05)
            AutoPaste._paste_macos(target)
            return
        if system == "Windows":
            AutoPaste._activate_windows_target(target)
            subprocess.run("clip", input=text.encode("utf-16le"), shell=True, check=True)
            AutoPaste._windows_ctrl_v()
            return
        raise RuntimeError(f"自動貼り付け未対応のOSです: {system}")

    @staticmethod
    def _capture_macos_target() -> PasteTarget | None:
        script = (
            'tell application "System Events"\n'
            '  set frontApp to first application process whose frontmost is true\n'
            '  set appName to name of frontApp\n'
            '  set bundleId to ""\n'
            '  try\n'
            '    set bundleId to bundle identifier of frontApp\n'
            '  end try\n'
            '  set processId to 0\n'
            '  try\n'
            '    set processId to unix id of frontApp\n'
            '  end try\n'
            '  return appName & linefeed & bundleId & linefeed & (processId as text)\n'
            "end tell"
        )
        try:
            result = subprocess.run(
                ["osascript", "-e", script],
                check=True,
                capture_output=True,
                text=True,
                timeout=2.0,
            )
        except Exception:
            return None
        lines = result.stdout.strip().splitlines()
        if not lines:
            return None
        name = lines[0].strip()
        bundle_id = lines[1].strip() if len(lines) > 1 else ""
        try:
            process_id = int(lines[2].strip()) if len(lines) > 2 else 0
        except ValueError:
            process_id = 0
        if not name and not bundle_id and process_id <= 0:
            return None
        return PasteTarget(platform="Darwin", name=name, bundle_id=bundle_id, process_id=process_id)

    @staticmethod
    def _activate_macos_target(target: PasteTarget | None) -> None:
        if target is None or target.platform != "Darwin":
            return
        script = (
            "on run argv\n"
            "  set targetPid to item 1 of argv as integer\n"
            "  set bundleId to item 2 of argv\n"
            "  set appName to item 3 of argv\n"
            '  tell application "System Events"\n'
            "    set targetProc to missing value\n"
            "    if targetPid > 0 then\n"
            "      try\n"
            "        set targetProc to first application process whose unix id is targetPid\n"
            "      end try\n"
            "    end if\n"
            '    if targetProc is missing value and bundleId is not "" then\n'
            "      try\n"
            "        set targetProc to first application process whose bundle identifier is bundleId\n"
            "      end try\n"
            "    end if\n"
            '    if targetProc is missing value and appName is not "" then\n'
            "      try\n"
            "        set targetProc to first application process whose name is appName\n"
            "      end try\n"
            "    end if\n"
            "    if targetProc is not missing value then\n"
            "      set frontmost of targetProc to true\n"
            "    end if\n"
            "  end tell\n"
            "end run"
        )
        try:
            subprocess.run(
                ["osascript", "-e", script, str(target.process_id), target.bundle_id, target.name],
                check=True,
                capture_output=True,
                text=True,
                timeout=2.0,
            )
            time.sleep(0.12)
        except Exception:
            return

    @staticmethod
    def _paste_macos(target: PasteTarget | None) -> None:
        bundle_id = target.bundle_id if target and target.platform == "Darwin" else ""
        app_name = target.name if target and target.platform == "Darwin" else ""
        process_id = str(target.process_id if target and target.platform == "Darwin" else 0)
        script = (
            "on run argv\n"
            "  set targetPid to item 1 of argv as integer\n"
            "  set bundleId to item 2 of argv\n"
            "  set appName to item 3 of argv\n"
            '  set hasTarget to (targetPid > 0) or (bundleId is not "") or (appName is not "")\n'
            '  tell application "System Events"\n'
            "    set targetProc to missing value\n"
            "    if targetPid > 0 then\n"
            "      try\n"
            "        set targetProc to first application process whose unix id is targetPid\n"
            "      end try\n"
            "    end if\n"
            '    if targetProc is missing value and bundleId is not "" then\n'
            "      try\n"
            "        set targetProc to first application process whose bundle identifier is bundleId\n"
            "      end try\n"
            "    end if\n"
            '    if targetProc is missing value and appName is not "" then\n'
            "      try\n"
            "        set targetProc to first application process whose name is appName\n"
            "      end try\n"
            "    end if\n"
            "    if targetProc is not missing value then\n"
            "      set frontmost of targetProc to true\n"
            "      repeat 12 times\n"
            "        delay 0.05\n"
            "        try\n"
            "          set frontApp to first application process whose frontmost is true\n"
            "          if (targetPid > 0) and ((unix id of frontApp) is targetPid) then exit repeat\n"
            '          if (bundleId is not "") and ((bundle identifier of frontApp) is bundleId) then exit repeat\n'
            '          if (appName is not "") and ((name of frontApp) is appName) then exit repeat\n'
            "        end try\n"
            "      end repeat\n"
            "    else if hasTarget then\n"
            '      error "貼り付け先アプリを前面化できません: " & appName\n'
            "    else\n"
            "      delay 0.05\n"
            "  end if\n"
            "    key code 9 using {command down}\n"
            "  end tell\n"
            "end run"
        )
        subprocess.run(
            ["osascript", "-e", script, process_id, bundle_id, app_name],
            check=True,
            capture_output=True,
            text=True,
            timeout=4.0,
        )

    @staticmethod
    def _capture_windows_target() -> PasteTarget | None:
        try:
            import ctypes

            user32 = ctypes.windll.user32
            hwnd = int(user32.GetForegroundWindow())
            if hwnd <= 0:
                return None
            length = int(user32.GetWindowTextLengthW(hwnd))
            buffer = ctypes.create_unicode_buffer(length + 1)
            user32.GetWindowTextW(hwnd, buffer, length + 1)
            name = buffer.value.strip()
            return PasteTarget(platform="Windows", name=name, window_handle=hwnd)
        except Exception:
            return None

    @staticmethod
    def _activate_windows_target(target: PasteTarget | None) -> None:
        if target is None or target.platform != "Windows" or target.window_handle <= 0:
            return
        try:
            import ctypes

            ctypes.windll.user32.SetForegroundWindow(target.window_handle)
            time.sleep(0.08)
        except Exception:
            return

    @classmethod
    def is_browser_target(cls, target: PasteTarget | None) -> bool:
        if target is None:
            return False
        if target.platform == "Darwin":
            return target.bundle_id in cls.BROWSER_BUNDLE_IDS or target.name in cls.BROWSER_NAMES
        if target.platform == "Windows":
            name = target.name.lower()
            return any(browser.lower() in name for browser in cls.BROWSER_NAMES)
        return False

    @staticmethod
    def _windows_ctrl_v() -> None:
        import ctypes

        user32 = ctypes.windll.user32
        keyeventf_keyup = 0x0002
        vk_control = 0x11
        vk_v = 0x56
        user32.keybd_event(vk_control, 0, 0, 0)
        user32.keybd_event(vk_v, 0, 0, 0)
        user32.keybd_event(vk_v, 0, keyeventf_keyup, 0)
        user32.keybd_event(vk_control, 0, keyeventf_keyup, 0)


class HotkeyMonitor:
    def __init__(
        self,
        *,
        settings_provider: Callable[[], AquaVoiceSettings],
        locked_provider: Callable[[], bool],
        start_hold: Callable[[], None],
        stop_hold: Callable[[], None],
        toggle_lock: Callable[[], None],
        error_callback: Callable[[str], None],
    ) -> None:
        self.settings_provider = settings_provider
        self.locked_provider = locked_provider
        self.start_hold = start_hold
        self.stop_hold = stop_hold
        self.toggle_lock = toggle_lock
        self.error_callback = error_callback
        self.keyboard_module = None
        self.listener: object | None = None
        self.key_down = False
        self.recording_started_by_hold = False
        self.last_tap_at = 0.0
        self.hold_timer: threading.Timer | None = None

    def start(self) -> None:
        from pynput import keyboard as pynput_keyboard

        self.keyboard_module = pynput_keyboard
        self.listener = pynput_keyboard.Listener(
            on_press=self._on_press,
            on_release=self._on_release,
        )
        self.listener.daemon = True
        self.listener.start()

    def stop(self) -> None:
        if self.listener is not None:
            self.listener.stop()
        self.listener = None

    def _on_press(self, key) -> None:  # type: ignore[no-untyped-def]
        if not self._matches(key) or self.key_down:
            return
        self.key_down = True
        now = time.monotonic()
        settings = self.settings_provider()
        if now - self.last_tap_at <= settings.double_tap_ms / 1000.0:
            self.last_tap_at = 0.0
            self._cancel_hold_timer()
            self.toggle_lock()
            return
        if self.locked_provider():
            return
        self.recording_started_by_hold = False
        self.hold_timer = threading.Timer(
            settings.hold_start_ms / 1000.0,
            self._start_after_hold,
        )
        self.hold_timer.daemon = True
        self.hold_timer.start()

    def _on_release(self, key) -> None:  # type: ignore[no-untyped-def]
        if not self._matches(key):
            return
        self.key_down = False
        self._cancel_hold_timer()
        if self.recording_started_by_hold:
            self.stop_hold()
            self.recording_started_by_hold = False
        else:
            self.last_tap_at = time.monotonic()

    def _start_after_hold(self) -> None:
        if not self.key_down:
            return
        self.recording_started_by_hold = True
        self.start_hold()

    def _cancel_hold_timer(self) -> None:
        if self.hold_timer is not None:
            self.hold_timer.cancel()
        self.hold_timer = None

    def _matches(self, key) -> bool:  # type: ignore[no-untyped-def]
        expected = self.settings_provider().shortcut_key.lower().strip()
        actual = self._key_name(key)
        return actual == expected

    def _key_name(self, key) -> str:  # type: ignore[no-untyped-def]
        if self.keyboard_module is None:
            return ""
        keyboard_key = self.keyboard_module.Key
        if key in {keyboard_key.alt, keyboard_key.alt_l, keyboard_key.alt_r}:
            return "option"
        if key in {keyboard_key.cmd, keyboard_key.cmd_l, keyboard_key.cmd_r}:
            return "command"
        if key in {keyboard_key.ctrl, keyboard_key.ctrl_l, keyboard_key.ctrl_r}:
            return "ctrl"
        if key in {keyboard_key.shift, keyboard_key.shift_l, keyboard_key.shift_r}:
            return "shift"
        for name in ("f8", "f9", "f10", "f11", "f12"):
            if key == getattr(keyboard_key, name):
                return name
        char = getattr(key, "char", None)
        return str(char or "").lower()


class AquaVoiceController:
    def __init__(self) -> None:
        self.settings = load_settings()
        self.state = RuntimeState()
        self.state_lock = threading.RLock()
        self.api_key = (
            normalize_groq_api_key(self.settings.groq_api_key)
            or normalize_groq_api_key(os.environ.get("GROQ_API_KEY", ""))
        )
        if self.api_key and self.settings.groq_api_key != self.api_key:
            self.settings.groq_api_key = self.api_key
            save_settings(self.settings)
        self.groq_client = GroqClient(self._api_key)
        self.recorder = self._new_recorder()
        self.paste_target: PasteTarget | None = None
        self.worker_lock = threading.Lock()
        self.shutdown_event = threading.Event()
        self.httpd: ThreadingHTTPServer | None = None
        self.hotkey = HotkeyMonitor(
            settings_provider=lambda: self.settings,
            locked_provider=lambda: self.snapshot()["lockedRecording"],
            start_hold=self.start_recording,
            stop_hold=self.stop_and_process,
            toggle_lock=self.toggle_lock_recording,
            error_callback=self._set_error,
        )

    def _new_recorder(self) -> AudioRecorder:
        return AudioRecorder(
            sample_rate=self.settings.sample_rate,
            level_callback=self._set_input_level,
        )

    def _api_key(self) -> str:
        return (
            self.api_key
            or normalize_groq_api_key(self.settings.groq_api_key)
            or normalize_groq_api_key(os.environ.get("GROQ_API_KEY", ""))
        )

    def run(self) -> None:
        self.start_hotkey()
        self.start_server()
        webbrowser.open(self.state.server_url)
        print(f"Aqua Voice Web UI: {self.state.server_url}")
        try:
            while not self.shutdown_event.wait(0.2):
                pass
        finally:
            self.shutdown()

    def start_hotkey(self) -> None:
        try:
            self.hotkey.start()
            with self.state_lock:
                self.state.hotkey_enabled = True
        except Exception as exc:
            self._set_error(
                "グローバルショートカットを開始できませんでした。"
                f"アクセシビリティ/入力監視の許可を確認してください: {exc}"
            )

    def start_server(self) -> None:
        controller = self

        class Handler(AquaVoiceRequestHandler):
            app = controller

        self.httpd = ThreadingHTTPServer((SERVER_HOST, SERVER_PORT), Handler)
        thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        thread.start()

    def shutdown(self) -> None:
        self.shutdown_event.set()
        try:
            self.hotkey.stop()
        except Exception:
            pass
        if self.snapshot()["recording"]:
            try:
                self.recorder.stop()
            except Exception:
                pass
        if self.httpd is not None:
            self.httpd.shutdown()
            self.httpd.server_close()

    def snapshot(self) -> dict[str, Any]:
        with self.state_lock:
            settings_payload = asdict(self.settings)
            settings_payload["groq_api_key"] = ""
            active_api_key = normalize_groq_api_key(self._api_key())
            return {
                "status": self.state.status,
                "recording": self.state.recording,
                "lockedRecording": self.state.locked_recording,
                "processing": self.state.processing,
                "inputLevel": self.state.input_level,
                "transcriptionLatencyMs": self.state.transcription_latency_ms,
                "llmLatencyMs": self.state.llm_latency_ms,
                "lastError": self.state.last_error,
                "rawText": "\n".join(self.state.raw_lines),
                "refinedText": "\n".join(self.state.refined_lines),
                "finalText": self.state.final_text,
                "hotkeyEnabled": self.state.hotkey_enabled,
                "serverUrl": self.state.server_url,
                "pasteTargetName": self.state.paste_target_name,
                "pasteTargetDetail": self.state.paste_target_detail,
                "settings": settings_payload,
                "hasApiKey": bool(active_api_key),
                "apiKeyPreview": mask_secret(active_api_key),
            }

    def update_settings(self, payload: dict[str, Any]) -> dict[str, Any]:
        with self.state_lock:
            settings = self.settings
            settings.language = str(payload.get("language", settings.language)).strip() or "ja"
            settings.transcription_model = (
                str(payload.get("transcriptionModel", settings.transcription_model)).strip()
                or "whisper-large-v3-turbo"
            )
            settings.llm_model = (
                str(payload.get("llmModel", settings.llm_model)).strip()
                or "llama-3.1-8b-instant"
            )
            settings.shortcut_key = (
                str(payload.get("shortcutKey", settings.shortcut_key)).strip() or "option"
            )
            settings.chunk_seconds = self._coerce_float(
                payload.get("chunkSeconds"),
                default=settings.chunk_seconds,
                minimum=0.5,
                maximum=5.0,
            )
            settings.sample_rate = int(
                self._coerce_float(
                    payload.get("sampleRate"),
                    default=settings.sample_rate,
                    minimum=8000,
                    maximum=48000,
                )
            )
            settings.dictionary = self._parse_dictionary(payload.get("dictionary", []))
            if "apiKey" in payload:
                next_api_key = normalize_groq_api_key(str(payload.get("apiKey") or ""))
                if next_api_key:
                    if not GROQ_API_KEY_RE.fullmatch(next_api_key):
                        self.state.last_error = "Groq APIキーは gsk_ から始まる値だけを指定してください。"
                        self.state.status = "エラー"
                        return self.snapshot()
                    self.api_key = next_api_key
                    settings.groq_api_key = next_api_key
            save_settings(settings)
            self.recorder = self._new_recorder()
            self.state.status = f"設定保存: {CONFIG_PATH}"
        return self.snapshot()

    @staticmethod
    def _coerce_float(
        raw_value: Any,
        *,
        default: float,
        minimum: float,
        maximum: float,
    ) -> float:
        try:
            value = float(raw_value)
        except (TypeError, ValueError):
            value = float(default)
        return min(max(value, minimum), maximum)

    @staticmethod
    def _parse_dictionary(raw_value: Any) -> list[DictionaryEntry]:
        if not isinstance(raw_value, list):
            return []
        entries: list[DictionaryEntry] = []
        for item in raw_value:
            if not isinstance(item, dict):
                continue
            spoken = str(item.get("spoken", "")).strip()
            replacement = str(item.get("replacement", "")).strip()
            if spoken and replacement:
                entries.append(DictionaryEntry(spoken=spoken, replacement=replacement))
        return entries

    def start_recording(self) -> dict[str, Any]:
        with self.state_lock:
            if self.state.recording or self.state.processing:
                return self.snapshot()
            self.state.raw_lines = []
            self.state.refined_lines = []
            self.state.final_text = ""
            self.state.last_error = ""
            self.state.transcription_latency_ms = None
            self.state.llm_latency_ms = None
            self.state.status = "録音開始中"
            self._remember_paste_target_locked()
        self.recorder = self._new_recorder()
        try:
            self.recorder.start()
        except Exception as exc:
            self._set_error(f"録音開始に失敗しました: {exc}")
            return self.snapshot()
        with self.state_lock:
            self.state.recording = True
            self.state.processing = False
            self.state.status = "録音中"
        threading.Thread(target=self._live_chunk_loop, daemon=True).start()
        return self.snapshot()

    def stop_and_process(self) -> dict[str, Any]:
        with self.state_lock:
            if not self.state.recording:
                return self.snapshot()
            self.state.recording = False
            self.state.locked_recording = False
            self.state.processing = True
            self.state.status = "最終処理中"
        try:
            remaining = self.recorder.stop()
        except Exception as exc:
            self._set_error(f"録音停止に失敗しました: {exc}")
            return self.snapshot()
        threading.Thread(target=self._finalize_audio, args=(remaining,), daemon=True).start()
        return self.snapshot()

    def toggle_lock_recording(self) -> dict[str, Any]:
        with self.state_lock:
            locked = self.state.locked_recording
        if locked:
            return self.stop_and_process()
        with self.state_lock:
            self.state.locked_recording = True
        snapshot = self.start_recording()
        with self.state_lock:
            self.state.locked_recording = True
            self.state.status = "ロック録音中"
        return snapshot

    def paste_final(self) -> dict[str, Any]:
        text = self.snapshot()["finalText"] or self.snapshot()["refinedText"]
        if not text.strip():
            return self.snapshot()
        try:
            AutoPaste.paste(text, self.paste_target)
            with self.state_lock:
                self.state.status = "貼り付け完了"
        except Exception as exc:
            self._set_error(f"貼り付けに失敗しました: {exc}")
        return self.snapshot()

    def clear(self) -> dict[str, Any]:
        with self.state_lock:
            self.state.raw_lines = []
            self.state.refined_lines = []
            self.state.final_text = ""
            self.state.last_error = ""
            self.state.status = "待機中"
        return self.snapshot()

    def _live_chunk_loop(self) -> None:
        while self.snapshot()["recording"]:
            time.sleep(self.settings.chunk_seconds)
            frame_bytes = self.recorder.pop_all()
            minimum_bytes = int(self.settings.sample_rate * 2 * 0.35)
            if len(frame_bytes) < minimum_bytes:
                continue
            self._process_audio_chunk(frame_bytes, final=False)

    def _finalize_audio(self, frame_bytes: bytes) -> None:
        if frame_bytes:
            self._process_audio_chunk(frame_bytes, final=False)
        raw_joined = apply_dictionary(
            " ".join(self.snapshot()["rawText"].split()).strip(),
            self.settings.dictionary,
        )
        if not raw_joined:
            with self.state_lock:
                self.state.status = "音声が検出されませんでした"
                self.state.processing = False
            return
        final_text = self._refine_text(raw_joined, final=True)
        if final_text:
            with self.state_lock:
                self.state.final_text = final_text
                self.state.refined_lines = [final_text]
        if final_text and self.settings.paste_after_refine:
            try:
                AutoPaste.paste(final_text, self.paste_target)
                with self.state_lock:
                    self.state.status = "貼り付け完了"
            except Exception as exc:
                self._set_error(f"貼り付けに失敗しました: {exc}")
        with self.state_lock:
            self.state.processing = False
            if not self.state.last_error:
                self.state.status = "待機中"

    def _process_audio_chunk(self, frame_bytes: bytes, *, final: bool) -> None:
        with self.worker_lock:
            with self.state_lock:
                self.state.status = "Groq音声認識中"
            try:
                wav_bytes = pcm16_wav_bytes(
                    frame_bytes,
                    sample_rate=self.settings.sample_rate,
                    channels=1,
                )
                raw_text, transcription_ms = self.groq_client.transcribe(
                    wav_bytes=wav_bytes,
                    filename=f"aqua-voice-{int(time.time() * 1000)}.wav",
                    language=self.settings.language,
                    model=self.settings.transcription_model,
                )
                raw_text = apply_dictionary(raw_text, self.settings.dictionary)
            except Exception as exc:
                self._set_error(f"音声認識エラー: {exc}")
                return
            if not raw_text:
                with self.state_lock:
                    self.state.status = "録音中" if self.state.recording else "待機中"
                return
            with self.state_lock:
                self.state.raw_lines.append(raw_text)
                self.state.transcription_latency_ms = transcription_ms
                self.state.status = "Groq LLM整形中"
            refined = self._refine_text(raw_text, final=final)
            if refined:
                with self.state_lock:
                    self.state.refined_lines.append(refined)
                    self.state.status = "録音中" if self.state.recording else "待機中"

    def _refine_text(self, text: str, *, final: bool) -> str:
        try:
            refined, llm_ms = self.groq_client.refine(
                text=text,
                settings=self.settings,
                final=final,
            )
        except Exception as exc:
            self._set_error(f"LLM整形エラー: {exc}")
            return text
        with self.state_lock:
            self.state.llm_latency_ms = llm_ms
        return refined

    def _set_input_level(self, level: float) -> None:
        with self.state_lock:
            self.state.input_level = level

    def _remember_paste_target_locked(self) -> None:
        target = AutoPaste.capture_target()
        if (
            AutoPaste.is_browser_target(target)
            and self.paste_target is not None
            and not AutoPaste.is_browser_target(self.paste_target)
        ):
            target = self.paste_target
        self.paste_target = target
        if target is None:
            self.state.paste_target_name = ""
            self.state.paste_target_detail = ""
            return
        self.state.paste_target_name = target.name or target.bundle_id or "不明なアプリ"
        if target.platform == "Darwin":
            details = []
            if target.bundle_id:
                details.append(target.bundle_id)
            if target.process_id > 0:
                details.append(f"pid {target.process_id}")
            self.state.paste_target_detail = " / ".join(details)
        elif target.platform == "Windows":
            self.state.paste_target_detail = str(target.window_handle)
        else:
            self.state.paste_target_detail = target.platform

    def _set_error(self, message: str) -> None:
        with self.state_lock:
            self.state.last_error = message
            self.state.status = "エラー"
            self.state.processing = False


class AquaVoiceRequestHandler(BaseHTTPRequestHandler):
    app: AquaVoiceController

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/":
            self._send_html(INDEX_HTML)
            return
        if parsed.path == "/api/state":
            self._send_json(self.app.snapshot())
            return
        self.send_error(HTTPStatus.NOT_FOUND)

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        payload = self._read_json()
        routes = {
            "/api/settings": lambda: self.app.update_settings(payload),
            "/api/record/start": self.app.start_recording,
            "/api/record/stop": self.app.stop_and_process,
            "/api/record/toggle-lock": self.app.toggle_lock_recording,
            "/api/paste": self.app.paste_final,
            "/api/clear": self.app.clear,
            "/api/shutdown": self._shutdown,
        }
        handler = routes.get(parsed.path)
        if handler is None:
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        self._send_json(handler())

    def log_message(self, format: str, *args: Any) -> None:
        return

    def _read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0") or "0")
        if length <= 0:
            return {}
        raw_body = self.rfile.read(length)
        try:
            payload = json.loads(raw_body.decode("utf-8"))
        except json.JSONDecodeError:
            return {}
        return payload if isinstance(payload, dict) else {}

    def _send_json(self, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _send_html(self, html: str) -> None:
        body = html.encode("utf-8")
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _shutdown(self) -> dict[str, Any]:
        snapshot = self.app.snapshot()
        threading.Thread(target=self.app.shutdown, daemon=True).start()
        return snapshot


INDEX_HTML = r"""<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Aqua Voice</title>
  <style>
    :root {
      color-scheme: light;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #f4f7fb;
      color: #122033;
    }
    * { box-sizing: border-box; }
    body { margin: 0; }
    main { min-height: 100vh; display: grid; grid-template-rows: auto 1fr; }
    header {
      display: flex;
      align-items: center;
      gap: 16px;
      padding: 14px 18px;
      border-bottom: 1px solid #d9e2ee;
      background: #ffffff;
    }
    h1 { margin: 0; font-size: 22px; line-height: 1.1; }
    .status { font-weight: 700; padding: 6px 10px; border-radius: 6px; background: #e8f3ff; color: #075985; }
    .header-meta { margin-left: auto; display: flex; gap: 12px; font-size: 13px; color: #496172; }
    .layout { display: grid; grid-template-columns: minmax(0, 1.4fr) 420px; gap: 14px; padding: 14px; min-height: 0; }
    section, aside, .panel {
      background: #ffffff;
      border: 1px solid #d9e2ee;
      border-radius: 8px;
    }
    .left { display: grid; grid-template-rows: auto 1fr 1fr; gap: 14px; min-height: 0; }
    .controls { padding: 12px; display: grid; gap: 10px; }
    .buttons { display: flex; flex-wrap: wrap; gap: 8px; }
    button {
      border: 1px solid #b7c8d8;
      background: #f8fbff;
      color: #122033;
      border-radius: 6px;
      padding: 8px 11px;
      font-weight: 700;
      cursor: pointer;
    }
    button.primary { background: #0f766e; border-color: #0f766e; color: #ffffff; }
    button.danger { background: #fff1f2; border-color: #fecdd3; color: #be123c; }
    button:disabled { opacity: .48; cursor: not-allowed; }
    .meter { height: 24px; border-radius: 5px; background: #e8eef4; overflow: hidden; border: 1px solid #d5e0eb; }
    .meter > div { height: 100%; width: 0%; background: #10b981; transition: width .08s linear; }
    .transcript { padding: 12px; display: grid; grid-template-rows: auto 1fr; min-height: 0; }
    .transcript h2, aside h2 { margin: 0 0 10px; font-size: 15px; }
    textarea, input, select {
      width: 100%;
      border: 1px solid #c9d7e5;
      border-radius: 6px;
      padding: 8px;
      background: #fbfdff;
      color: #122033;
      font: inherit;
    }
    textarea { resize: none; min-height: 160px; line-height: 1.55; }
    aside { padding: 12px; overflow: auto; }
    label { display: grid; gap: 5px; margin-bottom: 10px; font-size: 13px; font-weight: 700; color: #32495c; }
    .dict-row { display: grid; grid-template-columns: 1fr 1fr 36px; gap: 6px; margin-bottom: 7px; }
    .dict-row button { padding: 4px; }
    .error { margin-top: 8px; color: #be123c; white-space: pre-wrap; font-size: 13px; }
    .hint { color: #5b7183; font-size: 12px; line-height: 1.5; margin: 4px 0 12px; }
    @media (max-width: 940px) {
      .layout { grid-template-columns: 1fr; }
      .header-meta { display: none; }
    }
  </style>
</head>
<body>
<main>
  <header>
    <h1>Aqua Voice</h1>
    <div class="status" id="status">待機中</div>
    <div class="header-meta">
      <span id="hotkey">Hotkey: -</span>
      <span id="targetApp">貼り付け先: -</span>
      <span id="latency">音声認識: - / LLM: -</span>
    </div>
  </header>
  <div class="layout">
    <div class="left">
      <section class="controls">
        <div class="buttons">
          <button class="primary" id="startBtn">録音開始</button>
          <button id="stopBtn">停止して貼り付け</button>
          <button id="lockBtn">ロック録音切替</button>
          <button id="pasteBtn">再貼り付け</button>
          <button id="clearBtn">クリア</button>
          <button class="danger" id="shutdownBtn">終了</button>
        </div>
        <div class="meter"><div id="meterFill"></div></div>
        <div class="hint">貼り付け先アプリにカーソルを置いてからOption長押しで録音します。録音開始時の前面アプリを記憶し、整形後にそのアプリへ戻して貼り付けます。</div>
        <div class="error" id="error"></div>
      </section>
      <section class="transcript">
        <h2>リアルタイム音声認識</h2>
        <textarea id="rawText" readonly></textarea>
      </section>
      <section class="transcript">
        <h2>Groq LLM 整形結果</h2>
        <textarea id="refinedText" readonly></textarea>
      </section>
    </div>
    <aside>
      <h2>設定</h2>
      <label>Groq APIキー（保存されます）
        <input id="apiKey" type="password" placeholder="gsk_...">
      </label>
      <div class="hint" id="apiKeyHint">APIキーは保存後、次回から自動利用します。</div>
      <label>言語
        <input id="language">
      </label>
      <label>音声認識モデル
        <input id="transcriptionModel">
      </label>
      <label>LLMモデル
        <input id="llmModel">
      </label>
      <label>送信間隔（秒）
        <input id="chunkSeconds" type="number" min="0.5" max="5" step="0.1">
      </label>
      <label>サンプルレート
        <input id="sampleRate" type="number" min="8000" max="48000" step="1000">
      </label>
      <label>ショートカット
        <select id="shortcutKey">
          <option value="option">option</option>
          <option value="command">command</option>
          <option value="ctrl">ctrl</option>
          <option value="shift">shift</option>
          <option value="f8">f8</option>
          <option value="f9">f9</option>
          <option value="f10">f10</option>
          <option value="f11">f11</option>
          <option value="f12">f12</option>
        </select>
      </label>
      <h2>辞書設定</h2>
      <div id="dictionary"></div>
      <div class="buttons">
        <button id="addDictBtn">行を追加</button>
        <button class="primary" id="saveBtn">設定保存</button>
      </div>
    </aside>
  </div>
</main>
<script>
const $ = (id) => document.getElementById(id);
let currentSettings = null;
let apiKeyDirty = false;
let saveTimer = null;

async function post(path, payload = {}) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  return response.json();
}

async function refresh() {
  const response = await fetch("/api/state", { cache: "no-store" });
  const data = await response.json();
  render(data);
}

function render(data) {
  $("status").textContent = data.status;
  $("rawText").value = data.rawText || "";
  $("refinedText").value = data.finalText || data.refinedText || "";
  $("meterFill").style.width = `${Math.round((data.inputLevel || 0) * 100)}%`;
  $("error").textContent = data.lastError || "";
  $("hotkey").textContent = `${data.settings.shortcut_key} / ${data.hotkeyEnabled ? "監視中" : "未開始"}`;
  $("targetApp").textContent = `貼り付け先: ${data.pasteTargetName || "-"}`;
  $("targetApp").title = data.pasteTargetDetail || "";
  $("apiKeyHint").textContent = data.hasApiKey
    ? `APIキー: ${data.apiKeyPreview || "保存済み"}`
    : "APIキーは保存後、次回から自動利用します。";
  $("apiKey").placeholder = data.hasApiKey
    ? `${data.apiKeyPreview || "保存済み"}（変更時だけ入力）`
    : "gsk_...";
  $("latency").textContent = `音声認識: ${data.transcriptionLatencyMs ?? "-"}ms / LLM: ${data.llmLatencyMs ?? "-"}ms`;
  $("startBtn").disabled = data.recording || data.processing;
  $("stopBtn").disabled = !data.recording;
  $("lockBtn").textContent = data.lockedRecording ? "ロック録音を停止" : "ロック録音切替";
  if (!currentSettings) {
    currentSettings = data.settings;
    fillSettings(data.settings);
  }
}

function fillSettings(settings) {
  $("language").value = settings.language || "ja";
  $("transcriptionModel").value = settings.transcription_model || "whisper-large-v3-turbo";
  $("llmModel").value = settings.llm_model || "llama-3.1-8b-instant";
  $("chunkSeconds").value = settings.chunk_seconds || 1.2;
  $("sampleRate").value = settings.sample_rate || 16000;
  $("shortcutKey").value = settings.shortcut_key || "option";
  renderDictionary(settings.dictionary || []);
}

function renderDictionary(entries) {
  const root = $("dictionary");
  root.innerHTML = "";
  for (const entry of entries) addDictRow(entry.spoken || "", entry.replacement || "");
}

function addDictRow(spoken = "", replacement = "") {
  const row = document.createElement("div");
  row.className = "dict-row";
  row.innerHTML = `
    <input class="spoken" placeholder="認識表記" value="${escapeHtml(spoken)}">
    <input class="replacement" placeholder="置換後" value="${escapeHtml(replacement)}">
    <button type="button">×</button>
  `;
  row.querySelectorAll("input").forEach((input) => {
    input.addEventListener("input", scheduleSave);
    input.addEventListener("change", scheduleSave);
  });
  row.querySelector("button").addEventListener("click", () => {
    row.remove();
    scheduleSave();
  });
  $("dictionary").appendChild(row);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[char]));
}

function collectSettings() {
  const dictionary = [...document.querySelectorAll(".dict-row")].map((row) => ({
    spoken: row.querySelector(".spoken").value.trim(),
    replacement: row.querySelector(".replacement").value.trim()
  })).filter((entry) => entry.spoken && entry.replacement);
  const payload = {
    language: $("language").value,
    transcriptionModel: $("transcriptionModel").value,
    llmModel: $("llmModel").value,
    chunkSeconds: $("chunkSeconds").value,
    sampleRate: $("sampleRate").value,
    shortcutKey: $("shortcutKey").value,
    dictionary
  };
  const nextApiKey = $("apiKey").value.trim();
  if ((apiKeyDirty || nextApiKey) && /^gsk_[A-Za-z0-9_-]+$/.test(nextApiKey)) {
    payload.apiKey = nextApiKey;
  }
  return payload;
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveSettings, 650);
}

async function saveSettings() {
  const payload = collectSettings();
  const savedApiKey = Boolean(payload.apiKey);
  const data = await post("/api/settings", payload);
  currentSettings = data.settings;
  if (savedApiKey) {
    apiKeyDirty = false;
    $("apiKey").value = "";
  }
  render(data);
}

$("apiKey").addEventListener("input", () => {
  apiKeyDirty = true;
  scheduleSave();
});
["language", "transcriptionModel", "llmModel", "chunkSeconds", "sampleRate", "shortcutKey"].forEach((id) => {
  $(id).addEventListener("change", scheduleSave);
  $(id).addEventListener("input", scheduleSave);
});
$("saveBtn").addEventListener("click", async () => {
  await saveSettings();
});
$("addDictBtn").addEventListener("click", () => {
  addDictRow();
  scheduleSave();
});
$("startBtn").addEventListener("click", () => post("/api/record/start"));
$("stopBtn").addEventListener("click", () => post("/api/record/stop"));
$("lockBtn").addEventListener("click", () => post("/api/record/toggle-lock"));
$("pasteBtn").addEventListener("click", () => post("/api/paste"));
$("clearBtn").addEventListener("click", () => post("/api/clear"));
$("shutdownBtn").addEventListener("click", () => post("/api/shutdown"));

refresh();
setInterval(refresh, 250);
</script>
</body>
</html>
"""


def main() -> None:
    controller = AquaVoiceController()
    controller.run()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(0)
