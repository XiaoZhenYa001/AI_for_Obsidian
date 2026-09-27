from pathlib import Path
import json
import os
from playwright.sync_api import sync_playwright
from ui_server import serve

root = Path(__file__).resolve().parents[1]
with serve(root) as base_url, sync_playwright() as p:
    browser = p.chromium.launch(headless=True, channel=os.environ.get("PLAYWRIGHT_CHANNEL") or None)
    page = browser.new_page(viewport={"width": 1000, "height": 600})
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(base_url + "/.test-output/composer.html")
    page.wait_for_load_state("networkidle")
    widths = []
    for width in (320, 550, 900):
        page.evaluate("width => composerFixture.setWidth(width)", width)
        metrics = page.evaluate("""() => {
            const input = document.querySelector('.ai-second-brain-input').getBoundingClientRect();
            const composer = document.querySelector('.ai-second-brain-composer').getBoundingClientRect();
            const send = document.querySelector('.ai-second-brain-send').getBoundingClientRect();
            return { inputWidth: input.width, composerWidth: composer.width, inputBottom: input.bottom, sendTop: send.top, overflow: document.querySelector('.composer-fixture').scrollWidth > composer.width };
        }""")
        widths.append({"width": width, **metrics})
        page.screenshot(path=str(root / f".test-output/composer-{width}.png"))
    print(json.dumps(widths))
    for metrics in widths:
        assert metrics["inputWidth"] >= metrics["composerWidth"] - 30, metrics
        assert metrics["sendTop"] >= metrics["inputBottom"], metrics
        assert not metrics["overflow"], metrics
    page.get_by_role("textbox").fill("在指定位置添加文字")
    page.get_by_role("button", name="发送", exact=True).click()
    page.get_by_role("button", name="编辑 Excalidraw 画布", exact=False).click()
    page.evaluate("composerFixture.setGenerating(true)")
    page.get_by_role("button", name="停止", exact=True).click()
    assert page.evaluate("composerFixture.events") == [
        {"type": "send", "instruction": "在指定位置添加文字"},
        {"type": "drawing", "instruction": "在指定位置添加文字"},
        {"type": "stop"}
    ]
    assert not errors, errors
    browser.close()
print("Composer UI passed: 320/550/900 px input width, no overflow, send/drawing/stop actions.")
