"""CDPModClient (Python): importable, no CLI, no demo code.

Constructor parameter names mirror the JS / Go ports:
    cdp_url           upstream CDP URL (str)
    extension_path    extension directory (str)
    routes            client-side routing dict
    server            { 'loopback_cdp_url'?, 'routes'? } passed to CDPModServer.configure

Public methods: connect(), send(method, params), on(event, handler), close(), _cdp.send(), _cdp.on().
Synchronous (blocking) API; one background thread reads frames off the WS.
"""

import json
import os
import re
import subprocess
import threading
import time
import tempfile
import urllib.request
import socket
import zipfile
from collections.abc import Mapping, Sequence
from pathlib import Path
from queue import Queue, Empty
from typing import cast

from websocket import create_connection

from .translate import (
    DEFAULT_CLIENT_ROUTES,
    binding_name_for,
    wrap_command_if_needed,
    unwrap_event_if_needed,
    unwrap_response_if_needed,
)
from .types import (
    CDPModAddCustomCommandParams,
    CDPModAddCustomEventObjectParams,
    CDPModAddCustomEventParams,
    CDPModAddMiddlewareParams,
    CDPModCommandTiming,
    CDPModConnectTiming,
    CDPModPingLatency,
    CDPModRawTiming,
    CDPModRoutes,
    CDPModServerConfig,
    BorrowedExtensionInfo,
    CdpFrame,
    ExtensionInfo,
    ExtensionProbe,
    FrameParams,
    Handler,
    JsonValue,
    LaunchOptions,
    PendingEntry,
    ProtocolParams,
    ProtocolPayload,
    ProtocolResult,
    TargetInfo,
    TranslatedCommand,
    WebSocketLike,
)

EXT_ID_FROM_URL_RE = re.compile(r"^chrome-extension://([a-z]+)/")
CDPMOD_READY_EXPRESSION = (
    "Boolean(globalThis.CDPMod?.__CDPModServerVersion === 1 && "
    "globalThis.CDPMod?.handleCommand && globalThis.CDPMod?.addCustomEvent)"
)
DEFAULT_SERVER = object()


class _DomainMethods:
    def __init__(self, client: "CDPModClient", domain: str) -> None:
        self._client = client
        self._domain = domain

    def __getattr__(self, method: str):
        def call(*args: ProtocolParams, **kwargs: JsonValue) -> JsonValue:
            if len(args) > 1:
                raise TypeError(f"{self._domain}.{method} accepts at most one positional params object")
            params: ProtocolParams = dict(args[0]) if args else {}
            params.update(kwargs)
            return self._client.send(f"{self._domain}.{method}", params)

        return call


class _RawCDP:
    def __init__(self, client: "CDPModClient") -> None:
        self._client = client

    def send(
        self,
        method: str,
        params: ProtocolParams | None = None,
        session_id: str | None = None,
    ) -> ProtocolResult:
        return self._client._send_frame(method, params or {}, session_id=session_id, record_raw_timing=True)

    def on(self, event: str, handler: Handler) -> "CDPModClient":
        return self._client.on(event, handler)


def websocket_url_for(endpoint: str) -> str:
    if re.match(r"^wss?://", endpoint, re.I):
        return endpoint
    with urllib.request.urlopen(f"{endpoint}/json/version", timeout=5) as r:
        parsed: object = json.loads(r.read())
    if not isinstance(parsed, dict):
        raise RuntimeError(f"HTTP discovery for {endpoint} returned invalid JSON")
    parsed_obj = cast(Mapping[str, object], parsed)
    ws_url = parsed_obj.get("webSocketDebuggerUrl")
    if not ws_url:
        raise RuntimeError(f"HTTP discovery for {endpoint} returned no webSocketDebuggerUrl")
    if not isinstance(ws_url, str):
        raise RuntimeError(f"HTTP discovery for {endpoint} returned a non-string webSocketDebuggerUrl")
    return ws_url


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def _json_object(value: JsonValue | None) -> ProtocolResult:
    return value if isinstance(value, dict) else {}


def cdpmod_server_bootstrap_expression(extension_path: str) -> str:
    server_path = Path(extension_path) / "CDPModServer.js"
    source = server_path.read_text()
    start = source.index("export function installCDPModServer")
    end = source.index("export const CDPModServer")
    installer = source[start:end].replace("export function", "function", 1)
    return (
        "(() => {\n"
        f"{installer}\n"
        "const CDPMod = installCDPModServer(globalThis);\n"
        "return {\n"
        "  ok: Boolean(CDPMod?.__CDPModServerVersion === 1 && CDPMod?.handleCommand && CDPMod?.addCustomEvent),\n"
        "  extension_id: globalThis.chrome?.runtime?.id ?? null,\n"
        "  has_tabs: Boolean(globalThis.chrome?.tabs?.query),\n"
        "  has_debugger: Boolean(globalThis.chrome?.debugger?.sendCommand),\n"
        "};\n"
        "})()"
    )


class CDPModClient:
    def __init__(
        self,
        cdp_url: str | None = None,
        extension_path: str | None = None,
        routes: Mapping[str, str] | None = None,
        server: Mapping[str, JsonValue] | None | object = DEFAULT_SERVER,
        custom_commands: Sequence[CDPModAddCustomCommandParams] | None = None,
        custom_events: Sequence[CDPModAddCustomEventParams] | None = None,
        custom_middlewares: Sequence[CDPModAddMiddlewareParams] | None = None,
        service_worker_url_includes: Sequence[str] | None = None,
        service_worker_url_suffixes: Sequence[str] | None = None,
        trust_service_worker_target: bool = False,
        require_service_worker_target: bool = False,
        service_worker_ready_expression: str | None = None,
        launch_options: LaunchOptions | None = None,
    ) -> None:
        self.cdp_url: str | None = cdp_url
        self.extension_path: str | None = extension_path
        self.routes: CDPModRoutes = {**DEFAULT_CLIENT_ROUTES, **dict(routes or {})}
        if server is DEFAULT_SERVER:
            self.server: CDPModServerConfig | None = {}
        elif server is None:
            self.server = None
        elif isinstance(server, Mapping):
            self.server = cast(CDPModServerConfig, dict(server))
        else:
            raise TypeError("server must be a mapping, None, or omitted")
        self.custom_commands: list[CDPModAddCustomCommandParams] = list(custom_commands or [])
        self.custom_events: list[CDPModAddCustomEventParams] = list(custom_events or [])
        self.custom_middlewares: list[CDPModAddMiddlewareParams] = list(custom_middlewares or [])
        self.service_worker_url_includes: list[str] = list(service_worker_url_includes or [])
        self.service_worker_url_suffixes: list[str] = list(service_worker_url_suffixes or ["/service_worker.js", "/background.js"])
        self.trust_service_worker_target = trust_service_worker_target
        self.require_service_worker_target = require_service_worker_target
        self.service_worker_ready_expression = service_worker_ready_expression
        self.launch_options = cast(LaunchOptions, dict(launch_options or {}))

        self.extension_id: str | None = None
        self.ext_target_id: str | None = None
        self.ext_session_id: str | None = None
        self.latency: CDPModPingLatency | None = None
        self.connect_timing: CDPModConnectTiming | None = None
        self.last_command_timing: CDPModCommandTiming | None = None
        self.last_raw_timing: CDPModRawTiming | None = None

        self._ws: WebSocketLike | None = None
        self._next_id = 0
        self._pending: dict[int, PendingEntry] = {}
        self._handlers: dict[str, list[Handler]] = {}
        self._lock = threading.Lock()
        self._target_sessions: dict[str, str] = {}
        self._session_targets: dict[str, TargetInfo] = {}
        self._reader_thread: threading.Thread | None = None
        self._closed = False
        self._launched_process: subprocess.Popen[bytes] | None = None
        self._profile_dir: tempfile.TemporaryDirectory[str] | None = None
        self._prepared_extension_dir: tempfile.TemporaryDirectory[str] | None = None
        self._cdp = _RawCDP(self)

    def connect(self) -> "CDPModClient":
        connect_started_at = int(time.time() * 1000)
        if self.cdp_url is None:
            self._prepare_extension_path()
            launched = self._launch_chrome()
            self.cdp_url = launched["cdp_url"]
        input_cdp_url = self.cdp_url
        self.cdp_url = websocket_url_for(input_cdp_url)
        if self.server is not None and "loopback_cdp_url" not in self.server:
            self.server = {**self.server, "loopback_cdp_url": self.cdp_url}
        elif self.server and isinstance(self.server.get("loopback_cdp_url"), str):
            loopback_url = self.server["loopback_cdp_url"]
            if loopback_url == input_cdp_url or loopback_url == self.cdp_url:
                self.server = {**self.server, "loopback_cdp_url": self.cdp_url}
        self._ws = cast(WebSocketLike, create_connection(self.cdp_url))
        self._reader_thread = threading.Thread(target=self._reader, daemon=True)
        self._reader_thread.start()

        self._send_frame("Target.setAutoAttach", {
            "autoAttach": True,
            "waitForDebuggerOnStart": False,
            "flatten": True,
        })
        self._send_frame("Target.setDiscoverTargets", {"discover": True})

        extension_started_at = int(time.time() * 1000)
        self._prepare_extension_path()
        ext = self._ensure_extension()
        extension_completed_at = int(time.time() * 1000)
        self.extension_id = ext["extension_id"]
        self.ext_target_id = ext["target_id"]
        self.ext_session_id = ext["session_id"]
        self._send_frame("Runtime.enable", {}, self.ext_session_id)
        self._send_frame("Runtime.addBinding", {"name": binding_name_for("Mod.pong")}, self.ext_session_id)
        for event in self.custom_events:
            name = event.get("name") if isinstance(event, dict) else event
            if isinstance(name, str) and name:
                self._send_frame("Runtime.addBinding", {"name": binding_name_for(name)}, self.ext_session_id)

        if self.server is not None:
            custom_events: list[CDPModAddCustomEventObjectParams] = []
            for event in self.custom_events:
                custom_events.append({"name": event} if isinstance(event, str) else event)
            custom_commands: list[CDPModAddCustomCommandParams] = [
                command
                for command in self.custom_commands
                if isinstance(command.get("expression"), str) and command.get("expression")
            ]
            custom_middlewares: list[CDPModAddMiddlewareParams] = list(self.custom_middlewares)
            configure_params: CDPModServerConfig = {
                **self.server,
                "custom_events": custom_events,
                "custom_commands": custom_commands,
                "custom_middlewares": custom_middlewares,
            }
            self._send_raw(wrap_command_if_needed(
                "Mod.configure",
                cast(ProtocolParams, configure_params),
                routes=self.routes,
                cdp_session_id=self.ext_session_id,
            ))
        threading.Thread(target=self._measure_ping_latency, daemon=True).start()
        connected_at = int(time.time() * 1000)
        self.connect_timing = {
            "started_at": connect_started_at,
            "extension_source": ext.get("source"),
            "extension_started_at": extension_started_at,
            "extension_completed_at": extension_completed_at,
            "extension_duration_ms": extension_completed_at - extension_started_at,
            "connected_at": connected_at,
            "duration_ms": connected_at - connect_started_at,
        }
        return self

    def send(self, method: str, params: ProtocolParams | None = None) -> JsonValue:
        started_at = int(time.time() * 1000)
        command = wrap_command_if_needed(
            method,
            params or {},
            routes=self.routes,
            cdp_session_id=self.ext_session_id,
        )
        result = self._send_raw(command)
        completed_at = int(time.time() * 1000)
        self.last_command_timing = {
            "method": method,
            "target": command["target"],
            "started_at": started_at,
            "completed_at": completed_at,
            "duration_ms": completed_at - started_at,
        }
        return result

    def raw_send(self, method: str, params: ProtocolParams | None = None) -> ProtocolResult:
        return self._send_frame(method, params or {}, record_raw_timing=True)

    def on(self, event: str, handler: Handler) -> "CDPModClient":
        self._handlers.setdefault(event, []).append(handler)
        return self

    def __getattr__(self, domain: str) -> _DomainMethods:
        if domain.startswith("_"):
            raise AttributeError(domain)
        return _DomainMethods(self, domain)

    def close(self) -> None:
        self._closed = True
        try:
            if self._ws:
                self._ws.close()
        except Exception:
            pass
        if self._launched_process is not None:
            self._launched_process.terminate()
            try:
                self._launched_process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                self._launched_process.kill()
            self._launched_process = None
        if self._profile_dir is not None:
            self._profile_dir.cleanup()
            self._profile_dir = None
        if self._prepared_extension_dir is not None:
            self._prepared_extension_dir.cleanup()
            self._prepared_extension_dir = None

    def _ready_expression(self) -> str:
        if not self.service_worker_ready_expression:
            return CDPMOD_READY_EXPRESSION
        return f"({CDPMOD_READY_EXPRESSION}) && Boolean({self.service_worker_ready_expression})"

    def _session_id_for_target(self, target_id: str, timeout: float = 0) -> str | None:
        if timeout <= 0:
            return self._target_sessions.get(target_id)
        deadline = time.time() + timeout
        while time.time() <= deadline:
            session_id = self._target_sessions.get(target_id)
            if session_id:
                return session_id
            time.sleep(0.02)
        return None

    def _launch_chrome(self) -> dict[str, str]:
        executable_path = self.launch_options.get("executable_path") or os.environ.get("CHROME_PATH")
        candidates = [
            executable_path,
            "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/usr/bin/google-chrome-canary",
            "/usr/bin/chromium",
            "/usr/bin/chromium-browser",
            "/usr/bin/google-chrome",
        ]
        executable_path = next((candidate for candidate in candidates if candidate and Path(candidate).exists()), None)
        if executable_path is None:
            raise RuntimeError("No Chrome/Chromium binary found. Set CHROME_PATH or pass launch_options.executable_path.")
        port = int(self.launch_options.get("port") or _free_port())
        self._profile_dir = tempfile.TemporaryDirectory(prefix="cdpmod.")
        args = [
            "--enable-unsafe-extension-debugging",
            "--remote-allow-origins=*",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-default-apps",
            "--disable-dev-shm-usage",
            "--disable-background-networking",
            "--disable-backgrounding-occluded-windows",
            "--disable-renderer-backgrounding",
            "--disable-background-timer-throttling",
            "--disable-sync",
            "--disable-features=DisableLoadExtensionCommandLineSwitch",
            "--password-store=basic",
            "--use-mock-keychain",
            "--disable-gpu",
            f"--user-data-dir={self._profile_dir.name}",
            "--remote-debugging-address=127.0.0.1",
            f"--remote-debugging-port={port}",
        ]
        if self.launch_options.get("headless", False):
            args.append("--headless=new")
        if self.launch_options.get("sandbox", False) is False:
            args.append("--no-sandbox")
        if self.extension_path:
            args.append(f"--load-extension={self.extension_path}")
        extra_args = self.launch_options.get("extra_args") or []
        args.extend(extra_args)
        args.append("about:blank")
        self._launched_process = subprocess.Popen([executable_path, *args], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        cdp_url = f"http://127.0.0.1:{port}"
        chrome_ready_timeout_s = 45
        deadline = time.time() + chrome_ready_timeout_s
        while time.time() < deadline:
            try:
                with urllib.request.urlopen(f"{cdp_url}/json/version", timeout=0.5) as response:
                    json.loads(response.read())
                    return {"cdp_url": cdp_url}
            except Exception:
                time.sleep(0.1)
        self.close()
        raise RuntimeError(f"Chrome at {cdp_url} did not become ready within {chrome_ready_timeout_s}s")

    # --- internals ---------------------------------------------------------

    def _prepare_extension_path(self) -> None:
        if not self.extension_path or not self.extension_path.endswith(".zip"):
            return
        self._prepared_extension_dir = tempfile.TemporaryDirectory(prefix="cdpmod-extension.")
        with zipfile.ZipFile(self.extension_path) as archive:
            archive.extractall(self._prepared_extension_dir.name)
        self.extension_path = self._prepared_extension_dir.name

    def _send_raw(self, wrapped: TranslatedCommand) -> JsonValue:
        if wrapped["target"] == "direct_cdp":
            step = wrapped["steps"][0]
            return self._send_frame(step["method"], step.get("params") or {})
        if wrapped["target"] != "service_worker":
            raise RuntimeError(f"Unsupported command target {wrapped['target']!r}")

        result: ProtocolResult = {}
        unwrap: str | None = None
        for step in wrapped["steps"]:
            result = self._send_frame(step["method"], step.get("params") or {}, self.ext_session_id)
            unwrap = step.get("unwrap")
        return unwrap_response_if_needed(result, unwrap)

    def _measure_ping_latency(self) -> CDPModPingLatency:
        sent_at = int(time.time() * 1000)
        done: Queue[ProtocolPayload] = Queue()

        def on_pong(payload: ProtocolPayload) -> None:
            done.put(payload or {})

        self._handlers.setdefault("Mod.pong", []).append(on_pong)
        try:
            self.send("Mod.ping", {"sentAt": sent_at})
            payload = done.get(timeout=10)
        except Empty:
            raise RuntimeError("Mod.pong timed out")
        finally:
            handlers = self._handlers.get("Mod.pong") or []
            if on_pong in handlers:
                handlers.remove(on_pong)

        returned_at = int(time.time() * 1000)
        raw_received_at = payload.get("receivedAt")
        received_at = raw_received_at if isinstance(raw_received_at, (int, float)) else None
        latency: CDPModPingLatency = {
            "sentAt": sent_at,
            "receivedAt": received_at,
            "returnedAt": returned_at,
            "roundTripMs": returned_at - sent_at,
            "serviceWorkerMs": received_at - sent_at if received_at is not None else None,
            "returnPathMs": returned_at - received_at if received_at is not None else None,
        }
        self.latency = latency
        return latency

    def _send_frame(
        self,
        method: str,
        params: FrameParams | None = None,
        session_id: str | None = None,
        timeout: float | None = None,
        record_raw_timing: bool = False,
    ) -> ProtocolResult:
        with self._lock:
            self._next_id += 1
            msg_id = self._next_id
            done: Queue[CdpFrame] = Queue()
            self._pending[msg_id] = (method, done)
        started_at = int(time.time() * 1000)
        msg: CdpFrame = {"id": msg_id, "method": method, "params": params or {}}
        if session_id:
            msg["sessionId"] = session_id
        ws = self._ws
        if ws is None:
            with self._lock:
                self._pending.pop(msg_id, None)
            raise RuntimeError("CDP websocket is not connected")
        try:
            ws.send(json.dumps(msg))
        except Exception:
            with self._lock:
                self._pending.pop(msg_id, None)
            raise
        try:
            response = done.get(timeout=timeout)
        except Empty:
            with self._lock:
                self._pending.pop(msg_id, None)
            raise RuntimeError(f"{method} timed out after {timeout}s")
        err = response.get("error")
        if err:
            raise RuntimeError(f"{method} failed: {err.get('message', err)}")
        if record_raw_timing:
            completed_at = int(time.time() * 1000)
            self.last_raw_timing = {
                "method": method,
                "started_at": started_at,
                "completed_at": completed_at,
                "duration_ms": completed_at - started_at,
            }
        return _json_object(response.get("result"))

    def _reader(self) -> None:
        ws = self._ws
        if ws is None:
            return
        try:
            while True:
                raw = ws.recv()
                if not raw:
                    break
                if isinstance(raw, bytes):
                    raw = raw.decode()
                parsed: object = json.loads(raw)
                if not isinstance(parsed, dict):
                    continue
                msg = cast(CdpFrame, parsed)
                if "id" in msg and msg["id"] is not None:
                    with self._lock:
                        entry = self._pending.pop(msg["id"], None)
                    if entry:
                        entry[1].put(msg)
                    continue
                method = msg.get("method")
                raw_params = msg.get("params")
                params = cast(ProtocolParams, raw_params) if isinstance(raw_params, Mapping) else {}
                if method == "Target.attachedToTarget":
                    session_id = params.get("sessionId")
                    raw_target_info = params.get("targetInfo")
                    target_info = cast(TargetInfo, raw_target_info) if isinstance(raw_target_info, dict) else None
                    target_id = target_info.get("targetId") if target_info else None
                    if isinstance(session_id, str) and isinstance(target_id, str) and target_info:
                        self._target_sessions[target_id] = session_id
                        self._session_targets[session_id] = target_info
                elif method == "Target.detachedFromTarget":
                    session_id = params.get("sessionId")
                    target_info = self._session_targets.pop(session_id, None) if isinstance(session_id, str) else None
                    target_id = target_info.get("targetId") if target_info else None
                    if target_id:
                        self._target_sessions.pop(target_id, None)
                if method and msg.get("sessionId") == self.ext_session_id:
                    session_id = msg.get("sessionId")
                    u = unwrap_event_if_needed(
                        method,
                        params,
                        session_id if isinstance(session_id, str) else None,
                        self.ext_session_id,
                    )
                    if u:
                        for h in self._handlers.get(u["event"], []):
                            def run_wrapped_event(handler=h, payload=u["data"], event_name=u["event"]):
                                try: handler(payload)
                                except Exception as e: print(f"[CDPModClient] handler error for {event_name}: {e}")
                            threading.Thread(target=run_wrapped_event, daemon=True).start()
                    continue
                if method:
                    for h in self._handlers.get(method, []):
                        def run_method_event(handler=h, payload=dict(params), event_name=method):
                            try: handler(payload)
                            except Exception as e: print(f"[CDPModClient] handler error for {event_name}: {e}")
                        threading.Thread(target=run_method_event, daemon=True).start()
        except Exception as e:
            if not self._closed:
                print(f"[CDPModClient] reader exited: {e}")
        finally:
            with self._lock:
                pending = list(self._pending.values())
                self._pending.clear()
            for _, done in pending:
                done.put({"error": {"message": "connection closed"}})

    def _target_infos(self) -> list[TargetInfo]:
        value = self._send_frame("Target.getTargets").get("targetInfos")
        if not isinstance(value, list):
            return []
        targets: list[TargetInfo] = []
        for item in value:
            if not isinstance(item, dict):
                continue
            target_id = item.get("targetId")
            target_type = item.get("type")
            target_url = item.get("url")
            if isinstance(target_id, str) and isinstance(target_type, str) and isinstance(target_url, str):
                targets.append({"targetId": target_id, "type": target_type, "url": target_url})
        return targets

    def _ensure_extension(self) -> ExtensionInfo:
        ready_expression = self._ready_expression()
        trust_service_worker_target = (
            self.trust_service_worker_target
            or len(self.service_worker_url_includes) > 0
            or any(len([part for part in suffix.split("/") if part]) > 1 for suffix in self.service_worker_url_suffixes)
        )

        def probe_target(target: TargetInfo, timeout: float = 0) -> ExtensionProbe | None:
            target_id = target.get("targetId")
            target_url = target.get("url")
            if not target_id or not target_url:
                return None
            session_id = self._session_id_for_target(target_id, timeout=timeout)
            if not session_id:
                return None
            probe = self._send_frame("Runtime.evaluate", {
                "expression": ready_expression,
                "returnByValue": True,
            }, session_id, timeout=2)
            if _json_object(probe.get("result")).get("value") is not True:
                return None
            match = EXT_ID_FROM_URL_RE.match(target_url)
            if match is None:
                return None
            return {
                "extension_id": match.group(1),
                "target_id": target_id,
                "url": target_url,
                "session_id": session_id,
            }

        # 1. Discover an existing CDPMod service worker from the current CDP
        # target snapshot. If none is already ready, use explicit injection.
        target_infos = self._target_infos()
        if trust_service_worker_target:
            for t in target_infos:
                if self._service_worker_target_matches(t):
                    result = probe_target(t, timeout=2)
                    if result:
                        return {"source": "trusted", **result}
        for t in target_infos:
            if t["type"] != "service_worker": continue
            if not t["url"].startswith("chrome-extension://"): continue
            try:
                result = probe_target(t, timeout=2)
            except Exception:
                continue
            if result:
                return {"source": "discovered", **result}
        if self.require_service_worker_target:
            raise RuntimeError(
                "Required CDPMod service worker target was not visible in the current CDP target snapshot "
                f"({', '.join([*self.service_worker_url_includes, *self.service_worker_url_suffixes]) or 'no matcher'})."
            )
        if self.extension_path is None:
            raise RuntimeError("extension_path is required when no existing CDPMod service worker can be discovered.")

        # 2. Try Extensions.loadUnpacked.
        try:
            r = self._send_frame("Extensions.loadUnpacked", {"path": self.extension_path})
            extension_id = r.get("id") or r.get("extensionId")
        except RuntimeError as e:
            if "Method not available" in str(e) or "wasn't found" in str(e):
                target_infos = self._target_infos()
                if trust_service_worker_target:
                    for t in target_infos:
                        if self._service_worker_target_matches(t):
                            result = probe_target(t, timeout=2)
                            if result:
                                return {"source": "trusted", **result}
                for t in target_infos:
                    if t["type"] != "service_worker": continue
                    if not t["url"].startswith("chrome-extension://"): continue
                    try:
                        result = probe_target(t, timeout=2)
                    except Exception:
                        continue
                    if result:
                        return {"source": "discovered", **result}
                return self._borrow_extension_worker(str(e))
            raise
        if not isinstance(extension_id, str) or not extension_id:
            raise RuntimeError(f"Extensions.loadUnpacked returned no id: {r}")

        # 3. Wait for the loaded extension's SW.
        sw_url_prefix = f"chrome-extension://{extension_id}/"
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            for t in self._target_infos():
                target_url = t.get("url") or ""
                if t.get("type") == "service_worker" and target_url.startswith(sw_url_prefix):
                    result = probe_target(t, timeout=2)
                    if result:
                        return {
                            "source": "injected", "extension_id": extension_id,
                            "target_id": t["targetId"], "url": target_url, "session_id": result["session_id"],
                        }
            time.sleep(0.1)
        raise RuntimeError(f"Timed out after 60s waiting for service worker target for extension {extension_id}.")

    def _service_worker_target_matches(self, target: TargetInfo) -> bool:
        url = target.get("url") or ""
        if target.get("type") != "service_worker" or not url.startswith("chrome-extension://"):
            return False
        if self.service_worker_url_includes and not all(part in url for part in self.service_worker_url_includes):
            return False
        if self.service_worker_url_suffixes and not any(url.endswith(suffix) for suffix in self.service_worker_url_suffixes):
            return False
        return bool(self.service_worker_url_includes or self.service_worker_url_suffixes)

    def _borrow_extension_worker(self, load_error: str) -> ExtensionInfo:
        if self.extension_path is None:
            raise RuntimeError("extension_path is required to bootstrap a borrowed extension worker.")
        borrowed: list[BorrowedExtensionInfo] = []
        bootstrap = cdpmod_server_bootstrap_expression(self.extension_path)
        for t in self._target_infos():
            target_id = t.get("targetId")
            target_url = t.get("url") or ""
            if t.get("type") != "service_worker": continue
            if not target_id or not target_url.startswith("chrome-extension://"): continue
            session_id = None
            try:
                session_id = self._session_id_for_target(target_id, timeout=2)
                if not session_id:
                    continue
                try: self._send_frame("Runtime.enable", {}, session_id, timeout=2)
                except Exception: pass
                result = self._send_frame("Runtime.evaluate", {
                    "expression": bootstrap,
                    "awaitPromise": True,
                    "returnByValue": True,
                    "allowUnsafeEvalBlockedByCSP": True,
                }, session_id, timeout=3)
                result_object = result.get("result")
                value = result_object.get("value") if isinstance(result_object, dict) else {}
                if not isinstance(value, dict):
                    value = {}
                ready = bool(value.get("ok"))
                if ready and self.service_worker_ready_expression:
                    probe = self._send_frame("Runtime.evaluate", {
                        "expression": self._ready_expression(),
                        "returnByValue": True,
                    }, session_id, timeout=2)
                    ready = _json_object(probe.get("result")).get("value") is True
                if ready:
                    m = EXT_ID_FROM_URL_RE.match(target_url)
                    extension_id = value.get("extension_id") or (m.group(1) if m else None)
                    if not isinstance(extension_id, str):
                        continue
                    borrowed.append({
                        "source": "borrowed",
                        "extension_id": extension_id,
                        "target_id": target_id,
                        "url": target_url,
                        "session_id": session_id,
                        "has_tabs": bool(value.get("has_tabs")),
                        "has_debugger": bool(value.get("has_debugger")),
                    })
            except Exception:
                pass
        borrowed.sort(key=lambda item: (item.get("has_debugger", False), item.get("has_tabs", False)), reverse=True)
        if borrowed:
            selected = borrowed[0]
            selected.pop("has_tabs", None)
            selected.pop("has_debugger", None)
            return selected
        raise RuntimeError(
            "Cannot install or borrow CDPMod in the running browser.\n"
            "  - No existing service worker with globalThis.CDPMod was found.\n"
            f"  - Extensions.loadUnpacked is unavailable ({load_error}).\n"
            "  - No running chrome-extension:// service worker accepted the CDPMod bootstrap."
        )
