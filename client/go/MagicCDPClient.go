// MagicCDPClient (Go): importable, no CLI, no demo code.
//
// Field/option names mirror the JS / Python ports:
//   CDPURL          upstream CDP URL.
//   ExtensionPath   extension directory.
//   Routes          client-side routing map.
//   Server          { LoopbackCDPURL?, Routes? } passed to MagicCDPServer.configure.
//
// Public methods: Connect, Send(method, params), On(event, handler), Close.
// Synchronous; one background goroutine reads frames off the WS.
//
// Route and MagicCDP wire translation lives in translate.go. This file owns
// websocket transport, request bookkeeping, extension discovery, and events.
//
// Transport: gobwas/ws is intentionally low-level. We hold the underlying
// net.Conn ourselves and use wsutil.ReadServerText / WriteClientText to push
// raw JSON []byte over the websocket -- no message types, no schema, no
// dependency on chromedp/cdproto's static method enumeration.
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
	"net"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/gobwas/ws"
	"github.com/gobwas/ws/wsutil"
)

var (
	swURLRE      = regexp.MustCompile(`^chrome-extension://[a-z]+/service_worker\.js$`)
	extIDFromURL = regexp.MustCompile(`^chrome-extension://([a-z]+)/`)
)

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

type Options struct {
	CDPURL        string
	ExtensionPath string
	Routes        map[string]string
	Server        *ServerConfig
}

type Handler func(data any)

type MagicCDPClient struct {
	opts         Options
	conn         net.Conn
	writeMu      sync.Mutex
	ctx          context.Context
	cancel       context.CancelFunc
	mu           sync.Mutex
	nextID       int64
	pending      map[int64]chan map[string]any
	handlers     map[string][]Handler
	handlersMu   sync.Mutex
	ExtensionID  string
	ExtTargetID  string
	ExtSessionID string
	Latency      map[string]any
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
	return &MagicCDPClient{
		opts:     opts,
		pending:  map[int64]chan map[string]any{},
		handlers: map[string][]Handler{},
	}
}

func (c *MagicCDPClient) Connect() error {
	inputCDPURL := c.opts.CDPURL
	wsURL, err := websocketURLFor(c.opts.CDPURL)
	if err != nil {
		return err
	}
	c.opts.CDPURL = wsURL
	if c.opts.Server != nil && (c.opts.Server.LoopbackCDPURL == inputCDPURL || c.opts.Server.LoopbackCDPURL == wsURL) {
		c.opts.Server.LoopbackCDPURL = wsURL
	}

	c.ctx, c.cancel = context.WithCancel(context.Background())
	conn, _, _, err := ws.Dial(c.ctx, wsURL)
	if err != nil {
		return fmt.Errorf("websocket dial: %w", err)
	}
	c.conn = conn
	go c.reader()

	// once the reader goroutine is running, any further error must call Close
	// to tear it down; otherwise the goroutine + ws connection leak.
	ext, err := c.ensureExtension()
	if err != nil {
		c.Close()
		return err
	}
	c.ExtensionID = ext["extensionId"].(string)
	c.ExtTargetID = ext["targetId"].(string)
	c.ExtSessionID = ext["sessionId"].(string)
	if _, err := c.sendFrame("Runtime.enable", map[string]any{}, c.ExtSessionID); err != nil {
		c.Close()
		return err
	}
	if _, err := c.sendFrame("Runtime.addBinding", map[string]any{"name": bindingNameFor("Magic.pong")}, c.ExtSessionID); err != nil {
		c.Close()
		return err
	}

	if c.opts.Server != nil {
		command, err := wrapCommandIfNeeded("Magic.configure", map[string]any{
			"loopback_cdp_url": c.opts.Server.LoopbackCDPURL,
			"routes":           c.opts.Server.Routes,
		}, c.opts.Routes, c.ExtSessionID)
		if err != nil {
			c.Close()
			return fmt.Errorf("Magic.configure: %w", err)
		}
		if _, err := c.sendRaw(command); err != nil {
			c.Close()
			return fmt.Errorf("Magic.configure: %w", err)
		}
	}
	if err := c.measurePingLatency(); err != nil {
		c.Close()
		return err
	}
	return nil
}

func (c *MagicCDPClient) Send(method string, params map[string]any) (any, error) {
	if params == nil {
		params = map[string]any{}
	}
	command, err := wrapCommandIfNeeded(method, params, c.opts.Routes, c.ExtSessionID)
	if err != nil {
		return nil, err
	}
	return c.sendRaw(command)
}

func (c *MagicCDPClient) On(event string, handler Handler) {
	c.handlersMu.Lock()
	defer c.handlersMu.Unlock()
	c.handlers[event] = append(c.handlers[event], handler)
}

func (c *MagicCDPClient) Close() {
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

func (c *MagicCDPClient) sendRaw(command rawCommand) (any, error) {
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

func (c *MagicCDPClient) measurePingLatency() error {
	sentAt := time.Now().UnixMilli()
	ch := make(chan any, 1)
	c.On("Magic.pong", func(data any) {
		select {
		case ch <- data:
		default:
		}
	})
	if _, err := c.Send("Magic.ping", map[string]any{"sentAt": sentAt}); err != nil {
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
		return fmt.Errorf("Magic.pong timed out")
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

func (c *MagicCDPClient) sendFrame(method string, params map[string]any, sessionID string) (map[string]any, error) {
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
	case <-time.After(10 * time.Second):
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

func (c *MagicCDPClient) reader() {
	for {
		data, err := wsutil.ReadServerText(c.conn)
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
			c.handlersMu.Lock()
			hs := append([]Handler(nil), c.handlers[method]...)
			c.handlersMu.Unlock()
			params, _ := msg["params"].(map[string]any)
			for _, h := range hs {
				go h(params)
			}
		}
	}
}

func (c *MagicCDPClient) ensureExtension() (map[string]any, error) {
	type attached struct{ TargetID, URL, SessionID string }
	var seen []attached

	deadline := time.Now().Add(2 * time.Second)
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
			a, err := c.sendFrame("Target.attachToTarget", map[string]any{"targetId": tid, "flatten": true}, "")
			if err != nil {
				continue
			}
			sid, _ := a["sessionId"].(string)
			seen = append(seen, attached{TargetID: tid, URL: turl, SessionID: sid})
		}
		for _, a := range seen {
			probe, err := c.sendFrame("Runtime.evaluate", map[string]any{
				"expression":    "Boolean(globalThis.MagicCDP?.handleCommand && globalThis.MagicCDP?.addCustomEvent)",
				"returnByValue": true,
			}, a.SessionID)
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
		_, _ = c.sendFrame("Target.detachFromTarget", map[string]any{"sessionId": a.SessionID}, "")
	}

	loadResp, err := c.sendFrame("Extensions.loadUnpacked", map[string]any{"path": c.opts.ExtensionPath}, "")
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
		targetsResp, err := c.sendFrame("Target.getTargets", map[string]any{}, "")
		if err != nil {
			return nil, err
		}
		targetsRaw, _ := targetsResp["targetInfos"].([]any)
		for _, t := range targetsRaw {
			ti, _ := t.(map[string]any)
			if ti["type"] == "service_worker" && ti["url"] == swURL {
				tid, _ := ti["targetId"].(string)
				a, err := c.sendFrame("Target.attachToTarget", map[string]any{"targetId": tid, "flatten": true}, "")
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
