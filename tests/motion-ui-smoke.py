from pathlib import Path
import os
from playwright.sync_api import sync_playwright, expect
from ui_server import serve

root = Path(__file__).resolve().parents[1]
with serve(root) as base_url, sync_playwright() as p:
    browser = p.chromium.launch(headless=True, channel=os.environ.get('PLAYWRIGHT_CHANNEL') or None)
    page = browser.new_page(viewport={'width': 1200, 'height': 900})
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(base_url + '/.test-output/motion.html')
    page.wait_for_load_state('networkidle')

    # Mermaid tabs expose selection and keyboard navigation to assistive technology.
    page.evaluate('window.mermaidRoot = createMermaidFixture()')
    tabs = page.get_by_role('tablist', name='Mermaid 图表视图')
    preview = tabs.get_by_role('tab', name='预览')
    source = tabs.get_by_role('tab', name='源代码')
    preview.focus()
    preview.press('ArrowRight')
    expect(source).to_be_focused()
    expect(source).to_have_attribute('aria-selected', 'true')
    expect(page.locator('#' + source.get_attribute('aria-controls'))).to_be_visible()
    source.press('Home')
    expect(preview).to_be_focused()
    page.evaluate('mermaidRoot.remove()')

    # Rebuilding chat keeps focus on an existing message action.
    page.wait_for_selector('.ai-second-brain-message-actions button')
    page.evaluate('''() => {
      const button = document.querySelector('.ai-second-brain-message-actions button');
      button.focus();
      chatFixture.view.renderMessages(false);
    }''')
    assert page.evaluate('document.activeElement.classList.contains("ai-second-brain-icon-button")')

    # Keyboard submit never restarts animations on historical action bars.
    page.evaluate('''async () => {
      const messages = chatFixture.plugin.getActiveChatSession().messages;
      for (let i=0;i<18;i++) messages.push({role:'assistant',content:'History '+i,status:'complete',createdAt:new Date().toISOString()});
      await chatFixture.reopen();
      window.actionStarts = 0;
      document.addEventListener('animationstart', e => {
        if(e.animationName === 'ai-second-brain-actions-enter') window.actionStarts++;
      });
      chatFixture.state.stall = true;
    }''')
    assert page.locator('.ai-second-brain-message-actions').count() == 20
    page.get_by_role('textbox', name='对话输入', exact=True).fill('Check keyboard feedback')
    page.get_by_role('textbox', name='对话输入', exact=True).press('Control+Enter')
    page.wait_for_function('chatFixture.view.isGenerating')
    page.wait_for_timeout(200)
    assert page.evaluate('window.actionStarts') == 0
    assert page.locator('.ai-second-brain-message-actions').first.evaluate('el => getComputedStyle(el).animationName') == 'none'
    page.get_by_role('button', name='停止', exact=True).click()
    page.wait_for_function('!chatFixture.view.isGenerating')

    # Prepending history retains existing nodes and their position through delayed renders.
    page.evaluate('''async () => {
      const messages = chatFixture.plugin.getActiveChatSession().messages;
      for (let i=0;i<130;i++) messages.push({role:'assistant',content:('Earlier '+i+'\\n').repeat(6),status:'complete',createdAt:new Date().toISOString()});
      await chatFixture.reopen();
    }''')
    page.wait_for_timeout(100)
    page.evaluate('''() => {
      const list = chatFixture.view.messagesEl;
      list.scrollTop = 0;
      window.historyAnchor = list.querySelector('.ai-second-brain-message-group');
      window.anchorTop = historyAnchor.getBoundingClientRect().top;
      window.renderCount = motionFixture.markdownCalls;
      motionFixture.pauseMarkdown();
    }''')
    page.get_by_role('button', name='加载更早的消息', exact=True).click()
    assert page.locator('.ai-second-brain-message-group').count() == 120, (
        page.locator('.ai-second-brain-message-group').count(), errors,
        page.evaluate('({visible:chatFixture.view.viewVisible, count:chatFixture.view.visibleMessageCount, total:chatFixture.view.messages.length, pending:chatFixture.view.pendingFullRender})'))
    assert page.evaluate('historyAnchor.isConnected')
    assert page.evaluate('Math.abs(historyAnchor.getBoundingClientRect().top - anchorTop)') <= 1
    assert page.evaluate('motionFixture.markdownCalls - renderCount') == 60
    page.evaluate('motionFixture.releaseMarkdown()')
    page.wait_for_timeout(100)
    assert page.evaluate('Math.abs(historyAnchor.getBoundingClientRect().top - anchorTop)') <= 1
    # Late image/embed expansion is covered by the same observer.
    page.evaluate('historyAnchor.previousElementSibling.style.minHeight = "900px"')
    page.wait_for_timeout(100)
    assert page.evaluate('Math.abs(historyAnchor.getBoundingClientRect().top - anchorTop)') <= 1
    # Explicit user scrolling releases the manual anchor and restores native anchoring.
    page.evaluate('chatFixture.view.messagesEl.scrollTop -= 100')
    page.wait_for_timeout(50)
    assert page.evaluate('chatFixture.view.messagesEl.style.overflowAnchor') == ''
    assert page.evaluate('historyAnchor.getBoundingClientRect().top - anchorTop') >= 99
    # Loading the final partial batch removes its button without displacing the old first node.
    page.evaluate('''() => {
      chatFixture.view.messagesEl.scrollTop = 0;
      window.finalAnchor = chatFixture.view.messagesEl.querySelector('.ai-second-brain-message-group');
      window.finalTop = finalAnchor.getBoundingClientRect().top;
    }''')
    page.get_by_role('button', name='加载更早的消息', exact=True).click()
    page.wait_for_timeout(100)
    expect(page.get_by_role('button', name='加载更早的消息', exact=True)).to_have_count(0)
    assert page.evaluate('finalAnchor.isConnected && Math.abs(finalAnchor.getBoundingClientRect().top-finalTop) <= 1')

    # A burst of deltas produces one visual flush rather than one layout per delta.
    page.evaluate('motionFixture.openPreview()')
    cdp = page.context.new_cdp_session(page)
    cdp.send('Performance.enable')
    def metrics():
        return {m['name']: m['value'] for m in cdp.send('Performance.getMetrics')['metrics']}
    before = metrics()
    page.evaluate('''() => {
      for(let i=0;i<100;i++) motionFixture.preview.appendDelta('Streaming suggestion line.\\n');
      motionFixture.preview.complete();
    }''')
    textarea = page.get_by_role('textbox', name='可编辑的 AI 建议内容', exact=True)
    expect(textarea).to_have_value('Streaming suggestion line.\n' * 100)
    layout_count = metrics()['LayoutCount'] - before['LayoutCount']
    assert layout_count < 10, layout_count
    textarea.fill('Short edit')
    assert textarea.evaluate('el => parseFloat(el.style.height)') <= 120
    page.evaluate('motionFixture.preview.close(); motionFixture.openPreview(); motionFixture.preview.appendDelta("Long line.\\n".repeat(100))')
    expect(textarea).to_have_value('Long line.\n' * 100)
    textarea.evaluate('el => { el.scrollTop = 50; }')
    page.evaluate('motionFixture.preview.appendDelta("More content.\\n".repeat(30))')
    expect(textarea).to_have_value('Long line.\n' * 100 + 'More content.\n' * 30)
    assert textarea.evaluate('el => el.scrollTop') == 50
    page.evaluate('motionFixture.preview.appendDelta("Final fragment"); motionFixture.preview.fail("Stopped")')
    expect(textarea).to_have_value('Long line.\n' * 100 + 'More content.\n' * 30 + 'Final fragment')
    page.evaluate('motionFixture.preview.close()')

    # The actual CodeMirror extension responds instantly to a keyboard-created selection.
    page.evaluate('motionFixture.openEditor()')
    page.locator('.cm-content').press('Shift+ArrowRight')
    toolbar = page.locator('.ai-second-brain-selection-toolbar')
    expect(toolbar).to_have_class('ai-second-brain-selection-toolbar is-visible')
    assert toolbar.evaluate('el => getComputedStyle(el).transform') == 'none'
    assert toolbar.evaluate('el => getComputedStyle(el).transitionDuration') == '0s'
    page.evaluate('motionFixture.editor.destroy()')

    # Reduced motion keeps opacity feedback and the final disclosure direction.
    page.emulate_media(reduced_motion='reduce')
    page.evaluate('''() => {
      window.samples = document.body.createDiv();
      samples.innerHTML = '<button class="ai-second-brain-inline-citation"><span class="ai-second-brain-inline-citation-preview is-below">Preview</span></button>' +
        '<details class="ai-second-brain-modification-item" open><span class="ai-second-brain-modification-chevron">v</span></details>' +
        '<details class="ai-second-brain-settings-disclosure" open><span class="ai-second-brain-settings-disclosure-chevron">v</span></details>';
    }''')
    citation = page.locator('.ai-second-brain-inline-citation').last
    citation.hover()
    preview = citation.locator('.ai-second-brain-inline-citation-preview')
    assert preview.evaluate('el => getComputedStyle(el).transform') == 'none'
    assert preview.evaluate('el => getComputedStyle(el).transitionProperty') == 'opacity'
    for name in ('modification', 'settings-disclosure'):
        arrow = page.locator(f'.ai-second-brain-{name}-chevron').last
        assert arrow.evaluate('el => getComputedStyle(el).transitionDuration') == '0s'
        assert arrow.evaluate('el => getComputedStyle(el).transform') == 'matrix(-1, 0, 0, -1, 0, 0)'
    page.get_by_role('button', name='新对话', exact=True).hover()
    assert page.get_by_role('button', name='新对话', exact=True).evaluate('el => getComputedStyle(el).transform') == 'none'

    touch = browser.new_context(is_mobile=True, has_touch=True, viewport={'width': 800, 'height': 900})
    touch_page = touch.new_page()
    touch_page.goto(base_url + '/.test-output/motion.html')
    touch_page.wait_for_load_state('networkidle')
    switcher = touch_page.locator('.ai-second-brain-session-switcher')
    switcher.tap()
    assert switcher.evaluate('el => getComputedStyle(el).transform') == 'none'
    touch.close()
    assert not errors, errors
    browser.close()
print(f'Motion UI passed: history anchors, delayed Markdown, keyboard/touch, reduced motion, preview scrolling; 100 deltas: {layout_count:g} layouts.')
