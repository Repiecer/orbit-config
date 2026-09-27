/* =============================================================================
   星环配置器 · 前端逻辑（原生 JS，无构建步骤）
   ============================================================================= */

'use strict';

/* ── 工具 ─────────────────────────────────────────────────────────────────── */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function deepCopy(value) { return JSON.parse(JSON.stringify(value)); }

function debounce(fn, ms) {
  let timer = null;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
}

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex([r, g, b]) {
  return '#' + [r, g, b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
}

function mix(a, b, ratio) {
  const ra = hexToRgb(a) || [0, 0, 0];
  const rb = hexToRgb(b) || [255, 255, 255];
  return rgbToHex([0, 1, 2].map(i => ra[i] + (rb[i] - ra[i]) * ratio));
}

function slugify(text) {
  const base = String(text || '').toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return base || 'item-' + Math.random().toString(36).slice(2, 6);
}

/** 把 $HOME 缩写成 ~，顶栏路径看起来短很多 */
function prettyPath(value) {
  if (!value) return '';
  return String(value).replace(/^.*?(?=\/(?:\.config|\.cache|\.local|\.share)\b)/, '~');
}

const UID = new WeakMap();
let uidSeq = 0;
function uid(node) {
  if (!node || typeof node !== 'object') return 'x';
  if (!UID.has(node)) UID.set(node, 'n' + (++uidSeq));
  return UID.get(node);
}

/* ── 状态 ─────────────────────────────────────────────────────────────────── */

const S = {
  config: null,
  palette: null,
  paths: null,
  icons: null,
  sel: null,              // {list: Array, index: number}
  expanded: new Set(),    // 展开的文件夹 uid
  tab: 'items',
  dirty: false,
  filter: '',
  drag: null,
  previewScope: 'root',
  previewHover: null,
  token: new URLSearchParams(location.search).get('token') || '',
};

const TYPES = {
  url: { label: '网址', badge: 'url', hint: '用 xdg-open 在浏览器里打开' },
  cmd: { label: '命令', badge: 'cmd', hint: '交给 niri-scratch-toggle.sh 启动' },
  folder: { label: '文件夹', badge: 'folder', hint: '展开成下一层星环' },
};

const nodeTypeMap = new WeakMap();

// 切换类型时把当前类型的字段暂存起来，切回去能原样恢复。
// 之前是直接 delete，于是「命令 → 文件夹」会静默抹掉 cmd，
// 把 Kitty 这种启动项变成一个不干事的空文件夹。
const typeStash = new WeakMap();

function getType(node) {
  if (!node) return 'cmd';
  if (nodeTypeMap.has(node)) return nodeTypeMap.get(node);
  if (Array.isArray(node.children) && node.children.length) return 'folder';
  if (node.url) return 'url';
  if (node.cmd) return 'cmd';
  if (Array.isArray(node.children)) return 'folder';
  return 'cmd';
}

/** 把节点里属于「type」类型的字段挪进暂存区 */
function stashField(node, type, stash) {
  if (type === 'url' && node.url !== undefined) { stash.url = node.url; delete node.url; }
  if (type === 'cmd' && node.cmd !== undefined) { stash.cmd = node.cmd; delete node.cmd; }
  if (type === 'folder' && Array.isArray(node.children)) {
    stash.children = node.children;
    delete node.children;
  }
}

function setType(node, type) {
  const current = getType(node);
  const stash = typeStash.get(node) || {};
  if (current !== type) stashField(node, current, stash);
  typeStash.set(node, stash);

  // 切到目标类型：有暂存值就恢复，没有就给个合理的默认值
  if (type === 'url') {
    if (current !== 'url') node.url = stash.url !== undefined ? stash.url : '';
  } else if (type === 'cmd') {
    if (current !== 'cmd') node.cmd = stash.cmd !== undefined ? stash.cmd : '';
  } else {
    node.children = Array.isArray(stash.children) ? stash.children : [];
  }
  nodeTypeMap.set(node, type);
}

/** 该类型当前是否处于「什么都干不了」的状态 */
function isIncomplete(node, type) {
  if (!node) return false;
  if (type === 'folder') return !(Array.isArray(node.children) && node.children.length);
  if (type === 'url') return !String(node.url || '').trim();
  if (type === 'cmd') return !String(node.cmd || '').trim();
  return false;
}

function newItem(type = 'url') {
  const base = {
    id: 'new-item-' + Math.random().toString(36).slice(2, 6),
    name: '新菜单项',
    desc: '',
    icon: '\u{f05a7}',
    shortcut: '',
    color_key: 'secondary',
  };
  if (type === 'url') base.url = 'https://';
  else if (type === 'folder') base.children = [];
  else base.cmd = '';
  nodeTypeMap.set(base, type);
  return base;
}

/* ── API ──────────────────────────────────────────────────────────────────── */

function apiUrl(path) {
  if (!S.token) return path;
  return path + (path.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(S.token);
}

async function api(path, options = {}) {
  const response = await fetch(apiUrl(path), {
    method: options.method || 'GET',
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  let data = null;
  try { data = await response.json(); } catch (_) { data = null; }
  if (!response.ok || (data && data.ok === false)) {
    const err = new Error((data && data.error) || `HTTP ${response.status}`);
    err.details = (data && data.details) || [];
    throw err;
  }
  return data || {};
}

/* ── 主题 ─────────────────────────────────────────────────────────────────── */

function applyPalette(palette) {
  S.palette = palette;
  const colors = palette.colors || {};
  const root = document.documentElement.style;
  const key = name => colors[name] || null;

  for (const [name, value] of Object.entries(colors)) {
    if (/^#[0-9a-f]{6}$/i.test(value)) root.setProperty('--' + name.replace(/_/g, '-'), value);
  }

  const surface = key('surface') || '#131316';
  const surfaceDim = key('surface_dim') || surface;
  const onSurface = key('on_surface') || '#e4e1e5';
  const onSurfaceVar = key('on_surface_variant') || onSurface;
  const primary = key('primary') || '#bcc5f0';

  root.setProperty('--bg', surfaceDim);
  root.setProperty('--panel', mix(surface, onSurface, 0.035));
  root.setProperty('--panel-2', mix(surface, onSurface, 0.075));
  root.setProperty('--panel-3', mix(surface, onSurface, 0.13));
  root.setProperty('--border', mix(surface, onSurface, 0.17));
  root.setProperty('--text', onSurface);
  root.setProperty('--text-dim', onSurfaceVar);
  root.setProperty('--text-faint', mix(onSurfaceVar, surface, 0.35));
  root.setProperty('--accent', primary);
  root.setProperty('--accent-ink', mix(primary, '#000000', 0.78));
}

function colorFor(node) {
  const colors = (S.palette && S.palette.colors) || {};
  const key = node && node.color_key ? String(node.color_key) : 'secondary';
  return colors[key] || key || '#61d9a6';
}

/* ── toast / banner / 确认框 ──────────────────────────────────────────────── */

function toast(title, body = '', kind = 'ok', ms = 4200) {
  const el = document.createElement('div');
  el.className = 'toast is-' + kind;
  el.innerHTML = `<div class="t-title">${esc(title)}</div>` +
    (body ? `<div class="t-body">${esc(body)}</div>` : '');
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), ms);
}

function showBanner(text, isError = false) {
  const el = $('#banner');
  if (!text) { el.hidden = true; return; }
  el.textContent = text;
  el.classList.toggle('is-error', isError);
  el.hidden = false;
}

function confirmDialog({ title = '确认', text = '', okText = '确定', danger = true,
                         checkLabel = '' } = {}) {
  return new Promise(resolve => {
    const modal = $('#confirmModal');
    $('#confirmTitle').textContent = title;
    $('#confirmText').textContent = text;
    const okBtn = $('#btnConfirmOk');
    okBtn.textContent = okText;
    okBtn.className = 'btn ' + (danger ? 'danger' : 'primary');
    const checkLine = $('#confirmCheckLine');
    const check = $('#confirmCheck');
    check.checked = false;
    if (checkLabel) { $('#confirmCheckLabel').textContent = checkLabel; checkLine.hidden = false; }
    else checkLine.hidden = true;

    modal.hidden = false;
    const done = value => {
      modal.hidden = true;
      okBtn.removeEventListener('click', onOk);
      $('#btnConfirmCancel').removeEventListener('click', onCancel);
      resolve(value);
    };
    const onOk = () => done({ ok: true, checked: check.checked });
    const onCancel = () => done({ ok: false, checked: false });
    okBtn.addEventListener('click', onOk);
    $('#btnConfirmCancel').addEventListener('click', onCancel);
  });
}

function setDirty(value) {
  S.dirty = value;
  $('#dirtyFlag').hidden = !value;
  $('#btnSave').disabled = !value;
}

/* ── 树 ───────────────────────────────────────────────────────────────────── */

function matches(node, filter) {
  if (!filter) return true;
  const q = filter.toLowerCase();
  const haystack = [node.id, node.name, node.desc, node.url, node.cmd]
    .filter(Boolean).join(' ').toLowerCase();
  if (haystack.includes(q)) return true;
  return (node.children || []).some(child => matches(child, q));
}

function renderTree() {
  const tree = $('#tree');
  const items = (S.config && S.config.items) || [];

  if (!items.length) {
    tree.innerHTML = `<div class="tree-empty">星环还是空的<br>点右上角 ＋ 添加第一个菜单项</div>`;
    return;
  }

  const filter = S.filter.trim();
  const visible = items.filter(node => matches(node, filter));
  if (!visible.length) {
    tree.innerHTML = `<div class="tree-empty">没有匹配 “${esc(filter)}” 的菜单项</div>`;
    return;
  }

  const parts = [];
  parts.push(renderRows(items, 0, filter));
  tree.innerHTML = parts.join('');
  bindTreeEvents();
}

function renderRows(list, depth, filter) {
  const rows = [];
  list.forEach((node, index) => {
    if (!matches(node, filter)) return;
    const type = getType(node);
    const isFolder = type === 'folder';
    const children = Array.isArray(node.children) ? node.children : [];
    const expanded = S.expanded.has(uid(node)) || Boolean(filter);
    const selected = S.sel && S.sel.list === list && S.sel.index === index;
    const color = colorFor(node);
    const broken = isIncomplete(node, type);

    rows.push(`
      <div class="tree-row${selected ? ' is-selected' : ''}" data-depth="${depth}"
           draggable="true" data-index="${index}">
        <button class="tree-twisty${isFolder ? '' : ' is-leaf'}" data-act="toggle"
                title="${isFolder ? '展开 / 折叠' : ''}">${isFolder ? (expanded ? '▾' : '▸') : '·'}</button>
        <span class="tree-glyph" style="color:${esc(color)}">${esc(node.icon || '\u{f05a7}')}</span>
        <span class="tree-name">${esc(node.name || '(未命名)')}</span>
        ${node.shortcut ? `<span class="kbd">${esc(node.shortcut)}</span>` : ''}
        <span class="badge ${TYPES[type].badge}${broken ? ' is-broken' : ''}"
              title="${broken ? '这一项在 orbit 里点了没反应（内容为空）' : ''}">${TYPES[type].label}${isFolder ? ' ' + children.length : ''}${broken ? ' ⚠' : ''}</span>
        <span class="tree-actions">
          <button data-act="up" title="上移">↑</button>
          <button data-act="down" title="下移">↓</button>
          <button data-act="child" title="${isFolder ? '添加子项' : '转为文件夹并添加子项'}">＋</button>
          <button data-act="dup" title="复制">⧉</button>
          <button data-act="del" class="danger" title="删除">✕</button>
        </span>
      </div>
    `);
    if (isFolder && expanded && children.length) {
      rows.push(`<div class="tree-children" data-parent-index="${index}">${renderRows(children, depth + 1, filter)}</div>`);
    }
  });
  return rows.join('');
}

function bindTreeEvents() {
  $$('#tree .tree-row').forEach(row => {
    const list = listForRow(row);
    const index = Number(row.dataset.index);
    if (!list) return;
    const node = list[index];
    if (!node) return;

    row.addEventListener('click', event => {
      const action = event.target.closest('[data-act]');
      if (action) {
        event.stopPropagation();
        handleTreeAction(action.dataset.act, list, index);
        return;
      }
      selectNode(list, index);
    });

    row.addEventListener('dragstart', event => {
      S.drag = { list, index, parent: list.__parentUid || null };
      row.classList.add('is-dragging');
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', String(index));
    });
    row.addEventListener('dragend', () => {
      row.classList.remove('is-dragging');
      S.drag = null;
      clearDropMarks();
    });
    row.addEventListener('dragover', event => {
      if (!S.drag) return;
      event.preventDefault();
      const rect = row.getBoundingClientRect();
      const above = (event.clientY - rect.top) < rect.height / 2;
      clearDropMarks();
      row.classList.add(above ? 'is-drop-before' : 'is-drop-after');
    });
    row.addEventListener('dragleave', () => row.classList.remove('is-drop-before', 'is-drop-after'));
    row.addEventListener('drop', event => {
      event.preventDefault();
      const rect = row.getBoundingClientRect();
      const above = (event.clientY - rect.top) < rect.height / 2;
      clearDropMarks();
      handleDrop(list, index, above);
    });
  });
}

function clearDropMarks() {
  $$('#tree .tree-row').forEach(row => row.classList.remove('is-drop-before', 'is-drop-after'));
}

/** 从 DOM 反查该行所属的数组：用 data-parent-index 链回溯。 */
function listForRow(row) {
  const chain = [];
  let el = row.parentElement;
  while (el && el.id !== 'tree') {
    if (el.classList.contains('tree-children')) chain.unshift(Number(el.dataset.parentIndex));
    el = el.parentElement;
  }
  let list = (S.config && S.config.items) || [];
  for (const idx of chain) {
    const parent = list[idx];
    if (!parent || !Array.isArray(parent.children)) return null;
    list = parent.children;
  }
  return list;
}

function selectNode(list, index) {
  S.sel = { list, index };
  renderTree();
  renderEditor();
  renderPreview();
}

function findParent(node) {
  const items = (S.config && S.config.items) || [];
  const stack = [...items];
  while (stack.length) {
    const current = stack.pop();
    if (Array.isArray(current.children)) {
      if (current.children.includes(node)) return current;
      stack.push(...current.children);
    }
  }
  return null;
}

function handleTreeAction(action, list, index) {
  const node = list[index];
  if (!node) return;

  if (action === 'toggle') {
    const key = uid(node);
    if (S.expanded.has(key)) S.expanded.delete(key); else S.expanded.add(key);
    renderTree();
    return;
  }
  if (action === 'up' || action === 'down') {
    const target = action === 'up' ? index - 1 : index + 1;
    if (target < 0 || target >= list.length) return;
    [list[index], list[target]] = [list[target], list[index]];
    S.sel = { list, index: target };
    setDirty(true);
    renderTree(); renderEditor(); renderPreview();
    return;
  }
  if (action === 'child') {
    if (getType(node) !== 'folder') setType(node, 'folder');
    if (!Array.isArray(node.children)) node.children = [];
    const child = newItem('url');
    node.children.push(child);
    S.expanded.add(uid(node));
    S.sel = { list: node.children, index: node.children.length - 1 };
    setDirty(true);
    renderTree(); renderEditor(); renderPreview();
    return;
  }
  if (action === 'dup') {
    const copy = deepCopy(node);
    copy.id = (copy.id || 'item') + '-copy';
    list.splice(index + 1, 0, copy);
    S.sel = { list, index: index + 1 };
    setDirty(true);
    renderTree(); renderEditor(); renderPreview();
    return;
  }
  if (action === 'del') {
    removeNode(list, index);
  }
}

async function removeNode(list, index) {
  const node = list[index];
  if (!node) return;
  const isFolder = Array.isArray(node.children) && node.children.length > 0;
  const answer = await confirmDialog({
    title: '删除菜单项',
    text: isFolder
      ? `确定删除文件夹 “${node.name || node.id}” 及其 ${node.children.length} 个子项吗？`
      : `确定删除 “${node.name || node.id}” 吗？`,
    okText: '删除',
  });
  if (!answer.ok) return;
  list.splice(index, 1);
  if (S.sel && S.sel.list === list) {
    if (!list.length) S.sel = null;
    else S.sel = { list, index: Math.min(index, list.length - 1) };
  }
  setDirty(true);
  renderTree(); renderEditor(); renderPreview();
}

function handleDrop(targetList, targetIndex, above) {
  const drag = S.drag;
  if (!drag) return;
  const { list: sourceList, index: sourceIndex } = drag;
  const node = sourceList[sourceIndex];
  if (!node) return;

  if (sourceList === targetList) {
    let insertAt = above ? targetIndex : targetIndex + 1;
    if (sourceIndex < insertAt) insertAt -= 1;
    if (insertAt === sourceIndex) return;
    sourceList.splice(sourceIndex, 1);
    sourceList.splice(insertAt, 0, node);
    S.sel = { list: sourceList, index: insertAt };
    setDirty(true);
    renderTree(); renderEditor(); renderPreview();
    return;
  }

  // 跨层级：只允许拖进文件夹
  const target = targetList[targetIndex];
  if (!target || getType(target) !== 'folder') {
    toast('无法移动到这里', '跨层级拖动只能放进「文件夹」类型的菜单项里。', 'warn');
    return;
  }
  if (!Array.isArray(target.children)) target.children = [];
  sourceList.splice(sourceIndex, 1);
  target.children.push(node);
  S.expanded.add(uid(target));
  S.sel = { list: target.children, index: target.children.length - 1 };
  setDirty(true);
  renderTree(); renderEditor(); renderPreview();
  toast('已移入文件夹', `“${node.name}” → “${target.name}”`, 'ok');
}

/* ── 编辑器 ───────────────────────────────────────────────────────────────── */

function colorOptions(current) {
  const keys = (S.palette && S.palette.color_keys) || [];
  return keys.map(key => {
    const value = (S.palette.colors || {})[key] || '';
    const selected = current === key ? ' selected' : '';
    return `<option value="${esc(key)}"${selected}>${esc(key)}${value ? ' · ' + esc(value) : ''}</option>`;
  }).join('');
}

function renderEditor() {
  const body = $('#editorBody');
  const title = $('#editorTitle');

  if (!S.sel || !S.sel.list[S.sel.index]) {
    title.textContent = '编辑菜单项';
    $('#btnDelNode').disabled = true;
    $('#btnDupNode').disabled = true;
    body.innerHTML = `<div class="empty-state">从左侧选一个菜单项开始编辑</div>`;
    return;
  }

  $('#btnDelNode').disabled = false;
  $('#btnDupNode').disabled = false;

  const node = S.sel.list[S.sel.index];
  const type = getType(node);
  const isFolder = type === 'folder';
  const children = Array.isArray(node.children) ? node.children : [];
  const depth = depthOf(node);
  title.textContent = depth > 0 ? `编辑菜单项 · 第 ${depth + 1} 层` : '编辑菜单项';

  // 说明文字收进 title 提示，表单里只留必要的一行
  const T = {
    id: '同一层级内不能重复，orbit 用它做标识',
    desc: '留空时：文件夹显示 “Folder · N Items”，网址显示 “Web Link”',
    icon: 'Nerd Font 字符，推荐用「图标库」挑选',
    url: '可以写 www. 开头，orbit 会自动补 https://',
    cmd: '交给 niri-scratch-toggle.sh 执行，可以写脚本路径',
    shortcut: '仅作视觉提示；orbit 里数字键直接触发对应项',
    color: '取自 Material You 动态调色板，也可以直接填 #RRGGBB',
  };

  body.innerHTML = `
    <div class="field full" style="margin-bottom:18px">
      <div class="seg" id="typeSeg">
        ${Object.entries(TYPES).map(([key, meta]) =>
          `<button data-type="${key}" class="${key === type ? 'is-active' : ''}">${meta.label}</button>`).join('')}
      </div>
      <div class="hint">${esc(TYPES[type].hint)}</div>
    </div>

    <div class="section-title">基本信息</div>
    <div class="form-grid">
      <div class="field">
        <label title="${T.id}">唯一标识 id <span class="req">*</span></label>
        <div class="input-row">
          <input type="text" id="fId" value="${esc(node.id || '')}" placeholder="github">
          <button class="btn small ghost" id="btnGenId" title="根据名称生成">生成</button>
        </div>
      </div>
      <div class="field">
        <label>显示名称 <span class="req">*</span></label>
        <input type="text" id="fName" value="${esc(node.name || '')}" placeholder="GitHub">
      </div>
      <div class="field">
        <label title="${T.desc}">副标题</label>
        <input type="text" id="fDesc" value="${esc(node.desc || '')}" placeholder="留空自动生成">
      </div>
      <div class="field">
        <label title="${T.icon}">图标</label>
        <div class="icon-field">
          <span class="icon-preview" id="iconPreview">${esc(node.icon || '󰖧')}</span>
          <input type="text" id="fIcon" class="glyph-input" value="${esc(node.icon || '')}" maxlength="4">
          <button class="btn small ghost" id="btnPickIcon">图标库</button>
        </div>
      </div>
    </div>

    <div class="section-title">${isFolder ? '文件夹内容' : (type === 'url' ? '网址' : '启动命令')}</div>
    ${isFolder ? `
      <div class="row-inline">
        <button class="btn primary small" id="btnAddChild">＋ 添加子项</button>
        <span class="muted small">${children.length} 个子项 · 在左侧树里编辑</span>
      </div>
      ${children.length ? '' : `
        <div class="warn-box" id="emptyFolderWarn">
          <span class="wb-icon">󰀦</span>
          <div>
            <strong>这是个空文件夹，orbit 里点它不会有任何反应。</strong>
            <div class="muted small">
              上面点「＋ 添加子项」往里面放东西；如果这一项本来就该启动程序或打开网页，
              把类型换回「地址」或「命令」（你之前填过的内容会自动恢复）。
            </div>
          </div>
        </div>
      `}
    ` : type === 'url' ? `
      <div class="field full">
        <label title="${T.url}">网址 url <span class="req">*</span></label>
        <div class="input-row">
          <input type="url" id="fUrl" value="${esc(node.url || '')}" placeholder="https://github.com">
          <button class="btn small ghost" id="btnOpenUrl" title="在浏览器里测试打开">测试打开</button>
        </div>
        ${String(node.url || '').trim() ? '' :
          '<div class="hint is-error">还没填网址，orbit 里点它没反应</div>'}
      </div>
    ` : `
      <div class="field full">
        <label title="${T.cmd}">命令 cmd <span class="req">*</span></label>
        <input type="text" id="fCmd" value="${esc(node.cmd || '')}" placeholder="kitty">
        ${String(node.cmd || '').trim() ? '' :
          '<div class="hint is-error">还没填命令，orbit 里点它没反应</div>'}
      </div>
    `}

    <div class="section-title">外观</div>
    <div class="form-grid">
      <div class="field">
        <label title="${T.shortcut}">快捷键徽标</label>
        <div class="shortcut-row" id="shortcutRow">
          ${[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => {
            const value = String(n);
            return `<button class="chip${node.shortcut === value ? ' is-active' : ''}" data-sc="${value}">${value}</button>`;
          }).join('')}
          <input type="text" id="fShortcut" maxlength="3" value="${esc(node.shortcut || '')}" placeholder="—">
        </div>
      </div>
      <div class="field">
        <label title="${T.color}">颜色</label>
        <div class="color-field">
          <input type="color" id="fColorPicker" value="${esc(normalizeHex(colorFor(node)))}">
          <select id="fColorKey">${colorOptions(node.color_key)}</select>
        </div>
      </div>
    </div>
  `;

  bindEditorEvents(node, type, children);
}

function normalizeHex(value) {
  const rgb = hexToRgb(value);
  return rgb ? rgbToHex(rgb) : '#61d9a6';
}

function depthOf(node) {
  const items = (S.config && S.config.items) || [];
  function walk(list, depth) {
    for (const item of list) {
      if (item === node) return depth;
      if (Array.isArray(item.children)) {
        const found = walk(item.children, depth + 1);
        if (found !== null) return found;
      }
    }
    return null;
  }
  const found = walk(items, 0);
  return found === null ? 0 : found;
}

function bindEditorEvents(node, type, children) {
  const rerenderAll = () => { renderTree(); renderEditor(); renderPreview(); };

  $('#typeSeg').addEventListener('click', async event => {
    const btn = event.target.closest('[data-type]');
    if (!btn || btn.dataset.type === type) return;
    const next = btn.dataset.type;
    // 切换不再丢数据：原类型的字段会暂存，切回去就恢复
    setType(node, next);
    setDirty(true);
    rerenderAll();

    if (isIncomplete(node, next)) {
      toast(`已切换到「${TYPES[next].label}」`,
        next === 'folder'
          ? '文件夹里还是空的 —— 记得点「＋ 添加子项」，否则 orbit 里点它没反应。'
          : `还没填${next === 'url' ? '网址' : '命令'}，orbit 里点它没反应。`,
        'warn', 6000);
    }
  });

  const bind = (sel, key, transform = v => v) => {
    const el = $(sel);
    if (!el) return;
    el.addEventListener('input', () => {
      const value = transform(el.value);
      if (value === '' || value === null) delete node[key]; else node[key] = value;
      setDirty(true);
      renderTree();
      renderPreview();
    });
  };

  bind('#fId', 'id', v => v.trim());
  bind('#fName', 'name');
  bind('#fDesc', 'desc');
  bind('#fUrl', 'url', v => v.trim());
  bind('#fCmd', 'cmd', v => v.trim());
  bind('#fShortcut', 'shortcut', v => v.trim());

  const iconInput = $('#fIcon');
  if (iconInput) {
    iconInput.addEventListener('input', () => {
      const value = iconInput.value;
      if (value) node.icon = value; else delete node.icon;
      $('#iconPreview').textContent = value || '\u{f05a7}';
      setDirty(true);
      renderTree();
      renderPreview();
    });
  }

  const genBtn = $('#btnGenId');
  if (genBtn) {
    genBtn.addEventListener('click', () => {
      node.id = slugify(node.name || node.id);
      $('#fId').value = node.id;
      setDirty(true);
      renderTree();
    });
  }

  const pickBtn = $('#btnPickIcon');
  if (pickBtn) {
    pickBtn.addEventListener('click', () => {
      openIconPicker(node.icon || '', char => {
        node.icon = char;
        $('#fIcon').value = char;
        $('#iconPreview').textContent = char;
        setDirty(true);
        renderTree();
        renderPreview();
      });
    });
  }

  const openBtn = $('#btnOpenUrl');
  if (openBtn) {
    openBtn.addEventListener('click', () => {
      let url = (node.url || '').trim();
      if (!url) { toast('还没有网址', '先填一个网址再测试。', 'warn'); return; }
      if (url.startsWith('www.')) url = 'https://' + url;
      window.open(url, '_blank', 'noopener');
    });
  }

  const addChild = $('#btnAddChild');
  if (addChild) {
    addChild.addEventListener('click', () => {
      if (!Array.isArray(node.children)) node.children = [];
      const child = newItem('url');
      node.children.push(child);
      S.expanded.add(uid(node));
      S.sel = { list: node.children, index: node.children.length - 1 };
      setDirty(true);
      rerenderAll();
    });
  }

  const shortcutRow = $('#shortcutRow');
  if (shortcutRow) {
    shortcutRow.addEventListener('click', event => {
      const chip = event.target.closest('[data-sc]');
      if (!chip) return;
      const value = chip.dataset.sc;
      if (node.shortcut === value) { delete node.shortcut; } else { node.shortcut = value; }
      setDirty(true);
      rerenderAll();
    });
  }

  const colorKey = $('#fColorKey');
  if (colorKey) {
    colorKey.addEventListener('change', () => {
      node.color_key = colorKey.value;
      setDirty(true);
      rerenderAll();
    });
  }

  const picker = $('#fColorPicker');
  if (picker) {
    picker.addEventListener('input', () => {
      node.color_key = picker.value;
      setDirty(true);
      renderTree();
      renderPreview();
    });
  }
}

/* ── 预览环 ───────────────────────────────────────────────────────────────── */

function previewItems() {
  const items = (S.config && S.config.items) || [];
  if (S.previewScope === 'selected' && S.sel && S.sel.list[S.sel.index]) {
    const node = S.sel.list[S.sel.index];
    if (Array.isArray(node.children) && node.children.length) return { list: node.children, label: node.name || node.id };
    const parent = findParent(node);
    if (parent) return { list: parent.children || [], label: parent.name || parent.id };
    if (S.sel.list === items) return { list: items, label: '顶级星环' };
    return { list: S.sel.list, label: '当前层级' };
  }
  return { list: items, label: '顶级星环' };
}

function renderPreview() {
  const ring = $('#ring');
  const stage = $('#ringStage');
  const { list, label } = previewItems();
  const placeholder = (S.config && S.config.search && S.config.search.placeholder) || 'Search or ask…';
  $('#hubText').textContent = placeholder;

  if (!list || !list.length) {
    ring.innerHTML = '';
    $('#previewCaption').textContent = `${label} · 空`;
    return;
  }

  const rect = stage.getBoundingClientRect();
  const width = Math.max(rect.width, 320);
  const height = Math.max(rect.height, 300);
  const radius = Math.max(70, Math.min(width, height) / 2 - 74);
  const cx = width / 2;
  const cy = height / 2;
  const count = list.length;
  const step = 360 / count;

  ring.innerHTML = list.map((node, index) => {
    const angle = (-90 + index * step) * Math.PI / 180;
    const x = cx + radius * Math.cos(angle);
    const y = cy + radius * Math.sin(angle);
    const type = getType(node);
    const color = colorFor(node);
    const selected = S.sel && S.sel.list === list && S.sel.index === index;
    return `<div class="ring-item is-${type}${selected ? ' is-hovered' : ''}"
                 style="left:${x.toFixed(1)}px; top:${y.toFixed(1)}px; border-color:${esc(color)}66"
                 data-index="${index}" title="${esc(node.name || '')}">
      <span class="ri-icon" style="color:${esc(color)}">${esc(node.icon || '\u{f05a7}')}</span>
      <span class="ri-name">${esc(node.name || '(未命名)')}</span>
      ${node.shortcut ? `<span class="ri-badge">${esc(node.shortcut)}</span>` : ''}
    </div>`;
  }).join('');

  $$('#ring .ring-item').forEach(el => {
    el.addEventListener('click', () => selectNode(list, Number(el.dataset.index)));
  });

  const defEngine = list.length;
  $('#previewCaption').textContent = `${label} · ${defEngine} 项 · 半径 ${Math.round(radius)}px`;
}

function renderPreviewScope() {
  $$('#previewScope button').forEach(btn => {
    btn.classList.toggle('is-active', btn.dataset.scope === S.previewScope);
  });
}

/* ── 搜索引擎 ─────────────────────────────────────────────────────────────── */

function renderSearchTab() {
  const engines = (S.config && S.config.search_engines) || [];
  const search = (S.config && S.config.search) || {};

  const metaForm = $('#searchMetaForm');
  metaForm.innerHTML = `
    <div class="field">
      <label title="orbit 打开时首先选中的引擎（Tab 键循环切换）">默认引擎</label>
      <select id="sDefault">
        ${engines.map(engine =>
          `<option value="${esc(engine.id)}"${engine.id === search.default_engine ? ' selected' : ''}>${esc(engine.name || engine.id)}</option>`).join('')}
      </select>
    </div>
    <div class="field">
      <label title="星环中心搜索框里的占位文案">输入框提示语</label>
      <input type="text" id="sPlaceholder" value="${esc(search.placeholder || '')}" placeholder="Search or ask...">
    </div>
  `;

  $('#sDefault').addEventListener('change', event => {
    S.config.search.default_engine = event.target.value;
    setDirty(true);
    renderPreview();
  });
  $('#sPlaceholder').addEventListener('input', event => {
    S.config.search.placeholder = event.target.value;
    setDirty(true);
    $('#hubText').textContent = event.target.value || 'Search or ask…';
  });

  const list = $('#engineList');
  if (!engines.length) {
    list.innerHTML = `<div class="empty-state">还没有搜索引擎</div>`;
    return;
  }

  list.innerHTML = engines.map((engine, index) => `
    <div class="engine-card${engine.id === search.default_engine ? ' is-default' : ''}">
      <div class="engine-head" title="${esc(engine.name || engine.id || '')}">
        <span class="e-icon" id="eIcon${index}">${esc(engine.icon || '\u{f0349}')}</span>
        ${engine.id === search.default_engine ? '<span class="badge">默认</span>' : ''}
        <span class="tree-actions" style="display:flex;margin-left:auto">
          <button data-eact="up" data-eindex="${index}" title="上移">↑</button>
          <button data-eact="down" data-eindex="${index}" title="下移">↓</button>
          <button data-eact="icon" data-eindex="${index}" title="换图标">󰍉</button>
          <button data-eact="del" data-eindex="${index}" class="danger" title="删除">✕</button>
        </span>
      </div>
      <div class="engine-grid">
        <div class="field">
          <label>id</label>
          <input type="text" data-ekey="id" data-eindex="${index}" value="${esc(engine.id || '')}">
        </div>
        <div class="field">
          <label>名称</label>
          <input type="text" data-ekey="name" data-eindex="${index}" value="${esc(engine.name || '')}">
        </div>
        <div class="field full">
          <label title="用 {query} 占位搜索关键词">搜索地址</label>
          <input type="text" data-ekey="url" data-eindex="${index}" value="${esc(engine.url || '')}"
                 placeholder="https://example.com/search?q={query}">
          ${String(engine.url || '').includes('{query}') ? '' :
            '<div class="hint is-error">缺少 {query}，搜索词不会被代入</div>'}
        </div>
      </div>
    </div>
  `).join('');

  $$('#engineList [data-ekey]').forEach(input => {
    input.addEventListener('input', () => {
      const index = Number(input.dataset.eindex);
      const key = input.dataset.ekey;
      const value = input.value.trim();
      const engine = S.config.search_engines[index];
      if (!engine) return;
      if (value === '') delete engine[key]; else engine[key] = value;
      setDirty(true);
    });
  });

  $$('#engineList [data-eact]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const index = Number(btn.dataset.eindex);
      const action = btn.dataset.eact;
      const enginesRef = S.config.search_engines;
      if (action === 'up' && index > 0) {
        [enginesRef[index - 1], enginesRef[index]] = [enginesRef[index], enginesRef[index - 1]];
      } else if (action === 'down' && index < enginesRef.length - 1) {
        [enginesRef[index + 1], enginesRef[index]] = [enginesRef[index], enginesRef[index + 1]];
      } else if (action === 'del') {
        const answer = await confirmDialog({
          title: '删除搜索引擎',
          text: `确定删除 “${enginesRef[index].name || enginesRef[index].id}” 吗？`,
          okText: '删除',
        });
        if (!answer.ok) return;
        enginesRef.splice(index, 1);
        if (S.config.search.default_engine === btn.closest('.engine-card')?.querySelector('[data-ekey="id"]')?.value) {
          S.config.search.default_engine = enginesRef[0] ? enginesRef[0].id : '';
        }
      } else if (action === 'icon') {
        openIconPicker(enginesRef[index].icon || '', char => {
          enginesRef[index].icon = char;
          setDirty(true);
          renderSearchTab();
        });
        return;
      } else {
        return;
      }
      setDirty(true);
      renderSearchTab();
    });
  });
}

/* ── 预设 ─────────────────────────────────────────────────────────────────── */

async function refreshPresets() {
  const data = await api('/api/presets');
  const list = $('#presetList');
  const presets = data.presets || [];
  $('#presetDirLabel').textContent = prettyPath(data.dir) || '~';

  const builtinCard = `
    <div class="preset-card is-builtin">
      <div class="p-title">出厂默认</div>
      <div class="p-meta">来自 <span class="mono">orbit/config.py</span> 的 DEFAULT_MENU_TREE</div>
      <div class="p-actions">
        <button class="btn small ghost" data-pact="load" data-pid="__factory__">载入到编辑器</button>
        <button class="btn small primary" data-pact="apply" data-pid="__factory__">载入并保存</button>
      </div>
    </div>`;

  const cards = presets.map(preset => `
    <div class="preset-card">
      <div class="p-title">${esc(preset.name)}</div>
      <div class="p-meta">
        ${preset.error ? '⚠ ' + esc(preset.error) :
          `${preset.top_level_items} 顶级 · ${preset.total_items} 项 · ${preset.engines} 引擎`}
        <span class="muted"> · ${esc((preset.time || '').slice(5, 16))}</span>
      </div>
      <div class="p-actions">
        <button class="btn small ghost" data-pact="load" data-pid="${esc(preset.id)}">载入到编辑器</button>
        <button class="btn small primary" data-pact="apply" data-pid="${esc(preset.id)}">载入并保存</button>
        <button class="btn small ghost" data-pact="overwrite" data-pid="${esc(preset.id)}" data-pname="${esc(preset.name)}" title="用当前编辑器里的配置覆盖这个预设">覆盖</button>
        <button class="btn small ghost" data-pact="rename" data-pid="${esc(preset.id)}" data-pname="${esc(preset.name)}">重命名</button>
        <button class="btn small danger" data-pact="delete" data-pid="${esc(preset.id)}" data-pname="${esc(preset.name)}">删除</button>
      </div>
    </div>`).join('');

  list.innerHTML = builtinCard + (cards || `<div class="empty-state">还没有自定义预设</div>`);

  $$('#presetList [data-pact]').forEach(btn => {
    btn.addEventListener('click', () =>
      handlePresetAction(btn.dataset.pact, btn.dataset.pid, btn.dataset.pname || btn.dataset.pid));
  });
}

function currentPayload() {
  return {
    items: S.config.items,
    search: S.config.search,
    search_engines: S.config.search_engines,
  };
}

async function handlePresetAction(action, presetId, presetName) {
  presetName = presetName || presetId;
  try {
    if (action === 'load' || action === 'apply') {
      if (action === 'load' && S.dirty) {
        const answer = await confirmDialog({
          title: '有未保存的修改',
          text: '载入预设会覆盖编辑器里未保存的内容。',
          okText: '继续载入',
        });
        if (!answer.ok) return;
      }
      const data = await api('/api/presets/apply', {
        method: 'POST',
        body: { id: presetId, save: action === 'apply' },
      });
      if (action === 'apply') {
        S.config = data.config;
        setDirty(false);
      } else {
        S.config.items = data.loaded.items;
        S.config.search = data.loaded.search;
        S.config.search_engines = data.loaded.search_engines;
        setDirty(true);
      }
      S.sel = null;
      renderAll();
      toast(data.message || '完成', action === 'apply' ? '已写入配置文件。' : '记得点「保存」写入磁盘。',
        action === 'apply' ? 'ok' : 'warn');
      return;
    }

    if (action === 'overwrite') {
      const data = await api('/api/presets', {
        method: 'POST',
        body: { name: presetName, config: currentPayload(), overwrite: true },
      });
      await refreshPresets();
      toast('预设已更新', data.message || presetName);
      return;
    }

    if (action === 'rename') {
      const next = window.prompt('新的预设名称', presetName);
      if (!next || next === presetName) return;
      await api('/api/presets/rename', { method: 'POST', body: { id: presetId, name: next } });
      await refreshPresets();
      toast('预设已重命名', next);
      return;
    }

    if (action === 'delete') {
      const answer = await confirmDialog({
        title: '删除预设', text: `确定删除预设 “${presetName}” 吗？`, okText: '删除',
      });
      if (!answer.ok) return;
      await api('/api/presets/delete', { method: 'POST', body: { id: presetId } });
      await refreshPresets();
      toast('预设已删除', presetName);
    }
  } catch (error) {
    toast('操作失败', error.message, 'error');
  }
}

/* ── 备份 ─────────────────────────────────────────────────────────────────── */

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(2) + ' MB';
}

async function refreshBackups() {
  const data = await api('/api/backups');
  const tbody = $('#backupRows');
  const backups = data.backups || [];
  if (!backups.length) {
    tbody.innerHTML = `<tr><td colspan="4" class="muted" style="text-align:center;padding:28px">
      还没有备份
    </td></tr>`;
    return;
  }
  tbody.innerHTML = backups.map(backup => `
    <tr>
      <td class="fname">${esc(backup.name)}</td>
      <td>${esc(backup.time)}</td>
      <td>${esc(formatSize(backup.size))}</td>
      <td>
        <div class="row-actions">
          <button class="btn small ghost" data-bact="restore" data-bname="${esc(backup.name)}">恢复</button>
          <button class="btn small ghost" data-bact="download" data-bname="${esc(backup.name)}" title="下载这份备份">⭳</button>
          <button class="btn small danger" data-bact="delete" data-bname="${esc(backup.name)}">删除</button>
        </div>
      </td>
    </tr>
  `).join('');

  $$('#backupRows [data-bact]').forEach(btn => {
    btn.addEventListener('click', () => handleBackupAction(btn.dataset.bact, btn.dataset.bname));
  });
}

async function handleBackupAction(action, name) {
  try {
    if (action === 'download') {
      window.open(apiUrl('/api/backups/' + encodeURIComponent(name)), '_blank');
      return;
    }
    if (action === 'restore') {
      const answer = await confirmDialog({
        title: '从备份恢复',
        text: `会用 “${name}” 覆盖当前配置文件（覆盖前会自动再备份当前版本）。`,
        okText: '恢复',
      });
      if (!answer.ok) return;
      const data = await api('/api/backups/restore', { method: 'POST', body: { name } });
      S.config = data.config;
      S.sel = null;
      setDirty(false);
      renderAll();
      toast('已恢复', data.message || '');
      return;
    }
    if (action === 'delete') {
      const answer = await confirmDialog({ title: '删除备份', text: `确定删除 “${name}” 吗？`, okText: '删除' });
      if (!answer.ok) return;
      await api('/api/backups/delete', { method: 'POST', body: { name } });
      await refreshBackups();
      toast('备份已删除', name);
    }
  } catch (error) {
    toast('操作失败', error.message, 'error');
  }
}

/* ── 图标选择器 ───────────────────────────────────────────────────────────── */

let iconPickCallback = null;

function openIconPicker(current, callback) {
  iconPickCallback = callback;
  $('#iconModal').hidden = false;
  $('#iconSearch').value = '';
  $('#iconManual').value = current || '';
  renderIconGrid();
  setTimeout(() => $('#iconSearch').focus(), 40);
}

function renderIconGrid() {
  const grid = $('#iconGrid');
  if (!S.icons) { grid.innerHTML = `<div class="empty-state">图标库加载中…</div>`; return; }

  const query = $('#iconSearch').value.trim().toLowerCase();
  const category = $('#iconCategory').value;
  const current = $('#iconManual').value;

  const parts = [];
  let shown = 0;
  for (const group of S.icons.categories) {
    if (category && category !== group.name) continue;
    const icons = group.icons.filter(icon =>
      !query || icon.n.toLowerCase().includes(query) || icon.l.toLowerCase().includes(query));
    if (!icons.length) continue;
    parts.push(`<div class="icon-cat-title">${esc(group.name)} · ${icons.length}</div>`);
    parts.push(icons.map(icon => `
      <div class="icon-cell${icon.char === current ? ' is-active' : ''}"
           data-char="${esc(icon.char)}" title="${esc(icon.n)}">
        <span class="ic-glyph">${esc(icon.char)}</span>
        <span class="ic-label">${esc(icon.l)}</span>
      </div>`).join(''));
    shown += icons.length;
  }

  grid.innerHTML = parts.join('') || `<div class="empty-state">没有匹配的图标</div>`;
  $('#iconFooter').textContent = `${shown} / ${S.icons.total} 个图标`;

  $$('#iconGrid .icon-cell').forEach(cell => {
    cell.addEventListener('click', () => {
      const char = cell.dataset.char;
      if (iconPickCallback) iconPickCallback(char);
      closeIconModal();
    });
  });
}

function closeIconModal() {
  $('#iconModal').hidden = true;
  iconPickCallback = null;
}

/* ── 导入 ─────────────────────────────────────────────────────────────────── */

function openImportModal() {
  $('#importModal').hidden = false;
  $('#importText').value = '';
  $('#importFileName').textContent = '未选择文件';
  setTimeout(() => $('#importText').focus(), 40);
}

async function doImport() {
  const text = $('#importText').value;
  if (!text.trim()) { toast('没有内容', '请选择文件或粘贴 JSON / TOML。', 'warn'); return; }
  try {
    const data = await api('/api/import', { method: 'POST', body: { text } });
    S.config.items = data.loaded.items;
    S.config.search = data.loaded.search;
    S.config.search_engines = data.loaded.search_engines;
    S.sel = null;
    setDirty(true);
    $('#importModal').hidden = true;
    renderAll();
    const warnings = (data.validation && data.validation.warnings) || [];
    toast('导入成功', (data.message || '') +
      (warnings.length ? `\n\n有 ${warnings.length} 条提醒，保存时会再提示。` : ''), 'ok');
  } catch (error) {
    const details = (error.details || []).slice(0, 6).join('\n');
    toast('导入失败', error.message + (details ? '\n' + details : ''), 'error', 8000);
  }
}

/* ── 保存 / 加载 ──────────────────────────────────────────────────────────── */

async function saveConfig() {
  if (!S.config) return;
  const btn = $('#btnSave');
  btn.disabled = true;
  try {
    const data = await api('/api/config', { method: 'POST', body: { config: currentPayload() } });
    S.config = data.config;
    setDirty(false);
    const warnings = (data.validation && data.validation.warnings) || [];
    renderAll();
    toast('已保存', (data.message || '') +
      (warnings.length ? `\n\n${warnings.length} 条提醒：\n` + warnings.slice(0, 4).join('\n') : ''),
      warnings.length ? 'warn' : 'ok', warnings.length ? 8000 : 4200);
  } catch (error) {
    const details = (error.details || []).slice(0, 8).join('\n');
    toast('保存失败', error.message + (details ? '\n' + details : ''), 'error', 9000);
  } finally {
    btn.disabled = !S.dirty;
  }
}

async function loadState() {
  const data = await api('/api/state');
  S.config = data.config;
  S.paths = data.paths;
  applyPalette(data.palette);
  setDirty(false);
  S.sel = null;
  S.expanded = new Set();

  const source = S.config.source || {};
  const fullPath = source.path || S.config.write_path || '';
  $('#pathText').textContent = fullPath ? prettyPath(fullPath) : '内置默认';
  $('#pathChip').title = fullPath || '当前生效的配置文件';
  $('#pathDot').classList.toggle('is-missing', !source.exists);

  if (source.items_from_defaults) {
    showBanner('还没有自定义配置，当前是 orbit 内置默认菜单。保存后会创建 ' +
      prettyPath(S.config.write_path || ''));
  } else if (source.path && source.path !== S.config.write_path) {
    showBanner(`当前读取的是低优先级文件；保存会写入 ${prettyPath(S.config.write_path)}`);
  } else {
    showBanner('');
  }

  renderAll();
}

function renderAll() {
  renderTree();
  renderEditor();
  renderPreview();
  renderPreviewScope();
  renderSearchTab();
}

/* ── 标签页 ───────────────────────────────────────────────────────────────── */

const TABS = ['items', 'search', 'presets', 'backups'];

function switchTab(tab) {
  if (!TABS.includes(tab)) tab = 'items';
  S.tab = tab;
  $$('#tabs .tab').forEach(btn => btn.classList.toggle('is-active', btn.dataset.tab === tab));
  $$('.tabpane').forEach(pane => pane.classList.toggle('is-active', pane.dataset.pane === tab));
  if (location.hash.slice(1) !== tab) {
    history.replaceState(null, '', '#' + tab);
  }
  if (tab === 'presets') refreshPresets().catch(error => toast('预设加载失败', error.message, 'error'));
  if (tab === 'backups') refreshBackups().catch(error => toast('备份加载失败', error.message, 'error'));
  if (tab === 'items') renderPreview();
}

/* ── 事件绑定 ─────────────────────────────────────────────────────────────── */

function bindGlobalEvents() {
  $$('#tabs .tab').forEach(btn => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));

  $('#btnSave').addEventListener('click', saveConfig);
  $('#btnReload').addEventListener('click', async () => {
    if (S.dirty) {
      const answer = await confirmDialog({
        title: '丢弃未保存的修改？',
        text: '重新加载会从磁盘重新读取配置，编辑器里的改动会丢失。',
        okText: '丢弃并重新加载',
      });
      if (!answer.ok) return;
    }
    try { await loadState(); toast('已重新加载', '配置已从磁盘读取。'); }
    catch (error) { toast('重新加载失败', error.message, 'error'); }
  });

  $('#btnExport').addEventListener('click', () => {
    window.location.href = apiUrl('/api/export');
  });

  $('#btnImport').addEventListener('click', openImportModal);
  $('#btnCancelImport').addEventListener('click', () => { $('#importModal').hidden = true; });
  $('#btnCloseImportModal').addEventListener('click', () => { $('#importModal').hidden = true; });
  $('#btnDoImport').addEventListener('click', doImport);
  $('#btnPickImportFile').addEventListener('click', () => $('#importFileInput').click());
  $('#importFileInput').addEventListener('change', async event => {
    const file = event.target.files[0];
    if (!file) return;
    $('#importText').value = await file.text();
    $('#importFileName').textContent = file.name;
  });

  $('#btnAddTop').addEventListener('click', () => {
    if (!S.config) return;
    const item = newItem('url');
    S.config.items.push(item);
    S.sel = { list: S.config.items, index: S.config.items.length - 1 };
    setDirty(true);
    renderAll();
  });

  $('#btnDelNode').addEventListener('click', () => {
    if (S.sel && S.sel.list[S.sel.index]) removeNode(S.sel.list, S.sel.index);
  });
  $('#btnDupNode').addEventListener('click', () => {
    if (S.sel) handleTreeAction('dup', S.sel.list, S.sel.index);
  });

  $('#treeFilter').addEventListener('input', debounce(event => {
    S.filter = event.target.value;
    renderTree();
  }, 120));

  $('#previewScope').addEventListener('click', event => {
    const btn = event.target.closest('[data-scope]');
    if (!btn) return;
    S.previewScope = btn.dataset.scope;
    renderPreviewScope();
    renderPreview();
  });

  $('#btnAddEngine').addEventListener('click', () => {
    if (!Array.isArray(S.config.search_engines)) S.config.search_engines = [];
    S.config.search_engines.push({
      id: 'engine-' + Math.random().toString(36).slice(2, 6),
      name: '新搜索引擎',
      icon: '\u{f0349}',
      url: 'https://example.com/search?q={query}',
    });
    setDirty(true);
    renderSearchTab();
  });

  $('#btnSavePreset').addEventListener('click', async () => {
    const name = $('#presetName').value.trim();
    if (!name) { toast('请填预设名称', '', 'warn'); return; }
    try {
      const data = await api('/api/presets', { method: 'POST', body: { name, config: currentPayload() } });
      $('#presetName').value = '';
      await refreshPresets();
      toast('预设已保存', data.message || name);
    } catch (error) { toast('保存预设失败', error.message, 'error'); }
  });

  $('#btnImportPresetFile').addEventListener('click', () => $('#presetFileInput').click());
  $('#presetFileInput').addEventListener('change', async event => {
    const file = event.target.files[0];
    if (!file) return;
    try {
      const parsed = await api('/api/import', { method: 'POST', body: { text: await file.text() } });
      const name = window.prompt('预设名称', file.name.replace(/\.(json|toml)$/i, '')) || file.name;
      await api('/api/presets', { method: 'POST', body: { name, config: parsed.loaded } });
      await refreshPresets();
      toast('预设已导入', name);
    } catch (error) { toast('导入预设失败', error.message, 'error'); }
    event.target.value = '';
  });

  $('#btnMakeBackup').addEventListener('click', async () => {
    try {
      const data = await api('/api/backups', { method: 'POST', body: { reason: 'manual' } });
      await refreshBackups();
      toast(data.message || '完成', data.backup ? data.backup.name : '');
    } catch (error) { toast('备份失败', error.message, 'error'); }
  });

  $('#btnCloseIconModal').addEventListener('click', closeIconModal);
  $('#iconSearch').addEventListener('input', debounce(renderIconGrid, 110));
  $('#iconCategory').addEventListener('change', renderIconGrid);
  $('#iconManual').addEventListener('input', renderIconGrid);
  $('#btnUseManualIcon').addEventListener('click', () => {
    const char = $('#iconManual').value.trim();
    if (!char) { toast('请输入一个字符', '', 'warn'); return; }
    if (iconPickCallback) iconPickCallback(char);
    closeIconModal();
  });

  $('#iconModal').addEventListener('click', event => {
    if (event.target.id === 'iconModal') closeIconModal();
  });
  $('#importModal').addEventListener('click', event => {
    if (event.target.id === 'importModal') $('#importModal').hidden = true;
  });

  document.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      if (S.dirty) saveConfig();
      return;
    }
    if (event.key === 'Escape') {
      if (!$('#iconModal').hidden) closeIconModal();
      else if (!$('#importModal').hidden) $('#importModal').hidden = true;
    }
  });

  window.addEventListener('beforeunload', event => {
    if (S.dirty) { event.preventDefault(); event.returnValue = ''; }
  });

  window.addEventListener('resize', debounce(renderPreview, 120));
}

/* ── 启动 ─────────────────────────────────────────────────────────────────── */

async function boot() {
  bindGlobalEvents();
  setDirty(false);
  $('#btnSave').disabled = true;

  try {
    const icons = await api('/api/icons');
    S.icons = icons;
    $('#iconCategory').innerHTML = `<option value="">全部类别</option>` +
      icons.categories.map(group => `<option value="${esc(group.name)}">${esc(group.name)}</option>`).join('');
  } catch (error) {
    console.warn('图标库加载失败', error);
  }

  try {
    await loadState();
  } catch (error) {
    showBanner('无法读取配置：' + error.message, true);
    toast('初始化失败', error.message, 'error', 9000);
  }

  // 支持 #items / #search / #presets / #backups 深链接
  const hashTab = location.hash.slice(1);
  if (TABS.includes(hashTab) && hashTab !== 'items') switchTab(hashTab);

  window.addEventListener('hashchange', () => {
    const next = location.hash.slice(1);
    if (TABS.includes(next) && next !== S.tab) switchTab(next);
  });
}

document.addEventListener('DOMContentLoaded', boot);
