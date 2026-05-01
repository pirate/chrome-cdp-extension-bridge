// MagicCDPClient (Go): importable, no CLI, no demo code.
//
// Field/option names mirror the JS / Python ports:
//   CDPURL          upstream CDP URL.
//   ExtensionPath   extension directory.
//   Routes          client-side routing map.
//   Server          { LoopbackCDPURL?, Routes? } passed to MagicCDPServer.configure.
//   SessionID       client cdpSessionId tag for event scoping.
//
// Public methods: Connect, Send(method, params), On(event, handler), Close.
// Synchronous; one background goroutine reads frames off the WS.
//
// Wrap/unwrap is inlined to mirror bridge/translate.mjs without an extra
// file. Same wire format as the JS / Python sides.
//
// Package note: Go disallows two packages in one directory, so this file is
// in `package main` alongside demo.go. To use as a library, copy this file
// into your own package and rename `package main` to your package name.

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"
)

const bindingPrefix = "__MagicCDP_"

var (
	swURLRE      = regexp.MustCompile(`^chrome-extension://[a-z]+/service_worker\.js$`)
	extIDFromURL = regexp.MustCompile(`^chrome-extension://([a-z]+)/`)
)

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
	fallback := "direct_cdp"
	for pattern, route := range routes {
		if pattern == "*.*" {
			fallback = route
			continue
		}
		if strings.HasSuffix(pattern, ".*") && strings.HasPrefix(method, pattern[:len(pattern)-1]) {
			return route
		}
		if pattern == method {
			return route
		}
	}
	return fallback
}

// --- wrap helpers (port of bridge/translate.mjs) -------------------------

func evalParams(expression string) map[string]any {
	return map[string]any{
		"expression":                 expression,
		"awaitPromise":               true,
		"returnByValue":              true,
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
		`(async () => { const params = %s; const cdp = globalThis.MagicCDP.attachToSession(%s); const context = { cdp, MagicCDP: globalThis.MagicCDP, chrome: globalThis.chrome }; const value = (%s); return typeof value === 'function' ? await value(params, context) : value; })()`,
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
		`(() => { const handler = (%s); return globalThis.MagicCDP.addCustomCommand({ name: %s, paramsSchema: %s, resultSchema: %s, expression: %s, handler: async (params, meta) => { const cdp = globalThis.MagicCDP.attachToSession(meta.cdpSessionId); return await handler(params || {}, { cdp, MagicCDP: globalThis.MagicCDP, chrome: globalThis.chrome, meta }); }, }); })()`,
		expr, string(name), string(pSchema), string(rSchema), string(exprJSON),
	))
}

func wrapMagicAddCustomEvent(params map[string]any) map[string]any {
	name, _ := json.Marshal(params["name"])
	bn, _ := json.Marshal(bindingNameFor(params["name"].(string)))
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

func unwrapEvaluateResult(result map[string]any) (any, error) {
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

func unwrapBindingCalled(params map[string]any, ourSessionID string) (string, any, bool) {
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

// --- public types --------------------------------------------------------

type ServerConfig struct {
	LoopbackCDPURL string            `json:"loopback_cdp_url,omitempty"`
	Routes         map[string]string `json:"routes,omitempty"`
}

type Options struct {
	CDPURL        string
	ExtensionPath string
	Routes        map[string]string
	Server        *ServerConfig
	SessionID     string
}

type Handler func(data any)

type MagicCDPClient struct {
	opts          Options
	ws            *websocket.Conn
	ctx           context.Context
	cancel        context.CancelFunc
	mu            sync.Mutex
	nextID        int64
	pending       map[int64]chan map[string]any
	handlers      map[string][]Handler
	handlersMu    sync.Mutex
	ExtensionID   string
	ExtTargetID   string
	ExtSessionID  string
}

func New(opts Options) *MagicCDPClient {
	if opts.Routes == nil {
		opts.Routes = DefaultClientRoutes()
	} else {
		merged := DefaultClientRoutes()
		for k, v := range opts.Routes {
			merged[k] = v
		}
		opts.Routes = merged
	}
	if opts.SessionID == "" {
		opts.SessionID = uuid.NewString()
	}
	return &MagicCDPClient{
		opts:     opts,
		pending:  map[int64]chan map[string]any{},
		handlers: map[string][]Handler{},
	}
}

func (c *MagicCDPClient) SessionID() string { return c.opts.SessionID }

func (c *MagicCDPClient) Connect() error {
	resp, err := http.Get(c.opts.CDPURL + "/json/version")
	if err != nil {
		return fmt.Errorf("GET /json/version: %w", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	var version map[string]any
	if err := json.Unmarshal(body, &version); err != nil {
		return fmt.Errorf("parse /json/version: %w", err)
	}
	wsURL, _ := version["webSocketDebuggerUrl"].(string)

	c.ctx, c.cancel = context.WithCancel(context.Background())
	conn, _, err := websocket.Dial(c.ctx, wsURL, nil)
	if err != nil {
		return fmt.Errorf("websocket dial: %w", err)
	}
	conn.SetReadLimit(64 * 1024 * 1024)
	c.ws = conn
	go c.reader()

	ext, err := c.ensureExtension()
	if err != nil {
		return err
	}
	c.ExtensionID = ext["extensionId"].(string)
	c.ExtTargetID = ext["targetId"].(string)
	c.ExtSessionID = ext["sessionId"].(string)
	if _, err := c.sendRaw("Runtime.enable", map[string]any{}, c.ExtSessionID); err != nil {
		return err
	}

	if c.opts.Server != nil {
		serverJSON, _ := json.Marshal(c.opts.Server)
		_, err := c.sendRaw("Runtime.evaluate", map[string]any{
			"expression":                 fmt.Sprintf("globalThis.MagicCDP.configure(%s)", string(serverJSON)),
			"awaitPromise":               true,
			"returnByValue":              true,
			"allowUnsafeEvalBlockedByCSP": true,
		}, c.ExtSessionID)
		if err != nil {
			return fmt.Errorf("Magic.configure: %w", err)
		}
	}
	return nil
}

func (c *MagicCDPClient) Send(method string, params map[string]any) (any, error) {
	if params == nil {
		params = map[string]any{}
	}
	route := routeFor(method, c.opts.Routes)
	switch route {
	case "service_worker":
		switch method {
		case "Magic.evaluate":
			r, err := c.sendRaw("Runtime.evaluate", wrapMagicEvaluate(params, c.opts.SessionID), c.ExtSessionID)
			if err != nil {
				return nil, err
			}
			return unwrapEvaluateResult(r)
		case "Magic.addCustomCommand":
			r, err := c.sendRaw("Runtime.evaluate", wrapMagicAddCustomCommand(params), c.ExtSessionID)
			if err != nil {
				return nil, err
			}
			return unwrapEvaluateResult(r)
		case "Magic.addCustomEvent":
			name, _ := params["name"].(string)
			if _, err := c.sendRaw("Runtime.addBinding", map[string]any{"name": bindingNameFor(name)}, c.ExtSessionID); err != nil {
				return nil, err
			}
			r, err := c.sendRaw("Runtime.evaluate", wrapMagicAddCustomEvent(params), c.ExtSessionID)
			if err != nil {
				return nil, err
			}
			return unwrapEvaluateResult(r)
		default:
			r, err := c.sendRaw("Runtime.evaluate", wrapCustomCommand(method, params, c.opts.SessionID), c.ExtSessionID)
			if err != nil {
				return nil, err
			}
			return unwrapEvaluateResult(r)
		}
	case "direct_cdp":
		return c.sendRaw(method, params, "")
	}
	return nil, fmt.Errorf("unsupported client route %q for %s", route, method)
}

func (c *MagicCDPClient) On(event string, handler Handler) {
	c.handlersMu.Lock()
	defer c.handlersMu.Unlock()
	c.handlers[event] = append(c.handlers[event], handler)
}

func (c *MagicCDPClient) Close() {
	if c.ExtSessionID != "" {
		_, _ = c.sendRaw("Target.detachFromTarget", map[string]any{"sessionId": c.ExtSessionID}, "")
	}
	if c.cancel != nil {
		c.cancel()
	}
	if c.ws != nil {
		_ = c.ws.Close(websocket.StatusNormalClosure, "")
	}
}

// --- internals -----------------------------------------------------------

func (c *MagicCDPClient) sendRaw(method string, params map[string]any, sessionID string) (map[string]any, error) {
	c.mu.Lock()
	c.nextID++
	id := c.nextID
	ch := make(chan map[string]any, 1)
	c.pending[id] = ch
	c.mu.Unlock()

	msg := map[string]any{"id": id, "method": method, "params": params}
	if sessionID != "" {
		msg["sessionId"] = sessionID
	}
	body, _ := json.Marshal(msg)
	if err := c.ws.Write(c.ctx, websocket.MessageText, body); err != nil {
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
		return nil, err
	}
	select {
	case <-time.After(10 * time.Second):
		return nil, fmt.Errorf("%s timed out", method)
	case resp := <-ch:
		if errObj, ok := resp["error"].(map[string]any); ok {
			return nil, fmt.Errorf("%s failed: %v", method, errObj["message"])
		}
		if r, ok := resp["result"].(map[string]any); ok {
			return r, nil
		}
		return map[string]any{}, nil
	}
}

func (c *MagicCDPClient) reader() {
	for {
		_, data, err := c.ws.Read(c.ctx)
		if err != nil {
			c.mu.Lock()
			pending := c.pending
			c.pending = map[int64]chan map[string]any{}
			c.mu.Unlock()
			for _, ch := range pending {
				ch <- map[string]any{"error": map[string]any{"message": "connection closed"}}
			}
			return
		}
		var msg map[string]any
		if err := json.Unmarshal(data, &msg); err != nil {
			continue
		}
		if idF, ok := msg["id"].(float64); ok {
			id := int64(idF)
			c.mu.Lock()
			ch, ok := c.pending[id]
			delete(c.pending, id)
			c.mu.Unlock()
			if ok {
				ch <- msg
			}
			continue
		}
		method, _ := msg["method"].(string)
		sessionID, _ := msg["sessionId"].(string)
		if method == "Runtime.bindingCalled" && sessionID == c.ExtSessionID {
			params, _ := msg["params"].(map[string]any)
			if event, data, ok := unwrapBindingCalled(params, c.opts.SessionID); ok {
				c.handlersMu.Lock()
				hs := append([]Handler(nil), c.handlers[event]...)
				c.handlersMu.Unlock()
				for _, h := range hs {
					h(data)
				}
			}
			continue
		}
		if method != "" {
			c.handlersMu.Lock()
			hs := append([]Handler(nil), c.handlers[method]...)
			c.handlersMu.Unlock()
			params, _ := msg["params"].(map[string]any)
			for _, h := range hs {
				h(params)
			}
		}
	}
}

func (c *MagicCDPClient) ensureExtension() (map[string]any, error) {
	type attached struct{ TargetID, URL, SessionID string }
	var seen []attached

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline.Add(time.Millisecond)) {
		targetsResp, err := c.sendRaw("Target.getTargets", map[string]any{}, "")
		if err != nil {
			return nil, err
		}
		targetsRaw, _ := targetsResp["targetInfos"].([]any)
		for _, t := range targetsRaw {
			ti, _ := t.(map[string]any)
			ttype, _ := ti["type"].(string)
			turl, _ := ti["url"].(string)
			tid, _ := ti["targetId"].(string)
			if ttype != "service_worker" || !swURLRE.MatchString(turl) {
				continue
			}
			already := false
			for _, a := range seen {
				if a.TargetID == tid {
					already = true
					break
				}
			}
			if already {
				continue
			}
			a, err := c.sendRaw("Target.attachToTarget", map[string]any{"targetId": tid, "flatten": true}, "")
			if err != nil {
				continue
			}
			sid, _ := a["sessionId"].(string)
			seen = append(seen, attached{TargetID: tid, URL: turl, SessionID: sid})
		}
		for _, a := range seen {
			probe, err := c.sendRaw("Runtime.evaluate", map[string]any{
				"expression":   "Boolean(globalThis.MagicCDP?.handleCommand && globalThis.MagicCDP?.addCustomEvent)",
				"returnByValue": true,
			}, a.SessionID)
			if err != nil {
				continue
			}
			result, _ := probe["result"].(map[string]any)
			if v, _ := result["value"].(bool); v {
				for _, o := range seen {
					if o.SessionID != a.SessionID {
						_, _ = c.sendRaw("Target.detachFromTarget", map[string]any{"sessionId": o.SessionID}, "")
					}
				}
				m := extIDFromURL.FindStringSubmatch(a.URL)
				return map[string]any{
					"source": "discovered", "extensionId": m[1],
					"targetId": a.TargetID, "url": a.URL, "sessionId": a.SessionID,
				}, nil
			}
		}
		if !time.Now().Before(deadline) {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	for _, a := range seen {
		_, _ = c.sendRaw("Target.detachFromTarget", map[string]any{"sessionId": a.SessionID}, "")
	}

	loadResp, err := c.sendRaw("Extensions.loadUnpacked", map[string]any{"path": c.opts.ExtensionPath}, "")
	if err != nil {
		if strings.Contains(err.Error(), "Method not available") || strings.Contains(err.Error(), "wasn't found") {
			return nil, fmt.Errorf(
				"cannot install MagicCDP extension into the running browser:\n"+
					"  - no service worker with globalThis.MagicCDP found\n"+
					"  - Extensions.loadUnpacked unavailable in this Chrome build\n"+
					"fixes:\n"+
					"  1. relaunch with --load-extension=%s\n"+
					"  2. use Chrome Canary, which exposes Extensions.loadUnpacked over CDP",
				c.opts.ExtensionPath,
			)
		}
		return nil, err
	}
	extID, _ := loadResp["id"].(string)
	if extID == "" {
		extID, _ = loadResp["extensionId"].(string)
	}
	if extID == "" {
		return nil, fmt.Errorf("Extensions.loadUnpacked returned no id")
	}

	swURL := fmt.Sprintf("chrome-extension://%s/service_worker.js", extID)
	deadline = time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		targetsResp, err := c.sendRaw("Target.getTargets", map[string]any{}, "")
		if err != nil {
			return nil, err
		}
		targetsRaw, _ := targetsResp["targetInfos"].([]any)
		for _, t := range targetsRaw {
			ti, _ := t.(map[string]any)
			if ti["type"] == "service_worker" && ti["url"] == swURL {
				tid, _ := ti["targetId"].(string)
				a, err := c.sendRaw("Target.attachToTarget", map[string]any{"targetId": tid, "flatten": true}, "")
				if err != nil {
					return nil, err
				}
				sid, _ := a["sessionId"].(string)
				return map[string]any{
					"source": "injected", "extensionId": extID,
					"targetId": tid, "url": swURL, "sessionId": sid,
				}, nil
			}
		}
		time.Sleep(100 * time.Millisecond)
	}
	return nil, fmt.Errorf("Extensions.loadUnpacked installed %s but its SW did not appear", extID)
}
