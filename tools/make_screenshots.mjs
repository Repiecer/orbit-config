/**
 * 生成界面截图（开发工具）。
 *
 * 直接用 `--screenshot` 抓不到东西：页面在 load 之后才异步拉数据，
 * 而 Firefox 系 headless 的截图时机早于 fetch 返回。
 * 所以这里先用 jsdom 真正启动页面、等数据渲染完，再把「渲染后的 DOM + 内联 CSS」
 * 存成静态 HTML，最后交给 headless 浏览器截图。产物是真实渲染结果。
 *
 * 依赖：npm install --no-save jsdom
 * 用法：
 *   python3 orbit-config.py --port 8805 --no-browser &
 *   node tools/make_screenshots.mjs http://127.0.0.1:8805/ docs
 *   ZEN=/opt/zen-browser-bin/zen node tools/make_screenshots.mjs ...
 */

import { JSDOM, VirtualConsole } from 'jsdom';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const BASE = process.argv[2] || 'http://127.0.0.1:8787/';
const OUT_DIR = process.argv[3] || 'docs';
const TOOLS_DIR = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(TOOLS_DIR, '..');

const VIEWPORT = { width: 1720, height: 1080 };

// 每张截图：切到哪个标签页 + 额外要打开的东西
const SHOTS = [
  { name: 'items', tab: 'items', setup: selectSomething },
  { name: 'search', tab: 'search' },
  { name: 'presets', tab: 'presets' },
  { name: 'backups', tab: 'backups' },
  { name: 'iconpicker', tab: 'items', openIconPicker: true, setup: selectSomething },
];

const BROWSERS = [
  process.env.ZEN,
  '/opt/zen-browser-bin/zen',
  'firefox',
  'chromium',
  'google-chrome-stable',
].filter(Boolean);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitFor(fn, timeout = 8000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    try { if (await fn()) return true; } catch (_) { /* retry */ }
    if (Date.now() > deadline) return false;
    await sleep(80);
  }
}

const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', () => {});

const dom = await JSDOM.fromURL(BASE, {
  runScripts: 'dangerously',
  resources: 'usable',
  pretendToBeVisual: true,
  virtualConsole,
  beforeParse(window) {
    window.fetch = async (input, init = {}) => {
      const response = await fetch(new URL(String(input), BASE).toString(), {
        method: init.method || 'GET', headers: init.headers, body: init.body,
      });
      const text = await response.text();
      return { ok: response.ok, status: response.status, text: async () => text, json: async () => JSON.parse(text) };
    };
    window.prompt = () => null;
    window.open = () => null;
  },
});

// 展开所有文件夹，再选中第一个网址项（没有就退回到第一项），让编辑器面板有内容
async function selectSomething(window, doc) {
  const click = el => el && el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const rows = () => Array.from(doc.querySelectorAll('#tree .tree-row'));

  for (const row of rows()) {
    if (row.querySelector('.badge.folder')) {
      click(row.querySelector('[data-act="toggle"]'));
      await sleep(60);
    }
  }
  await sleep(120);

  const target = rows().find(row => row.querySelector('.badge.url')) || rows()[0];
  click(target);
  await sleep(150);
}

const { window } = dom;
const doc = window.document;

if (!await waitFor(() => doc.querySelectorAll('#tree .tree-row').length > 0)) {
  console.error('页面没有渲染出菜单树，截图取消。');
  process.exit(1);
}
console.log('页面已渲染完成，开始逐个标签页快照…');
// jsdom 没有真实布局，给预览环一个确定的尺寸，让截图里的星环大小合理
const stage = doc.querySelector('#ringStage');
if (stage) {
  stage.getBoundingClientRect = () => ({
    width: 430, height: 460, top: 0, left: 0, right: 430, bottom: 460, x: 0, y: 0,
  });
}

// 让顶栏干净一些：去掉未保存标记
doc.querySelector('#dirtyFlag').hidden = true;

const css = await readFile(path.join(ROOT, 'web', 'style.css'), 'utf8');

await mkdir(path.join(ROOT, OUT_DIR), { recursive: true });

for (const shot of SHOTS) {
  if (typeof window.switchTab === 'function') window.switchTab(shot.tab);
  await sleep(shot.tab === 'presets' || shot.tab === 'backups' ? 400 : 150);
  if (typeof window.renderPreview === 'function') window.renderPreview();

  if (shot.setup) await shot.setup(window, doc);
  if (shot.openIconPicker) {
    if (typeof window.switchTab === 'function') window.switchTab('items');
    if (typeof window.openIconPicker === 'function') window.openIconPicker('', () => {});
    await sleep(300);
  }

  let html = '<!DOCTYPE html>\n' + doc.documentElement.outerHTML;
  html = html.replace(/<link rel="stylesheet"[^>]*>/, `<style>\n${css}\n</style>`);
  html = html.replace(/<script src="assets\/app\.js"><\/script>/, '');
  html = html.replace('<head>', `<head>\n<meta name="viewport" content="width=${VIEWPORT.width}">`);

  // 中间产物放临时目录，最终只把 PNG 留在 OUT_DIR
  const target = path.join(os.tmpdir(), `orbit-snapshot-${shot.name}.html`);
  await writeFile(target, html, 'utf8');
  console.log(`  快照 DOM -> ${target}`);
  SHOTS.find(s => s.name === shot.name).page = target;
}

dom.window.close();

// ── 用 headless 浏览器把快照渲染成 PNG ───────────────────────────────────────
const browser = BROWSERS.find(bin => bin.startsWith('/') ? existsSync(bin) : true);
if (!browser) {
  console.log('没找到可用的浏览器，只生成了 HTML 快照。');
  process.exit(0);
}

console.log(`\n用 ${browser} 渲染 PNG…`);
for (const shot of SHOTS) {
  const page = shot.page;
  const png = path.join(ROOT, OUT_DIR, `screenshot-${shot.name}.png`);
  const profile = path.join(os.tmpdir(), `orbit-shot-${shot.name}`);
  // Zen/Firefox 的 -profile 要求目录已存在
  mkdirSync(profile, { recursive: true });
  await new Promise(resolve => {
    const child = spawn(browser, [
      '--headless', '--no-remote', '-profile', profile,
      `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
      '--screenshot', png, `file://${page}`,
    ], { stdio: 'ignore' });
    child.on('exit', resolve);
    child.on('error', resolve);
    setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} resolve(); }, 60000);
  });
  console.log(`  ${existsSync(png) ? '✅' : '❌'} ${path.relative(ROOT, png)}`);
}
