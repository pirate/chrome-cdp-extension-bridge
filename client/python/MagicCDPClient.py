"""MagicCDPClient (Python): importable, no CLI, no demo code.

Constructor parameter names mirror the JS / Go ports:
    cdp_url           upstream CDP URL (str)
    extension_path    extension directory (str)
    routes            client-side routing dict
    server            { 'loopback_cdp_url'?, 'routes'? } passed to MagicCDPServer.configure

Public methods: connect(), send(method, params), on(event, handler), close().
Synchronous (blocking) API; one background thread reads frames off the WS.
"""

import json
import re
import threading
import time
import urllib.request
from pathlib import Path
from queue import Queue, Empty

from websocket import create_connection

from translate import (
    DEFAULT_CLIENT_ROUTES,
    binding_name_for,
    wrap_command_if_needed,
    unwrap_event_if_needed,
    unwrap_response_if_needed,
)

EXT_ID_FROM_URL_RE = re.compile(r"^chrome-extension://([a-z]+)/")
MAGIC_READY_EXPRESSION = (
    "Boolean(globalThis.MagicCDP?.__MagicCDPServerVersion === 1 && "
    "globalThis.MagicCDP?.handleCommand && globalThis.MagicCDP?.addCustomEvent)"
)
DEFAULT_SERVER = object()


def websocket_url_for(endpoint: str) -> str:
    if re.match(r"^wss?://", endpoint, re.I):
        return endpoint
    with urllib.request.urlopen(f"{endpoint}/json/version", timeout=5) as r:
        ws_url = json.loads(r.read()).get("webSocketDebuggerUrl")
    if not ws_url:
        raise RuntimeError(f"HTTP discovery for {endpoint} returned no webSocketDebuggerUrl")
    return ws_url


def magic_server_bootstrap_expression(extension_path: str) -> str:
    server_path = Path(extension_path) / "MagicCDPServer.js"
    source = server_path.read_text()
    start = source.index("export function installMagicCDPServer")
    end = source.index("export const MagicCDPServer")
    installer = source[start:end].replace("export function", "function", 1)
    return (
        "(() => {\n"
        f"{installer}\n"
        "const MagicCDP = installMagicCDPServer(globalThis);\n"
        "return {\n"
        "  ok: Boolean(MagicCDP?.__MagicCDPServerVersion === 1 && MagicCDP?.handleCommand && MagicCDP?.addCustomEvent),\n"
        "  extensionId: globalThis.chrome?.runtime?.id ?? null,\n"
        "  hasTabs: Boolean(globalThis.chrome?.tabs?.query),\n"
        "  hasDebugger: Boolean(globalThis.chrome?.debugger?.sendCommand),\n"
        "};\n"
        "})()"
    )


class MagicCDPClient:
    def __init__(self, cdp_url, extension_path, routes=None, server=DEFAULT_SERVER):
        self.cdp_url = cdp_url
        self.extension_path = extension_path
        self.routes = {**DEFAULT_CLIENT_ROUTES, **(routes or {})}
        self.server = {} if server is DEFAULT_SERVER else server

        self.extension_id = None
        self.ext_target_id = None
        self.ext_session_id = None
        self.latency = None

        self._ws = None
        self._next_id = 0
        self._pending = {}
        self._handlers = {}
        self._lock = threading.Lock()
        self._reader_thread = None
        self._closed = False

    def connect(self):
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

        ext = self._ensure_extension()
        self.extension_id = ext["extensionId"]
        self.ext_target_id = ext["targetId"]
        self.ext_session_id = ext["sessionId"]
        self._send_frame("Runtime.enable", {}, self.ext_session_id)
        self._send_frame("Runtime.addBinding", {"name": binding_name_for("Magic.pong")}, self.ext_session_id)

        if self.server is not None:
            self._send_raw(wrap_command_if_needed(
                "Magic.configure",
                self.server,
                routes=self.routes,
                cdp_session_id=self.ext_session_id,
            ))
        self._measure_ping_latency()
        return self

    def send(self, method, params=None):
        return self._send_raw(wrap_command_if_needed(
            method,
            params or {},
            routes=self.routes,
            cdp_session_id=self.ext_session_id,
        ))

    def on(self, event, handler):
        self._handlers.setdefault(event, []).append(handler)
        return self

    def close(self):
        self._closed = True
        try:
            if self.ext_session_id:
                self._send_frame("Target.detachFromTarget", {"sessionId": self.ext_session_id})
        except Exception:
            pass
        try:
            if self._ws:
                self._ws.close()
        except Exception:
            pass

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

        self._handlers.setdefault("Magic.pong", []).append(on_pong)
        try:
            self.send("Magic.ping", {"sentAt": sent_at})
            payload = done.get(timeout=10)
        except Empty:
            raise RuntimeError("Magic.pong timed out")
        finally:
            handlers = self._handlers.get("Magic.pong") or []
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

    def _send_frame(self, method, params=None, session_id=None, timeout=10):
        with self._lock:
            self._next_id += 1
            msg_id = self._next_id
            done = Queue()
            self._pending[msg_id] = (method, done)
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
                if msg.get("sessionId") == self.ext_session_id:
                    u = unwrap_event_if_needed(msg.get("method"), msg.get("params") or {}, msg.get("sessionId"), self.ext_session_id)
                    if u:
                        for h in self._handlers.get(u["event"], []):
                            try: h(u["data"])
                            except Exception as e: print(f"[MagicCDPClient] handler error for {u['event']}: {e}")
                    continue
                method = msg.get("method")
                if method:
                    for h in self._handlers.get(method, []):
                        try: h(msg.get("params") or {}, msg.get("sessionId"))
                        except Exception as e: print(f"[MagicCDPClient] handler error for {method}: {e}")
        except Exception as e:
            if not self._closed:
                print(f"[MagicCDPClient] reader exited: {e}")
        finally:
            with self._lock:
                pending = list(self._pending.values())
                self._pending.clear()
            for _, done in pending:
                done.put({"error": {"message": "connection closed"}})

    def _ensure_extension(self):
        # 1. Discover an existing MagicCDP service worker. Poll briefly because
        # extensions loaded with --load-extension take a moment to spin up.
        attached = []
        deadline = time.time() + 10.0
        while time.time() <= deadline:
            for t in (self._send_frame("Target.getTargets")["targetInfos"]):
                if t["type"] != "service_worker": continue
                if not t["url"].startswith("chrome-extension://"): continue
                if any(a["targetId"] == t["targetId"] for a in attached): continue
                try:
                    a = self._send_frame("Target.attachToTarget", {"targetId": t["targetId"], "flatten": True}, timeout=2)
                except Exception:
                    continue
                attached.append({"targetId": t["targetId"], "url": t["url"], "sessionId": a["sessionId"]})
            for a in attached:
                try:
                    probe = self._send_frame("Runtime.evaluate", {
                        "expression": MAGIC_READY_EXPRESSION,
                        "returnByValue": True,
                    }, a["sessionId"], timeout=2)
                except Exception:
                    continue
                if (probe.get("result") or {}).get("value") is True:
                    for o in attached:
                        if o["sessionId"] != a["sessionId"]:
                            try: self._send_frame("Target.detachFromTarget", {"sessionId": o["sessionId"]})
                            except Exception: pass
                    return {
                        "source": "discovered",
                        "extensionId": EXT_ID_FROM_URL_RE.match(a["url"]).group(1),
                        "targetId": a["targetId"], "url": a["url"], "sessionId": a["sessionId"],
                    }
            if time.time() >= deadline: break
            time.sleep(0.1)
        for a in attached:
            try: self._send_frame("Target.detachFromTarget", {"sessionId": a["sessionId"]})
            except Exception: pass

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
        sw_url = f"chrome-extension://{extension_id}/service_worker.js"
        deadline = time.time() + 10.0
        while time.time() < deadline:
            for t in (self._send_frame("Target.getTargets")["targetInfos"]):
                if t["type"] == "service_worker" and t["url"] == sw_url:
                    a = self._send_frame("Target.attachToTarget", {"targetId": t["targetId"], "flatten": True})
                    probe = self._send_frame("Runtime.evaluate", {
                        "expression": MAGIC_READY_EXPRESSION,
                        "returnByValue": True,
                    }, a["sessionId"])
                    if (probe.get("result") or {}).get("value") is True:
                        return {
                            "source": "injected", "extensionId": extension_id,
                            "targetId": t["targetId"], "url": sw_url, "sessionId": a["sessionId"],
                        }
                    self._send_frame("Target.detachFromTarget", {"sessionId": a["sessionId"]})
            time.sleep(0.1)
        raise RuntimeError(f"Extensions.loadUnpacked installed {extension_id} but its SW did not appear")

    def _borrow_extension_worker(self, load_error):
        borrowed = []
        bootstrap = magic_server_bootstrap_expression(self.extension_path)
        for t in (self._send_frame("Target.getTargets")["targetInfos"]):
            if t["type"] != "service_worker": continue
            if not t["url"].startswith("chrome-extension://"): continue
            session_id = None
            try:
                a = self._send_frame("Target.attachToTarget", {"targetId": t["targetId"], "flatten": True}, timeout=2)
                session_id = a["sessionId"]
                try: self._send_frame("Runtime.enable", {}, session_id, timeout=2)
                except Exception: pass
                result = self._send_frame("Runtime.evaluate", {
                    "expression": bootstrap,
                    "awaitPromise": True,
                    "returnByValue": True,
                    "allowUnsafeEvalBlockedByCSP": True,
                }, session_id, timeout=3)
                value = (result.get("result") or {}).get("value") or {}
                if value.get("ok"):
                    m = EXT_ID_FROM_URL_RE.match(t["url"])
                    borrowed.append({
                        "source": "borrowed",
                        "extensionId": value.get("extensionId") or (m.group(1) if m else None),
                        "targetId": t["targetId"],
                        "url": t["url"],
                        "sessionId": session_id,
                        "hasTabs": bool(value.get("hasTabs")),
                        "hasDebugger": bool(value.get("hasDebugger")),
                    })
                else:
                    self._send_frame("Target.detachFromTarget", {"sessionId": session_id})
            except Exception:
                if session_id:
                    try: self._send_frame("Target.detachFromTarget", {"sessionId": session_id})
                    except Exception: pass
        borrowed.sort(key=lambda item: (item.get("hasDebugger", False), item.get("hasTabs", False)), reverse=True)
        if borrowed:
            for other in borrowed[1:]:
                try: self._send_frame("Target.detachFromTarget", {"sessionId": other["sessionId"]})
                except Exception: pass
            selected = borrowed[0]
            selected.pop("hasTabs", None)
            selected.pop("hasDebugger", None)
            return selected
        raise RuntimeError(
            "Cannot install or borrow MagicCDP in the running browser.\n"
            "  - No existing service worker with globalThis.MagicCDP was found.\n"
            f"  - Extensions.loadUnpacked is unavailable ({load_error}).\n"
            "  - No running chrome-extension:// service worker accepted the MagicCDP bootstrap."
        )
