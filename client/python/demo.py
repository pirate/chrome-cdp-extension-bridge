"""Python demo for MagicCDPClient. Mirrors client/js/demo.js.

Modes (mirror the JS / Go demos):
    --live        Use the running Google Chrome enabled via chrome://inspect.
    --direct      *.* -> direct_cdp on the client.
    --loopback    *.* -> service_worker on the client; *.* -> loopback_cdp on
                  the server. Default.
    --debugger    *.* -> service_worker on the client; *.* -> chrome_debugger
                  on the server.
"""

import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from MagicCDPClient import MagicCDPClient

ROOT = Path(__file__).resolve().parent.parent.parent
EXTENSION_PATH = ROOT / "dist" / "extension"
LIVE_DEVTOOLS_ACTIVE_PORTS = [
    Path.home() / "Library" / "Application Support" / "Google" / "Chrome" / "DevToolsActivePort",
    Path.home() / "Library" / "Application Support" / "Google" / "Chrome Beta" / "DevToolsActivePort",
] if sys.platform == "darwin" else [
    Path.home() / ".config" / "google-chrome" / "DevToolsActivePort",
    Path.home() / ".config" / "chromium" / "DevToolsActivePort",
]
CHROME = os.environ.get("CHROME_PATH") or (
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary"
    if sys.platform == "darwin"
    else "/opt/pw-browsers/chromium-1194/chrome-linux/chrome"
)


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def wait_for_url(url, timeout_s=8.0):
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=0.5) as r:
                return json.loads(r.read())
        except Exception:
            time.sleep(0.05)
    raise RuntimeError(f"timeout waiting for {url}")


def client_options_for(mode, cdp_url):
    direct_normal_event_routes = {
        "Target.setDiscoverTargets": "direct_cdp",
        "Target.createTarget": "direct_cdp",
        "Target.activateTarget": "direct_cdp",
    }
    if mode == "direct":
        return {
            "cdp_url": cdp_url,
            "extension_path": str(EXTENSION_PATH),
            "routes": {"Magic.*": "service_worker", "Custom.*": "service_worker", "*.*": "direct_cdp", **direct_normal_event_routes},
        }
    return {
        "cdp_url": cdp_url,
        "extension_path": str(EXTENSION_PATH),
        "routes": {"Magic.*": "service_worker", "Custom.*": "service_worker", "*.*": "service_worker", **direct_normal_event_routes},
        "server": {
            "routes": {
                "Magic.*": "service_worker",
                "Custom.*": "service_worker",
                "*.*": "loopback_cdp" if mode == "loopback" else "chrome_debugger",
            },
            "loopback_cdp_url": cdp_url if mode == "loopback" else None,
        },
    }


def wait_for_live_cdp_url():
    started_at = time.time()
    opener = ["open", "chrome://inspect/#remote-debugging"] if sys.platform == "darwin" else ["xdg-open", "chrome://inspect/#remote-debugging"]
    subprocess.Popen(opener, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    print("opened chrome://inspect/#remote-debugging")
    print("waiting for Chrome to expose DevToolsActivePort; click Allow when Chrome asks.")
    while True:
        for path in LIVE_DEVTOOLS_ACTIVE_PORTS:
            try:
                if path.stat().st_mtime < started_at - 1:
                    continue
                lines = [line.strip() for line in path.read_text().splitlines() if line.strip()]
                if len(lines) >= 2:
                    return f"ws://127.0.0.1:{lines[0]}{lines[1]}"
            except Exception:
                pass
        time.sleep(0.25)


def main():
    flags = {a[2:] for a in sys.argv[1:] if a.startswith("--")}
    live = "live" in flags
    mode = "debugger" if "debugger" in flags else "direct" if "direct" in flags else "loopback" if "loopback" in flags else "direct" if live else "loopback"
    print(f"== mode: {'live/' if live else ''}{mode} ==")

    # Allocate cleanup handles up front so an early failure (port allocation,
    # mkdtemp, Popen, /json/version probe) still hits the try/finally and
    # releases the temp profile dir + any partially-started Chrome.
    chrome_proc = None
    profile_dir = None
    cdp = None
    try:
        if live:
            cdp_url = wait_for_live_cdp_url()
        else:
            chrome_port = free_port()
            profile_dir = tempfile.mkdtemp(prefix="magic-cdp-py.")
            chrome_args = [
                CHROME,
                "--disable-gpu",
                "--enable-unsafe-extension-debugging", "--remote-allow-origins=*",
                "--no-first-run", "--no-default-browser-check",
                f"--remote-debugging-port={chrome_port}",
                f"--user-data-dir={profile_dir}",
                f"--load-extension={EXTENSION_PATH}",
                "about:blank",
            ]
            if sys.platform.startswith("linux"):
                chrome_args.insert(1, "--headless=new")
                chrome_args.insert(2, "--no-sandbox")
            chrome_proc = subprocess.Popen(chrome_args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            http_url = f"http://127.0.0.1:{chrome_port}"
            cdp_url = wait_for_url(f"{http_url}/json/version")["webSocketDebuggerUrl"]
        print(f"upstream cdp: {cdp_url}")

        cdp = MagicCDPClient(**client_options_for(mode, cdp_url))
        foreground_events = []
        target_created_events = []
        events_lock = threading.Lock()

        def on_target_created(payload, *_):
            print(f"Target.targetCreated -> {payload.get('targetInfo', {}).get('targetId')}")
            with events_lock:
                target_created_events.append(payload)

        def on_foreground_changed(payload, *_):
            print(f"Custom.foregroundTargetChanged -> {payload}")
            with events_lock:
                foreground_events.append(payload)

        cdp.on("Target.targetCreated", on_target_created)

        cdp.connect()
        print(f"connected; ext {cdp.extension_id} session {cdp.ext_session_id}")
        print(f"ping latency      -> {cdp.latency}")

        try: print(f"Browser.getVersion -> {cdp.send('Browser.getVersion')}")
        except Exception as e: print(f"Browser.getVersion -> (rejected by route: {str(e).splitlines()[0]} )")

        magic_eval = cdp.send("Magic.evaluate", {"expression": "({ extensionId: chrome.runtime.id })"})
        if magic_eval.get("extensionId") != cdp.extension_id:
            raise RuntimeError(f"unexpected Magic.evaluate result {magic_eval}")
        print(f"Magic.evaluate     -> {magic_eval}")

        cdp.send("Magic.addCustomCommand", {
            "name": "Custom.TabIdFromTargetId",
            "expression": '''async ({ targetId }) => {
              const targets = await chrome.debugger.getTargets();
              const target = targets.find(target => target.id === targetId);
              return { tabId: target?.tabId ?? null };
            }''',
        })
        cdp.send("Magic.addCustomCommand", {
            "name": "Custom.targetIdFromTabId",
            "expression": '''async ({ tabId }) => {
              const targets = await chrome.debugger.getTargets();
              const target = targets.find(target => target.type === "page" && target.tabId === tabId);
              return { targetId: target?.id ?? null };
            }''',
        })
        for phase in ("response", "event"):
            cdp.send("Magic.addMiddleware", {
                "name": "*",
                "phase": phase,
                "expression": '''async (payload, next) => {
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
                }''',
            })

        cdp.send("Magic.addCustomEvent", {"name": "Custom.foregroundTargetChanged"})
        cdp.on("Custom.foregroundTargetChanged", on_foreground_changed)
        cdp.send("Magic.evaluate", {"expression": '''chrome.tabs.onActivated.addListener(async ({ tabId }) => {
            const targets = await chrome.debugger.getTargets();
            const target = targets.find(target => target.type === "page" && target.tabId === tabId);
            const tab = await chrome.tabs.get(tabId).catch(() => null);
            await cdp.emit("Custom.foregroundTargetChanged", { tabId, targetId: target?.id ?? null, url: target?.url ?? tab?.url ?? null });
          })'''})

        cdp.send("Target.setDiscoverTargets", {"discover": True})
        created_target = cdp.send("Target.createTarget", {"url": "https://example.com"})
        created_target_id = created_target.get("targetId")
        if not created_target_id:
            raise RuntimeError(f"Target.createTarget returned no targetId: {created_target}")
        deadline = time.monotonic() + 3.0
        while True:
            with events_lock:
                matched_target_event = next((event for event in target_created_events if event.get("targetInfo", {}).get("targetId") == created_target_id), None)
            if matched_target_event or time.monotonic() >= deadline:
                break
            time.sleep(0.02)
        if not matched_target_event:
            raise RuntimeError(f"expected Target.targetCreated for {created_target_id}")
        print(f"normal event matched -> {created_target_id}")

        cdp.send("Target.activateTarget", {"targetId": created_target_id})
        deadline = time.monotonic() + 3.0
        while True:
            with events_lock:
                foreground = next((event for event in foreground_events if event.get("targetId") == created_target_id), None)
            if foreground or time.monotonic() >= deadline:
                break
            time.sleep(0.02)
        if not foreground:
            raise RuntimeError(f"expected Custom.foregroundTargetChanged for {created_target_id}")

        tab_from_target = cdp.send("Custom.TabIdFromTargetId", {"targetId": created_target_id})
        if tab_from_target.get("tabId") != foreground.get("tabId"):
            raise RuntimeError(f"unexpected Custom.TabIdFromTargetId result {tab_from_target}")
        print(f"Custom.TabIdFromTargetId -> {tab_from_target}")

        target_from_tab = cdp.send("Custom.targetIdFromTabId", {"tabId": foreground["tabId"]})
        if target_from_tab.get("targetId") != created_target_id or target_from_tab.get("tabId") != foreground.get("tabId"):
            raise RuntimeError(f"unexpected Custom.targetIdFromTabId/middleware result {target_from_tab}")
        print(f"Custom.targetIdFromTabId -> {target_from_tab}")

        print(f"\nSUCCESS ({mode}): normal command, normal event, custom commands, custom event, and middleware all passed")

        # TTY-only: drop into a REPL where you can send live commands and
        # watch events as they print. Skip when run non-interactively so the
        # demo stays CI-friendly.
        if sys.stdin.isatty():
            cdp.on("Magic.pong", lambda e: print(f"\n[event] Magic.pong {e}"))
            run_repl(cdp, mode)

        return 0
    finally:
        if cdp is not None:
            try: cdp.close()
            except Exception: pass
        if chrome_proc is not None:
            chrome_proc.terminate()
            try: chrome_proc.wait(timeout=3)
            except Exception: chrome_proc.kill()
        if profile_dir is not None:
            shutil.rmtree(profile_dir, ignore_errors=True)


def run_repl(cdp, mode):
    import re
    print(f"\nBrowser remains running. Mode: {mode}.")
    print("Enter commands as Domain.method({...JSON params...}). Examples:")
    print('  Browser.getVersion({})')
    print('  Magic.evaluate({"expression": "chrome.tabs.query({active: true})"})')
    print('  Custom.TabIdFromTargetId({"targetId": "..."})')
    print("Type exit or quit to disconnect (browser keeps running).")
    cmd_re = re.compile(r"^([A-Za-z_]\w*\.[A-Za-z_]\w*)(?:\((.*)\))?$")
    while True:
        try:
            line = input("MagicCDP> ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            break
        if not line: continue
        if line in ("exit", "quit"): break
        try:
            m = cmd_re.match(line)
            if not m:
                raise ValueError("format: Domain.method({...JSON...})")
            method = m.group(1)
            raw = (m.group(2) or "").strip()
            params = json.loads(raw) if raw else {}
            result = cdp.send(method, params)
            print(json.dumps(result, indent=2))
        except Exception as e:
            print(f"error: {e}")


if __name__ == "__main__":
    sys.exit(main())
