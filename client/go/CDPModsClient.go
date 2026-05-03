// CDPModsClient (Go): importable, no CLI, no demo code.
//
// Field/option names mirror the JS / Python ports:
//
//	CDPURL          upstream CDP URL.
//	ExtensionPath   extension directory.
//	Routes          client-side routing map.
//	Server          { LoopbackCDPURL?, Routes? } passed to CDPModsServer.configure.
//
// Public methods: Connect, Send(method, params), On(event, handler), Close.
// Synchronous; one background goroutine reads frames off the WS.
//
// Route and CDPMods wire translation lives in translate.go. This file owns
// websocket transport, request bookkeeping, extension discovery, and events.
//
// Transport: gobwas/ws is intentionally low-level. We hold the underlying
// net.Conn ourselves and use wsutil.ReadServerText / WriteClientText to push
// raw JSON []byte over the websocket -- no message types, no schema, no
// dependency on chromedp/cdproto's static method enumeration.
package cdpmods

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/gobwas/ws"
	"github.com/gobwas/ws/wsutil"
)

var (
	extIDFromURL = regexp.MustCompile(`^chrome-extension://([a-z]+)/`)
)

const cdpmodsReadyExpression = `Boolean(globalThis.CDPMods?.__CDPModsServerVersion === 1 && globalThis.CDPMods?.handleCommand && globalThis.CDPMods?.addCustomEvent)`

func websocketURLFor(endpoint string) (string, error) {
	if strings.HasPrefix(endpoint, "ws://") || strings.HasPrefix(endpoint, "wss://") {
		return endpoint, nil
	}
	resp, err := http.Get(endpoint + "/json/version")
	if err != nil {
		return "", fmt.Errorf("GET /json/version: %w", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	var version map[string]any
	if err := json.Unmarshal(body, &version); err != nil {
		return "", fmt.Errorf("parse /json/version: %w", err)
	}
	wsURL, _ := version["webSocketDebuggerUrl"].(string)
	if wsURL == "" {
		return "", fmt.Errorf("HTTP discovery for %s returned no webSocketDebuggerUrl", endpoint)
	}
	return wsURL, nil
}

// --- public types --------------------------------------------------------

type ServerConfig struct {
	LoopbackCDPURL string            `json:"loopback_cdp_url,omitempty"`
	Routes         map[string]string `json:"routes,omitempty"`
}

type CustomEvent struct {
	Name        string         `json:"name"`
	EventSchema map[string]any `json:"eventSchema,omitempty"`
}

type CustomCommand struct {
	Name         string         `json:"name"`
	Expression   string         `json:"expression"`
	ParamsSchema map[string]any `json:"paramsSchema,omitempty"`
	ResultSchema map[string]any `json:"resultSchema,omitempty"`
}

type CustomMiddleware struct {
	Name       string `json:"name,omitempty"`
	Phase      string `json:"phase"`
	Expression string `json:"expression"`
}

type Options struct {
	CDPURL            string
	ExtensionPath     string
	Routes            map[string]string
	Server            *ServerConfig
	CustomCommands    []CustomCommand
	CustomEvents      []CustomEvent
	CustomMiddlewares []CustomMiddleware
}

type Handler func(data any)
type CDPHandler func(event CDPEvent)

type CDPEvent struct {
	Method       string
	Params       map[string]any
	CDPSessionID string
	TargetID     string
}

type CDPModsClient struct {
	opts              Options
	CDPURL            string
	conn              net.Conn
	writeMu           sync.Mutex
	ctx               context.Context
	cancel            context.CancelFunc
	mu                sync.Mutex
	nextID            int64
	pending           map[int64]chan map[string]any
	handlers          map[string][]Handler
	handlersMu        sync.Mutex
	cdpHandlers       map[string][]CDPHandler
	cdpHandlersMu     sync.Mutex
	ExtensionID       string
	ExtTargetID       string
	ExtSessionID      string
	Latency           map[string]any
	ConnectTiming     map[string]any
	LastCommandTiming map[string]any
	LastRawTiming     map[string]any
}

func New(opts Options) *CDPModsClient {
	if opts.Routes == nil {
		opts.Routes = DefaultClientRoutes()
	} else {
		merged := DefaultClientRoutes()
		for k, v := range opts.Routes {
			merged[k] = v
		}
		opts.Routes = merged
	}
	if opts.Server == nil {
		opts.Server = &ServerConfig{}
	}
	return &CDPModsClient{
		opts:        opts,
		pending:     map[int64]chan map[string]any{},
		handlers:    map[string][]Handler{},
		cdpHandlers: map[string][]CDPHandler{},
	}
}

func (c *CDPModsClient) Connect() error {
	connectStartedAt := time.Now().UnixMilli()
	inputCDPURL := c.opts.CDPURL
	wsURL, err := websocketURLFor(c.opts.CDPURL)
	if err != nil {
		return err
	}
	c.opts.CDPURL = wsURL
	c.CDPURL = wsURL
	if c.opts.Server != nil && c.opts.Server.LoopbackCDPURL == "" {
		c.opts.Server.LoopbackCDPURL = wsURL
	} else if c.opts.Server != nil && (c.opts.Server.LoopbackCDPURL == inputCDPURL || c.opts.Server.LoopbackCDPURL == wsURL) {
		c.opts.Server.LoopbackCDPURL = wsURL
	}

	c.ctx, c.cancel = context.WithCancel(context.Background())
	conn, _, _, err := ws.Dial(c.ctx, wsURL)
	if err != nil {
		return fmt.Errorf("websocket dial: %w", err)
	}
	c.conn = conn
	go c.reader()
	if _, err := c.sendFrame("Target.setAutoAttach", map[string]any{
		"autoAttach":             true,
		"waitForDebuggerOnStart": false,
		"flatten":                true,
	}, ""); err != nil {
		c.Close()
		return err
	}
	if _, err := c.sendFrame("Target.setDiscoverTargets", map[string]any{"discover": true}, ""); err != nil {
		c.Close()
		return err
	}

	// once the reader goroutine is running, any further error must call Close
	// to tear it down; otherwise the goroutine + ws connection leak.
	ext, err := c.ensureExtension()
	if err != nil {
		c.Close()
		return err
	}
	c.ExtensionID = ext["extension_id"].(string)
	c.ExtTargetID = ext["target_id"].(string)
	c.ExtSessionID = ext["session_id"].(string)
	if _, err := c.sendFrame("Runtime.enable", map[string]any{}, c.ExtSessionID); err != nil {
		c.Close()
		return err
	}
	if _, err := c.sendFrame("Runtime.addBinding", map[string]any{"name": bindingNameFor("Mods.pong")}, c.ExtSessionID); err != nil {
		c.Close()
		return err
	}
	for _, event := range c.opts.CustomEvents {
		if event.Name == "" {
			continue
		}
		if _, err := c.sendFrame("Runtime.addBinding", map[string]any{"name": bindingNameFor(event.Name)}, c.ExtSessionID); err != nil {
			c.Close()
			return err
		}
	}

	if c.opts.Server != nil {
		customCommands := make([]map[string]any, 0, len(c.opts.CustomCommands))
		for _, command := range c.opts.CustomCommands {
			if command.Expression == "" {
				continue
			}
			customCommands = append(customCommands, map[string]any{
				"name":         command.Name,
				"expression":   command.Expression,
				"paramsSchema": command.ParamsSchema,
				"resultSchema": command.ResultSchema,
			})
		}
		customEvents := make([]map[string]any, 0, len(c.opts.CustomEvents))
		for _, event := range c.opts.CustomEvents {
			customEvents = append(customEvents, map[string]any{
				"name":        event.Name,
				"eventSchema": event.EventSchema,
			})
		}
		customMiddlewares := make([]map[string]any, 0, len(c.opts.CustomMiddlewares))
		for _, middleware := range c.opts.CustomMiddlewares {
			item := map[string]any{
				"phase":      middleware.Phase,
				"expression": middleware.Expression,
			}
			if middleware.Name != "" {
				item["name"] = middleware.Name
			}
			customMiddlewares = append(customMiddlewares, item)
		}
		command, err := wrapCommandIfNeeded("Mods.configure", map[string]any{
			"loopback_cdp_url":   c.opts.Server.LoopbackCDPURL,
			"routes":             c.opts.Server.Routes,
			"custom_commands":    customCommands,
			"custom_events":      customEvents,
			"custom_middlewares": customMiddlewares,
		}, c.opts.Routes, c.ExtSessionID)
		if err != nil {
			c.Close()
			return fmt.Errorf("Mods.configure: %w", err)
		}
		if _, err := c.sendRaw(command); err != nil {
			c.Close()
			return fmt.Errorf("Mods.configure: %w", err)
		}
	}
	if err := c.measurePingLatency(); err != nil {
		c.Close()
		return err
	}
	connectedAt := time.Now().UnixMilli()
	c.ConnectTiming = map[string]any{
		"started_at":   connectStartedAt,
		"connected_at": connectedAt,
		"duration_ms":  connectedAt - connectStartedAt,
	}
	return nil
}

func (c *CDPModsClient) Send(method string, params map[string]any) (any, error) {
	startedAt := time.Now().UnixMilli()
	if params == nil {
		params = map[string]any{}
	}
	command, err := wrapCommandIfNeeded(method, params, c.opts.Routes, c.ExtSessionID)
	if err != nil {
		return nil, err
	}
	result, err := c.sendRaw(command)
	completedAt := time.Now().UnixMilli()
	c.LastCommandTiming = map[string]any{
		"method":       method,
		"target":       command.Target,
		"started_at":   startedAt,
		"completed_at": completedAt,
		"duration_ms":  completedAt - startedAt,
	}
	return result, err
}

func (c *CDPModsClient) RawSend(method string, params map[string]any) (map[string]any, error) {
	startedAt := time.Now().UnixMilli()
	result, err := c.sendFrame(method, params, "")
	completedAt := time.Now().UnixMilli()
	c.LastRawTiming = map[string]any{
		"method":       method,
		"started_at":   startedAt,
		"completed_at": completedAt,
		"duration_ms":  completedAt - startedAt,
	}
	return result, err
}

func (c *CDPModsClient) On(event string, handler Handler) {
	c.handlersMu.Lock()
	defer c.handlersMu.Unlock()
	c.handlers[event] = append(c.handlers[event], handler)
}

func (c *CDPModsClient) OnCDP(event string, handler CDPHandler) {
	c.cdpHandlersMu.Lock()
	defer c.cdpHandlersMu.Unlock()
	c.cdpHandlers[event] = append(c.cdpHandlers[event], handler)
}

func (c *CDPModsClient) Close() {
	if c.ExtSessionID != "" {
		_, _ = c.sendFrame("Target.detachFromTarget", map[string]any{"sessionId": c.ExtSessionID}, "")
	}
	if c.cancel != nil {
		c.cancel()
	}
	if c.conn != nil {
		_ = c.conn.Close()
	}
}

// --- internals -----------------------------------------------------------

func (c *CDPModsClient) sendRaw(command rawCommand) (any, error) {
	if command.Target == "direct_cdp" {
		step := command.Steps[0]
		return c.sendFrame(step.Method, step.Params, "")
	}
	if command.Target != "service_worker" {
		return nil, fmt.Errorf("unsupported command target %q", command.Target)
	}

	var result map[string]any
	unwrap := ""
	for _, step := range command.Steps {
		r, err := c.sendFrame(step.Method, step.Params, c.ExtSessionID)
		if err != nil {
			return nil, err
		}
		result = r
		unwrap = step.Unwrap
	}
	return unwrapResponseIfNeeded(result, unwrap)
}

func (c *CDPModsClient) measurePingLatency() error {
	sentAt := time.Now().UnixMilli()
	ch := make(chan any, 1)
	c.On("Mods.pong", func(data any) {
		select {
		case ch <- data:
		default:
		}
	})
	if _, err := c.Send("Mods.ping", map[string]any{"sentAt": sentAt}); err != nil {
		return err
	}
	select {
	case payload := <-ch:
		returnedAt := time.Now().UnixMilli()
		latency := map[string]any{
			"sentAt":          sentAt,
			"receivedAt":      nil,
			"returnedAt":      returnedAt,
			"roundTripMs":     returnedAt - sentAt,
			"serviceWorkerMs": nil,
			"returnPathMs":    nil,
		}
		if data, ok := payload.(map[string]any); ok {
			if receivedAt, ok := numberAsInt64(data["receivedAt"]); ok {
				latency["receivedAt"] = receivedAt
				latency["serviceWorkerMs"] = receivedAt - sentAt
				latency["returnPathMs"] = returnedAt - receivedAt
			}
		}
		c.Latency = latency
		return nil
	case <-time.After(10 * time.Second):
		return fmt.Errorf("Mods.pong timed out")
	}
}

func numberAsInt64(value any) (int64, bool) {
	switch v := value.(type) {
	case int64:
		return v, true
	case int:
		return int64(v), true
	case float64:
		return int64(v), true
	default:
		return 0, false
	}
}

func (c *CDPModsClient) sendFrame(method string, params map[string]any, sessionID string) (map[string]any, error) {
	return c.sendFrameTimeout(method, params, sessionID, 10*time.Second)
}

func (c *CDPModsClient) sendFrameTimeout(method string, params map[string]any, sessionID string, timeout time.Duration) (map[string]any, error) {
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
	c.writeMu.Lock()
	err := wsutil.WriteClientText(c.conn, body)
	c.writeMu.Unlock()
	if err != nil {
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
		return nil, err
	}
	select {
	case <-time.After(timeout):
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
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

func (c *CDPModsClient) cdpmodsServerBootstrapExpression() (string, error) {
	body, err := os.ReadFile(filepath.Join(c.opts.ExtensionPath, "CDPModsServer.js"))
	if err != nil {
		return "", err
	}
	source := string(body)
	start := strings.Index(source, "export function installCDPModsServer")
	end := strings.Index(source, "export const CDPModsServer")
	if start < 0 || end < start {
		return "", fmt.Errorf("could not find installCDPModsServer in CDPModsServer.js")
	}
	installer := strings.Replace(source[start:end], "export function", "function", 1)
	return fmt.Sprintf(`(() => {
%s
const CDPMods = installCDPModsServer(globalThis);
return {
  ok: Boolean(CDPMods?.__CDPModsServerVersion === 1 && CDPMods?.handleCommand && CDPMods?.addCustomEvent),
  extension_id: globalThis.chrome?.runtime?.id ?? null,
  has_tabs: Boolean(globalThis.chrome?.tabs?.query),
  has_debugger: Boolean(globalThis.chrome?.debugger?.sendCommand),
};
})()`, installer), nil
}

func (c *CDPModsClient) reader() {
	for {
		data, err := wsutil.ReadServerText(c.conn)
		if err != nil {
			c.mu.Lock()
			pending := c.pending
			c.pending = map[int64]chan map[string]any{}
			c.mu.Unlock()
			for _, ch := range pending {
				ch <- map[string]any{"error": map[string]any{"message": fmt.Sprintf("connection closed: %v", err)}}
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
		// IMPORTANT: handlers run on their own goroutine, not on the reader.
		// A handler that calls c.Send() would otherwise deadlock waiting on
		// a response that this same goroutine is supposed to deliver.
		if sessionID == c.ExtSessionID {
			params, _ := msg["params"].(map[string]any)
			if event, data, ok := unwrapEventIfNeeded(method, params, sessionID, c.ExtSessionID); ok {
				c.handlersMu.Lock()
				hs := append([]Handler(nil), c.handlers[event]...)
				c.handlersMu.Unlock()
				for _, h := range hs {
					go h(data)
				}
			}
			continue
		}
		if method != "" {
			params, _ := msg["params"].(map[string]any)
			c.handlersMu.Lock()
			hs := append([]Handler(nil), c.handlers[method]...)
			c.handlersMu.Unlock()
			for _, h := range hs {
				go h(params)
			}
			cdpEvent := CDPEvent{
				Method:       method,
				Params:       params,
				CDPSessionID: sessionID,
				TargetID:     targetIDFromEventParams(params),
			}
			c.cdpHandlersMu.Lock()
			cdpHandlers := append([]CDPHandler(nil), c.cdpHandlers["*"]...)
			cdpHandlers = append(cdpHandlers, c.cdpHandlers[method]...)
			c.cdpHandlersMu.Unlock()
			for _, h := range cdpHandlers {
				go h(cdpEvent)
			}
		}
	}
}

func targetIDFromEventParams(params map[string]any) string {
	if targetID, _ := params["targetId"].(string); targetID != "" {
		return targetID
	}
	if targetInfo, _ := params["targetInfo"].(map[string]any); targetInfo != nil {
		targetID, _ := targetInfo["targetId"].(string)
		return targetID
	}
	return ""
}

func (c *CDPModsClient) ensureExtension() (map[string]any, error) {
	type attached struct{ TargetID, URL, SessionID string }
	var seen []attached

	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline.Add(time.Millisecond)) {
		targetsResp, err := c.sendFrame("Target.getTargets", map[string]any{}, "")
		if err != nil {
			return nil, err
		}
		targetsRaw, _ := targetsResp["targetInfos"].([]any)
		for _, t := range targetsRaw {
			ti, _ := t.(map[string]any)
			ttype, _ := ti["type"].(string)
			turl, _ := ti["url"].(string)
			tid, _ := ti["targetId"].(string)
			if ttype != "service_worker" || !strings.HasPrefix(turl, "chrome-extension://") {
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
			a, err := c.sendFrameTimeout("Target.attachToTarget", map[string]any{"targetId": tid, "flatten": true}, "", 2*time.Second)
			if err != nil {
				continue
			}
			sid, _ := a["sessionId"].(string)
			seen = append(seen, attached{TargetID: tid, URL: turl, SessionID: sid})
		}
		for _, a := range seen {
			probe, err := c.sendFrameTimeout("Runtime.evaluate", map[string]any{
				"expression":    cdpmodsReadyExpression,
				"returnByValue": true,
			}, a.SessionID, 2*time.Second)
			if err != nil {
				continue
			}
			result, _ := probe["result"].(map[string]any)
			if v, _ := result["value"].(bool); v {
				for _, o := range seen {
					if o.SessionID != a.SessionID {
						_, _ = c.sendFrame("Target.detachFromTarget", map[string]any{"sessionId": o.SessionID}, "")
					}
				}
				m := extIDFromURL.FindStringSubmatch(a.URL)
				return map[string]any{
					"source": "discovered", "extension_id": m[1],
					"target_id": a.TargetID, "url": a.URL, "session_id": a.SessionID,
				}, nil
			}
		}
		if !time.Now().Before(deadline) {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	for _, a := range seen {
		_, _ = c.sendFrame("Target.detachFromTarget", map[string]any{"sessionId": a.SessionID}, "")
	}

	loadResp, err := c.sendFrame("Extensions.loadUnpacked", map[string]any{"path": c.opts.ExtensionPath}, "")
	if err != nil {
		if strings.Contains(err.Error(), "Method not available") || strings.Contains(err.Error(), "wasn't found") {
			return c.borrowExtensionWorker(err.Error())
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

	swURLPrefix := fmt.Sprintf("chrome-extension://%s/", extID)
	deadline = time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		targetsResp, err := c.sendFrame("Target.getTargets", map[string]any{}, "")
		if err != nil {
			return nil, err
		}
		targetsRaw, _ := targetsResp["targetInfos"].([]any)
		for _, t := range targetsRaw {
			ti, _ := t.(map[string]any)
			turl, _ := ti["url"].(string)
			if ti["type"] == "service_worker" && strings.HasPrefix(turl, swURLPrefix) {
				tid, _ := ti["targetId"].(string)
				a, err := c.sendFrame("Target.attachToTarget", map[string]any{"targetId": tid, "flatten": true}, "")
				if err != nil {
					return nil, err
				}
				sid, _ := a["sessionId"].(string)
				probe, err := c.sendFrame("Runtime.evaluate", map[string]any{
					"expression":    cdpmodsReadyExpression,
					"returnByValue": true,
				}, sid)
				if err != nil {
					_, _ = c.sendFrame("Target.detachFromTarget", map[string]any{"sessionId": sid}, "")
					continue
				}
				result, _ := probe["result"].(map[string]any)
				if v, _ := result["value"].(bool); v {
					return map[string]any{
						"source": "injected", "extension_id": extID,
						"target_id": tid, "url": turl, "session_id": sid,
					}, nil
				}
				_, _ = c.sendFrame("Target.detachFromTarget", map[string]any{"sessionId": sid}, "")
			}
		}
		time.Sleep(100 * time.Millisecond)
	}
	return nil, fmt.Errorf("Extensions.loadUnpacked installed %s but its SW did not appear", extID)
}

func (c *CDPModsClient) borrowExtensionWorker(loadError string) (map[string]any, error) {
	bootstrap, err := c.cdpmodsServerBootstrapExpression()
	if err != nil {
		return nil, err
	}
	targetsResp, err := c.sendFrame("Target.getTargets", map[string]any{}, "")
	if err != nil {
		return nil, err
	}
	targetsRaw, _ := targetsResp["targetInfos"].([]any)
	var borrowed []map[string]any
	for _, t := range targetsRaw {
		ti, _ := t.(map[string]any)
		ttype, _ := ti["type"].(string)
		turl, _ := ti["url"].(string)
		tid, _ := ti["targetId"].(string)
		if ttype != "service_worker" || !strings.HasPrefix(turl, "chrome-extension://") {
			continue
		}
		sessionID := ""
		a, err := c.sendFrameTimeout("Target.attachToTarget", map[string]any{"targetId": tid, "flatten": true}, "", 2*time.Second)
		if err != nil {
			continue
		}
		sessionID, _ = a["sessionId"].(string)
		_, _ = c.sendFrameTimeout("Runtime.enable", map[string]any{}, sessionID, 2*time.Second)
		probe, err := c.sendFrameTimeout("Runtime.evaluate", map[string]any{
			"expression":                  bootstrap,
			"awaitPromise":                true,
			"returnByValue":               true,
			"allowUnsafeEvalBlockedByCSP": true,
		}, sessionID, 3*time.Second)
		if err != nil {
			_, _ = c.sendFrame("Target.detachFromTarget", map[string]any{"sessionId": sessionID}, "")
			continue
		}
		result, _ := probe["result"].(map[string]any)
		value, _ := result["value"].(map[string]any)
		if ok, _ := value["ok"].(bool); !ok {
			_, _ = c.sendFrame("Target.detachFromTarget", map[string]any{"sessionId": sessionID}, "")
			continue
		}
		extensionID, _ := value["extension_id"].(string)
		if extensionID == "" {
			if m := extIDFromURL.FindStringSubmatch(turl); len(m) > 1 {
				extensionID = m[1]
			}
		}
		borrowed = append(borrowed, map[string]any{
			"source":       "borrowed",
			"extension_id": extensionID,
			"target_id":    tid,
			"url":          turl,
			"session_id":   sessionID,
			"has_tabs":     value["has_tabs"],
			"has_debugger": value["has_debugger"],
		})
	}
	sort.SliceStable(borrowed, func(i, j int) bool {
		iDebugger, _ := borrowed[i]["has_debugger"].(bool)
		jDebugger, _ := borrowed[j]["has_debugger"].(bool)
		if iDebugger != jDebugger {
			return iDebugger
		}
		iTabs, _ := borrowed[i]["has_tabs"].(bool)
		jTabs, _ := borrowed[j]["has_tabs"].(bool)
		return iTabs && !jTabs
	})
	if len(borrowed) > 0 {
		for _, other := range borrowed[1:] {
			if sid, _ := other["session_id"].(string); sid != "" {
				_, _ = c.sendFrame("Target.detachFromTarget", map[string]any{"sessionId": sid}, "")
			}
		}
		delete(borrowed[0], "has_tabs")
		delete(borrowed[0], "has_debugger")
		return borrowed[0], nil
	}
	return nil, fmt.Errorf(
		"cannot install or borrow CDPMods in the running browser:\n"+
			"  - no service worker with globalThis.CDPMods found\n"+
			"  - Extensions.loadUnpacked unavailable (%s)\n"+
			"  - no running chrome-extension:// service worker accepted the CDPMods bootstrap",
		loadError,
	)
}
