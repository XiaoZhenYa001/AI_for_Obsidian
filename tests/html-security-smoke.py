"""Chrome enforcement checks with real HTTP request logs, including positive controls."""
from pathlib import Path
import json
import os
import subprocess
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright, expect
from ui_server import QuietHandler, serve


class SecurityHandler(QuietHandler):
    requests = []

    def do_GET(self):
        path = urlsplit(self.path).path
        if path in ("/fetch", "/nav"):
            self.requests.append(self.path)
            body = b"<!doctype html><h1>network destination</h1>"
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            super().do_GET()


root = Path(__file__).resolve().parents[1]
out = root / ".test-output"
out.mkdir(exist_ok=True)
subprocess.run(["node", "-e", "require('esbuild').buildSync({entryPoints:['tests/ui/html-security-harness.ts'],bundle:true,format:'iife',outfile:'.test-output/html-security.js',alias:{obsidian:require('path').resolve('tests/ui/obsidian.ts')}})"], cwd=root, check=True)
(out / "html-security.html").write_text('<!doctype html><meta charset="utf-8"><script defer src="html-security.js"></script><body></body>', encoding="utf-8")

with serve(out, SecurityHandler) as origin, sync_playwright() as p:
    browser = p.chromium.launch(headless=True, channel=os.environ.get("PLAYWRIGHT_CHANNEL") or None)
    try:
        page = browser.new_page()
        page.goto(f"{origin}/html-security.html")
        source = """<!doctype html><style>body{color:rgb(1, 2, 3)}</style><body><button onclick="this.textContent='clicked'">run</button><script>
document.body.dataset.ready='yes';
try { parent.document.body.dataset.exposed='yes'; document.body.dataset.parentAccess='allowed'; } catch { document.body.dataset.parentAccess='blocked'; }
fetch(FETCH_URL, {cache:'no-store'}).then(()=>document.body.dataset.network='allowed').catch(()=>document.body.dataset.network='blocked');
</script></body>""".replace("FETCH_URL", json.dumps(f"{origin}/fetch"))
        page.evaluate("htmlSecurityFixture.open", source)
        outer = page.frame_locator('iframe[title="HTML 互动预览"]')
        inner = outer.frame_locator('iframe[title="HTML 页面内容"]')
        expect(inner.locator("body")).to_have_attribute("data-ready", "yes")
        expect(inner.locator("body")).to_have_attribute("data-network", "blocked")
        expect(inner.locator("body")).to_have_attribute("data-parent-access", "blocked")
        expect(inner.locator("body")).to_have_css("color", "rgb(1, 2, 3)")
        inner.get_by_role("button", name="run", exact=True).click()
        expect(inner.get_by_role("button")).to_have_text("clicked")
        assert SecurityHandler.requests == [], SecurityHandler.requests

        # Each fresh preview runs the attempted navigation as real page script.
        # Local server records requests even if Chromium replaces the frame with
        # an error document, where page.route can miss a navigation request.
        navigation_methods = (
            "location.href=URL",
            "location.replace(URL)",
            "const a=document.createElement('a'); a.href=URL; document.body.append(a); a.click()",
            "const m=document.createElement('meta'); m.httpEquiv='refresh'; m.content='0;url='+URL; document.head.append(m)",
            "parent.location.href=URL",
            "top.location.href=URL",
        )
        for network in (False, True):
            if network:
                page.get_by_role("checkbox", name="允许在线资源").check()
                expect(inner.locator("body")).to_have_attribute("data-network", "allowed")
                assert any(urlsplit(path).path == "/fetch" for path in SecurityHandler.requests), "Positive network control did not reach the server"
            for index, method in enumerate(navigation_methods):
                expect(inner.locator("body")).to_have_attribute("data-ready", "yes")
                destination = json.dumps(f"{origin}/nav?network={network}&method={index}")
                code = "document.body.dataset.attempted='yes'; try { " + method.replace("URL", destination) + " } catch (error) { document.body.dataset.navigationError=error.name; }"
                inner.locator("body").evaluate("(body, code) => { const script=document.createElement('script'); script.textContent=code; body.append(script); }", code)
                page.wait_for_timeout(300)
                assert not any(urlsplit(path).path == "/nav" for path in SecurityHandler.requests), SecurityHandler.requests
                assert page.url == f"{origin}/html-security.html", "Sandbox allowed top-level navigation"
                assert page.locator("body").get_attribute("data-exposed") is None
                page.get_by_role("button", name="刷新", exact=True).click()
                expect(inner.locator("body")).to_have_attribute("data-ready", "yes")

        # Attempts to close the srcdoc attribute / iframe must execute only in
        # the opaque user document, never as part of the trusted wrapper.
        malicious = '''<!doctype html><body>" ></iframe><script>
try { top.document.body.dataset.escaped='yes'; } catch { document.body.dataset.escape='blocked'; }
</script><p title='&quot;></iframe><script>top.document.body.dataset.escaped="yes"</script>'>escaped attribute</p></body>'''
        page.evaluate("htmlSecurityFixture.setSource", malicious)
        page.get_by_role("button", name="刷新", exact=True).click()
        expect(inner.locator("body")).to_have_attribute("data-escape", "blocked")
        assert page.locator("body").get_attribute("data-escaped") is None
        assert outer.locator("iframe").count() == 1
        assert outer.locator("script").count() == 0

        # Keep an interval running in the online document. After revocation,
        # delayed vault I/O must not leave that old document executing scripts.
        ticking_source = source.replace("</script>", "setInterval(()=>top.postMessage({htmlSecurityTick:true}, '*'), 20);</script>")
        page.evaluate("htmlSecurityFixture.setSource", ticking_source)
        page.get_by_role("button", name="刷新", exact=True).click()
        expect(inner.locator("body")).to_have_attribute("data-network", "allowed")
        page.wait_for_function("htmlSecurityFixture.tickCount > 2")
        page.evaluate("window.oldPreviewFrame=document.querySelector('iframe'); htmlSecurityFixture.blockReads()")
        page.get_by_role("checkbox", name="允许在线资源").uncheck()
        assert page.evaluate("!oldPreviewFrame.isConnected")
        assert outer.locator("iframe").count() == 0
        page.wait_for_timeout(100)  # Drain messages queued before destruction.
        ticks = page.evaluate("htmlSecurityFixture.tickCount")
        requests = len(SecurityHandler.requests)
        page.wait_for_timeout(150)
        assert page.evaluate("htmlSecurityFixture.tickCount") == ticks, "Revoked document still executes"
        page.evaluate("htmlSecurityFixture.releaseReads()")
        expect(inner.locator("body")).to_have_attribute("data-network", "blocked")
        assert len(SecurityHandler.requests) == requests, "Revoked network permission still issued requests"
        assert not any(urlsplit(path).path == "/nav" for path in SecurityHandler.requests)
    finally:
        browser.close()

print("HTML security passed: local HTTP positive control; offline fetch blocking; six navigation methods blocked offline/online; wrapper escaping; opaque parent; immediate old-document destruction.")
