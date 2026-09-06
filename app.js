/**
 * app.js — LVO chat app shell.
 *
 * Wires: login -> roster (admin-controlled account list) -> E2EE chat
 * per selected member, using the SDK bundle from sdk/e2ee-sdk.bundle.js
 * (window.E2EE) for the actual X3DH + Double Ratchet work. This file
 * only handles accounts, avatars, and UI — it never touches plaintext
 * before encryption or after decryption in a way that leaves this file.
 */

// EDIT THIS to your deployed Worker URL (or custom domain).
const SERVER_URL = 'https://lvo-chat-relay.YOUR-SUBDOMAIN.workers.dev';

const SESSION_KEY = 'lvo_session'; // { token, user } in localStorage

// ---------------------------------------------------------------------
// tiny IndexedDB key-value store (crypto key material + local message log)
// ---------------------------------------------------------------------
function idbGet(key) {
  return new Promise((resolve) => {
    const req = indexedDB.open('lvo-chat', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => {
      const tx = req.result.transaction('kv', 'readonly');
      const g = tx.objectStore('kv').get(key);
      g.onsuccess = () => resolve(g.result ?? null);
      g.onerror = () => resolve(null);
    };
    req.onerror = () => resolve(null);
  });
}
function idbSet(key, value) {
  return new Promise((resolve) => {
    const req = indexedDB.open('lvo-chat', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => {
      const tx = req.result.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(value, key);
      tx.oncomplete = () => resolve();
    };
    req.onerror = () => resolve();
  });
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

async function api(path, { method = 'GET', body, token, rawBody, contentType } = {}) {
  const headers = {};
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
let selectedPeerId = null;
let client = null;
let socket = null;
const avatarBlobCache = new Map(); // userId -> object URL

const els = {};
[
  'login-screen', 'login-form', 'login-username', 'login-password', 'login-submit', 'login-error',
  'pwd-modal', 'pwd-new', 'pwd-error', 'pwd-save',
  'app-screen', 'me-avatar', 'me-name', 'leader-badge', 'open-avatar-modal',
  'roster-list', 'admin-link', 'logout-btn',
  'chat-empty', 'chat-active', 'peer-avatar', 'peer-name', 'status-dot', 'status-text',
  'messages', 'composer-input', 'composer-send',
  'avatar-modal', 'preset-grid', 'upload-preview', 'upload-input', 'avatar-error', 'avatar-cancel',
  'tab-presets', 'tab-upload',
].forEach((id) => (els[id] = document.getElementById(id)));

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
// roster
// ---------------------------------------------------------------------
async function loadRoster() {
  const data = await api('/roster', { token: session.token });
  roster = data.roster;
  presetsById = Object.fromEntries(data.presets.map((p) => [p.id, p]));
  renderRoster();
  buildPresetGrid();
}

function renderRoster() {
  els['roster-list'].innerHTML = '';
  if (roster.length === 0) {
    els['roster-list'].innerHTML = '<p class="roster-empty">No other members yet. Ask your admin to add someone.</p>';
    return;
  }
  for (const member of roster) {
    const btn = document.createElement('button');
    btn.className = 'roster-item' + (member.id === selectedPeerId ? ' active' : '');
    const avatarEl = document.createElement('div');
    avatarEl.className = 'avatar avatar-sm';
    renderAvatar(avatarEl, member.id, member.avatar, member.displayName);
    const name = document.createElement('span');
    name.className = 'roster-name';
    name.textContent = member.displayName;
    btn.appendChild(avatarEl);
    btn.appendChild(name);
    btn.addEventListener('click', () => selectPeer(member.id));
    els['roster-list'].appendChild(btn);
  }
}

// ---------------------------------------------------------------------
// chat / E2EE wiring
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

async function loadHistory(peerId) {
  const all = (await idbGet(`history:${session.user.id}`)) || {};
  return all[peerId] || [];
}
async function appendHistory(peerId, entry) {
  const all = (await idbGet(`history:${session.user.id}`)) || {};
  all[peerId] = [...(all[peerId] || []), entry].slice(-500);
  await idbSet(`history:${session.user.id}`, all);
}

async function initClient() {
  await window.E2EE.crypto.ready();
  const storageKey = `client:${session.user.id}`;
  const saved = await idbGet(storageKey);

  const transportBundle = window.E2EE.createBrowserTransport({
    serverUrl: SERVER_URL,
    userId: session.user.id,
    authToken: session.token,
    onOpen: () => setStatus('secured', 'Connected'),
    onMessage: async (wire) => {
      try {
        await client.receive(wire);
      } catch (e) {
        console.error('Failed to decrypt incoming message', e);
        if (wire.from === selectedPeerId) addBubble('Received a message that could not be decrypted.', 'system');
      }
    },
  });
  socket = transportBundle.socket;
  socket.addEventListener('close', () => setStatus('error', 'Disconnected'));

  client = new window.E2EE.E2EEClient(session.user.id, transportBundle.transport);
  client.onMessage = async (from, text) => {
    await appendHistory(from, { from, text, ts: Date.now() });
    if (from === selectedPeerId) addBubble(text, 'theirs');
    await idbSet(storageKey, client.export());
  };

  if (saved) {
    await client.restore(saved);
  } else {
    await client.init();
  }
  await idbSet(storageKey, client.export());
}

async function selectPeer(peerId) {
  selectedPeerId = peerId;
  renderRoster();
  const member = roster.find((m) => m.id === peerId);
  els['chat-empty'].classList.add('hidden');
  els['chat-active'].classList.remove('hidden');
  renderAvatar(els['peer-avatar'], member.id, member.avatar, member.displayName);
  els['peer-name'].textContent = member.displayName;
  setStatus(socket && socket.readyState === 1 ? 'secured' : '', socket && socket.readyState === 1 ? 'Connected' : 'Connecting…');

  els['messages'].innerHTML = '';
  const history = await loadHistory(peerId);
  if (history.length === 0) {
    addBubble('No messages yet. Anything you send here is end-to-end encrypted.', 'system');
  }
  for (const entry of history) {
    addBubble(entry.text, entry.from === session.user.id ? 'mine' : 'theirs');
  }
}

async function sendCurrentMessage() {
  const text = els['composer-input'].value.trim();
  if (!text || !selectedPeerId) return;
  els['composer-input'].value = '';
  els['composer-send'].disabled = true;
  try {
    await client.sendMessage(selectedPeerId, text);
    addBubble(text, 'mine');
    await appendHistory(selectedPeerId, { from: session.user.id, text, ts: Date.now() });
    await idbSet(`client:${session.user.id}`, client.export());
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

// ---------------------------------------------------------------------
// screen wiring
// ---------------------------------------------------------------------
function showLogin() {
  els['login-screen'].classList.remove('hidden');
  els['app-screen'].classList.add('hidden');
}

function showApp() {
  els['login-screen'].classList.add('hidden');
  els['app-screen'].classList.remove('hidden');
  els['me-name'].textContent = session.user.displayName;
  renderAvatar(els['me-avatar'], session.user.id, session.user.avatar, session.user.displayName);
  if (session.user.role === 'admin') {
    els['leader-badge'].classList.remove('hidden');
    els['admin-link'].classList.remove('hidden');
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
  showApp();
  await loadRoster();
  await initClient();
}

// ---- login form ----
els['login-form'].addEventListener('submit', async (e) => {
  e.preventDefault();
  els['login-error'].textContent = '';
  els['login-submit'].disabled = true;
  try {
    const data = await api('/login', {
      method: 'POST',
      body: { username: els['login-username'].value, password: els['login-password'].value },
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
    showApp();
    await loadRoster();
    await initClient();
  } catch (e) {
    els['pwd-error'].textContent = e.message;
  }
});

// ---- composer ----
els['composer-send'].addEventListener('click', sendCurrentMessage);
els['composer-input'].addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendCurrentMessage();
  }
});

// ---- logout ----
els['logout-btn'].addEventListener('click', () => {
  if (socket) socket.close();
  clearSession();
  session = null;
  client = null;
  location.reload();
});

// ---- avatar modal ----
els['open-avatar-modal'].addEventListener('click', () => {
  els['avatar-error'].textContent = '';
  renderAvatar(els['upload-preview'], session.user.id, session.user.avatar, session.user.displayName);
  els['avatar-modal'].classList.remove('hidden');
});
els['avatar-cancel'].addEventListener('click', () => els['avatar-modal'].classList.add('hidden'));
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
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
