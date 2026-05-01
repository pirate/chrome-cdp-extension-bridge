"""Pure MagicCDP <-> CDP translation helpers for the Python client."""

import json
import time

BINDING_PREFIX = "__MagicCDP_"

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
    routes = routes or {}
    if method in routes:
        return routes[method]
    best_prefix_len = -1
    best_route = None
    for pattern, route in routes.items():
        if pattern == "*.*" or not pattern.endswith(".*"):
            continue
        prefix = pattern[:-1]
        if method.startswith(prefix) and len(prefix) > best_prefix_len:
            best_prefix_len = len(prefix)
            best_route = route
    if best_route is not None:
        return best_route
    if "*.*" in routes:
        return routes["*.*"]
    return "direct_cdp"


def _eval_params(expression: str):
    return {
        "expression": expression,
        "awaitPromise": True,
        "returnByValue": True,
        "allowUnsafeEvalBlockedByCSP": True,
    }


def _wrap_magic_evaluate(params: dict, session_id: str):
    expression = params["expression"]
    user_params = params.get("params", {})
    cdp_session_id = params.get("cdpSessionId") or session_id
    return _eval_params(
        "(async () => {\n"
        f"  const params = {json.dumps(user_params)};\n"
        f"  const cdp = globalThis.MagicCDP.attachToSession({json.dumps(cdp_session_id)});\n"
        "  const MagicCDP = globalThis.MagicCDP;\n"
        "  const chrome = globalThis.chrome;\n"
        f"  const value = ({expression});\n"
        "  return typeof value === 'function' ? await value(params) : value;\n"
        "})()"
    )


def _wrap_magic_add_custom_command(params: dict):
    return _eval_params(
        "(() => {\n"
        "  return globalThis.MagicCDP.addCustomCommand({\n"
        f"    name: {json.dumps(params['name'])},\n"
        f"    paramsSchema: {json.dumps(params.get('paramsSchema'))},\n"
        f"    resultSchema: {json.dumps(params.get('resultSchema'))},\n"
        f"    expression: {json.dumps(params['expression'])},\n"
        "    handler: async (params, cdpSessionId) => {\n"
        "      const cdp = globalThis.MagicCDP.attachToSession(cdpSessionId);\n"
        "      const MagicCDP = globalThis.MagicCDP;\n"
        "      const chrome = globalThis.chrome;\n"
        f"      const handler = ({params['expression']});\n"
        "      return await handler(params || {});\n"
        "    },\n"
        "  });\n"
        "})()"
    )


def _wrap_magic_add_custom_event(params: dict):
    return _eval_params(
        "globalThis.MagicCDP.addCustomEvent({\n"
        f"  name: {json.dumps(params['name'])},\n"
        f"  bindingName: {json.dumps(binding_name_for(params['name']))},\n"
        f"  eventSchema: {json.dumps(params.get('eventSchema'))},\n"
        "})"
    )


def _wrap_magic_add_middleware(params: dict):
    return _eval_params(
        "(() => {\n"
        "  return globalThis.MagicCDP.addMiddleware({\n"
        f"    name: {json.dumps(params.get('name', '*'))},\n"
        f"    phase: {json.dumps(params['phase'])},\n"
        f"    expression: {json.dumps(params['expression'])},\n"
        "    handler: async (payload, next, context = {}) => {\n"
        "      const cdp = globalThis.MagicCDP.attachToSession(context.cdpSessionId ?? null);\n"
        "      const MagicCDP = globalThis.MagicCDP;\n"
        "      const chrome = globalThis.chrome;\n"
        f"      const middleware = ({params['expression']});\n"
        "      return await middleware(payload, next, context);\n"
        "    },\n"
        "  });\n"
        "})()"
    )


def _wrap_custom_command(method: str, params: dict, session_id: str):
    return _eval_params(
        f"globalThis.MagicCDP.handleCommand("
        f"{json.dumps(method)}, {json.dumps(params)}, "
        f"{json.dumps(session_id)})"
    )


def _wrap_service_worker_command(method: str, params: dict, session_id: str):
    if method == "Magic.ping" and "sentAt" not in params:
        params = {**params, "sentAt": int(time.time() * 1000)}

    if method == "Magic.addCustomEvent":
        return [
            {"method": "Runtime.addBinding", "params": {"name": binding_name_for(params["name"])}},
            {
                "method": "Runtime.evaluate",
                "params": _wrap_magic_add_custom_event(params),
                "unwrap": "evaluate",
            },
        ]
    if method == "Magic.evaluate":
        runtime_params = _wrap_magic_evaluate(params, session_id)
    elif method == "Magic.addCustomCommand":
        runtime_params = _wrap_magic_add_custom_command(params)
    elif method == "Magic.addMiddleware":
        runtime_params = _wrap_magic_add_middleware(params)
    else:
        runtime_params = _wrap_custom_command(method, params, params.get("cdpSessionId") or session_id)
    return [{"method": "Runtime.evaluate", "params": runtime_params, "unwrap": "evaluate"}]


def wrap_command_if_needed(method: str, params=None, *, routes=None, cdp_session_id=None):
    params = params or {}
    route = route_for(method, routes or DEFAULT_CLIENT_ROUTES)
    if route == "direct_cdp":
        return {"route": route, "target": "direct_cdp", "steps": [{"method": method, "params": params}]}
    if route == "service_worker":
        return {
            "route": route,
            "target": "service_worker",
            "steps": _wrap_service_worker_command(method, params, cdp_session_id),
        }
    raise RuntimeError(f"Unsupported client route '{route}' for {method}")


def _unwrap_evaluate_response(result: dict):
    if result.get("exceptionDetails"):
        ex = result["exceptionDetails"]
        msg = (ex.get("exception") or {}).get("description") or ex.get("text") or "Runtime.evaluate failed"
        raise RuntimeError(msg)
    inner = result.get("result") or {}
    return inner.get("value")


def unwrap_response_if_needed(result: dict, unwrap=None):
    return _unwrap_evaluate_response(result) if unwrap == "evaluate" else (result or {})


def unwrap_event_if_needed(method: str, params: dict, session_id=None, our_session_id=None):
    if method != "Runtime.bindingCalled":
        return None
    event = event_name_for(params.get("name") or "")
    if event is None:
        return None
    try:
        payload = json.loads(params.get("payload") or "{}")
    except json.JSONDecodeError:
        return None
    if not isinstance(payload, dict):
        return None
    if our_session_id is not None and payload.get("cdpSessionId") and payload["cdpSessionId"] != our_session_id:
        return None
    data = payload["data"] if "data" in payload else payload
    return {"event": event, "data": data, "sessionId": session_id}
