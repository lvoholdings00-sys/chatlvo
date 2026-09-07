/**
 * client.js — high-level session management on top of crypto.js.
 *
 * This module knows nothing about WebSockets or HTTP; you hand it a
 * `transport` object with three async functions:
 *
 *   uploadBundle(userId, bundle)        -> publish your public keys
 *   fetchBundle(userId)                 -> fetch someone else's public keys
 *                                          (server MUST delete the returned
 *                                          one-time prekey after handing it out)
 *   send(toUserId, envelope)            -> hand a ciphertext envelope to the relay
 *
 * Incoming envelopes are pushed in from outside via `client.receive(...)`,
 * e.g. from a WebSocket `message` handler.
 *
 * All session state lives in `client.sessions[peerId]` and in
 * `client.identity` / `client.signedPrekey` / `client.oneTimePrekeys`.
 * Persist these (encrypted at rest, ideally) if you need the session to
 * survive a page reload — see README for the storage discussion.
 */

const crypto = require('./crypto');

class E2EEClient {
  constructor(userId, transport) {
    this.userId = userId;
    this.transport = transport;
    this.identity = null;
    this.signedPrekey = null;
    this.oneTimePrekeys = [];
    this.sessions = {}; // peerId -> ratchet state
    this.pendingHandshake = {}; // peerId -> { ephemeralPublicKey, usedOneTimePrekeyId } while we're the initiator waiting to derive sendChain
    this.onMessage = null; // set by caller: (fromUserId, plaintextString) => void
  }

  /** Call once per device, first time this user ever uses the app. */
  async init() {
    await crypto.ready();
    this.identity = crypto.generateIdentity();
    this.signedPrekey = crypto.generateSignedPrekey(this.identity);
    this.oneTimePrekeys = crypto.generateOneTimePrekeys(20);
    const bundle = crypto.publicBundle(this.identity, this.signedPrekey, this.oneTimePrekeys);
    await this.transport.uploadBundle(this.userId, bundle);
  }

  /** Restore from previously-persisted key material instead of generating new. */
  async restore(saved) {
    await crypto.ready();
    this.identity = saved.identity;
    this.signedPrekey = saved.signedPrekey;
    this.oneTimePrekeys = saved.oneTimePrekeys || [];
    this.sessions = saved.sessions || {};
  }

  /** Everything needed to restore this client later. Persist this, encrypted. */
  export() {
    return {
      identity: this.identity,
      signedPrekey: this.signedPrekey,
      oneTimePrekeys: this.oneTimePrekeys,
      sessions: this.sessions,
    };
  }

  /** Starts (or reuses) a session with peerId and sends one message. */
  async sendMessage(peerId, plaintext) {
    if (!this.sessions[peerId]) {
      await this._startSession(peerId);
    }
    const state = this.sessions[peerId];
    const { newState, envelope } = crypto.encrypt(state, Buffer.from(plaintext, 'utf8'));
    this.sessions[peerId] = newState;

    const isFirstMessage = !!this.pendingHandshake[peerId];
    const wire = isFirstMessage
      ? { type: 'prekey_message', handshake: this.pendingHandshake[peerId], envelope, from: this.userId }
      : { type: 'message', envelope, from: this.userId };
    if (isFirstMessage) delete this.pendingHandshake[peerId];

    await this.transport.send(peerId, wire);
  }

  async _startSession(peerId) {
    const theirBundle = await this.transport.fetchBundle(peerId);
    const handshakeResult = crypto.x3dhInitiate(this.identity, theirBundle);
    const initialRatchetState = crypto.ratchetInitSender(handshakeResult.sharedSecret, theirBundle.signedPrekey.publicKey);
    this.sessions[peerId] = initialRatchetState;
    this.pendingHandshake[peerId] = {
      ephemeralPublicKey: handshakeResult.ephemeralPublicKey,
      usedOneTimePrekeyId: handshakeResult.usedOneTimePrekeyId,
      identityKey: this.identity.dhPublicKey,
      identitySignKey: this.identity.signPublicKey,
      signedPrekeyId: theirBundle.signedPrekey.keyId,
    };
  }

  /** Feed an incoming wire message in. Fires this.onMessage on success. */
  async receive(wire) {
    let state = this.sessions[wire.from];

    if (wire.type === 'prekey_message') {
      // Glare: both sides independently called _startSession() for each
      // other around the same time (e.g. right after both reset a broken
      // session) before either had received the other's prekey_message.
      // Without a tie-break, each side would just overwrite its session
      // with whatever it receives, and there's no guarantee both sides
      // converge on the SAME chain — leaving A permanently keyed to "B's
      // initiation" and B permanently keyed to "A's initiation": two
      // chains, neither matching what the other side actually has.
      // Deterministically pick one initiator (higher identityKey wins,
      // evaluated identically on both sides since it's a plain string
      // compare of the same two keys) so both sides always land on the
      // same single chain. The loser's in-flight message in this exact
      // wire is unrecoverable (it was encrypted under a shared secret
      // the winner never derives) and surfaces as a normal decrypt
      // failure to the caller — everything sent after this resolves.
      if (this.pendingHandshake[wire.from]) {
        const weWin = this.identity.dhPublicKey > wire.handshake.identityKey;
        if (weWin) {
          throw new Error('Discarded a simultaneous handshake attempt (glare) — keeping our own session as initiator.');
        }
        delete this.pendingHandshake[wire.from]; // we lose the tie: abandon our own half-started session
      }
      const otp = this.oneTimePrekeys.find((k) => k.keyId === wire.handshake.usedOneTimePrekeyId);
      const sharedSecret = crypto.x3dhRespond(
        this.identity,
        this.signedPrekey.privateKey,
        otp ? otp.privateKey : null,
        wire.handshake.identityKey,
        wire.handshake.ephemeralPublicKey
      );
      if (otp) this.oneTimePrekeys = this.oneTimePrekeys.filter((k) => k.keyId !== otp.keyId); // one-time = one use
      state = crypto.ratchetInitReceiver(sharedSecret, this.signedPrekey.publicKey, this.signedPrekey.privateKey);
    }

    if (!state) throw new Error(`No session with ${wire.from} and this wasn't a handshake message.`);

    const { newState, plaintextBytes } = crypto.decrypt(state, wire.envelope);
    this.sessions[wire.from] = newState;
    const text = Buffer.from(plaintextBytes).toString('utf8');
    if (this.onMessage) this.onMessage(wire.from, text);
    return text;
  }
}

module.exports = { E2EEClient };
