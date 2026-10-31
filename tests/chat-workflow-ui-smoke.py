from pathlib import Path
import os
from playwright.sync_api import sync_playwright, expect
from ui_server import serve

root = Path(__file__).resolve().parents[1]
with serve(root) as base_url, sync_playwright() as p:
    browser = p.chromium.launch(headless=True, channel=os.environ.get("PLAYWRIGHT_CHANNEL") or None)
    page = browser.new_page(viewport={"width": 1200, "height": 900})
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(base_url + "/.test-output/chat-workflow.html")
    page.wait_for_load_state("networkidle")
    input_box = page.get_by_role("textbox", name="对话输入", exact=True)
    expect(page.get_by_role("button", name="发送", exact=True)).to_be_disabled()
    for theme in ("light", "dark"):
        page.emulate_media(color_scheme=theme)
        for width in (280, 320, 550, 900):
            page.evaluate("width => chatFixture.setWidth(width)", width)
            assert page.locator(".ai-second-brain-view").evaluate("el => el.scrollWidth <= el.clientWidth"), (theme, width)
            assert page.locator(".ai-second-brain-header").evaluate("el => el.scrollWidth <= el.clientWidth"), (theme, width)
            assert page.locator(".ai-second-brain-composer").evaluate("el => el.scrollWidth <= el.clientWidth"), (theme, width)
            assert page.locator(".ai-second-brain-message-actions").first.locator("button").count() == 3
            page.screenshot(path=str(root / f".test-output/chat-{theme}-{width}.png"))
    page.evaluate("chatFixture.setWidth(350)")
    page.emulate_media(color_scheme="light")
    page.get_by_role("button", name="选择模型：", exact=False).click()
    page.get_by_role("button", name="本地服务 · local-model", exact=True).click()
    expect(page.get_by_role("button", name="选择模型：本地服务 · local-model", exact=True)).to_be_visible()
    page.get_by_role("button", name="选择 AI 可访问", exact=False).click()
    page.get_by_role("button", name="范围 · 本地资料", exact=True).click()
    expect(page.locator(".ai-second-brain-scope-picker-label")).to_contain_text("仅本地")
    page.get_by_role("button", name="选择 AI 可访问", exact=False).click()
    page.get_by_role("button", name="查看已授权文件", exact=True).click()
    expect(page.get_by_role("heading", name="已授权文件", exact=True)).to_be_visible()
    page.evaluate("document.querySelector('.modal').remove()")
    # HTML remains discoverable while its preview is disabled and reuses the saved file.
    html_button = page.get_by_role("button", name="保存 HTML 并预览", exact=True)
    html_button.click()
    assert page.evaluate("chatFixture.state.settingsOpened") == 1
    page.evaluate("chatFixture.plugin.settings.enableHtmlPreview = true")
    html_button.click()
    page.wait_for_function("chatFixture.state.previews.length === 1")
    html_button.click()
    page.wait_for_function("chatFixture.state.previews.length === 2")
    assert page.evaluate("chatFixture.state.previews[0] === chatFixture.state.previews[1]")
    # Closing and reopening the sidebar and switching chats preserve separate drafts.
    input_box.fill("尚未发送的草稿")
    page.evaluate("chatFixture.reopen()")
    expect(input_box).to_have_value("尚未发送的草稿")
    page.evaluate("chatFixture.switchSession('other')")
    expect(input_box).to_have_value("")
    input_box.fill("另一段草稿")
    page.evaluate("chatFixture.switchSession('chat')")
    expect(input_box).to_have_value("尚未发送的草稿")
    input_box.fill("给出下一步")
    input_box.press("Control+Enter")
    page.wait_for_function("chatFixture.state.calls === 1 && !chatFixture.view.isGenerating")
    assert page.evaluate("chatFixture.state.requests[0].provider") == "local"
    expect(input_box).to_have_value("")
    expect(page.get_by_role("button", name="发送", exact=True)).to_be_disabled()
    page.evaluate("chatFixture.state.stall = true")
    input_box.fill("等待回答")
    page.get_by_role("button", name="发送", exact=True).click()
    expect(page.get_by_role("button", name="发送", exact=True)).to_be_hidden()
    page.get_by_role("button", name="停止", exact=True).click()
    page.wait_for_function("!chatFixture.view.isGenerating")
    expect(input_box).to_be_enabled()
    page.evaluate("chatFixture.state.stall = false")
    # Cancellation keeps messages; confirmation clears them.
    page.get_by_role("button", name="对话与工具", exact=True).click()
    page.get_by_role("button", name="清空当前对话", exact=True).click()
    page.get_by_role("button", name="取消", exact=True).click()
    assert page.locator(".ai-second-brain-message").count() > 0
    page.get_by_role("button", name="对话与工具", exact=True).click()
    page.get_by_role("button", name="清空当前对话", exact=True).click()
    page.get_by_role("button", name="确认清空", exact=True).click()
    expect(page.locator(".ai-second-brain-message")).to_have_count(0)
    # A new conversation opens directly and health reports expose all findings.
    input_box.fill("保留旧对话草稿")
    page.get_by_role("button", name="新对话", exact=True).click()
    expect(input_box).to_have_value("")
    expect(page.get_by_role("button", name="切换对话：新对话", exact=True)).to_be_visible()
    assert page.locator(".modal").count() == 0
    page.get_by_role("button", name="对话与工具", exact=True).click()
    page.get_by_role("button", name="知识库健康检查", exact=True).click()
    expect(page.get_by_role("heading", name="知识库健康检查", exact=True)).to_be_visible()
    expect(page.locator("summary").filter(has_text="缺少 Front Matter")).to_be_visible()
    first_section = page.locator(".ai-second-brain-health-section").first
    first_section.get_by_role("button", name="显示更多", exact=False).click()
    assert first_section.locator(".ai-second-brain-health-note").count() == 25
    page.evaluate("document.querySelector('.modal').remove(); chatFixture.state.stall = true; chatFixture.openGeneration()")
    page.locator(".ai-second-brain-generate-form textarea").fill("生成本周计划")
    page.get_by_role("button", name="生成预览", exact=True).click()
    page.get_by_role("button", name="停止生成", exact=True).click()
    expect(page.locator(".ai-second-brain-generate-preview")).to_contain_text("已停止生成")
    page.get_by_role("button", name="生成预览", exact=True).click()
    page.wait_for_function("chatFixture.state.generationCalls === 2")
    page.evaluate("chatFixture.closeGeneration()")
    assert page.evaluate("chatFixture.generationAborted()")
    page.evaluate("chatFixture.state.stall = false")
    # Settings categories remain collapsible and navigation opens the target.
    page.evaluate("chatFixture.openSettings()")
    expect(page.locator("#ai-second-brain-settings-providers")).to_have_attribute("open", "")
    expect(page.locator("#ai-second-brain-settings-html")).not_to_have_attribute("open", "")
    expect(page.locator(".ai-second-brain-authorized-preview")).not_to_have_attribute("open", "")
    page.locator(".ai-second-brain-authorized-preview > summary").click()
    expect(page.locator(".ai-second-brain-authorized-file")).to_have_count(6)
    page.locator(".ai-second-brain-authorized-preview > summary").click()
    page.get_by_role("navigation", name="设置分类").get_by_role("button", name="HTML", exact=True).click()
    expect(page.locator("#ai-second-brain-settings-html")).to_have_attribute("open", "")
    for theme in ("light", "dark"):
        page.emulate_media(color_scheme=theme, reduced_motion="reduce")
        for width in (320, 900):
            page.set_viewport_size({"width": width + 24, "height": 900})
            page.evaluate("window.scrollTo({top: 0, behavior: 'instant'})")
            assert page.locator(".fixture-settings").bounding_box()["width"] <= width + 24
            assert page.locator(".fixture-settings").evaluate("el => el.scrollWidth <= el.clientWidth"), (theme, width)
            page.screenshot(path=str(root / f".test-output/settings-{theme}-{width}.png"))
    assert not errors, errors
    browser.close()
print("Chat workflow passed: 280/320/550/900 px, both themes, model/scope selection, HTML save, drafts, shortcuts, stop, clear confirmation, new chat, full health results, responsive settings navigation.")
