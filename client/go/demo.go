// Go demo for MagicCDPClient. Mirrors client/js/demo.mjs and client/python/demo.py.
//
// Modes:
//   --direct     *.* -> direct_cdp on the client.
//   --loopback   *.* -> service_worker on client; *.* -> loopback_cdp on server.
//   --debugger   *.* -> service_worker on client; *.* -> chrome_debugger on server.

package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"sync"
	"time"
)

func freePort() int {
	l, _ := net.Listen("tcp", "127.0.0.1:0")
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}

func waitForJSON(url string, deadline time.Time) (map[string]any, error) {
	for time.Now().Before(deadline) {
		resp, err := (&http.Client{Timeout: 500 * time.Millisecond}).Get(url)
		if err == nil {
			body, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			if resp.StatusCode < 500 {
				var data map[string]any
				if err := json.Unmarshal(body, &data); err != nil {
					return nil, err
				}
				return data, nil
			}
		}
		time.Sleep(50 * time.Millisecond)
	}
	return nil, fmt.Errorf("timeout waiting for %s", url)
}

func optionsFor(mode, cdpURL, extensionPath string) Options {
	if mode == "direct" {
		return Options{
			CDPURL:        cdpURL,
			ExtensionPath: extensionPath,
			Routes: map[string]string{
				"Magic.*":  "service_worker",
				"Custom.*": "service_worker",
				"*.*":      "direct_cdp",
			},
		}
	}
	serverRoute := "chrome_debugger"
	if mode == "loopback" {
		serverRoute = "loopback_cdp"
	}
	server := &ServerConfig{
		Routes: map[string]string{
			"Magic.*":  "service_worker",
			"Custom.*": "service_worker",
			"*.*":      serverRoute,
		},
	}
	if mode == "loopback" {
		server.LoopbackCDPURL = cdpURL
	}
	return Options{
		CDPURL:        cdpURL,
		ExtensionPath: extensionPath,
		Routes: map[string]string{
			"Magic.*":  "service_worker",
			"Custom.*": "service_worker",
			"*.*":      "service_worker",
		},
		Server: server,
	}
}

func main() {
	mode := "direct"
	for _, a := range os.Args[1:] {
		switch a {
		case "--debugger":
			mode = "debugger"
		case "--loopback":
			mode = "loopback"
		case "--direct":
			mode = "direct"
		}
	}
	fmt.Printf("== mode: %s ==\n", mode)

	chromePath := os.Getenv("CHROME_PATH")
	if chromePath == "" {
		chromePath = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome"
	}
	// Resolve repo root from this source file so the demo runs correctly from
	// any CWD (`go run ./client/go`, `go run .` from inside client/go, etc.).
	_, thisFile, _, _ := runtime.Caller(0)
	root, _ := filepath.Abs(filepath.Join(filepath.Dir(thisFile), "..", ".."))
	extensionPath := filepath.Join(root, "extension")
	profile, _ := os.MkdirTemp("", "magic-cdp-go.")
	defer os.RemoveAll(profile)

	chromePort := freePort()
	chrome := exec.Command(chromePath,
		"--headless=new", "--no-sandbox", "--disable-gpu",
		"--enable-unsafe-extension-debugging", "--remote-allow-origins=*",
		"--no-first-run", "--no-default-browser-check",
		"--remote-debugging-port="+strconv.Itoa(chromePort),
		"--user-data-dir="+profile,
		"--load-extension="+extensionPath,
		"about:blank",
	)
	if err := chrome.Start(); err != nil {
		log.Fatal(err)
	}
	defer func() { _ = chrome.Process.Kill(); _, _ = chrome.Process.Wait() }()

	httpURL := fmt.Sprintf("http://127.0.0.1:%d", chromePort)
	version, err := waitForJSON(httpURL+"/json/version", time.Now().Add(10*time.Second))
	if err != nil {
		log.Fatal(err)
	}
	cdpURL, _ := version["webSocketDebuggerUrl"].(string)
	fmt.Println("upstream cdp:", cdpURL)

	cdp := New(optionsFor(mode, cdpURL, extensionPath))
	var (
		eventsMu sync.Mutex
		events   []any
	)
	cdp.On("Custom.demo", func(data any) {
		fmt.Printf("event -> %v\n", data)
		eventsMu.Lock()
		events = append(events, data)
		eventsMu.Unlock()
	})

	if err := cdp.Connect(); err != nil {
		log.Fatalf("connect: %v", err)
	}
	defer cdp.Close()
	fmt.Printf("connected; ext %s session %s\n", cdp.ExtensionID, cdp.SessionID())

	if r, err := cdp.Send("Browser.getVersion", nil); err != nil {
		fmt.Println("Browser.getVersion -> (rejected by route:", err, ")")
	} else {
		b, _ := json.Marshal(r)
		fmt.Println("Browser.getVersion ->", string(b))
	}

	if r, err := cdp.Send("Magic.evaluate", map[string]any{
		"expression": "async () => ({ extensionId: chrome.runtime.id })",
	}); err != nil {
		log.Fatalf("Magic.evaluate: %v", err)
	} else {
		b, _ := json.Marshal(r)
		fmt.Println("Magic.evaluate     ->", string(b))
	}

	if _, err := cdp.Send("Magic.addCustomEvent", map[string]any{"name": "Custom.demo"}); err != nil {
		log.Fatal(err)
	}
	if _, err := cdp.Send("Magic.addCustomCommand", map[string]any{
		"name":       "Custom.echo",
		"expression": "async (params) => { await cdp.emit('Custom.demo', { echo: params.value }); return { echoed: params.value }; }",
	}); err != nil {
		log.Fatal(err)
	}

	for _, v := range []string{"hello-from-go-" + mode, "second-" + mode} {
		r, err := cdp.Send("Custom.echo", map[string]any{"value": v})
		if err != nil {
			log.Fatalf("Custom.echo %s: %v", v, err)
		}
		b, _ := json.Marshal(r)
		fmt.Println("Custom.echo        ->", string(b))
	}

	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		eventsMu.Lock()
		n := len(events)
		eventsMu.Unlock()
		if n >= 2 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	eventsMu.Lock()
	defer eventsMu.Unlock()
	if len(events) < 2 {
		log.Fatalf("expected >=2 Custom.demo events, got %d", len(events))
	}
	fmt.Printf("\nSUCCESS (%s): %d events\n", mode, len(events))
}
