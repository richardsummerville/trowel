// main.js — Trowel controller.
// Talks to Tauri commands for file I/O. Loads schemas.json baked at build time.

import { renderForm } from './render-form.mjs';

const { invoke } = window.__TAURI__?.core ?? { invoke: notTauri };

function notTauri() {
  throw new Error('This window must be launched via `npm run edit` (Tauri).');
}

// ── state ──────────────────────────────────────────────────────────────────

const state = {
  schemas: {},                  // collections → field-spec arrays
  collection: 'experiments',    // currently active
  entries: [],                  // list for current collection
  current: null,                // { slug, fm, body, isNew }
  dirty: false,
  counts: {},
};

// ── boot ───────────────────────────────────────────────────────────────────

async function boot() {
  state.schemas = await fetch('schemas.json').then(r => r.json());
  drawRail();
  await selectCollection('experiments');
  bindShortcuts();
  document.getElementById('save-btn').onclick = save;
  document.getElementById('new-btn').onclick = newEntry;
  document.getElementById('new-list-btn').onclick = newEntry;
  for (const el of document.querySelectorAll('[data-script]')) {
    el.onclick = () => runScript(el.dataset.script);
  }
}

// ── left rail ──────────────────────────────────────────────────────────────

function drawRail() {
  const root = document.getElementById('collections');
  root.innerHTML = '';
  const order = ['notes', 'projects', 'experiments', 'gallery'];
  for (const name of order) {
    if (!state.schemas[name]) continue;
    const item = document.createElement('div');
    item.className = 'rail-item' + (name === state.collection ? ' active' : '')
                   + (name === 'notes' ? ' locked' : '');
    item.innerHTML = `<span>${humanize(name)}</span>
                      <span class="count">${name === 'notes' ? 'read-only' : (state.counts[name] ?? '')}</span>`;
    if (name !== 'notes') item.onclick = () => selectCollection(name);
    root.appendChild(item);
  }
}

async function selectCollection(name) {
  if (state.dirty && !confirm('Discard unsaved changes?')) return;
  state.collection = name;
  state.entries = await invoke('list_entries', { collection: name });
  state.counts[name] = state.entries.length;
  state.current = null;
  state.dirty = false;
  document.getElementById('list-title').textContent = `${humanize(name)} · ${state.entries.length}`;
  document.getElementById('status-collection').textContent = name;
  drawRail();
  drawList();
  drawEditor();
  drawStatus();
}

// ── middle column ──────────────────────────────────────────────────────────

function drawList() {
  const root = document.getElementById('entries');
  root.innerHTML = '';
  if (!state.entries.length) {
    root.innerHTML = '<div class="empty">No entries yet. ⌘N to create one.</div>';
    return;
  }
  for (const e of state.entries) {
    const el = document.createElement('div');
    const active = state.current?.slug === e.slug ? ' active' : '';
    el.className = 'entry' + active;
    el.innerHTML = `
      <div class="entry-title">${escape(e.title || e.slug)}</div>
      <div class="entry-meta">
        <span>${(e.date || '').slice(0, 10)}</span>
        ${e.group ? `<span>${escape(e.group)}</span>` : ''}
        ${e.type ? `<span>${escape(e.type)}</span>` : ''}
        <span class="status-${e.status || 'published'}">${e.status || 'published'}</span>
      </div>`;
    el.onclick = () => openEntry(e.slug);
    root.appendChild(el);
  }
}

// ── right panel ────────────────────────────────────────────────────────────

async function openEntry(slug) {
  if (state.dirty && !confirm('Discard unsaved changes?')) return;
  const entry = await invoke('read_entry', { collection: state.collection, slug });
  state.current = { slug: entry.slug, fm: entry.fm || {}, body: entry.body || '', isNew: false };
  state.dirty = false;
  drawList();
  drawEditor();
  drawStatus();
}

function newEntry() {
  if (state.dirty && !confirm('Discard unsaved changes?')) return;
  if (state.collection === 'notes') return;  // read-only
  const today = new Date().toISOString().slice(0, 10);
  const fm = { title: '', date: today };
  // Apply defaults from schema
  for (const f of state.schemas[state.collection]) {
    if (f.default !== undefined && fm[f.name] === undefined) fm[f.name] = f.default;
  }
  state.current = { slug: '', fm, body: '', isNew: true };
  state.dirty = true;
  drawEditor();
  drawStatus();
  // Focus title
  setTimeout(() => document.querySelector('.frontmatter input')?.focus(), 0);
}

function drawEditor() {
  const root = document.getElementById('editor');
  root.innerHTML = '';
  if (!state.current) {
    root.innerHTML = `<div class="editor-empty">
      <div>No entry selected.</div>
      <div class="hint">⌘N to create one · click an entry to edit</div>
    </div>`;
    return;
  }
  const fields = state.schemas[state.collection];

  const fm = document.createElement('div');
  fm.className = 'frontmatter';
  fm.appendChild(renderForm(fields, state.current.fm, values => {
    state.current.fm = values;
    state.dirty = true;
    drawStatus();
  }));

  const slugRow = document.createElement('div');
  slugRow.className = 'field';
  slugRow.innerHTML = `
    <label class="field-label">Slug</label>
    <div class="field-input">
      <input id="slug-input" class="mono" value="${escape(state.current.slug)}"
             placeholder="auto from title" style="font-size:11px;color:var(--muted)" />
    </div>`;
  fm.appendChild(slugRow);
  slugRow.querySelector('input').oninput = e => {
    state.current.slug = e.target.value;
    state.dirty = true;
    drawStatus();
  };

  // Body pane
  const pane = document.createElement('div');
  pane.className = 'body-pane';
  pane.innerHTML = `
    <div class="body-toolbar">
      <button data-clip="callout">Callout</button>
      <button data-clip="frontispiece">Frontispiece</button>
      <button data-clip="code">Code</button>
      <span class="word-count" id="word-count"></span>
    </div>
    <textarea class="body" id="body"></textarea>`;
  pane.querySelector('#body').value = state.current.body;
  pane.querySelector('#body').oninput = e => {
    state.current.body = e.target.value;
    state.dirty = true;
    updateWordCount();
    drawStatus();
  };
  for (const btn of pane.querySelectorAll('[data-clip]')) {
    btn.onclick = () => insertClip(btn.dataset.clip);
  }

  root.appendChild(fm);
  root.appendChild(pane);
  updateWordCount();
}

function updateWordCount() {
  const el = document.getElementById('word-count');
  if (!el) return;
  const body = state.current?.body || '';
  const words = body.trim() ? body.trim().split(/\s+/).length : 0;
  el.textContent = `${words} words · ${body.length} chars`;
}

// ── clips ──────────────────────────────────────────────────────────────────

const CLIPS = {
  callout: '\n> [!summary] Summary line.\n> Continued summary.\n',
  frontispiece: 'frontispiece:\n  source: https://commons.wikimedia.org/wiki/File:FILE.jpg\n  filename: FILE.jpg\n  alt: ""\n  caption: ""\n',
  code: '\n```js\n// code\n```\n',
};

function insertClip(name) {
  const ta = document.getElementById('body');
  if (!ta) return;
  const clip = CLIPS[name] || '';
  const start = ta.selectionStart;
  ta.value = ta.value.slice(0, start) + clip + ta.value.slice(ta.selectionEnd);
  ta.selectionStart = ta.selectionEnd = start + clip.length;
  state.current.body = ta.value;
  state.dirty = true;
  ta.focus();
  drawStatus();
}

// ── save ───────────────────────────────────────────────────────────────────

async function save() {
  if (!state.current || !state.dirty) return;
  let slug = state.current.slug?.trim();
  if (!slug) slug = slugify(state.current.fm.title || '');
  if (!slug) { alert('Title or slug required'); return; }

  // Coerce date back to YYYY-MM-DD if input gave us something else
  if (state.current.fm.date instanceof Date) {
    state.current.fm.date = state.current.fm.date.toISOString().slice(0, 10);
  }

  await invoke('write_entry', {
    collection: state.collection,
    slug,
    fm: state.current.fm,
    body: state.current.body,
  });
  state.current.slug = slug;
  state.current.isNew = false;
  state.dirty = false;
  state.entries = await invoke('list_entries', { collection: state.collection });
  state.counts[state.collection] = state.entries.length;
  drawRail();
  drawList();
  drawStatus();
}

async function runScript(script) {
  document.getElementById('status-collection').textContent = `running ${script}…`;
  try {
    await invoke('run_sync', { script });
    document.getElementById('status-collection').textContent = `${script} ✓`;
  } catch (err) {
    document.getElementById('status-collection').textContent = `${script} failed`;
    console.error(err);
  }
}

// ── status bar ─────────────────────────────────────────────────────────────

function drawStatus() {
  const total = Object.values(state.counts).reduce((a, b) => a + (b || 0), 0);
  document.getElementById('status-counts').textContent =
    `${total} entries · ${Object.entries(state.counts).map(([k, v]) => `${v} ${k}`).join(' · ')}`;
  const ss = document.getElementById('save-state');
  ss.textContent = state.dirty ? 'unsaved' : 'saved';
  ss.classList.toggle('dirty', state.dirty);
  document.getElementById('status-path').textContent =
    state.current ? `${state.collection}/${state.current.slug || '(new)'}.md` : '—';
}

// ── shortcuts ──────────────────────────────────────────────────────────────

function bindShortcuts() {
  document.addEventListener('keydown', e => {
    const meta = e.metaKey || e.ctrlKey;
    if (meta && e.key === 's') { e.preventDefault(); save(); }
    if (meta && e.key === 'n') { e.preventDefault(); newEntry(); }
    if (meta && e.key === '1') { e.preventDefault(); selectCollection('projects'); }
    if (meta && e.key === '2') { e.preventDefault(); selectCollection('experiments'); }
    if (meta && e.key === '3') { e.preventDefault(); selectCollection('gallery'); }
  });
}

// ── utils ──────────────────────────────────────────────────────────────────

const escape = s => String(s ?? '').replace(/[&<>"']/g, c => ({
  '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
}[c]));

const humanize = s => s.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

const slugify = s => s.toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-|-$/g, '')
  .slice(0, 60);

boot().catch(err => {
  document.body.innerHTML = `<pre style="padding:24px;color:#cc3333;font-family:monospace">
${err.message}\n\n${err.stack || ''}</pre>`;
});
