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
 *
 * MOBILE NAV: below the 700px breakpoint (see app.css), #app-screen
 * shows only one pane at a time — the roster/channel list, or the open
 * chat — Telegram/Instagram style, instead of the two-column desktop
 * layout. Selecting a channel or DM adds the "chat-open" class to
 * #app-screen (CSS swaps which pane is visible); the back button in
 * the chat header removes it again. This is a no-op above the
 * breakpoint since the desktop grid always shows both panes regardless
 * of the class.
 *
 * PERFORMANCE NOTE: sdk/e2ee-sdk.bundle.js (the crypto library) and the
 * emoji-picker-element web component are both loaded lazily from this
 * file (see loadScriptOnce / ensureEmojiPicker below) instead of via
 * <script> tags in index.html. Neither is needed to render or use the
 * login screen, so loading them unconditionally on every page load was
 * adding several seconds of dead weight before the login form was even
 * usable. The SDK now loads right before it's first needed (inside
 * initClient(), which only runs after a successful login), and the
 * emoji picker is prefetched quietly in the background right after
 * login so it's warm by the time someone opens the reaction picker.
 */


const SERVER_URL = 'https://lvo-chat-relay.lvoholdings00.workers.dev';

const SESSION_KEY = 'lvo_session'; // { token, user } in localStorage

// GIPHY SDK key — safe to embed client-side (GIPHY's Web/JS SDK keys are
// meant to ship in the frontend bundle, unlike a private server key).
const GIPHY_API_KEY = 'n7IXLWcTUPp5fr5ZgJ7g7zNIs0Cn5PQE';

// ---------------------------------------------------------------------
// lazy asset loading (see PERFORMANCE NOTE above)
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
let client = null;
let socket = null;
const avatarBlobCache = new Map(); // userId -> object URL
const channelTypeById = {}; // scratch used while building the create-channel modal

// Files + reactions state.
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024; // must match the Worker's limits
let pendingFiles = []; // File[] queued in the composer, not yet sent
let channelMessageEls = {}; // messageId -> { el, reactions } for the currently-open channel only
let reactionPickerCtx = null; // { channelId, messageId } the picker popup is currently anchored to
const fileBlobCache = new Map(); // storageKey -> object URL, for plaintext channel attachments
let gifSearchDebounce = null; // debounce handle for the GIF search box

// How close together (ms) two consecutive messages from the same sender
// need to be to visually "group" them (hide the repeat avatar/name),
// Instagram-DM style, instead of every message getting its own header.
const GROUP_WINDOW_MS = 5 * 60 * 1000;

const els = {};
[
  'login-screen', 'login-form', 'login-username', 'login-password', 'login-submit', 'login-error',
  'pwd-modal', 'pwd-new', 'pwd-error', 'pwd-save',
  'app-screen', 'rail', 'chat-pane', 'me-avatar', 'me-name', 'leader-badge', 'open-avatar-modal',
  'channels-list', 'roster-list', 'admin-link', 'logout-btn',
  'settings-btn', 'settings-popover', 'settings-avatar-btn',
  'chat-empty', 'chat-active', 'chat-back-btn', 'peer-avatar', 'peer-name', 'status-dot', 'status-text',
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
].forEach((id) => (els[id] = document.getElementById(id)));

// ---------------------------------------------------------------------
// mobile list <-> chat navigation (see MOBILE NAV note at top of file)
// ---------------------------------------------------------------------
function openChatPaneMobile() {
  els['app-screen'].classList.add('chat-open');
}
function closeChatPaneMobile() {
  els['app-screen'].classList.remove('chat-open');
}
els['chat-back-btn'] && els['chat-back-btn'].addEventListener('click', closeChatPaneMobile);

// ---------------------------------------------------------------------
// cross-device backup — lets logging into the same account on a second
// device restore both its E2EE identity/session state and its decrypted
// DM history, instead of starting cold with a brand-new identity and no
// history (which is what happened before this).
//
// The server (see /me/backup in the Worker) only ever stores the
// ciphertext blob below. The key that encrypts it is derived client-side
// from the account's login password using PBKDF2 with its own random
// salt — never the same salt or iteration count the server uses to hash
// the password for auth — so this stays consistent with the rest of the
// app's trust model: the server can't read it.
//
// Real limits worth knowing:
//   - This only works on a device where the person has actually typed
//     their password in this tab (fresh login, or the forced first-time
//     password change). A reloaded tab with a persisted session token
//     but no local IndexedDB state has to ask for the password once to
//     attempt a restore (see the prompt() fallback in initClient below).
//   - If the password changes, the old backup is invalidated server-side
//     (see handleAdminResetPassword) since it was encrypted with a key
//     derived from the old password. The next device that pushes a
//     backup under the new password starts a fresh one.
// ---------------------------------------------------------------------
let sessionPassword = null; // in-memory only for this tab; never persisted to localStorage/IndexedDB
let backupPushDebounce = null;
const BACKUP_PBKDF2_ITERATIONS = 200_000;

function bytesToB64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function b64ToBytes(b64) {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

async function deriveBackupKey(password, saltB64) {
  const salt = b64ToBytes(saltB64);
  const keyMaterial = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: BACKUP_PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

// Encrypts this device's exported E2EE client state + decrypted DM
// history and pushes it to the server, reusing whatever salt is already
// on file so every device deriving from the same password lands on the
// same key. Best-effort — failures here should never block sending a
// message, so callers just fire-and-forget this via scheduleBackupPush.
async function pushBackupToServer(password) {
  if (!password || !client || !session) return;
  try {
    let saltB64;
    try {
      const existing = await api('/me/backup', { token: session.token });
      saltB64 = existing.salt;
    } catch {
      saltB64 = bytesToB64(crypto.getRandomValues(new Uint8Array(16)));
    }
    const key = await deriveBackupKey(password, saltB64);
    const history = (await idbGet(`history:${session.user.id}`)) || {};
    const payload = { clientState: client.export(), history };
    const plaintext = new TextEncoder().encode(JSON.stringify(payload));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
    await api('/me/backup', {
      method: 'PUT',
      token: session.token,
      body: { salt: saltB64, iv: bytesToB64(iv), blob: bytesToB64(new Uint8Array(ciphertext)) },
    });
  } catch (e) {
    console.error('Backup push failed (will retry after the next message)', e);
  }
}

// Debounced so a burst of messages doesn't fire a PBKDF2 derivation +
// upload per message — just once, ~2.5s after things settle.
function scheduleBackupPush() {
  if (!sessionPassword) return; // nothing in memory to encrypt with this session
  clearTimeout(backupPushDebounce);
  backupPushDebounce = setTimeout(() => pushBackupToServer(sessionPassword), 2500);
}

// Attempts to pull down and decrypt this account's server-side backup
// (if any) using `password`, and if successful, seeds this device's local
// IndexedDB with the restored identity/session state + history so the
// normal initClient() flow picks it up as if it had always been there.
// Returns false (not an error) when there's simply no backup yet — that's
// the expected case for the very first device an account is ever used on.
async function tryRestoreFromServerBackup(password) {
  let data;
  try {
    data = await api('/me/backup', { token: session.token });
  } catch {
    return false;
  }
  try {
    const key = await deriveBackupKey(password, data.salt);
    const iv = b64ToBytes(data.iv);
    const ciphertext = b64ToBytes(data.blob);
    const plaintextBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
    const payload = JSON.parse(new TextDecoder().decode(plaintextBuf));
    await idbSet(`client:${session.user.id}`, payload.clientState);
    await idbSet(`history:${session.user.id}`, payload.history || {});
    return true;
  } catch (e) {
    console.error('Backup restore failed — wrong password derivation, or the backup predates a password change', e);
    return false;
  }
}

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
  container.classList.remove('channel-icon'); // defensive: this container may have last shown a channel icon
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
// files: upload, encryption (DM only), fetching, and rendering
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

// Channel attachments are plaintext on the server, same trust tier as
// channel text — fetch them the same way avatars are fetched (bearer
// token on the request, cached as a local object URL).
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

// DM attachments follow the same trust model as DM text: the Worker only
// ever sees ciphertext. We encrypt the file locally with a random
// per-file AES-GCM key before upload, then deliver that key to the
// recipient inside a normal E2EE ratchet message (as a JSON "descriptor"
// sent through client.sendMessage), exactly like the Worker comments
// describe. This uses WebCrypto directly rather than the E2EE SDK, since
// this is a separate, simpler symmetric-encryption step, not part of the
// X3DH/ratchet session itself.
async function encryptBufferForDm(buffer) {
  const rawKey = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cryptoKey = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['encrypt']);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, cryptoKey, buffer);
  return {
    ciphertext,
    rawKeyB64: btoa(String.fromCharCode(...rawKey)),
    ivB64: btoa(String.fromCharCode(...iv)),
  };
}
async function decryptDmFileBuffer(ciphertextBuffer, rawKeyB64, ivB64) {
  const rawKey = Uint8Array.from(atob(rawKeyB64), (c) => c.charCodeAt(0));
  const iv = Uint8Array.from(atob(ivB64), (c) => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['decrypt']);
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv }, cryptoKey, ciphertextBuffer);
}
function isAttachmentDescriptor(text) {
  if (!text || text[0] !== '{') return null;
  try {
    const obj = JSON.parse(text);
    return obj && obj.__lvoAttachment ? obj : null;
  } catch {
    return null;
  }
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
  const { ciphertext, rawKeyB64, ivB64 } = await encryptBufferForDm(buf);
  const data = await api('/dm-files/upload', {
    method: 'POST',
    token: session.token,
    rawBody: ciphertext,
    headers: { 'X-To': peerId },
  });
  return {
    storageKey: data.key,
    size: data.size,
    filename: file.name,
    mime: file.type || 'application/octet-stream',
    rawKeyB64,
    ivB64,
  };
}

// Resolves an attachment descriptor to a displayable/downloadable blob URL.
// `attachment.localUrl` is used for a file the current user just sent
// (we already have the plaintext bytes, no need to round-trip the server).
// `attachment.gifUrl` is used for GIPHY picks — GIPHY's CDN URL is used
// directly, same trust tier as any other external image link.
async function resolveAttachmentUrl(attachment, isChannel) {
  if (attachment.gifUrl) return attachment.gifUrl;
  if (attachment.localUrl) return attachment.localUrl;
  if (isChannel) return getChannelFileBlobUrl(attachment.key);
  const res = await fetch(`${SERVER_URL}/files/${encodeURIComponent(attachment.storageKey)}`, {
    headers: { Authorization: `Bearer ${session.token}` },
  });
  if (!res.ok) throw new Error('Could not load attachment.');
  const ciphertext = await res.arrayBuffer();
  const plaintext = await decryptDmFileBuffer(ciphertext, attachment.cryptoKey, attachment.iv);
  const blob = new Blob([plaintext], { type: attachment.mime || 'application/octet-stream' });
  return URL.createObjectURL(blob);
}

function renderAttachmentInto(container, attachment, isChannel) {
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
  fileBox.classList.remove('hidden'); // shown as the fallback / loading state
  container.appendChild(node);

  resolveAttachmentUrl(attachment, isChannel)
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
      // 'file' kind keeps the fallback file-chip visible with a working download link.
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
// GIFs (GIPHY) — sent as an attachment carrying a direct gifUrl, so no
// upload/download round-trip through your server or DM encryption is
// needed (same trust model as any other external image link/embed).
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
  els['gif-modal'].classList.add('hidden');
  try {
    if (selectedChannelId) {
      sendChannelMessage(selectedChannelId, '', { gifUrl: url, filename: title || 'GIF', mime: 'image/gif' });
      // socket listener renders the server echo — same as file attachments.
    } else if (selectedPeerId) {
      const descriptor = { __lvoAttachment: true, gifUrl: url, filename: title || 'GIF', mime: 'image/gif' };
      await client.sendMessage(selectedPeerId, JSON.stringify(descriptor));
      const ts = Date.now();
      renderMessage(
        { id: `local-${ts}`, from: session.user.id, text: '', attachment: { gifUrl: url, filename: title || 'GIF', mime: 'image/gif' }, reactions: {}, ts },
        'mine', selectedPeerId, false
      );
      await appendHistory(selectedPeerId, { from: session.user.id, text: JSON.stringify(descriptor), ts });
      await idbSet(`client:${session.user.id}`, client.export());
      scheduleBackupPush();
    }
  } catch (e) {
    addBubble(`Failed to send GIF: ${e.message}`, 'system');
  }
}

// ---------------------------------------------------------------------
// reactions (channels only — the current backend has no DM reaction path)
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
  await ensureEmojiPicker(); // no-op after the first call — see PERFORMANCE NOTE at top of file
  reactionPickerCtx = { channelId, messageId };
  const picker = els['reaction-picker'];
  const margin = 10;

  // Reveal off-screen first so we can measure its real size (it's
  // display:none via .hidden, which reports 0x0), then place it, then
  // make it visible — all before the next paint, so there's no flash.
  picker.style.visibility = 'hidden';
  picker.classList.remove('hidden');
  picker.style.position = 'fixed';
  picker.style.top = '0px';
  picker.style.left = '0px';

  const anchorRect = anchorEl.getBoundingClientRect();
  const pickerRect = picker.getBoundingClientRect();

  // Prefer opening below the message; flip above it if there isn't
  // room, so it never gets pinned to the bottom of the screen.
  let top = anchorRect.bottom + 6;
  if (top + pickerRect.height + margin > window.innerHeight) {
    top = anchorRect.top - pickerRect.height - 6;
  }
  top = Math.max(margin, Math.min(top, window.innerHeight - pickerRect.height - margin));

  // Center it on the anchor horizontally, clamped to stay on-screen.
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
// Full emoji set via the emoji-picker-element web component, replacing
// the old hardcoded 6-button row.
const emojiPickerEl = document.getElementById('emoji-picker-el');
emojiPickerEl && emojiPickerEl.addEventListener('emoji-click', (e) => {
  const emoji = e.detail.unicode;
  if (reactionPickerCtx && emoji) sendReaction(reactionPickerCtx.channelId, reactionPickerCtx.messageId, emoji);
  closeReactionPicker();
});

// ---------------------------------------------------------------------
// message rendering (Telegram/Instagram-style bubble: avatar, author,
// text, attachments, reaction pills, hover-to-react, and consecutive
// messages from the same sender grouped together with the repeat
// avatar/name hidden)
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
  } else {
    textEl.classList.add('hidden');
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
    // Double-tap/double-click a bubble to heart it, same gesture as Instagram DMs.
    node.querySelector('.message-bubble').addEventListener('dblclick', () => sendReaction(scopeId, msg.id, '❤️'));
  } else {
    reactionsEl.classList.add('hidden');
    reactBtn.remove(); // no DM reaction path in the current backend
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
  channelMessageEls = {}; // only the currently-open channel's messages are tracked for live reaction updates
  closeReactionPicker();
  renderRoster();
  renderChannels();
  openChatPaneMobile();

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
  await loadScriptOnce('sdk/e2ee-sdk.bundle.js'); // see PERFORMANCE NOTE at top of file
  await window.E2EE.crypto.ready();
  const storageKey = `client:${session.user.id}`;
  let saved = await idbGet(storageKey);
  if (!saved) {
    // No local identity on this device yet. Before generating a brand new
    // one (which would leave this device unable to read any existing DM
    // history/sessions), see if there's a cross-device backup to restore.
    let pw = sessionPassword;
    if (!pw) {
      // We got here via a persisted session token rather than a fresh
      // login (e.g. this device's IndexedDB was cleared but localStorage
      // wasn't) — no password in memory. Only bother asking for one if a
      // backup actually exists; otherwise this is genuinely a first-ever
      // device and there's nothing to restore.
      try {
        await api('/me/backup', { token: session.token });
        pw = prompt('This device has no local secure-line history yet. Enter your password to restore it from your account backup:') || null;
      } catch {
        pw = null;
      }
    }
    if (pw) {
      const restored = await tryRestoreFromServerBackup(pw);
      if (restored) {
        sessionPassword = pw;
        saved = await idbGet(storageKey);
      }
    }
  }

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
        renderMessage(
          { id: payload.id, from: payload.from, fromName: payload.fromName, text: payload.text, attachment: payload.attachment, reactions: {}, ts: payload.ts },
          payload.from === session.user.id ? 'mine' : 'theirs',
          payload.channelId,
          true
        );
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
    if (payload.type === 'room_error') {
      if (selectedChannelId === payload.channelId) {
        els['composer-error'].textContent = payload.error;
      }
      return;
    }
  });

  client = new window.E2EE.E2EEClient(session.user.id, transportBundle.transport);
  client.onMessage = async (from, text) => {
    const ts = Date.now();
    await appendHistory(from, { from, text, ts });
    if (from === selectedPeerId) renderDmHistoryEntry({ from, text, ts });
    await idbSet(storageKey, client.export());
    scheduleBackupPush();
  };

  if (saved) {
    await client.restore(saved);
  } else {
    await client.init();
  }
  await idbSet(storageKey, client.export());
  scheduleBackupPush(); // make sure a backup exists even before the first message is sent/received
}

// A DM "message" from the wire is either plain chat text, or a JSON
// attachment descriptor (see uploadDmFile / sendCurrentMessage / sendGif)
// — this tells the two apart and renders whichever it is.
function renderDmHistoryEntry(entry) {
  const kind = entry.from === session.user.id ? 'mine' : 'theirs';
  const descriptor = isAttachmentDescriptor(entry.text);
  if (descriptor) {
    renderMessage(
      {
        id: `${entry.ts}-${entry.from}`,
        from: entry.from,
        text: '',
        attachment: descriptor.gifUrl
          ? { gifUrl: descriptor.gifUrl, filename: descriptor.filename, mime: descriptor.mime }
          : {
              storageKey: descriptor.storageKey,
              filename: descriptor.filename,
              mime: descriptor.mime,
              size: descriptor.size,
              cryptoKey: descriptor.cryptoKey,
              iv: descriptor.iv,
            },
        reactions: {},
        ts: entry.ts,
      },
      kind,
      selectedPeerId,
      false
    );
  } else {
    renderMessage({ id: `${entry.ts}-${entry.from}`, from: entry.from, text: entry.text, reactions: {}, ts: entry.ts }, kind, selectedPeerId, false);
  }
}

async function selectPeer(peerId) {
  selectedPeerId = peerId;
  selectedChannelId = null;
  closeReactionPicker();
  renderRoster();
  renderChannels();
  openChatPaneMobile();
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
    renderDmHistoryEntry(entry);
  }
}

async function sendCurrentMessage() {
  const text = els['composer-input'].value.trim();
  const files = pendingFiles.slice();
  if (!text && files.length === 0) return;
  if (!selectedPeerId && !selectedChannelId) return;

  els['composer-input'].value = '';
  clearPendingFiles();
  updateSendButtonState();
  els['composer-send'].disabled = true;
  els['composer-error'].textContent = '';
  try {
    if (selectedChannelId) {
      // channel_messages.attachment_json holds exactly one attachment per
      // row, so each file goes out as its own message; any typed text
      // rides along on the last one.
      if (files.length > 0) {
        for (let i = 0; i < files.length; i++) {
          const uploaded = await uploadChannelFile(selectedChannelId, files[i]);
          sendChannelMessage(selectedChannelId, i === files.length - 1 ? text : '', uploaded);
        }
      } else {
        sendChannelMessage(selectedChannelId, text);
      }
      // Do not render here: the server echoes every room_message back to
      // all channel members (including the sender), and the socket listener
      // already renders it. Rendering it here too caused duplicates.
    } else if (files.length > 0) {
      for (const file of files) {
        const uploaded = await uploadDmFile(selectedPeerId, file);
        const descriptor = {
          __lvoAttachment: true,
          storageKey: uploaded.storageKey,
          filename: uploaded.filename,
          mime: uploaded.mime,
          size: uploaded.size,
          cryptoKey: uploaded.rawKeyB64,
          iv: uploaded.ivB64,
        };
        await client.sendMessage(selectedPeerId, JSON.stringify(descriptor));
        const ts = Date.now();
        renderMessage(
          { id: `local-${ts}-${Math.random()}`, from: session.user.id, text: '', attachment: { filename: uploaded.filename, mime: uploaded.mime, size: uploaded.size, localUrl: URL.createObjectURL(file) }, reactions: {}, ts },
          'mine',
          selectedPeerId,
          false
        );
        await appendHistory(selectedPeerId, { from: session.user.id, text: JSON.stringify(descriptor), ts });
      }
      if (text) {
        await client.sendMessage(selectedPeerId, text);
        const ts = Date.now();
        renderMessage({ id: `local-${ts}`, from: session.user.id, text, reactions: {}, ts }, 'mine', selectedPeerId, false);
        await appendHistory(selectedPeerId, { from: session.user.id, text, ts });
      }
      await idbSet(`client:${session.user.id}`, client.export());
      scheduleBackupPush();
    } else {
      await client.sendMessage(selectedPeerId, text);
      const ts = Date.now();
      renderMessage({ id: `local-${ts}`, from: session.user.id, text, reactions: {}, ts }, 'mine', selectedPeerId, false);
      await appendHistory(selectedPeerId, { from: session.user.id, text, ts });
      await idbSet(`client:${session.user.id}`, client.export());
      scheduleBackupPush();
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
// settings popover (bottom-left of the rail): change picture, admin
// panel link (admins only), log out — replaces the old two-button footer
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
  closeChatPaneMobile(); // land on the roster/channel list first on mobile, not a stale chat view
  els['me-name'].textContent = session.user.displayName;
  renderAvatar(els['me-avatar'], session.user.id, session.user.avatar, session.user.displayName);
  if (session.user.role === 'admin') {
    els['leader-badge'].classList.remove('hidden');
    els['admin-link'].classList.remove('hidden');
  }
  // Quietly prefetch the emoji picker now that we're past the login
  // screen, so it's already warm the first time someone opens a
  // reaction picker instead of them waiting on it mid-interaction.
  ensureEmojiPicker().catch(() => {});
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
  // Load the roster first: it's what populates presetsById, which
  // renderAvatar() (called inside showApp()) depends on to resolve a
  // preset-type avatar. Rendering before this resolved was causing the
  // avatar to silently fall back to the letter-avatar look on every load.
  await loadRoster();
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
    // Kept in memory only (never localStorage/IndexedDB) so this device can
    // restore a cross-device backup if it has no local history yet, and so
    // it can push its own backup as this session goes on. See initClient().
    sessionPassword = typedPassword;
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
    sessionPassword = newPassword; // this device now holds the account's real password — good for backup restore/push
    els['pwd-modal'].classList.add('hidden');
    await loadRoster();
    showApp();
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
els['composer-input'].addEventListener('input', updateSendButtonState);

// ---- logout ----
els['logout-btn'].addEventListener('click', () => {
  if (socket) socket.close();
  clearSession();
  session = null;
  client = null;
  sessionPassword = null;
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
