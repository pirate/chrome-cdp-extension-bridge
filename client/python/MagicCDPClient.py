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
from queue import Queue, Empty

from websocket import create_connection

from translate import (
    DEFAULT_CLIENT_ROUTES,
    wrap_command_if_needed,
    unwrap_event_if_needed,
    unwrap_response_if_needed,
)

SW_URL_RE = re.compile(r"^chrome-extension://[a-z]+/service_worker\.js$")
EXT_ID_FROM_URL_RE = re.compile(r"^chrome-extension://([a-z]+)/")


def websocket_url_for(endpoint: str) -> str:
    if re.match(r"^wss?://", endpoint, re.I):
        return endpoint
    with urllib.request.urlopen(f"{endpoint}/json/version", timeout=5) as r:
        ws_url = json.loads(r.read()).get("webSocketDebuggerUrl")
    if not ws_url:
        raise RuntimeError(f"HTTP discovery for {endpoint} returned no webSocketDebuggerUrl")
    return ws_url


class MagicCDPClient:
    def __init__(self, cdp_url, extension_path, routes=None, server=None):
        self.cdp_url = cdp_url
        self.extension_path = extension_path
        self.routes = {**DEFAULT_CLIENT_ROUTES, **(routes or {})}
        self.server = server

        self.extension_id = None
        self.ext_target_id = None
        self.ext_session_id = None

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
        if self.server and self.server.get("loopback_cdp_url"):
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

        if self.server:
            self._send_raw(wrap_command_if_needed(
                "Magic.configure",
                self.server,
                routes=self.routes,
                cdp_session_id=self.ext_session_id,
            ))
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
        # 1. Discover an existing MagicCDP service worker. Poll for ~2s because
        # extensions loaded with --load-extension take a moment to spin up.
        attached = []
        deadline = time.time() + 2.0
        while time.time() <= deadline:
            for t in (self._send_frame("Target.getTargets")["targetInfos"]):
                if t["type"] != "service_worker": continue
                if not SW_URL_RE.match(t["url"]): continue
                if any(a["targetId"] == t["targetId"] for a in attached): continue
                a = self._send_frame("Target.attachToTarget", {"targetId": t["targetId"], "flatten": True})
                attached.append({"targetId": t["targetId"], "url": t["url"], "sessionId": a["sessionId"]})
            for a in attached:
                probe = self._send_frame("Runtime.evaluate", {
                    "expression": "Boolean(globalThis.MagicCDP?.handleCommand && globalThis.MagicCDP?.addCustomEvent)",
                    "returnByValue": True,
                }, a["sessionId"])
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
                raise RuntimeError(
                    f"Cannot install MagicCDP extension into the running browser.\n"
                    f"  - No existing service worker with globalThis.MagicCDP was found.\n"
                    f"  - Extensions.loadUnpacked is unavailable in this Chrome build.\n"
                    f"Fixes:\n"
                    f"  1. Relaunch the browser with --load-extension={self.extension_path}\n"
                    f"  2. Use Chrome Canary, which exposes Extensions.loadUnpacked over CDP.\n"
                ) from None
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
                    return {
                        "source": "injected", "extensionId": extension_id,
                        "targetId": t["targetId"], "url": sw_url, "sessionId": a["sessionId"],
                    }
            time.sleep(0.1)
        raise RuntimeError(f"Extensions.loadUnpacked installed {extension_id} but its SW did not appear")
