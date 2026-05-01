package main

import (
	"encoding/json"
	"fmt"
	"strings"
)

const bindingPrefix = "__MagicCDP_"

func DefaultClientRoutes() map[string]string {
	return map[string]string{
		"Magic.*":  "service_worker",
		"Custom.*": "service_worker",
		"*.*":      "direct_cdp",
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

func wrapMagicEvaluate(params map[string]any, sessionID string) map[string]any {
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
		`(async () => { const params = %s; const cdp = globalThis.MagicCDP.attachToSession(%s); const MagicCDP = globalThis.MagicCDP; const chrome = globalThis.chrome; const value = (%s); return typeof value === 'function' ? await value(params) : value; })()`,
		string(up), string(sid), expr,
	))
}

func wrapMagicAddCustomCommand(params map[string]any) map[string]any {
	name, _ := json.Marshal(params["name"])
	expr, _ := params["expression"].(string)
	exprJSON, _ := json.Marshal(expr)
	pSchema, _ := json.Marshal(params["paramsSchema"])
	rSchema, _ := json.Marshal(params["resultSchema"])
	return evalParams(fmt.Sprintf(
		`(() => { return globalThis.MagicCDP.addCustomCommand({ name: %s, paramsSchema: %s, resultSchema: %s, expression: %s, handler: async (params, meta) => { const cdp = globalThis.MagicCDP.attachToSession(meta.cdpSessionId); const MagicCDP = globalThis.MagicCDP; const chrome = globalThis.chrome; const handler = (%s); return await handler(params || {}); }, }); })()`,
		string(name), string(pSchema), string(rSchema), string(exprJSON), expr,
	))
}

func wrapMagicAddCustomEvent(params map[string]any) map[string]any {
	rawName, _ := params["name"].(string)
	name, _ := json.Marshal(rawName)
	bn, _ := json.Marshal(bindingNameFor(rawName))
	pSchema, _ := json.Marshal(params["payloadSchema"])
	return evalParams(fmt.Sprintf(
		`globalThis.MagicCDP.addCustomEvent({ name: %s, bindingName: %s, payloadSchema: %s })`,
		string(name), string(bn), string(pSchema),
	))
}

func wrapCustomCommand(method string, params map[string]any, sessionID string) map[string]any {
	m, _ := json.Marshal(method)
	p, _ := json.Marshal(params)
	meta, _ := json.Marshal(map[string]any{"cdpSessionId": sessionID})
	return evalParams(fmt.Sprintf(`globalThis.MagicCDP.handleCommand(%s, %s, %s)`, string(m), string(p), string(meta)))
}

func wrapServiceWorkerCommand(method string, params map[string]any, sessionID string) []rawStep {
	if method == "Magic.addCustomEvent" {
		name, _ := params["name"].(string)
		return []rawStep{
			{Method: "Runtime.addBinding", Params: map[string]any{"name": bindingNameFor(name)}},
			{Method: "Runtime.evaluate", Params: wrapMagicAddCustomEvent(params), Unwrap: "evaluate"},
		}
	}
	runtimeParams := map[string]any{}
	switch method {
	case "Magic.evaluate":
		runtimeParams = wrapMagicEvaluate(params, sessionID)
	case "Magic.addCustomCommand":
		runtimeParams = wrapMagicAddCustomCommand(params)
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
