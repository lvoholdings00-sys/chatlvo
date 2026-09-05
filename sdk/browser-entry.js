const crypto = require('./crypto');
const { E2EEClient } = require('./client');
const { createBrowserTransport } = require('./browser-transport');

window.E2EE = { crypto, E2EEClient, createBrowserTransport };
