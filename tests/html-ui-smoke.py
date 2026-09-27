from pathlib import Path
import os
from playwright.sync_api import sync_playwright, expect
from ui_server import QuietHandler, serve

root = Path(__file__).resolve().parents[1]
online = []


class ResourceHandler(QuietHandler):
    def do_GET(self):
        if not self.path.startswith('/remote/'):
            return super().do_GET()
        online.append(self.path)
        is_image = self.path.endswith('.svg')
        body = ('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"></svg>' if is_image else '{}').encode()
        self.send_response(200)
        self.send_header('Content-Type', 'image/svg+xml' if is_image else 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


with serve(root, ResourceHandler) as base_url, sync_playwright() as p:
    browser = p.chromium.launch(headless=True, channel=os.environ.get("PLAYWRIGHT_CHANNEL") or None)
    page = browser.new_page(viewport={"width": 1100, "height": 800})
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(base_url + "/.test-output/html.html")
    page.evaluate("htmlFixture.open()")
    frame = page.frame_locator('iframe[title="HTML 互动预览"]').frame_locator('iframe[title="HTML 页面内容"]')
    expect(frame.get_by_role("heading", name="交互式 HTML 预览")).to_be_visible()
    frame.get_by_role("button", name="增加计数").click()
    expect(frame.locator("#count")).to_have_text("1")
    expect(frame.locator("#count")).to_have_css("color", "rgb(12, 100, 180)")
    expect(frame.locator("body")).to_have_attribute("data-parent-access", "blocked")
    expect(frame.locator("body")).to_have_attribute("data-node", "undefined")
    expect(frame.locator("body")).to_have_attribute("data-network", "blocked")
    assert frame.locator("#local-image").evaluate("image => image.complete && image.naturalWidth > 0")
    assert online == []
    assert page.locator("iframe").get_attribute("sandbox") == "allow-scripts allow-same-origin"
    assert page.frame_locator('iframe[title="HTML 互动预览"]').locator("iframe").get_attribute("sandbox") == "allow-scripts"
    page.screenshot(path=str(root / ".test-output/html-preview.png"), full_page=True)
    page.get_by_role("button", name="源码", exact=True).click()
    expect(page.get_by_role("textbox", name="HTML 源码（只读）")).to_have_value(__import__('re').compile('.*交互式 HTML 预览.*', __import__('re').S))
    page.get_by_role("button", name="预览", exact=True).click()
    page.evaluate("htmlFixture.changeStyle()")
    expect(frame.locator("#count")).to_have_css("color", "rgb(180, 20, 30)")
    page.evaluate("htmlFixture.changeSource()")
    expect(frame.get_by_role("heading", name="自动刷新成功")).to_be_visible()
    page.get_by_role("checkbox", name="允许在线资源").check()
    expect(frame.locator("body")).to_have_attribute("data-network", "allowed")
    expect(frame.locator("body")).to_have_attribute("data-parent-access", "blocked")
    assert online
    assert page.locator("body").get_attribute("data-exposed") is None
    page.evaluate("htmlFixture.close()")
    assert page.locator("iframe").count() == 0
    assert not errors, errors
    browser.close()
print("HTML UI passed: inline interaction, relative CSS/JS/image, source, auto-refresh, network opt-in, host isolation, cleanup.")
