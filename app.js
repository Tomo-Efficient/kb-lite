/* 便签 · 轻量版
 * 纯静态，数据全部存在浏览器 IndexedDB 里，不需要任何后端。
 * 代价：换浏览器 / 清缓存 / 隐私模式关闭 = 数据没了。所以一定要能导出备份。
 */

const DB_NAME = 'kb-lite';
const DB_VERSION = 1;
const MODE_KEY = 'kb-lite-mode';
const DATE_TAG_RE = /^\d{4}-\d{2}-\d{2}$/;

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const state = {
  view: 'home',
  projects: [],
  project: null,
  notes: [],
  mode: localStorage.getItem(MODE_KEY) === 'note' ? 'note' : 'kb',
  q: '',
  tag: '',
  highlight: null,
};

let db = null;

/* ------------------------------------------------ IndexedDB */
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('projects')) {
        d.createObjectStore('projects', { keyPath: 'id' });
      }
      if (!d.objectStoreNames.contains('notes')) {
        const s = d.createObjectStore('notes', { keyPath: 'id' });
        s.createIndex('projectId', 'projectId', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function store(name, mode) {
  return db.transaction(name, mode).objectStore(name);
}

function wrap(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

const dbGetAll = name => wrap(store(name, 'readonly').getAll());
const dbPut = (name, value) => wrap(store(name, 'readwrite').put(value));
const dbDelete = (name, key) => wrap(store(name, 'readwrite').delete(key));

/* ------------------------------------------------ 小工具 */
function uid() {
  if (crypto.randomUUID) return crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  return Math.random().toString(36).slice(2, 14);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function toast(msg, isErr = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast show' + (isErr ? ' err' : '');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.className = 'toast'; }, 2600);
}

function relTime(iso) {
  if (!iso) return '';
  const d = new Date(iso), s = (Date.now() - d.getTime()) / 1000;
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} 天前`;
  return d.toLocaleDateString('zh-CN');
}

function hashNum(str) {
  let h = 0;
  for (let i = 0; i < String(str).length; i++) h = (h * 31 + String(str).charCodeAt(i)) | 0;
  return Math.abs(h);
}

function todayStr() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function firstLine(text, limit = 40) {
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim().replace(/^[#>*\-•\s]+/, '').trim();
    if (line) return line.slice(0, limit);
  }
  return '无标题';
}

function splitDate(tags) {
  const list = (tags || []).map(String);
  return { date: list.find(t => DATE_TAG_RE.test(t)) || '', rest: list.filter(t => !DATE_TAG_RE.test(t)) };
}

function setMode(mode, syncInput = true) {
  state.mode = mode === 'note' ? 'note' : 'kb';
  localStorage.setItem(MODE_KEY, state.mode);
  const kb = state.mode === 'kb';

  $$('#mode-switch .mode').forEach(b => b.classList.toggle('on', b.dataset.mode === state.mode));
  $('#mode-tip').textContent = kb ? '回车打开核对：标题、标签' : '回车直接存下，不核对';
  if (syncInput) {
    $('#input').placeholder = kb
      ? '把文字粘进来…（Enter 核对，Shift+Enter 换行）'
      : '随手记点什么…（Enter 存下，Shift+Enter 换行）';
    $('#hint').textContent = kb ? '知识库便签：有标题和标签' : '普通便签：不分类、不加标签';
    $('#btn-save').textContent = kb ? '核对 →' : '存下';
    refreshComposer();
  }
}

function refreshComposer() {
  $('#btn-save').disabled = $('#input').value.trim().length === 0;
}

/* ------------------------------------------------ 弹窗 */
function openModal(html) {
  $('#modal').className = 'modal';
  $('#modal').innerHTML = html;
  $('#mask').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

function closeModal() {
  $('#mask').classList.add('hidden');
  $('#modal').innerHTML = '';
  document.body.style.overflow = '';
}

/* ------------------------------------------------ 项目 */
async function loadProjects() {
  const all = await dbGetAll('projects');
  state.projects = all.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}

function renderHome() {
  state.view = 'home';
  $('#workspace').classList.add('hidden');
  $('#home').classList.remove('hidden');
  document.title = '便签 · 轻量版';

  const grid = $('#project-grid');
  if (!state.projects.length) {
    grid.innerHTML = '<div class="empty" style="width:100%"><h3>还没有项目</h3><p>先建一个，比如「读书笔记」</p></div>';
    return;
  }

  grid.innerHTML = state.projects.map(p => `
    <div class="project-card" data-id="${p.id}">
      <div class="pc-top">
        <span class="pc-dot" style="background:hsl(${hashNum(p.id) % 360} 55% 62%)"></span>
        <h3>${esc(p.name)}</h3>
      </div>
      <div class="pc-meta"><span>${(p.count || 0)} 条便签</span></div>
      <div class="pc-foot">
        <span class="muted">${relTime(p.updatedAt)}</span>
        <span class="pc-actions">
          <button class="mini" data-rename="${p.id}">改名</button>
          <button class="mini" data-del="${p.id}">删除</button>
        </span>
      </div>
    </div>`).join('');

  $$('.project-card').forEach(card => {
    card.onclick = e => {
      if (e.target.closest('.mini')) return;
      openProject(card.dataset.id);
    };
  });

  $$('[data-rename]').forEach(btn => btn.onclick = async e => {
    e.stopPropagation();
    const p = state.projects.find(x => x.id === btn.dataset.rename);
    const name = prompt('新的项目名：', p ? p.name : '');
    if (!name || !name.trim()) return;
    p.name = name.trim();
    p.updatedAt = new Date().toISOString();
    await dbPut('projects', p);
    await loadProjects();
    renderHome();
    toast('已改名');
  });

  $$('[data-del]').forEach(btn => btn.onclick = async e => {
    e.stopPropagation();
    const p = state.projects.find(x => x.id === btn.dataset.del);
    if (!p) return;
    const notes = (await dbGetAll('notes')).filter(n => n.projectId === p.id);
    const msg = notes.length
      ? `删除项目「${p.name}」？里面的 ${notes.length} 条便签会一起删掉。`
      : `删除项目「${p.name}」？`;
    if (!confirm(msg)) return;
    for (const n of notes) await dbDelete('notes', n.id);
    await dbDelete('projects', p.id);
    await loadProjects();
    renderHome();
    toast('项目已删除');
  });
}

async function createProject() {
  const input = $('#new-project');
  const name = input.value.trim();
  if (!name) { input.focus(); return; }
  if (state.projects.some(p => p.name === name)) { toast('已经有同名项目了', true); return; }

  const p = { id: uid(), name, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), count: 0 };
  await dbPut('projects', p);
  input.value = '';
  await loadProjects();
  renderHome();
  toast(`项目「${name}」已创建`);
  openProject(p.id);
}

async function openProject(id) {
  const projects = await dbGetAll('projects');
  const project = projects.find(p => p.id === id);
  if (!project) { toast('项目不存在', true); location.hash = ''; renderHome(); return; }

  state.project = project;
  state.view = 'project';
  state.q = '';
  state.tag = '';
  $('#search').value = '';
  location.hash = '#/p/' + id;

  $('#home').classList.add('hidden');
  $('#workspace').classList.remove('hidden');
  $('#project-name').textContent = project.name;
  document.title = `${project.name} · 便签`;

  await loadNotes();
  renderWall();
}

function backHome() {
  state.project = null;
  state.notes = [];
  location.hash = '';
  loadProjects().then(renderHome);
}

/* ------------------------------------------------ 便签 */
async function loadNotes() {
  const all = await dbGetAll('notes');
  state.notes = all.filter(n => n.projectId === state.project.id)
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}

async function bumpProject() {
  if (!state.project) return;
  state.project.updatedAt = new Date().toISOString();
  state.project.count = state.notes.length;
  await dbPut('projects', state.project);
}

function renderWall() {
  const q = state.q.toLowerCase();
  let items = state.notes;
  if (q) {
    items = items.filter(n =>
      (n.title || '').toLowerCase().includes(q) ||
      (n.body || '').toLowerCase().includes(q) ||
      (n.tags || []).some(t => t.toLowerCase().includes(q)));
  }
  if (state.tag) {
    items = items.filter(n => (n.tags || []).includes(state.tag));
  }

  $('#wall-title').textContent = state.tag ? `标签：${state.tag}` : (q ? `搜索：${state.q}` : '全部便签');
  $('#wall-count').textContent = `${items.length} 条`;
  $('#tagfilter').innerHTML = state.tag
    ? `<button class="chip on" id="clear-tag">标签：${esc(state.tag)} ×</button>` : '';
  if ($('#clear-tag')) $('#clear-tag').onclick = () => { state.tag = ''; renderWall(); };

  const wall = $('#wall');
  if (!items.length) {
    wall.innerHTML = `<div class="empty" style="column-span:all">
      <h3>${q || state.tag ? '没找到符合条件的便签' : '这个项目还没有便签'}</h3>
      <p>${q || state.tag ? '换个词试试' : '把文字粘到上面的框里'}</p>
    </div>`;
    return;
  }

  wall.innerHTML = items.map(n => {
    const color = (hashNum(n.id) % 6) + 1;
    const rot = (((hashNum(n.id) % 7) - 3) * 0.55).toFixed(2);
    const plain = n.kind === 'note';
    const isNew = state.highlight === n.id;
    return `<article class="note c${color}${plain ? ' plain' : ''}${isNew ? ' new' : ''}" data-id="${n.id}" style="--rot:${rot}deg">
      ${plain ? '' : `<div class="note-top"><span class="status-dot draft"></span><h3>${esc(n.title)}</h3></div>`}
      <p class="body">${esc(n.body || '').slice(0, plain ? 700 : 420)}</p>
      <div class="note-foot">
        ${[...(n.tags || [])].sort((a, b) => (DATE_TAG_RE.test(b) ? 1 : 0) - (DATE_TAG_RE.test(a) ? 1 : 0))
          .slice(0, 4)
          .map(t => `<span class="tag${DATE_TAG_RE.test(t) ? ' date' : ''}" data-tag="${esc(t)}">${esc(t)}</span>`).join('')}
        <span class="time">${relTime(n.updatedAt)}</span>
      </div>
    </article>`;
  }).join('');

  $$('#wall .note').forEach(el => el.onclick = ev => {
    if (ev.target.closest('.tag')) return;
    openNote(el.dataset.id);
  });
  $$('#wall .tag').forEach(t => t.onclick = ev => {
    ev.stopPropagation();
    state.tag = t.dataset.tag;
    renderWall();
  });
  state.highlight = null;
}

async function saveNote(kind, data) {
  const now = new Date().toISOString();
  const note = {
    id: uid(),
    projectId: state.project.id,
    kind,
    title: data.title || firstLine(data.body),
    body: data.body,
    tags: data.tags || [],
    createdAt: now,
    updatedAt: now,
  };
  await dbPut('notes', note);
  await loadNotes();
  await bumpProject();
  state.highlight = note.id;
  state.q = '';
  $('#search').value = '';
  renderWall();
  return note;
}

async function savePlain() {
  const body = $('#input').value;
  if (!body.trim()) return;
  const tags = [todayStr()];
  await saveNote('note', { body, tags });
  $('#input').value = '';
  refreshComposer();
  toast('已存下');
}

function openCheckModal() {
  const body = $('#input').value;
  if (!body.trim()) return;
  const title = firstLine(body);

  openModal(`
    <div class="modal-head">
      <h3>核对一下</h3>
      <span class="sub">确认无误后再存入便签</span>
      <button class="x" data-close>×</button>
    </div>
    <div class="modal-body">
      <div class="field">
        <label>标题</label>
        <input id="m-title" value="${esc(title)}" />
      </div>
      <div class="field">
        <label>内容</label>
        <textarea id="m-body" class="tall">${esc(body)}</textarea>
      </div>
      <div class="row">
        <div class="field">
          <label>日期</label>
          <input type="date" id="m-date" value="${todayStr()}" />
        </div>
        <div class="field">
          <label>标签 <span class="sub" style="margin:0;font-weight:400">（逗号分隔）</span></label>
          <input id="m-tags" placeholder="报价, 客户" />
        </div>
      </div>
      <div class="issues" id="m-issues"></div>
    </div>
    <div class="modal-foot">
      <span class="grow muted" id="m-hint" style="font-size:12px"></span>
      <button class="btn" data-close>取消</button>
      <button class="btn primary" id="m-save">存入便签</button>
    </div>`);

  const validate = () => {
    const t = $('#m-title').value.trim();
    const b = $('#m-body').value.trim();
    const issues = [];
    if (!t) issues.push(['error', '标题不能为空']);
    if (!b) issues.push(['error', '内容不能为空']);
    if (issues.length) {
      $('#m-issues').innerHTML = issues.map(([sv, msg]) =>
        `<div class="issue ${sv}"><b>必填</b><span>${esc(msg)}</span></div>`).join('');
    } else {
      $('#m-issues').innerHTML = '<div class="issue ok"><b>通过</b><span>可以保存</span></div>';
    }
    $('#m-save').disabled = issues.length > 0;
  };

  ['m-title', 'm-body'].forEach(id => $('#' + id).oninput = validate);
  $('#m-save').onclick = async () => {
    const date = ($('#m-date').value || todayStr()).trim();
    const typed = $('#m-tags').value.split(/[,，]/).map(s => s.trim()).filter(Boolean);
    const tags = [...new Set([...typed.filter(t => !DATE_TAG_RE.test(t)), date])];
    const saved = await saveNote('kb', {
      title: $('#m-title').value.trim(),
      body: $('#m-body').value,
      tags,
    });
    closeModal();
    $('#input').value = '';
    refreshComposer();
    toast('已存入便签');
    return saved;
  };

  validate();
  setTimeout(() => $('#m-title').focus(), 50);
}

function openNote(id) {
  const n = state.notes.find(x => x.id === id);
  if (!n) return;
  const plain = n.kind === 'note';
  openModal(`
    <div class="modal-head">
      <h3>${plain ? '普通便签' : esc(n.title)}</h3>
      <span class="sub">${relTime(n.updatedAt)}</span>
      <button class="x" data-close>×</button>
    </div>
    <div class="modal-body">
      <div class="md plain-body">${esc(n.body).replace(/\n/g, '<br>')}</div>
    </div>
    <div class="modal-foot">
      <button class="btn danger" id="n-del">删除</button>
      <span class="grow"></span>
      <button class="btn" data-close>关闭</button>
    </div>`);

  $('#n-del').onclick = async () => {
    if (!confirm('删除这条便签？')) return;
    await dbDelete('notes', n.id);
    await loadNotes();
    await bumpProject();
    closeModal();
    renderWall();
    toast('已删除');
  };
}

/* ------------------------------------------------ 导入 / 导出 */
function download(name, text) {
  const blob = new Blob([text], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function exportBackup() {
  const projects = await dbGetAll('projects');
  const notes = await dbGetAll('notes');
  const payload = { app: 'kb-lite', version: 1, exportedAt: new Date().toISOString(), projects, notes };
  const stamp = new Date().toISOString().slice(0, 10);
  download(`便签备份-${stamp}.json`, JSON.stringify(payload, null, 2));
  toast(`已导出 ${notes.length} 条便签`);
}

async function importBackup(file) {
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (!Array.isArray(data.projects) || !Array.isArray(data.notes)) {
      throw new Error('文件格式不对');
    }
    const existing = new Set((await dbGetAll('notes')).map(n => n.id));
    let added = 0;
    for (const p of data.projects) await dbPut('projects', p);
    for (const n of data.notes) {
      if (existing.has(n.id)) continue;
      await dbPut('notes', n);
      added++;
    }
    await loadProjects();
    renderHome();
    toast(`导入完成，新增 ${added} 条`);
  } catch (e) {
    toast('导入失败：' + e.message, true);
  }
}

/* ------------------------------------------------ 事件 */
function bind() {
  $('#btn-home').onclick = backHome;
  $('#btn-add-project').onclick = createProject;
  $('#new-project').onkeydown = e => { if (e.key === 'Enter') createProject(); };

  $('#input').oninput = refreshComposer;
  $('#input').onkeydown = e => {
    if (e.isComposing) return;
    if (e.key !== 'Enter') return;
    if (e.shiftKey) return;
    e.preventDefault();
    if ($('#btn-save').disabled) return;
    state.mode === 'note' ? savePlain() : openCheckModal();
  };
  $('#btn-save').onclick = () => (state.mode === 'note' ? savePlain() : openCheckModal());

  $$('#mode-switch .mode').forEach(btn => btn.onclick = () => setMode(btn.dataset.mode));

  let t = null;
  $('#search').oninput = e => {
    clearTimeout(t);
    t = setTimeout(() => { state.q = e.target.value.trim(); renderWall(); }, 200);
  };

  $('#btn-export').onclick = exportBackup;
  $('#btn-import').onclick = () => $('#file-import').click();
  $('#file-import').onchange = e => {
    const f = e.target.files[0];
    if (f) importBackup(f);
    e.target.value = '';
  };

  $('#mask').onclick = e => { if (e.target.id === 'mask') closeModal(); };
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
  $('#modal').addEventListener('click', e => { if (e.target.closest('[data-close]')) closeModal(); });
}

/* ------------------------------------------------ 启动 */
(async function boot() {
  try {
    db = await openDB();
  } catch (e) {
    document.body.innerHTML = '<div class="empty" style="margin:10vh auto;max-width:520px">'
      + '<h3>浏览器不支持本地存储</h3><p>IndexedDB 被禁用（可能是隐私模式）。换普通窗口或换个浏览器试试。</p></div>';
    return;
  }

  bind();
  setMode(state.mode, true);

  await loadProjects();
  if (!state.projects.length) {
    const p = { id: uid(), name: '我的便签', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), count: 0 };
    await dbPut('projects', p);
    await loadProjects();
  }

  const m = location.hash.match(/^#\/p\/([\w-]+)/);
  if (m && state.projects.some(p => p.id === m[1])) await openProject(m[1]);
  else renderHome();
})();
