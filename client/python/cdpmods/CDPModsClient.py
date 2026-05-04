"""CDPModsClient (Python): importable, no CLI, no demo code.

Constructor parameter names mirror the JS / Go ports:
    cdp_url           upstream CDP URL (str)
    extension_path    extension directory (str)
    routes            client-side routing dict
    server            { 'loopback_cdp_url'?, 'routes'? } passed to CDPModsServer.configure

Public methods: connect(), send(method, params), on(event, handler), close().
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
from pathlib import Path
from queue import Queue, Empty

from websocket import create_connection

from .translate import (
    DEFAULT_CLIENT_ROUTES,
    binding_name_for,
    wrap_command_if_needed,
    unwrap_event_if_needed,
    unwrap_response_if_needed,
)

EXT_ID_FROM_URL_RE = re.compile(r"^chrome-extension://([a-z]+)/")
CDPMODS_READY_EXPRESSION = (
    "Boolean(globalThis.CDPMods?.__CDPModsServerVersion === 1 && "
    "globalThis.CDPMods?.handleCommand && globalThis.CDPMods?.addCustomEvent)"
)
DEFAULT_SERVER = object()


class _DomainMethods:
    def __init__(self, client, domain):
        self._client = client
        self._domain = domain

    def __getattr__(self, method):
        def call(*args, **kwargs):
            if len(args) > 1:
                raise TypeError(f"{self._domain}.{method} accepts at most one positional params object")
            params = dict(args[0]) if args else {}
            params.update(kwargs)
            return self._client.send(f"{self._domain}.{method}", params)

        return call


def websocket_url_for(endpoint: str) -> str:
    if re.match(r"^wss?://", endpoint, re.I):
        return endpoint
    with urllib.request.urlopen(f"{endpoint}/json/version", timeout=5) as r:
        ws_url = json.loads(r.read()).get("webSocketDebuggerUrl")
    if not ws_url:
        raise RuntimeError(f"HTTP discovery for {endpoint} returned no webSocketDebuggerUrl")
    return ws_url


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def cdpmods_server_bootstrap_expression(extension_path: str) -> str:
    server_path = Path(extension_path) / "CDPModsServer.js"
    source = server_path.read_text()
    start = source.index("export function installCDPModsServer")
    end = source.index("export const CDPModsServer")
    installer = source[start:end].replace("export function", "function", 1)
    return (
        "(() => {\n"
        f"{installer}\n"
        "const CDPMods = installCDPModsServer(globalThis);\n"
        "return {\n"
        "  ok: Boolean(CDPMods?.__CDPModsServerVersion === 1 && CDPMods?.handleCommand && CDPMods?.addCustomEvent),\n"
        "  extension_id: globalThis.chrome?.runtime?.id ?? null,\n"
        "  has_tabs: Boolean(globalThis.chrome?.tabs?.query),\n"
        "  has_debugger: Boolean(globalThis.chrome?.debugger?.sendCommand),\n"
        "};\n"
        "})()"
    )


class CDPModsClient:
    def __init__(
        self,
        cdp_url=None,
        extension_path=None,
        routes=None,
        server=DEFAULT_SERVER,
        custom_commands=None,
        custom_events=None,
        custom_middlewares=None,
        service_worker_url_includes=None,
        service_worker_url_suffixes=None,
        trust_service_worker_target=False,
        require_service_worker_target=False,
        service_worker_ready_expression=None,
        launch_options=None,
    ):
        self.cdp_url = cdp_url
        self.extension_path = extension_path
        self.routes = {**DEFAULT_CLIENT_ROUTES, **(routes or {})}
        self.server = {} if server is DEFAULT_SERVER else server
        self.custom_commands = list(custom_commands or [])
        self.custom_events = list(custom_events or [])
        self.custom_middlewares = list(custom_middlewares or [])
        self.service_worker_url_includes = list(service_worker_url_includes or [])
        self.service_worker_url_suffixes = list(service_worker_url_suffixes or ["/service_worker.js", "/background.js"])
        self.trust_service_worker_target = trust_service_worker_target
        self.require_service_worker_target = require_service_worker_target
        self.service_worker_ready_expression = service_worker_ready_expression
        self.launch_options = dict(launch_options or {})

        self.extension_id = None
        self.ext_target_id = None
        self.ext_session_id = None
        self.latency = None
        self.connect_timing = None
        self.last_command_timing = None
        self.last_raw_timing = None

        self._ws = None
        self._next_id = 0
        self._pending = {}
        self._handlers = {}
        self._lock = threading.Lock()
        self._target_sessions = {}
        self._session_targets = {}
        self._reader_thread = None
        self._closed = False
        self._launched_process = None
        self._profile_dir = None

    def connect(self):
        connect_started_at = int(time.time() * 1000)
        if self.cdp_url is None:
            launched = self._launch_chrome()
            self.cdp_url = launched["cdp_url"]
        input_cdp_url = self.cdp_url
        self.cdp_url = websocket_url_for(self.cdp_url)
        if self.server is not None and "loopback_cdp_url" not in self.server:
            self.server = {**self.server, "loopback_cdp_url": self.cdp_url}
        elif self.server and self.server.get("loopback_cdp_url"):
            loopback_url = self.server["loopback_cdp_url"]
            if loopback_url == input_cdp_url or loopback_url == self.cdp_url:
                self.server = {**self.server, "loopback_cdp_url": self.cdp_url}
        self._ws = create_connection(self.cdp_url)
        self._reader_thread = threading.Thread(target=self._reader, daemon=True)
        self._reader_thread.start()

        self._send_frame("Target.setAutoAttach", {
            "autoAttach": True,
            "waitForDebuggerOnStart": False,
            "flatten": True,
        })
        self._send_frame("Target.setDiscoverTargets", {"discover": True})

        extension_started_at = int(time.time() * 1000)
        ext = self._ensure_extension()
        extension_completed_at = int(time.time() * 1000)
        self.extension_id = ext["extension_id"]
        self.ext_target_id = ext["target_id"]
        self.ext_session_id = ext["session_id"]
        self._send_frame("Runtime.enable", {}, self.ext_session_id)
        self._send_frame("Runtime.addBinding", {"name": binding_name_for("Mods.pong")}, self.ext_session_id)
        for event in self.custom_events:
            name = event.get("name") if isinstance(event, dict) else event
            if isinstance(name, str) and name:
                self._send_frame("Runtime.addBinding", {"name": binding_name_for(name)}, self.ext_session_id)

        if self.server is not None:
            self._send_raw(wrap_command_if_needed(
                "Mods.configure",
                {
                    **self.server,
                    "custom_events": [
                        {
                            "name": event["name"] if isinstance(event, dict) else event,
                            "eventSchema": (event.get("eventSchema") if isinstance(event, dict) else None),
                        }
                        for event in self.custom_events
                    ],
                    "custom_commands": [
                        {
                            "name": command["name"],
                            "expression": command["expression"],
                            "paramsSchema": command.get("paramsSchema"),
                            "resultSchema": command.get("resultSchema"),
                        }
                        for command in self.custom_commands
                        if isinstance(command.get("expression"), str) and command.get("expression")
                    ],
                    "custom_middlewares": [
                        {
                            **({"name": middleware["name"]} if middleware.get("name") else {}),
                            "phase": middleware["phase"],
                            "expression": middleware["expression"],
                        }
                        for middleware in self.custom_middlewares
                    ],
                },
                routes=self.routes,
                cdp_session_id=self.ext_session_id,
            ))
        self._measure_ping_latency()
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

    def send(self, method, params=None):
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

    def raw_send(self, method, params=None):
        return self._send_frame(method, params or {}, record_raw_timing=True)

    def on(self, event, handler):
        self._handlers.setdefault(event, []).append(handler)
        return self

    def __getattr__(self, domain):
        if domain.startswith("_"):
            raise AttributeError(domain)
        return _DomainMethods(self, domain)

    def close(self):
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

    def _ready_expression(self):
        if not self.service_worker_ready_expression:
            return CDPMODS_READY_EXPRESSION
        return f"({CDPMODS_READY_EXPRESSION}) && Boolean({self.service_worker_ready_expression})"

    def _session_id_for_target(self, target_id, timeout=0):
        if timeout <= 0:
            return self._target_sessions.get(target_id)
        deadline = time.time() + timeout
        while time.time() <= deadline:
            session_id = self._target_sessions.get(target_id)
            if session_id:
                return session_id
            time.sleep(0.02)
        return None

    def _launch_chrome(self):
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
        self._profile_dir = tempfile.TemporaryDirectory(prefix="cdpmods.")
        args = [
            "--enable-unsafe-extension-debugging",
            "--remote-allow-origins=*",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-default-apps",
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
        extra_args = self.launch_options.get("extra_args") or []
        args.extend(extra_args)
        args.append("about:blank")
        self._launched_process = subprocess.Popen([executable_path, *args], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        cdp_url = f"http://127.0.0.1:{port}"
        deadline = time.time() + 15
        while time.time() < deadline:
            try:
                with urllib.request.urlopen(f"{cdp_url}/json/version", timeout=0.5) as response:
                    json.loads(response.read())
                    return {"cdp_url": cdp_url}
            except Exception:
                time.sleep(0.1)
        self.close()
        raise RuntimeError(f"Chrome at {cdp_url} did not become ready within 15s")

    # --- internals ---------------------------------------------------------

    def _send_raw(self, wrapped):
        if wrapped["target"] == "direct_cdp":
            step = wrapped["steps"][0]
            return self._send_frame(step["method"], step.get("params") or {})
        if wrapped["target"] != "service_worker":
            raise RuntimeError(f"Unsupported command target {wrapped['target']!r}")

        result = {}
        unwrap = None
        for step in wrapped["steps"]:
            result = self._send_frame(step["method"], step.get("params") or {}, self.ext_session_id)
            unwrap = step.get("unwrap")
        return unwrap_response_if_needed(result, unwrap)

    def _measure_ping_latency(self):
        sent_at = int(time.time() * 1000)
        done = Queue()

        def on_pong(payload):
            done.put(payload or {})

        self._handlers.setdefault("Mods.pong", []).append(on_pong)
        try:
            self.send("Mods.ping", {"sentAt": sent_at})
            payload = done.get(timeout=10)
        except Empty:
            raise RuntimeError("Mods.pong timed out")
        finally:
            handlers = self._handlers.get("Mods.pong") or []
            if on_pong in handlers:
                handlers.remove(on_pong)

        returned_at = int(time.time() * 1000)
        received_at = payload.get("receivedAt")
        self.latency = {
            "sentAt": sent_at,
            "receivedAt": received_at,
            "returnedAt": returned_at,
            "roundTripMs": returned_at - sent_at,
            "serviceWorkerMs": received_at - sent_at if isinstance(received_at, (int, float)) else None,
            "returnPathMs": returned_at - received_at if isinstance(received_at, (int, float)) else None,
        }
        return self.latency

    def _send_frame(self, method, params=None, session_id=None, timeout=None, record_raw_timing=False):
        with self._lock:
            self._next_id += 1
            msg_id = self._next_id
            done = Queue()
            self._pending[msg_id] = (method, done)
        started_at = int(time.time() * 1000)
        msg = {"id": msg_id, "method": method, "params": params or {}}
        if session_id:
            msg["sessionId"] = session_id
        try:
            self._ws.send(json.dumps(msg))
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
        if response.get("error"):
            err = response["error"]
            raise RuntimeError(f"{method} failed: {err.get('message', err)}")
        if record_raw_timing:
            completed_at = int(time.time() * 1000)
            self.last_raw_timing = {
                "method": method,
                "started_at": started_at,
                "completed_at": completed_at,
                "duration_ms": completed_at - started_at,
            }
        return response.get("result") or {}

    def _reader(self):
        try:
            while True:
                raw = self._ws.recv()
                if not raw:
                    break
                msg = json.loads(raw)
                if "id" in msg and msg["id"] is not None:
                    with self._lock:
                        entry = self._pending.pop(msg["id"], None)
                    if entry:
                        entry[1].put(msg)
                    continue
                method = msg.get("method")
                params = msg.get("params") or {}
                if method == "Target.attachedToTarget":
                    session_id = params.get("sessionId")
                    target_info = params.get("targetInfo") or {}
                    target_id = target_info.get("targetId")
                    if session_id and target_id:
                        self._target_sessions[target_id] = session_id
                        self._session_targets[session_id] = target_info
                elif method == "Target.detachedFromTarget":
                    session_id = params.get("sessionId")
                    target_info = self._session_targets.pop(session_id, {}) if session_id else {}
                    target_id = target_info.get("targetId")
                    if target_id:
                        self._target_sessions.pop(target_id, None)
                if msg.get("sessionId") == self.ext_session_id:
                    u = unwrap_event_if_needed(msg.get("method"), msg.get("params") or {}, msg.get("sessionId"), self.ext_session_id)
                    if u:
                        for h in self._handlers.get(u["event"], []):
                            try: h(u["data"])
                            except Exception as e: print(f"[CDPModsClient] handler error for {u['event']}: {e}")
                    continue
                if method:
                    event = {"method": method, "params": msg.get("params") or {}, "cdp_session_id": msg.get("sessionId")}
                    for h in self._handlers.get(method, []):
                        try: h(event)
                        except Exception as e: print(f"[CDPModsClient] handler error for {method}: {e}")
        except Exception as e:
            if not self._closed:
                print(f"[CDPModsClient] reader exited: {e}")
        finally:
            with self._lock:
                pending = list(self._pending.values())
                self._pending.clear()
            for _, done in pending:
                done.put({"error": {"message": "connection closed"}})

    def _ensure_extension(self):
        ready_expression = self._ready_expression()
        def probe_target(target):
            session_id = self._session_id_for_target(target["targetId"])
            if not session_id:
                return None
            probe = self._send_frame("Runtime.evaluate", {
                "expression": ready_expression,
                "returnByValue": True,
            }, session_id, timeout=2)
            if (probe.get("result") or {}).get("value") is not True:
                return None
            return {
                "extension_id": EXT_ID_FROM_URL_RE.match(target["url"]).group(1),
                "target_id": target["targetId"],
                "url": target["url"],
                "session_id": session_id,
            }
        # 1. Discover an existing CDPMods service worker from the current CDP
        # target snapshot. If none is already ready, use explicit injection.
        target_infos = self._send_frame("Target.getTargets")["targetInfos"]
        if self.trust_service_worker_target:
            for t in target_infos:
                if self._service_worker_target_matches(t):
                    result = probe_target(t)
                    if result:
                        return {"source": "trusted", **result}
        for t in target_infos:
            if t["type"] != "service_worker": continue
            if not t["url"].startswith("chrome-extension://"): continue
            try:
                result = probe_target(t)
            except Exception:
                continue
            if result:
                return {"source": "discovered", **result}
        if self.require_service_worker_target:
            raise RuntimeError(
                "Required CDPMods service worker target was not visible in the current CDP target snapshot "
                f"({', '.join([*self.service_worker_url_includes, *self.service_worker_url_suffixes]) or 'no matcher'})."
            )

        # 2. Try Extensions.loadUnpacked.
        try:
            r = self._send_frame("Extensions.loadUnpacked", {"path": self.extension_path})
            extension_id = r.get("id") or r.get("extensionId")
        except RuntimeError as e:
            if "Method not available" in str(e) or "wasn't found" in str(e):
                return self._borrow_extension_worker(str(e))
            raise
        if not extension_id:
            raise RuntimeError(f"Extensions.loadUnpacked returned no id: {r}")

        # 3. Wait for the loaded extension's SW.
        sw_url_prefix = f"chrome-extension://{extension_id}/"
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            for t in (self._send_frame("Target.getTargets")["targetInfos"]):
                if t["type"] == "service_worker" and t["url"].startswith(sw_url_prefix):
                    result = probe_target(t)
                    if result:
                        return {
                            "source": "injected", "extension_id": extension_id,
                            "target_id": t["targetId"], "url": t["url"], "session_id": result["session_id"],
                        }
            time.sleep(0.1)
        raise RuntimeError(f"Timed out after 60s waiting for service worker target for extension {extension_id}.")

    def _service_worker_target_matches(self, target):
        url = target.get("url") or ""
        if target.get("type") != "service_worker" or not url.startswith("chrome-extension://"):
            return False
        if self.service_worker_url_includes and not all(part in url for part in self.service_worker_url_includes):
            return False
        if self.service_worker_url_suffixes and not any(url.endswith(suffix) for suffix in self.service_worker_url_suffixes):
            return False
        return bool(self.service_worker_url_includes or self.service_worker_url_suffixes)

    def _borrow_extension_worker(self, load_error):
        borrowed = []
        bootstrap = cdpmods_server_bootstrap_expression(self.extension_path)
        for t in (self._send_frame("Target.getTargets")["targetInfos"]):
            if t["type"] != "service_worker": continue
            if not t["url"].startswith("chrome-extension://"): continue
            session_id = None
            try:
                session_id = self._session_id_for_target(t["targetId"], timeout=0.05)
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
                value = (result.get("result") or {}).get("value") or {}
                ready = bool(value.get("ok"))
                if ready and self.service_worker_ready_expression:
                    probe = self._send_frame("Runtime.evaluate", {
                        "expression": self._ready_expression(),
                        "returnByValue": True,
                    }, session_id, timeout=2)
                    ready = (probe.get("result") or {}).get("value") is True
                if ready:
                    m = EXT_ID_FROM_URL_RE.match(t["url"])
                    borrowed.append({
                        "source": "borrowed",
                        "extension_id": value.get("extension_id") or (m.group(1) if m else None),
                        "target_id": t["targetId"],
                        "url": t["url"],
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
            "Cannot install or borrow CDPMods in the running browser.\n"
            "  - No existing service worker with globalThis.CDPMods was found.\n"
            f"  - Extensions.loadUnpacked is unavailable ({load_error}).\n"
            "  - No running chrome-extension:// service worker accepted the CDPMods bootstrap."
        )
