"""End-to-end demo: stock Playwright Python connecting through the same JS
MagicCDPBridge that the Node demo uses, against a real local Chromium.

What this proves:
  - chromium.connect_over_cdp(...) works against the JS proxy unchanged.
  - cdp_session.send('Magic.*' / 'Custom.*', ...) works from Python.
  - cdp_session.on('Custom.*', handler) receives binding events from the SW.

The chrome + proxy lifecycle here intentionally mirrors playwright-demo.mjs:
  - Launch upstream Chromium with --load-extension (workaround for the
    Playwright-bundled chromium build that doesn't implement
    Extensions.loadUnpacked over CDP).
  - Spawn `node proxy.mjs --upstream <url> --port <free>`.
  - Connect Playwright Python via connect_over_cdp through the proxy.

Nothing about playwright python needed any patching.
"""

import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent
EXTENSION_PATH = ROOT / "extension"
CHROME = os.environ.get("CHROME_PATH", "/opt/pw-browsers/chromium-1194/chrome-linux/chrome")


def free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def wait_for_url(url: str, timeout_s: float = 8.0) -> dict:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=0.5) as response:
                return json.loads(response.read())
        except Exception:
            time.sleep(0.05)
    raise RuntimeError(f"timeout waiting for {url}")


def main() -> int:
    events: list[dict] = []
    chrome_proc = None
    proxy_proc = None
    profile_dir = tempfile.mkdtemp(prefix="magic-cdp-py.")

    try:
        # 1. launch upstream Chromium with the extension preloaded
        chrome_port = free_port()
        print(f"== launching upstream Chromium at port {chrome_port}")
        chrome_proc = subprocess.Popen(
            [
                CHROME,
                "--headless=new",
                "--no-sandbox",
                "--disable-gpu",
                "--enable-unsafe-extension-debugging",
                "--remote-allow-origins=*",
                "--no-first-run",
                "--no-default-browser-check",
                f"--remote-debugging-port={chrome_port}",
                f"--user-data-dir={profile_dir}",
                f"--load-extension={EXTENSION_PATH}",
                "about:blank",
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        chrome_url = f"http://127.0.0.1:{chrome_port}"
        version = wait_for_url(f"{chrome_url}/json/version")
        print(f"upstream chromium up: {version['Browser']}")

        # 2. spawn the JS proxy in front of that Chromium
        proxy_port = free_port()
        proxy_url = f"http://127.0.0.1:{proxy_port}"
        print(f"\n== spawning MagicCDPBridge at {proxy_url}")
        proxy_proc = subprocess.Popen(
            ["node", str(ROOT / "proxy.mjs"), "--upstream", chrome_url, "--port", str(proxy_port)],
            stdout=sys.stdout,
            stderr=sys.stderr,
        )
        wait_for_url(f"{proxy_url}/json/version")

        # 3. connect Playwright Python via connect_over_cdp
        print("\n== connecting Playwright Python via connect_over_cdp through proxy ==")
        with sync_playwright() as p:
            browser = p.chromium.connect_over_cdp(proxy_url)
            print(f"playwright connected. contexts: {len(browser.contexts)}")
            ctx = browser.contexts[0] if browser.contexts else browser.new_context()
            page = ctx.pages[0] if ctx.pages else ctx.new_page()
            print(f"page url: {page.url}")

            # vanilla Playwright Python CDPSession scoped to a page target
            session = ctx.new_cdp_session(page)

            print("\n== prove standard CDP still works through the proxy ==")
            ver = session.send("Browser.getVersion")
            print(f"Browser.getVersion -> {ver}")

            print("\n== Magic.evaluate from a vanilla Playwright Python CDPSession ==")
            info = session.send("Magic.evaluate", {
                "expression": "async () => ({ extensionId: chrome.runtime.id, swUrl: chrome.runtime.getURL('service_worker.js') })",
            })
            print(f"Magic.evaluate result -> {info}")

            print("\n== Magic.addCustomEvent + session.on('Custom.demo', ...) ==")
            session.send("Magic.addCustomEvent", {"name": "Custom.demo"})

            def on_demo(payload):
                print(f"PYTHON RECEIVED Custom.demo -> {payload}")
                events.append(payload)
            session.on("Custom.demo", on_demo)

            print("\n== Magic.addCustomCommand: Custom.echo emits Custom.demo ==")
            session.send("Magic.addCustomCommand", {
                "name": "Custom.echo",
                "expression": (
                    "async (params, { cdp }) => { "
                    "  await cdp.emit('Custom.demo', { echo: params.value, ts: Date.now() }); "
                    "  return { ok: true, echoed: params.value }; "
                    "}"
                ),
            })

            print("\n== Custom.echo (custom command) sent from Playwright Python ==")
            echo1 = session.send("Custom.echo", {"value": "hello-from-python"})
            print(f"Custom.echo result -> {echo1}")
            echo2 = session.send("Custom.echo", {"value": "second-roundtrip-py"})
            print(f"Custom.echo result -> {echo2}")

            deadline = time.monotonic() + 3
            while len(events) < 2 and time.monotonic() < deadline:
                time.sleep(0.02)

            print("\n== summary ==")
            print(f"events received: {events}")
            assert len(events) >= 2, f"expected >=2 Custom.demo events, got {len(events)}"
            assert echo1["echoed"] == "hello-from-python", "echo1 did not roundtrip"
            assert echo2["echoed"] == "second-roundtrip-py", "echo2 did not roundtrip"

            print("\nSUCCESS: Playwright Python CDPSession sent Magic commands and received Magic events through the proxy.")
            browser.close()
        return 0
    finally:
        if proxy_proc is not None:
            proxy_proc.terminate()
            try: proxy_proc.wait(timeout=3)
            except Exception: proxy_proc.kill()
        if chrome_proc is not None:
            chrome_proc.terminate()
            try: chrome_proc.wait(timeout=3)
            except Exception: chrome_proc.kill()
        try: subprocess.run(["rm", "-rf", profile_dir], check=False)
        except Exception: pass


if __name__ == "__main__":
    sys.exit(main())
