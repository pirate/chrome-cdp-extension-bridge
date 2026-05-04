// CDPModClient (Go): importable, no CLI, no demo code.
//
// Field/option names mirror the JS / Python ports:
//
//	CDPURL          upstream CDP URL.
//	ExtensionPath   extension directory.
//	Routes          client-side routing map.
//	Server          { LoopbackCDPURL?, Routes? } passed to CDPModServer.configure.
//
// Public methods: Connect, Send(method, params), SendRaw, On, OnRaw, Close.
// Synchronous; one background goroutine reads frames off the WS.
//
// Route and CDPMod wire translation lives in translate.go. This file owns
// websocket transport, request bookkeeping, extension discovery, and events.
//
// Transport: gobwas/ws is intentionally low-level. We hold the underlying
// net.Conn ourselves and use wsutil.ReadServerText / WriteClientText to push
// raw JSON []byte over the websocket -- no message types, no schema, no
// dependency on chromedp/cdproto's static method enumeration.
package cdpmod

import (
	"archive/zip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
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

const cdpmodReadyExpression = `Boolean(globalThis.CDPMod?.__CDPModServerVersion === 1 && globalThis.CDPMod?.handleCommand && globalThis.CDPMod?.addCustomEvent)`

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

func freePort() (int, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	defer listener.Close()
	return listener.Addr().(*net.TCPAddr).Port, nil
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
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

type LaunchOptions struct {
	ExecutablePath string
	ExtraArgs      []string
	Headless       *bool
	Port           int
	Sandbox        *bool
}

type Options struct {
	CDPURL                       string
	ExtensionPath                string
	Routes                       map[string]string
	Server                       *ServerConfig
	CustomCommands               []CustomCommand
	CustomEvents                 []CustomEvent
	CustomMiddlewares            []CustomMiddleware
	ServiceWorkerURLIncludes     []string
	ServiceWorkerURLSuffixes     []string
	TrustServiceWorkerTarget     bool
	RequireServiceWorkerTarget   bool
	ServiceWorkerReadyExpression string
	LaunchOptions                LaunchOptions
}

type Handler func(data any)

type CDPEvent struct {
	Method       string         `json:"method"`
	Params       map[string]any `json:"params,omitempty"`
	CDPSessionID string         `json:"cdpSessionId,omitempty"`
	SessionID    string         `json:"sessionId,omitempty"`
}

type CDPModClient struct {
	opts                 Options
	CDPURL               string
	conn                 net.Conn
	writeMu              sync.Mutex
	ctx                  context.Context
	cancel               context.CancelFunc
	mu                   sync.Mutex
	nextID               int64
	pending              map[int64]chan map[string]any
	handlers             map[string][]Handler
	cdpHandlers          map[string][]func(CDPEvent)
	handlersMu           sync.Mutex
	targetSessions       map[string]string
	sessionTargets       map[string]map[string]any
	targetSessionsMu     sync.Mutex
	ExtensionID          string
	ExtTargetID          string
	ExtSessionID         string
	Latency              map[string]any
	ConnectTiming        map[string]any
	LastCommandTiming    map[string]any
	LastRawTiming        map[string]any
	launchedProcess      *exec.Cmd
	profileDir           string
	preparedExtensionDir string
}

func New(opts Options) *CDPModClient {
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
	if opts.ServiceWorkerURLSuffixes == nil {
		opts.ServiceWorkerURLSuffixes = []string{"/service_worker.js", "/background.js"}
	}
	return &CDPModClient{
		opts:           opts,
		pending:        map[int64]chan map[string]any{},
		handlers:       map[string][]Handler{},
		cdpHandlers:    map[string][]func(CDPEvent){},
		targetSessions: map[string]string{},
		sessionTargets: map[string]map[string]any{},
	}
}

func (c *CDPModClient) Connect() error {
	connectStartedAt := time.Now().UnixMilli()
	if c.opts.CDPURL == "" {
		if err := c.prepareExtensionPath(); err != nil {
			return err
		}
		cdpURL, err := c.launchChrome()
		if err != nil {
			return err
		}
		c.opts.CDPURL = cdpURL
	}
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
	extensionStartedAt := time.Now().UnixMilli()
	if err := c.prepareExtensionPath(); err != nil {
		c.Close()
		return err
	}
	ext, err := c.ensureExtension()
	if err != nil {
		c.Close()
		return err
	}
	extensionCompletedAt := time.Now().UnixMilli()
	c.ExtensionID = ext["extension_id"].(string)
	c.ExtTargetID = ext["target_id"].(string)
	c.ExtSessionID = ext["session_id"].(string)
	if _, err := c.sendFrame("Runtime.enable", map[string]any{}, c.ExtSessionID); err != nil {
		c.Close()
		return err
	}
	if _, err := c.sendFrame("Runtime.addBinding", map[string]any{"name": bindingNameFor("Mod.pong")}, c.ExtSessionID); err != nil {
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
		command, err := wrapCommandIfNeeded("Mod.configure", map[string]any{
			"loopback_cdp_url":   c.opts.Server.LoopbackCDPURL,
			"routes":             c.opts.Server.Routes,
			"custom_commands":    customCommands,
			"custom_events":      customEvents,
			"custom_middlewares": customMiddlewares,
		}, c.opts.Routes, c.ExtSessionID)
		if err != nil {
			c.Close()
			return fmt.Errorf("Mod.configure: %w", err)
		}
		if _, err := c.sendRaw(command); err != nil {
			c.Close()
			return fmt.Errorf("Mod.configure: %w", err)
		}
	}
	go func() { _ = c.measurePingLatency() }()
	connectedAt := time.Now().UnixMilli()
	c.ConnectTiming = map[string]any{
		"started_at":             connectStartedAt,
		"extension_source":       ext["source"],
		"extension_started_at":   extensionStartedAt,
		"extension_completed_at": extensionCompletedAt,
		"extension_duration_ms":  extensionCompletedAt - extensionStartedAt,
		"connected_at":           connectedAt,
		"duration_ms":            connectedAt - connectStartedAt,
	}
	return nil
}

func (c *CDPModClient) Send(method string, params map[string]any) (any, error) {
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

func (c *CDPModClient) SendRaw(method string, params map[string]any, sessionID ...string) (map[string]any, error) {
	startedAt := time.Now().UnixMilli()
	if params == nil {
		params = map[string]any{}
	}
	targetSessionID := ""
	if len(sessionID) > 0 {
		targetSessionID = sessionID[0]
	}
	result, err := c.sendFrame(method, params, targetSessionID)
	completedAt := time.Now().UnixMilli()
	c.LastRawTiming = map[string]any{
		"method":       method,
		"started_at":   startedAt,
		"completed_at": completedAt,
		"duration_ms":  completedAt - startedAt,
	}
	return result, err
}

func (c *CDPModClient) OnRaw(event string, handler Handler) {
	c.On(event, handler)
}

func (c *CDPModClient) OnCDP(event string, handler func(CDPEvent)) {
	c.handlersMu.Lock()
	defer c.handlersMu.Unlock()
	c.cdpHandlers[event] = append(c.cdpHandlers[event], handler)
}

func (c *CDPModClient) On(event string, handler Handler) {
	c.handlersMu.Lock()
	defer c.handlersMu.Unlock()
	c.handlers[event] = append(c.handlers[event], handler)
}

func (c *CDPModClient) Close() {
	if c.cancel != nil {
		c.cancel()
	}
	if c.conn != nil {
		_ = c.conn.Close()
	}
	if c.launchedProcess != nil && c.launchedProcess.Process != nil {
		_ = c.launchedProcess.Process.Kill()
		_, _ = c.launchedProcess.Process.Wait()
		c.launchedProcess = nil
	}
	if c.profileDir != "" {
		_ = os.RemoveAll(c.profileDir)
		c.profileDir = ""
	}
	if c.preparedExtensionDir != "" {
		_ = os.RemoveAll(c.preparedExtensionDir)
		c.preparedExtensionDir = ""
	}
}

func (c *CDPModClient) launchChrome() (string, error) {
	executablePath := firstNonEmpty(c.opts.LaunchOptions.ExecutablePath, os.Getenv("CHROME_PATH"))
	candidates := []string{
		executablePath,
		"/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
		"/Applications/Chromium.app/Contents/MacOS/Chromium",
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		"/usr/bin/google-chrome-canary",
		"/usr/bin/chromium",
		"/usr/bin/chromium-browser",
		"/usr/bin/google-chrome",
	}
	executablePath = ""
	for _, candidate := range candidates {
		if candidate == "" {
			continue
		}
		if _, err := os.Stat(candidate); err == nil {
			executablePath = candidate
			break
		}
	}
	if executablePath == "" {
		return "", fmt.Errorf("no Chrome/Chromium binary found; set CHROME_PATH or pass LaunchOptions.ExecutablePath")
	}
	port := c.opts.LaunchOptions.Port
	if port == 0 {
		nextPort, err := freePort()
		if err != nil {
			return "", err
		}
		port = nextPort
	}
	profileDir, err := os.MkdirTemp("", "cdpmod.")
	if err != nil {
		return "", err
	}
	c.profileDir = profileDir
	args := []string{
		"--enable-unsafe-extension-debugging",
		"--remote-allow-origins=*",
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-default-apps",
		"--disable-background-networking",
		"--disable-backgrounding-occluded-windows",
		"--disable-renderer-backgrounding",
		"--disable-background-timer-throttling",
		"--disable-dev-shm-usage",
		"--disable-sync",
		"--disable-features=DisableLoadExtensionCommandLineSwitch",
		"--password-store=basic",
		"--use-mock-keychain",
		"--disable-gpu",
		fmt.Sprintf("--user-data-dir=%s", profileDir),
		"--remote-debugging-address=127.0.0.1",
		fmt.Sprintf("--remote-debugging-port=%d", port),
	}
	headless := runtime.GOOS == "linux" && os.Getenv("DISPLAY") == ""
	if c.opts.LaunchOptions.Headless != nil {
		headless = *c.opts.LaunchOptions.Headless
	}
	if headless {
		args = append(args, "--headless=new")
	}
	if c.opts.LaunchOptions.Sandbox == nil || !*c.opts.LaunchOptions.Sandbox {
		args = append(args, "--no-sandbox")
	}
	if c.opts.ExtensionPath != "" {
		args = append(args, fmt.Sprintf("--load-extension=%s", c.opts.ExtensionPath))
	}
	args = append(args, c.opts.LaunchOptions.ExtraArgs...)
	args = append(args, "about:blank")
	c.launchedProcess = exec.Command(executablePath, args...)
	if err := c.launchedProcess.Start(); err != nil {
		_ = os.RemoveAll(profileDir)
		return "", err
	}
	cdpURL := fmt.Sprintf("http://127.0.0.1:%d", port)
	const chromeReadyTimeout = 45 * time.Second
	deadline := time.Now().Add(chromeReadyTimeout)
	for time.Now().Before(deadline) {
		resp, err := http.Get(cdpURL + "/json/version")
		if err == nil {
			_ = resp.Body.Close()
			if resp.StatusCode >= 200 && resp.StatusCode < 300 {
				return cdpURL, nil
			}
		}
		time.Sleep(100 * time.Millisecond)
	}
	c.Close()
	return "", fmt.Errorf("Chrome at %s did not become ready within %s", cdpURL, chromeReadyTimeout)
}

// --- internals -----------------------------------------------------------

func (c *CDPModClient) prepareExtensionPath() error {
	if c.opts.ExtensionPath == "" || !strings.HasSuffix(c.opts.ExtensionPath, ".zip") {
		return nil
	}
	dir, err := os.MkdirTemp("", "cdpmod-extension.")
	if err != nil {
		return err
	}
	reader, err := zip.OpenReader(c.opts.ExtensionPath)
	if err != nil {
		_ = os.RemoveAll(dir)
		return err
	}
	defer reader.Close()
	for _, file := range reader.File {
		targetPath := filepath.Join(dir, file.Name)
		if file.FileInfo().IsDir() {
			if err := os.MkdirAll(targetPath, 0o755); err != nil {
				_ = os.RemoveAll(dir)
				return err
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(targetPath), 0o755); err != nil {
			_ = os.RemoveAll(dir)
			return err
		}
		src, err := file.Open()
		if err != nil {
			_ = os.RemoveAll(dir)
			return err
		}
		dst, err := os.OpenFile(targetPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, file.FileInfo().Mode())
		if err != nil {
			_ = src.Close()
			_ = os.RemoveAll(dir)
			return err
		}
		_, copyErr := io.Copy(dst, src)
		srcErr := src.Close()
		dstErr := dst.Close()
		if copyErr != nil {
			_ = os.RemoveAll(dir)
			return copyErr
		}
		if srcErr != nil {
			_ = os.RemoveAll(dir)
			return srcErr
		}
		if dstErr != nil {
			_ = os.RemoveAll(dir)
			return dstErr
		}
	}
	c.preparedExtensionDir = dir
	c.opts.ExtensionPath = dir
	return nil
}

func (c *CDPModClient) sendRaw(command rawCommand) (any, error) {
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

func (c *CDPModClient) measurePingLatency() error {
	sentAt := time.Now().UnixMilli()
	ch := make(chan any, 1)
	c.On("Mod.pong", func(data any) {
		select {
		case ch <- data:
		default:
		}
	})
	if _, err := c.Send("Mod.ping", map[string]any{"sentAt": sentAt}); err != nil {
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
		return fmt.Errorf("Mod.pong timed out")
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

func (c *CDPModClient) sendFrame(method string, params map[string]any, sessionID string) (map[string]any, error) {
	return c.sendFrameTimeout(method, params, sessionID, 0)
}

func (c *CDPModClient) sendFrameTimeout(method string, params map[string]any, sessionID string, timeout time.Duration) (map[string]any, error) {
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
	if timeout <= 0 {
		resp := <-ch
		if errObj, ok := resp["error"].(map[string]any); ok {
			return nil, fmt.Errorf("%s failed: %v", method, errObj["message"])
		}
		if r, ok := resp["result"].(map[string]any); ok {
			return r, nil
		}
		return map[string]any{}, nil
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

func (c *CDPModClient) cdpmodServerBootstrapExpression() (string, error) {
	body, err := os.ReadFile(filepath.Join(c.opts.ExtensionPath, "CDPModServer.js"))
	if err != nil {
		return "", err
	}
	source := string(body)
	start := strings.Index(source, "export function installCDPModServer")
	end := strings.Index(source, "export const CDPModServer")
	if start < 0 || end < start {
		return "", fmt.Errorf("could not find installCDPModServer in CDPModServer.js")
	}
	installer := strings.Replace(source[start:end], "export function", "function", 1)
	return fmt.Sprintf(`(() => {
%s
const CDPMod = installCDPModServer(globalThis);
return {
  ok: Boolean(CDPMod?.__CDPModServerVersion === 1 && CDPMod?.handleCommand && CDPMod?.addCustomEvent),
  extension_id: globalThis.chrome?.runtime?.id ?? null,
  has_tabs: Boolean(globalThis.chrome?.tabs?.query),
  has_debugger: Boolean(globalThis.chrome?.debugger?.sendCommand),
};
})()`, installer), nil
}

func (c *CDPModClient) reader() {
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
		params, _ := msg["params"].(map[string]any)
		if method == "Target.attachedToTarget" {
			attachedSessionID, _ := params["sessionId"].(string)
			targetInfo, _ := params["targetInfo"].(map[string]any)
			targetID, _ := targetInfo["targetId"].(string)
			if attachedSessionID != "" && targetID != "" {
				c.targetSessionsMu.Lock()
				c.targetSessions[targetID] = attachedSessionID
				c.sessionTargets[attachedSessionID] = targetInfo
				c.targetSessionsMu.Unlock()
			}
		} else if method == "Target.detachedFromTarget" {
			detachedSessionID, _ := params["sessionId"].(string)
			if detachedSessionID != "" {
				c.targetSessionsMu.Lock()
				targetInfo := c.sessionTargets[detachedSessionID]
				delete(c.sessionTargets, detachedSessionID)
				if targetID, _ := targetInfo["targetId"].(string); targetID != "" {
					delete(c.targetSessions, targetID)
				}
				c.targetSessionsMu.Unlock()
			}
		}
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
			cdpHandlers := append([]func(CDPEvent){}, c.cdpHandlers["*"]...)
			cdpHandlers = append(cdpHandlers, c.cdpHandlers[method]...)
			c.handlersMu.Unlock()
			for _, h := range hs {
				go h(params)
			}
			if len(cdpHandlers) > 0 {
				event := CDPEvent{Method: method, Params: params, CDPSessionID: sessionID, SessionID: sessionID}
				for _, h := range cdpHandlers {
					go h(event)
				}
			}
		}
	}
}

func (c *CDPModClient) ensureExtension() (map[string]any, error) {
	targetsResp, err := c.sendFrame("Target.getTargets", map[string]any{}, "")
	if err != nil {
		return nil, err
	}
	targetsRaw, _ := targetsResp["targetInfos"].([]any)
	trustServiceWorkerTarget := c.trustServiceWorkerTarget()
	if trustServiceWorkerTarget {
		for _, t := range targetsRaw {
			ti, _ := t.(map[string]any)
			if !c.serviceWorkerTargetMatches(ti) {
				continue
			}
			if probed, ok := c.probeReadyTarget(ti, 2*time.Second); ok {
				probed["source"] = "trusted"
				return probed, nil
			}
		}
	}
	for _, t := range targetsRaw {
		ti, _ := t.(map[string]any)
		ttype, _ := ti["type"].(string)
		turl, _ := ti["url"].(string)
		if ttype != "service_worker" || !strings.HasPrefix(turl, "chrome-extension://") {
			continue
		}
		if probed, ok := c.probeReadyTarget(ti, 2*time.Second); ok {
			probed["source"] = "discovered"
			return probed, nil
		}
	}
	if c.opts.RequireServiceWorkerTarget {
		matchers := append(append([]string{}, c.opts.ServiceWorkerURLIncludes...), c.opts.ServiceWorkerURLSuffixes...)
		matcherText := strings.Join(matchers, ", ")
		if matcherText == "" {
			matcherText = "no matcher"
		}
		return nil, fmt.Errorf("required CDPMod service worker target was not visible in the current CDP target snapshot (%s)", matcherText)
	}

	loadResp, err := c.sendFrame("Extensions.loadUnpacked", map[string]any{"path": c.opts.ExtensionPath}, "")
	if err != nil {
		if strings.Contains(err.Error(), "Method not available") || strings.Contains(err.Error(), "wasn't found") {
			targetsResp, getTargetsErr := c.sendFrame("Target.getTargets", map[string]any{}, "")
			if getTargetsErr != nil {
				return nil, getTargetsErr
			}
			targetsRaw, _ := targetsResp["targetInfos"].([]any)
			if trustServiceWorkerTarget {
				for _, t := range targetsRaw {
					ti, _ := t.(map[string]any)
					if !c.serviceWorkerTargetMatches(ti) {
						continue
					}
					if probed, ok := c.probeReadyTarget(ti, 2*time.Second); ok {
						probed["source"] = "trusted"
						return probed, nil
					}
				}
			}
			for _, t := range targetsRaw {
				ti, _ := t.(map[string]any)
				ttype, _ := ti["type"].(string)
				turl, _ := ti["url"].(string)
				if ttype != "service_worker" || !strings.HasPrefix(turl, "chrome-extension://") {
					continue
				}
				if probed, ok := c.probeReadyTarget(ti, 2*time.Second); ok {
					probed["source"] = "discovered"
					return probed, nil
				}
			}
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
	deadline := time.Now().Add(60 * time.Second)
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
				if probed, ok := c.probeReadyTarget(ti, time.Second); ok {
					probed["source"] = "injected"
					probed["extension_id"] = extID
					return probed, nil
				}
			}
		}
		time.Sleep(100 * time.Millisecond)
	}
	return nil, fmt.Errorf("timed out after 60s waiting for service worker target for extension %s", extID)
}

func (c *CDPModClient) trustServiceWorkerTarget() bool {
	if c.opts.TrustServiceWorkerTarget || len(c.opts.ServiceWorkerURLIncludes) > 0 {
		return true
	}
	for _, suffix := range c.opts.ServiceWorkerURLSuffixes {
		parts := 0
		for _, part := range strings.Split(suffix, "/") {
			if part != "" {
				parts++
			}
		}
		if parts > 1 {
			return true
		}
	}
	return false
}

func (c *CDPModClient) serviceWorkerTargetMatches(target map[string]any) bool {
	turl, _ := target["url"].(string)
	ttype, _ := target["type"].(string)
	if ttype != "service_worker" || !strings.HasPrefix(turl, "chrome-extension://") {
		return false
	}
	for _, part := range c.opts.ServiceWorkerURLIncludes {
		if !strings.Contains(turl, part) {
			return false
		}
	}
	if len(c.opts.ServiceWorkerURLSuffixes) > 0 {
		matched := false
		for _, suffix := range c.opts.ServiceWorkerURLSuffixes {
			if strings.HasSuffix(turl, suffix) {
				matched = true
				break
			}
		}
		if !matched {
			return false
		}
	}
	return len(c.opts.ServiceWorkerURLIncludes) > 0 || len(c.opts.ServiceWorkerURLSuffixes) > 0
}

func (c *CDPModClient) readyExpression() string {
	if c.opts.ServiceWorkerReadyExpression == "" {
		return cdpmodReadyExpression
	}
	return fmt.Sprintf("(%s) && Boolean(%s)", cdpmodReadyExpression, c.opts.ServiceWorkerReadyExpression)
}

func (c *CDPModClient) sessionIDForTarget(targetID string, timeout time.Duration) string {
	if timeout <= 0 {
		c.targetSessionsMu.Lock()
		sessionID := c.targetSessions[targetID]
		c.targetSessionsMu.Unlock()
		return sessionID
	}
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline.Add(time.Millisecond)) {
		c.targetSessionsMu.Lock()
		sessionID := c.targetSessions[targetID]
		c.targetSessionsMu.Unlock()
		if sessionID != "" {
			return sessionID
		}
		time.Sleep(20 * time.Millisecond)
	}
	return ""
}

func (c *CDPModClient) probeReadyTarget(target map[string]any, timeout time.Duration) (map[string]any, bool) {
	targetID, _ := target["targetId"].(string)
	targetURL, _ := target["url"].(string)
	sessionID := c.sessionIDForTarget(targetID, timeout)
	if sessionID == "" {
		return nil, false
	}
	probe, err := c.sendFrameTimeout("Runtime.evaluate", map[string]any{
		"expression":    c.readyExpression(),
		"returnByValue": true,
	}, sessionID, 2*time.Second)
	if err != nil {
		return nil, false
	}
	result, _ := probe["result"].(map[string]any)
	if ready, _ := result["value"].(bool); !ready {
		return nil, false
	}
	extensionID := ""
	if m := extIDFromURL.FindStringSubmatch(targetURL); len(m) > 1 {
		extensionID = m[1]
	}
	return map[string]any{
		"extension_id": extensionID,
		"target_id":    targetID,
		"url":          targetURL,
		"session_id":   sessionID,
	}, true
}

func (c *CDPModClient) borrowExtensionWorker(loadError string) (map[string]any, error) {
	bootstrap, err := c.cdpmodServerBootstrapExpression()
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
		sessionID := c.sessionIDForTarget(tid, 2*time.Second)
		if sessionID == "" {
			continue
		}
		_, _ = c.sendFrameTimeout("Runtime.enable", map[string]any{}, sessionID, 2*time.Second)
		probe, err := c.sendFrameTimeout("Runtime.evaluate", map[string]any{
			"expression":                  bootstrap,
			"awaitPromise":                true,
			"returnByValue":               true,
			"allowUnsafeEvalBlockedByCSP": true,
		}, sessionID, 3*time.Second)
		if err != nil {
			continue
		}
		result, _ := probe["result"].(map[string]any)
		value, _ := result["value"].(map[string]any)
		if ok, _ := value["ok"].(bool); !ok {
			continue
		}
		if c.opts.ServiceWorkerReadyExpression != "" {
			readyProbe, err := c.sendFrameTimeout("Runtime.evaluate", map[string]any{
				"expression":    c.readyExpression(),
				"returnByValue": true,
			}, sessionID, 2*time.Second)
			if err != nil {
				continue
			}
			readyResult, _ := readyProbe["result"].(map[string]any)
			if ready, _ := readyResult["value"].(bool); !ready {
				continue
			}
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
		delete(borrowed[0], "has_tabs")
		delete(borrowed[0], "has_debugger")
		return borrowed[0], nil
	}
	return nil, fmt.Errorf(
		"cannot install or borrow CDPMod in the running browser:\n"+
			"  - no service worker with globalThis.CDPMod found\n"+
			"  - Extensions.loadUnpacked unavailable (%s)\n"+
			"  - no running chrome-extension:// service worker accepted the CDPMod bootstrap",
		loadError,
	)
}
