from pathlib import Path
import os
from playwright.sync_api import sync_playwright
from ui_server import serve

root = Path(__file__).resolve().parents[1]
with serve(root) as base_url, sync_playwright() as p:
    browser = p.chromium.launch(headless=True, channel=os.environ.get("PLAYWRIGHT_CHANNEL") or None)
    page = browser.new_page(viewport={"width": 1150, "height": 920})
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(base_url + "/.test-output/drawing.html")
    page.wait_for_load_state("networkidle")
    page.get_by_role("textbox", name="对话输入").wait_for()

    def send(instruction):
        page.get_by_role("textbox", name="对话输入").fill(instruction)
        page.get_by_role("button", name="发送", exact=True).click()

    def preview():
        page.get_by_role("button", name="写入画布", exact=True).wait_for()
        assert page.locator(".ai-second-brain-drawing-panel").count() == 0
        assert page.get_by_role("spinbutton").count() == 0

    page.evaluate("drawingFixture.state.stall = true")
    send("/draw 在标题下面添加准备周会")
    page.get_by_text("正在生成画布修改…", exact=True).wait_for()
    assert page.evaluate("drawingFixture.state.elements.length") == 1
    assert not page.evaluate("drawingFixture.state.appState.viewModeEnabled")
    page.get_by_role("textbox", name="同文件源码").fill("仍然可以编辑源码")
    page.get_by_role("button", name="停止", exact=True).click()
    page.get_by_text("已停止生成，画布保持原样。", exact=True).wait_for()
    assert page.evaluate("drawingFixture.state.commits") == 0

    page.evaluate("drawingFixture.state.stall = false; drawingFixture.state.fail = true")
    send("添加准备周会")
    page.get_by_text("画布操作失败：模拟模型连接中断", exact=True).wait_for()
    assert page.evaluate("drawingFixture.state.commits") == 0
    page.evaluate("drawingFixture.state.fail = false")
    send("在标题下面添加准备周会")
    preview()
    assert page.evaluate("drawingFixture.state.elements.length") == 1
    send("再简短一点")
    preview()
    assert page.locator(".ai-second-brain-drawing-preview-text").inner_text() == "开会"
    assert page.evaluate("drawingFixture.state.lastPrompt.includes('尚未写入')")
    assert page.get_by_role("button", name="写入画布", exact=True).count() == 1
    page.get_by_role("button", name="放弃", exact=True).click()
    assert page.evaluate("drawingFixture.state.commits") == 0

    send("在标题下面添加准备周会")
    preview()
    page.screenshot(path=str(root / ".test-output/drawing-preview.png"), full_page=True)
    page.get_by_role("button", name="写入画布", exact=True).click()
    page.get_by_role("button", name="撤销本次写入", exact=True).wait_for()
    assert page.evaluate("drawingFixture.state.commits") == 1
    assert page.evaluate("drawingFixture.liveTexts") == ["项目计划", "准备周会"]
    page.get_by_role("button", name="撤销本次写入", exact=True).click()
    page.get_by_text("已撤销本次写入", exact=True).wait_for()
    assert page.evaluate("drawingFixture.liveTexts") == ["项目计划"]

    page.get_by_role("button", name="退出画布编辑", exact=True).click()
    calls = page.evaluate("drawingFixture.state.calls")
    page.evaluate("drawingFixture.state.appState.selectedElementIds.title = false; drawingFixture.state.appState.scrollX = 100")
    page.get_by_role("button", name="插入 Excalidraw 画布", exact=True).click()
    page.get_by_role("button", name="撤销本次写入", exact=True).wait_for()
    assert page.evaluate("drawingFixture.state.calls") == calls
    assert page.evaluate("drawingFixture.state.elements.at(-1).x") == 230
    assert page.evaluate("drawingFixture.state.elements.at(-1).y") == 350
    assert page.evaluate("drawingFixture.state.elements.at(-1).text") == "已经完成的回答\n无需再次请求模型"
    page.get_by_role("button", name="撤销本次写入", exact=True).click()
    page.wait_for_function("drawingFixture.liveTexts.length === 1")
    page.evaluate("drawingFixture.state.appState.selectedElementIds.title = true")

    send("/draw 在标题下面添加准备周会")
    preview()
    page.evaluate("drawingFixture.changeCanvas()")
    commits = page.evaluate("drawingFixture.state.commits")
    page.get_by_role("button", name="写入画布", exact=True).click()
    page.get_by_text("画布在预览期间发生了变化", exact=False).wait_for()
    assert page.evaluate("drawingFixture.state.commits") == commits
    assert page.evaluate("drawingFixture.liveTexts") == ["用户的新标题"]

    send("在标题下面添加准备周会")
    preview()
    page.evaluate("drawingFixture.state.activeFile = drawingFixture.plugin.app.vault.getFiles()[1]")
    page.get_by_role("button", name="写入画布", exact=True).click()
    page.get_by_role("button", name="撤销本次写入", exact=True).wait_for()
    assert page.evaluate("drawingFixture.state.otherElements.length") == 1
    page.get_by_role("button", name="撤销本次写入", exact=True).click()
    page.wait_for_function("drawingFixture.liveTexts.length === 1")

    send("在标题下面添加准备周会")
    preview()
    page.evaluate("drawingFixture.switchSession('other-chat')")
    page.wait_for_function("drawingFixture.plugin.settings.activeChatSessionId === 'other-chat'")
    page.evaluate("drawingFixture.switchSession('chat')")
    page.get_by_text("预览已失效，请重新生成", exact=True).first.wait_for()
    assert page.get_by_role("button", name="写入画布", exact=True).count() == 0
    assert page.locator(".ai-second-brain-drawing-context").is_hidden()

    page.evaluate("drawingFixture.state.activeFile = null; drawingFixture.state.scopeFile = null")
    page.get_by_role("button", name="编辑 Excalidraw 画布", exact=False).click()
    page.get_by_role("button", name="其他.excalidraw.md", exact=True).click()
    send("添加准备周会")
    preview()
    assert page.evaluate("drawingFixture.state.lastPrompt.includes('目标文件：其他.excalidraw.md')")

    page.evaluate("""() => {
        drawingFixture.plugin.chatService.sendMessage = async () => ({content: JSON.stringify({summary: '原样显示文本', edits: [{type: 'add-text', x: 100, y: 240, text: '**保留标记** <img src=x>'}]})});
    }""")
    send("继续调整预览")
    preview()
    assert page.locator(".ai-second-brain-drawing-preview-text").inner_text() == "**保留标记** <img src=x>"
    assert page.locator(".ai-second-brain-drawing-preview img").count() == 0

    for width in (320, 550):
        page.set_viewport_size({"width": width, "height": 920})
        assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")
        page.screenshot(path=str(root / f".test-output/drawing-chat-{width}.png"), full_page=True)
    page.set_viewport_size({"width": 1150, "height": 920})
    page.emulate_media(color_scheme="dark")
    page.screenshot(path=str(root / ".test-output/drawing-chat-dark.png"), full_page=True)
    page.get_by_role("button", name="放弃", exact=True).click()
    page.evaluate("""() => {
        drawingFixture.plugin.chatService.sendMessage = async (_prompt, {signal}) => {
            await new Promise(resolve => signal.addEventListener('abort', resolve, {once:true}));
            return {content: JSON.stringify({edits:[{type:'add-text',x:100,y:240,text:'关闭后不能写入'}]})};
        };
    }""")
    send("添加新文本")
    page.get_by_text("正在生成画布修改…", exact=True).wait_for()
    commits = page.evaluate("drawingFixture.state.commits")
    page.evaluate("drawingFixture.close()")
    page.wait_for_function("!drawingFixture.view.isGenerating")
    assert page.evaluate("drawingFixture.state.commits") == commits
    assert page.get_by_role("button", name="写入画布", exact=True).count() == 0
    assert not errors, errors
    browser.close()
print("Drawing chat UI passed: no live writes/locks, stop/failure, refinement, discard, apply/undo, direct insertion, stale canvas, fixed target, session switch, explicit picker, narrow/dark layout.")
