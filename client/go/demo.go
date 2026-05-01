// Go demo for MagicCDPClient. Mirrors client/js/demo.js and client/python/demo.py.
//
// Modes:
//   --direct     *.* -> direct_cdp on the client.
//   --loopback   *.* -> service_worker on client; *.* -> loopback_cdp on server. Default.
//   --debugger   *.* -> service_worker on client; *.* -> chrome_debugger on server.

package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/term"
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
	mode := "loopback"
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
		if runtime.GOOS == "darwin" {
			chromePath = "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary"
		} else {
			chromePath = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome"
		}
	}
	// Resolve repo root from this source file so the demo runs correctly from
	// any CWD (`go run ./client/go`, `go run .` from inside client/go, etc.).
	_, thisFile, _, _ := runtime.Caller(0)
	root, _ := filepath.Abs(filepath.Join(filepath.Dir(thisFile), "..", ".."))
	extensionPath := filepath.Join(root, "dist", "extension")
	profile, _ := os.MkdirTemp("", "magic-cdp-go.")
	defer os.RemoveAll(profile)

	chromePort := freePort()
	chromeFlags := []string{
		"--disable-gpu",
		"--enable-unsafe-extension-debugging", "--remote-allow-origins=*",
		"--no-first-run", "--no-default-browser-check",
		"--remote-debugging-port=" + strconv.Itoa(chromePort),
		"--user-data-dir=" + profile,
		"--load-extension=" + extensionPath,
		"about:blank",
	}
	if runtime.GOOS == "linux" {
		chromeFlags = append([]string{"--headless=new", "--no-sandbox"}, chromeFlags...)
	}
	chrome := exec.Command(chromePath, chromeFlags...)
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
	fmt.Printf("connected; ext %s session %s\n", cdp.ExtensionID, cdp.ExtSessionID)
	if b, err := json.Marshal(cdp.Latency); err == nil {
		fmt.Println("ping latency      ->", string(b))
	}

	if r, err := cdp.Send("Browser.getVersion", nil); err != nil {
		fmt.Println("Browser.getVersion -> (rejected by route:", err, ")")
	} else {
		b, _ := json.Marshal(r)
		fmt.Println("Browser.getVersion ->", string(b))
	}

	if r, err := cdp.Send("Magic.evaluate", map[string]any{
		"expression": "({ extensionId: chrome.runtime.id })",
	}); err != nil {
		log.Fatalf("Magic.evaluate: %v", err)
	} else {
		b, _ := json.Marshal(r)
		fmt.Println("Magic.evaluate     ->", string(b))
	}

	if _, err := cdp.Send("Magic.addCustomCommand", map[string]any{
		"name": "Custom.tabIdFromTargetId",
		"expression": `async ({ targetId }) => {
          const targets = await chrome.debugger.getTargets();
          const target = targets.find(target => target.id === targetId);
          if (target?.tabId != null) return { tabId: target.tabId };
          const tabs = await chrome.tabs.query({});
          const tab = tabs.find(tab => target?.url && (tab.url === target.url || tab.pendingUrl === target.url));
          return { tabId: tab?.id ?? null };
        }`,
	}); err != nil {
		log.Fatal(err)
	}
	for _, phase := range []string{"response", "event"} {
		if _, err := cdp.Send("Magic.addMiddleware", map[string]any{
			"name":  "*",
			"phase": phase,
			"expression": `async (payload, next) => {
              const seen = new WeakSet();
              const visit = async value => {
                if (!value || typeof value !== "object" || seen.has(value)) return;
                seen.add(value);
                if (!Array.isArray(value) && typeof value.targetId === "string" && value.tabId == null) {
                  const { tabId } = await cdp.send("Custom.tabIdFromTargetId", { targetId: value.targetId });
                  if (tabId != null) value.tabId = tabId;
                }
                for (const child of Array.isArray(value) ? value : Object.values(value)) await visit(child);
              };
              await visit(payload);
              return next(payload);
            }`,
		}); err != nil {
			log.Fatal(err)
		}
	}

	if _, err := cdp.Send("Magic.addCustomEvent", map[string]any{"name": "Page.foregroundPageChanged"}); err != nil {
		log.Fatal(err)
	}
	cdp.On("Page.foregroundPageChanged", func(p any) {
		fmt.Printf("Page.foregroundPageChanged -> %v\n", p)
	})
	if _, err := cdp.Send("Magic.evaluate", map[string]any{
		"expression": `chrome.tabs.onActivated.addListener(async ({ tabId }) => {
            const targets = await chrome.debugger.getTargets();
            const target = targets.find(target => target.type === "page" && target.tabId === tabId);
            await cdp.emit("Page.foregroundPageChanged", { targetId: target?.id ?? null, url: target?.url ?? null });
          })`,
	}); err != nil {
		log.Fatal(err)
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
	got := len(events)
	eventsMu.Unlock()
	if got < 2 {
		log.Fatalf("expected >=2 Custom.demo events, got %d", got)
	}
	fmt.Printf("\nSUCCESS (%s): %d events\n", mode, got)

	// TTY-only REPL. Lets you poke at the live browser interactively;
	// subscribed events print as they arrive. Skip when stdin is not a tty
	// (CI / piped input / /dev/null) so the demo exits cleanly after
	// assertions.
	if term.IsTerminal(int(os.Stdin.Fd())) {
		cdp.On("Magic.pong", func(p any) {
			b, _ := json.Marshal(p)
			fmt.Printf("\n[event] Magic.pong %s\n", string(b))
		})
		runRepl(cdp, mode)
	}
}

func runRepl(cdp *MagicCDPClient, mode string) {
	fmt.Printf("\nBrowser remains running. Mode: %s.\n", mode)
	fmt.Println("Enter commands as Domain.method({...JSON params...}). Examples:")
	fmt.Println(`  Browser.getVersion({})`)
	fmt.Println(`  Magic.evaluate({"expression": "chrome.tabs.query({active: true})"})`)
	fmt.Println(`  Custom.echo({"value": "hi"})`)
	fmt.Println("Type exit or quit to disconnect (browser keeps running).")
	cmdRE := regexp.MustCompile(`^([A-Za-z_]\w*\.[A-Za-z_]\w*)(?:\((.*)\))?$`)
	sc := bufio.NewScanner(os.Stdin)
	fmt.Print("MagicCDP> ")
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			fmt.Print("MagicCDP> ")
			continue
		}
		if line == "exit" || line == "quit" {
			break
		}
		m := cmdRE.FindStringSubmatch(line)
		if m == nil {
			fmt.Println("error: format: Domain.method({...JSON...})")
			fmt.Print("MagicCDP> ")
			continue
		}
		method := m[1]
		raw := strings.TrimSpace(m[2])
		params := map[string]any{}
		if raw != "" {
			if err := json.Unmarshal([]byte(raw), &params); err != nil {
				fmt.Printf("error: parse params: %v\n", err)
				fmt.Print("MagicCDP> ")
				continue
			}
		}
		result, err := cdp.Send(method, params)
		if err != nil {
			fmt.Printf("error: %v\n", err)
			fmt.Print("MagicCDP> ")
			continue
		}
		b, _ := json.MarshalIndent(result, "", "  ")
		fmt.Println(string(b))
		fmt.Print("MagicCDP> ")
	}
}
