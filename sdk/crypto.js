/**
 * crypto.js — X3DH key agreement + Double Ratchet, built on libsodium.
 *
 * This is a from-scratch implementation of the ideas behind the Signal
 * Protocol (X3DH + Double Ratchet), not a copy of Signal's source code.
 * It has NOT been externally audited. Before using this with real user
 * data, get it reviewed by a cryptography professional — see README.md
 * "Before you go to production".
 *
 * Design choices, documented so a reviewer can check them quickly:
 *  - X25519 for all Diffie-Hellman key agreement.
 *  - Ed25519 for signing the signed prekey (identity keys double as
 *    signing keys via libsodium's sign<->box conversion).
 *  - BLAKE2b (crypto_generichash) in keyed mode as the KDF/HMAC
 *    primitive instead of HMAC-SHA256. BLAKE2b keyed mode is a
 *    documented, safe way to use it as a MAC/KDF, and it's built into
 *    libsodium's JS bindings with no extra dependency.
 *  - XChaCha20-Poly1305 (AEAD) for actual message encryption, with the
 *    message header as associated data (so headers are authenticated
 *    but not encrypted).
 *
 * Known simplifications vs. a production Signal-Protocol implementation:
 *  - No handling of out-of-order / skipped messages (no skipped-message
 *    key cache). Messages must currently arrive in order or they fail
 *    to decrypt. This is the single biggest gap to close before
 *    production use on unreliable networks.
 *  - No multi-device fan-out. One identity key pair = one device.
 */

let sodium = null;

/** Call once before using anything else. Works in Node or browser. */
async function ready() {
  if (sodium) return sodium;
  if (typeof window !== 'undefined' && window.sodium) {
    await window.sodium.ready;
    sodium = window.sodium;
  } else {
    sodium = require('libsodium-wrappers');
    await sodium.ready;
  }
  return sodium;
}

// ---------- encoding helpers ----------

const b64 = (bytes) => sodium.to_base64(bytes, sodium.base64_variants.URLSAFE_NO_PADDING);
const unb64 = (str) => sodium.from_base64(str, sodium.base64_variants.URLSAFE_NO_PADDING);

// ---------- identity / prekeys ----------

/**
 * Generates a long-term identity for a user:
 *  - an Ed25519 signing keypair (identity key, used to prove ownership
 *    of the signed prekey)
 *  - an X25519 keypair derived from it, used for the actual DH math
 */
function generateIdentity() {
  const sign = sodium.crypto_sign_keypair();
  return {
    signPublicKey: b64(sign.publicKey),
    signPrivateKey: b64(sign.privateKey),
    dhPublicKey: b64(sodium.crypto_sign_ed25519_pk_to_curve25519(sign.publicKey)),
    dhPrivateKey: b64(sodium.crypto_sign_ed25519_sk_to_curve25519(sign.privateKey)),
  };
}

/** Signed prekey: rotated periodically (e.g. weekly) by the client. */
function generateSignedPrekey(identity) {
  const kp = sodium.crypto_box_keypair();
  const sig = sodium.crypto_sign_detached(kp.publicKey, unb64(identity.signPrivateKey));
  return {
    keyId: b64(sodium.randombytes_buf(8)),
    publicKey: b64(kp.publicKey),
    privateKey: b64(kp.privateKey),
    signature: b64(sig),
  };
}

/** One-time prekeys: a batch is uploaded to the server; each is used once. */
function generateOneTimePrekeys(count = 20) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const kp = sodium.crypto_box_keypair();
    out.push({ keyId: b64(sodium.randombytes_buf(8)), publicKey: b64(kp.publicKey), privateKey: b64(kp.privateKey) });
  }
  return out;
}

/** What gets published to the key server (no private keys). */
function publicBundle(identity, signedPrekey, oneTimePrekeys) {
  return {
    identityKey: identity.dhPublicKey,
    identitySignKey: identity.signPublicKey,
    signedPrekey: { keyId: signedPrekey.keyId, publicKey: signedPrekey.publicKey, signature: signedPrekey.signature },
    oneTimePrekeys: oneTimePrekeys.map((k) => ({ keyId: k.keyId, publicKey: k.publicKey })),
  };
}

function verifyBundle(bundle) {
  return sodium.crypto_sign_verify_detached(
    unb64(bundle.signedPrekey.signature),
    unb64(bundle.signedPrekey.publicKey),
    unb64(bundle.identitySignKey)
  );
}

// ---------- KDF helpers (BLAKE2b keyed) ----------

function kdf(key, data, outLen = 32) {
  return sodium.crypto_generichash(outLen, data, key);
}

/** HKDF-ish: expand a shared secret into a root key + first chain key. */
function kdfRootKey(rootKey, dhOutput) {
  const out = kdf(rootKey, dhOutput, 64);
  return { rootKey: out.slice(0, 32), chainKey: out.slice(32, 64) };
}

/** Advance a symmetric ratchet chain: returns next chain key + message key. */
function kdfChainKey(chainKey) {
  const nextChainKey = kdf(chainKey, new Uint8Array([0x02]), 32);
  const messageKey = kdf(chainKey, new Uint8Array([0x01]), 32);
  return { nextChainKey, messageKey };
}

// ---------- X3DH: initial handshake ----------

/**
 * Alice initiates a session with Bob using Bob's public bundle.
 * Returns { sharedSecret, ephemeralPublicKey, usedOneTimePrekeyId }
 * to be sent alongside the first message.
 */
function x3dhInitiate(myIdentity, theirBundle) {
  if (!verifyBundle(theirBundle)) throw new Error('Prekey signature verification failed — possible tampering.');

  const IK_A = unb64(myIdentity.dhPrivateKey);
  const EK_A = sodium.crypto_box_keypair();
  const IK_B = unb64(theirBundle.identityKey);
  const SPK_B = unb64(theirBundle.signedPrekey.publicKey);

  const dh1 = sodium.crypto_scalarmult(IK_A, SPK_B);
  const dh2 = sodium.crypto_scalarmult(EK_A.privateKey, IK_B);
  const dh3 = sodium.crypto_scalarmult(EK_A.privateKey, SPK_B);

  let dh4 = new Uint8Array(0);
  let usedOneTimePrekeyId = null;
  if (theirBundle.oneTimePrekeys && theirBundle.oneTimePrekeys.length > 0) {
    const opk = theirBundle.oneTimePrekeys[0];
    dh4 = sodium.crypto_scalarmult(EK_A.privateKey, unb64(opk.publicKey));
    usedOneTimePrekeyId = opk.keyId;
  }

  const combined = new Uint8Array(dh1.length + dh2.length + dh3.length + dh4.length);
  combined.set(dh1, 0);
  combined.set(dh2, dh1.length);
  combined.set(dh3, dh1.length + dh2.length);
  combined.set(dh4, dh1.length + dh2.length + dh3.length);

  const sharedSecret = kdf(new Uint8Array(32), combined, 32); // salt = 32 zero bytes

  return {
    sharedSecret,
    ephemeralPublicKey: b64(EK_A.publicKey),
    usedOneTimePrekeyId,
    theirIdentityDhKey: theirBundle.identityKey,
    theirSignedPrekeyId: theirBundle.signedPrekey.keyId,
  };
}

/**
 * Bob completes the handshake once he receives Alice's first message,
 * using his own stored private keys for the signed prekey (and the
 * one-time prekey, if Alice used one — it must then be deleted).
 */
function x3dhRespond(myIdentity, mySignedPrekeyPrivate, myOneTimePrekeyPrivate, theirIdentityDhKeyB64, ephemeralPublicKeyB64) {
  const IK_B = unb64(myIdentity.dhPrivateKey);
  const SPK_B = unb64(mySignedPrekeyPrivate);
  const IK_A = unb64(theirIdentityDhKeyB64);
  const EK_A = unb64(ephemeralPublicKeyB64);

  const dh1 = sodium.crypto_scalarmult(SPK_B, IK_A);
  const dh2 = sodium.crypto_scalarmult(IK_B, EK_A);
  const dh3 = sodium.crypto_scalarmult(SPK_B, EK_A);

  let dh4 = new Uint8Array(0);
  if (myOneTimePrekeyPrivate) {
    dh4 = sodium.crypto_scalarmult(unb64(myOneTimePrekeyPrivate), EK_A);
  }

  const combined = new Uint8Array(dh1.length + dh2.length + dh3.length + dh4.length);
  combined.set(dh1, 0);
  combined.set(dh2, dh1.length);
  combined.set(dh3, dh1.length + dh2.length);
  combined.set(dh4, dh1.length + dh2.length + dh3.length);

  return kdf(new Uint8Array(32), combined, 32);
}

// ---------- Double Ratchet ----------

/**
 * Creates the initial ratchet state for the party who INITIATED the
 * session (Alice). She generates a fresh DH ratchet keypair right away.
 */
function ratchetInitSender(sharedSecret, theirRatchetPublicKeyB64) {
  const dhSelf = sodium.crypto_box_keypair();
  const dhOutput = sodium.crypto_scalarmult(dhSelf.privateKey, unb64(theirRatchetPublicKeyB64));
  const { rootKey, chainKey } = kdfRootKey(sharedSecret, dhOutput);
  return {
    rootKey: b64(rootKey),
    dhSelfPublicKey: b64(dhSelf.publicKey),
    dhSelfPrivateKey: b64(dhSelf.privateKey),
    dhTheirPublicKey: theirRatchetPublicKeyB64,
    sendChainKey: b64(chainKey),
    recvChainKey: null,
    sendCount: 0,
    recvCount: 0,
  };
}

/**
 * Creates the initial ratchet state for the party who RECEIVED the
 * session request (Bob). His signed prekey pair doubles as his first
 * ratchet keypair — he'll rotate on the first message he sends.
 */
function ratchetInitReceiver(sharedSecret, mySignedPrekeyPublicB64, mySignedPrekeyPrivateB64) {
  return {
    rootKey: b64(sharedSecret),
    dhSelfPublicKey: mySignedPrekeyPublicB64,
    dhSelfPrivateKey: mySignedPrekeyPrivateB64,
    dhTheirPublicKey: null,
    sendChainKey: null,
    recvChainKey: null,
    sendCount: 0,
    recvCount: 0,
  };
}

function dhRatchetStep(state, theirNewPublicKeyB64) {
  // Receiving chain: derive from our current private key + their new public key.
  const dhRecv = sodium.crypto_scalarmult(unb64(state.dhSelfPrivateKey), unb64(theirNewPublicKeyB64));
  const { rootKey: rk1, chainKey: recvChainKey } = kdfRootKey(unb64(state.rootKey), dhRecv);

  // Sending chain: generate a fresh keypair, derive from it + their new public key.
  const newSelf = sodium.crypto_box_keypair();
  const dhSend = sodium.crypto_scalarmult(newSelf.privateKey, unb64(theirNewPublicKeyB64));
  const { rootKey: rk2, chainKey: sendChainKey } = kdfRootKey(rk1, dhSend);

  return {
    rootKey: b64(rk2),
    dhSelfPublicKey: b64(newSelf.publicKey),
    dhSelfPrivateKey: b64(newSelf.privateKey),
    dhTheirPublicKey: theirNewPublicKeyB64,
    sendChainKey: b64(sendChainKey),
    recvChainKey: b64(recvChainKey),
    sendCount: 0,
    recvCount: 0,
  };
}

/**
 * Encrypts one message. Mutates and returns the new state alongside
 * the wire envelope to send.
 */
function encrypt(state, plaintextBytes) {
  const { nextChainKey, messageKey } = kdfChainKey(unb64(state.sendChainKey));
  const header = {
    dhPublicKey: state.dhSelfPublicKey,
    n: state.sendCount,
  };
  const aad = sodium.from_string(JSON.stringify(header));
  const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(plaintextBytes, aad, null, nonce, messageKey);

  const newState = { ...state, sendChainKey: b64(nextChainKey), sendCount: state.sendCount + 1 };
  const envelope = { header, nonce: b64(nonce), ciphertext: b64(ciphertext) };
  return { newState, envelope };
}

/**
 * Decrypts one message. If the envelope's header carries a new ratchet
 * public key we haven't seen, performs a DH ratchet step first.
 * NOTE: assumes in-order delivery within a chain (see file header).
 */
function decrypt(state, envelope) {
  let s = state;
  if (envelope.header.dhPublicKey !== s.dhTheirPublicKey) {
    s = dhRatchetStep(s, envelope.header.dhPublicKey);
  }
  const { nextChainKey, messageKey } = kdfChainKey(unb64(s.recvChainKey));
  const aad = sodium.from_string(JSON.stringify(envelope.header));
  const plaintextBytes = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null,
    unb64(envelope.ciphertext),
    aad,
    unb64(envelope.nonce),
    messageKey
  );
  const newState = { ...s, recvChainKey: b64(nextChainKey), recvCount: s.recvCount + 1 };
  return { newState, plaintextBytes };
}

module.exports = {
  ready,
  b64,
  unb64,
  generateIdentity,
  generateSignedPrekey,
  generateOneTimePrekeys,
  publicBundle,
  verifyBundle,
  x3dhInitiate,
  x3dhRespond,
  ratchetInitSender,
  ratchetInitReceiver,
  encrypt,
  decrypt,
};
