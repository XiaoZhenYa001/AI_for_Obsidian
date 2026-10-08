from pathlib import Path
import os
import subprocess
from playwright.sync_api import sync_playwright, expect
from ui_server import serve

root = Path(__file__).resolve().parents[1]
subprocess.run(['node', 'tests/build-ui-harness.cjs'], cwd=root, check=True)
with serve(root) as origin, sync_playwright() as p:
    browser = p.chromium.launch(headless=True, channel=os.environ.get('PLAYWRIGHT_CHANNEL') or None)
    try:
        page = browser.new_page(viewport={'width': 900, 'height': 780})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        cdp = page.context.new_cdp_session(page)
        cdp.send('Emulation.setCPUThrottlingRate', {'rate': 6})
        page.goto(origin + '/.test-output/html.html')
        page.evaluate('htmlFixture.open()')
        frame = page.frame_locator('iframe[title="HTML 互动预览"]').frame_locator('iframe[title="HTML 页面内容"]')
        expect(frame.locator('h1')).to_be_visible()
        page.get_by_role('button', name='源码', exact=True).click()
        editor = page.get_by_role('textbox', name='HTML 源码', exact=True)
        expect(editor).to_be_editable()
        original = editor.input_value()
        edited = original.replace('交互式 HTML 预览', '保存测试')
        editor.fill(edited)
        assert page.evaluate('htmlFixture.source()') == original
        editor.press('Control+s')
        page.wait_for_function('htmlFixture.source().includes("保存测试")')
        expect(page.get_by_role('button', name='保存', exact=True)).to_be_disabled()
        page.get_by_role('button', name='预览', exact=True).click()
        expect(frame.locator('h1')).to_have_text('保存测试')
        page.get_by_role('button', name='源码', exact=True).click()
        draft = edited.replace('保存测试', '保留草稿')
        editor.fill(draft)
        page.evaluate('htmlFixture.reopen()')
        page.get_by_role('button', name='源码', exact=True).click()
        expect(editor).to_have_value(draft)
        external = edited.replace('保存测试', '外部修改')
        page.evaluate('(text)=>htmlFixture.setSource(text)', external)
        expect(page.get_by_role('button', name='另存副本', exact=True)).to_be_visible()
        page.get_by_role('button', name='保存', exact=True).click()
        expect(page.locator('.notice').last).to_contain_text('未覆盖')
        assert page.evaluate('htmlFixture.source()') == external
        expect(editor).to_have_value(draft)
        page.get_by_role('button', name='另存副本', exact=True).click()
        page.wait_for_function('htmlFixture.copies().length === 1')
        assert page.evaluate('htmlFixture.copies()[0][1]') == draft
        page.get_by_role('button', name='放弃修改', exact=True).click()
        page.get_by_role('button', name='取消', exact=True).click()
        expect(editor).to_have_value(draft)
        page.get_by_role('button', name='放弃修改', exact=True).click()
        page.get_by_role('button', name='放弃并重新载入', exact=True).click()
        expect(editor).to_have_value(external)
        page.evaluate('htmlFixture.hide()')
        page.wait_for_timeout(200)
        background = external.replace('外部修改', '后台修改')
        page.evaluate('(text)=>htmlFixture.setSource(text)', background)
        page.wait_for_timeout(200)
        page.evaluate('htmlFixture.show()')
        expect(editor).to_have_value(background)
        page.get_by_role('button', name='预览', exact=True).click()
        expect(frame.locator('h1')).to_have_text('后台修改')
        switched = background.replace('后台修改', '切换同步')
        page.evaluate('''text => {
            htmlFixture.setSource(text);
            [...document.querySelectorAll('button')].find(button => button.textContent === '源码').click();
        }''', switched)
        expect(editor).to_have_value(switched)
        # A live page sends a heartbeat only for measurement, never product polling.
        ticking = '<!doctype html><h1>节能测试</h1><script>setInterval(()=>top.postMessage("preview-tick","*"),30)</script>'
        editor.fill(ticking)
        editor.press('Control+s')
        page.wait_for_function('htmlFixture.source().includes("节能测试")')
        page.get_by_role('button', name='预览', exact=True).click()
        page.wait_for_function('htmlFixture.stats().ticks > 2')
        page.get_by_role('button', name='源码', exact=True).click()
        page.wait_for_timeout(300)
        before = page.evaluate('htmlFixture.stats()')
        page.wait_for_timeout(700)
        after = page.evaluate('htmlFixture.stats()')
        assert after == before, (before, after)
        page.get_by_role('button', name='预览', exact=True).click()
        page.wait_for_function('(n)=>htmlFixture.stats().ticks > n', arg=after['ticks'] + 2)
        page.evaluate('htmlFixture.hide()')
        page.wait_for_timeout(300)
        before = page.evaluate('htmlFixture.stats()')
        for _ in range(5):
            page.evaluate('(text)=>htmlFixture.setSource(text)', ticking)
        page.wait_for_timeout(700)
        assert page.evaluate('htmlFixture.stats()') == before
        page.evaluate('htmlFixture.show()')
        page.wait_for_function('(n)=>htmlFixture.stats().ticks > n', arg=before['ticks'] + 2)
        page.get_by_role('checkbox', name='隐藏时暂停').uncheck()
        page.get_by_role('button', name='源码', exact=True).click()
        before = page.evaluate('htmlFixture.stats().ticks')
        page.wait_for_function('(n)=>htmlFixture.stats().ticks > n', arg=before + 2)
        page.get_by_role('checkbox', name='隐藏时暂停').check()
        page.screenshot(path=str(root / '.test-output/html-editor.png'), full_page=True)
        recovery = ticking + '<!-- keep this draft -->'
        editor.fill(recovery)
        page.evaluate('htmlFixture.failDraftStorage()')
        page.evaluate('htmlFixture.close()')
        assert page.evaluate('htmlFixture.recoveries()[0][1]') == recovery
        page.evaluate('htmlFixture.reopen()')
        page.get_by_role('button', name='源码', exact=True).click()
        editor.fill('<!-- copyable after disk failure -->')
        page.evaluate('htmlFixture.failRecoveryWrite()')
        page.evaluate('htmlFixture.close()')
        expect(page.get_by_role('textbox', name='待恢复的 HTML 源码')).to_have_value('<!-- copyable after disk failure -->')
        assert not errors, errors
        print('HTML editor passed at 6x CPU throttle: save/preview, draft recovery, external conflict, copy/discard, hidden pause with zero extra reads/ticks, quota/disk failure recovery and cleanup.')
    finally:
        browser.close()
