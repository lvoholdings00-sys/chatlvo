const SERVER_URL = 'https://lvo-chat-relay.lvoholdings00.workers.dev'; // keep in sync with app.js
const SESSION_KEY = 'lvo_session';

function loadSession() {
  try {
    return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
  } catch {
    return null;
  }
}

async function api(path, { method = 'GET', body, token } = {}) {
  const headers = { Authorization: `Bearer ${token}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${SERVER_URL}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

const session = loadSession();
const els = {};
['not-admin', 'admin-content', 'new-username', 'new-displayname', 'new-password', 'create-btn', 'create-error', 'user-list']
  .forEach((id) => (els[id] = document.getElementById(id)));

function fmtDate(ms) {
  return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
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
  } catch (e) {
    alert(e.message);
  }
}

els['create-btn'].addEventListener('click', async () => {
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

async function boot() {
  if (!session) {
    els['not-admin'].classList.remove('hidden');
    return;
  }
  try {
    const me = await api('/me', { token: session.token });
    if (me.user.role !== 'admin') {
      els['not-admin'].classList.remove('hidden');
      return;
    }
    session.user = me.user;
  } catch {
    els['not-admin'].classList.remove('hidden');
    return;
  }
  els['admin-content'].classList.remove('hidden');
  await refreshUserList();
}

boot();
