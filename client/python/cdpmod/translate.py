"""Pure CDPMod <-> CDP translation helpers for the Python client."""

import json
import time
from typing import cast

from .types import (
    CDPModRoutes,
    JsonObject,
    JsonValue,
    ProtocolParams,
    ProtocolPayload,
    ProtocolResult,
    RuntimeEvaluateParams,
    TranslatedCommand,
    TranslatedStep,
    UnwrappedCDPModEvent,
)

BINDING_PREFIX = "__CDPMod_"

DEFAULT_CLIENT_ROUTES: CDPModRoutes = {
    "Mod.*": "service_worker",
    "Custom.*": "service_worker",
    "*.*": "service_worker",
}


def binding_name_for(event_name: str) -> str:
    return BINDING_PREFIX + event_name.replace(".", "_")


def event_name_for(binding_name: str) -> str | None:
    if not binding_name.startswith(BINDING_PREFIX):
        return None
    return binding_name[len(BINDING_PREFIX):].replace("_", ".")


def route_for(method: str, routes: CDPModRoutes) -> str:
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


def _required_string(params: ProtocolParams, name: str) -> str:
    value = params.get(name)
    if not isinstance(value, str) or not value:
        raise TypeError(f"{name} must be a non-empty string")
    return value


def _optional_string(params: ProtocolParams, name: str) -> str | None:
    value = params.get(name)
    if value is None:
        return None
    if not isinstance(value, str):
        raise TypeError(f"{name} must be a string")
    return value


def _object_or_empty(value: JsonValue | None) -> JsonObject:
    return value if isinstance(value, dict) else {}


def _eval_params(expression: str) -> RuntimeEvaluateParams:
    return {
        "expression": expression,
        "awaitPromise": True,
        "returnByValue": True,
        "allowUnsafeEvalBlockedByCSP": True,
    }


def _wrap_cdpmod_evaluate(params: ProtocolParams, session_id: str) -> RuntimeEvaluateParams:
    expression = _required_string(params, "expression")
    user_params = params.get("params", {})
    cdp_session_id = _optional_string(params, "cdpSessionId") or session_id
    return _eval_params(
        "(async () => {\n"
        f"  const params = {json.dumps(user_params)};\n"
        f"  const cdp = globalThis.CDPMod.attachToSession({json.dumps(cdp_session_id)});\n"
        "  const CDPMod = globalThis.CDPMod;\n"
        "  const chrome = globalThis.chrome;\n"
        f"  const value = ({expression});\n"
        "  return typeof value === 'function' ? await value(params) : value;\n"
        "})()"
    )


def _wrap_cdpmod_add_custom_command(params: ProtocolParams) -> RuntimeEvaluateParams:
    name = _required_string(params, "name")
    expression = _required_string(params, "expression")
    return _eval_params(
        "(() => {\n"
        "  return globalThis.CDPMod.addCustomCommand({\n"
        f"    name: {json.dumps(name)},\n"
        f"    paramsSchema: {json.dumps(params.get('paramsSchema'))},\n"
        f"    resultSchema: {json.dumps(params.get('resultSchema'))},\n"
        f"    expression: {json.dumps(expression)},\n"
        "    handler: async (params, cdpSessionId, method) => {\n"
        "      const cdp = globalThis.CDPMod.attachToSession(cdpSessionId);\n"
        "      const CDPMod = globalThis.CDPMod;\n"
        "      const chrome = globalThis.chrome;\n"
        f"      const handler = ({expression});\n"
        "      return await handler(params || {}, method);\n"
        "    },\n"
        "  });\n"
        "})()"
    )


def _wrap_cdpmod_add_custom_event(params: ProtocolParams) -> RuntimeEvaluateParams:
    name = _required_string(params, "name")
    return _eval_params(
        "globalThis.CDPMod.addCustomEvent({\n"
        f"  name: {json.dumps(name)},\n"
        f"  bindingName: {json.dumps(binding_name_for(name))},\n"
        f"  eventSchema: {json.dumps(params.get('eventSchema'))},\n"
        "})"
    )


def _wrap_cdpmod_add_middleware(params: ProtocolParams) -> RuntimeEvaluateParams:
    phase = _required_string(params, "phase")
    expression = _required_string(params, "expression")
    name = _optional_string(params, "name") or "*"
    return _eval_params(
        "(() => {\n"
        "  return globalThis.CDPMod.addMiddleware({\n"
        f"    name: {json.dumps(name)},\n"
        f"    phase: {json.dumps(phase)},\n"
        f"    expression: {json.dumps(expression)},\n"
        "    handler: async (payload, next, context = {}) => {\n"
        "      const cdp = globalThis.CDPMod.attachToSession(context.cdpSessionId ?? null);\n"
        "      const CDPMod = globalThis.CDPMod;\n"
        "      const chrome = globalThis.chrome;\n"
        f"      const middleware = ({expression});\n"
        "      return await middleware(payload, next, context);\n"
        "    },\n"
        "  });\n"
        "})()"
    )


def _wrap_custom_command(method: str, params: ProtocolParams, session_id: str) -> RuntimeEvaluateParams:
    return _eval_params(
        f"globalThis.CDPMod.handleCommand("
        f"{json.dumps(method)}, {json.dumps(params)}, "
        f"{json.dumps(session_id)})"
    )


def _wrap_service_worker_command(method: str, params: ProtocolParams, session_id: str) -> list[TranslatedStep]:
    if method == "Mod.ping" and "sentAt" not in params:
        params = {**params, "sentAt": int(time.time() * 1000)}

    if method == "Mod.addCustomEvent":
        name = _required_string(params, "name")
        return [
            {"method": "Runtime.addBinding", "params": {"name": binding_name_for(name)}},
            {
                "method": "Runtime.evaluate",
                "params": _wrap_cdpmod_add_custom_event(params),
                "unwrap": "evaluate",
            },
        ]
    if method == "Mod.evaluate":
        runtime_params = _wrap_cdpmod_evaluate(params, session_id)
    elif method == "Mod.addCustomCommand":
        runtime_params = _wrap_cdpmod_add_custom_command(params)
    elif method == "Mod.addMiddleware":
        runtime_params = _wrap_cdpmod_add_middleware(params)
    else:
        runtime_params = _wrap_custom_command(method, params, _optional_string(params, "cdpSessionId") or session_id)
    return [{"method": "Runtime.evaluate", "params": runtime_params, "unwrap": "evaluate"}]


def wrap_command_if_needed(
    method: str,
    params: ProtocolParams | None = None,
    *,
    routes: CDPModRoutes | None = None,
    cdp_session_id: str | None = None,
) -> TranslatedCommand:
    params = params or {}
    route = route_for(method, routes or DEFAULT_CLIENT_ROUTES)
    if route == "direct_cdp":
        return {"route": route, "target": "direct_cdp", "steps": [{"method": method, "params": params}]}
    if route == "service_worker":
        if cdp_session_id is None:
            raise RuntimeError(f"service_worker route requires a CDP session id for {method}")
        return {
            "route": route,
            "target": "service_worker",
            "steps": _wrap_service_worker_command(method, params, cdp_session_id),
        }
    raise RuntimeError(f"Unsupported client route '{route}' for {method}")


def _unwrap_evaluate_response(result: ProtocolResult) -> JsonValue:
    if result.get("exceptionDetails"):
        ex = _object_or_empty(result.get("exceptionDetails"))
        exception = _object_or_empty(ex.get("exception"))
        description = exception.get("description")
        text = ex.get("text")
        msg = (
            description
            if isinstance(description, str)
            else text
            if isinstance(text, str)
            else "Runtime.evaluate failed"
        )
        raise RuntimeError(msg)
    inner = _object_or_empty(result.get("result"))
    return inner.get("value")


def unwrap_response_if_needed(result: ProtocolResult, unwrap: str | None = None) -> JsonValue:
    return _unwrap_evaluate_response(result) if unwrap == "evaluate" else (result or {})


def unwrap_event_if_needed(
    method: str,
    params: ProtocolParams,
    session_id: str | None = None,
    our_session_id: str | None = None,
) -> UnwrappedCDPModEvent | None:
    if method != "Runtime.bindingCalled":
        return None
    binding_name = params.get("name")
    if not isinstance(binding_name, str):
        return None
    event = event_name_for(binding_name)
    if event is None:
        return None
    raw_payload = params.get("payload")
    if not isinstance(raw_payload, str):
        return None
    try:
        parsed: object = json.loads(raw_payload)
    except json.JSONDecodeError:
        return None
    if not isinstance(parsed, dict):
        return None
    payload = cast(ProtocolPayload, parsed)
    if our_session_id is not None and payload.get("cdpSessionId") and payload["cdpSessionId"] != our_session_id:
        return None
    data_value = payload["data"] if "data" in payload else payload
    data: ProtocolPayload = data_value if isinstance(data_value, dict) else {"value": data_value}
    unwrapped: UnwrappedCDPModEvent = {"event": event, "data": data, "sessionId": session_id}
    return unwrapped
