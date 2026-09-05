/**
 * browser-transport.js — connects E2EEClient to a real server over
 * fetch() (key server) and WebSocket (relay).
 *
 * Usage (inside a browser):
 *   const { transport, socket } = createBrowserTransport({
 *     serverUrl: 'https://chat.yoursite.com',
 *     userId: 'alice',
 *     authToken: '...',            // your own site's session/auth token
 *     onMessage: (wire) => client.receive(wire),
 *   });
 */
function createBrowserTransport({ serverUrl, userId, authToken, onMessage, onOpen }) {
  const httpBase = serverUrl.replace(/\/$/, '');
  const wsBase = httpBase.replace(/^http/, 'ws');
  const socket = new WebSocket(`${wsBase}/relay`);

  socket.addEventListener('open', () => {
    socket.send(JSON.stringify({ type: 'authenticate', userId, token: authToken }));
  });

  socket.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === 'authenticated') {
      if (onOpen) onOpen();
      return;
    }
    onMessage(msg);
  });

  const transport = {
    async uploadBundle(uid, bundle) {
      const res = await fetch(`${httpBase}/bundles/${encodeURIComponent(uid)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify(bundle),
      });
      if (!res.ok) throw new Error(`Failed to upload bundle: ${res.status}`);
    },
    async fetchBundle(uid) {
      const res = await fetch(`${httpBase}/bundles/${encodeURIComponent(uid)}`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (!res.ok) throw new Error(`Failed to fetch bundle for ${uid}: ${res.status}`);
      return res.json();
    },
    async send(toUserId, wire) {
      socket.send(JSON.stringify({ type: 'send', to: toUserId, wire }));
    },
  };

  return { transport, socket };
}

if (typeof window !== 'undefined') {
  window.createBrowserTransport = createBrowserTransport;
}
if (typeof module !== 'undefined') {
  module.exports = { createBrowserTransport };
}
