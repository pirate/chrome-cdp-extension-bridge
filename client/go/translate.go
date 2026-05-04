package modcdp

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

const bindingPrefix = "__ModCDP_"

func DefaultClientRoutes() map[string]string {
	return map[string]string{
		"Mod.*":    "service_worker",
		"Custom.*": "service_worker",
		"*.*":      "service_worker",
	}
}

func bindingNameFor(eventName string) string {
	return bindingPrefix + strings.ReplaceAll(eventName, ".", "_")
}

func eventNameFor(bindingName string) string {
	if !strings.HasPrefix(bindingName, bindingPrefix) {
		return ""
	}
	return strings.ReplaceAll(bindingName[len(bindingPrefix):], "_", ".")
}

func routeFor(method string, routes map[string]string) string {
	if route, ok := routes[method]; ok {
		return route
	}
	bestPrefixLen := -1
	bestRoute := ""
	for pattern, route := range routes {
		if pattern == "*.*" || !strings.HasSuffix(pattern, ".*") {
			continue
		}
		prefix := pattern[:len(pattern)-1]
		if strings.HasPrefix(method, prefix) && len(prefix) > bestPrefixLen {
			bestPrefixLen = len(prefix)
			bestRoute = route
		}
	}
	if bestPrefixLen >= 0 {
		return bestRoute
	}
	if route, ok := routes["*.*"]; ok {
		return route
	}
	return "direct_cdp"
}

type rawStep struct {
	Method string
	Params map[string]any
	Unwrap string
}

type rawCommand struct {
	Route  string
	Target string
	Steps  []rawStep
}

func evalParams(expression string) map[string]any {
	return map[string]any{
		"expression":                  expression,
		"awaitPromise":                true,
		"returnByValue":               true,
		"allowUnsafeEvalBlockedByCSP": true,
	}
}

func wrapModCDPEvaluate(params map[string]any, sessionID string) map[string]any {
	expr, _ := params["expression"].(string)
	userParams := params["params"]
	if userParams == nil {
		userParams = map[string]any{}
	}
	cdpSessionID, _ := params["cdpSessionId"].(string)
	if cdpSessionID == "" {
		cdpSessionID = sessionID
	}
	up, _ := json.Marshal(userParams)
	sid, _ := json.Marshal(cdpSessionID)
	return evalParams(fmt.Sprintf(
		`(async () => { const params = %s; const cdp = globalThis.ModCDP.attachToSession(%s); const ModCDP = globalThis.ModCDP; const chrome = globalThis.chrome; const value = (%s); return typeof value === 'function' ? await value(params) : value; })()`,
		string(up), string(sid), expr,
	))
}

func wrapModCDPAddCustomCommand(params map[string]any) map[string]any {
	name, _ := json.Marshal(params["name"])
	expr, _ := params["expression"].(string)
	exprJSON, _ := json.Marshal(expr)
	pSchema, _ := json.Marshal(params["paramsSchema"])
	rSchema, _ := json.Marshal(params["resultSchema"])
	return evalParams(fmt.Sprintf(
		`(() => { return globalThis.ModCDP.addCustomCommand({ name: %s, paramsSchema: %s, resultSchema: %s, expression: %s, handler: async (params, cdpSessionId, method) => { const cdp = globalThis.ModCDP.attachToSession(cdpSessionId); const ModCDP = globalThis.ModCDP; const chrome = globalThis.chrome; const handler = (%s); return await handler(params || {}, method); }, }); })()`,
		string(name), string(pSchema), string(rSchema), string(exprJSON), expr,
	))
}

func wrapModCDPAddCustomEvent(params map[string]any) map[string]any {
	rawName, _ := params["name"].(string)
	name, _ := json.Marshal(rawName)
	bn, _ := json.Marshal(bindingNameFor(rawName))
	pSchema, _ := json.Marshal(params["eventSchema"])
	return evalParams(fmt.Sprintf(
		`globalThis.ModCDP.addCustomEvent({ name: %s, bindingName: %s, eventSchema: %s })`,
		string(name), string(bn), string(pSchema),
	))
}

func wrapModCDPAddMiddleware(params map[string]any) map[string]any {
	name := params["name"]
	if name == nil {
		name = "*"
	}
	rawExpr, _ := params["expression"].(string)
	nameJSON, _ := json.Marshal(name)
	phaseJSON, _ := json.Marshal(params["phase"])
	exprJSON, _ := json.Marshal(rawExpr)
	return evalParams(fmt.Sprintf(
		`(() => { return globalThis.ModCDP.addMiddleware({ name: %s, phase: %s, expression: %s, handler: async (payload, next, context = {}) => { const cdp = globalThis.ModCDP.attachToSession(context.cdpSessionId ?? null); const ModCDP = globalThis.ModCDP; const chrome = globalThis.chrome; const middleware = (%s); return await middleware(payload, next, context); }, }); })()`,
		string(nameJSON), string(phaseJSON), string(exprJSON), rawExpr,
	))
}

func wrapCustomCommand(method string, params map[string]any, sessionID string) map[string]any {
	m, _ := json.Marshal(method)
	p, _ := json.Marshal(params)
	sid, _ := json.Marshal(sessionID)
	return evalParams(fmt.Sprintf(`globalThis.ModCDP.handleCommand(%s, %s, %s)`, string(m), string(p), string(sid)))
}

func wrapServiceWorkerCommand(method string, params map[string]any, sessionID string) []rawStep {
	if params == nil {
		params = map[string]any{}
	}
	if method == "Mod.ping" {
		if _, ok := params["sentAt"]; !ok {
			next := map[string]any{}
			for key, value := range params {
				next[key] = value
			}
			next["sentAt"] = time.Now().UnixMilli()
			params = next
		}
	}

	if method == "Mod.addCustomEvent" {
		name, _ := params["name"].(string)
		return []rawStep{
			{Method: "Runtime.addBinding", Params: map[string]any{"name": bindingNameFor(name)}},
			{Method: "Runtime.evaluate", Params: wrapModCDPAddCustomEvent(params), Unwrap: "evaluate"},
		}
	}
	runtimeParams := map[string]any{}
	switch method {
	case "Mod.evaluate":
		runtimeParams = wrapModCDPEvaluate(params, sessionID)
	case "Mod.addCustomCommand":
		runtimeParams = wrapModCDPAddCustomCommand(params)
	case "Mod.addMiddleware":
		runtimeParams = wrapModCDPAddMiddleware(params)
	default:
		cdpSessionID, _ := params["cdpSessionId"].(string)
		if cdpSessionID == "" {
			cdpSessionID = sessionID
		}
		runtimeParams = wrapCustomCommand(method, params, cdpSessionID)
	}
	return []rawStep{{Method: "Runtime.evaluate", Params: runtimeParams, Unwrap: "evaluate"}}
}

func wrapCommandIfNeeded(method string, params map[string]any, routes map[string]string, sessionID string) (rawCommand, error) {
	route := routeFor(method, routes)
	if route == "direct_cdp" {
		return rawCommand{Route: route, Target: "direct_cdp", Steps: []rawStep{{Method: method, Params: params}}}, nil
	}
	if route == "service_worker" {
		return rawCommand{Route: route, Target: "service_worker", Steps: wrapServiceWorkerCommand(method, params, sessionID)}, nil
	}
	return rawCommand{}, fmt.Errorf("unsupported client route %q for %s", route, method)
}

func unwrapResponseIfNeeded(result map[string]any, unwrap string) (any, error) {
	if unwrap != "evaluate" {
		return result, nil
	}
	if ex, ok := result["exceptionDetails"].(map[string]any); ok {
		msg := ""
		if e, ok := ex["exception"].(map[string]any); ok {
			if d, ok := e["description"].(string); ok {
				msg = d
			}
		}
		if msg == "" {
			if t, ok := ex["text"].(string); ok {
				msg = t
			}
		}
		if msg == "" {
			msg = "Runtime.evaluate failed"
		}
		return nil, fmt.Errorf("%s", msg)
	}
	inner, _ := result["result"].(map[string]any)
	return inner["value"], nil
}

func unwrapEventIfNeeded(method string, params map[string]any, sessionID string, ourSessionID string) (string, any, bool) {
	if method != "Runtime.bindingCalled" {
		return "", nil, false
	}
	name, _ := params["name"].(string)
	event := eventNameFor(name)
	if event == "" {
		return "", nil, false
	}
	payloadStr, _ := params["payload"].(string)
	var payload map[string]any
	if err := json.Unmarshal([]byte(payloadStr), &payload); err != nil || payload == nil {
		payload = map[string]any{}
	}
	if sid, ok := payload["cdpSessionId"].(string); ok && sid != "" && ourSessionID != "" && sid != ourSessionID {
		return "", nil, false
	}
	if data, ok := payload["data"]; ok {
		return event, data, true
	}
	return event, payload, true
}
