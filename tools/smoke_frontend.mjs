/**
 * 前端冒烟测试：用 jsdom 真正启动页面、执行 app.js，并模拟用户操作。
 *
 * 依赖（仅测试需要，不属于运行依赖）：
 *     npm install --no-save jsdom
 *
 * 用法：
 *     python3 orbit-config.py --port 8792 --no-browser &   # 或在沙箱 HOME 里跑
 *     node tools/smoke_frontend.mjs http://127.0.0.1:8792/
 */

import { JSDOM, VirtualConsole } from 'jsdom';

const BASE = process.argv[2] || 'http://127.0.0.1:8787/';

let failures = 0;
function check(name, condition, extra = '') {
  const mark = condition ? '✅' : '❌';
  if (!condition) failures += 1;
  console.log(`${mark} ${name}${extra ? '  → ' + extra : ''}`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(fn, timeout = 6000, interval = 60) {
  const deadline = Date.now() + timeout;
  for (;;) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (_) { /* 继续等 */ }
    if (Date.now() > deadline) return null;
    await sleep(interval);
  }
}

const captured = [];

function apiCalls(fragment, method = null) {
  return captured.filter(c => c.url.includes(fragment) && (!method || c.method === method));
}

function makeFetch(window) {
  return async (input, init = {}) => {
    const url = new URL(String(input), BASE).toString();
    const response = await fetch(url, {
      method: init.method || 'GET',
      headers: init.headers,
      body: init.body,
    });
    const text = await response.text();
    captured.push({ url, method: init.method || 'GET', body: init.body });
    return {
      ok: response.ok,
      status: response.status,
      text: async () => text,
      json: async () => JSON.parse(text),
    };
  };
}

const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', error => {
  if (!/Could not parse CSS|Not implemented/.test(String(error.message))) {
    console.error('[jsdom error]', error.message);
  }
});
virtualConsole.on('error', (...args) => console.error('[console.error]', ...args));

console.log(`\n=== 前端冒烟测试 · ${BASE} ===\n`);

const dom = await JSDOM.fromURL(BASE, {
  runScripts: 'dangerously',
  resources: 'usable',
  pretendToBeVisual: true,
  virtualConsole,
  beforeParse(window) {
    window.fetch = makeFetch(window);
    window.prompt = () => null;
    window.open = () => null;
    window.HTMLElement.prototype.scrollIntoView = () => {};
  },
});

const { window } = dom;
const doc = window.document;
const $ = sel => doc.querySelector(sel);
const $$ = sel => Array.from(doc.querySelectorAll(sel));

// 等 app.js 完成 boot
const ready = await waitFor(() => $$('#tree .tree-row').length > 0, 9000);
check('页面启动并渲染出菜单树', Boolean(ready), `${$$('#tree .tree-row').length} 行`);

check('顶栏显示配置文件路径', ($('#pathText')?.textContent || '').includes('orbit-items'),
  $('#pathText')?.textContent);
check('保存按钮初始为禁用（无改动）', $('#btnSave')?.disabled === true);

// ── 预览环 ──────────────────────────────────────────────────────────────────
check('预览环渲染出 4 个顶级项', $$('#ring .ring-item').length === 4,
  `${$$('#ring .ring-item').length} 个`);
check('预览中心显示搜索占位符', ($('#hubText')?.textContent || '').length > 0,
  $('#hubText')?.textContent);

// ── 选中并编辑 ──────────────────────────────────────────────────────────────
// 不依赖某个具体名称：挑第一个「文件夹」类型的菜单项（它的类型切换会弹确认框）
const folderRow = $$('#tree .tree-row').find(row => row.querySelector('.badge.folder'))
  || $$('#tree .tree-row')[2];
check('找到一个文件夹类型的菜单项', Boolean(folderRow),
  folderRow ? folderRow.textContent.trim().replace(/\s+/g, ' ') : '');
folderRow.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

check('选中后编辑器渲染出表单', Boolean($('#fId')));
check('id 字段带出原值', ($('#fId')?.value || '').length > 0, $('#fId')?.value);
const originalId = $('#fId').value;
check('类型段显示「文件夹」', $('#typeSeg button.is-active')?.textContent === '文件夹',
  $('#typeSeg button.is-active')?.textContent);
check('文件夹类型显示「添加子项」按钮', Boolean($('#btnAddChild')));

// 改名字，验证树与预览同步 + dirty
const NEW_NAME = '冒烟测试-' + Date.now().toString(36);
const nameInput = $('#fName');
nameInput.value = NEW_NAME;
nameInput.dispatchEvent(new window.Event('input', { bubbles: true }));
check('改名后脏标记出现', $('#dirtyFlag')?.hidden === false);
check('改名后树同步更新', $('#tree').textContent.includes(NEW_NAME));
check('改名后预览同步更新', $('#ring').textContent.includes(NEW_NAME));

// 先给文件夹补一个子项，后面用来验证切换类型不会丢数据
function folderRowNow() {
  return $$('#tree .tree-row').find(row => row.querySelector('.badge.folder'));
}
function nodeRowByBadge(kind) {
  return $$('#tree .tree-row').find(row => row.querySelector('.badge.' + kind));
}
function folderChildCount(row) {
  const match = /文件夹\s*(\d+)/.exec(row.textContent);
  return match ? Number(match[1]) : 0;
}
let folderAgain = folderRowNow();
const childrenBefore = folderChildCount(folderAgain);
folderAgain.querySelector('[data-act="child"]')
  .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await sleep(120);
folderAgain = folderRowNow();
folderAgain.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await sleep(60);
check('给文件夹添加子项后计数 +1',
  folderChildCount(folderAgain) === childrenBefore + 1,
  `${childrenBefore} -> ${folderChildCount(folderAgain)}`);
const childrenAfterAdd = folderChildCount(folderAgain);

// ── 回归：切换类型不能丢数据（用户就是在这里把 Kitty 变成空文件夹的）──────
const cmdRow = nodeRowByBadge('cmd');
if (cmdRow) {
  cmdRow.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(60);
  const cmdValue = $('#fCmd')?.value || '';
  const cmdId = $('#fId')?.value || '';

  // 命令 → 文件夹
  $$('#typeSeg [data-type]').find(b => b.dataset.type === 'folder')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(100);
  check(`「${cmdId}」切成文件夹后不弹确认框（改为无损暂存）`,
    $('#confirmModal')?.hidden === true);
  check('空文件夹会显示醒目的警告框', Boolean($('#emptyFolderWarn')));
  check('空文件夹在树里被标记为异常',
    Boolean(nodeRowByBadge('folder')?.querySelector('.badge.is-broken')),
    cmdId);

  // 文件夹 → 命令：原来的 cmd 必须原样回来
  $$('#typeSeg [data-type]').find(b => b.dataset.type === 'cmd')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(100);
  check('切回「命令」后原来的命令原样恢复',
    $('#fCmd')?.value === cmdValue,
    `${JSON.stringify(cmdValue)} -> ${JSON.stringify($('#fCmd')?.value)}`);
  check('恢复后不再标记为异常',
    !Array.from($$('#tree .badge')).some(b => b.classList.contains('is-broken')),
    cmdId);
}

// ── 切换类型不丢子项 ────────────────────────────────────────────────────────
folderAgain = folderRowNow();
folderAgain.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await sleep(60);
const urlBtn = $$('#typeSeg [data-type]').find(btn => btn.dataset.type === 'url');
urlBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await sleep(120);
check('切换成「网址」后出现 url 输入框', Boolean($('#fUrl')));
check('切换成「网址」不弹确认框（子项已暂存）', $('#confirmModal')?.hidden === true);
const urlInput = $('#fUrl');
urlInput.value = 'https://example.com';
urlInput.dispatchEvent(new window.Event('input', { bubbles: true }));
check('填写 url 后脏标记存在', $('#dirtyFlag')?.hidden === false);

// 切回文件夹：子项应该原样回来
const folderBtn = $$('#typeSeg [data-type]').find(btn => btn.dataset.type === 'folder');
folderBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await sleep(120);
check('切回文件夹后子项数原样恢复',
  folderChildCount(folderRowNow()) === childrenAfterAdd,
  `${childrenAfterAdd} -> ${folderChildCount(folderRowNow())}`);
check('切回文件夹不再弹确认框',
  Boolean($('#btnAddChild')) && $('#confirmModal')?.hidden === true);

// ── 新增顶级项 ──────────────────────────────────────────────────────────────
const before = $$('#tree .tree-row').length;
$('#btnAddTop').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await sleep(60);
check('新增顶级项后树多一行', $$('#tree .tree-row').length === before + 1,
  `${before} → ${$$('#tree .tree-row').length}`);

// 删除刚加的（确认框需要点确定）
$('#btnDelNode').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await sleep(60);
check('删除时弹出确认框', $('#confirmModal')?.hidden === false);
$('#btnConfirmOk').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await sleep(80);
check('确认后恢复原行数', $$('#tree .tree-row').length === before,
  `${$$('#tree .tree-row').length}`);

// ── 图标选择器 ──────────────────────────────────────────────────────────────
$$('#tree .tree-row')[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await sleep(50);
const iconBefore = $('#fIcon').value;
$('#btnPickIcon').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const iconsReady = await waitFor(() => $$('#iconGrid .icon-cell').length > 20, 5000);
check('图标选择器打开并渲染图标', Boolean(iconsReady),
  `${$$('#iconGrid .icon-cell').length} 个`);
check('图标分类下拉已填充', $$('#iconCategory option').length > 5,
  `${$$('#iconCategory option').length} 项`);

// 用搜索过滤
const iconSearch = $('#iconSearch');
iconSearch.value = 'github';
iconSearch.dispatchEvent(new window.Event('input', { bubbles: true }));
await sleep(260);
const ghCell = $$('#iconGrid .icon-cell').find(cell => (cell.getAttribute('title') || '').includes('github'));
check('图标搜索能命中 github', Boolean(ghCell),
  `${$$('#iconGrid .icon-cell').length} 个结果`);
ghCell.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await sleep(60);
check('点击图标后表单 icon 被设为该字形', $('#fIcon').value === ghCell.dataset.char,
  `${JSON.stringify(iconBefore)} -> ${JSON.stringify($('#fIcon').value)}`);
check('选择后弹窗关闭', $('#iconModal')?.hidden === true);

// ── 搜索引擎标签页 ──────────────────────────────────────────────────────────
$$('#tabs .tab').find(t => t.dataset.tab === 'search')
  .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await sleep(140);
const engineCount = $$('#engineList .engine-card').length;
check('搜索引擎页渲染出引擎卡片', engineCount > 0, `${engineCount} 个`);
check('默认引擎下拉项数与卡片数一致', $$('#sDefault option').length === engineCount,
  `${$$('#sDefault option').length} / ${engineCount}`);
check('占位符输入框带出原值', ($('#sPlaceholder')?.value || '').length > 0,
  $('#sPlaceholder')?.value);

$('#btnAddEngine').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await sleep(90);
check('可以新增搜索引擎', $$('#engineList .engine-card').length === engineCount + 1,
  `${engineCount} -> ${$$('#engineList .engine-card').length}`);
check('新增引擎后脏标记存在', $('#dirtyFlag')?.hidden === false);

// ── 备份 / 预设标签页 ───────────────────────────────────────────────────────
$$('#tabs .tab').find(t => t.dataset.tab === 'presets')
  .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const presetsReady = await waitFor(() => $$('#presetList .preset-card').length > 0, 5000);
check('预设页渲染出内置预设卡片', Boolean(presetsReady),
  `${$$('#presetList .preset-card').length} 张`);

$$('#tabs .tab').find(t => t.dataset.tab === 'backups')
  .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const backupsReady = await waitFor(() => $$('#backupRows tr').length > 0, 5000);
check('备份页渲染出表格行', Boolean(backupsReady),
  `${$$('#backupRows tr').length} 行`);

// ── 保存 ────────────────────────────────────────────────────────────────────
$$('#tabs .tab').find(t => t.dataset.tab === 'items')
  .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await sleep(80);
$('#btnSave').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const saved = await waitFor(() => apiCalls('/api/config', 'POST')[0], 6000);
check('保存时向 /api/config 发送 POST', Boolean(saved));
if (saved) {
  const payload = JSON.parse(saved.body);
  check('保存载荷包含 items / search / search_engines',
    Array.isArray(payload.config?.items) &&
    Array.isArray(payload.config?.search_engines) &&
    typeof payload.config?.search === 'object');
  check('保存载荷里没有前端内部字段（__uid/layout_ 等）',
    !JSON.stringify(payload).includes('layout_'));
  check('保存载荷里没有空字符串 id',
    payload.config.items.every(i => typeof i.id === 'string' && i.id.length > 0));
}
const clearedDirty = await waitFor(() => $('#dirtyFlag')?.hidden === true, 5000);
check('保存成功后脏标记消失', Boolean(clearedDirty));

// ── 端到端回归：重新从磁盘加载，确认写回的内容能原样读回来 ────────────────
const beforeReload = captured.length;
$('#btnReload').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const gotState = await waitFor(() =>
  captured.slice(beforeReload).some(c => c.url.includes('/api/state')), 6000);
check('点击重新加载会重新拉取 /api/state', Boolean(gotState));
await sleep(300);   // 等 loadState 里的 renderAll 跑完

const reloadedRow = $$('#tree .tree-row').find(row => row.textContent.includes(NEW_NAME));
check('重新加载后仍能看到刚保存的名称', Boolean(reloadedRow));
reloadedRow.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await sleep(80);
check('空文件夹的类型在保存/重载后仍然是「文件夹」',
  $('#typeSeg button.is-active')?.textContent === '文件夹',
  $('#typeSeg button.is-active')?.textContent);
check('重载后 id 字段完好', $('#fId')?.value === originalId,
  `${$('#fId')?.value} (期望 ${originalId})`);
check('确认框已全部关闭', $('#confirmModal')?.hidden === true);

// ── 回归保护：图标格子不能重新变成“图标与文字重叠”的紧凑布局 ───────────────
// jsdom 没有排版引擎，所以这里直接断言关键 CSS 约束（之前就是因为用了
// aspect-ratio + 可收缩的 flex 子元素，导致窄格子里图标和文字挤在一起）。
const cssText = await (await fetch(new URL('/assets/style.css', BASE).toString())).text();
function cssRule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(escaped + '\\s*\\{([^}]*)\\}').exec(cssText);
  return match ? match[1] : '';
}
const gridRule = cssRule('.icon-grid');
const cellRule = cssRule('.icon-cell');
const glyphRule = cssRule('.icon-cell .ic-glyph');
const labelRule = cssRule('.icon-cell .ic-label');

check('图标格子不再用 aspect-ratio（它会让高度被宽度路死）',
  !/aspect-ratio/.test(cellRule + gridRule));
check('图标格子有固定高度', /height:\s*\d+px/.test(cellRule), cellRule.match(/height:[^;]*/)?.[0]);
check('图标字形不可被压缩（flex: none）', /flex:\s*none/.test(glyphRule));
check('图标文字不可被压缩（flex: none）', /flex:\s*none/.test(labelRule));
check('图标文字单行省略号，不会换行撞到图标',
  /white-space:\s*nowrap/.test(labelRule) && /text-overflow:\s*ellipsis/.test(labelRule));
check('图标列最小宽度足够（>= 84px）',
  (() => { const m = /minmax\((\d+)px/.exec(gridRule); return m && Number(m[1]) >= 84; })(),
  gridRule.match(/minmax\([^)]*\)/)?.[0]);

// 检查没有未捕获的运行时错误
const writes = captured.filter(c => c.method !== 'GET' && c.url.includes('/api/'));
console.log(`\n请求记录：${captured.length} 次，其中写操作 ${writes.length} 次`);

console.log(`\n=== ${failures === 0 ? '全部通过 ✅' : failures + ' 项失败 ❌'} ===\n`);
dom.window.close();
process.exit(failures === 0 ? 0 : 1);
