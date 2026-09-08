/**
 * app.js — LVO chat app shell.
 *
 * (See original header comments — unchanged.) This version adds:
 *
 * TOP TABS (NEW): Chat / Calendar / News, Teams-style, in the rail
 * header. switchTab() toggles which pane is visible in <main> and
 * which lists show in the rail. Chat behaves exactly as before.
 *
 * CALENDAR (NEW): month-grid view. Anyone can view; only admins see
 * the "+ New event" button and can delete events. Expects new backend
 * endpoints — see the API CONTRACT note near loadCalendarEvents().
 *
 * NEWS (NEW): an announcements feed, separate from channels. Anyone
 * can read; only admins get the compose box. Expects new backend
 * endpoints — see the API CONTRACT note near loadNewsPosts().
 *
 * GLOBAL SEARCH (NEW): Teams-style "Search or type a command" box in
 * the rail. Searches channels + members locally (already loaded
 * client-side) and asks the server for matching messages via
 * GET /search?q=... Selecting a result jumps straight to that
 * channel/DM (and, for a message hit, that conversation).
 */


const SERVER_URL = 'https://lvo-chat-relay.lvoholdings00.workers.dev';

const SESSION_KEY = 'lvo_session'; // { token, user } in localStorage

// GIPHY SDK key — safe to embed client-side (GIPHY's Web/JS SDK keys are
// meant to ship in the frontend bundle, unlike a private server key).
const GIPHY_API_KEY = 'n7IXLWcTUPp5fr5ZgJ7g7zNIs0Cn5PQE';

// ---------------------------------------------------------------------
// lazy asset loading
// ---------------------------------------------------------------------
function loadScriptOnce(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[data-lazy="${src}"]`)) {
      resolve();
      return;
    }
    const s = document.createElement('script');
    s.src = src;
    s.dataset.lazy = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(s);
  });
}

let emojiPickerLoadPromise = null;
function ensureEmojiPicker() {
  if (!emojiPickerLoadPromise) {
    emojiPickerLoadPromise = import('https://cdn.jsdelivr.net/npm/emoji-picker-element@^1/index.js');
  }
  return emojiPickerLoadPromise;
}

// ---------------------------------------------------------------------
// session
// ---------------------------------------------------------------------
function loadSession() {
  try {
    return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
  } catch {
    return null;
  }
}
function saveSession(session) {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}
function clearSession() {
  localStorage.removeItem(SESSION_KEY);
}

async function api(path, { method = 'GET', body, token, rawBody, contentType, headers: extraHeaders } = {}) {
  const headers = { ...(extraHeaders || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  let fetchBody;
  if (rawBody !== undefined) {
    fetchBody = rawBody;
    if (contentType) headers['Content-Type'] = contentType;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    fetchBody = JSON.stringify(body);
  }
  const res = await fetch(`${SERVER_URL}${path}`, { method, headers, body: fetchBody });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// ---------------------------------------------------------------------
// state
// ---------------------------------------------------------------------
let session = loadSession();
let roster = [];
let presetsById = {};
let channels = []; // [{id, name, type, memberCount, canPost}]
let selectedPeerId = null;
let selectedChannelId = null; // mutually exclusive with selectedPeerId

let socket = null;
const avatarBlobCache = new Map(); // userId -> object URL
const channelTypeById = {}; // scratch used while building the create-channel modal

// Files + reactions state.
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024; // must match the Worker's limits
let pendingFiles = []; // File[] queued in the composer, not yet sent
let channelMessageEls = {}; // messageId -> { el, reactions } for the currently-open channel only
let reactionPickerCtx = null; // { channelId, messageId } the picker popup is currently anchored to
const fileBlobCache = new Map(); // storageKey -> object URL, for plaintext attachments
let gifSearchDebounce = null; // debounce handle for the GIF search box

// NEW: top-level tab state (chat / calendar / news)
let currentTab = 'chat';

// NEW: calendar state
let calendarCursor = new Date(); // month currently shown
let calendarCursor2 = null; // unused placeholder guard (kept out of the way of minifiers)
let calendarEventsByDate = {}; // 'YYYY-MM-DD' -> [event, ...]
let calendarSelectedDate = null; // 'YYYY-MM-DD'

// NEW: news state
let newsPosts = [];

// NEW: recent chats (client-side, per-account, localStorage-persisted).
// [{ id: peerId, ts }], most-recent first. There's no "recent DMs"
// concept on the backend today, so this just tracks conversations the
// current browser has opened or received a message in.
let recentChats = [];

// NEW: local message cache, used so search can actually find message
// text without a backend endpoint. Keyed by "channel:<id>" / "dm:<id>"
// -> Map(messageId -> { id, text, ts, from, fromName, channelId, dmPeerId }).
// This only covers conversations you've actually opened in this browser
// session (or before, if you've opened them earlier and they're still
// in the currently-loaded history) — it is NOT full server-side search
// across every message ever sent. See the /search API CONTRACT note
// near performGlobalSearch() for what real full-history search needs.
let messageCache = {};
function cacheMessage(scopeKey, msg, extra) {
  if (!messageCache[scopeKey]) messageCache[scopeKey] = new Map();
  messageCache[scopeKey].set(msg.id, {
    id: msg.id,
    text: msg.text || '',
    ts: msg.ts || Date.now(),
    from: msg.from,
    fromName: msg.fromName,
    ...extra,
  });
}

// NEW: search debounce
let globalSearchDebounce = null;

// Muted conversations — server-synced.
let mutedConvos = new Set();
function convKey(id, isChannel) {
  return (isChannel ? 'channel:' : 'dm:') + id;
}
async function loadMutedConvos() {
  try {
    const data = await api('/me/muted', { token: session.token });
    mutedConvos = new Set((data.muted || []).map((m) => convKey(m.id, m.type === 'channel')));
  } catch {
    mutedConvos = new Set();
  }
}
async function setMuted(id, isChannel, muted) {
  const key = convKey(id, isChannel);
  if (muted) mutedConvos.add(key); else mutedConvos.delete(key);
  updateMuteButton(id, isChannel);
  try {
    await api('/me/muted', {
      method: 'POST',
      token: session.token,
      body: { type: isChannel ? 'channel' : 'dm', id, muted },
    });
  } catch (e) {
    if (muted) mutedConvos.delete(key); else mutedConvos.add(key);
    updateMuteButton(id, isChannel);
    console.error('Failed to update mute state:', e.message);
  }
}
function updateMuteButton(id, isChannel) {
  if (!els['mute-btn']) return;
  const muted = mutedConvos.has(convKey(id, isChannel));
  els['mute-btn'].textContent = muted ? '🔕' : '🔔';
  els['mute-btn'].title = muted ? 'Unmute notifications' : 'Mute notifications';
  els['mute-btn'].dataset.convId = id;
  els['mute-btn'].dataset.isChannel = isChannel ? '1' : '';
}
function notifyIncoming(id, isChannel, title, body) {
  if (mutedConvos.has(convKey(id, isChannel))) return;
  const isOpenAndFocused = document.hasFocus()
    && ((isChannel && selectedChannelId === id) || (!isChannel && selectedPeerId === id));
  if (isOpenAndFocused) return;
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    new Notification(title, { body, icon: 'assets/logo.png' });
  } catch {
    // never let a notification failure break message rendering
  }
}

const GROUP_WINDOW_MS = 5 * 60 * 1000;

const els = {};
[
  'login-screen', 'login-form', 'login-username', 'login-password', 'login-submit', 'login-error',
  'pwd-modal', 'pwd-new', 'pwd-error', 'pwd-save',
  'app-screen', 'rail', 'chat-pane', 'me-avatar', 'me-name', 'leader-badge', 'open-avatar-modal',
  'top-tabs', 'chat-rail-lists',
  'global-search-input', 'search-results',
  'channels-list', 'roster-list', 'roster-search-input', 'admin-link', 'logout-btn',
  'settings-btn', 'settings-popover', 'settings-avatar-btn',
  'chat-empty', 'chat-active', 'chat-back-btn', 'peer-avatar', 'peer-name', 'status-dot', 'status-text',
  'mute-btn',
  'messages', 'composer-input', 'composer-send', 'composer-row', 'composer-error', 'composer-locked',
  'composer-file-input', 'composer-attach-btn', 'attachment-preview',
  'composer-gif-btn', 'gif-modal', 'gif-search-input', 'gif-grid', 'gif-error', 'gif-cancel',
  'reaction-picker', 'lightbox-modal', 'lightbox-image', 'lightbox-video', 'lightbox-close',
  'avatar-modal', 'preset-grid', 'upload-preview', 'upload-input', 'avatar-error', 'avatar-cancel',
  'tab-presets', 'tab-upload',
  'channel-modal', 'channel-name', 'channel-member-picker', 'channel-error', 'channel-cancel', 'channel-create',
  'manage-channel-modal', 'manage-channel-title', 'manage-channel-subhead', 'manage-channel-members',
  'manage-channel-add-select', 'manage-channel-add-btn', 'manage-channel-error', 'manage-channel-delete', 'manage-channel-close',
  'admin-screen', 'close-admin',
  'new-username', 'new-displayname', 'new-password', 'create-btn', 'create-error', 'user-list',
  'admin-new-channel', 'admin-channel-list', 'dm-thread-list',
  // NEW: calendar
  'calendar-view', 'calendar-back-btn', 'cal-prev', 'cal-next', 'cal-month-label', 'cal-new-event-btn',
  'calendar-dow-row', 'calendar-grid', 'cal-selected-day-label', 'cal-day-events',
  'event-modal', 'event-title', 'event-date', 'event-time', 'event-desc', 'event-error',
  'event-cancel', 'event-save',
  // NEW: news
  'news-view', 'news-back-btn', 'news-compose', 'news-title-input', 'news-body-input', 'news-pin-checkbox',
  'news-error', 'news-post-btn', 'news-feed',
].forEach((id) => (els[id] = document.getElementById(id)));

// ---------------------------------------------------------------------
// mobile list <-> chat navigation
// ---------------------------------------------------------------------
function openChatPaneMobile() {
  els['app-screen'].classList.add('chat-open');
}
function closeChatPaneMobile() {
  els['app-screen'].classList.remove('chat-open');
}
els['chat-back-btn'] && els['chat-back-btn'].addEventListener('click', closeChatPaneMobile);

// =======================================================================
// NEW: top tabs — Chat / Calendar / News
// =======================================================================
function switchTab(tab) {
  currentTab = tab;
  els['top-tabs'].querySelectorAll('.top-tab').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });

  els['chat-rail-lists'].classList.toggle('hidden', tab !== 'chat');
  els['chat-empty'].classList.toggle('hidden', tab !== 'chat' || selectedPeerId || selectedChannelId);
  els['chat-active'].classList.toggle('hidden', tab !== 'chat' || (!selectedPeerId && !selectedChannelId));
  els['calendar-view'].classList.toggle('hidden', tab !== 'calendar');
  els['news-view'].classList.toggle('hidden', tab !== 'news');

  closeSearchResults();

  // MOBILE FIX: below the mobile breakpoint, #app-screen only shows the
  // rail OR the main pane, switched by the "chat-open" class (see the
  // MOBILE NAV note at the top of this file). That class previously
  // only got added when a channel/DM was selected, so Calendar and News
  // rendered into a pane that was still hidden on phones — nothing
  // visibly showed up even though the DOM was populated correctly.
  // Calendar/News now count as "open" content too; Chat only opens the
  // pane once something is actually selected.
  if (tab === 'calendar' || tab === 'news') {
    openChatPaneMobile();
  } else if (!selectedPeerId && !selectedChannelId) {
    closeChatPaneMobile();
  }

  if (tab === 'calendar') {
    renderCalendarMonth();
  } else if (tab === 'news') {
    refreshNewsFeed();
  }
}
els['top-tabs'] && els['top-tabs'].addEventListener('click', (e) => {
  const btn = e.target.closest('.top-tab');
  if (btn) switchTab(btn.dataset.tab);
});
// Back buttons inside Calendar/News (mobile only — same chat-back-btn
// class as the chat header's back button, so it's hidden on desktop by
// whatever rule already hides that one). Going back just re-reveals the
// rail; the tab itself stays selected so re-opening it is one tap.
els['calendar-back-btn'] && els['calendar-back-btn'].addEventListener('click', closeChatPaneMobile);
els['news-back-btn'] && els['news-back-btn'].addEventListener('click', closeChatPaneMobile);

// =======================================================================
// NEW: Calendar
//
// API CONTRACT (backend not shown in this repo — add these routes to
// the Worker):
//   GET  /calendar/events?month=YYYY-MM   -> { events: [
//          { id, title, description, date: 'YYYY-MM-DD', time: 'HH:MM'|null,
//            createdBy, createdByName } ] }
//   POST /calendar/events   (admin only)  body: { title, description, date, time }
//        -> { event: {...} }
//   DELETE /calendar/events/:id  (admin only)
//
// Deleting/creating should broadcast so other open sessions refresh —
// simplest is to just re-fetch on open; real-time push can ride the
// existing websocket ('calendar_event' message type) later if wanted.
// =======================================================================
function ymd(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
function monthKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

async function loadCalendarEvents(monthDate) {
  try {
    const data = await api(`/calendar/events?month=${monthKey(monthDate)}`, { token: session.token });
    calendarEventsByDate = {};
    for (const ev of data.events || []) {
      (calendarEventsByDate[ev.date] ||= []).push(ev);
    }
  } catch (e) {
    calendarEventsByDate = {};
    console.error('Could not load calendar events:', e.message);
  }
}

async function renderCalendarMonth() {
  const isAdmin = session.user.role === 'admin';
  els['cal-new-event-btn'].classList.toggle('hidden', !isAdmin);

  const label = calendarCursor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  els['cal-month-label'].textContent = label;

  await loadCalendarEvents(calendarCursor);

  const dow = els['calendar-dow-row'];
  dow.innerHTML = '';
  dow.style.marginBottom = '2px';
  for (const d of ['S', 'M', 'T', 'W', 'T', 'F', 'S']) {
    const cell = document.createElement('div');
    cell.className = 'calendar-dow';
    cell.textContent = d;
    dow.appendChild(cell);
  }

  const grid = els['calendar-grid'];
  grid.innerHTML = '';

  const year = calendarCursor.getFullYear();
  const month = calendarCursor.getMonth();
  const firstOfMonth = new Date(year, month, 1);
  const startOffset = firstOfMonth.getDay(); // 0=Sun
  const gridStart = new Date(year, month, 1 - startOffset);
  const todayKey = ymd(new Date());

  if (!calendarSelectedDate) calendarSelectedDate = todayKey;

  for (let i = 0; i < 42; i++) {
    const cellDate = new Date(gridStart);
    cellDate.setDate(gridStart.getDate() + i);
    const key = ymd(cellDate);
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'calendar-day';
    if (cellDate.getMonth() !== month) cell.classList.add('other-month');
    if (key === todayKey) cell.classList.add('today');
    if (key === calendarSelectedDate) cell.classList.add('selected');

    const num = document.createElement('span');
    num.className = 'day-num';
    num.textContent = String(cellDate.getDate());
    cell.appendChild(num);

    const dayEvents = calendarEventsByDate[key] || [];
    if (dayEvents.length > 0) {
      const dotRow = document.createElement('div');
      dotRow.className = 'day-dot-row';
      for (let d = 0; d < Math.min(dayEvents.length, 4); d++) {
        const dot = document.createElement('span');
        dot.className = 'day-dot';
        dotRow.appendChild(dot);
      }
      cell.appendChild(dotRow);
    }

    cell.addEventListener('click', () => {
      calendarSelectedDate = key;
      renderCalendarMonth();
    });
    grid.appendChild(cell);
  }

  renderSelectedDayEvents();
}

function renderSelectedDayEvents() {
  const key = calendarSelectedDate;
  const dateObj = new Date(`${key}T00:00:00`);
  els['cal-selected-day-label'].textContent = dateObj.toLocaleDateString(undefined, {
    weekday: 'long', month: 'long', day: 'numeric',
  });

  const isAdmin = session.user.role === 'admin';
  const container = els['cal-day-events'];
  container.innerHTML = '';
  const dayEvents = (calendarEventsByDate[key] || []).slice().sort((a, b) => (a.time || '').localeCompare(b.time || ''));

  if (dayEvents.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'roster-empty';
    empty.textContent = 'No events on this day.';
    container.appendChild(empty);
    return;
  }

  for (const ev of dayEvents) {
    const row = document.createElement('div');
    row.className = 'event-item';
    const time = document.createElement('div');
    time.className = 'event-time';
    time.textContent = ev.time || 'All day';
    const body = document.createElement('div');
    body.className = 'event-body';
    const title = document.createElement('div');
    title.className = 'event-title';
    title.textContent = ev.title;
    body.appendChild(title);
    if (ev.description) {
      const desc = document.createElement('div');
      desc.className = 'event-desc';
      desc.textContent = ev.description;
      body.appendChild(desc);
    }
    row.appendChild(time);
    row.appendChild(body);
    if (isAdmin) {
      const del = document.createElement('button');
      del.className = 'event-remove';
      del.type = 'button';
      del.title = 'Delete event';
      del.textContent = '✕';
      del.addEventListener('click', () => deleteCalendarEvent(ev.id));
      row.appendChild(del);
    }
    container.appendChild(row);
  }
}

async function deleteCalendarEvent(eventId) {
  if (!confirm('Delete this event?')) return;
  try {
    await api(`/calendar/events/${encodeURIComponent(eventId)}`, { method: 'DELETE', token: session.token });
    await renderCalendarMonth();
  } catch (e) {
    alert(e.message);
  }
}

function openEventModal() {
  els['event-error'].textContent = '';
  els['event-title'].value = '';
  els['event-date'].value = calendarSelectedDate || ymd(new Date());
  els['event-time'].value = '';
  els['event-desc'].value = '';
  els['event-modal'].classList.remove('hidden');
}
els['cal-new-event-btn'] && els['cal-new-event-btn'].addEventListener('click', openEventModal);
els['event-cancel'] && els['event-cancel'].addEventListener('click', () => els['event-modal'].classList.add('hidden'));
els['event-save'] && els['event-save'].addEventListener('click', async () => {
  els['event-error'].textContent = '';
  const title = els['event-title'].value.trim();
  const date = els['event-date'].value;
  if (!title || !date) {
    els['event-error'].textContent = 'Title and date are required.';
    return;
  }
  try {
    await api('/calendar/events', {
      method: 'POST',
      token: session.token,
      body: {
        title,
        date,
        time: els['event-time'].value || null,
        description: els['event-desc'].value.trim() || null,
      },
    });
    els['event-modal'].classList.add('hidden');
    calendarSelectedDate = date;
    await renderCalendarMonth();
  } catch (e) {
    els['event-error'].textContent = e.message;
  }
});
els['cal-prev'] && els['cal-prev'].addEventListener('click', () => {
  calendarCursor = new Date(calendarCursor.getFullYear(), calendarCursor.getMonth() - 1, 1);
  renderCalendarMonth();
});
els['cal-next'] && els['cal-next'].addEventListener('click', () => {
  calendarCursor = new Date(calendarCursor.getFullYear(), calendarCursor.getMonth() + 1, 1);
  renderCalendarMonth();
});

// =======================================================================
// NEW: News / announcements feed
//
// API CONTRACT (backend not shown in this repo — add these routes):
//   GET  /news                     -> { posts: [
//          { id, title, body, authorId, authorName, ts, pinned } ] }
//   POST /news   (admin only)      body: { title, body, pinned }
//   DELETE /news/:id  (admin only)
// =======================================================================
async function refreshNewsFeed() {
  const isAdmin = session.user.role === 'admin';
  els['news-compose'].classList.toggle('hidden', !isAdmin);

  els['news-feed'].innerHTML = '<p class="roster-empty">Loading…</p>';
  try {
    const data = await api('/news', { token: session.token });
    newsPosts = (data.posts || []).slice().sort((a, b) => {
      if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
      return (b.ts || 0) - (a.ts || 0);
    });
  } catch (e) {
    els['news-feed'].innerHTML = `<p class="roster-empty">Could not load news: ${e.message}</p>`;
    return;
  }
  renderNewsFeed();
}

function renderNewsFeed() {
  const container = els['news-feed'];
  container.innerHTML = '';
  if (newsPosts.length === 0) {
    container.innerHTML = '<p class="roster-empty">No news posted yet.</p>';
    return;
  }
  const isAdmin = session.user.role === 'admin';
  for (const post of newsPosts) {
    const card = document.createElement('div');
    card.className = 'news-post' + (post.pinned ? ' pinned' : '');
    const head = document.createElement('div');
    head.className = 'news-post-head';
    if (post.pinned) {
      const tag = document.createElement('span');
      tag.className = 'news-pin-tag';
      tag.textContent = 'Pinned';
      head.appendChild(tag);
    }
    const title = document.createElement('span');
    title.className = 'news-post-title';
    title.textContent = post.title;
    head.appendChild(title);
    const meta = document.createElement('span');
    meta.className = 'news-post-meta';
    meta.textContent = `${post.authorName || post.authorId} · ${new Date(post.ts).toLocaleString()}`;
    head.appendChild(meta);
    card.appendChild(head);

    const body = document.createElement('div');
    body.className = 'news-post-body';
    body.textContent = post.body;
    card.appendChild(body);

    if (isAdmin) {
      const del = document.createElement('button');
      del.className = 'event-remove';
      del.type = 'button';
      del.textContent = 'Delete post';
      del.style.marginTop = '8px';
      del.addEventListener('click', () => deleteNewsPost(post.id));
      card.appendChild(del);
    }
    container.appendChild(card);
  }
}

async function deleteNewsPost(postId) {
  if (!confirm('Delete this news post?')) return;
  try {
    await api(`/news/${encodeURIComponent(postId)}`, { method: 'DELETE', token: session.token });
    await refreshNewsFeed();
  } catch (e) {
    alert(e.message);
  }
}

els['news-post-btn'] && els['news-post-btn'].addEventListener('click', async () => {
  els['news-error'].textContent = '';
  const title = els['news-title-input'].value.trim();
  const body = els['news-body-input'].value.trim();
  if (!title || !body) {
    els['news-error'].textContent = 'Headline and body are both required.';
    return;
  }
  try {
    await api('/news', {
      method: 'POST',
      token: session.token,
      body: { title, body, pinned: !!els['news-pin-checkbox'].checked },
    });
    els['news-title-input'].value = '';
    els['news-body-input'].value = '';
    els['news-pin-checkbox'].checked = false;
    await refreshNewsFeed();
  } catch (e) {
    els['news-error'].textContent = e.message;
  }
});

// =======================================================================
// NEW: Global search (Teams-style "Search or type a command")
//
// Channels and members are matched client-side against data already
// loaded (roster/channels). Message hits require a server endpoint —
// GET /search?q=... -> { messages: [
//   { id, text, ts, from, fromName, channelId, channelName, dmPeerId, dmPeerName } ] }
// If that endpoint 404s or errors, search still works for people and
// channels; the Messages section is just quietly omitted.
// =======================================================================
// =======================================================================
// NEW: Global search (Teams-style "Search or type a command")
//
// Channels and members are matched client-side against roster/channels
// already loaded. Messages are matched two ways:
//   1) Client-side, against messageCache (see cacheMessage()) — this
//      only covers conversations already opened in this browser, so it
//      is NOT full history search.
//   2) Server-side, via GET /search?q=... -> { messages: [
//      { id, text, ts, from, fromName, channelId, channelName, dmPeerId, dmPeerName } ] }
//      This is what actually searches "everything on the site" —
//      every message ever sent, not just what's been loaded locally.
//      THIS ROUTE DOES NOT EXIST ON THE BACKEND YET, so today search
//      quietly falls back to client-cache-only results. Add it to your
//      Worker (same auth/shape as your other endpoints — likely a LIKE
//      query over your messages table, scoped to channels the caller is
//      in plus DMs they're a participant of, or unrestricted for admins)
//      and full-site message search will start working with no
//      frontend changes needed.
// =======================================================================
function searchMessageCache(query) {
  const q = query.toLowerCase();
  const hits = [];
  for (const scopeKey of Object.keys(messageCache)) {
    for (const entry of messageCache[scopeKey].values()) {
      if (entry.text && entry.text.toLowerCase().includes(q)) hits.push(entry);
    }
  }
  hits.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  return hits;
}

function closeSearchResults() {
  els['search-results'] && els['search-results'].classList.add('hidden');
}

function addSearchSection(container, label) {
  const el = document.createElement('div');
  el.className = 'search-section-label';
  el.textContent = label;
  container.appendChild(el);
}

function addSearchRow(container, { icon, primary, secondary, onClick }) {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'search-result-row';
  const iconEl = document.createElement('span');
  iconEl.textContent = icon;
  const label = document.createElement('span');
  label.textContent = primary;
  row.appendChild(iconEl);
  row.appendChild(label);
  if (secondary) {
    const sub = document.createElement('span');
    sub.className = 'search-result-sub';
    sub.textContent = secondary;
    row.appendChild(sub);
  }
  row.addEventListener('click', onClick);
  container.appendChild(row);
}

async function performGlobalSearch(query) {
  const container = els['search-results'];
  container.innerHTML = '';
  container.classList.remove('hidden');

  const q = query.trim().toLowerCase();
  if (!q) {
    container.classList.add('hidden');
    return;
  }

  const matchingChannels = channels.filter((c) => c.name.toLowerCase().includes(q));
  const matchingMembers = roster.filter(
    (m) => m.displayName.toLowerCase().includes(q) || m.id.toLowerCase().includes(q)
  );

  let matchingMessages = searchMessageCache(q);
  try {
    const data = await api(`/search?q=${encodeURIComponent(query.trim())}`, { token: session.token });
    const serverHits = data.messages || [];
    const seen = new Set(matchingMessages.map((m) => m.id));
    for (const hit of serverHits) {
      if (!seen.has(hit.id)) {
        matchingMessages.push(hit);
        seen.add(hit.id);
      }
    }
    matchingMessages.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  } catch {
    // /search doesn't exist on the backend yet — matchingMessages just
    // stays as whatever the local cache found. See API CONTRACT note above.
  }

  if (matchingChannels.length === 0 && matchingMembers.length === 0 && matchingMessages.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'search-empty';
    empty.textContent = `No results for "${query.trim()}".`;
    container.appendChild(empty);
    return;
  }

  if (matchingChannels.length > 0) {
    addSearchSection(container, 'Channels');
    for (const ch of matchingChannels.slice(0, 6)) {
      addSearchRow(container, {
        icon: channelIcon(ch.type),
        primary: ch.name,
        secondary: `${ch.memberCount || ''}`.trim(),
        onClick: () => {
          switchTab('chat');
          selectChannel(ch.id);
          clearSearchBox();
        },
      });
    }
  }

  if (matchingMembers.length > 0) {
    addSearchSection(container, 'People');
    for (const m of matchingMembers.slice(0, 6)) {
      addSearchRow(container, {
        icon: '👤',
        primary: m.displayName,
        secondary: `@${m.id}`,
        onClick: () => {
          switchTab('chat');
          selectPeer(m.id);
          clearSearchBox();
        },
      });
    }
  }

  if (matchingMessages.length > 0) {
    addSearchSection(container, 'Messages');
    for (const msg of matchingMessages.slice(0, 8)) {
      const where = msg.channelId ? (msg.channelName || msg.channelId) : (msg.dmPeerName || msg.dmPeerId);
      addSearchRow(container, {
        icon: '💬',
        primary: msg.text && msg.text.length > 60 ? `${msg.text.slice(0, 60)}…` : (msg.text || '(attachment)'),
        secondary: where,
        onClick: () => {
          switchTab('chat');
          if (msg.channelId) selectChannel(msg.channelId);
          else if (msg.dmPeerId) selectPeer(msg.dmPeerId);
          clearSearchBox();
        },
      });
    }
    const note = document.createElement('div');
    note.className = 'search-empty';
    note.style.fontSize = '11px';
    note.textContent = 'Message results are limited to conversations you\u2019ve opened before.';
    container.appendChild(note);
  }
}

function clearSearchBox() {
  if (els['global-search-input']) els['global-search-input'].value = '';
  closeSearchResults();
}

els['global-search-input'] && els['global-search-input'].addEventListener('input', (e) => {
  clearTimeout(globalSearchDebounce);
  const q = e.target.value;
  globalSearchDebounce = setTimeout(() => performGlobalSearch(q), 250);
});
els['global-search-input'] && els['global-search-input'].addEventListener('focus', (e) => {
  if (e.target.value.trim()) performGlobalSearch(e.target.value);
});
document.addEventListener('click', (e) => {
  const box = els['search-results'];
  if (!box || box.classList.contains('hidden')) return;
  if (!box.contains(e.target) && e.target !== els['global-search-input']) closeSearchResults();
});

// ---------------------------------------------------------------------
// avatar rendering
// ---------------------------------------------------------------------
async function getAvatarBlobUrl(userId) {
  if (avatarBlobCache.has(userId)) return avatarBlobCache.get(userId);
  try {
    const res = await fetch(`${SERVER_URL}/avatar-image/${encodeURIComponent(userId)}`, {
      headers: { Authorization: `Bearer ${session.token}` },
    });
    if (!res.ok) return null;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    avatarBlobCache.set(userId, url);
    return url;
  } catch {
    return null;
  }
}

function invalidateAvatarCache(userId) {
  const existing = avatarBlobCache.get(userId);
  if (existing) URL.revokeObjectURL(existing);
  avatarBlobCache.delete(userId);
}

function renderAvatar(container, userId, avatar, displayName) {
  container.innerHTML = '';
  container.classList.remove('channel-icon');
  if (avatar && avatar.type === 'preset' && presetsById[avatar.value]) {
    const p = presetsById[avatar.value];
    container.style.background = 'var(--panel-raised)';
    const img = document.createElement('img');
    img.src = p.image;
    container.appendChild(img);
    return;
  }
  if (avatar && avatar.type === 'upload') {
    container.style.background = 'var(--panel-raised)';
    container.textContent = '';
    const img = document.createElement('img');
    getAvatarBlobUrl(userId).then((url) => {
      if (url) img.src = url;
    });
    container.appendChild(img);
    return;
  }
  container.style.background = 'var(--panel-raised)';
  container.textContent = (displayName || '?').trim().slice(0, 1).toUpperCase();
}

// ---------------------------------------------------------------------
// files: upload, fetching, and rendering
// ---------------------------------------------------------------------
function formatFileSize(bytes) {
  if (!bytes && bytes !== 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
function fileKindFromMime(mime) {
  if (!mime) return 'file';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  return 'file';
}

async function getChannelFileBlobUrl(storageKey) {
  if (fileBlobCache.has(storageKey)) return fileBlobCache.get(storageKey);
  const res = await fetch(`${SERVER_URL}/files/${encodeURIComponent(storageKey)}`, {
    headers: { Authorization: `Bearer ${session.token}` },
  });
  if (!res.ok) throw new Error('Could not load attachment.');
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  fileBlobCache.set(storageKey, url);
  return url;
}

async function uploadChannelFile(channelId, file) {
  const buf = await file.arrayBuffer();
  return api(`/channels/${encodeURIComponent(channelId)}/upload`, {
    method: 'POST',
    token: session.token,
    rawBody: buf,
    contentType: file.type || 'application/octet-stream',
    headers: { 'X-Filename': encodeURIComponent(file.name) },
  });
}
async function uploadDmFile(peerId, file) {
  const buf = await file.arrayBuffer();
  return api(`/dm/${encodeURIComponent(peerId)}/upload`, {
    method: 'POST',
    token: session.token,
    rawBody: buf,
    contentType: file.type || 'application/octet-stream',
    headers: { 'X-Filename': encodeURIComponent(file.name) },
  });
}

async function resolveAttachmentUrl(attachment) {
  if (attachment.gifUrl) return attachment.gifUrl;
  if (attachment.localUrl) return attachment.localUrl;
  return getChannelFileBlobUrl(attachment.key);
}

function renderAttachmentInto(container, attachment) {
  const tpl = document.getElementById('attachment-bubble-template');
  const node = tpl.content.firstElementChild.cloneNode(true);
  const kind = fileKindFromMime(attachment.mime);
  node.dataset.kind = kind;

  const imageLink = node.querySelector('.attachment-image-link');
  const imageEl = node.querySelector('.attachment-image');
  const fileBox = node.querySelector('.attachment-file');
  const fileIcon = node.querySelector('.attachment-file-icon');
  const fileNameEl = node.querySelector('.attachment-file-name');
  const fileSizeEl = node.querySelector('.attachment-file-size');
  const downloadLink = node.querySelector('.attachment-download-link');
  const audioEl = node.querySelector('.attachment-audio');
  const videoEl = node.querySelector('.attachment-video');

  fileNameEl.textContent = attachment.filename || 'file';
  fileSizeEl.textContent = formatFileSize(attachment.size);
  fileIcon.textContent = kind === 'audio' ? '🎵' : kind === 'video' ? '🎬' : kind === 'image' ? '🖼️' : '📄';
  fileBox.classList.remove('hidden');
  container.appendChild(node);

  resolveAttachmentUrl(attachment)
    .then((url) => {
      downloadLink.href = url;
      downloadLink.setAttribute('download', attachment.filename || 'file');
      if (kind === 'image') {
        imageEl.src = url;
        imageEl.alt = attachment.filename || '';
        imageEl.classList.remove('hidden');
        fileBox.classList.add('hidden');
        imageLink.addEventListener('click', (e) => {
          e.preventDefault();
          openLightbox('image', url);
        });
      } else if (kind === 'audio') {
        audioEl.src = url;
        audioEl.classList.remove('hidden');
        fileBox.classList.add('hidden');
      } else if (kind === 'video') {
        videoEl.src = url;
        videoEl.classList.remove('hidden');
        fileBox.classList.add('hidden');
        videoEl.addEventListener('click', () => openLightbox('video', url));
      }
    })
    .catch((err) => {
      fileNameEl.textContent = `${attachment.filename || 'file'} (failed to load: ${err.message})`;
    });
}

function openLightbox(kind, url) {
  els['lightbox-image'].classList.add('hidden');
  els['lightbox-video'].classList.add('hidden');
  els['lightbox-video'].pause();
  if (kind === 'image') {
    els['lightbox-image'].src = url;
    els['lightbox-image'].classList.remove('hidden');
  } else {
    els['lightbox-video'].src = url;
    els['lightbox-video'].classList.remove('hidden');
  }
  els['lightbox-modal'].classList.remove('hidden');
}
function closeLightbox() {
  els['lightbox-modal'].classList.add('hidden');
  els['lightbox-video'].pause();
  els['lightbox-video'].removeAttribute('src');
  els['lightbox-image'].removeAttribute('src');
}
els['lightbox-close'] && els['lightbox-close'].addEventListener('click', closeLightbox);
els['lightbox-modal'] && els['lightbox-modal'].addEventListener('click', (e) => {
  if (e.target === els['lightbox-modal']) closeLightbox();
});

// ---------------------------------------------------------------------
// composer attachment picker
// ---------------------------------------------------------------------
function updateSendButtonState() {
  const hasText = els['composer-input'].value.trim().length > 0;
  const hasFiles = pendingFiles.length > 0;
  els['composer-send'].classList.toggle('active', hasText || hasFiles);
}

function renderAttachmentPreviewStrip() {
  const container = els['attachment-preview'];
  container.innerHTML = '';
  if (pendingFiles.length === 0) {
    container.classList.add('hidden');
  } else {
    container.classList.remove('hidden');
    pendingFiles.forEach((file, idx) => {
      const chip = document.createElement('div');
      chip.className = 'attachment-preview-chip';
      const label = document.createElement('span');
      label.textContent = `${file.name} (${formatFileSize(file.size)})`;
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'icon-btn';
      removeBtn.title = 'Remove';
      removeBtn.textContent = '✕';
      removeBtn.addEventListener('click', () => {
        pendingFiles.splice(idx, 1);
        renderAttachmentPreviewStrip();
      });
      chip.appendChild(label);
      chip.appendChild(removeBtn);
      container.appendChild(chip);
    });
  }
  updateSendButtonState();
}
function clearPendingFiles() {
  pendingFiles = [];
  renderAttachmentPreviewStrip();
  if (els['composer-file-input']) els['composer-file-input'].value = '';
}
els['composer-attach-btn'] && els['composer-attach-btn'].addEventListener('click', () => {
  els['composer-file-input'].click();
});
els['composer-file-input'] && els['composer-file-input'].addEventListener('change', (e) => {
  const files = Array.from(e.target.files || []);
  const tooBig = files.find((f) => f.size > MAX_ATTACHMENT_BYTES);
  if (tooBig) {
    els['composer-error'].textContent = `${tooBig.name} is over the 20MB limit.`;
  }
  pendingFiles = pendingFiles.concat(files.filter((f) => f.size <= MAX_ATTACHMENT_BYTES));
  renderAttachmentPreviewStrip();
});

// ---------------------------------------------------------------------
// GIFs (GIPHY)
// ---------------------------------------------------------------------
function openGifModal() {
  if (!selectedPeerId && !selectedChannelId) return;
  els['gif-error'].textContent = '';
  els['gif-search-input'].value = '';
  els['gif-grid'].innerHTML = '';
  els['gif-modal'].classList.remove('hidden');
  els['gif-search-input'].focus();
  searchGifs('');
}

async function searchGifs(query) {
  els['gif-error'].textContent = '';
  els['gif-grid'].innerHTML = '<p class="roster-empty">Loading…</p>';
  const endpoint = query
    ? `https://api.giphy.com/v1/gifs/search?api_key=${GIPHY_API_KEY}&q=${encodeURIComponent(query)}&limit=24&rating=pg-13`
    : `https://api.giphy.com/v1/gifs/trending?api_key=${GIPHY_API_KEY}&limit=24&rating=pg-13`;
  try {
    const res = await fetch(endpoint);
    const data = await res.json();
    els['gif-grid'].innerHTML = '';
    if (!data.data || data.data.length === 0) {
      els['gif-grid'].innerHTML = '<p class="roster-empty">No results.</p>';
      return;
    }
    for (const gif of data.data) {
      const thumb = gif.images.fixed_width_small || gif.images.fixed_width;
      const full = gif.images.fixed_width || gif.images.original;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'gif-choice';
      const img = document.createElement('img');
      img.src = thumb.url;
      img.alt = gif.title || 'GIF';
      btn.appendChild(img);
      btn.addEventListener('click', () => sendGif({ url: full.url, title: gif.title }));
      els['gif-grid'].appendChild(btn);
    }
  } catch {
    els['gif-error'].textContent = 'Could not load GIFs.';
  }
}

els['gif-search-input'] && els['gif-search-input'].addEventListener('input', (e) => {
  clearTimeout(gifSearchDebounce);
  const q = e.target.value.trim();
  gifSearchDebounce = setTimeout(() => searchGifs(q), 350);
});
els['gif-cancel'] && els['gif-cancel'].addEventListener('click', () => els['gif-modal'].classList.add('hidden'));
els['composer-gif-btn'] && els['composer-gif-btn'].addEventListener('click', openGifModal);

async function sendGif({ url, title }) {
  if (!selectedChannelId && !selectedPeerId) {
    els['gif-modal'].classList.add('hidden');
    return;
  }
  els['gif-error'].textContent = '';
  const choices = els['gif-grid'].querySelectorAll('.gif-choice');
  choices.forEach((b) => { b.disabled = true; });
  try {
    // Route the GIF through the same upload pipeline regular attachments
    // use (fetch the bytes, POST to /upload, send the returned key) rather
    // than sending an ad-hoc { gifUrl } attachment straight over the
    // socket — that shape isn't produced anywhere else in the app, so if
    // the server only validates attachments coming out of /upload, a raw
    // gifUrl message can get silently dropped. This way a sent GIF is
    // indistinguishable, server-side, from any other image attachment.
    const res = await fetch(url);
    if (!res.ok) throw new Error('Could not download that GIF.');
    const blob = await res.blob();
    const safeName = (title || 'gif').replace(/[^a-z0-9-_]+/gi, '_').slice(0, 60) || 'gif';
    const file = new File([blob], `${safeName}.gif`, { type: blob.type || 'image/gif' });

    const uploaded = selectedChannelId
      ? await uploadChannelFile(selectedChannelId, file)
      : await uploadDmFile(selectedPeerId, file);

    els['gif-modal'].classList.add('hidden');
    if (selectedChannelId) {
      sendChannelMessage(selectedChannelId, '', uploaded);
    } else {
      sendDmMessage(selectedPeerId, '', uploaded);
    }
  } catch (e) {
    els['gif-error'].textContent = `Failed to send GIF: ${e.message}`;
  } finally {
    choices.forEach((b) => { b.disabled = false; });
  }
}

// ---------------------------------------------------------------------
// reactions (channels only)
// ---------------------------------------------------------------------
function renderReactionsInto(container, reactions, channelId, messageId) {
  container.innerHTML = '';
  const emojis = Object.keys(reactions || {}).filter((e) => reactions[e] && reactions[e].length > 0);
  container.classList.toggle('hidden', emojis.length === 0);
  for (const emoji of emojis) {
    const users = reactions[emoji];
    const tpl = document.getElementById('reaction-pill-template');
    const pill = tpl.content.firstElementChild.cloneNode(true);
    pill.dataset.emoji = emoji;
    pill.querySelector('.reaction-emoji').textContent = emoji;
    pill.querySelector('.reaction-count').textContent = String(users.length);
    if (users.includes(session.user.id)) pill.classList.add('mine-reaction');
    pill.addEventListener('click', () => sendReaction(channelId, messageId, emoji));
    container.appendChild(pill);
  }
}
function sendReaction(channelId, messageId, emoji) {
  if (!socket || socket.readyState !== 1) return;
  socket.send(JSON.stringify({ type: 'room_react', channelId, messageId, emoji }));
}
async function openReactionPicker(anchorEl, channelId, messageId) {
  await ensureEmojiPicker();
  reactionPickerCtx = { channelId, messageId };
  const picker = els['reaction-picker'];
  const margin = 10;

  picker.style.visibility = 'hidden';
  picker.classList.remove('hidden');
  picker.style.position = 'fixed';
  picker.style.top = '0px';
  picker.style.left = '0px';

  const anchorRect = anchorEl.getBoundingClientRect();
  const pickerRect = picker.getBoundingClientRect();

  let top = anchorRect.bottom + 6;
  if (top + pickerRect.height + margin > window.innerHeight) {
    top = anchorRect.top - pickerRect.height - 6;
  }
  top = Math.max(margin, Math.min(top, window.innerHeight - pickerRect.height - margin));

  let left = anchorRect.left + anchorRect.width / 2 - pickerRect.width / 2;
  left = Math.max(margin, Math.min(left, window.innerWidth - pickerRect.width - margin));

  picker.style.top = `${top}px`;
  picker.style.left = `${left}px`;
  picker.style.visibility = '';
}
function closeReactionPicker() {
  reactionPickerCtx = null;
  els['reaction-picker'] && els['reaction-picker'].classList.add('hidden');
}
document.addEventListener('click', (e) => {
  const picker = els['reaction-picker'];
  if (!picker || picker.classList.contains('hidden')) return;
  if (!picker.contains(e.target) && !e.target.closest('.message-react-btn')) closeReactionPicker();
});
const emojiPickerEl = document.getElementById('emoji-picker-el');
emojiPickerEl && emojiPickerEl.addEventListener('emoji-click', (e) => {
  const emoji = e.detail.unicode;
  if (reactionPickerCtx && emoji) sendReaction(reactionPickerCtx.channelId, reactionPickerCtx.messageId, emoji);
  closeReactionPicker();
});

// ---------------------------------------------------------------------
// translate
// ---------------------------------------------------------------------
async function translateText(text, targetLang) {
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(targetLang)}&dt=t&q=${encodeURIComponent(text)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Translation service unavailable.');
  const data = await res.json();
  return (data[0] || []).map((chunk) => chunk[0]).join('');
}

function targetLanguage() {
  return (navigator.language || 'en').split('-')[0];
}

async function toggleTranslate(node, originalText, translateBtn) {
  const existing = node.querySelector('.message-translation');
  if (existing) {
    existing.remove();
    translateBtn.textContent = '🌐';
    translateBtn.title = 'Translate';
    return;
  }
  translateBtn.textContent = '…';
  translateBtn.disabled = true;
  try {
    const translated = await translateText(originalText, targetLanguage());
    const box = document.createElement('div');
    box.className = 'message-translation';
    box.textContent = translated;
    const bubbleWrap = node.querySelector('.message-bubble');
    bubbleWrap.appendChild(box);
    translateBtn.textContent = '↺';
    translateBtn.title = 'Show original';
  } catch (e) {
    const box = document.createElement('div');
    box.className = 'message-translation error';
    box.textContent = `Couldn't translate: ${e.message}`;
    node.querySelector('.message-bubble').appendChild(box);
  } finally {
    translateBtn.disabled = false;
  }
}

// ---------------------------------------------------------------------
// message rendering
// ---------------------------------------------------------------------
function shouldGroupWithPrevious(fromId, ts) {
  const container = els['messages'];
  const last = container.lastElementChild;
  if (!last || !last.classList || !last.classList.contains('message')) return false;
  if (last.dataset.from !== fromId) return false;
  const lastTs = Number(last.dataset.ts || 0);
  const curTs = Number(ts || Date.now());
  return Math.abs(curTs - lastTs) < GROUP_WINDOW_MS;
}

function renderMessage(msg, kind, scopeId, isChannel) {
  const tpl = document.getElementById('message-template');
  const node = tpl.content.firstElementChild.cloneNode(true);
  node.dataset.messageId = msg.id;
  node.dataset.from = msg.from;
  node.classList.add(kind);

  if (shouldGroupWithPrevious(msg.from, msg.ts)) node.classList.add('grouped');
  node.dataset.ts = String(msg.ts || Date.now());

  const avatarEl = node.querySelector('.message-avatar');
  const authorEl = node.querySelector('.message-author');
  const timeEl = node.querySelector('.message-time');
  const textEl = node.querySelector('.message-text');
  const attachmentsEl = node.querySelector('.message-attachments');
  const reactionsEl = node.querySelector('.message-reactions');
  const reactBtn = node.querySelector('.message-react-btn');
  const heartBtn = node.querySelector('.message-heart-btn');
  const translateBtn = node.querySelector('.message-translate-btn');

  if (kind === 'mine') {
    renderAvatar(avatarEl, session.user.id, session.user.avatar, session.user.displayName);
    authorEl.textContent = 'You';
  } else {
    const member = roster.find((m) => m.id === msg.from);
    renderAvatar(avatarEl, msg.from, member ? member.avatar : null, msg.fromName || (member && member.displayName));
    authorEl.textContent = msg.fromName || (member && member.displayName) || msg.from;
  }
  timeEl.textContent = new Date(msg.ts || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  if (msg.text) {
    textEl.textContent = msg.text;
    if (translateBtn) {
      translateBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleTranslate(node, msg.text, translateBtn);
      });
    }
  } else {
    textEl.classList.add('hidden');
    if (translateBtn) translateBtn.remove();
  }

  if (msg.attachment) renderAttachmentInto(attachmentsEl, msg.attachment, isChannel);

  if (isChannel) {
    renderReactionsInto(reactionsEl, msg.reactions || {}, scopeId, msg.id);
    reactBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openReactionPicker(reactBtn, scopeId, msg.id);
    });
    heartBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      sendReaction(scopeId, msg.id, '❤️');
    });
    node.querySelector('.message-bubble').addEventListener('dblclick', () => sendReaction(scopeId, msg.id, '❤️'));
  } else {
    reactionsEl.classList.add('hidden');
    reactBtn.remove();
    heartBtn.remove();
  }

  els['messages'].appendChild(node);
  els['messages'].scrollTop = els['messages'].scrollHeight;

  if (isChannel) {
    if (!channelMessageEls[scopeId]) channelMessageEls[scopeId] = new Map();
    channelMessageEls[scopeId].set(msg.id, { el: node, reactions: msg.reactions || {} });
  }
  return node;
}

// ---------------------------------------------------------------------
// roster + recent chats
//
// The "MEMBERS" list used to only render when a (now-removed) search
// box had text in it, so in practice it always sat empty — that's the
// blank space under Chat you were seeing. It's now a "RECENT CHATS"
// list instead, Teams/Telegram-style: whoever you've opened a DM with
// or gotten a DM from recently, most-recent first. Finding *new*
// people to message is what the global search bar at the top is for.
//
// This is tracked client-side (per browser, per account) in
// localStorage — there's no "recent DMs" concept on the backend, so a
// second device won't share this list until/unless that's added
// server-side.
// ---------------------------------------------------------------------
async function loadRoster() {
  const data = await api('/roster', { token: session.token });
  roster = data.roster;
  presetsById = Object.fromEntries(data.presets.map((p) => [p.id, p]));
  renderRoster();
  buildPresetGrid();
}

function recentChatsStorageKey() {
  return `lvo_recent_chats_${session.user.id}`;
}
function loadRecentChatsFromStorage() {
  try {
    recentChats = JSON.parse(localStorage.getItem(recentChatsStorageKey()) || '[]');
  } catch {
    recentChats = [];
  }
}
function saveRecentChatsToStorage() {
  try {
    localStorage.setItem(recentChatsStorageKey(), JSON.stringify(recentChats));
  } catch {
    // storage full/unavailable — recent chats just won't persist this session
  }
}
function touchRecentChat(peerId) {
  if (!peerId) return;
  recentChats = recentChats.filter((r) => r.id !== peerId);
  recentChats.unshift({ id: peerId, ts: Date.now() });
  recentChats = recentChats.slice(0, 20);
  saveRecentChatsToStorage();
  renderRoster();
}

function renderRoster() {
  const container = els['roster-list'];
  container.innerHTML = '';
  container.classList.remove('hidden');

  const entries = recentChats
    .map((r) => roster.find((m) => m.id === r.id))
    .filter(Boolean);

  if (entries.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'roster-empty';
    empty.textContent = 'No recent chats yet — search above to message someone.';
    container.appendChild(empty);
    return;
  }

  for (const member of entries) {
    const btn = document.createElement('button');
    btn.className = 'roster-item' + (member.id === selectedPeerId && !selectedChannelId ? ' active' : '');
    const avatarEl = document.createElement('div');
    avatarEl.className = 'avatar avatar-sm';
    renderAvatar(avatarEl, member.id, member.avatar, member.displayName);
    const name = document.createElement('span');
    name.className = 'roster-name';
    name.textContent = member.displayName;
    btn.appendChild(avatarEl);
    btn.appendChild(name);
    btn.addEventListener('click', () => selectPeer(member.id));
    container.appendChild(btn);
  }
}

// ---------------------------------------------------------------------
// channels
// ---------------------------------------------------------------------
function channelIcon(type) {
  if (type === 'announcement') return '📣';
  return '#';
}

async function loadChannels() {
  const data = await api('/channels', { token: session.token });
  channels = data.channels;
  renderChannels();
}

function renderChannels() {
  els['channels-list'].innerHTML = '';
  for (const ch of channels) {
    const btn = document.createElement('button');
    btn.className = 'roster-item' + (ch.id === selectedChannelId ? ' active' : '');
    const icon = document.createElement('div');
    icon.className = 'avatar avatar-sm channel-icon';
    icon.textContent = channelIcon(ch.type);
    const name = document.createElement('span');
    name.className = 'roster-name';
    name.textContent = ch.name;
    btn.appendChild(icon);
    btn.appendChild(name);
    if (ch.type === 'announcement' && !ch.canPost) {
      const lock = document.createElement('span');
      lock.className = 'read-only-badge';
      lock.textContent = 'read-only';
      btn.appendChild(lock);
    }
    if (mutedConvos.has(convKey(ch.id, true))) {
      const muteMark = document.createElement('span');
      muteMark.className = 'muted-badge';
      muteMark.textContent = '🔕';
      btn.appendChild(muteMark);
    }
    btn.addEventListener('click', () => selectChannel(ch.id));
    els['channels-list'].appendChild(btn);
  }
}

async function loadChannelMessages(channelId) {
  const data = await api(`/channels/${encodeURIComponent(channelId)}/messages`, { token: session.token });
  return data.messages || [];
}

async function selectChannel(channelId) {
  selectedChannelId = channelId;
  selectedPeerId = null;
  channelMessageEls = {};
  closeReactionPicker();
  renderRoster();
  renderChannels();
  openChatPaneMobile();
  updateMuteButton(channelId, true);

  const ch = channels.find((c) => c.id === channelId);
  els['chat-empty'].classList.add('hidden');
  els['chat-active'].classList.remove('hidden');
  els['peer-avatar'].innerHTML = '';
  els['peer-avatar'].classList.add('channel-icon');
  els['peer-avatar'].style.background = '';
  els['peer-avatar'].textContent = channelIcon(ch ? ch.type : 'group');
  els['peer-name'].textContent = ch ? ch.name : channelId;
  setStatus(socket && socket.readyState === 1 ? 'secured' : '', socket && socket.readyState === 1 ? 'Connected' : 'Connecting…');

  updateComposerForChannel(ch);
  renderChannelBanner(ch);

  els['messages'].innerHTML = '';
  let history = [];
  try {
    history = await loadChannelMessages(channelId);
  } catch (e) {
    addBubble(`Could not load channel history: ${e.message}`, 'system');
  }
  if (history.length === 0) {
    addBubble(`No messages yet in ${ch ? ch.name : 'this channel'}.`, 'system');
  }
  for (const entry of history) {
    renderMessage(entry, entry.from === session.user.id ? 'mine' : 'theirs', channelId, true);
    cacheMessage(`channel:${channelId}`, entry, { channelId, channelName: ch ? ch.name : channelId });
  }
}

function updateComposerForChannel(ch) {
  els['composer-error'].textContent = '';
  const canPost = !ch || ch.canPost !== false;
  els['composer-row'].classList.toggle('hidden', !canPost);
  els['composer-locked'].classList.toggle('hidden', canPost);
}

function renderChannelBanner(ch) {
  const existing = document.getElementById('monitoring-banner');
  if (existing) existing.remove();
  if (!ch) return;
  const banner = document.createElement('div');
  banner.id = 'monitoring-banner';
  banner.className = 'monitoring-banner';
  banner.textContent = ch.dm
    ? 'Direct messages are stored and may be reviewed by LVO admins for compliance purposes.'
    : 'Messages in this channel are stored and may be reviewed by LVO admins for compliance purposes.';
  els['chat-active'].prepend(banner);
}

function sendChannelMessage(channelId, text, attachment) {
  if (!socket || socket.readyState !== 1) throw new Error('Not connected.');
  const payload = { type: 'room_send', channelId, text };
  if (attachment) payload.attachment = attachment;
  socket.send(JSON.stringify(payload));
}

// ---------------------------------------------------------------------
// create / manage channel modals (admin only)
// ---------------------------------------------------------------------
let pendingChannelType = 'group';

function openChannelModal() {
  els['channel-error'].textContent = '';
  els['channel-name'].value = '';
  pendingChannelType = 'group';
  els['channel-modal'].querySelectorAll('[data-channel-type]').forEach((b) => {
    b.classList.toggle('active', b.dataset.channelType === 'group');
  });
  els['channel-member-picker'].innerHTML = '';
  for (const member of roster) {
    const row = document.createElement('label');
    row.className = 'member-picker-row';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = member.id;
    row.appendChild(cb);
    row.appendChild(document.createTextNode(' ' + member.displayName));
    els['channel-member-picker'].appendChild(row);
  }
  els['channel-modal'].classList.remove('hidden');
}

els['channel-modal'] && els['channel-modal'].querySelectorAll('[data-channel-type]').forEach((btn) => {
  btn.addEventListener('click', () => {
    pendingChannelType = btn.dataset.channelType;
    els['channel-modal'].querySelectorAll('[data-channel-type]').forEach((b) => b.classList.toggle('active', b === btn));
  });
});

els['channel-cancel'] && els['channel-cancel'].addEventListener('click', () => els['channel-modal'].classList.add('hidden'));

els['channel-create'] && els['channel-create'].addEventListener('click', async () => {
  els['channel-error'].textContent = '';
  const name = els['channel-name'].value.trim();
  if (!name) {
    els['channel-error'].textContent = 'Channel name is required.';
    return;
  }
  const memberIds = Array.from(els['channel-member-picker'].querySelectorAll('input:checked')).map((cb) => cb.value);
  try {
    await api('/channels', { method: 'POST', token: session.token, body: { name, type: pendingChannelType, memberIds } });
    els['channel-modal'].classList.add('hidden');
    await loadChannels();
    await refreshAdminChannelList();
  } catch (e) {
    els['channel-error'].textContent = e.message;
  }
});

let manageChannelId = null;

async function openManageChannel(channelId) {
  manageChannelId = channelId;
  els['manage-channel-error'].textContent = '';
  const adminList = await api('/admin/channels', { token: session.token });
  const ch = adminList.channels.find((c) => c.id === channelId);
  if (!ch) return;
  els['manage-channel-title'].textContent = ch.name;
  els['manage-channel-subhead'].textContent = ch.type === 'announcement'
    ? 'Only members with posting rights can send here. Everyone else reads.'
    : 'Everyone in this channel can post.';
  els['manage-channel-delete'].classList.toggle('hidden', ch.id === 'general');

  const membersData = await api(`/channels/${encodeURIComponent(channelId)}/members`, { token: session.token });
  els['manage-channel-members'].innerHTML = '';
  for (const m of membersData.members) {
    const row = document.createElement('div');
    row.className = 'user-row';
    const meta = document.createElement('div');
    meta.className = 'user-meta';
    meta.innerHTML = `<div>${m.displayName}</div><div class="user-id">@${m.id}</div>`;
    row.appendChild(meta);

    if (ch.type === 'announcement') {
      const label = document.createElement('label');
      label.className = 'canpost-toggle';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!m.canPost;
      cb.addEventListener('change', async () => {
        try {
          await api(`/channels/${encodeURIComponent(channelId)}`, {
            method: 'PATCH',
            token: session.token,
            body: { setCanPost: { userId: m.id, canPost: cb.checked } },
          });
        } catch (e) {
          els['manage-channel-error'].textContent = e.message;
        }
      });
      label.appendChild(cb);
      label.appendChild(document.createTextNode(' can post'));
      row.appendChild(label);
    }

    const actions = document.createElement('div');
    actions.className = 'user-actions';
    const removeBtn = document.createElement('button');
    removeBtn.className = 'btn btn-danger';
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', async () => {
      try {
        await api(`/channels/${encodeURIComponent(channelId)}`, {
          method: 'PATCH',
          token: session.token,
          body: { removeMemberIds: [m.id] },
        });
        await openManageChannel(channelId);
        await loadChannels();
      } catch (e) {
        els['manage-channel-error'].textContent = e.message;
      }
    });
    actions.appendChild(removeBtn);
    row.appendChild(actions);
    els['manage-channel-members'].appendChild(row);
  }

  const memberIds = new Set(membersData.members.map((m) => m.id));
  els['manage-channel-add-select'].innerHTML = '';
  const nonMembers = [session.user, ...roster].filter((u) => !memberIds.has(u.id));
  for (const u of nonMembers) {
    const opt = document.createElement('option');
    opt.value = u.id;
    opt.textContent = u.displayName;
    els['manage-channel-add-select'].appendChild(opt);
  }

  els['manage-channel-modal'].classList.remove('hidden');
}

els['manage-channel-add-btn'] && els['manage-channel-add-btn'].addEventListener('click', async () => {
  const uid = els['manage-channel-add-select'].value;
  if (!uid || !manageChannelId) return;
  try {
    await api(`/channels/${encodeURIComponent(manageChannelId)}`, {
      method: 'PATCH',
      token: session.token,
      body: { addMemberIds: [uid] },
    });
    await openManageChannel(manageChannelId);
    await loadChannels();
  } catch (e) {
    els['manage-channel-error'].textContent = e.message;
  }
});

els['manage-channel-delete'] && els['manage-channel-delete'].addEventListener('click', async () => {
  if (!manageChannelId) return;
  if (!confirm('Delete this channel? This removes it for everyone.')) return;
  try {
    await api(`/channels/${encodeURIComponent(manageChannelId)}`, { method: 'DELETE', token: session.token });
    els['manage-channel-modal'].classList.add('hidden');
    await loadChannels();
    await refreshAdminChannelList();
  } catch (e) {
    els['manage-channel-error'].textContent = e.message;
  }
});

els['manage-channel-close'] && els['manage-channel-close'].addEventListener('click', () => els['manage-channel-modal'].classList.add('hidden'));
els['admin-new-channel'] && els['admin-new-channel'].addEventListener('click', openChannelModal);

// ---------------------------------------------------------------------
// mute button
// ---------------------------------------------------------------------
els['mute-btn'] && els['mute-btn'].addEventListener('click', () => {
  const id = els['mute-btn'].dataset.convId;
  const isChannel = !!els['mute-btn'].dataset.isChannel;
  if (!id) return;
  const currentlyMuted = mutedConvos.has(convKey(id, isChannel));
  setMuted(id, isChannel, !currentlyMuted);
  if (isChannel) renderChannels();
});

// ---------------------------------------------------------------------
// chat wiring
// ---------------------------------------------------------------------
function setStatus(state, text) {
  els['status-dot'].className = `status-dot ${state}`;
  els['status-text'].textContent = text;
}

function addBubble(text, kind) {
  const row = document.createElement('div');
  row.className = `bubble-row ${kind}`;
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = text;
  row.appendChild(bubble);
  els['messages'].appendChild(row);
  els['messages'].scrollTop = els['messages'].scrollHeight;
}

async function loadDmMessages(peerId) {
  const data = await api(`/dm/${encodeURIComponent(peerId)}/messages`, { token: session.token });
  return data.messages || [];
}

function sendDmMessage(peerId, text, attachment) {
  if (!socket || socket.readyState !== 1) throw new Error('Not connected.');
  const payload = { type: 'dm_send', to: peerId, text };
  if (attachment) payload.attachment = attachment;
  socket.send(JSON.stringify(payload));
}

function initClient() {
  return new Promise((resolve, reject) => {
    socket = new WebSocket(SERVER_URL.replace(/^http/, 'ws') + '/relay');
    let authenticated = false;

    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ type: 'authenticate', token: session.token, userId: session.user.id }));
    });

    socket.addEventListener('close', () => {
      setStatus('error', 'Disconnected');
      if (!authenticated) reject(new Error('Connection closed before authenticating.'));
    });

    socket.addEventListener('error', () => {
      if (!authenticated) reject(new Error('Could not connect to the chat server.'));
    });

    socket.addEventListener('message', (ev) => {
      let payload;
      try {
        payload = JSON.parse(ev.data);
      } catch {
        return;
      }

      if (payload.type === 'authenticated') {
        authenticated = true;
        setStatus('secured', 'Connected');
        resolve();
        return;
      }
      if (payload.type === 'auth_error') {
        setStatus('error', 'Disconnected');
        reject(new Error(payload.error || 'Authentication failed.'));
        return;
      }

      if (payload.type === 'dm_message') {
        const otherParty = payload.from === session.user.id ? payload.to : payload.from;
        touchRecentChat(otherParty);
        const peerMember = roster.find((m) => m.id === otherParty);
        cacheMessage(`dm:${otherParty}`, payload, {
          dmPeerId: otherParty,
          dmPeerName: peerMember ? peerMember.displayName : otherParty,
        });
        if (selectedPeerId === otherParty) {
          renderMessage(
            { id: payload.id, from: payload.from, text: payload.text, attachment: payload.attachment, reactions: {}, ts: payload.ts },
            payload.from === session.user.id ? 'mine' : 'theirs',
            otherParty,
            false
          );
        }
        if (payload.from !== session.user.id) {
          const fromMember = roster.find((m) => m.id === payload.from);
          notifyIncoming(otherParty, false, fromMember ? fromMember.displayName : payload.from, payload.text || 'Sent an attachment');
        }
        return;
      }
      if (payload.type === 'room_message') {
        const ch = channels.find((c) => c.id === payload.channelId);
        cacheMessage(`channel:${payload.channelId}`, payload, {
          channelId: payload.channelId,
          channelName: ch ? ch.name : payload.channelId,
        });
        if (selectedChannelId === payload.channelId) {
          renderMessage(
            { id: payload.id, from: payload.from, fromName: payload.fromName, text: payload.text, attachment: payload.attachment, reactions: {}, ts: payload.ts },
            payload.from === session.user.id ? 'mine' : 'theirs',
            payload.channelId,
            true
          );
        }
        if (payload.from !== session.user.id) {
          notifyIncoming(payload.channelId, true, `${ch ? ch.name : payload.channelId}: ${payload.fromName || payload.from}`, payload.text || 'Sent an attachment');
        }
        return;
      }
      if (payload.type === 'room_reaction') {
        const store = channelMessageEls[payload.channelId];
        const entry = store && store.get(payload.messageId);
        if (entry) {
          const reactions = entry.reactions;
          if (payload.action === 'add') {
            if (!reactions[payload.emoji]) reactions[payload.emoji] = [];
            if (!reactions[payload.emoji].includes(payload.from)) reactions[payload.emoji].push(payload.from);
          } else {
            if (reactions[payload.emoji]) {
              reactions[payload.emoji] = reactions[payload.emoji].filter((u) => u !== payload.from);
              if (reactions[payload.emoji].length === 0) delete reactions[payload.emoji];
            }
          }
          renderReactionsInto(entry.el.querySelector('.message-reactions'), reactions, payload.channelId, payload.messageId);
        }
        return;
      }
      // NEW: allow the server to push freshly-created calendar events / news
      // posts to everyone connected, so open tabs update live. Purely
      // additive — safe no-op if the backend never sends these yet.
      if (payload.type === 'calendar_event' && currentTab === 'calendar') {
        renderCalendarMonth();
        return;
      }
      if (payload.type === 'news_post' && currentTab === 'news') {
        refreshNewsFeed();
        return;
      }
      if (payload.type === 'room_error') {
        if (selectedChannelId === payload.channelId) {
          els['composer-error'].textContent = payload.error;
        }
        return;
      }
    });
  });
}

async function selectPeer(peerId) {
  selectedPeerId = peerId;
  selectedChannelId = null;
  touchRecentChat(peerId);
  closeReactionPicker();
  renderRoster();
  renderChannels();
  openChatPaneMobile();
  updateMuteButton(peerId, false);
  const member = roster.find((m) => m.id === peerId);
  els['chat-empty'].classList.add('hidden');
  els['chat-active'].classList.remove('hidden');
  renderAvatar(els['peer-avatar'], member.id, member.avatar, member.displayName);
  els['peer-name'].textContent = member.displayName;
  setStatus(socket && socket.readyState === 1 ? 'secured' : '', socket && socket.readyState === 1 ? 'Connected' : 'Connecting…');

  updateComposerForChannel(null);
  renderChannelBanner({ name: member.displayName, dm: true });

  els['messages'].innerHTML = '';
  let history = [];
  try {
    history = await loadDmMessages(peerId);
  } catch (e) {
    addBubble(`Could not load conversation history: ${e.message}`, 'system');
  }
  if (history.length === 0) {
    addBubble(`No messages yet with ${member.displayName}.`, 'system');
  }
  for (const entry of history) {
    renderMessage(entry, entry.from === session.user.id ? 'mine' : 'theirs', peerId, false);
    cacheMessage(`dm:${peerId}`, entry, { dmPeerId: peerId, dmPeerName: member.displayName });
  }
}

async function sendCurrentMessage() {
  const text = els['composer-input'].value.trim();
  const files = pendingFiles.slice();
  if (!text && files.length === 0) return;
  if (!selectedPeerId && !selectedChannelId) return;

  els['composer-input'].value = '';
  autosizeComposer();
  clearPendingFiles();
  updateSendButtonState();
  els['composer-send'].disabled = true;
  els['composer-error'].textContent = '';
  try {
    const send = selectedChannelId
      ? (t, attachment) => sendChannelMessage(selectedChannelId, t, attachment)
      : (t, attachment) => sendDmMessage(selectedPeerId, t, attachment);
    const upload = selectedChannelId
      ? (file) => uploadChannelFile(selectedChannelId, file)
      : (file) => uploadDmFile(selectedPeerId, file);

    if (files.length > 0) {
      for (let i = 0; i < files.length; i++) {
        const uploaded = await upload(files[i]);
        send(i === files.length - 1 ? text : '', uploaded);
      }
    } else {
      send(text);
    }
  } catch (e) {
    console.error(e);
    addBubble(`Failed to send: ${e.message}`, 'system');
  } finally {
    els['composer-send'].disabled = false;
    els['composer-input'].focus();
  }
}

// ---------------------------------------------------------------------
// avatar settings modal
// ---------------------------------------------------------------------
function buildPresetGrid() {
  els['preset-grid'].innerHTML = '';
  for (const preset of Object.values(presetsById)) {
    const btn = document.createElement('button');
    btn.className = 'preset-choice' + (session.user.avatar && session.user.avatar.value === preset.id ? ' selected' : '');
    btn.style.background = 'var(--panel-raised)';
    const img = document.createElement('img');
    img.src = preset.image;
    btn.appendChild(img);
    btn.title = preset.id;
    btn.addEventListener('click', () => chooseImagePreset(preset.id));
    els['preset-grid'].appendChild(btn);
  }
}

async function chooseImagePreset(presetId) {
  els['avatar-error'].textContent = '';
  try {
    await api('/me/avatar/preset', { method: 'POST', token: session.token, body: { presetId } });
    session.user.avatar = { type: 'preset', value: presetId };
    saveSession(session);
    invalidateAvatarCache(session.user.id);
    renderAvatar(els['me-avatar'], session.user.id, session.user.avatar, session.user.displayName);
    buildPresetGrid();
    renderRoster();
  } catch (e) {
    els['avatar-error'].textContent = e.message;
  }
}

function resizeImageFile(file, maxSize = 160) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = maxSize;
      canvas.height = maxSize;
      const ctx = canvas.getContext('2d');
      const side = Math.min(img.width, img.height);
      const sx = (img.width - side) / 2;
      const sy = (img.height - side) / 2;
      ctx.drawImage(img, sx, sy, side, side, 0, 0, maxSize, maxSize);
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not process image.'))), 'image/jpeg', 0.85);
    };
    img.onerror = () => reject(new Error('Could not read that image.'));
    img.src = URL.createObjectURL(file);
  });
}

async function handleAvatarUpload(file) {
  els['avatar-error'].textContent = '';
  try {
    const blob = await resizeImageFile(file);
    if (blob.size > 350 * 1024) throw new Error('Image is still too large after resizing — try a smaller photo.');
    await api('/me/avatar/upload', {
      method: 'POST',
      token: session.token,
      rawBody: blob,
      contentType: 'image/jpeg',
    });
    session.user.avatar = { type: 'upload', value: `u/${session.user.id}` };
    saveSession(session);
    invalidateAvatarCache(session.user.id);
    renderAvatar(els['me-avatar'], session.user.id, session.user.avatar, session.user.displayName);
    renderAvatar(els['upload-preview'], session.user.id, session.user.avatar, session.user.displayName);
    renderRoster();
  } catch (e) {
    els['avatar-error'].textContent = e.message;
  }
}

// =======================================================================
// Admin panel
// =======================================================================
function showAdmin() {
  els['app-screen'].classList.add('hidden');
  els['admin-screen'].classList.remove('hidden');
  refreshUserList().catch((e) => (els['create-error'].textContent = e.message));
  refreshAdminChannelList().catch(() => {});
  refreshDmThreads().catch(() => {});
}
function hideAdmin() {
  els['admin-screen'].classList.add('hidden');
  els['app-screen'].classList.remove('hidden');
}

async function refreshUserList() {
  const { users } = await api('/admin/users', { token: session.token });
  els['user-list'].innerHTML = '';
  for (const u of users) {
    const row = document.createElement('div');
    row.className = 'user-row';

    const meta = document.createElement('div');
    meta.className = 'user-meta';
    meta.innerHTML = `<div>${u.displayName}${u.role === 'admin' ? ' <span class="leader-badge">LEADER</span>' : ''}</div>
                       <div class="user-id">@${u.id}${u.mustChangePassword ? ' · awaiting first sign-in' : ''}</div>`;

    const actions = document.createElement('div');
    actions.className = 'user-actions';

    const resetBtn = document.createElement('button');
    resetBtn.className = 'btn btn-secondary';
    resetBtn.textContent = 'Reset password';
    resetBtn.addEventListener('click', () => resetPassword(u.id));
    actions.appendChild(resetBtn);

    if (u.id !== session.user.id) {
      const delBtn = document.createElement('button');
      delBtn.className = 'btn btn-danger';
      delBtn.textContent = 'Remove';
      delBtn.addEventListener('click', () => removeUser(u.id, u.displayName));
      actions.appendChild(delBtn);
    }

    row.appendChild(meta);
    row.appendChild(actions);
    els['user-list'].appendChild(row);
  }
}

async function resetPassword(userId) {
  const newPassword = prompt(`New temporary password for @${userId} (8+ characters):`);
  if (!newPassword) return;
  if (newPassword.length < 8) {
    alert('Password must be at least 8 characters.');
    return;
  }
  try {
    await api(`/admin/users/${encodeURIComponent(userId)}/reset-password`, {
      method: 'POST',
      token: session.token,
      body: { newPassword },
    });
    alert(`Password reset. Give @${userId} the new temporary password — they'll set their own at next sign-in.`);
    await refreshUserList();
  } catch (e) {
    alert(e.message);
  }
}

async function removeUser(userId, displayName) {
  if (!confirm(`Remove ${displayName} (@${userId})? This deletes their account.`)) return;
  try {
    await api(`/admin/users/${encodeURIComponent(userId)}`, { method: 'DELETE', token: session.token });
    await refreshUserList();
    await loadRoster();
    await loadChannels();
  } catch (e) {
    alert(e.message);
  }
}

els['create-btn'] && els['create-btn'].addEventListener('click', async () => {
  els['create-error'].textContent = '';
  const username = els['new-username'].value.trim();
  const password = els['new-password'].value;
  const displayName = els['new-displayname'].value.trim();
  if (!username || !password) {
    els['create-error'].textContent = 'Username and temporary password are required.';
    return;
  }
  try {
    await api('/admin/users', { method: 'POST', token: session.token, body: { username, password, displayName } });
    els['new-username'].value = '';
    els['new-displayname'].value = '';
    els['new-password'].value = '';
    await refreshUserList();
  } catch (e) {
    els['create-error'].textContent = e.message;
  }
});

async function refreshAdminChannelList() {
  const { channels: all } = await api('/admin/channels', { token: session.token });
  els['admin-channel-list'].innerHTML = '';
  for (const ch of all) {
    const row = document.createElement('div');
    row.className = 'user-row';
    const meta = document.createElement('div');
    meta.className = 'user-meta';
    const last = ch.lastActivity ? new Date(ch.lastActivity).toLocaleString() : 'no messages yet';
    meta.innerHTML = `<div>${channelIcon(ch.type)} ${ch.name} <span class="channel-type-badge">${ch.type}</span></div>
                       <div class="user-id">${ch.memberCount} member${ch.memberCount === 1 ? '' : 's'} · ${ch.messageCount} message${ch.messageCount === 1 ? '' : 's'} · last: ${last}</div>`;
    row.appendChild(meta);

    const actions = document.createElement('div');
    actions.className = 'user-actions';
    if (ch.id !== 'general') {
      const manageBtn = document.createElement('button');
      manageBtn.className = 'btn btn-secondary';
      manageBtn.textContent = 'Manage';
      manageBtn.addEventListener('click', () => openManageChannel(ch.id));
      actions.appendChild(manageBtn);
    }
    row.appendChild(actions);
    els['admin-channel-list'].appendChild(row);
  }
}

async function refreshDmThreads() {
  const { threads } = await api('/admin/dm-threads', { token: session.token });
  els['dm-thread-list'].innerHTML = '';
  if (threads.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'roster-empty';
    empty.textContent = 'No direct-message activity yet.';
    els['dm-thread-list'].appendChild(empty);
    return;
  }
  for (const t of threads) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'user-row dm-thread-row';
    const meta = document.createElement('div');
    meta.className = 'user-meta';
    meta.innerHTML = `<div>${t.userA.displayName} ↔ ${t.userB.displayName}</div>
                       <div class="user-id">last activity: ${new Date(t.lastActivity).toLocaleString()}</div>`;
    row.appendChild(meta);
    row.addEventListener('click', () => openAdminDmViewer(t.userA, t.userB));
    els['dm-thread-list'].appendChild(row);
  }
}

async function openAdminDmViewer(userA, userB) {
  const modal = document.getElementById('admin-dm-viewer-modal');
  if (!modal) return;
  document.getElementById('admin-dm-viewer-title').textContent = `${userA.displayName} ↔ ${userB.displayName}`;
  const messagesEl = document.getElementById('admin-dm-viewer-messages');
  messagesEl.innerHTML = '<p class="roster-empty">Loading…</p>';
  modal.classList.remove('hidden');

  let history = [];
  try {
    const data = await api(
      `/admin/dm/${encodeURIComponent(userA.id)}/${encodeURIComponent(userB.id)}/messages`,
      { token: session.token }
    );
    history = data.messages || [];
  } catch (e) {
    messagesEl.innerHTML = `<p class="roster-empty">Could not load this thread: ${e.message}</p>`;
    return;
  }

  messagesEl.innerHTML = '';
  if (history.length === 0) {
    messagesEl.innerHTML = '<p class="roster-empty">No messages in this thread.</p>';
    return;
  }
  const originalMessagesEl = els['messages'];
  els['messages'] = messagesEl;
  for (const entry of history) {
    renderMessage(entry, 'theirs', entry.from, false);
  }
  els['messages'] = originalMessagesEl;
}
document.getElementById('admin-dm-viewer-close') &&
  document.getElementById('admin-dm-viewer-close').addEventListener('click', () => {
    document.getElementById('admin-dm-viewer-modal').classList.add('hidden');
  });

els['admin-link'] && els['admin-link'].addEventListener('click', showAdmin);
els['close-admin'] && els['close-admin'].addEventListener('click', hideAdmin);

// ---------------------------------------------------------------------
// settings popover
// ---------------------------------------------------------------------
function openAvatarModal() {
  els['avatar-error'].textContent = '';
  renderAvatar(els['upload-preview'], session.user.id, session.user.avatar, session.user.displayName);
  els['avatar-modal'].classList.remove('hidden');
}
function closeSettingsPopover() {
  els['settings-popover'] && els['settings-popover'].classList.add('hidden');
}
els['settings-btn'] && els['settings-btn'].addEventListener('click', (e) => {
  e.stopPropagation();
  els['settings-popover'].classList.toggle('hidden');
});
document.addEventListener('click', (e) => {
  const pop = els['settings-popover'];
  if (!pop || pop.classList.contains('hidden')) return;
  if (!pop.contains(e.target) && e.target !== els['settings-btn']) closeSettingsPopover();
});
els['settings-popover'] && els['settings-popover'].addEventListener('click', (e) => {
  if (e.target.closest('button, a')) closeSettingsPopover();
});
els['settings-avatar-btn'] && els['settings-avatar-btn'].addEventListener('click', openAvatarModal);

// ---------------------------------------------------------------------
// screen wiring
// ---------------------------------------------------------------------
function showLogin() {
  els['login-screen'].classList.remove('hidden');
  els['app-screen'].classList.add('hidden');
  els['admin-screen'].classList.add('hidden');
}

function showApp() {
  els['login-screen'].classList.add('hidden');
  els['admin-screen'].classList.add('hidden');
  els['app-screen'].classList.remove('hidden');
  closeChatPaneMobile();
  els['me-name'].textContent = session.user.displayName;
  renderAvatar(els['me-avatar'], session.user.id, session.user.avatar, session.user.displayName);
  if (session.user.role === 'admin') {
    els['leader-badge'].classList.remove('hidden');
    els['admin-link'].classList.remove('hidden');
  }
  switchTab('chat');
  ensureEmojiPicker().catch(() => {});
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
}

async function boot() {
  if (!session) {
    showLogin();
    return;
  }
  try {
    const me = await api('/me', { token: session.token });
    session.user = me.user;
    saveSession(session);
  } catch {
    clearSession();
    session = null;
    showLogin();
    return;
  }
  if (session.user.mustChangePassword) {
    els['pwd-modal'].classList.remove('hidden');
    return;
  }
  loadRecentChatsFromStorage();
  await loadRoster();
  await loadMutedConvos();
  showApp();
  await loadChannels();
  await initClient();
}

// ---- login form ----
els['login-form'].addEventListener('submit', async (e) => {
  e.preventDefault();
  els['login-error'].textContent = '';
  els['login-submit'].disabled = true;
  try {
    const typedPassword = els['login-password'].value;
    const data = await api('/login', {
      method: 'POST',
      body: { username: els['login-username'].value, password: typedPassword },
    });
    session = data;
    saveSession(session);
    await boot();
  } catch (e) {
    els['login-error'].textContent = e.message;
  } finally {
    els['login-submit'].disabled = false;
  }
});

// ---- forced password change ----
els['pwd-save'].addEventListener('click', async () => {
  els['pwd-error'].textContent = '';
  const newPassword = els['pwd-new'].value;
  if (newPassword.length < 8) {
    els['pwd-error'].textContent = 'Use at least 8 characters.';
    return;
  }
  try {
    await api('/me/password', { method: 'POST', token: session.token, body: { newPassword } });
    session.user.mustChangePassword = false;
    saveSession(session);
    els['pwd-modal'].classList.add('hidden');
    loadRecentChatsFromStorage();
    await loadRoster();
    await loadMutedConvos();
    showApp();
    await loadChannels();
    await initClient();
  } catch (e) {
    els['pwd-error'].textContent = e.message;
  }
});

// ---- composer ----
const COMPOSER_MAX_HEIGHT = 140; // px — matches app.css .composer-pill textarea max-height
function autosizeComposer() {
  const el = els['composer-input'];
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, COMPOSER_MAX_HEIGHT)}px`;
}
els['composer-send'].addEventListener('click', sendCurrentMessage);
els['composer-input'].addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendCurrentMessage();
  }
});
els['composer-input'].addEventListener('input', () => {
  updateSendButtonState();
  autosizeComposer();
});

// ---- logout ----
els['logout-btn'].addEventListener('click', () => {
  if (socket) socket.close();
  clearSession();
  session = null;
  location.reload();
});

// ---- avatar modal ----
els['open-avatar-modal'].addEventListener('click', openAvatarModal);
els['avatar-cancel'].addEventListener('click', () => els['avatar-modal'].classList.add('hidden'));
document.querySelectorAll('.tab-btn[data-tab]').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn[data-tab]').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    const tab = btn.dataset.tab;
    els['tab-presets'].classList.toggle('hidden', tab !== 'presets');
    els['tab-upload'].classList.toggle('hidden', tab !== 'upload');
  });
});
els['upload-input'].addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (file) handleAvatarUpload(file);
});

boot();
