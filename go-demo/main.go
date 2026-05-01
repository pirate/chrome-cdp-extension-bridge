// chromedp end-to-end demo against the JS MagicCDPBridge.
//
// chromedp's high-level event listener silently drops events for methods that
// aren't statically generated in cdproto (Custom.* are not). The simplest
// chromedp-native answer is its raw transport: chromedp.DialContext returns
// a Conn whose Read/Write speak cdproto.Message frames, so any method/event
// name passes through.
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

func freePort() int {
	l, _ := net.Listen("tcp", "127.0.0.1:0")
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}

func waitForWS(url string) string {
	for deadline := time.Now().Add(10 * time.Second); time.Now().Before(deadline); time.Sleep(100 * time.Millisecond) {
		resp, err := http.Get(url)
		if err != nil {
			continue
		}
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		var v map[string]any
		if json.Unmarshal(body, &v) == nil {
			if ws, ok := v["webSocketDebuggerUrl"].(string); ok {
				return ws
			}
		}
	}
	log.Fatalf("timeout waiting for %s", url)
	return ""
}

func main() {
	chromePath := os.Getenv("CHROME_PATH")
	if chromePath == "" {
		chromePath = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome"
	}
	root, _ := filepath.Abs("..")
	profile, _ := os.MkdirTemp("", "magic-cdp-go.")
	defer os.RemoveAll(profile)

	chromePort, proxyPort := freePort(), freePort()
	chrome := exec.Command(chromePath,
		"--headless=new", "--no-sandbox", "--disable-gpu",
		"--enable-unsafe-extension-debugging", "--remote-allow-origins=*",
		"--no-first-run", "--no-default-browser-check",
		"--remote-debugging-port="+strconv.Itoa(chromePort),
		"--user-data-dir="+profile,
		"--load-extension="+filepath.Join(root, "extension"),
		"about:blank",
	)
	must(chrome.Start())
	defer chrome.Process.Kill()

	proxy := exec.Command("node", filepath.Join(root, "proxy.mjs"),
		"--upstream", fmt.Sprintf("http://127.0.0.1:%d", chromePort),
		"--port", strconv.Itoa(proxyPort),
	)
	proxy.Stdout, proxy.Stderr = os.Stdout, os.Stderr
	must(proxy.Start())
	defer proxy.Process.Kill()

	wsURL := waitForWS(fmt.Sprintf("http://127.0.0.1:%d/json/version", proxyPort))
	conn, err := chromedp.DialContext(context.Background(), wsURL)
	must(err)
	defer conn.Close()

	// Dispatch loop: responses go to a per-id channel, Custom.demo events go
	// to the events channel.
	var (
		mu      sync.Mutex
		nextID  int64
		pending = map[int64]chan *cdproto.Message{}
		events  = make(chan map[string]any, 16)
	)
	go func() {
		for {
			var msg cdproto.Message
			if err := conn.Read(context.Background(), &msg); err != nil {
				return
			}
			if msg.ID != 0 {
				mu.Lock()
				ch := pending[msg.ID]
				delete(pending, msg.ID)
				mu.Unlock()
				if ch != nil {
					ch <- &msg
				}
			} else if string(msg.Method) == "Custom.demo" {
				p := map[string]any{}
				_ = json.Unmarshal(msg.Params, &p)
				events <- p
			}
		}
	}()

	send := func(method string, params map[string]any) []byte {
		mu.Lock()
		nextID++
		id := nextID
		ch := make(chan *cdproto.Message, 1)
		pending[id] = ch
		mu.Unlock()

		p, _ := json.Marshal(params)
		must(conn.Write(context.Background(), &cdproto.Message{
			ID: id, Method: cdproto.MethodType(method), Params: p,
		}))
		msg := <-ch
		if msg.Error != nil {
			log.Fatalf("%s failed: %s", method, msg.Error.Message)
		}
		return msg.Result
	}

	fmt.Println("Browser.getVersion ->", string(send("Browser.getVersion", nil)))
	fmt.Println("Magic.evaluate    ->", string(send("Magic.evaluate", map[string]any{
		"expression": "async () => ({ extensionId: chrome.runtime.id })",
	})))
	send("Magic.addCustomEvent", map[string]any{"name": "Custom.demo"})
	send("Magic.addCustomCommand", map[string]any{
		"name":       "Custom.echo",
		"expression": "async (params, { cdp }) => { await cdp.emit('Custom.demo', { echo: params.value }); return { echoed: params.value }; }",
	})
	fmt.Println("Custom.echo       ->", string(send("Custom.echo", map[string]any{"value": "hello-from-go"})))
	fmt.Println("Custom.echo       ->", string(send("Custom.echo", map[string]any{"value": "second"})))

	for i := 0; i < 2; i++ {
		select {
		case e := <-events:
			fmt.Println("event             ->", e)
		case <-time.After(2 * time.Second):
			log.Fatalf("timeout waiting for event %d", i+1)
		}
	}
	fmt.Println("SUCCESS")
}

func must(err error) {
	if err != nil {
		log.Fatal(err)
	}
}
