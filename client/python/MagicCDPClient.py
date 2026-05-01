"""MagicCDPClient (Python): importable, no CLI, no demo code.

Constructor parameter names mirror the JS / Go ports:
    cdp_url           upstream CDP URL (str)
    extension_path    extension directory (str)
    routes            client-side routing dict
    server            { 'loopback_cdp_url'?, 'routes'? } passed to MagicCDPServer.configure
    session_id        client cdpSessionId tag for event scoping (str)

Public methods: connect(), send(method, params), on(event, handler), close().
Synchronous (blocking) API; one background thread reads frames off the WS.

Wrap/unwrap is inlined here to mirror bridge/translate.mjs without an extra
file. Same wire format as the JS side (encodeBindingPayload).
"""

import json
import re
import threading
import time
import urllib.request
import uuid
from queue import Queue, Empty

from websocket import create_connection

BINDING_PREFIX = "__MagicCDP_"
SW_URL_RE = re.compile(r"^chrome-extension://[a-z]+/service_worker\.js$")
EXT_ID_FROM_URL_RE = re.compile(r"^chrome-extension://([a-z]+)/")

DEFAULT_CLIENT_ROUTES = {
    "Magic.*": "service_worker",
    "Custom.*": "service_worker",
    "*.*": "direct_cdp",
}


def binding_name_for(event_name: str) -> str:
    return BINDING_PREFIX + event_name.replace(".", "_")


def event_name_for(binding_name: str):
    if not binding_name.startswith(BINDING_PREFIX):
        return None
    return binding_name[len(BINDING_PREFIX):].replace("_", ".")


def route_for(method: str, routes: dict) -> str:
    fallback = "direct_cdp"
    for pattern, route in (routes or {}).items():
        if pattern == "*.*":
            fallback = route
            continue
        if pattern.endswith(".*") and method.startswith(pattern[:-1]):
            return route
        if pattern == method:
            return route
    return fallback


def wrap_magic_evaluate(params: dict, session_id: str):
    expression = params["expression"]
    user_params = params.get("params", {})
    cdp_session_id = params.get("cdpSessionId") or session_id
    return {
        "expression": (
            "(async () => {\n"
            f"  const params = {json.dumps(user_params)};\n"
            f"  const cdp = globalThis.MagicCDP.attachToSession({json.dumps(cdp_session_id)});\n"
            "  const context = { cdp, MagicCDP: globalThis.MagicCDP, chrome: globalThis.chrome };\n"
            f"  const value = ({expression});\n"
            "  return typeof value === 'function' ? await value(params, context) : value;\n"
            "})()"
        ),
        "awaitPromise": True,
        "returnByValue": True,
        "allowUnsafeEvalBlockedByCSP": True,
    }


def wrap_magic_add_custom_command(params: dict):
    return {
        "expression": (
            "(() => {\n"
            f"  const handler = ({params['expression']});\n"
            "  return globalThis.MagicCDP.addCustomCommand({\n"
            f"    name: {json.dumps(params['name'])},\n"
            f"    paramsSchema: {json.dumps(params.get('paramsSchema'))},\n"
            f"    resultSchema: {json.dumps(params.get('resultSchema'))},\n"
            f"    expression: {json.dumps(params['expression'])},\n"
            "    handler: async (params, meta) => {\n"
            "      const cdp = globalThis.MagicCDP.attachToSession(meta.cdpSessionId);\n"
            "      return await handler(params || {}, { cdp, MagicCDP: globalThis.MagicCDP, chrome: globalThis.chrome, meta });\n"
            "    },\n"
            "  });\n"
            "})()"
        ),
        "awaitPromise": True,
        "returnByValue": True,
        "allowUnsafeEvalBlockedByCSP": True,
    }


def wrap_magic_add_custom_event(params: dict):
    return {
        "expression": (
            "globalThis.MagicCDP.addCustomEvent({\n"
            f"  name: {json.dumps(params['name'])},\n"
            f"  bindingName: {json.dumps(binding_name_for(params['name']))},\n"
            f"  payloadSchema: {json.dumps(params.get('payloadSchema'))},\n"
            "})"
        ),
        "awaitPromise": True,
        "returnByValue": True,
        "allowUnsafeEvalBlockedByCSP": True,
    }


def wrap_custom_command(method: str, params: dict, session_id: str):
    return {
        "expression": (
            f"globalThis.MagicCDP.handleCommand("
            f"{json.dumps(method)}, {json.dumps(params)}, "
            f"{json.dumps({'cdpSessionId': session_id})})"
        ),
        "awaitPromise": True,
        "returnByValue": True,
        "allowUnsafeEvalBlockedByCSP": True,
    }


def unwrap_evaluate_result(result: dict):
    if result.get("exceptionDetails"):
        ex = result["exceptionDetails"]
        msg = (ex.get("exception") or {}).get("description") or ex.get("text") or "Runtime.evaluate failed"
        raise RuntimeError(msg)
    inner = result.get("result") or {}
    return inner.get("value")


def unwrap_binding_called(params: dict, our_session_id: str):
    event = event_name_for(params.get("name") or "")
    if event is None:
        return None
    payload = json.loads(params.get("payload") or "{}")
    if our_session_id is not None and payload.get("cdpSessionId") and payload["cdpSessionId"] != our_session_id:
        return None
    data = payload["data"] if "data" in payload else payload
    return {"event": event, "data": data}


class MagicCDPClient:
    def __init__(self, cdp_url, extension_path, routes=None, server=None, session_id=None):
        self.cdp_url = cdp_url
        self.extension_path = extension_path
        self.routes = {**DEFAULT_CLIENT_ROUTES, **(routes or {})}
        self.server = server
        self.session_id = session_id or str(uuid.uuid4())

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
        with urllib.request.urlopen(f"{self.cdp_url}/json/version", timeout=5) as r:
            ws_url = json.loads(r.read())["webSocketDebuggerUrl"]
        self._ws = create_connection(ws_url)
        self._reader_thread = threading.Thread(target=self._reader, daemon=True)
        self._reader_thread.start()

        ext = self._ensure_extension()
        self.extension_id = ext["extensionId"]
        self.ext_target_id = ext["targetId"]
        self.ext_session_id = ext["sessionId"]
        self._send_raw("Runtime.enable", {}, self.ext_session_id)

        if self.server:
            self._send_raw("Runtime.evaluate", {
                "expression": f"globalThis.MagicCDP.configure({json.dumps(self.server)})",
                "awaitPromise": True,
                "returnByValue": True,
                "allowUnsafeEvalBlockedByCSP": True,
            }, self.ext_session_id)
        return self

    def send(self, method, params=None):
        params = params or {}
        route = route_for(method, self.routes)
        if route == "service_worker":
            if method == "Magic.evaluate":
                return unwrap_evaluate_result(self._send_raw("Runtime.evaluate", wrap_magic_evaluate(params, self.session_id), self.ext_session_id))
            if method == "Magic.addCustomCommand":
                return unwrap_evaluate_result(self._send_raw("Runtime.evaluate", wrap_magic_add_custom_command(params), self.ext_session_id))
            if method == "Magic.addCustomEvent":
                self._send_raw("Runtime.addBinding", {"name": binding_name_for(params["name"])}, self.ext_session_id)
                return unwrap_evaluate_result(self._send_raw("Runtime.evaluate", wrap_magic_add_custom_event(params), self.ext_session_id))
            return unwrap_evaluate_result(self._send_raw("Runtime.evaluate", wrap_custom_command(method, params, self.session_id), self.ext_session_id))
        if route == "direct_cdp":
            return self._send_raw(method, params)
        raise RuntimeError(f"Unsupported client route '{route}' for {method}")

    def on(self, event, handler):
        self._handlers.setdefault(event, []).append(handler)
        return self

    def close(self):
        self._closed = True
        try:
            if self.ext_session_id:
                self._send_raw("Target.detachFromTarget", {"sessionId": self.ext_session_id})
        except Exception:
            pass
        try:
            if self._ws:
                self._ws.close()
        except Exception:
            pass

    # --- internals ---------------------------------------------------------

    def _send_raw(self, method, params=None, session_id=None, timeout=10):
        with self._lock:
            self._next_id += 1
            msg_id = self._next_id
            done = Queue()
            self._pending[msg_id] = (method, done)
        msg = {"id": msg_id, "method": method, "params": params or {}}
        if session_id:
            msg["sessionId"] = session_id
        self._ws.send(json.dumps(msg))
        try:
            response = done.get(timeout=timeout)
        except Empty:
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
                if msg.get("method") == "Runtime.bindingCalled" and msg.get("sessionId") == self.ext_session_id:
                    u = unwrap_binding_called(msg.get("params") or {}, self.session_id)
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
            for t in (self._send_raw("Target.getTargets")["targetInfos"]):
                if t["type"] != "service_worker": continue
                if not SW_URL_RE.match(t["url"]): continue
                if any(a["targetId"] == t["targetId"] for a in attached): continue
                a = self._send_raw("Target.attachToTarget", {"targetId": t["targetId"], "flatten": True})
                attached.append({"targetId": t["targetId"], "url": t["url"], "sessionId": a["sessionId"]})
            for a in attached:
                probe = self._send_raw("Runtime.evaluate", {
                    "expression": "Boolean(globalThis.MagicCDP?.handleCommand && globalThis.MagicCDP?.addCustomEvent)",
                    "returnByValue": True,
                }, a["sessionId"])
                if (probe.get("result") or {}).get("value") is True:
                    for o in attached:
                        if o["sessionId"] != a["sessionId"]:
                            try: self._send_raw("Target.detachFromTarget", {"sessionId": o["sessionId"]})
                            except Exception: pass
                    return {
                        "source": "discovered",
                        "extensionId": EXT_ID_FROM_URL_RE.match(a["url"]).group(1),
                        "targetId": a["targetId"], "url": a["url"], "sessionId": a["sessionId"],
                    }
            if time.time() >= deadline: break
            time.sleep(0.1)
        for a in attached:
            try: self._send_raw("Target.detachFromTarget", {"sessionId": a["sessionId"]})
            except Exception: pass

        # 2. Try Extensions.loadUnpacked.
        try:
            r = self._send_raw("Extensions.loadUnpacked", {"path": self.extension_path})
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
            for t in (self._send_raw("Target.getTargets")["targetInfos"]):
                if t["type"] == "service_worker" and t["url"] == sw_url:
                    a = self._send_raw("Target.attachToTarget", {"targetId": t["targetId"], "flatten": True})
                    return {
                        "source": "injected", "extensionId": extension_id,
                        "targetId": t["targetId"], "url": sw_url, "sessionId": a["sessionId"],
                    }
            time.sleep(0.1)
        raise RuntimeError(f"Extensions.loadUnpacked installed {extension_id} but its SW did not appear")
