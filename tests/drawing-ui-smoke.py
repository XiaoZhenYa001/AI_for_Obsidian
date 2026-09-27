from pathlib import Path
import os
from playwright.sync_api import sync_playwright
from ui_server import serve

root = Path(__file__).resolve().parents[1]
with serve(root) as base_url, sync_playwright() as p:
    browser = p.chromium.launch(headless=True, channel=os.environ.get("PLAYWRIGHT_CHANNEL") or None)
    page = browser.new_page(viewport={"width": 1100, "height": 1000})
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(base_url + "/.test-output/drawing.html")
    page.evaluate("void window.drawingFixture.open()")
    page.get_by_role("button", name="预览修改", exact=True).click()
    page.get_by_role("heading", name="在标题下添加待办").wait_for()
    assert page.evaluate("drawingFixture.state.commits") == 0
    page.get_by_role("textbox", name="预览文本").fill("确认后的待办")
    page.screenshot(path=str(root / ".test-output/drawing-preview.png"), full_page=True)
    page.get_by_role("button", name="应用修改", exact=True).click()
    page.wait_for_function("drawingFixture.state.result?.count === 1")
    assert page.evaluate("drawingFixture.state.elements.at(-1).text") == "确认后的待办"
    assert page.evaluate("drawingFixture.state.elements.at(-1).y") == 254
    page.evaluate("void window.drawingFixture.open()")
    page.get_by_role("button", name="预览修改", exact=True).click()
    page.get_by_role("heading", name="在标题下添加待办").wait_for()
    page.evaluate("drawingFixture.changeCanvas()")
    page.get_by_role("button", name="应用修改", exact=True).click()
    page.get_by_text("画布在预览期间发生了变化", exact=False).wait_for()
    assert page.evaluate("drawingFixture.state.commits") == 1
    page.get_by_role("button", name="关闭", exact=True).click()
    page.evaluate("void window.drawingFixture.open('直接文字')")
    page.locator("select").nth(1).select_option("text")
    page.get_by_role("spinbutton", name="x", exact=True).fill("-100")
    page.get_by_role("spinbutton", name="y", exact=True).fill("300")
    page.get_by_role("button", name="预览修改", exact=True).click()
    page.get_by_role("heading", name="插入文本").wait_for()
    page.get_by_role("button", name="关闭", exact=True).click()
    assert page.evaluate("drawingFixture.state.commits") == 1
    assert not errors, errors
    browser.close()
print("Drawing UI passed: preview, edited text, exact placement, stale-canvas rejection, cancellation.")
