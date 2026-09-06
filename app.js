/**
 * app.js — LVO chat app shell.
 *
 * Wires: login -> roster (admin-controlled account list) -> E2EE chat
 * per selected member, using the SDK bundle from sdk/e2ee-sdk.bundle.js
 * (window.E2EE) for the actual X3DH + Double Ratchet work. Direct
 * messages are never touched in plaintext by this file before
 * encryption or after decryption in a way that leaves this file.
 *
 * Channels (General / Group / Announcement) are a separate, plaintext,
 * server-stored broadcast system — sent as `room_send` over the same
 * websocket, persisted server-side, and visible to admins for
 * oversight. That's a deliberate trade-off, not an oversight: direct
 * messages are the secure line, channels are the compliance-monitored
 * team space (same idea "General" always advertised, now finished and
 * extended to Group/Announcement channels).
 *
 * The admin panel (member management, channel management, DM activity
 * overview) lives in this same page as a toggled view — there is no
 * separate admin.html route, so the URL never changes.
 */


const SERVER_URL = 'https://lvo-chat-relay.lvoholdings00.workers.dev';

const SESSION_KEY = 'lvo_session'; // { token, user } in localStorage

// ---------------------------------------------------------------------
// tiny IndexedDB key-value store (crypto key material + local DM log)
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
let channels = []; // [{id, name, type, memberCount, canPost}]
let selectedPeerId = null;
let selectedChannelId = null; // mutually exclusive with selectedPeerId
let client = null;
let socket = null;
const avatarBlobCache = new Map(); // userId -> object URL
const channelTypeById = {}; // scratch used while building the create-channel modal

const els = {};
[
  'login-screen', 'login-form', 'login-username', 'login-password', 'login-submit', 'login-error',
  'pwd-modal', 'pwd-new', 'pwd-error', 'pwd-save',
  'app-screen', 'me-avatar', 'me-name', 'leader-badge', 'open-avatar-modal',
  'channels-list', 'roster-list', 'admin-link', 'logout-btn',
  'chat-empty', 'chat-active', 'peer-avatar', 'peer-name', 'status-dot', 'status-text',
  'messages', 'composer-input', 'composer-send', 'composer-row', 'composer-error', 'composer-locked',
  'avatar-modal', 'preset-grid', 'upload-preview', 'upload-input', 'avatar-error', 'avatar-cancel',
  'tab-presets', 'tab-upload',
  'channel-modal', 'channel-name', 'channel-member-picker', 'channel-error', 'channel-cancel', 'channel-create',
  'manage-channel-modal', 'manage-channel-title', 'manage-channel-subhead', 'manage-channel-members',
  'manage-channel-add-select', 'manage-channel-add-btn', 'manage-channel-error', 'manage-channel-delete', 'manage-channel-close',
  'admin-screen', 'close-admin',
  'new-username', 'new-displayname', 'new-password', 'create-btn', 'create-error', 'user-list',
  'admin-new-channel', 'admin-channel-list', 'dm-thread-list',
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
    const empty = document.createElement('p');
    empty.className = 'roster-empty';
    empty.textContent = 'No other members yet. Ask your admin to add someone.';
    els['roster-list'].appendChild(empty);
    return;
  }
  for (const member of roster) {
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
    els['roster-list'].appendChild(btn);
  }
}

// ---------------------------------------------------------------------
// channels (General / Group / Announcement — plaintext, server-stored)
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
    icon.className = 'avatar avatar-sm';
    icon.style.background = 'var(--panel-raised)';
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
  renderRoster();
  renderChannels();

  const ch = channels.find((c) => c.id === channelId);
  els['chat-empty'].classList.add('hidden');
  els['chat-active'].classList.remove('hidden');
  els['peer-avatar'].innerHTML = '';
  els['peer-avatar'].style.background = 'var(--panel-raised)';
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
    const label = entry.fromName || entry.from;
    addBubble(`${label}: ${entry.text}`, entry.from === session.user.id ? 'mine' : 'theirs');
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
  banner.textContent = 'Messages in this channel are stored and may be reviewed by LVO admins for compliance purposes.';
  els['chat-active'].prepend(banner);
}

function sendChannelMessage(channelId, text) {
  if (!socket || socket.readyState !== 1) throw new Error('Not connected.');
  socket.send(JSON.stringify({ type: 'room_send', channelId, text }));
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
  const data = await api('/channels', { token: session.token }); // for name/type context via admin list fallback
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

  // Second listener on the same socket, scoped to channel broadcasts
  // (room_message / room_error). Does not interfere with the SDK's own
  // listener for encrypted 1:1 traffic — it ignores anything else.
  socket.addEventListener('message', (ev) => {
    let payload;
    try {
      payload = JSON.parse(ev.data);
    } catch {
      return; // not JSON (e.g. raw E2EE wire frame) — not ours to handle
    }
    if (payload.type === 'room_message') {
      if (selectedChannelId === payload.channelId) {
        addBubble(`${payload.fromName || payload.from}: ${payload.text}`, payload.from === session.user.id ? 'mine' : 'theirs');
      }
      return;
    }
    if (payload.type === 'room_error') {
      if (selectedChannelId === payload.channelId) {
        els['composer-error'].textContent = payload.error;
      }
      return;
    }
  });

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
  selectedChannelId = null;
  renderRoster();
  renderChannels();
  const member = roster.find((m) => m.id === peerId);
  els['chat-empty'].classList.add('hidden');
  els['chat-active'].classList.remove('hidden');
  renderAvatar(els['peer-avatar'], member.id, member.avatar, member.displayName);
  els['peer-name'].textContent = member.displayName;
  setStatus(socket && socket.readyState === 1 ? 'secured' : '', socket && socket.readyState === 1 ? 'Connected' : 'Connecting…');

  updateComposerForChannel(null);
  renderChannelBanner(null);

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
  if (!text) return;
  if (!selectedPeerId && !selectedChannelId) return;

  els['composer-input'].value = '';
  els['composer-send'].disabled = true;
  els['composer-error'].textContent = '';
  try {
    if (selectedChannelId) {
      sendChannelMessage(selectedChannelId, text);
      addBubble(text, 'mine');
    } else {
      await client.sendMessage(selectedPeerId, text);
      addBubble(text, 'mine');
      await appendHistory(selectedPeerId, { from: session.user.id, text, ts: Date.now() });
      await idbSet(`client:${session.user.id}`, client.export());
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
// Admin panel — merged from admin.js, shown/hidden in-page (no admin.html)
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
  if (!confirm(`Remove ${displayName} (@${userId})? This deletes their account and key bundle.`)) return;
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
    const row = document.createElement('div');
    row.className = 'user-row';
    const meta = document.createElement('div');
    meta.className = 'user-meta';
    meta.innerHTML = `<div>${t.userA.displayName} ↔ ${t.userB.displayName}</div>
                       <div class="user-id">last activity: ${new Date(t.lastActivity).toLocaleString()}</div>`;
    row.appendChild(meta);
    els['dm-thread-list'].appendChild(row);
  }
}

els['admin-link'] && els['admin-link'].addEventListener('click', showAdmin);
els['close-admin'] && els['close-admin'].addEventListener('click', hideAdmin);

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
  await loadChannels();
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
    await loadChannels();
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
