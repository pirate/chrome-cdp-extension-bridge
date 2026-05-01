// End-to-end demo: stock chromedp connecting through the same JS
// MagicCDPBridge that the Node + Python demos use, against a real local
// Chromium.
//
// What this proves:
//   - chromedp's high-level API (NewRemoteAllocator + NewContext + Run) works
//     through the proxy unchanged for normal CDP (e.g. navigation).
//   - For Magic.* sending and Custom.* event receiving, the right primitive
//     in chromedp is its raw Transport: chromedp.DialContext returns a Conn
//     whose Read/Write deal in cdproto.Message frames, so we can speak any
//     CDP method/event name through it. (chromedp.ListenTarget's high-level
//     dispatcher silently drops events for methods that aren't in cdproto's
//     statically-generated set, which Custom.* events are not.)
//
// No JS proxy modifications, no chromedp patches.

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"sync"
	"time"

	"github.com/chromedp/cdproto"
	"github.com/chromedp/chromedp"
)

const chromePathDefault = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome"

func freePort() int {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		log.Fatal(err)
	}
	port := l.Addr().(*net.TCPAddr).Port
	l.Close()
	return port
}

func waitForJSON(url string, deadline time.Time) (map[string]any, error) {
	client := &http.Client{Timeout: 500 * time.Millisecond}
	for time.Now().Before(deadline) {
		resp, err := client.Get(url)
		if err == nil {
			body, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			out := map[string]any{}
			if json.Unmarshal(body, &out) == nil {
				return out, nil
			}
		}
		time.Sleep(50 * time.Millisecond)
	}
	return nil, fmt.Errorf("timeout waiting for %s", url)
}

func main() {
	chromePath := os.Getenv("CHROME_PATH")
	if chromePath == "" {
		chromePath = chromePathDefault
	}
	cwd, _ := os.Getwd()
	extensionPath, _ := filepath.Abs(filepath.Join(cwd, "..", "extension"))

	chromePort := freePort()
	profileDir, err := os.MkdirTemp("", "magic-cdp-go.")
	if err != nil {
		log.Fatal(err)
	}
	defer os.RemoveAll(profileDir)

	fmt.Printf("== launching upstream Chromium at port %d\n", chromePort)
	chromeCmd := exec.Command(chromePath,
		"--headless=new",
		"--no-sandbox",
		"--disable-gpu",
		"--enable-unsafe-extension-debugging",
		"--remote-allow-origins=*",
		"--no-first-run",
		"--no-default-browser-check",
		"--remote-debugging-port="+strconv.Itoa(chromePort),
		"--user-data-dir="+profileDir,
		"--load-extension="+extensionPath,
		"about:blank",
	)
	chromeCmd.Stdout = nil
	chromeCmd.Stderr = nil
	if err := chromeCmd.Start(); err != nil {
		log.Fatal(err)
	}
	defer func() { _ = chromeCmd.Process.Kill(); _, _ = chromeCmd.Process.Wait() }()

	chromeURL := fmt.Sprintf("http://127.0.0.1:%d", chromePort)
	if _, err := waitForJSON(chromeURL+"/json/version", time.Now().Add(8*time.Second)); err != nil {
		log.Fatal(err)
	}

	proxyPort := freePort()
	proxyURL := fmt.Sprintf("http://127.0.0.1:%d", proxyPort)
	fmt.Printf("\n== spawning MagicCDPBridge at %s\n", proxyURL)
	proxyJS, _ := filepath.Abs(filepath.Join(cwd, "..", "proxy.mjs"))
	proxyCmd := exec.Command("node", proxyJS, "--upstream", chromeURL, "--port", strconv.Itoa(proxyPort))
	proxyCmd.Stdout = os.Stdout
	proxyCmd.Stderr = os.Stderr
	if err := proxyCmd.Start(); err != nil {
		log.Fatal(err)
	}
	defer func() { _ = proxyCmd.Process.Kill(); _, _ = proxyCmd.Process.Wait() }()

	if _, err := waitForJSON(proxyURL+"/json/version", time.Now().Add(5*time.Second)); err != nil {
		log.Fatal(err)
	}

	if err := runHighLevelChromedp(proxyURL); err != nil {
		log.Fatalf("high-level chromedp failed: %v", err)
	}

	if err := runMagicViaChromedpConn(proxyURL); err != nil {
		log.Fatalf("magic-over-chromedp-conn failed: %v", err)
	}

	fmt.Println("\nSUCCESS: chromedp sent Magic commands and received Magic events through the proxy.")
}

// 1. chromedp's high-level API through the proxy (unchanged from any normal
//    chromedp usage). Proves that connecting via NewRemoteAllocator and
//    running normal Actions works through the bridge.
func runHighLevelChromedp(proxyURL string) error {
	fmt.Println("\n== chromedp.NewRemoteAllocator + chromedp.Run through proxy ==")
	allocCtx, allocCancel := chromedp.NewRemoteAllocator(context.Background(), proxyURL)
	defer allocCancel()
	ctx, cancel := chromedp.NewContext(allocCtx)
	defer cancel()

	var ua string
	err := chromedp.Run(ctx,
		chromedp.Navigate("about:blank"),
		chromedp.Evaluate(`navigator.userAgent`, &ua),
	)
	if err != nil {
		return err
	}
	fmt.Printf("navigator.userAgent -> %s\n", ua)
	return nil
}

// 2. Magic.* / Custom.* via chromedp.DialContext. Read/Write at the
//    cdproto.Message level so we can speak any method/event name. This is the
//    chromedp-idiomatic way to use CDP methods that aren't in cdproto's
//    static codebase.
func runMagicViaChromedpConn(proxyURL string) error {
	ver, err := waitForJSON(proxyURL+"/json/version", time.Now().Add(2*time.Second))
	if err != nil {
		return err
	}
	wsURL := ver["webSocketDebuggerUrl"].(string)

	fmt.Println("\n== chromedp.DialContext raw conn for Magic + Custom events ==")
	conn, err := chromedp.DialContext(context.Background(), wsURL)
	if err != nil {
		return err
	}
	defer conn.Close()

	// id -> response channel
	var (
		nextID  int64 = 0
		mu      sync.Mutex
		pending = map[int64]chan *cdproto.Message{}
		events  []map[string]any
		evMu    sync.Mutex
		done    = make(chan struct{})
	)

	go func() {
		defer close(done)
		for {
			var msg cdproto.Message
			if err := conn.Read(context.Background(), &msg); err != nil {
				return
			}
			if msg.ID != 0 {
				mu.Lock()
				ch, ok := pending[msg.ID]
				if ok {
					delete(pending, msg.ID)
				}
				mu.Unlock()
				if ok {
					m := msg
					ch <- &m
				}
				continue
			}
			if string(msg.Method) == "Custom.demo" {
				p := map[string]any{}
				_ = json.Unmarshal(msg.Params, &p)
				evMu.Lock()
				events = append(events, p)
				evMu.Unlock()
				fmt.Printf("GO RECEIVED Custom.demo -> %v\n", p)
			}
		}
	}()

	send := func(method string, params any) (*cdproto.Message, error) {
		mu.Lock()
		nextID++
		id := nextID
		ch := make(chan *cdproto.Message, 1)
		pending[id] = ch
		mu.Unlock()

		paramsJSON, err := json.Marshal(params)
		if err != nil {
			return nil, err
		}
		out := &cdproto.Message{
			ID:     id,
			Method: cdproto.MethodType(method),
			Params: paramsJSON,
		}
		if err := conn.Write(context.Background(), out); err != nil {
			return nil, err
		}
		select {
		case <-time.After(10 * time.Second):
			return nil, fmt.Errorf("timeout waiting for %s response", method)
		case msg := <-ch:
			if msg.Error != nil {
				return nil, fmt.Errorf("%s failed: %s", method, msg.Error.Message)
			}
			return msg, nil
		}
	}

	verResp, err := send("Browser.getVersion", map[string]any{})
	if err != nil {
		return err
	}
	fmt.Printf("Browser.getVersion -> %s\n", string(verResp.Result))

	magicResp, err := send("Magic.evaluate", map[string]any{
		"expression": "async () => ({ extensionId: chrome.runtime.id, swUrl: chrome.runtime.getURL('service_worker.js') })",
	})
	if err != nil {
		return err
	}
	fmt.Printf("Magic.evaluate -> %s\n", string(magicResp.Result))

	if _, err := send("Magic.addCustomEvent", map[string]any{"name": "Custom.demo"}); err != nil {
		return err
	}
	if _, err := send("Magic.addCustomCommand", map[string]any{
		"name":       "Custom.echo",
		"expression": "async (params, { cdp }) => { await cdp.emit('Custom.demo', { echo: params.value, ts: Date.now() }); return { ok: true, echoed: params.value }; }",
	}); err != nil {
		return err
	}

	echo1, err := send("Custom.echo", map[string]any{"value": "hello-from-go"})
	if err != nil {
		return err
	}
	fmt.Printf("Custom.echo -> %s\n", string(echo1.Result))
	echo2, err := send("Custom.echo", map[string]any{"value": "second-roundtrip-go"})
	if err != nil {
		return err
	}
	fmt.Printf("Custom.echo -> %s\n", string(echo2.Result))

	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		evMu.Lock()
		n := len(events)
		evMu.Unlock()
		if n >= 2 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	evMu.Lock()
	defer evMu.Unlock()
	fmt.Printf("\nevents received: %v\n", events)
	if len(events) < 2 {
		return fmt.Errorf("expected >=2 Custom.demo events, got %d", len(events))
	}
	return nil
}
