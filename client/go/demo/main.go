// Go demo for CDPModClient. Mirrors client/js/demo.js and client/python/demo.py.
//
// Modes:
//   --live       Use the running Google Chrome enabled via chrome://inspect.
//   --direct     *.* -> direct_cdp on the client.
//   --loopback   *.* -> service_worker on client; *.* -> loopback_cdp on server. Default.
//   --debugger   *.* -> service_worker on client; *.* -> chrome_debugger on server.

package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"time"

	"cdpmod"
	"golang.org/x/term"
)

func optionsFor(mode, cdpURL, extensionPath string, launchOptions cdpmod.LaunchOptions) cdpmod.Options {
	directNormalEventRoutes := map[string]string{
		"Target.setDiscoverTargets": "direct_cdp",
		"Target.createTarget":       "direct_cdp",
		"Target.activateTarget":     "direct_cdp",
	}
	routes := func(base map[string]string) map[string]string {
		for k, v := range directNormalEventRoutes {
			base[k] = v
		}
		return base
	}
	if mode == "direct" {
		return cdpmod.Options{
			CDPURL:        cdpURL,
			ExtensionPath: extensionPath,
			LaunchOptions: launchOptions,
			Routes: routes(map[string]string{
				"Mod.*":    "service_worker",
				"Custom.*": "service_worker",
				"*.*":      "direct_cdp",
			}),
		}
	}
	server := &cdpmod.ServerConfig{
		Routes: serverRoutesFor(mode),
	}
	if mode == "loopback" && cdpURL != "" {
		server.LoopbackCDPURL = cdpURL
	}
	return cdpmod.Options{
		CDPURL:        cdpURL,
		ExtensionPath: extensionPath,
		LaunchOptions: launchOptions,
		Routes: routes(map[string]string{
			"Mod.*":    "service_worker",
			"Custom.*": "service_worker",
			"*.*":      "service_worker",
		}),
		Server: server,
	}
}

func serverRoutesFor(mode string) map[string]string {
	serverRoute := "auto"
	if mode == "loopback" {
		serverRoute = "loopback_cdp"
	} else if mode == "debugger" {
		serverRoute = "chrome_debugger"
	}
	return map[string]string{
		"Mod.*":    "service_worker",
		"Custom.*": "service_worker",
		"*.*":      serverRoute,
	}
}

func mustMap(value any, label string) map[string]any {
	result, ok := value.(map[string]any)
	if !ok {
		log.Fatalf("%s returned non-object value: %v", label, value)
	}
	return result
}

func mustString(value any, label string) string {
	result, ok := value.(string)
	if !ok || result == "" {
		log.Fatalf("%s returned non-string value: %v", label, value)
	}
	return result
}

func waitForEvent(ch <-chan map[string]any, label string, predicate func(map[string]any) bool) map[string]any {
	timeout := time.After(3 * time.Second)
	for {
		select {
		case event := <-ch:
			if predicate(event) {
				return event
			}
		case <-timeout:
			log.Fatalf("timed out waiting for %s", label)
		}
	}
}

func main() {
	flags := map[string]bool{}
	for _, a := range os.Args[1:] {
		if strings.HasPrefix(a, "--") {
			flags[strings.TrimPrefix(a, "--")] = true
		}
	}
	live := flags["live"]
	mode := "loopback"
	if flags["debugger"] {
		mode = "debugger"
	} else if flags["direct"] {
		mode = "direct"
	} else if flags["loopback"] {
		mode = "loopback"
	} else if live {
		mode = "direct"
	}
	fmt.Printf("== mode: %s%s ==\n", map[bool]string{true: "live/", false: ""}[live], mode)

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
	root, _ := filepath.Abs(filepath.Join(filepath.Dir(thisFile), "..", "..", ".."))
	extensionPath := filepath.Join(root, "dist", "extension")
	var cdpURL string
	launchOptions := cdpmod.LaunchOptions{}
	if live {
		var err error
		cdpURL, err = waitForLiveCDPURL()
		if err != nil {
			log.Fatal(err)
		}
	} else {
		headless := false
		sandbox := true
		if runtime.GOOS == "linux" {
			headless = true
			sandbox = false
		}
		launchOptions = cdpmod.LaunchOptions{
			ExecutablePath: chromePath,
			ExtraArgs:      []string{"--load-extension=" + extensionPath},
			Headless:       &headless,
			Sandbox:        &sandbox,
		}
	}

	cdp := cdpmod.New(optionsFor(mode, cdpURL, extensionPath, launchOptions))
	var (
		eventsMu            sync.Mutex
		targetCreatedEvents []map[string]any
		foregroundEvents    []map[string]any
	)
	cdp.On("Target.targetCreated", func(data any) {
		event, _ := data.(map[string]any)
		targetInfo, _ := event["targetInfo"].(map[string]any)
		fmt.Printf("Target.targetCreated -> %v\n", targetInfo["targetId"])
		eventsMu.Lock()
		targetCreatedEvents = append(targetCreatedEvents, event)
		eventsMu.Unlock()
	})

	if err := cdp.Connect(); err != nil {
		log.Fatalf("connect: %v", err)
	}
	defer cdp.Close()
	fmt.Println("upstream cdp:", cdp.CDPURL)
	fmt.Printf("connected; ext %s session %s\n", cdp.ExtensionID, cdp.ExtSessionID)
	if b, err := json.Marshal(cdp.Latency); err == nil {
		fmt.Println("ping latency      ->", string(b))
	}

	configureParams := map[string]any{"routes": serverRoutesFor(mode)}
	if mode == "loopback" {
		configureParams["loopback_cdp_url"] = cdp.CDPURL
	}
	configure := mustMap(mustSend(cdp, "Mod.configure", configureParams), "Mod.configure")
	configureRoutes := mustMap(configure["routes"], "Mod.configure.routes")
	if configureRoutes["*.*"] != serverRoutesFor(mode)["*.*"] {
		log.Fatalf("unexpected Mod.configure result: %v", configure)
	}
	fmt.Println("Mod.configure    ->", configureRoutes)

	pongCh := make(chan map[string]any, 16)
	cdp.On("Mod.pong", func(data any) {
		if event, ok := data.(map[string]any); ok {
			pongCh <- event
		}
	})
	pingSentAt := time.Now().UnixMilli()
	ping := mustMap(mustSend(cdp, "Mod.ping", map[string]any{"sentAt": pingSentAt}), "Mod.ping")
	pong := waitForEvent(pongCh, "Mod.pong", func(event map[string]any) bool {
		return event["sentAt"] == float64(pingSentAt) || event["sentAt"] == pingSentAt
	})
	if ping["ok"] != true || pong["receivedAt"] == nil || pong["from"] != "extension-service-worker" {
		log.Fatalf("unexpected Mod.ping/Mod.pong result: ping=%v pong=%v", ping, pong)
	}
	fmt.Println("Mod.ping/pong    ->", ping, pong)

	if mode == "debugger" {
		if r, err := cdp.Send("Browser.getVersion", nil); err == nil {
			version := mustMap(r, "Browser.getVersion")
			_ = mustString(version["protocolVersion"], "Browser.getVersion.protocolVersion")
			_ = mustString(version["product"], "Browser.getVersion.product")
			b, _ := json.Marshal(version)
			fmt.Println("Browser.getVersion ->", string(b))
		} else {
			fmt.Println("Browser.getVersion -> (debugger route rejected:", err, ")")
		}
		runtimeEval := mustMap(mustSend(cdp, "Runtime.evaluate", map[string]any{
			"expression":    "(() => 42)()",
			"returnByValue": true,
		}), "Runtime.evaluate")
		runtimeResult := mustMap(runtimeEval["result"], "Runtime.evaluate.result")
		if runtimeResult["value"] != float64(42) && runtimeResult["value"] != 42 {
			log.Fatalf("unexpected Runtime.evaluate result: %v", runtimeEval)
		}
		b, _ := json.Marshal(runtimeEval)
		fmt.Println("Runtime.evaluate ->", string(b))
	} else {
		version := mustMap(mustSend(cdp, "Browser.getVersion", nil), "Browser.getVersion")
		_ = mustString(version["protocolVersion"], "Browser.getVersion.protocolVersion")
		_ = mustString(version["product"], "Browser.getVersion.product")
		b, _ := json.Marshal(version)
		fmt.Println("Browser.getVersion ->", string(b))
	}

	if r, err := cdp.Send("Mod.evaluate", map[string]any{
		"expression": "({ extensionId: chrome.runtime.id })",
	}); err != nil {
		log.Fatalf("Mod.evaluate: %v", err)
	} else {
		cdpmodEval, _ := r.(map[string]any)
		if cdpmodEval["extensionId"] != cdp.ExtensionID {
			log.Fatalf("unexpected Mod.evaluate result: %v", cdpmodEval)
		}
		b, _ := json.Marshal(r)
		fmt.Println("Mod.evaluate     ->", string(b))
	}

	echoRegistration := mustMap(mustSend(cdp, "Mod.addCustomCommand", map[string]any{
		"name":       "Custom.echo",
		"expression": `async (params, method) => ({ echoed: params.value, method })`,
	}), "Mod.addCustomCommand Custom.echo")
	if echoRegistration["registered"] != true || echoRegistration["name"] != "Custom.echo" {
		log.Fatalf("unexpected Custom.echo registration: %v", echoRegistration)
	}
	echoResult := mustMap(mustSend(cdp, "Custom.echo", map[string]any{"value": "custom-command-ok"}), "Custom.echo")
	if echoResult["echoed"] != "custom-command-ok" || echoResult["method"] != "Custom.echo" {
		log.Fatalf("unexpected Custom.echo result: %v", echoResult)
	}
	b, _ := json.Marshal(echoResult)
	fmt.Println("Custom.echo      ->", string(b))

	tabCommandRegistration := mustMap(mustSend(cdp, "Mod.addCustomCommand", map[string]any{
		"name": "Custom.TabIdFromTargetId",
		"expression": `async ({ targetId }) => {
          const targets = await chrome.debugger.getTargets();
          const target = targets.find(target => target.id === targetId);
          return { tabId: target?.tabId ?? null };
        }`,
	}), "Mod.addCustomCommand Custom.TabIdFromTargetId")
	if tabCommandRegistration["registered"] != true {
		log.Fatalf("unexpected TabIdFromTargetId registration: %v", tabCommandRegistration)
	}
	targetCommandRegistration := mustMap(mustSend(cdp, "Mod.addCustomCommand", map[string]any{
		"name": "Custom.targetIdFromTabId",
		"expression": `async ({ tabId }) => {
          const targets = await chrome.debugger.getTargets();
          const target = targets.find(target => target.type === "page" && target.tabId === tabId);
          return { targetId: target?.id ?? null };
        }`,
	}), "Mod.addCustomCommand Custom.targetIdFromTabId")
	if targetCommandRegistration["registered"] != true {
		log.Fatalf("unexpected targetIdFromTabId registration: %v", targetCommandRegistration)
	}
	for _, phase := range []string{"response", "event"} {
		middlewareRegistration := mustMap(mustSend(cdp, "Mod.addMiddleware", map[string]any{
			"name":  "*",
			"phase": phase,
			"expression": `async (payload, next) => {
              const seen = new WeakSet();
              const visit = async value => {
                if (!value || typeof value !== "object" || seen.has(value)) return;
                seen.add(value);
                if (!Array.isArray(value) && typeof value.targetId === "string" && value.tabId == null) {
                  const { tabId } = await cdp.send("Custom.TabIdFromTargetId", { targetId: value.targetId });
                  if (tabId != null) value.tabId = tabId;
                }
                for (const child of Array.isArray(value) ? value : Object.values(value)) await visit(child);
              };
              await visit(payload);
              return next(payload);
            }`,
		}), "Mod.addMiddleware "+phase)
		if middlewareRegistration["registered"] != true || middlewareRegistration["phase"] != phase {
			log.Fatalf("unexpected %s middleware registration: %v", phase, middlewareRegistration)
		}
	}

	demoEventCh := make(chan map[string]any, 16)
	cdp.On("Custom.demoEvent", func(data any) {
		if event, ok := data.(map[string]any); ok {
			demoEventCh <- event
		}
	})
	demoEventRegistration := mustMap(mustSend(cdp, "Mod.addCustomEvent", map[string]any{"name": "Custom.demoEvent"}), "Mod.addCustomEvent Custom.demoEvent")
	if demoEventRegistration["registered"] != true || demoEventRegistration["name"] != "Custom.demoEvent" {
		log.Fatalf("unexpected Custom.demoEvent registration: %v", demoEventRegistration)
	}
	emitResult := mustMap(mustSend(cdp, "Mod.evaluate", map[string]any{
		"expression": `async () => await CDPMod.emit("Custom.demoEvent", { value: "custom-event-ok" })`,
	}), "Custom.demoEvent emit")
	if emitResult["emitted"] != true {
		log.Fatalf("unexpected Custom.demoEvent emit result: %v", emitResult)
	}
	demoEvent := waitForEvent(demoEventCh, "Custom.demoEvent", func(event map[string]any) bool {
		return event["value"] == "custom-event-ok"
	})
	fmt.Println("Custom.demoEvent ->", demoEvent)

	foregroundEventRegistration := mustMap(mustSend(cdp, "Mod.addCustomEvent", map[string]any{"name": "Custom.foregroundTargetChanged"}), "Mod.addCustomEvent Custom.foregroundTargetChanged")
	if foregroundEventRegistration["registered"] != true {
		log.Fatalf("unexpected foreground event registration: %v", foregroundEventRegistration)
	}
	cdp.On("Custom.foregroundTargetChanged", func(p any) {
		event, _ := p.(map[string]any)
		fmt.Printf("Custom.foregroundTargetChanged -> %v\n", event)
		eventsMu.Lock()
		foregroundEvents = append(foregroundEvents, event)
		eventsMu.Unlock()
	})
	if _, err := cdp.Send("Mod.evaluate", map[string]any{
		"expression": `chrome.tabs.onActivated.addListener(async ({ tabId }) => {
            const targets = await chrome.debugger.getTargets();
            const target = targets.find(target => target.type === "page" && target.tabId === tabId);
            const tab = await chrome.tabs.get(tabId).catch(() => null);
            await cdp.emit("Custom.foregroundTargetChanged", { tabId, targetId: target?.id ?? null, url: target?.url ?? tab?.url ?? null });
          })`,
	}); err != nil {
		log.Fatal(err)
	}

	if _, err := cdp.Send("Target.setDiscoverTargets", map[string]any{"discover": true}); err != nil {
		log.Fatal(err)
	}
	createdRaw, err := cdp.Send("Target.createTarget", map[string]any{"url": "https://example.com", "background": true})
	if err != nil {
		log.Fatalf("Target.createTarget: %v", err)
	}
	createdTarget, _ := createdRaw.(map[string]any)
	createdTargetID, _ := createdTarget["targetId"].(string)
	if createdTargetID == "" {
		log.Fatalf("Target.createTarget returned no targetId: %v", createdTarget)
	}
	deadline := time.Now().Add(3 * time.Second)
	var matchedTargetEvent map[string]any
	for time.Now().Before(deadline) {
		eventsMu.Lock()
		for _, event := range targetCreatedEvents {
			targetInfo, _ := event["targetInfo"].(map[string]any)
			if targetInfo["targetId"] == createdTargetID {
				matchedTargetEvent = event
				break
			}
		}
		eventsMu.Unlock()
		if matchedTargetEvent != nil {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if matchedTargetEvent == nil {
		log.Fatalf("expected Target.targetCreated for %s", createdTargetID)
	}
	fmt.Println("normal event matched ->", createdTargetID)

	if _, err := cdp.Send("Target.activateTarget", map[string]any{"targetId": createdTargetID}); err != nil {
		log.Fatalf("Target.activateTarget: %v", err)
	}
	deadline = time.Now().Add(3 * time.Second)
	var foreground map[string]any
	for time.Now().Before(deadline) {
		eventsMu.Lock()
		for _, event := range foregroundEvents {
			if event["targetId"] == createdTargetID {
				foreground = event
				break
			}
		}
		eventsMu.Unlock()
		if foreground != nil {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if foreground == nil {
		log.Fatalf("expected Custom.foregroundTargetChanged for %s", createdTargetID)
	}

	tabFromTargetRaw, err := cdp.Send("Custom.TabIdFromTargetId", map[string]any{"targetId": createdTargetID})
	if err != nil {
		log.Fatalf("Custom.TabIdFromTargetId: %v", err)
	}
	tabFromTarget, _ := tabFromTargetRaw.(map[string]any)
	foregroundTabID, _ := foreground["tabId"].(float64)
	tabID, _ := tabFromTarget["tabId"].(float64)
	if tabID != foregroundTabID {
		log.Fatalf("unexpected Custom.TabIdFromTargetId result: %v", tabFromTarget)
	}
	b, _ = json.Marshal(tabFromTarget)
	fmt.Println("Custom.TabIdFromTargetId ->", string(b))

	targetFromTabRaw, err := cdp.Send("Custom.targetIdFromTabId", map[string]any{"tabId": foreground["tabId"]})
	if err != nil {
		log.Fatalf("Custom.targetIdFromTabId: %v", err)
	}
	targetFromTab, _ := targetFromTabRaw.(map[string]any)
	middlewareTabID, _ := targetFromTab["tabId"].(float64)
	if targetFromTab["targetId"] != createdTargetID || middlewareTabID != foregroundTabID {
		log.Fatalf("unexpected Custom.targetIdFromTabId/middleware result: %v", targetFromTab)
	}
	b, _ = json.Marshal(targetFromTab)
	fmt.Println("Custom.targetIdFromTabId ->", string(b))

	fmt.Printf("\nSUCCESS (%s): normal command, normal event, custom commands, custom event, and middleware all passed\n", mode)

	// TTY-only REPL. Lets you poke at the live browser interactively;
	// subscribed events print as they arrive. Skip when stdin is not a tty
	// (CI / piped input / /dev/null) so the demo exits cleanly after
	// assertions.
	if term.IsTerminal(int(os.Stdin.Fd())) {
		cdp.On("Mod.pong", func(p any) {
			b, _ := json.Marshal(p)
			fmt.Printf("\n[event] Mod.pong %s\n", string(b))
		})
		runRepl(cdp, mode)
	}
}

func mustSend(cdp *cdpmod.CDPModClient, method string, params map[string]any) any {
	result, err := cdp.Send(method, params)
	if err != nil {
		log.Fatalf("%s: %v", method, err)
	}
	return result
}

func waitForLiveCDPURL() (string, error) {
	startedAt := time.Now()
	if runtime.GOOS == "darwin" {
		_ = exec.Command("open", "chrome://inspect/#remote-debugging").Start()
	} else {
		_ = exec.Command("xdg-open", "chrome://inspect/#remote-debugging").Start()
	}
	fmt.Println("opened chrome://inspect/#remote-debugging")
	fmt.Println("waiting for Chrome to expose DevToolsActivePort; click Allow when Chrome asks.")

	var candidates []string
	home, _ := os.UserHomeDir()
	if runtime.GOOS == "darwin" {
		candidates = []string{
			filepath.Join(home, "Library", "Application Support", "Google", "Chrome", "DevToolsActivePort"),
			filepath.Join(home, "Library", "Application Support", "Google", "Chrome Beta", "DevToolsActivePort"),
		}
	} else {
		candidates = []string{
			filepath.Join(home, ".config", "google-chrome", "DevToolsActivePort"),
			filepath.Join(home, ".config", "chromium", "DevToolsActivePort"),
		}
	}

	for {
		for _, candidate := range candidates {
			info, err := os.Stat(candidate)
			if err != nil || info.ModTime().Before(startedAt.Add(-time.Second)) {
				continue
			}
			body, err := os.ReadFile(candidate)
			if err != nil {
				continue
			}
			lines := strings.Fields(string(body))
			if len(lines) >= 2 {
				return "ws://127.0.0.1:" + lines[0] + lines[1], nil
			}
		}
		time.Sleep(250 * time.Millisecond)
	}
}

func runRepl(cdp *cdpmod.CDPModClient, mode string) {
	fmt.Printf("\nBrowser remains running. Mode: %s.\n", mode)
	fmt.Println("Enter commands as Domain.method({...JSON params...}). Examples:")
	fmt.Println(`  Browser.getVersion({})`)
	fmt.Println(`  Mod.evaluate({"expression": "chrome.tabs.query({active: true})"})`)
	fmt.Println(`  Custom.TabIdFromTargetId({"targetId": "..."})`)
	fmt.Println("Type exit or quit to disconnect (browser keeps running).")
	cmdRE := regexp.MustCompile(`^([A-Za-z_]\w*\.[A-Za-z_]\w*)(?:\((.*)\))?$`)
	sc := bufio.NewScanner(os.Stdin)
	fmt.Print("CDPMod> ")
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			fmt.Print("CDPMod> ")
			continue
		}
		if line == "exit" || line == "quit" {
			break
		}
		m := cmdRE.FindStringSubmatch(line)
		if m == nil {
			fmt.Println("error: format: Domain.method({...JSON...})")
			fmt.Print("CDPMod> ")
			continue
		}
		method := m[1]
		raw := strings.TrimSpace(m[2])
		params := map[string]any{}
		if raw != "" {
			if err := json.Unmarshal([]byte(raw), &params); err != nil {
				fmt.Printf("error: parse params: %v\n", err)
				fmt.Print("CDPMod> ")
				continue
			}
		}
		result, err := cdp.Send(method, params)
		if err != nil {
			fmt.Printf("error: %v\n", err)
			fmt.Print("CDPMod> ")
			continue
		}
		b, _ := json.MarshalIndent(result, "", "  ")
		fmt.Println(string(b))
		fmt.Print("CDPMod> ")
	}
}
