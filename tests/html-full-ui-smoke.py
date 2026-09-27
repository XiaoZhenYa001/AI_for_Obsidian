from pathlib import Path
import json
import os
import subprocess
from urllib.parse import quote
from playwright.sync_api import sync_playwright, expect
from ui_server import serve

root = Path(__file__).resolve().parents[1]
out = root / '.test-output'
out.mkdir(exist_ok=True)
subprocess.run(['node', '-e', "require('esbuild').buildSync({entryPoints:['tests/ui/html-full-harness.ts'],bundle:true,format:'iife',outfile:'.test-output/html-full.js',alias:{obsidian:require('path').resolve('tests/ui/obsidian.ts')}})"], cwd=root, check=True)
(out / 'html-full.html').write_text('<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="../styles.css"><style>body{margin:12px;font:15px system-ui}.fixture-view{height:94vh}.fixture-view>div{height:100%}</style><script defer src="html-full.js"></script>', encoding='utf-8')
server = subprocess.Popen(['node', 'tests/ui/full-preview-server.cjs'], cwd=root, stdout=subprocess.PIPE, text=True)
try:
    control = json.loads(server.stdout.readline())['controlOrigin']
    with serve(root) as origin, sync_playwright() as p:
        browser = p.chromium.launch(headless=True, channel=os.environ.get('PLAYWRIGHT_CHANNEL') or None)
        try:
            page = browser.new_page(viewport={'width':1100,'height':800})
            page.goto(origin + '/.test-output/html-full.html?control=' + quote(control, safe=''))
            page.evaluate('fullFixture.open()')
            expect(page.get_by_role('combobox', name='HTML 预览方式')).to_have_value('full')
            frame = page.frame_locator('iframe[title="HTML 互动预览"]').frame_locator('iframe[title="HTML 页面内容"]')
            expect(frame.get_by_role('heading', name='完整 HTML 预览')).to_be_visible()
            for key, value in [('module','42'),('storage','works'),('eval','42'),('parent','blocked'),('node','undefined')]:
                expect(frame.locator('body')).to_have_attribute('data-' + key, value)
            expect(frame.locator('h1')).to_have_css('color','rgb(12, 100, 180)')
            expect(frame.locator('base')).to_have_attribute('href','./')
            expect(frame.locator('source')).to_have_attribute('srcset','./picture.svg')
            assert frame.locator('img').evaluate('img=>img.complete && img.naturalWidth===64')
            expect(frame.frame_locator('iframe[title="页面内嵌入"]').locator('body')).to_contain_text('嵌入页面完整显示')
            frame.get_by_role('button', name='提交').click()
            expect(frame.locator('#result')).to_have_text('submitted')
            assert page.evaluate('fullFixture.stats()')['networkRequests'] == 0
            page.get_by_role('checkbox', name='允许在线资源').check()
            expect(frame.locator('body')).to_have_attribute('data-online','loaded')
            assert page.evaluate('fullFixture.stats()')['networkRequests'] > 0
            page.screenshot(path=str(out / 'html-full-preview.png'), full_page=True)
            page.get_by_role('button', name='源码', exact=True).click()
            expect(page.get_by_role('textbox', name='HTML 源码（只读）')).to_contain_text('')
            assert 'srcset=' in page.get_by_role('textbox', name='HTML 源码（只读）').input_value()
            page.evaluate('fullFixture.close()')
            assert page.evaluate('fullFixture.stats()')['active'] == 0
        finally:
            browser.close()
finally:
    server.terminate()
    server.wait(timeout=10)
print('Full HTML UI passed: original markup, CSS, modules, JSON fetch, storage, eval, forms, srcset, embedded page, network toggle, isolation and cleanup.')
