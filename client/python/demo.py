"""Python demo for MagicCDPClient. Mirrors client/js/demo.mjs.

Modes (mirror the JS / Go demos):
    --direct      *.* -> direct_cdp on the client.
    --loopback    *.* -> service_worker on the client; *.* -> loopback_cdp on
                  the server.
    --debugger    *.* -> service_worker on the client; *.* -> chrome_debugger
                  on the server.
"""

import json
import os
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
EXTENSION_PATH = ROOT / "extension"
CHROME = os.environ.get("CHROME_PATH", "/opt/pw-browsers/chromium-1194/chrome-linux/chrome")


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
    if mode == "direct":
        return {
            "cdp_url": cdp_url,
            "extension_path": str(EXTENSION_PATH),
            "routes": {"Magic.*": "service_worker", "Custom.*": "service_worker", "*.*": "direct_cdp"},
        }
    return {
        "cdp_url": cdp_url,
        "extension_path": str(EXTENSION_PATH),
        "routes": {"Magic.*": "service_worker", "Custom.*": "service_worker", "*.*": "service_worker"},
        "server": {
            "routes": {
                "Magic.*": "service_worker",
                "Custom.*": "service_worker",
                "*.*": "loopback_cdp" if mode == "loopback" else "chrome_debugger",
            },
            "loopback_cdp_url": cdp_url if mode == "loopback" else None,
        },
    }


def main():
    flags = {a[2:] for a in sys.argv[1:] if a.startswith("--")}
    mode = "debugger" if "debugger" in flags else "loopback" if "loopback" in flags else "direct"
    print(f"== mode: {mode} ==")

    chrome_port = free_port()
    profile_dir = tempfile.mkdtemp(prefix="magic-cdp-py.")
    chrome_proc = subprocess.Popen([
        CHROME,
        "--headless=new", "--no-sandbox", "--disable-gpu",
        "--enable-unsafe-extension-debugging", "--remote-allow-origins=*",
        "--no-first-run", "--no-default-browser-check",
        f"--remote-debugging-port={chrome_port}",
        f"--user-data-dir={profile_dir}",
        f"--load-extension={EXTENSION_PATH}",
        "about:blank",
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    cdp_url = f"http://127.0.0.1:{chrome_port}"
    wait_for_url(f"{cdp_url}/json/version")
    print(f"upstream cdp: {cdp_url}")

    cdp = MagicCDPClient(**client_options_for(mode, cdp_url))
    events = []
    events_lock = threading.Lock()

    def on_demo(payload):
        print(f"event -> {payload}")
        with events_lock:
            events.append(payload)
    cdp.on("Custom.demo", on_demo)

    try:
        cdp.connect()
        print(f"connected; ext {cdp.extension_id} session {cdp.session_id}")

        try: print(f"Browser.getVersion -> {cdp.send('Browser.getVersion')}")
        except Exception as e: print(f"Browser.getVersion -> (rejected by route: {str(e).splitlines()[0]} )")

        print(f"Magic.evaluate     -> {cdp.send('Magic.evaluate', {'expression': 'async () => ({ extensionId: chrome.runtime.id })'})}")

        cdp.send("Magic.addCustomEvent", {"name": "Custom.demo"})
        cdp.send("Magic.addCustomCommand", {
            "name": "Custom.echo",
            "expression": "async (params, { cdp }) => { await cdp.emit('Custom.demo', { echo: params.value }); return { echoed: params.value }; }",
        })
        print(f"Custom.echo        -> {cdp.send('Custom.echo', {'value': f'hello-from-py-{mode}'})}")
        print(f"Custom.echo        -> {cdp.send('Custom.echo', {'value': f'second-{mode}'})}")

        deadline = time.monotonic() + 3.0
        while True:
            with events_lock:
                if len(events) >= 2: break
            if time.monotonic() >= deadline: break
            time.sleep(0.02)
        if len(events) < 2:
            raise RuntimeError(f"expected >=2 Custom.demo events, got {len(events)}")
        print(f"\nSUCCESS ({mode}): {len(events)} events")
        return 0
    finally:
        cdp.close()
        chrome_proc.terminate()
        try: chrome_proc.wait(timeout=3)
        except Exception: chrome_proc.kill()
        subprocess.run(["rm", "-rf", profile_dir], check=False)


if __name__ == "__main__":
    sys.exit(main())
