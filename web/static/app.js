/* Thermal Printer - browser front end
 *
 * The server owns the hardware and the renderer, so this file is only ever
 * doing three things: editing text, asking the server to re-render it, and
 * posting it to the printer. The preview is a PNG produced by the same code
 * path that drives the print head, not a CSS imitation of it.
 */

const $ = (id) => document.getElementById(id);
const api = async (path, options = {}) => {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const type = response.headers.get('Content-Type') || '';
  const body = type.includes('json') ? await response.json() : await response.blob();
  if (!response.ok && type.includes('json')) throw new Error(body.message || 'Request failed');
  return body;
};

const state = {
  presets: [],
  todos: [],
  activePresetId: null,
  printer: {},
};

/* ------------------------------------------------------------------ toast */
let toastTimer = null;
function toast(message, isError = false) {
  const el = $('toast');
  el.textContent = message;
  el.classList.toggle('err', isError);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}
function status(message) { $('statusMsg').textContent = message; }

/* ------------------------------------------------------------------ theme */
/* Themes are data. The server merges the built-in manifest with anything in
 * ~/.local/share/thermal-printer/themes, and this file only ever reads that
 * list: it links the stylesheet, builds the menu entry and takes the print
 * font from it. Adding a theme therefore never means editing this file. */
const THEME_KEY = 'tp.theme';
const MODE_KEY = 'tp.mode';

let themes = [];

const themeById = (id) => themes.find((theme) => theme.id === id);

async function loadThemes() {
  try {
    const data = await api('/api/themes');
    themes = data.themes || [];
  } catch (error) {
    themes = [];
  }
  if (!themes.length) {
    // the four built-ins are linked statically, so the UI still works if the
    // manifest is missing or unreadable
    // the manifest's order is the menu's order and its first entry is the
    // default, so a fallback list keeps the same order the manifest has
    themes = ['1', '2', '3', '4'].map((id) => ({ id, name: `Theme ${id}`, print: {} }));
  }

  themes.forEach((theme) => {
    if (!theme.href || document.querySelector(`link[href="${theme.href}"]`)) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = theme.href;
    document.head.append(link);
  });

  buildThemeMenu();
}

function buildThemeMenu() {
  const menu = $('themeMenu');
  menu.querySelectorAll('.theme-item[data-theme]').forEach((item) => item.remove());
  const separator = menu.querySelector('.theme-sep');

  themes.forEach((theme) => {
    const item = document.createElement('button');
    item.className = 'theme-item';
    item.setAttribute('role', 'menuitemradio');
    item.dataset.theme = theme.id;

    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.setAttribute('aria-hidden', 'true');
    const [a, b] = theme.swatch || [];
    if (a) swatch.style.background = `linear-gradient(135deg,${a} 50%,${b || a} 50%)`;

    item.append(swatch, document.createTextNode(theme.name || `Theme ${theme.id}`));
    item.addEventListener('click', () => {
      applyTheme(theme.id, document.documentElement.dataset.mode);
      menu.hidden = true;
      $('themeToggle').setAttribute('aria-expanded', 'false');
    });
    menu.insertBefore(item, separator);
  });
}

function applyTheme(theme, mode) {
  const root = document.documentElement;
  const entry = themeById(theme) || themes[0] || { id: theme };
  theme = entry.id;
  root.dataset.theme = theme;
  root.dataset.mode = mode;
  $('themeLabel').textContent = entry.name || `Theme ${theme}`;

  const [a, b] = entry.swatch || [];
  const swatch = $('themeToggle').querySelector('.swatch');
  if (a && swatch) swatch.style.background = `linear-gradient(135deg,${a} 50%,${b || a} 50%)`;
  $('modeLabel').textContent = mode === 'dark' ? 'Light mode' : 'Dark mode';
  document.querySelectorAll('.theme-item[data-theme]').forEach((item) => {
    item.setAttribute('aria-checked', String(item.dataset.theme === theme));
  });
  remember(THEME_KEY, theme);
  remember(MODE_KEY, mode);
  applyThemePrintDefaults(theme);
}

/* The chosen theme is written twice: to local storage, which is where the rest
 * of this app's preferences live, and to a cookie, which survives storage
 * being cleared or blocked and is what an installed window falls back on. Both
 * are read on the way back in, whichever answers first. */
function remember(key, value) {
  try { localStorage.setItem(key, value); } catch (error) { /* private mode */ }
  const year = 365 * 24 * 60 * 60;
  document.cookie = `${key}=${encodeURIComponent(value)};path=/;max-age=${year};samesite=lax`;
}

function recall(key) {
  try {
    const stored = localStorage.getItem(key);
    if (stored) return stored;
  } catch (error) { /* private mode */ }
  const match = document.cookie.match(new RegExp(`(?:^|; )${key.replace('.', '\\.')}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

function initTheme() {
  const prefersLight = window.matchMedia('(prefers-color-scheme: light)').matches;
  const saved = localStorage.getItem(THEME_KEY);
  applyTheme(
    themeById(saved) ? saved : (themes[0] && themes[0].id) || '1',
    localStorage.getItem(MODE_KEY) || (prefersLight ? 'light' : 'dark')
  );

  const toggle = $('themeToggle');
  const menu = $('themeMenu');

  const close = () => { menu.hidden = true; toggle.setAttribute('aria-expanded', 'false'); };
  const open = () => { menu.hidden = false; toggle.setAttribute('aria-expanded', 'true'); };

  toggle.addEventListener('click', (event) => {
    event.stopPropagation();
    menu.hidden ? open() : close();
  });
  document.addEventListener('click', (event) => {
    if (!menu.hidden && !menu.contains(event.target)) close();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !menu.hidden) { close(); toggle.focus(); }
  });

  $('modeToggle').addEventListener('click', () => {
    const next = document.documentElement.dataset.mode === 'dark' ? 'light' : 'dark';
    applyTheme(document.documentElement.dataset.theme, next);
  });
}

/* ------------------------------------------------------------------- tabs */
function initTabs() {
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => showView(tab.dataset.view));
  });
}

const VIEW_KEY = 'tp.view';

function showView(name) {
  if (!$(`view-${name}`)) name = 'compose';
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.setAttribute('aria-selected', String(tab.dataset.view === name));
  });
  document.querySelectorAll('.view').forEach((view) => {
    view.hidden = view.id !== `view-${name}`;
  });
  // where you were is where you meant to be: a reload while setting up a
  // label should not drop you back in the editor
  remember(VIEW_KEY, name);
  if (name === 'compose') $('editor').focus();
  // a panel that was hidden measured zero, so its ruler could not be drawn
  // until now
  if (typeof refreshRulers === 'function') refreshRulers();
  if (name === 'todos') refreshTodoPreview();
  if (name === 'calendar') refreshCalendar();
  if (name === 'labels') refreshLabel();
}

/* --------------------------------------------------------------- markdown */
/* Mirrors the desktop toolbar: wrap a selection, prefix whole lines, or drop
 * in a skeleton with the placeholder selected so typing replaces it. */
/* Indirection so the same helpers can drive the compose textarea or the one
 * in the preset editor; withPresetTextarea swaps this for one action. */
let editorTarget = () => $('editor');
const editor = () => editorTarget();

function replaceRange(start, end, text, selStart, selEnd) {
  const el = editor();
  el.setRangeText(text, start, end, 'end');
  if (selStart !== undefined) el.setSelectionRange(selStart, selEnd ?? selStart);
  el.focus();
  // setRangeText fires no input event, so the preview has to be told
  if (el.id === 'editor') schedulePreview();
}

/* --------------------------------------------------------- rendered editor */
/* Two editors over one document, and markdown is the document.
 *
 * Rendered mode is TipTap, vendored as a single file in static/vendor. Writing
 * this by hand meant reimplementing selection, undo, paste and tables, and the
 * tables were where it showed: a hand-rolled surface can decorate markdown but
 * it cannot give you a cell to type in. TipTap brings a real document model,
 * resizable columns and proper keyboard handling; the toolbar and the styling
 * stay ours, so the themes still own how it looks.
 *
 * Markdown remains what is saved and printed. The converters below are the
 * only bridge, and they speak this printer's dialect rather than a general
 * one: a newline is a line break, because that is what the paper does. */
const EDITOR_MODE_KEY = 'tp.editorMode';

const escapeHtml = (text) =>
  text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

let tt = null;                       // the TipTap editor
const isRendered = () => !$('editorShell').classList.contains('raw');
/* ------------------------------------------------------- markdown to html */
function inlineToHtml(text) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, (_m, code) => `<code>${code}</code>`)
    .replace(/!?\[([^\]]+)\]\(([^)]+)\)/g, (_m, label, href) =>
      `<a href="${href}">${label}</a>`)
    .replace(/~~([^~]+)~~/g, (_m, body) => `<del>${body}</del>`)
    .replace(/==([^=]+)==/g, (_m, body) => `<mark>${body}</mark>`)
    .replace(/\+\+([^+]+)\+\+/g, (_m, body) => `<u>${body}</u>`)
    .replace(/\^([^^\s]+)\^/g, (_m, body) => `<sup>${body}</sup>`)
    .replace(/(?<!~)~([^~\s]+)~(?!~)/g, (_m, body) => `<sub>${body}</sub>`)
    .replace(/(?<!\w)(?:\*\*|__)(?=\S)([\s\S]*?\S)(?:\*\*|__)(?!\w)/g,
      (_m, body) => `<strong>${body}</strong>`)
    .replace(/(?<![\w*_])[*_]([^*_\s][^*_]*?)[*_](?![\w*_])/g,
      (_m, body) => `<em>${body}</em>`);
}

/* how wide a table has to be to fill the writing pane; a plain number is
 * enough before the pane exists, since the next set of content re-measures */
function editorSpan() {
  return document.querySelector('.rich .ProseMirror')?.clientWidth || 600;
}

function tableToHtml(rows, align = [], borders = 'all', shares = []) {
  const head = rows[0] || [];
  const body = rows.slice(1);
  const width = Math.max(...rows.map((r) => r.length), 1);
  const total = shares.reduce((sum, share) => sum + share, 0) || 1;
  const attribute = (i) => {
    const parts = [];
    if (align[i] && align[i] !== 'left') {
      parts.push(` data-align="${align[i]}" style="text-align:${align[i]}"`);
    }
    // The share also rides on the cell, since that is where the editor reads a
    // column width from. The editor counts in pixels and sizes the table to
    // their sum, so a share is turned into a slice of the pane it is going
    // into: the table fills the width, divided as the document says, and an
    // edge dragged afterwards still has room to move. It is normalised back to
    // percentages on the way out, so only the ratio ever survives.
    if (shares[i]) parts.push(` colwidth="${Math.round((shares[i] / total) * editorSpan())}"`);
    return parts.join('');
  };
  const cells = (row, tag) => Array.from({ length: width }, (_v, i) =>
    `<${tag}${attribute(i)}>${inlineToHtml(row[i] || '') || '<br>'}</${tag}>`).join('');
  // A colgroup plus a fixed layout is what stops the columns jumping about
  // while a cell is being typed into; without it every keystroke re-measures
  // the whole table.
  // the shares the document carries, or an even split if it carries none
  const spread = shares.length === width && shares.every(Boolean)
    ? shares.map((share) => (share * 100) / shares.reduce((sum, v) => sum + v, 0))
    : Array.from({ length: width }, () => 100 / width);
  const cols = spread.map((share) => `<col style="width:${share.toFixed(4)}%">`).join('');
  const flag = ` data-borders="${borders}" class="borders-${borders}"`;
  return `<table${flag}><colgroup>${cols}</colgroup><thead><tr>${cells(head, 'th')}</tr></thead><tbody>${
    body.map((row) => `<tr>${cells(row, 'td')}</tr>`).join('')}</tbody></table>`;
}

/* A dragged column is a width in pixels, which means nothing on paper: what
 * carries over is the share of the table it takes. Shares only travel if they
 * were actually set, so a table nobody has dragged still prints sized to its
 * contents. */
function columnShares(table) {
  const cols = Array.from(table.querySelectorAll('col'));
  const widths = cols.map((col) => parseFloat(col.style.width) || 0);
  const row = table.querySelector('tr');
  const cells = row ? Array.from(row.children) : [];
  const measured = cells.map((cell) => Number(cell.getAttribute('colwidth')) || 0);
  const source = measured.some(Boolean) ? measured : widths;
  const total = source.reduce((sum, value) => sum + value, 0);
  if (!total || source.some((value) => !value)) return '';
  const shares = source.map((value) => Math.round((value / total) * 100));
  // an even split is what happens by default, so it is not worth recording
  const even = Math.round(100 / shares.length);
  if (shares.every((share) => Math.abs(share - even) <= 1)) return '';
  return shares.join(',');
}

const cellAlignment = (cell) => {
  const left = cell.startsWith(':');
  const right = cell.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  return 'left';
};

function mdToHtml(md) {
  const lines = (md || '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let borders = 'all';
  let shares = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed.startsWith('```')) {
      const code = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith('```')) { code.push(lines[i]); i += 1; }
      i += 1;
      out.push(`<pre>${escapeHtml(code.join('\n'))}</pre>`);
      continue;
    }

    // A deliberate blank line is content: it is a line of space on the paper
    // and an empty paragraph in the editor. Skipping it, which is what a
    // general markdown parser does, was why pressing Enter twice appeared to
    // do nothing.
    if (!trimmed) { out.push('<p></p>'); i += 1; continue; }

    const directive = /^<!--\s*table\s+(.*?)\s*-->$/.exec(trimmed);
    if (directive) {
      borders = (/borders=(\w+)/.exec(directive[1]) || [])[1] || '';
      shares = ((/widths=([\d,]+)/.exec(directive[1]) || [])[1] || '')
        .split(',').map(Number).filter(Boolean);
      i += 1;
      continue;
    }

    if (/^\s*([-*_]\s*){3,}$/.test(line)) { out.push('<hr>'); i += 1; continue; }

    const picture = /^!\[([^\]]*)\]\(\s*(\S+?)(?:\s+"([^"]*)")?\s*\)$/.exec(trimmed);
    if (picture) {
      const title = picture[3] ? ` title="${escapeHtml(picture[3])}"` : '';
      out.push(`<img src="${picture[2]}" alt="${escapeHtml(picture[1])}"${title}>`);
      i += 1;
      continue;
    }

    if (isTableLine(line)) {
      const rows = [];
      let align = [];
      while (i < lines.length && isTableLine(lines[i])) {
        if (isSeparatorRow(lines[i])) align = tableCells(lines[i]).map(cellAlignment);
        else rows.push(tableCells(lines[i]));
        i += 1;
      }
      out.push(tableToHtml(rows, align, borders, shares));
      borders = 'all';
      shares = [];
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      const level = Math.min(heading[1].length, 6);
      out.push(`<h${level}>${inlineToHtml(heading[2])}</h${level}>`);
      i += 1;
      continue;
    }

    if (trimmed.startsWith('>')) {
      const quoted = [];
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        quoted.push(lines[i].trim().replace(/^>\s?/, ''));
        i += 1;
      }
      out.push(`<blockquote>${quoted.map(inlineToHtml).join('<br>')}</blockquote>`);
      continue;
    }

    // a task list is a bullet list whose items start with a box
    if (/^[-*+]\s+\[[ xX]\]\s/.test(trimmed)) {
      const items = [];
      while (i < lines.length && /^[-*+]\s+\[[ xX]\]\s/.test(lines[i].trim())) {
        const item = /^[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(lines[i].trim());
        items.push(`<li data-type="taskItem" data-checked="${
          item[1].toLowerCase() === 'x'}"><p>${inlineToHtml(item[2])}</p></li>`);
        i += 1;
      }
      out.push(`<ul data-type="taskList">${items.join('')}</ul>`);
      continue;
    }

    const bullet = /^[-*+]\s+/;
    const numbered = /^\d+[.)]\s+/;
    if (bullet.test(trimmed) || numbered.test(trimmed)) {
      const ordered = numbered.test(trimmed);
      const items = [];
      const marker = ordered ? numbered : bullet;
      while (i < lines.length && marker.test(lines[i].trim())) {
        items.push(inlineToHtml(lines[i].trim().replace(marker, '')));
        i += 1;
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>${items.map((t) => `<li>${t}</li>`).join('')}</${tag}>`);
      continue;
    }

    // one paragraph per typed line, the same rule the printer follows
    out.push(`<p>${inlineToHtml(trimmed)}</p>`);
    i += 1;
  }

  return out.join('') || '<p><br></p>';
}

/* ------------------------------------------------------- html to markdown */
function inlineToMd(node) {
  if (node.nodeType === Node.TEXT_NODE) return node.nodeValue.replace(/\s+/g, ' ');
  if (node.nodeType !== Node.ELEMENT_NODE) return '';

  const inner = Array.from(node.childNodes).map(inlineToMd).join('');
  switch (node.nodeName) {
    case 'BR': return '\n';
    case 'STRONG': case 'B': return inner.trim() ? `**${inner.trim()}**` : '';
    case 'EM': case 'I': return inner.trim() ? `*${inner.trim()}*` : '';
    case 'DEL': case 'S': case 'STRIKE': return inner.trim() ? `~~${inner.trim()}~~` : '';
    // markdown proper has none of these; these are the spellings the wider
    // ecosystem settled on, and the renderer understands the same ones
    case 'MARK': return inner.trim() ? `==${inner.trim()}==` : '';
    case 'U': return inner.trim() ? `++${inner.trim()}++` : '';
    case 'SUP': return inner.trim() ? `^${inner.trim()}^` : '';
    case 'SUB': return inner.trim() ? `~${inner.trim()}~` : '';
    case 'CODE': return inner.trim() ? `\`${inner.trim()}\`` : '';
    case 'A': return `[${inner}](${node.getAttribute('href') || ''})`;
    default: return inner;
  }
}

const cellText = (cell) => inlineToMd(cell).replace(/\n/g, ' ').trim();

function blockToMd(node) {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.nodeValue.trim();
    return text ? [text] : [];
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return [];
  // an empty paragraph is a blank line, not nothing
  if (node.nodeName === 'P' && !node.textContent.trim() && !node.querySelector('img')) return [''];

  const name = node.nodeName;
  const inline = () => inlineToMd(node).split('\n').map((l) => l.trim());

  if (/^H[1-6]$/.test(name)) return [`${'#'.repeat(Number(name[1]))} ${inlineToMd(node).trim()}`];
  if (name === 'HR') return ['---'];
  if (name === 'PRE') return ['```', ...(node.textContent || '').split('\n'), '```'];
  if (name === 'BLOCKQUOTE') {
    return inline().filter((l, i, all) => l || i < all.length - 1).map((l) => `> ${l}`.trimEnd());
  }
  if (name === 'UL' && node.dataset.type === 'taskList') {
    return Array.from(node.children).map((li) =>
      `- [${li.dataset.checked === 'true' ? 'x' : ' '}] ${inlineToMd(li).trim()}`);
  }
  if (name === 'UL' || name === 'OL') {
    return Array.from(node.children).map((li, index) =>
      `${name === 'OL' ? `${index + 1}.` : '-'} ${inlineToMd(li).trim()}`);
  }
  if (name === 'IMG') {
    const title = node.getAttribute('title');
    const target = title
      ? `${node.getAttribute('src') || ''} "${title}"`
      : node.getAttribute('src') || '';
    return [`![${node.getAttribute('alt') || ''}](${target})`];
  }
  if (name === 'TABLE') {
    const rows = Array.from(node.querySelectorAll('tr'))
      .map((tr) => Array.from(tr.children).map(cellText));
    if (!rows.length) return [];
    // alignment rides in the separator row, where any other reader finds it.
    // Borders and column widths have no markdown syntax at all, so they go in
    // a directive comment: any other reader ignores it, and this one prints
    // the table the width you dragged it to.
    const align = Array.from(node.querySelector('tr')?.children || [])
      .map((cell) => cell.dataset.align || 'left');
    const out = formatTable([rows[0], null, ...rows.slice(1)], align).split('\n');
    const parts = [];
    // "all" is the default but it is still written down: a table that says
    // nothing would otherwise be at the mercy of whatever the default becomes
    parts.push(`borders=${node.dataset.borders || 'all'}`);   // theme|all|none
    const widths = columnShares(node);
    if (widths) parts.push(`widths=${widths}`);
    return parts.length ? [`<!-- table ${parts.join(' ')} -->`, ...out] : out;
  }
  if (node.querySelector?.('img') && name !== 'IMG') {
    return Array.from(node.childNodes).flatMap(blockToMd);
  }
  if (name === 'DIV' && node.querySelector('h1,h2,h3,h4,h5,h6,ul,ol,table,blockquote,pre,div,p')) {
    // Chrome sometimes nests blocks inside a wrapper div; walk into it
    return Array.from(node.childNodes).flatMap(blockToMd);
  }
  return inline();
}

function htmlToMd(root) {
  const blocks = Array.from(root.childNodes).map(blockToMd).filter((b) => b.length);
  // No inserted gaps: blank lines are the author's, and collapsing runs of
  // them would silently edit the document. Tables and fences parse without
  // needing one.
  return blocks.flat().join('\n').replace(/\s+$/, '');
}

/* -------------------------------------------------------------- the document */
/* One accessor for the text, whichever surface is in front. */
function editorMarkdown() {
  if (!isRendered() || !tt) return $('editor').value;
  const holder = document.createElement('div');
  holder.innerHTML = tt.getHTML();
  return htmlToMd(holder);
}

function setEditorMarkdown(md) {
  $('editor').value = md;
  if (tt) tt.commands.setContent(mdToHtml(md), false);
}

function setEditorMode(mode) {
  const shell = $('editorShell');
  const raw = mode === 'raw';
  const wasRaw = shell.classList.contains('raw');

  if (raw && !wasRaw) $('editor').value = editorMarkdown();
  if (!raw && wasRaw && tt) tt.commands.setContent(mdToHtml($('editor').value), false);

  shell.classList.toggle('raw', raw);
  $('modeRendered').setAttribute('aria-pressed', String(!raw));
  $('modeRaw').setAttribute('aria-pressed', String(raw));
  localStorage.setItem(EDITOR_MODE_KEY, raw ? 'raw' : 'rendered');
  if (raw) $('editor').focus();
  else tt?.commands.focus();
  syncToolbarState();
}

/* --------------------------------------------------------------- the editor */
/* Markdown has no syntax for how a table is ruled, so that lives on the node
 * and is written out as a directive comment; column alignment does have a
 * syntax, and rides in the separator row where any other reader will find it. */
function tableExtensions() {
  const { Table, TableCell, TableHeader } = window.TipTap;

  const withAlign = (base) => base.extend({
    addAttributes() {
      return {
        ...this.parent?.(),
        align: {
          default: null,
          parseHTML: (element) => element.dataset.align || null,
          renderHTML: (attributes) => (attributes.align
            ? { 'data-align': attributes.align, style: `text-align:${attributes.align}` }
            : {}),
        },
      };
    },
  });

  const table = Table.extend({
    addAttributes() {
      return {
        ...this.parent?.(),
        // A grid is what a table is for, so a table that says nothing gets
        // one. The class rides along with the attribute, since the editor's
        // own rules are drawn in CSS while the printer's are drawn in dots.
        borders: {
          default: 'all',
          parseHTML: (element) => element.dataset.borders || 'all',
          renderHTML: (attributes) => ({
            'data-borders': attributes.borders || 'all',
            class: `borders-${attributes.borders || 'all'}`,
          }),
        },
      };
    },
  });

  return [table.configure({ resizable: true }), withAlign(TableCell), withAlign(TableHeader)];
}

/* Typing {{ offers the tokens that get filled in at print time. They are
 * inserted as plain text rather than as a node, so the document stays ordinary
 * markdown and a preset written by hand behaves identically. */
const TOKENS = [
  { id: '{{date}}', label: 'date' },
  { id: '{{time}}', label: 'time' },
  { id: '{{datetime}}', label: 'date and time' },
  { id: '{{weekday}}', label: 'weekday' },
];

function tokenSuggestion() {
  let list = null;
  let items = [];
  let active = 0;
  let range = null;

  const close = () => { list?.remove(); list = null; };

  const paint = () => {
    if (!list) return;
    list.innerHTML = '';
    items.forEach((item, index) => {
      const option = document.createElement('button');
      option.className = `token-option${index === active ? ' is-active' : ''}`;
      option.textContent = `${item.id}  ${item.label}`;
      option.addEventListener('mousedown', (event) => { event.preventDefault(); choose(index); });
      list.append(option);
    });
  };

  const choose = (index) => {
    const item = items[index];
    if (!item || !range) return;
    tt.chain().focus().insertContentAt(range, item.id).run();
    close();
  };

  return {
    char: '{{',
    startOfLine: false,
    items: ({ query }) => TOKENS.filter((token) =>
      token.label.startsWith(query.toLowerCase()) || token.id.includes(query.toLowerCase())),
    render: () => ({
      onStart: (props) => {
        items = props.items; active = 0; range = props.range;
        list = document.createElement('div');
        list.className = 'token-menu';
        const box = props.clientRect?.();
        const shell = $('editorShell').getBoundingClientRect();
        if (box) {
          list.style.left = `${box.left - shell.left}px`;
          list.style.top = `${box.bottom - shell.top + 4}px`;
        }
        $('editorShell').append(list);
        paint();
      },
      onUpdate: (props) => { items = props.items; range = props.range; paint(); },
      onKeyDown: (props) => {
        if (!list) return false;
        if (props.event.key === 'ArrowDown') { active = (active + 1) % items.length; paint(); return true; }
        if (props.event.key === 'ArrowUp') { active = (active - 1 + items.length) % items.length; paint(); return true; }
        if (props.event.key === 'Enter') { choose(active); return true; }
        if (props.event.key === 'Escape') { close(); return true; }
        return false;
      },
      onExit: close,
    }),
  };
}

/* A picture can arrive by paste or by drop as well as through the button, and
 * all three take the same road: upload, then a markdown reference. */
function handleDroppedFiles(files) {
  const images = Array.from(files || []).filter((file) => file.type.startsWith('image/'));
  if (!images.length) return false;
  images.forEach((file) => uploadAndInsert(file));
  return true;
}

function initRichEditor() {
  const {
    Editor, StarterKit, TableRow, Image, Link, TaskList, TaskItem,
    CharacterCount, Placeholder, Mention,
    Underline, Highlight, Subscript, Superscript,
  } = window.TipTap;

  tt = new Editor({
    element: $('rich'),
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
      ...tableExtensions(),
      TableRow,
      TaskList,
      TaskItem.configure({ nested: false }),
      Image.configure({ inline: false, allowBase64: false }),
      Link.configure({ openOnClick: false }),
      Underline,
      Highlight,
      Subscript,
      Superscript,
      CharacterCount,
      Placeholder.configure({
        placeholder: 'Type here. Markdown works, and {{ offers the date tokens.',
      }),
      Mention.configure({
        renderText: ({ node }) => node.attrs.id,
        suggestion: tokenSuggestion(),
      }),
    ],
    editorProps: {
      handlePaste: (view, event) => handleDroppedFiles(event.clipboardData?.files),
      handleDrop: (view, event) => handleDroppedFiles(event.dataTransfer?.files),
    },
    content: '<p></p>',
    onUpdate: () => {
      schedulePreview();
      positionTableTools();
      positionImageTools();
      syncToolbarState();
      syncTableBorders();
      updateCounts();
    },
    onSelectionUpdate: () => {
      positionTableTools();
      positionImageTools();
      syncToolbarState();
    },
    onBlur: () => setTimeout(() => {
      const ribbon = $('tableRibbon');
      if (ribbon && !ribbon.contains(document.activeElement)) ribbon.hidden = true;
    }, 150),
  });
}

function initEditorModes() {
  initRichEditor();
  $('modeRendered').addEventListener('click', () => setEditorMode('rendered'));
  $('modeRaw').addEventListener('click', () => setEditorMode('raw'));
  // Always open in the rendered editor. Raw markdown is there when you want
  // it, but it is a view of the document rather than a mode to be left in, and
  // opening in it is a surprise every time.
  setEditorMode('rendered');
  initTableTools();
  initImageTools();
  syncToolbarState();
  syncTableBorders();
}

/* ---------------------------------------------------------------- pictures */
/* The browser has the file and the printer has the paper, so the picture goes
 * to the server, which keeps it by content hash and hands back a reference the
 * document can carry. The renderer dithers it at print time. */
async function uploadAndInsert(file) {
  try {
    const data = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
    const result = await api('/api/images', { method: 'POST', body: JSON.stringify({ data }) });
    // No alt text: a file name is not a description, and the renderer prints
    // the alt when a picture cannot be loaded, so "IMG_2231.jpeg" would end up
    // on the paper. Anyone who wants a caption can type one.
    tt.chain().focus().setImage({ src: result.url, alt: '' }).run();
    schedulePreview();
  } catch (error) {
    toast(`Could not add that image: ${error.message}`, true);
  }
}

function insertImage() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.addEventListener('change', () => {
    if (input.files?.[0]) uploadAndInsert(input.files[0]);
  });
  input.click();
}

/* Characters and words are what a text editor counts; on a receipt printer the
 * number that matters is how much paper this will take, so that is estimated
 * from the rendered height the preview just reported. */
function updateCounts() {
  const counter = $('docCount');
  if (!counter || !tt?.storage.characterCount) return;
  const words = tt.storage.characterCount.words();
  const characters = tt.storage.characterCount.characters();
  counter.textContent = `${words} word${words === 1 ? '' : 's'} · ${characters} chars${
    lastPaperMm ? ` · ${lastPaperMm} mm` : ''}`;
}

let lastPaperMm = 0;

const isRawMode = () => !isRendered();

/* ------------------------------------------------------------ image controls */
/* How a picture is reduced to one bit is the most consequential choice in
 * printing it, and the right answer depends on the picture: a hard threshold
 * for line art, error diffusion for a photograph, Atkinson when the paper is
 * mostly dark. It is a property of the image, so it rides in markdown's title
 * slot and stays with the document. */
let ditherModes = [];
let ditherPrefilters = [];

async function loadDitherModes() {
  try {
    const data = await api('/api/dither');
    ditherModes = data.modes || [];
    ditherPrefilters = data.prefilters || [];
  } catch (error) {
    ditherModes = [];
    ditherPrefilters = [];
  }
  const select = $('imageDither');
  const settings = $('defaultDither');
  [select, settings].forEach((element) => {
    if (!element) return;
    element.innerHTML = '';
    ditherModes.forEach(({ id, label }) => element.append(new Option(label, id)));
  });
  if (settings) settings.value = localStorage.getItem(DITHER_KEY) || 'floyd-steinberg';

  // Dithering decides how grey becomes dots; preparation decides what grey the
  // dithering is given. A flat phone photograph of a page is the case that
  // needs it: no threshold rescues it, a contrast stretch does.
  const prefilter = $('imagePrefilter');
  if (prefilter) {
    prefilter.innerHTML = '';
    ditherPrefilters.forEach(({ id, label }) => prefilter.append(new Option(label, id)));
  }
}

const DITHER_KEY = 'tp.dither';
const THRESHOLD_KEY = 'tp.ditherThreshold';
const STRENGTH_KEY = 'tp.ditherStrength';
const DEFAULT_THRESHOLD = 128;
const DEFAULT_STRENGTH = 100;

const currentDither = () => localStorage.getItem(DITHER_KEY) || 'floyd-steinberg';
const currentThreshold = () => Number(localStorage.getItem(THRESHOLD_KEY) ?? DEFAULT_THRESHOLD);
const currentStrength = () => Number(localStorage.getItem(STRENGTH_KEY) ?? DEFAULT_STRENGTH);

/* An image's screening rides in markdown's title slot as "mode t=<cutoff>
 * s=<amount>". Anything the picture does not say falls back to the page
 * setting, so a document written before these controls existed still reads. */
function parseScreen(title) {
  const parts = String(title || '').trim().split(/\s+/).filter(Boolean);
  const mode = parts[0] && !parts[0].includes('=') ? parts[0] : currentDither();
  const options = {};
  parts.filter((part) => part.includes('=')).forEach((part) => {
    const [key, value] = part.split('=');
    options[key] = Number(value);
  });
  const prefilter = parts
    .filter((part) => part.startsWith('f='))
    .map((part) => part.slice(2))[0];
  return {
    mode,
    threshold: Number.isFinite(options.t) ? options.t : currentThreshold(),
    strength: Number.isFinite(options.s) ? Math.round(options.s * 100) : currentStrength(),
    prefilter: prefilter || 'none',
  };
}

function screenTitle({ mode, threshold, strength, prefilter }) {
  const parts = [mode];
  if (threshold !== currentThreshold()) parts.push(`t=${threshold}`);
  if (strength !== currentStrength()) parts.push(`s=${(strength / 100).toFixed(2)}`);
  if (prefilter && prefilter !== 'none') parts.push(`f=${prefilter}`);
  return parts.join(' ');
}

/* Ask the document, not the DOM: a node selection is a fact about the editor
 * state, while the selected-node class is a rendering detail that is not
 * always there when the selection is set programmatically. */
const imageSelected = () => Boolean(tt && tt.isActive('image'));

function positionImageTools() {
  const tools = $('imageTools');
  if (!tools) return;
  const showing = isRendered() && imageSelected();
  tools.hidden = !showing;
  if (showing) {
    const screen = parseScreen(tt.getAttributes('image').title);
    $('imageDither').value = screen.mode;
    if ($('imagePrefilter')) $('imagePrefilter').value = screen.prefilter;
    setSlider('imageThreshold', screen.threshold);
    setSlider('imageStrength', screen.strength, '%');
  }
}

/* A range and its readout move together, and the readout is the only place the
 * number appears, so they are set as a pair everywhere. */
function setSlider(id, value, suffix = '') {
  const input = $(id);
  if (!input) return;
  input.value = value;
  const readout = $(`${id}Out`);
  if (readout) readout.value = `${value}${suffix}`;
}

function applyScreenToImage() {
  if (!tt.isActive('image')) return;
  const title = screenTitle({
    mode: $('imageDither').value,
    threshold: Number($('imageThreshold').value),
    strength: Number($('imageStrength').value),
    prefilter: $('imagePrefilter') ? $('imagePrefilter').value : 'none',
  });
  // Deliberately not focus(): the editor scrolls the selection into view when
  // it takes focus back, which throws the page around under a slider that is
  // being dragged. The selection is still on the picture whether or not the
  // editor holds focus, so the attribute lands either way.
  tt.commands.updateAttributes('image', { title });
  schedulePreview();
}

function initImageTools() {
  const select = $('imageDither');
  if (!select) return;
  select.addEventListener('change', applyScreenToImage);
  $('imagePrefilter')?.addEventListener('change', applyScreenToImage);
  ['imageThreshold', 'imageStrength'].forEach((id) => {
    const suffix = id === 'imageStrength' ? '%' : '';
    $(id)?.addEventListener('input', () => setSlider(id, Number($(id).value), suffix));
    $(id)?.addEventListener('change', applyScreenToImage);
  });
  document.querySelector('[data-image="reset"]')?.addEventListener('click', () => {
    if (!tt.isActive('image')) return;
    setSlider('imageThreshold', currentThreshold());
    setSlider('imageStrength', currentStrength(), '%');
    $('imageDither').value = currentDither();
    if ($('imagePrefilter')) $('imagePrefilter').value = 'none';
    tt.commands.updateAttributes('image', { title: null });
    schedulePreview();
  });

  $('defaultDither')?.addEventListener('change', () => {
    localStorage.setItem(DITHER_KEY, $('defaultDither').value);
    refreshPreview();
  });
  const defaults = [
    ['defaultThreshold', THRESHOLD_KEY, '', DEFAULT_THRESHOLD],
    ['defaultStrength', STRENGTH_KEY, '%', DEFAULT_STRENGTH],
  ];
  defaults.forEach(([id, key, suffix, fallback]) => {
    const input = $(id);
    if (!input) return;
    setSlider(id, Number(localStorage.getItem(key) ?? fallback), suffix);
    input.addEventListener('input', () => setSlider(id, Number(input.value), suffix));
    // written on release rather than on every pixel of the drag, so the
    // preview is asked for once per adjustment
    input.addEventListener('change', () => {
      localStorage.setItem(key, input.value);
      refreshPreview();
    });
  });
}

/* ------------------------------------------------------------ table controls */
const TABLE_TOOLS = {
  'row-after': () => tt.chain().focus().addRowAfter().run(),
  'col-after': () => tt.chain().focus().addColumnAfter().run(),
  'row-delete': () => tt.chain().focus().deleteRow().run(),
  'col-delete': () => tt.chain().focus().deleteColumn().run(),
  'align-left': () => setCellAlign('left'),
  'align-center': () => setCellAlign('center'),
  'align-right': () => setCellAlign('right'),
  borders: () => cycleBorders(),
  'table-delete': () => tt.chain().focus().deleteTable().run(),
};

/* Alignment is a property of the column, since that is all markdown can say,
 * so setting it on one cell sets it down the whole column. */
function setCellAlign(align) {
  const dom = tt.view.domAtPos(tt.state.selection.from).node;
  const cell = (dom.nodeType === 1 ? dom : dom.parentElement)?.closest('td,th');
  const table = cell?.closest('table');
  if (!cell || !table) return;

  const column = Array.from(cell.parentElement.children).indexOf(cell);
  Array.from(table.querySelectorAll('tr')).forEach((row) => {
    const target = row.children[column];
    if (!target) return;
    target.dataset.align = align;
    target.style.textAlign = align;
  });
  // the DOM was edited under ProseMirror, so the document is re-read from it
  tt.commands.setContent(tt.view.dom.innerHTML, false);
  schedulePreview();
}

const BORDER_MODES = ['theme', 'all', 'none'];

/* Borders are set outright now rather than cycled: a menu can say what the
 * three choices are, where a button that changes on every press cannot. */
function setBorders(mode) {
  if (!tt?.isActive('table')) return;
  // set on the node rather than on the element: the element is a rendering of
  // the node, and setting it there is undone the moment anything re-renders
  tt.commands.updateAttributes('table', { borders: mode || 'theme' });
  syncTableBorders();
}

/* The editor draws tables through a node view of its own, which does not carry
 * our attribute onto the element, so the element is told separately. The node
 * stays the truth; this only decides which rules are painted on screen. */
function syncTableBorders() {
  if (!tt) return;
  const tables = [];
  tt.state.doc.descendants((node, pos) => {
    if (node.type.name === 'table') tables.push([node, pos]);
    return true;
  });
  tables.forEach(([node, pos]) => {
    let element = tt.view.nodeDOM(pos);
    if (element && element.nodeType === 1 && element.tagName !== 'TABLE') {
      element = element.querySelector('table') || element;
    }
    if (!element || element.tagName !== 'TABLE') return;
    const mode = node.attrs.borders || 'all';
    element.dataset.borders = mode;
    element.classList.toggle('borders-all', mode === 'all');
    element.classList.toggle('borders-none', mode === 'none');
  });
}

const cycleBorders = () => {
  const now = currentTableElement()?.dataset.borders || 'all';
  setBorders(now === 'all' ? 'none' : (now === 'none' ? 'theme' : 'all'));
  schedulePreview();
};

function currentTableElement() {
  if (!tt || !tt.isActive('table')) return null;
  const dom = tt.view.domAtPos(tt.state.selection.from).node;
  const element = dom.nodeType === 1 ? dom : dom.parentElement;
  return element?.closest('table') || null;
}

/* Docked to the top of the pane rather than floating over the table: anchored
 * to the table it covered whatever line sat above it, which is usually the one
 * being worked on. */
function positionTableTools() {
  const table = isRendered() ? currentTableElement() : null;
  const column = $('tableAddColumn');
  const row = $('tableAddRow');
  const ribbon = $('tableRibbon');
  if (!column || !row || !ribbon) return;

  if (!table) {
    [column, row, ribbon].forEach((element) => { element.hidden = true; });
    return;
  }

  // positioned against the editor shell, which is the nearest thing with a
  // position of its own; the table's own box moves as rows are added
  const shell = $('rich').closest('.editor-shell') || $('rich').parentElement;
  const frame = shell.getBoundingClientRect();
  const box = table.getBoundingClientRect();

  [column, row, ribbon].forEach((element) => { element.hidden = false; });
  // inside the right edge: a table usually runs the full width of the editor,
  // so a plus placed beyond it would be clipped by the panel
  column.style.left = `${Math.min(box.right - frame.left - 28, frame.width - 34)}px`;
  column.style.top = `${box.top - frame.top + (box.height - 24) / 2}px`;
  row.style.left = `${box.left - frame.left}px`;
  row.style.top = `${box.bottom - frame.top + 6}px`;

  const width = ribbon.offsetWidth || 260;
  ribbon.style.left = `${Math.max(6, Math.min(box.right - frame.left - width, frame.width - width - 6))}px`;
  ribbon.style.top = `${Math.max(2, box.top - frame.top - ribbon.offsetHeight - 6)}px`;

  describeTable();
}

function initTableTools() {
  const run = (action) => {
    TABLE_TOOLS[action]?.();
    positionTableTools();
    schedulePreview();
  };

  // mousedown throughout, so a command runs before the caret is lost to the
  // button that ran it
  const press = (element, handler) => element?.addEventListener('mousedown', (event) => {
    event.preventDefault();
    handler();
  });

  press($('tableAddColumn'), () => run('col-after'));
  press($('tableAddRow'), () => run('row-after'));

  document.querySelectorAll('#tableRibbon [data-table]').forEach((button) => {
    press(button, () => run(button.dataset.table));
  });
  document.querySelectorAll('#tableRibbon [data-borders]').forEach((button) => {
    press(button, () => {
      setBorders(button.dataset.borders || 'theme');
      positionTableTools();
      schedulePreview();
    });
  });
  press($('tableWidthsEven'), () => applyWidthFields(true));
}

/* The ribbon reflects the table it is sitting on: which border treatment is in
 * force, and how the width is divided. */
function describeTable() {
  const table = currentTableElement();
  if (!table) return;
  const mode = table.dataset.borders || 'all';
  document.querySelectorAll('#tableRibbon [data-borders]').forEach((button) => {
    button.classList.toggle('is-active', (button.dataset.borders || 'theme') === mode);
  });
  buildWidthFields(table, table.querySelector('tr')?.children.length || 0);
}

/* One field per column, in percent. A number is a poorer gesture than dragging
 * an edge, but it is one that survives being saved: the shares travel with the
 * document and the renderer prints the table divided the same way. */
function buildWidthFields(table, columns) {
  const host = $('tableWidths');
  if (!host) return;
  const current = readShares(table, columns);
  // rebuilding on every keystroke would take the caret out of the field being
  // typed into, so it is only rebuilt when the shape changes
  if (host.children.length === columns
      && Array.from(host.children).every((field, index) => Number(field.value) === current[index])) {
    return;
  }
  if (document.activeElement?.parentElement === host) return;

  host.innerHTML = '';
  current.forEach((share, index) => {
    const field = document.createElement('input');
    field.className = 'rib-width';
    field.type = 'number';
    field.min = '5';
    field.max = '90';
    field.step = '5';
    field.value = String(share);
    field.title = `Column ${index + 1}, as a percentage of the table`;
    field.addEventListener('change', () => applyWidthFields());
    host.append(field);
  });
}

function readShares(table, columns) {
  const cells = Array.from(table.querySelector('tr')?.children || []);
  const measured = cells.map((cell) => Number(cell.getAttribute('colwidth')) || 0);
  if (measured.some(Boolean) && measured.every(Boolean)) {
    const total = measured.reduce((sum, value) => sum + value, 0);
    return measured.map((value) => Math.round((value / total) * 100));
  }
  const even = Math.round(100 / Math.max(1, columns));
  return Array.from({ length: columns }, () => even);
}

function applyWidthFields(even = false) {
  const table = currentTableElement();
  const host = $('tableWidths');
  if (!table || !host) return;
  const fields = Array.from(host.children);
  const columns = fields.length || 1;
  const shares = even
    ? Array.from({ length: columns }, () => Math.round(100 / columns))
    : fields.map((field) => Math.max(5, Number(field.value) || 0));
  const total = shares.reduce((sum, value) => sum + value, 0) || 1;

  // pixels, because that is what the editor's own column widths are in. The
  // span comes from the pane rather than from the table, since the table's own
  // width is whatever the last set of widths made it: measuring that and
  // dividing it again would shrink the table a little on every edit.
  const span = table.parentElement?.clientWidth || table.clientWidth || 600;
  Array.from(table.querySelectorAll('tr')).forEach((row) => {
    Array.from(row.children).forEach((cell, index) => {
      if (!shares[index]) return;
      cell.setAttribute('colwidth', String(Math.round((shares[index] / total) * span)));
    });
  });
  Array.from(table.querySelectorAll('col')).forEach((col, index) => {
    col.style.width = `${((shares[index] || 0) * 100 / total).toFixed(4)}%`;
  });

  tt.commands.setContent(tt.view.dom.innerHTML, false);
  positionTableTools();
  schedulePreview();
}

/* ---------------------------------------------------------- rich commands */
/* Every one of these that can be on or off is a toggle, and the toolbar says
 * which: pressing Bold inside bold text takes it off again, and H1 on a
 * heading turns it back into a paragraph. The ones with no "off" state
 * (insert a table, a rule, a picture) simply never light up. */
const ACTIVE_STATE = {
  h1: () => tt.isActive('heading', { level: 1 }),
  h2: () => tt.isActive('heading', { level: 2 }),
  h3: () => tt.isActive('heading', { level: 3 }),
  bold: () => tt.isActive('bold'),
  italic: () => tt.isActive('italic'),
  strike: () => tt.isActive('strike'),
  code: () => tt.isActive('code'),
  ul: () => tt.isActive('bulletList'),
  ol: () => tt.isActive('orderedList'),
  quote: () => tt.isActive('blockquote'),
  codeblock: () => tt.isActive('codeBlock'),
  link: () => tt.isActive('link'),
  table: () => tt.isActive('table'),
  math: () => tt.isActive('code'),
  tasks: () => tt.isActive('taskList'),
  underline: () => tt.isActive('underline'),
  highlight: () => tt.isActive('highlight'),
  sup: () => tt.isActive('superscript'),
  sub: () => tt.isActive('subscript'),
};

function syncToolbarState() {
  const rendered = isRendered() && tt;
  document.querySelectorAll('.tool[data-md]').forEach((button) => {
    const check = ACTIVE_STATE[button.dataset.md];
    const on = Boolean(rendered && check && check());
    button.classList.toggle('is-active', on);
    button.setAttribute('aria-pressed', String(on));
  });
}

const RICH_ACTIONS = {
  h1: () => tt.chain().focus().toggleHeading({ level: 1 }).run(),
  h2: () => tt.chain().focus().toggleHeading({ level: 2 }).run(),
  h3: () => tt.chain().focus().toggleHeading({ level: 3 }).run(),
  bold: () => tt.chain().focus().toggleBold().run(),
  italic: () => tt.chain().focus().toggleItalic().run(),
  strike: () => tt.chain().focus().toggleStrike().run(),
  code: () => tt.chain().focus().toggleCode().run(),
  ul: () => tt.chain().focus().toggleBulletList().run(),
  ol: () => tt.chain().focus().toggleOrderedList().run(),
  quote: () => tt.chain().focus().toggleBlockquote().run(),
  rule: () => tt.chain().focus().setHorizontalRule().run(),
  codeblock: () => tt.chain().focus().toggleCodeBlock().run(),
  math: () => tt.chain().focus().toggleCode().run(),
  image: () => insertImage(),
  tasks: () => tt.chain().focus().toggleTaskList().run(),
  underline: () => tt.chain().focus().toggleUnderline().run(),
  highlight: () => tt.chain().focus().toggleHighlight().run(),
  sup: () => tt.chain().focus().toggleSuperscript().run(),
  sub: () => tt.chain().focus().toggleSubscript().run(),
  link: () => {
    // pressing it on an existing link takes the link off, which is what a
    // toggle in a toolbar is expected to do
    if (tt.isActive('link')) {
      tt.chain().focus().extendMarkRange('link').unsetLink().run();
      return;
    }
    const href = window.prompt('Link address', 'https://');
    if (!href) return;
    tt.chain().focus().extendMarkRange('link').setLink({ href }).run();
  },
  // a selected comma separated list becomes a real table, which is how this
  // data usually arrives
  table: () => {
    const { from, to } = tt.state.selection;
    const selected = tt.state.doc.textBetween(from, to, '\n').trim();
    const rows = selected
      ? selected.split('\n').map((line) => line.trim()).filter(Boolean).map(splitCells)
      : [];

    if (rows.length && (rows.length > 1 || rows[0].length > 1)) {
      tt.chain().focus().deleteSelection().insertContent(tableToHtml(rows)).run();
    } else {
      tt.chain().focus().insertTable({ rows: 3, cols: 2, withHeaderRow: true }).run();
    }
    schedulePreview();
  },
};

const isWrapped = (text, prefix, suffix) =>
  text.length >= prefix.length + suffix.length &&
  text.startsWith(prefix) && text.endsWith(suffix);

/* Find the marked-up span the caret is sitting inside, so pressing the button
 * again with no selection removes the markers rather than nesting new ones. */
function enclosingSpan(value, caret, prefix, suffix) {
  const lineStart = value.lastIndexOf('\n', caret - 1) + 1;
  let lineEnd = value.indexOf('\n', caret);
  if (lineEnd === -1) lineEnd = value.length;

  const open = value.lastIndexOf(prefix, caret - 1);
  if (open < lineStart) return null;

  const close = value.indexOf(suffix, Math.max(open + prefix.length, caret));
  if (close === -1 || close + suffix.length > lineEnd) return null;

  // a single "*" sitting next to another is part of "**", a different marker
  if (prefix.length === 1 &&
      (value[open - 1] === prefix || value[open + 1] === prefix ||
       value[close - 1] === suffix || value[close + 1] === suffix)) {
    return null;
  }
  return { start: open, end: close + suffix.length };
}

/* Inline emphasis. Applying it twice takes it off again, and the behaviour
 * follows what is selected: nothing, part of a line, or several lines. */
function toggleWrap(prefix, suffix, placeholder) {
  const el = editor();
  const value = el.value;
  const a = el.selectionStart;
  const b = el.selectionEnd;

  // --- no selection: unwrap where the caret is, else drop in a placeholder
  if (a === b) {
    const span = enclosingSpan(value, a, prefix, suffix);
    if (span) {
      const inner = value.slice(span.start + prefix.length, span.end - suffix.length);
      replaceRange(span.start, span.end, inner, span.start, span.start + inner.length);
    } else {
      replaceRange(a, b, `${prefix}${placeholder}${suffix}`,
        a + prefix.length, a + prefix.length + placeholder.length);
    }
    return;
  }

  const selected = value.slice(a, b);

  // --- several lines: emphasis does not survive a newline in markdown, so
  //     each line is marked on its own, and indentation is left alone.
  //     The range snaps out to whole lines first, since a drag that stops
  //     mid-word would otherwise emphasise half of it.
  if (selected.includes('\n')) {
    const start = value.lastIndexOf('\n', a - 1) + 1;
    let end = value.indexOf('\n', b);
    if (end === -1) end = value.length;

    const lines = value.slice(start, end).split('\n');
    const filled = lines.filter((line) => line.trim());
    const allWrapped = filled.length > 0 &&
      filled.every((line) => isWrapped(line.trim(), prefix, suffix));

    const next = lines.map((line) => {
      const body = line.trim();
      if (!body) return line;
      const indent = line.slice(0, line.indexOf(body));
      return indent + (allWrapped
        ? body.slice(prefix.length, body.length - suffix.length)
        : `${prefix}${body}${suffix}`);
    }).join('\n');

    replaceRange(start, end, next, start, start + next.length);
    return;
  }

  // --- the selection itself carries the markers
  if (isWrapped(selected, prefix, suffix)) {
    const inner = selected.slice(prefix.length, selected.length - suffix.length);
    replaceRange(a, b, inner, a, a + inner.length);
    return;
  }

  // --- the markers sit just outside the selection
  if (value.slice(a - prefix.length, a) === prefix &&
      value.slice(b, b + suffix.length) === suffix) {
    const start = a - prefix.length;
    replaceRange(start, b + suffix.length, selected, start, start + selected.length);
    return;
  }

  replaceRange(a, b, `${prefix}${selected}${suffix}`,
    a, a + prefix.length + selected.length + suffix.length);
}

/* Not a toggle: the closing half carries the url, so there is nothing
 * symmetrical to detect and removing it would silently drop the target. */
function insertLink() {
  const el = editor();
  const { selectionStart: a, selectionEnd: b } = el;
  const label = el.value.slice(a, b) || 'text';
  const text = `[${label}](https://)`;
  // leave the url selected, since that is what still needs typing
  const urlAt = a + label.length + 3;
  replaceRange(a, b, text, urlAt, urlAt + 8);
}

/* Split one line into cells. Commas, tabs and semicolons all count as
 * separators, and quotes protect a comma that belongs to the value. */
function splitCells(line) {
  const cells = [];
  let cell = '';
  let quoted = false;

  for (const char of line) {
    if (char === '"') { quoted = !quoted; continue; }
    if (!quoted && (char === ',' || char === '\t' || char === ';')) {
      cells.push(cell.trim());
      cell = '';
      continue;
    }
    cell += char;
  }
  cells.push(cell.trim());
  return cells;
}

/* Turn a pasted comma or tab separated list into a markdown table, so the
 * usual way this data arrives does not have to be retyped by hand. */
function listToTable(text) {
  const rows = text.split('\n').map((l) => l.trim()).filter(Boolean).map(splitCells);
  if (!rows.length) return null;

  const width = Math.max(...rows.map((r) => r.length));
  // a single cell is just a word; there is no table to build from it
  if (width < 2 && rows.length < 2) return null;

  const padded = rows.map((row) => {
    const cells = row.slice();
    while (cells.length < width) cells.push('');
    return cells;
  });

  // one line of values reads as headings, so leave an empty row to type into
  const header = padded[0];
  const body = padded.length > 1 ? padded.slice(1) : [new Array(width).fill(' ')];

  return formatTable([header, null, ...body]);
}

/* Markdown tables are only as readable as their columns are straight, so a
 * table is written back out padded to its widest cell. In a monospace editor
 * that is what turns pipes and dashes into something you can actually read as
 * a grid: the source stays plain markdown, and it lines up. A null row is the
 * header separator, whose dashes are drawn to the same measured width. */
function formatTable(rows, align = []) {
  const widths = [];
  rows.filter(Boolean).forEach((row) => {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] || 0, String(cell).trim().length, 3);
    });
  });

  // ":---", "---:" and ":---:" are how markdown itself carries alignment, so
  // another reader of this file gets it too
  const marker = (width, index) => {
    const dashes = '-'.repeat(Math.max(1, width - (align[index] === 'center' ? 2 : 1)));
    if (align[index] === 'center') return `:${dashes}:`;
    if (align[index] === 'right') return `${dashes}:`;
    return '-'.repeat(width);
  };

  return rows.map((row) => {
    if (!row) return `| ${widths.map(marker).join(' | ')} |`;
    return `| ${widths.map((w, i) => String(row[i] ?? '').trim().padEnd(w)).join(' | ')} |`;
  }).join('\n');
}

const isTableLine = (line) => /^\s*\|/.test(line) && line.trim().endsWith('|');
const isSeparatorRow = (line) => /^\s*\|[\s:|-]+\|\s*$/.test(line) && line.includes('-');
const tableCells = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

/* Re-align every table in the document. Cheap enough to run on each edit, and
 * it keeps a table straight while it is being typed into rather than only at
 * the moment it is inserted. */
function realignTables(text) {
  const lines = text.split('\n');
  const out = [];
  let block = [];

  const flush = () => {
    if (!block.length) return;
    if (block.length > 1) {
      const rows = block.map((line) => (isSeparatorRow(line) ? null : tableCells(line)));
      out.push(...formatTable(rows).split('\n'));
    } else {
      out.push(...block);
    }
    block = [];
  };

  lines.forEach((line) => {
    if (isTableLine(line)) { block.push(line); return; }
    flush();
    out.push(line);
  });
  flush();
  return out.join('\n');
}

/* Applied on a pause rather than on every keystroke, since re-padding under
 * the caret while someone is mid-word would fight their typing. */
function alignTablesInEditor() {
  const el = $('editor');
  const next = realignTables(el.value);
  if (next === el.value) return;

  // keep the caret on the same cell by counting pipes rather than characters,
  // which move as the padding changes
  const before = el.value.slice(0, el.selectionStart);
  const pipes = (before.match(/\|/g) || []).length;
  const lineIndex = before.split('\n').length - 1;

  el.value = next;
  const lines = next.split('\n');
  if (lineIndex < lines.length) {
    let offset = lines.slice(0, lineIndex).reduce((n, l) => n + l.length + 1, 0);
    const line = lines[lineIndex];
    let seen = (next.slice(0, offset).match(/\|/g) || []).length;
    let at = 0;
    while (at < line.length && seen < pipes) {
      if (line[at] === '|') seen += 1;
      at += 1;
    }
    el.setSelectionRange(offset + at, offset + at);
  }
  schedulePreview();
}

function insertTable() {
  const el = editor();
  const { selectionStart: a, selectionEnd: b } = el;
  const selected = el.value.slice(a, b).trim();

  if (selected) {
    const table = listToTable(selected);
    if (table) {
      replaceRange(a, b, table, a, a + table.length);
      return;
    }
  }
  insertBlock(formatTable([['Item', 'Qty'], null, ['tea', '2'], ['jam', '1']]));
}

const BLOCK_MARKER = /^(#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/;

function prefixLines(marker, numbered = false) {
  const el = editor();
  const value = el.value;
  const startLine = value.lastIndexOf('\n', el.selectionStart - 1) + 1;
  let endLine = value.indexOf('\n', el.selectionEnd);
  if (endLine === -1) endLine = value.length;

  const lines = value.slice(startLine, endLine).split('\n');
  // reapplying the same marker removes it, so one button toggles a list
  const allMarked = lines.every((line, i) => line.startsWith(numbered ? `${i + 1}. ` : marker));

  const next = lines.map((line, i) => {
    const applied = numbered ? `${i + 1}. ` : marker;
    if (allMarked) return line.slice(applied.length);
    return applied + line.replace(BLOCK_MARKER, '');
  }).join('\n');

  replaceRange(startLine, endLine, next, startLine, startLine + next.length);
}

function insertBlock(text) {
  const el = editor();
  const value = el.value;
  const lineStart = value.lastIndexOf('\n', el.selectionStart - 1) + 1;
  let lineEnd = value.indexOf('\n', el.selectionStart);
  if (lineEnd === -1) lineEnd = value.length;
  const current = value.slice(lineStart, lineEnd);

  // only open a new line when the current one already has something on it
  const at = current.trim() ? lineEnd : lineStart;
  const payload = current.trim() ? `\n${text}` : text;
  replaceRange(at, at, payload, at + payload.length);
}

const MD_ACTIONS = {
  h1: () => prefixLines('# '),
  h2: () => prefixLines('## '),
  h3: () => prefixLines('### '),
  bold: () => toggleWrap('**', '**', 'bold'),
  italic: () => toggleWrap('*', '*', 'italic'),
  strike: () => toggleWrap('~~', '~~', 'strike'),
  code: () => toggleWrap('`', '`', 'code'),
  ul: () => prefixLines('- '),
  ol: () => prefixLines('1. ', true),
  quote: () => prefixLines('> '),
  link: () => insertLink(),
  table: () => insertTable(),
  codeblock: () => insertBlock('```\ncode\n```'),
  rule: () => insertBlock('---'),
  math: () => toggleWrap('$', '$', 'x^2'),
};

/* The toolbar drives whichever surface is in front: rich commands on the
 * rendered document, text manipulation on the markdown source. The preset
 * editor always has a plain textarea, so it always takes the text path. */
function initToolbar() {
  document.querySelectorAll('.tool[data-md]').forEach((button) => {
    button.addEventListener('click', () => {
      const action = button.dataset.md;
      if (isRendered()) {
        RICH_ACTIONS[action]?.();
        schedulePreview();
        syncToolbarState();
        return;
      }
      MD_ACTIONS[action]?.();
    });
  });
}

/* ---------------------------------------------------------------- preview */
/* Three panes want previews (compose, to-dos, the preset editor) and they all
 * render the same way, so one function serves all of them. Each keeps its own
 * object URL so revoking one cannot blank another. */
const previewUrls = {};

/* Each theme carries its own printing voice, not just its own chrome: the font
 * is what the paper actually looks like, so a theme that leaves it alone is
 * only ever skin-deep. The pairing lives in the theme manifest next to the
 * stylesheet, which is what makes a user theme able to bring its own. */
const themePrint = (id) => (themeById(id) || {}).print || {};

const FONT_KEY = 'tp.font';
const SIZE_KEY = 'tp.size';
const FONT_PINNED = 'tp.fontPinned';

function currentFont() {
  return $('fontFamily').value || localStorage.getItem(FONT_KEY) || 'DejaVuSansMono';
}

/* A theme sets the page as well as the screen: its manifest carries the print
 * font and a small set of typographic choices (heading treatment, rules,
 * bullet, spacing) that the server's renderer honours. Font and size can be
 * overridden per preset or by hand; the setting stays with the theme. */
function themeStyle() {
  const print = themePrint(document.documentElement.dataset.theme);
  // the theme sets the page, the user sets how pictures are screened onto it
  return {
    style: {
      ...(print.style || {}),
      image_dither: currentDither(),
      image_threshold: currentThreshold(),
      image_strength: currentStrength() / 100,
    },
    line_spacing: print.line_spacing,
  };
}

const ORIENTATION_KEY = 'tp.orientation';
const LENGTH_KEY = 'tp.pageLength';

function renderOptions() {
  return {
    font: currentFont(),
    size: Number($('fontSize').value) || 16,
    darkness: Number($('darkness').value) || 1,
    orientation: currentDirection(),
    page_length: Number(localStorage.getItem(LENGTH_KEY)) || 1200,
    ...themeStyle(),
  };
}

/* 203 dots to the inch. Dots are what the printer counts and millimetres are
 * what a roll of paper is sold in, so the settings keep dots and everything
 * the user touches is in millimetres. */
const DOTS_PER_MM = 203 / 25.4;
const toMm = (dots) => Math.round(dots / DOTS_PER_MM);
const toDots = (mm) => Math.round(mm * DOTS_PER_MM);

const currentDirection = () => localStorage.getItem(ORIENTATION_KEY) || 'portrait';
const isAlong = () => currentDirection() === 'landscape';

/* Direction can be set from the preview head or from Settings, and both have
 * to agree, so it is set in one place and everything else follows it. */
function setDirection(value) {
  localStorage.setItem(ORIENTATION_KEY, value);
  if ($('orientation')) $('orientation').value = value;
  document.querySelectorAll('.segmented .seg[data-direction]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.direction === value));
  });
  // A strip composed along the roll is wider than it is deep, so beside the
  // editor is the wrong place for it: the compose view stacks, the preview
  // takes the full width underneath, and it is turned upright by default,
  // which is the only orientation the strip can be read in.
  const along = value === 'landscape';
  $('view-compose')?.classList.toggle('stacked', along);
  if ($('alongTools')) $('alongTools').hidden = !along;
  setTurned(along);
  refreshPreview();
}

function setLength(dots) {
  const bounded = Math.max(384, Math.min(4000, Math.round(dots)));
  localStorage.setItem(LENGTH_KEY, String(bounded));
  if ($('pageLength')) $('pageLength').value = bounded;
  if ($('alongLength')) $('alongLength').value = toMm(bounded);
  refreshPreview();
}

/* Turning the preview is a way of looking at it, not a property of the page,
 * so it is never stored and never reaches the printer. Both panes that can
 * compose along the roll use these, told which preview they mean. */
function setTurned(on, image = 'preview', control = 'turnToRead') {
  const wrap = $(image)?.closest('.paper-wrap');
  const button = $(control);
  if (!wrap) return;
  wrap.classList.toggle('turned', on);
  if (button) button.setAttribute('aria-pressed', String(on));
  sizeTurnedWrap(image);
}

function sizeTurnedWrap(image = 'preview') {
  const img = $(image);
  const wrap = img?.closest('.paper-wrap');
  if (!wrap || !img || !img.naturalWidth) return;

  if (!wrap.classList.contains('turned')) {
    wrap.style.width = '';
    wrap.style.height = '';
    wrap.style.removeProperty('--turn-gap');
    img.style.width = '';
    img.style.transform = '';
    img.style.top = '';
    // the ruler measured the strip while it was turned, and now measures the
    // paper again
    refreshRulers();
    return;
  }

  // A turned page is as wide as the page is long, which is more than the panel
  // has, so it is scaled to fit: this view is for reading the whole strip at
  // once, not for judging the type size. Measure the page before it is turned,
  // since a bounding box reports the transformed shape and would feed back
  // into itself. Rotated about its top left corner it also has to be pushed
  // back down into view.
  const stage = wrap.closest('.paper-stage');
  const available = (stage?.clientWidth || wrap.clientWidth) - 20;
  const width = 384;
  const height = width * (img.naturalHeight / img.naturalWidth);
  // never shrink past a third, or a long strip turns into a grey smear that
  // cannot be read at all; past that point the stage scrolls instead
  const scale = Math.max(0.34, Math.min(1, available / height));

  // The margin is on the paper whichever way the page is read. Turned, it is
  // the band above and below rather than the strip either side, so the sheet
  // grows by it and the page sits that far down inside it.
  const framed = document.body.classList.contains('frame-print');
  const gap = framed
    ? Math.round(parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue('--paper-gap')
    ) || 0) * scale
    : 0;

  img.style.width = `${width}px`;
  img.style.transform = `rotate(-90deg) scale(${scale})`;
  img.style.top = `${width * scale + gap}px`;
  wrap.style.width = `${height * scale}px`;
  wrap.style.height = `${width * scale + gap * 2}px`;
  wrap.style.setProperty('--turn-gap', `${gap}px`);
  refreshRulers();
}

function initOrientation() {
  const direction = $('orientation');
  const length = $('pageLength');

  document.querySelectorAll('.segmented .seg[data-direction]').forEach((button) => {
    button.addEventListener('click', () => setDirection(button.dataset.direction));
  });
  $('alongLength')?.addEventListener('change', () =>
    setLength(toDots(Number($('alongLength').value) || 150)));
  $('turnToRead')?.addEventListener('click', () =>
    setTurned($('turnToRead').getAttribute('aria-pressed') !== 'true'));

  direction?.addEventListener('change', () => setDirection(direction.value));
  length?.addEventListener('change', () => setLength(Number(length.value) || 1200));

  setDirection(currentDirection());
  setLength(Number(localStorage.getItem(LENGTH_KEY) || 1200));
}

/* presets store their own font and size but not the setting, which follows
 * whichever theme is in use when they print */
const withThemeStyle = (options) => ({ ...(options || {}), ...themeStyle() });

/* keep the Settings pane and the compose toolbar showing the same thing */
function setPrintFont(font, size, { pin = false } = {}) {
  [['fontFamily', font], ['fontQuick', font],
   ['fontSize', size], ['sizeQuick', size]].forEach(([id, value]) => {
    if ($(id) && value !== undefined && value !== null) $(id).value = value;
  });
  if (font) localStorage.setItem(FONT_KEY, font);
  if (size) localStorage.setItem(SIZE_KEY, size);
  if (pin) localStorage.setItem(FONT_PINNED, '1');
  refreshPreview();
}

/* Applied on theme change unless the font was chosen by hand, since silently
 * overriding a deliberate choice is worse than a theme looking less distinct. */
function applyThemePrintDefaults(theme) {
  if (localStorage.getItem(FONT_PINNED) === '1') return;
  const preset = themePrint(theme);
  if (!preset || !fontList.length) return;
  const font = fontList.includes(preset.font) ? preset.font : currentFont();
  setPrintFont(font, preset.size);
}

let fontList = [];

async function loadFonts() {
  const data = await api('/api/fonts');
  fontList = data.fonts || [];

  ['fontFamily', 'fontQuick', 'presetFont', 'todoFont'].forEach((id) => {
    const select = $(id);
    if (!select) return;
    select.innerHTML = '';
    fontList.forEach((name) => select.append(new Option(name, name)));
  });

  const theme = document.documentElement.dataset.theme;
  const pinned = localStorage.getItem(FONT_PINNED) === '1';
  const saved = localStorage.getItem(FONT_KEY);
  const savedSize = Number(localStorage.getItem(SIZE_KEY)) || undefined;

  if (pinned && saved && fontList.includes(saved)) {
    setPrintFont(saved, savedSize || 24);
  } else {
    const preset = themePrint(theme);
    const font = fontList.includes(preset.font) ? preset.font
      : (fontList.includes('DejaVuSansMono') ? 'DejaVuSansMono' : fontList[0]);
    setPrintFont(font, preset.size || 24);
  }
}

function initFontControls() {
  const pinAndRender = (font, size) => setPrintFont(font, size, { pin: true });

  $('fontFamily').addEventListener('change', () =>
    pinAndRender($('fontFamily').value, undefined));
  $('fontQuick').addEventListener('change', () =>
    pinAndRender($('fontQuick').value, undefined));
  $('fontSize').addEventListener('change', () =>
    pinAndRender(undefined, Number($('fontSize').value)));
  $('sizeQuick').addEventListener('change', () =>
    pinAndRender(undefined, Number($('sizeQuick').value)));
}

async function renderInto(key, text, img, meta, options) {
  try {
    const response = await fetch('/api/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, options: options ? withThemeStyle(options) : renderOptions() }),
    });
    if (!response.ok) throw new Error('render failed');
    const trimmed = response.headers.get('X-Trimmed') === '1';
    const blob = await response.blob();
    // revoke the previous URL or every keystroke leaks a bitmap
    if (previewUrls[key]) URL.revokeObjectURL(previewUrls[key]);
    previewUrls[key] = URL.createObjectURL(blob);
    img.src = previewUrls[key];
    img.onload = () => {
      // paper is bought by the metre, so the length is said in millimetres
      // and the dots are kept beside it for anyone setting a strip by hand
      meta.textContent =
        `${img.naturalWidth} x ${img.naturalHeight} - ${toMm(img.naturalHeight)} mm`;
      if (key === 'compose') {
        if ($('trimWarning')) $('trimWarning').hidden = !trimmed;
        sizeTurnedWrap();
      }
      if (key === 'todos') {
        if ($('todoTrimWarning')) $('todoTrimWarning').hidden = !trimmed;
        sizeTurnedWrap('todoPreview');
      }
    };
  } catch (error) {
    meta.textContent = 'preview failed';
  }
}

/* debounce per pane so typing in one does not cancel another's refresh */
const timers = {};
function debounce(key, fn, wait = 260) {
  clearTimeout(timers[key]);
  timers[key] = setTimeout(fn, wait);
}

const refreshPreview = () => renderInto('compose', editorMarkdown(), $('preview'), $('previewMeta'));
const schedulePreview = () => debounce('compose', refreshPreview);

/* Direction is a property of the document being composed rather than of the
 * printer, so each pane that writes its own document keeps its own. A list is
 * usually set across the roll, but two items printed large down the length of
 * the paper is a different and useful thing, so the choice is offered where
 * the list is, and remembered separately from Compose. */
const TODO_ORIENTATION_KEY = 'tp.todoOrientation';
const TODO_LENGTH_KEY = 'tp.todoLength';
const TODO_SIZE_KEY = 'tp.todoSize';
const TODO_FONT_KEY = 'tp.todoFont';

const todoDirection = () => localStorage.getItem(TODO_ORIENTATION_KEY) || 'portrait';
const todoIsAlong = () => todoDirection() === 'landscape';

/* The list has its own face and size as well as its own direction. Two items
 * printed large down the roll want 60 point type; the same list across the
 * roll wants 24. Neither is what Compose is set to, and having to change
 * Compose to print a list would be a strange way round. Empty means follow
 * Compose, which is what most lists want. */
function todoOptions() {
  const options = { ...renderOptions(), orientation: todoDirection() };
  const font = localStorage.getItem(TODO_FONT_KEY);
  const size = Number(localStorage.getItem(TODO_SIZE_KEY));
  if (font) options.font = font;
  if (size) options.size = size;
  if (todoIsAlong()) {
    options.page_length = Number(localStorage.getItem(TODO_LENGTH_KEY)) || 1200;
  }
  return options;
}

function setTodoDirection(value) {
  localStorage.setItem(TODO_ORIENTATION_KEY, value);
  document.querySelectorAll('[data-todo-direction]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.todoDirection === value));
  });
  const along = value === 'landscape';
  $('view-todos')?.classList.toggle('stacked', along);
  if ($('todoAlongTools')) $('todoAlongTools').hidden = !along;
  setTurned(along, 'todoPreview', 'todoTurnToRead');
  refreshTodoPreview();
}

function setTodoLength(dots) {
  const bounded = Math.max(384, Math.min(4000, Math.round(dots)));
  localStorage.setItem(TODO_LENGTH_KEY, String(bounded));
  if ($('todoLength')) $('todoLength').value = toMm(bounded);
  refreshTodoPreview();
}

function initTodoDirection() {
  document.querySelectorAll('[data-todo-direction]').forEach((button) => {
    button.addEventListener('click', () => setTodoDirection(button.dataset.todoDirection));
  });
  $('todoLength')?.addEventListener('change', () =>
    setTodoLength(toDots(Number($('todoLength').value) || 150)));
  $('todoSize')?.addEventListener('change', () => {
    const size = Math.max(8, Math.min(120, Number($('todoSize').value) || 24));
    localStorage.setItem(TODO_SIZE_KEY, String(size));
    $('todoSize').value = size;
    refreshTodoPreview();
  });
  $('todoFont')?.addEventListener('change', () => {
    localStorage.setItem(TODO_FONT_KEY, $('todoFont').value);
    refreshTodoPreview();
  });
  $('todoTypeReset')?.addEventListener('click', () => {
    localStorage.removeItem(TODO_FONT_KEY);
    localStorage.removeItem(TODO_SIZE_KEY);
    showTodoType();
    refreshTodoPreview();
  });
  $('todoTurnToRead')?.addEventListener('click', () =>
    setTurned($('todoTurnToRead').getAttribute('aria-pressed') !== 'true',
              'todoPreview', 'todoTurnToRead'));

  showTodoType();
  setTodoLength(Number(localStorage.getItem(TODO_LENGTH_KEY)) || 1200);
  setTodoDirection(todoDirection());
}

/* what the fields say when nothing of the list's own is set: whatever Compose
 * is using, since that is what will be printed */
function showTodoType() {
  const font = $('todoFont');
  const size = $('todoSize');
  if (font) font.value = localStorage.getItem(TODO_FONT_KEY) || currentFont();
  if (size) {
    size.value = Number(localStorage.getItem(TODO_SIZE_KEY))
      || Number($('fontSize')?.value) || 24;
  }
}

const refreshTodoPreview = () =>
  renderInto('todos', todosAsMarkdown(), $('todoPreview'), $('todoPreviewMeta'),
             todoOptions());
const scheduleTodoPreview = () => debounce('todos', refreshTodoPreview);

/* -------------------------------------------------------------- connection */
async function refreshState() {
  const data = await api('/api/state');
  state.printer = data;

  const select = $('profileSelect');
  select.innerHTML = '';
  if (!data.profiles.length) {
    select.append(new Option('No saved devices', ''));
  }
  data.profiles.forEach((profile) => {
    const option = new Option(`${profile.name} (${profile.transport})`, profile.name);
    option.selected = profile.name === data.activeProfile;
    select.append(option);
  });

  describePaper(data);

  $('connState').classList.toggle('on', data.connected);
  $('connText').textContent = data.connected ? 'Connected' : 'Disconnected';
  $('connectBtn').textContent = data.connected ? 'Disconnect' : 'Connect';
  if ($('statusBtn')) $('statusBtn').hidden = !data.connected;
  if (!data.connected && $('printerStatus')) $('printerStatus').textContent = '';
  $('statusProfile').textContent = data.activeProfile || 'no device';
  $('statusWidth').textContent = `${data.width} px - ${data.dpi} dpi - tear ${data.tearGapMm} mm`;
  $('tearGap').value = data.tearGapMm;

  if ($('newCapability') && !$('newCapability').options.length) loadPrinterTypes();

  renderDevices(data.profiles);
}

/* Most of these printers will say whether they have paper, whether the cover is
 * shut and whether the head is too hot, and many of them will say nothing at
 * all: a one-way Bluetooth link is common. Silence is reported as silence
 * rather than dressed up as good news, and the query is on a button because it
 * takes the same lock a print does. */
async function checkPrinterStatus() {
  const out = $('printerStatus');
  if (!out) return;
  out.textContent = 'Asking...';
  try {
    const status = await api('/api/status');
    if (!status.connected) out.textContent = '';
    else if (!status.answered) out.textContent = 'No answer (normal over Bluetooth)';
    else if (status.ok) out.textContent = 'Ready';
    else out.textContent = (status.messages || []).join('. ') || 'Not ready';
    out.classList.toggle('bad', status.answered && status.ok === false);
  } catch (error) {
    out.textContent = 'Could not ask it';
  }
}

/* ------------------------------------------------------------- the paper */
/* The head is narrower than the roll: 58 mm of paper takes 48 mm of print, and
 * the rest is margin whether you wanted one or not. The preview is drawn at
 * the width of the paper with the printable part marked inside it, so the
 * margin is something you can see rather than something you find out about
 * after the roll has gone through. */
const PRINT_FRAME_KEY = 'tp.printFrame';

function describePaper(state) {
  const root = document.documentElement;
  const dots = Number(state.width) || 384;
  const perMm = Number(state.dotsPerMm) || (Number(state.dpi) || 203) / 25.4;
  const paperMm = Number(state.paperWidthMm) || 0;
  // one preview pixel is one dot, so the margin is in dots too
  const gap = paperMm ? Math.max(6, Math.round((paperMm * perMm - dots) / 2)) : 12;

  root.style.setProperty('--paper-gap', `${gap}px`);
  const frame = recall(PRINT_FRAME_KEY) !== 'off';
  const showing = frame && !!paperMm;
  document.body.classList.toggle('frame-print', showing);
  if ($('printFrame')) $('printFrame').checked = frame;
  if ($('paperNote')) {
    $('paperNote').textContent = paperMm
      ? `${paperMm} mm of paper, ${state.printWidthMm} mm of it printable `
        + `(${dots} dots at ${state.dpi} dpi)`
      : `${dots} dots at ${state.dpi} dpi`;
  }

  // named underneath, since a marquee says where but not how much
  ['composeLegend', 'todoLegend'].forEach((id) => {
    const legend = $(id);
    if (!legend) return;
    legend.hidden = !showing;
    if (!showing) return;
    $(`${id}Print`).textContent = `${state.printWidthMm} mm`;
    $(`${id}Paper`).textContent = `${paperMm} mm`;
  });

  root.style.setProperty('--mm', `${perMm}px`);
  paperFacts = { paperMm, perMm, showing };
  refreshRulers();
}

/* What the paper is, kept so the rulers can be redrawn without asking the
 * server again: they have to be, because a turned page measures something
 * different from an upright one and the panel can be any width. */
let paperFacts = { paperMm: 0, perMm: 8, showing: false };

function refreshRulers() {
  [['composeRuler', 'composeRulerSide', 'preview'],
   ['todoRuler', 'todoRulerSide', 'todoPreview']].forEach(
    ([acrossId, downId, imageId]) => {
      const image = $(imageId);
      if (!image) return;
      const turned = image.closest('.paper-wrap')?.classList.contains('turned');
      // The ruler measures the dimension that ends. Upright that is across the
      // paper; turned it is the height of the card, because the strip running
      // across the screen is as long as you care to make it and the width is
      // the only thing the printer fixes.
      const span = paperFacts.showing ? paperFacts.paperMm : 0;
      drawRuler($(acrossId), turned ? 0 : span);
      drawRuler($(downId), turned ? span : 0, 'down');
    });
}

/* Ticks every millimetre and a number every ten, across the width of the roll.
 * The paper is sold in millimetres and the head is quoted in dots, so the one
 * that can be held against the other belongs on screen. */
function drawRuler(ruler, spanMm, axis = 'across') {
  if (!ruler) return;
  // Measured from the sheet beside it rather than left to the layout, which
  // has no idea how wide a ruler with no content ought to be. A hidden panel
  // measures zero, and a ruler drawn against zero is worse than none, so it
  // waits until there is something to measure.
  const sheet = axis === 'down'
    ? ruler.closest('.paper-wrap')
    : ruler.parentElement?.querySelector('.paper-wrap');
  const box = sheet ? sheet.getBoundingClientRect() : null;
  const width = box ? box.width : 0;
  ruler.hidden = !spanMm || !box || !box.width || !box.height;
  if (ruler.hidden) return;

  if (axis === 'down') ruler.style.width = '';
  else ruler.style.width = `${width}px`;
  // the sheet is scaled to fit the panel, so a millimetre on screen is not a
  // millimetre of dots: the ticks follow what is actually drawn
  const along = axis === 'down' ? sheet.getBoundingClientRect().height : width;
  ruler.style.setProperty('--mm', `${along / spanMm}px`);
  ruler.querySelectorAll('b').forEach((label) => label.remove());
  const step = spanMm > 220 ? 50 : spanMm > 90 ? 20 : 10;
  for (let mm = step; mm < spanMm - step / 4; mm += step) {
    const label = document.createElement('b');
    label.textContent = mm;
    label.style[axis === 'down' ? 'top' : 'left'] = `${(mm / spanMm) * 100}%`;
    ruler.append(label);
  }
}

/* -------------------------------------------------------- printer types */
/* A capability profile says what the printer can do: how wide the head is,
 * what it does in firmware, what has to be drawn instead. The shipped ones
 * cover the printers somebody has written down; anything else can be described
 * here, in the same escpos-printer-db schema, and is then a type like any
 * other. */
let printerTypes = [];

async function loadPrinterTypes(select) {
  try {
    const data = await api('/api/printer-types');
    printerTypes = data.types || [];
    // the opcode and cut dialects are the server's to name, so the editor asks
    // for them rather than keeping its own copy of the table
    fillOptions('typeDriver', data.driverOptions);
    fillOptions('typeGraphics', data.graphicsOptions);
    fillOptions('typeCutFull', data.cutOptions);
    fillOptions('typeCutPartial', data.cutOptions);
  } catch (error) {
    printerTypes = [];
    return;
  }
  const menu = $('newCapability');
  if (!menu) return;
  const wanted = select || menu.value;
  menu.innerHTML = '';
  printerTypes.forEach((type) => {
    const option = new Option(
      type.custom ? `${type.name} (yours)` : type.name, type.key);
    menu.append(option);
  });
  if (wanted && printerTypes.some((type) => type.key === wanted)) menu.value = wanted;
  markCustomType();
}

const currentPrinterType = () =>
  printerTypes.find((type) => type.key === $('newCapability')?.value) || null;

/* the delete button belongs to a type you wrote, so it comes and goes with the
 * selection rather than sitting there greyed out */
function markCustomType() {
  const type = currentPrinterType();
  const remove = $('typeDeleteBtn');
  if (remove) remove.hidden = !type?.custom;
}

function fillTypeEditor(type) {
  $('typeName').value = type ? `${type.name}${type.custom ? '' : ' (copy)'}` : '';
  $('typeVendor').value = type?.vendor || '';
  $('typeWidth').value = type?.widthDots || 384;
  $('typePaper').value = type?.widthMm || 58;
  // a dpi the list does not offer is still a dpi, so it is added rather than
  // silently rounded to one of the two common ones
  const dpi = String(type?.dpi || 203);
  if (!Array.from($('typeDpi').options).some((option) => option.value === dpi)) {
    $('typeDpi').append(new Option(`${dpi} dpi`, dpi));
  }
  $('typeDpi').value = dpi;
  describeTypeWidth();
  const features = type?.features || { bitImageRaster: true };
  $('typeRaster').checked = features.bitImageRaster !== false;
  $('typeQr').checked = !!features.qrCode;
  $('typeBarcode').checked = !!features.barcodeA;
  $('typeFullCut').checked = !!features.paperFullCut;
  $('typePartCut').checked = !!features.paperPartCut;

  const flow = type?.flow || {};
  $('typeDriver').value = type?.driver || 'escpos';
  $('typeGraphics').value = type?.graphics || 'gsv0';
  $('typeChunk').value = flow.chunk_bytes ?? 1024;
  $('typePause').value = flow.chunk_pause_ms ?? 10;
  $('typeBand').value = flow.band_rows ?? 64;
  $('typeDrain').value = flow.drain_seconds ?? 0;

  const cut = type?.cut || {};
  $('typeCutFull').value = cut.full || 'gsv0';
  $('typeCutPartial').value = cut.partial || 'gsv1';
  $('typeCutFeed').value = cut.feed_dots ?? 0;

  const density = type?.density || {};
  $('typeDensity').checked = !!density.supported;
  setSlider('typeDensityLevel', density.level ?? 0);

  const commands = type?.commands || {};
  $('typeInit').value = commands.start_print || '';
  $('typeFinish').value = commands.end_print || '';
}

/* Options a dropdown is given by the server: nothing about which opcodes exist
 * belongs in the page. */
function fillOptions(id, options) {
  const element = $(id);
  if (!element || !Array.isArray(options)) return;
  element.innerHTML = '';
  options.forEach(({ id: value, label }) => element.append(new Option(label, value)));
}

/* What the numbers in the editor come to in millimetres, said back as they are
 * typed: dots are what the protocol counts and millimetres are what the paper
 * is sold in, and getting the head width wrong is the one mistake that ruins
 * every page. */
function describeTypeWidth() {
  const hint = $('typeWidthHint');
  if (!hint) return;
  const dpi = Number($('typeDpi').value) || 203;
  const dots = Number($('typeWidth').value) || 0;
  const paper = Number($('typePaper').value) || 0;
  const perMm = dpi / 25.4;
  const printed = dots / perMm;
  const margin = paper - printed;
  hint.textContent = dots
    ? `${dots} dots at ${dpi} dpi is ${printed.toFixed(1)} mm of print`
      + (paper ? `, leaving ${margin.toFixed(1)} mm of paper unprinted.` : '.')
    : 'How much of the paper the head can print, in dots.';
  if (paper && margin < -0.5) {
    hint.textContent += ' That is wider than the paper you have said it uses.';
  }
}

function initPrinterTypes() {
  const editor = $('typeEditor');
  if (!editor) return;

  ['typeWidth', 'typeDpi', 'typePaper'].forEach((id) =>
    $(id)?.addEventListener('input', describeTypeWidth));

  // the calculator RawBt has, which is only a multiplication but is the one
  // people get wrong: dots are millimetres times eight, or twelve at 300 dpi
  $('typeCalc')?.addEventListener('click', () => {
    const perMm = (Number($('typeDpi').value) || 203) / 25.4;
    const suggested = Math.round((Number($('typePaper').value) || 58) - 10);
    const answer = prompt(
      `How many millimetres does the head print?\n\n`
      + `At ${$('typeDpi').value} dpi that is ${perMm.toFixed(1)} dots to the millimetre. `
      + `A 58 mm roll usually prints 48.`, String(suggested));
    if (answer === null) return;
    const mm = Number(answer);
    if (!mm) return;
    const dots = Math.max(64, Math.min(2048, Math.floor(mm * perMm / 8) * 8));
    $('typeWidth').value = dots;
    describeTypeWidth();
  });

  $('typeDensityLevel')?.addEventListener('input', () =>
    setSlider('typeDensityLevel', Number($('typeDensityLevel').value)));

  $('newCapability').addEventListener('change', markCustomType);
  $('typeEditBtn').addEventListener('click', () => {
    // a listed type is a starting point rather than a thing to be overwritten:
    // editing one of yours edits it, editing a shipped one copies it
    fillTypeEditor(currentPrinterType());
    editor.hidden = false;
  });
  $('typeCancelBtn').addEventListener('click', () => { editor.hidden = true; });

  $('typeSaveBtn').addEventListener('click', async () => {
    const existing = currentPrinterType();
    const body = {
      name: $('typeName').value,
      vendor: $('typeVendor').value,
      widthDots: Number($('typeWidth').value),
      widthMm: Number($('typePaper').value),
      dpi: Number($('typeDpi').value),
      features: {
        bitImageRaster: $('typeRaster').checked,
        qrCode: $('typeQr').checked,
        barcodeA: $('typeBarcode').checked,
        paperFullCut: $('typeFullCut').checked,
        paperPartCut: $('typePartCut').checked,
      },
      driver: $('typeDriver').value,
      graphics: $('typeGraphics').value,
      flow: {
        chunk_bytes: Number($('typeChunk').value),
        chunk_pause_ms: Number($('typePause').value),
        band_rows: Number($('typeBand').value),
        drain_seconds: Number($('typeDrain').value),
      },
      cut: {
        full: $('typeCutFull').value,
        partial: $('typeCutPartial').value,
        feed_dots: Number($('typeCutFeed').value),
      },
      density: {
        supported: $('typeDensity').checked,
        level: Number($('typeDensityLevel').value),
      },
      commands: {
        start_print: $('typeInit').value,
        end_print: $('typeFinish').value,
      },
    };
    // editing one of your own keeps its key, so the devices already pointing
    // at it keep pointing at it
    if (existing?.custom && existing.name === $('typeName').value.trim()) {
      body.key = existing.key;
    }
    try {
      const saved = await api('/api/printer-types',
        { method: 'POST', body: JSON.stringify(body) });
      await loadPrinterTypes(saved.key);
      editor.hidden = true;
      toast('Printer type saved');
    } catch (error) {
      toast(`Could not save it: ${error.message}`, true);
    }
  });

  $('typeDeleteBtn').addEventListener('click', async () => {
    const type = currentPrinterType();
    if (!type?.custom) return;
    try {
      await api(`/api/printer-types/${encodeURIComponent(type.key)}`, { method: 'DELETE' });
      await loadPrinterTypes();
      editor.hidden = true;
    } catch (error) {
      toast(`Could not remove it: ${error.message}`, true);
    }
  });
}

function initConnection() {
  $('connectBtn').addEventListener('click', async () => {
    const button = $('connectBtn');
    button.disabled = true;
    try {
      if (state.printer.connected) {
        await api('/api/disconnect', { method: 'POST' });
        toast('Disconnected');
      } else {
        const name = $('profileSelect').value;
        if (!name) { toast('Add a device in Settings first', true); return; }
        await api('/api/connect', { method: 'POST', body: JSON.stringify({ profile: name }) });
        toast('Connected');
      }
      await refreshState();
    } catch (error) {
      toast(error.message, true);
    } finally {
      button.disabled = false;
    }
  });
}

/* ------------------------------------------------------------------ print */
async function printText(text, label = 'Printed', options) {
  if (!state.printer.connected) { toast('Not connected to a printer', true); return; }
  const button = $('printBtn');
  button.disabled = true;
  status('Printing...');
  try {
    const result = await api('/api/print', {
      method: 'POST',
      body: JSON.stringify({ text, options: options ? withThemeStyle(options) : renderOptions() }),
    });
    toast(label);
    status(result.message || 'Ready');
  } catch (error) {
    toast(error.message, true);
    status('Print failed');
  } finally {
    button.disabled = false;
  }
}

/* --------------------------------------------------------------- the wire */
/* A page that comes out wrong was either composed wrong or sent wrong, and
 * those have different fixes. This reads a byte stream back as paper: the
 * stream this app would send for what is in the editor, or one pasted in from
 * anywhere else. */
async function readWire(body) {
  const meta = $('wireMeta');
  const paper = $('wirePaper');
  const list = $('wireEvents');
  if (!meta) return;
  meta.textContent = 'Reading...';
  list.innerHTML = '';
  try {
    const result = await api('/api/emulate',
      { method: 'POST', body: JSON.stringify(body) });
    paper.src = result.png;
    paper.hidden = false;
    meta.textContent = `${result.bytes} bytes, ${result.height} dot rows`
      + `${result.cuts ? `, ${result.cuts} cuts` : ''}`;
    (result.events || []).forEach((event) => {
      const item = document.createElement('li');
      const detail = event.detail ? ` ${event.detail}` : '';
      item.textContent = `${event.at}: ${event.command}${detail} (${event.bytes} bytes)`;
      if (event.command === 'unknown') item.className = 'bad';
      list.append(item);
    });
    if (result.truncated) {
      const item = document.createElement('li');
      item.textContent = 'and more, not listed';
      list.append(item);
    }
  } catch (error) {
    meta.textContent = error.message;
    paper.hidden = true;
  }
}

function initWirePane() {
  $('wireJobBtn')?.addEventListener('click', () =>
    readWire({ text: editorMarkdown(), options: renderOptions() }));
  $('wirePasteBtn')?.addEventListener('click', () =>
    readWire({ hex: $('wireInput').value }));
}

/* ---------------------------------------------------------------- presets */
async function loadPresets() {
  const data = await api('/api/presets');
  state.presets = data.presets || [];
  renderPresets();
}

function renderPresets() {
  const list = $('presetList');
  list.innerHTML = '';
  $('presetCount').textContent = `${state.presets.length} saved`;

  if (!state.presets.length) {
    list.innerHTML = '<li class="empty">No presets yet. Use "New preset", or write something in Compose and hit "Save as preset".</li>';
    return;
  }

  state.presets
    .slice()
    .sort((a, b) => (b.updated || 0) - (a.updated || 0))
    .forEach((preset) => {
      const lines = (preset.text || '').split('\n').filter(Boolean).length;
      const bits = [`${lines} line${lines === 1 ? '' : 's'}`];
      if (preset.description) bits.unshift(preset.description);
      if (preset.options?.size) bits.push(`${preset.options.size}px`);

      const li = document.createElement('li');
      li.className = 'item';
      li.innerHTML = `
        <div>
          <div class="name"></div>
          <div class="sub"></div>
        </div>
        <span class="spacer"></span>
        ${icon('open', 'Open in Compose')}
        ${icon('edit', 'Edit this preset')}
        ${icon('print', 'Print it now')}`;
      li.querySelector('.name').textContent = preset.name;
      li.querySelector('.sub').textContent = bits.join(' · ');

      li.querySelector('[data-act="open"]').addEventListener('click', () => openPreset(preset));
      li.querySelector('[data-act="edit"]').addEventListener('click', () => openPresetEditor(preset));
      li.querySelector('[data-act="print"]').addEventListener('click', () =>
        printText(preset.text, `Printed "${preset.name}"`, preset.options));

      list.append(li);
    });

  renderQuickPresets();
}

/* The same presets, reachable without leaving Compose. */
function renderQuickPresets() {
  const list = $('quickPresets');
  if (!list) return;
  list.innerHTML = '';
  $('quickCount').textContent = `${state.presets.length} saved`;

  if (!state.presets.length) {
    list.innerHTML = '<li class="empty">Nothing saved yet</li>';
    return;
  }

  state.presets
    .slice()
    .sort((a, b) => (b.updated || 0) - (a.updated || 0))
    .slice(0, 8)
    .forEach((preset) => {
      const lines = (preset.text || '').split('\n').filter(Boolean).length;
      const li = document.createElement('li');
      li.className = 'item';
      li.innerHTML = '<div class="name"></div><span class="spacer"></span><span class="sub"></span>';
      li.querySelector('.name').textContent = preset.name;
      li.querySelector('.sub').textContent = lines;
      li.addEventListener('click', () => openPreset(preset));
      list.append(li);
    });
}

function openPreset(preset) {
  setEditorMarkdown(preset.text || '');
  state.activePresetId = preset.id;
  $('presetLabel').textContent = preset.name;
  // a preset carries the settings it was designed against
  if (preset.options?.font || preset.options?.size) {
    setPrintFont(preset.options.font, preset.options.size, { pin: true });
  }
  if (preset.options?.darkness) $('darkness').value = preset.options.darkness;
  // direction is part of the design, not of the machine: a banner opened into
  // Compose should arrive turned the way it was drawn
  if (preset.options?.orientation) {
    if (preset.options.page_length) setLength(preset.options.page_length);
    setDirection(preset.options.orientation);
  }
  showView('compose');
  refreshPreview();
  toast(`Opened "${preset.name}"`);
}


/* ------------------------------------------------------------------ symbols */
/* Nine hundred glyphs is a reference work, not a menu, so the search is the
 * interface: the table is fetched once and filtered in the browser, and the
 * groups are there for the times you would rather browse than name a thing. */
let symbolGroups = [];

async function loadSymbols() {
  if (symbolGroups.length) return;
  try {
    const data = await api('/api/symbols');
    symbolGroups = data.groups || [];
  } catch (error) {
    symbolGroups = [];
  }
}

function symbolMatches(query) {
  const needle = query.trim().toLowerCase();
  if (!needle) return symbolGroups;
  return symbolGroups
    .map((group) => ({
      name: group.name,
      symbols: group.symbols.filter((symbol) =>
        symbol.char === needle
        || symbol.name.toLowerCase().includes(needle)
        || symbol.use.toLowerCase().includes(needle)
        || group.name.toLowerCase().includes(needle)),
    }))
    .filter((group) => group.symbols.length);
}

function renderSymbols(query = '') {
  const results = $('symbolResults');
  const groups = symbolMatches(query);
  results.innerHTML = '';
  if (!groups.length) {
    results.innerHTML = '<p class="hint">Nothing by that name.</p>';
    return;
  }
  groups.forEach((group) => {
    const section = document.createElement('section');
    section.className = 'symbol-group';
    section.innerHTML = `<h3>${escapeHtml(group.name)}</h3><div class="symbol-grid"></div>`;
    const grid = section.querySelector('.symbol-grid');
    group.symbols.forEach((symbol) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'symbol';
      button.textContent = symbol.char;
      button.title = `${symbol.name} - ${symbol.use}`;
      button.addEventListener('click', () => insertSymbol(symbol.char));
      grid.append(button);
    });
    results.append(section);
  });
}

function insertSymbol(character) {
  if (isRendered() && tt) {
    tt.chain().focus().insertContent(character).run();
  } else {
    const area = editor();
    replaceRange(area.selectionStart, area.selectionEnd, character);
  }
  schedulePreview();
}

/* The overflow menu. Opened from its button, closed by choosing something,
 * clicking away, or Escape, and positioned under the button rather than in a
 * corner so the connection between the two is obvious. */
function initToolMenu() {
  const button = $('moreTools');
  const menu = $('toolMenu');
  if (!button || !menu) return;

  const close = () => {
    menu.hidden = true;
    button.setAttribute('aria-expanded', 'false');
  };

  button.addEventListener('mousedown', (event) => {
    event.preventDefault();
    if (!menu.hidden) { close(); return; }
    const frame = button.offsetParent?.getBoundingClientRect();
    const box = button.getBoundingClientRect();
    if (frame) {
      menu.style.left = `${Math.max(6, box.left - frame.left)}px`;
      menu.style.top = `${box.bottom - frame.top + 4}px`;
    }
    menu.hidden = false;
    button.setAttribute('aria-expanded', 'true');
  });

  menu.addEventListener('mousedown', () => setTimeout(close, 0));
  document.addEventListener('mousedown', (event) => {
    if (!menu.hidden && !menu.contains(event.target) && event.target !== button) close();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') close();
  });
}

function initSymbols() {
  const dialog = $('symbolPicker');
  const search = $('symbolSearch');
  if (!dialog) return;

  $('symbolsBtn')?.addEventListener('click', async () => {
    await loadSymbols();
    renderSymbols(search.value);
    dialog.showModal();
    search.focus();
    search.select();
  });
  search.addEventListener('input', () => debounce('symbols', () => renderSymbols(search.value), 120));
  $('symbolClose').addEventListener('click', () => dialog.close());
}

/* ----------------------------------------------------------------- calendar */
/* A calendar is drawn, not written, so it does not pass through the markdown
 * renderer: the server draws the grid at the paper's width and hands back a
 * page. What is left here is choosing which weeks to ask for. */
const calendarBody = () => ({
  range: $('calRange').value,
  year: Number($('calYear').value) || new Date().getFullYear(),
  month: Number($('calMonth').value) || (new Date().getMonth() + 1),
  date: $('calDate').value,
  size: Number($('calSize').value) || 14,
});

async function refreshCalendar() {
  await renderImageInto('calendar', '/api/calendar', calendarBody(),
                        $('calPreview'), $('calPreviewMeta'));
}

function initCalendar() {
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December'];
  const today = new Date();
  const select = $('calMonth');
  if (!select) return;

  months.forEach((name, index) => select.append(new Option(name, String(index + 1))));
  select.value = String(today.getMonth() + 1);
  $('calYear').value = today.getFullYear();
  $('calDate').value = today.toISOString().slice(0, 10);

  const onChange = () => {
    const week = $('calRange').value === 'week';
    $('calMonthFields').hidden = week;
    $('calWeekFields').hidden = !week;
    debounce('calendar', refreshCalendar, 150);
  };
  ['calRange', 'calMonth', 'calYear', 'calDate', 'calSize']
    .forEach((id) => $(id).addEventListener('change', onChange));

  $('calPrint').addEventListener('click', async () => {
    if (!state.printer.connected) { toast('Not connected to a printer', true); return; }
    try {
      const result = await api('/api/calendar',
        { method: 'POST', body: JSON.stringify({ ...calendarBody(), print: true }) });
      toast('Printed the calendar');
      status(result.message || 'Ready');
    } catch (error) {
      toast(`Could not print: ${error.message}`, true);
    }
  });
  onChange();
}

/* ------------------------------------------------------------------- labels */
/* A label is a printed background with your words placed on it, so placing is
 * done by pointing at the label rather than by typing coordinates into a form.
 * Coordinates are in the background's own pixels, which is why the click is
 * scaled by however large the preview happens to be drawn. */
const labelState = { template: null, areas: [], selected: null };

async function loadTemplates(keep) {
  try {
    const data = await api('/api/templates');
    const select = $('labelTemplate');
    if (!select) return;
    const wanted = keep || select.value;
    select.innerHTML = '';
    (data.templates || []).forEach((template) => {
      const option = new Option(
        template.mine ? template.name : template.name.replace(/^CTP500_/, ''),
        template.file);
      option.dataset.width = template.width;
      option.dataset.height = template.height;
      if (template.mine) option.dataset.mine = '1';
      select.append(option);
    });
    if (wanted && Array.from(select.options).some((o) => o.value === wanted)) {
      select.value = wanted;
    }
    labelState.template = data.templates?.[0] || null;
    markOwnTemplate();
  } catch (error) {
    toast('Could not list the label backgrounds', true);
  }
}

/* Only a background that was uploaded can be taken away again, so the button
 * that does it is only there when one is selected. */
function markOwnTemplate() {
  const option = $('labelTemplate')?.selectedOptions?.[0];
  const drop = $('labelDropBg');
  if (drop) drop.hidden = !option?.dataset.mine;
}

/* A picture of your own becomes a background: the file goes to the server,
 * which keeps it beside the shipped ones and hands back its size, since text
 * is placed in the background's own pixels. */
async function uploadLabelBackground(file) {
  if (!file) return;
  const name = file.name.replace(/\.[^.]+$/, '');
  const data = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('could not read that file'));
    reader.readAsDataURL(file);
  });
  try {
    const saved = await api('/api/templates',
      { method: 'POST', body: JSON.stringify({ data, name }) });
    await loadTemplates(saved.file);
    labelState.areas = [];
    renderLabelAreas();
    await refreshLabel();
    toast(`Added ${saved.name}`);
  } catch (error) {
    toast(`Could not use that picture: ${error.message}`, true);
  }
}

/* -------------------------------------------------------- saved labels */
/* A label worth printing once is usually worth printing again, so a background
 * and the blocks on it can be kept under a name and come back whole. */
let savedLabels = [];

async function loadSavedLabels() {
  try {
    savedLabels = (await api('/api/labels')).labels || [];
  } catch (error) {
    savedLabels = [];
  }
  renderSavedLabels();
}

function renderSavedLabels() {
  const list = $('labelSaved');
  const meta = $('labelSavedMeta');
  if (!list) return;
  if (meta) meta.textContent = savedLabels.length ? `${savedLabels.length} saved` : '–';
  list.innerHTML = '';
  if (!savedLabels.length) {
    list.innerHTML = '<p class="hint">Nothing saved yet. Place some text, name it, and save.</p>';
    return;
  }
  savedLabels.forEach((label) => {
    const row = document.createElement('div');
    row.className = 'item';
    row.innerHTML = `<div class="row-form">
        <button class="btn subtle" data-act="open" style="flex:1;text-align:left">
          ${escapeHtml(label.name)}</button>
        <button class="btn subtle" data-act="remove" title="Forget this label">Remove</button>
      </div>`;
    row.querySelector('[data-act="open"]').addEventListener('click', () => openSavedLabel(label));
    row.querySelector('[data-act="remove"]').addEventListener('click', async () => {
      try {
        savedLabels = (await api(`/api/labels/${encodeURIComponent(label.name)}`,
          { method: 'DELETE' })).labels || [];
        renderSavedLabels();
      } catch (error) {
        toast(`Could not remove it: ${error.message}`, true);
      }
    });
    list.append(row);
  });
}

async function openSavedLabel(label) {
  const select = $('labelTemplate');
  if (select && label.template) {
    if (!Array.from(select.options).some((option) => option.value === label.template)) {
      toast('That label\'s background is missing', true);
      return;
    }
    select.value = label.template;
    markOwnTemplate();
  }
  labelState.areas = (label.areas || []).map((area) => ({ ...area }));
  $('labelName').value = label.name;
  renderLabelAreas();
  await refreshLabel();
}

async function saveCurrentLabel() {
  const name = $('labelName').value.trim();
  if (!name) { toast('Give the label a name first', true); return; }
  try {
    savedLabels = (await api('/api/labels', {
      method: 'POST',
      body: JSON.stringify({ name, template: currentTemplate()?.file,
                             areas: labelState.areas }),
    })).labels || [];
    renderSavedLabels();
    toast(`Saved ${name}`);
  } catch (error) {
    toast(`Could not save it: ${error.message}`, true);
  }
}

function currentTemplate() {
  const select = $('labelTemplate');
  const option = select?.selectedOptions?.[0];
  if (!option) return null;
  return { file: option.value, width: Number(option.dataset.width),
           height: Number(option.dataset.height) };
}

function labelAreaRow(area, index) {
  const row = document.createElement('div');
  row.className = 'item label-area';
  row.dataset.index = String(index);
  // pointing at a row lights up the block it stands for, and the other way
  // round, so which line of the form is which block on the label is never a
  // question worth asking
  row.addEventListener('pointerenter', () => highlightLabelArea(index, true));
  row.addEventListener('pointerleave', () => highlightLabelArea(index, false));
  row.innerHTML = `
    <div class="row-form">
      <input class="control" data-field="text" value="${escapeHtml(area.text)}"
             placeholder="Text for this block">
      <input class="control narrow" data-field="font_size" type="number" min="8" max="90"
             step="1" value="${area.font_size}" title="Type size">
      <button class="btn subtle" data-act="remove" title="Remove this block">Remove</button>
    </div>
    <p class="hint">at ${area.x}, ${area.y} - drag it on the label to move it</p>`;
  row.querySelector('[data-field="text"]').addEventListener('input', (event) => {
    area.text = event.target.value;
    debounce('label', refreshLabel, 200);
  });
  row.querySelector('[data-field="font_size"]').addEventListener('change', (event) => {
    area.font_size = Number(event.target.value) || 24;
    refreshLabel();
  });
  row.querySelector('[data-act="remove"]').addEventListener('click', () => {
    labelState.areas.splice(index, 1);
    renderLabelAreas();
    refreshLabel();
  });
  return row;
}

function renderLabelAreas() {
  const list = $('labelAreas');
  list.innerHTML = '';
  if (!labelState.areas.length) {
    list.innerHTML = '<p class="hint">No text yet. Click the label where you want some.</p>';
    placeLabelHandles();
    return;
  }
  labelState.areas.forEach((area, index) => list.append(labelAreaRow(area, index)));
  placeLabelHandles();
}

/* A block on the label is text baked into a picture, which nothing can take
 * hold of. So each one gets a handle laid over the picture where the text
 * lands: that is what lights up under the pointer and what a drag moves. Its
 * size is the room the text will take, near enough to grab. */
function labelHandleBox(area) {
  const lines = String(area.text || ' ').split('\n');
  const longest = Math.max(...lines.map((line) => line.length), 1);
  return {
    x: area.x,
    y: area.y,
    w: Math.max(area.font_size, longest * area.font_size * 0.58),
    h: Math.max(area.font_size, lines.length * area.font_size * 1.2),
  };
}

function placeLabelHandles() {
  const host = $('labelHandles');
  const image = $('labelPreview');
  const stage = $('labelStage');
  if (!host || !image || !stage) return;
  const template = currentTemplate();
  if (!template || !image.naturalWidth) { host.innerHTML = ''; return; }

  const box = image.getBoundingClientRect();
  const frame = stage.getBoundingClientRect();
  const scale = box.width / template.width;
  const offsetX = box.left - frame.left;
  const offsetY = box.top - frame.top;

  host.innerHTML = '';
  labelState.areas.forEach((area, index) => {
    const place = labelHandleBox(area);
    const handle = document.createElement('div');
    handle.className = 'label-handle';
    handle.dataset.index = String(index);
    handle.tabIndex = 0;
    handle.title = `${area.text || 'Text'} - drag to move it`;
    handle.style.left = `${offsetX + place.x * scale}px`;
    handle.style.top = `${offsetY + place.y * scale}px`;
    handle.style.width = `${Math.max(18, place.w * scale)}px`;
    handle.style.height = `${Math.max(14, place.h * scale)}px`;
    handle.addEventListener('pointerenter', () => highlightLabelArea(index, true));
    handle.addEventListener('pointerleave', () => highlightLabelArea(index, false));
    host.append(handle);
  });
}

function highlightLabelArea(index, on) {
  document.querySelectorAll(`#labelHandles .label-handle[data-index="${index}"],
                             #labelAreas .label-area[data-index="${index}"]`)
    .forEach((element) => element.classList.toggle('is-hot', on));
}

function labelBody(extra = {}) {
  const template = currentTemplate();
  return {
    template: template?.file,
    areas: labelState.areas,
    darkness: Number($('darkness')?.value) || 1.5,
    ...extra,
  };
}

async function refreshLabel() {
  const template = currentTemplate();
  if (!template) return;
  $('labelMeta').textContent = `${template.width} x ${template.height}`;
  await renderImageInto('label', '/api/label', labelBody(),
                        $('labelPreview'), $('labelPreviewMeta'));
}

/* the preview is drawn at whatever width fits, so a click has to be put back
 * into the background's own coordinates before it means anything */
function labelPointFromEvent(event) {
  const image = $('labelPreview');
  const template = currentTemplate();
  if (!image.naturalWidth || !template) return null;
  const box = image.getBoundingClientRect();
  const scale = template.width / box.width;
  return {
    x: Math.max(0, Math.round((event.clientX - box.left) * scale)),
    y: Math.max(0, Math.round((event.clientY - box.top) * scale)),
  };
}

function initLabels() {
  const stage = $('labelStage');
  if (!stage) return;

  $('labelTemplate').addEventListener('change', () => { markOwnTemplate(); refreshLabel(); });
  $('labelUpload').addEventListener('click', () => $('labelFile').click());
  $('labelFile').addEventListener('change', (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    uploadLabelBackground(file);
  });
  $('labelDropBg').addEventListener('click', async () => {
    const option = $('labelTemplate').selectedOptions?.[0];
    if (!option?.dataset.mine) return;
    try {
      await api(`/api/templates/${encodeURIComponent(option.value)}`, { method: 'DELETE' });
      await loadTemplates();
      await refreshLabel();
    } catch (error) {
      toast(`Could not remove it: ${error.message}`, true);
    }
  });
  $('labelSave').addEventListener('click', saveCurrentLabel);
  $('labelAdd').addEventListener('click', () => {
    labelState.areas.push({ x: 20, y: 20, text: 'Text', font_size: 28,
                            font_family: currentFont(), alignment: 'left' });
    renderLabelAreas();
    refreshLabel();
  });
  $('labelClear').addEventListener('click', () => {
    labelState.areas = [];
    renderLabelAreas();
    refreshLabel();
  });

  // A click on bare label makes a block; a drag that starts on a handle moves
  // the block that handle belongs to. The handle moves with the pointer and
  // the picture catches up behind it, because waiting on a round trip for
  // every pixel would make the drag feel stuck.
  let dragging = null;
  let handle = null;
  let moved = false;

  stage.addEventListener('pointerdown', (event) => {
    const grabbed = event.target.closest?.('.label-handle');
    const point = labelPointFromEvent(event);
    if (!point) return;
    moved = false;
    if (grabbed) {
      dragging = labelState.areas[Number(grabbed.dataset.index)];
      handle = grabbed;
      if (!dragging) { handle = null; return; }
      dragging.grabX = point.x - dragging.x;
      dragging.grabY = point.y - dragging.y;
      handle.classList.add('is-held');
      stage.setPointerCapture(event.pointerId);
      event.preventDefault();
    }
  });

  stage.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    const point = labelPointFromEvent(event);
    if (!point) return;
    moved = true;
    dragging.x = Math.max(0, point.x - dragging.grabX);
    dragging.y = Math.max(0, point.y - dragging.grabY);
    const image = $('labelPreview');
    const template = currentTemplate();
    if (handle && template && image.naturalWidth) {
      const scale = image.getBoundingClientRect().width / template.width;
      const frame = stage.getBoundingClientRect();
      const box = image.getBoundingClientRect();
      handle.style.left = `${(box.left - frame.left) + dragging.x * scale}px`;
      handle.style.top = `${(box.top - frame.top) + dragging.y * scale}px`;
    }
    debounce('label', refreshLabel, 90);
  });

  const drop = () => {
    if (!dragging) return false;
    delete dragging.grabX;
    delete dragging.grabY;
    dragging = null;
    handle?.classList.remove('is-held');
    handle = null;
    if (moved) { renderLabelAreas(); refreshLabel(); }
    return true;
  };

  stage.addEventListener('pointercancel', drop);
  stage.addEventListener('pointerup', (event) => {
    if (drop()) return;
    if (event.target.id !== 'labelPreview') return;
    const point = labelPointFromEvent(event);
    if (!point) return;
    labelState.areas.push({ ...point, text: 'Text', font_size: 28,
                            font_family: currentFont(), alignment: 'left' });
    renderLabelAreas();
    refreshLabel();
  });

  // the handles are laid over a picture whose size follows the window, so they
  // are placed again whenever that changes or a fresh render arrives
  $('labelPreview').addEventListener('load', placeLabelHandles);
  window.addEventListener('resize', () => debounce('labelHandles', placeLabelHandles, 120));

  $('labelPrint').addEventListener('click', async () => {
    if (!state.printer.connected) { toast('Not connected to a printer', true); return; }
    try {
      const result = await api('/api/label',
        { method: 'POST', body: JSON.stringify(labelBody({ print: true })) });
      toast('Printed the label');
      status(result.message || 'Ready');
    } catch (error) {
      toast(`Could not print: ${error.message}`, true);
    }
  });

  renderLabelAreas();
}

/* ------------------------------------------------- pages that are pictures */
/* Calendars and labels come back as a PNG rather than as JSON, so they share
 * one fetch that swaps the image and reports the paper it will use. */
async function renderImageInto(key, url, body, img, meta) {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error('render failed');
    const blob = await response.blob();
    if (previewUrls[key]) URL.revokeObjectURL(previewUrls[key]);
    previewUrls[key] = URL.createObjectURL(blob);
    img.src = previewUrls[key];
    img.onload = () => {
      meta.textContent =
        `${img.naturalWidth} x ${img.naturalHeight} - ${toMm(img.naturalHeight)} mm`;
    };
  } catch (error) {
    meta.textContent = 'preview failed';
  }
}

/* --------------------------------------------------- tear-off calibration */
/* How far the paper has to come out to clear the tear bar is a fact about the
 * printer's body, so it is measured rather than guessed: print a strip that
 * ends in a line, tear it, and see where the tear landed. */
let tearMm = 1;

function initTearWizard() {
  const test = $('tearTestBtn');
  if (!test) return;
  const label = $('tearTestMm');
  const accept = $('tearAcceptBtn');
  const next = $('tearNextBtn');
  const hint = $('tearWizardHint');

  const show = () => { label.textContent = String(tearMm); };

  test.addEventListener('click', async () => {
    if (!state.printer.connected) { toast('Not connected to a printer', true); return; }
    try {
      await api('/api/tear-test', { method: 'POST', body: JSON.stringify({ mm: tearMm }) });
      accept.disabled = false;
      next.disabled = false;
      hint.textContent = 'Tear it off. Did the tear land on the printed line?';
    } catch (error) {
      toast(`Could not print the test: ${error.message}`, true);
    }
  });

  accept.addEventListener('click', async () => {
    try {
      await api('/api/tear-gap', { method: 'POST', body: JSON.stringify({ mm: tearMm }) });
      $('tearGap').value = tearMm;
      hint.textContent = `Saved. Every print now feeds ${tearMm} mm after it finishes.`;
      accept.disabled = true;
      next.disabled = true;
      toast(`Tear-off gap set to ${tearMm} mm`);
    } catch (error) {
      toast(`Could not save: ${error.message}`, true);
    }
  });

  next.addEventListener('click', () => {
    tearMm = Math.min(40, tearMm + 1);
    show();
    hint.textContent = 'Print again at the new gap and judge the tear once more.';
  });

  show();
}

/* --------------------------------------------------------- preset editor */
let editingPreset = null;

function openPresetEditor(preset) {
  editingPreset = preset || null;
  $('presetModalTitle').textContent = preset ? 'Edit preset' : 'New preset';
  $('presetName').value = preset?.name || '';
  $('presetDesc').value = preset?.description || '';
  $('presetText').value = preset?.text ?? editor().value;
  $('presetFont').value = preset?.options?.font || currentFont();
  $('presetSize').value = preset?.options?.size || $('fontSize').value || 24;
  $('presetDarkness').value = preset?.options?.darkness || $('darkness').value || 1;
  $('presetDirection').value = preset?.options?.orientation || currentDirection();
  $('presetStrip').value = toMm(preset?.options?.page_length
    || Number(localStorage.getItem(LENGTH_KEY)) || 1200);
  syncPresetDirection();

  $('presetDelete').hidden = !preset;
  $('presetDuplicate').hidden = !preset;

  $('presetModal').hidden = false;
  $('presetName').focus();
  refreshPresetPreview();
}

function closePresetEditor() {
  $('presetModal').hidden = true;
  editingPreset = null;
}

/* the strip fields only mean anything along the roll */
function syncPresetDirection() {
  const along = $('presetDirection')?.value === 'landscape';
  if ($('presetAlongFields')) $('presetAlongFields').hidden = !along;
}

function presetEditorOptions() {
  return {
    font: $('presetFont').value || currentFont(),
    size: Number($('presetSize').value) || 24,
    darkness: Number($('presetDarkness').value) || 1,
    orientation: $('presetDirection')?.value || 'portrait',
    page_length: toDots(Number($('presetStrip')?.value) || 150),
  };
}

const refreshPresetPreview = () => renderInto(
  'preset', $('presetText').value, $('presetPreview'), $('presetPreviewMeta'),
  presetEditorOptions()
);

async function submitPreset() {
  const name = $('presetName').value.trim();
  if (!name) { toast('A preset needs a name', true); $('presetName').focus(); return; }

  // a new preset that reuses an existing name updates it rather than making a
  // second entry that is impossible to tell apart in the list
  const clash = state.presets.find(
    (p) => p.name.toLowerCase() === name.toLowerCase() && p.id !== editingPreset?.id
  );
  if (clash && !confirm(`"${clash.name}" already exists. Overwrite it?`)) return;

  const result = await api('/api/presets', {
    method: 'POST',
    body: JSON.stringify({
      id: editingPreset?.id || clash?.id,
      name,
      description: $('presetDesc').value,
      text: $('presetText').value,
      options: presetEditorOptions(),
    }),
  });

  state.presets = result.presets;
  renderPresets();
  closePresetEditor();
  toast(`Saved "${result.preset.name}"`);
}

function initPresetEditor() {
  $('newPresetBtn').addEventListener('click', () => openPresetEditor(null));
  $('presetCancel').addEventListener('click', closePresetEditor);
  $('presetClose').addEventListener('click', closePresetEditor);

  $('presetModal').addEventListener('click', (event) => {
    if (event.target === $('presetModal')) closePresetEditor();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !$('presetModal').hidden) closePresetEditor();
  });

  $('presetSave').addEventListener('click', submitPreset);

  $('presetDelete').addEventListener('click', async () => {
    if (!editingPreset) return;
    if (!confirm(`Delete "${editingPreset.name}"?`)) return;
    await api(`/api/presets/${editingPreset.id}`, { method: 'DELETE' });
    if (state.activePresetId === editingPreset.id) {
      state.activePresetId = null;
      $('presetLabel').textContent = 'Untitled';
    }
    closePresetEditor();
    await loadPresets();
    toast('Preset deleted');
  });

  $('presetDuplicate').addEventListener('click', () => {
    // drop the id so saving creates a second entry
    editingPreset = null;
    $('presetModalTitle').textContent = 'New preset';
    $('presetName').value = `${$('presetName').value} copy`;
    $('presetDelete').hidden = true;
    $('presetDuplicate').hidden = true;
    $('presetName').select();
  });

  ['presetText', 'presetFont', 'presetSize', 'presetDarkness'].forEach((id) => {
    $(id).addEventListener('input', () => debounce('preset', refreshPresetPreview));
  });

  // markdown buttons and token inserts inside the modal
  document.querySelectorAll('.tool[data-pmd]').forEach((button) => {
    button.addEventListener('click', () => {
      withPresetTextarea(() => MD_ACTIONS[button.dataset.pmd]?.());
    });
  });
  document.querySelectorAll('.tool[data-token]').forEach((button) => {
    button.addEventListener('click', () => {
      const area = $('presetText');
      const at = area.selectionStart;
      area.setRangeText(button.dataset.token, at, area.selectionEnd, 'end');
      area.focus();
      refreshPresetPreview();
    });
  });
}

/* The markdown helpers act on whatever editor() returns, so point it at the
 * modal's textarea for the duration of one action rather than duplicating
 * every wrap and prefix routine. */
function withPresetTextarea(action) {
  const original = editorTarget;
  editorTarget = () => $('presetText');
  try { action(); } finally { editorTarget = original; }
  refreshPresetPreview();
}

/* ------------------------------------------------------------------ todos */
async function loadTodos() {
  const data = await api('/api/todos');
  state.todos = data.todos || [];
  renderTodos();
}

/* ------------------------------------------------------------------ icons */
/* A row of small buttons reads faster as shapes than as words, and stays the
 * same width in every language. Drawn rather than typed: an emoji is a font
 * question and renders differently on every machine. Each one keeps a label
 * for anything that is not looking at it. */
const ICON_PATHS = {
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  delete: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/>',
  save: '<path d="M20 6 9 17l-5-5"/>',
  cancel: '<path d="M18 6 6 18"/><path d="M6 6l12 12"/>',
  open: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M21 14v7H3V3h7"/>',
  print: '<path d="M6 9V2h12v7"/><rect x="2" y="9" width="20" height="8" rx="2"/><path d="M6 14h12v8H6z"/>',
};

function icon(name, label) {
  return `<button class="iconbtn${name === 'delete' ? ' del' : ''}" data-act="${name}"
      title="${label}" aria-label="${label}"><svg viewBox="0 0 24 24" fill="none"
      stroke="currentColor" stroke-width="2" stroke-linecap="round"
      stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name]}</svg></button>`;
}

function renderTodos() {
  const list = $('todoList');
  list.innerHTML = '';
  const open = state.todos.filter((t) => !t.done).length;
  $('todoCount').textContent = `${open} open`;

  scheduleTodoPreview();

  if (!state.todos.length) {
    list.innerHTML = '<li class="empty">Nothing here yet.</li>';
    return;
  }

  state.todos.forEach((todo) => {
    list.append(todo.id === editingTodo ? todoEditRow(todo) : todoRow(todo));
  });
  // typing into the item that is being edited, rather than at the end of the list
  $('todoList').querySelector('[data-field="text"]')?.focus();
}

/* Which item is open for editing, if any. One at a time: a list where every
 * line is a text box is a form, not a list. */
let editingTodo = null;

function todoRow(todo) {
  const li = document.createElement('li');
  li.className = `item${todo.done ? ' done' : ''}`;
  li.innerHTML = `
    <input type="checkbox" ${todo.done ? 'checked' : ''} aria-label="Done">
    <div class="name"></div>
    <span class="spacer"></span>
    ${icon('edit', 'Edit this item')}
    ${icon('delete', 'Delete this item')}`;
  li.querySelector('.name').textContent = todo.text;

  li.querySelector('input').addEventListener('change', async (event) => {
    const data = await api(`/api/todos/${todo.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ done: event.target.checked }),
    });
    state.todos = data.todos;
    renderTodos();
  });
  // the text itself is the obvious thing to click when you want to change it
  li.querySelector('.name').addEventListener('click', () => {
    editingTodo = todo.id;
    renderTodos();
  });
  li.querySelector('[data-act="edit"]').addEventListener('click', () => {
    editingTodo = todo.id;
    renderTodos();
  });
  li.querySelector('[data-act="delete"]').addEventListener('click', async () => {
    const data = await api(`/api/todos/${todo.id}`, { method: 'DELETE' });
    state.todos = data.todos;
    renderTodos();
  });
  return li;
}

/* The same line with its text in a field: Enter or Save keeps the change,
 * Escape or the cross leaves it alone. Nothing is written until one of those
 * happens, so an abandoned edit costs nothing. */
function todoEditRow(todo) {
  const li = document.createElement('li');
  li.className = 'item editing';
  li.innerHTML = `
    <input class="control grow" data-field="text" aria-label="Item text">
    ${icon('save', 'Keep this change')}
    ${icon('cancel', 'Leave it as it was')}`;
  const field = li.querySelector('[data-field="text"]');
  field.value = todo.text;

  const close = () => { editingTodo = null; renderTodos(); };
  const save = async () => {
    const text = field.value.trim();
    if (!text || text === todo.text) { close(); return; }
    try {
      const data = await api(`/api/todos/${todo.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ text, done: todo.done }),
      });
      state.todos = data.todos;
    } catch (error) {
      toast(`Could not save that: ${error.message}`, true);
    }
    close();
  };

  field.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); save(); }
    if (event.key === 'Escape') { event.preventDefault(); close(); }
  });
  li.querySelector('[data-act="save"]').addEventListener('click', save);
  li.querySelector('[data-act="cancel"]').addEventListener('click', close);
  return li;
}

const TODO_TITLE_KEY = 'tp.todoTitle';
const TODO_DATE_KEY = 'tp.todoDate';

function todosAsMarkdown() {
  const open = state.todos.filter((t) => !t.done);
  const done = state.todos.filter((t) => t.done);

  const title = ($('todoTitle').value || '').trim();
  const lines = [];
  if (title) lines.push(`# ${title}`);

  if ($('todoDate').checked) {
    lines.push(new Date().toLocaleString(undefined, {
      weekday: 'short', day: 'numeric', month: 'short',
      hour: '2-digit', minute: '2-digit',
    }));
  }
  if (lines.length) lines.push('');

  if (!open.length && !done.length) lines.push('_nothing to do_');
  open.forEach((t) => lines.push(`- ${t.text}`));

  if (done.length) {
    lines.push('', '> done');
    done.forEach((t) => lines.push(`- ~~${t.text}~~`));
  }
  return lines.join('\n');
}

function initTodos() {
  $('todoTitle').value = localStorage.getItem(TODO_TITLE_KEY) ?? 'To-do';
  $('todoDate').checked = localStorage.getItem(TODO_DATE_KEY) !== 'false';

  $('todoTitle').addEventListener('input', () => {
    localStorage.setItem(TODO_TITLE_KEY, $('todoTitle').value);
    scheduleTodoPreview();
  });
  $('todoDate').addEventListener('change', () => {
    localStorage.setItem(TODO_DATE_KEY, String($('todoDate').checked));
    refreshTodoPreview();
  });

  $('todoForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const input = $('todoInput');
    const text = input.value.trim();
    if (!text) return;
    const data = await api('/api/todos', { method: 'POST', body: JSON.stringify({ text }) });
    state.todos = data.todos;
    input.value = '';
    renderTodos();
  });

  $('clearDoneBtn').addEventListener('click', async () => {
    const data = await api('/api/todos/clear-done', { method: 'POST' });
    state.todos = data.todos;
    renderTodos();
    toast('Cleared completed items');
  });

  $('printTodosBtn').addEventListener('click', () => {
    if (!state.todos.length) { toast('Nothing to print', true); return; }
    printText(todosAsMarkdown(), 'Printed to-do list', todoOptions());
  });

  $('todoToPresetBtn').addEventListener('click', () => {
    openPresetEditor(null);
    $('presetName').value = $('todoTitle').value || 'To-do';
    $('presetText').value = todosAsMarkdown()
      // keep it a live template rather than freezing today's date into it
      .replace(/^[A-Z][a-z]{2},? .*\d{2}:\d{2}$/m, '{{datetime}}');
    refreshPresetPreview();
  });
}

/* --------------------------------------------------------------- settings */
function renderDevices(profiles) {
  const list = $('deviceList');
  if (!list) return;
  list.innerHTML = '';

  if (!profiles.length) {
    list.innerHTML = '<li class="empty">No devices saved yet.</li>';
    return;
  }

  profiles.forEach((profile) => {
    const li = document.createElement('li');
    li.className = 'item';
    li.innerHTML = `
      <div>
        <div class="name"></div>
        <div class="sub"></div>
      </div>
      <span class="spacer"></span>
      ${icon('edit', 'Edit this device')}
      ${icon('delete', 'Remove this device')}`;
    li.querySelector('.name').textContent = profile.name;
    li.querySelector('.sub').textContent =
      `${profile.transport} - ${profile.address} - tear ${profile.tearGapMm} mm`;

    li.querySelector('[data-act="edit"]').addEventListener('click', () => editDevice(profile));
    li.querySelector('[data-act="delete"]').addEventListener('click', async () => {
      await api(`/api/profiles/${encodeURIComponent(profile.name)}`, { method: 'DELETE' });
      await refreshState();
      toast('Device removed');
    });

    list.append(li);
  });
}

async function scanDevices() {
  const button = $('scanBtn');
  button.disabled = true;
  button.textContent = 'Scanning';
  try {
    const data = await api(`/api/devices?transport=${encodeURIComponent($('newTransport').value)}`);
    const select = $('newDevice');
    select.innerHTML = '';
    if (!data.devices.length) {
      select.append(new Option('Nothing found', ''));
    }
    data.devices.forEach((device) => select.append(new Option(device.label, device.value)));
    if (data.devices.length && !$('newName').value.trim()) {
      $('newName').value = data.devices[0].label.split(' (')[0];
    }
    toast(`${data.devices.length} device(s) found`);
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = 'Scan';
  }
}

/* ------------------------------------------------------------- the network */
/* The server listens to this machine only until it is told otherwise, and this
 * switch is the whole of that decision. Turning it on replaces the listening
 * socket rather than restarting anything, so an open printer connection and
 * whatever is in the editor both survive it. */
async function initNetworkSwitch() {
  const box = $('networkExposed');
  if (!box) return;

  const describe = (data) => {
    const meta = $('networkMeta');
    const hint = $('networkHint');
    box.checked = !!data.exposed;
    if (data.override) {
      // the unit file, or whoever started the process, has already decided
      box.disabled = true;
      if (meta) meta.textContent = `fixed to ${data.override}`;
      if (hint) {
        hint.textContent =
          `THERMAL_WEB_HOST is set to ${data.override}, so where the server `
          + 'listens was decided outside the app and cannot be changed here.';
      }
      return;
    }
    if (!meta) return;
    meta.textContent = data.exposed
      ? (data.addresses || []).map((address) => `${address}:${data.port}`)[0]
        || `open on port ${data.port}`
      : 'this machine only';
  };

  // the raw printing port, which follows the switch above rather than having
  // an address of its own
  const raw = $('rawPort');
  const describeRaw = (data) => {
    if (!raw) return;
    raw.checked = !!data.rawPort;
  };

  try {
    const data = await api('/api/network');
    describe(data);
    describeRaw(data);
  } catch (error) {
    return;
  }

  raw?.addEventListener('change', async () => {
    const wanted = raw.checked;
    try {
      const result = await api('/api/raw-port',
        { method: 'POST', body: JSON.stringify({ enabled: wanted }) });
      if (result.message) toast(result.message, true);
      else toast(wanted ? `Listening on port ${result.port}` : 'Raw port closed');
      raw.checked = wanted ? !!result.open : false;
    } catch (error) {
      raw.checked = !wanted;
      toast(error.message, true);
    }
  });

  box.addEventListener('change', async () => {
    const wanted = box.checked;
    if (wanted && !confirm(
      'Anything that can reach this machine will be able to print, and there '
      + 'is no password. Open it to the network?')) {
      box.checked = false;
      return;
    }
    try {
      const result = await api('/api/network',
        { method: 'POST', body: JSON.stringify({ exposed: wanted }) });
      describe(result);
      toast(wanted
        ? `Open at ${(result.addresses || [])[0] || 'this machine'}:${result.port}`
        : 'Closed to the network');
    } catch (error) {
      box.checked = !wanted;
      toast(error.message, true);
    }
  });
}

/* A saved device is a name, a way to reach it, a printer type and a calibrated
 * gap, and any of the four can turn out to be wrong: a printer that moves to a
 * cable, a type chosen before the right one existed. Editing one fills the
 * same form the device was made in and sends the old name along, so the entry
 * is changed rather than a near-duplicate created beside it. */
let editingDevice = null;

function editDevice(profile) {
  editingDevice = profile.name;
  const details = $('addDeviceBtn').closest('details');
  if (details) details.open = true;

  $('newTransport').value = profile.transport || 'Bluetooth';
  const devices = $('newDevice');
  // the address is normally chosen from a scan; the saved one is put in the
  // list so the device can be edited without the printer being switched on
  if (!Array.from(devices.options).some((option) => option.value === profile.address)) {
    devices.append(new Option(profile.address || '(none)', profile.address || ''));
  }
  devices.value = profile.address || '';
  if (profile.capabilityProfile) $('newCapability').value = profile.capabilityProfile;
  $('newName').value = profile.name;

  $('addDeviceBtn').textContent = 'Save changes';
  $('cancelEditBtn').hidden = false;
  details?.querySelector('summary')?.replaceChildren(`Editing ${profile.name}`);
  $('newName').focus();
}

function stopEditingDevice() {
  editingDevice = null;
  $('addDeviceBtn').textContent = 'Save device';
  $('cancelEditBtn').hidden = true;
  $('newName').value = '';
  const details = $('addDeviceBtn').closest('details');
  details?.querySelector('summary')?.replaceChildren('Add a device');
}

function initSettings() {
  $('scanBtn').addEventListener('click', scanDevices);
  $('newTransport').addEventListener('change', scanDevices);
  $('cancelEditBtn').addEventListener('click', stopEditingDevice);

  $('addDeviceBtn').addEventListener('click', async () => {
    try {
      await api('/api/profiles', {
        method: 'POST',
        body: JSON.stringify({
          name: $('newName').value,
          transport: $('newTransport').value,
          address: $('newDevice').value,
          capabilityProfile: $('newCapability').value,
          originalName: editingDevice || undefined,
        }),
      });
      const was = editingDevice;
      stopEditingDevice();
      await refreshState();
      toast(was ? 'Device updated' : 'Device saved');
    } catch (error) {
      toast(error.message, true);
    }
  });

  initNetworkSwitch();
  $('statusBtn')?.addEventListener('click', checkPrinterStatus);
  initWirePane();
  // the sheet is scaled to the panel, so the ruler under it has to be redrawn
  // when the panel changes size
  window.addEventListener('resize', () => refreshRulers());

  $('printFrame')?.addEventListener('change', () => {
    remember(PRINT_FRAME_KEY, $('printFrame').checked ? 'on' : 'off');
    describePaper(state.printer || {});
  });

  $('saveTearBtn').addEventListener('click', async () => {
    await api('/api/tear-gap', { method: 'POST', body: JSON.stringify({ mm: $('tearGap').value }) });
    await refreshState();
    toast('Tear gap saved');
  });

  $('fontSize').addEventListener('change', refreshPreview);
  $('darkness').addEventListener('change', refreshPreview);
}

/* ------------------------------------------------------------------- boot */
function initShortcuts() {
  document.addEventListener('keydown', (event) => {
    if (!(event.ctrlKey || event.metaKey)) return;
    if (event.key === 'p') { event.preventDefault(); printText(editorMarkdown()); }
    if (event.key === 's') { event.preventDefault(); openPresetEditor(null); }
  });
}

async function boot() {
  await loadThemes();
  initTheme();
  initTabs();
  initEditorModes();
  initToolbar();
  initConnection();
  initTodos();
  initTodoDirection();
  initSettings();
  initFontControls();
  initOrientation();
  initPresetEditor();
  initSymbols();
  initToolMenu();
  initCalendar();
  initLabels();
  initPrinterTypes();
  initTearWizard();
  initShortcuts();

  editor().addEventListener('input', () => {
    schedulePreview();
    debounce('align', alignTablesInEditor, 800);
  });
  $('printBtn').addEventListener('click', () => printText(editorMarkdown()));
  $('savePresetBtn').addEventListener('click', () => openPresetEditor(null));

  try {
    await refreshState();
    await Promise.all([loadFonts(), loadDitherModes(), loadPresets(), loadTodos(),
                       loadTemplates(), loadSavedLabels()]);
    // the list's font field is filled from the same list as everything else,
    // so it can only be set once that list has arrived
    showTodoType();
  } catch (error) {
    toast(`Could not reach the server: ${error.message}`, true);
  }

  if (!editorMarkdown()) {
    setEditorMarkdown('# Groceries\nMilk and eggs.\n- bread\n- butter\n> dont forget the receipt');
  }
  refreshPreview();

  // back to whichever pane was open, once everything it needs has loaded
  const last = recall(VIEW_KEY);
  if (last && last !== 'compose') showView(last);

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

document.addEventListener('DOMContentLoaded', boot);
