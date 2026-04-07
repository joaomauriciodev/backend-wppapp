const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const { pool } = require('../config/database');
const { generateReply } = require('../config/gemini');

const clients      = new Map();
const clientStatus = new Map();
const clientQR     = new Map();

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Resolve sender's real phone number (handles @lid and @c.us)
const resolveContactNumber = async (msg, client) => {
  try {
    const contact = await msg.getContact();
    if (contact.number) {
      const num = contact.number.replace(/\D/g, '');
      console.log(`[msg] resolved phone via getContact(): ${num}`);
      return num;
    }
  } catch (e) {
    console.log(`[msg] getContact() failed: ${e.message}`);
  }
  const from = msg.author || msg.from || '';
  if (from.endsWith('@c.us')) {
    const num = from.split('@')[0].replace(/\D/g, '');
    console.log(`[msg] resolved phone via @c.us fallback: ${num}`);
    return num;
  }
  console.log(`[msg] could not resolve phone from: ${from}`);
  return null;
};

// Lookup active rule by normalized phone number
const findRuleByNumber = async (userId, phoneNumber, isGroup) => {
  if (!phoneNumber) return null;
  const normalized = phoneNumber.replace(/\D/g, '');
  const result = await pool.query(
    `SELECT * FROM auto_reply_rules
     WHERE user_id = $1
       AND REGEXP_REPLACE(contact_phone, '[^0-9]', '', 'g') = $2
       AND active = TRUE
       AND (
         scope = 'both'
         OR (scope = 'private' AND $3 = FALSE)
         OR (scope = 'groups'  AND $3 = TRUE)
       )
     LIMIT 1`,
    [userId, normalized, isGroup]
  );
  if (result.rows.length) {
    console.log(`[msg] rule matched: id=${result.rows[0].id} tone=${result.rows[0].tone} delay=${result.rows[0].reply_delay}s`);
  } else {
    console.log(`[msg] no active rule for phone=${normalized} isGroup=${isGroup} userId=${userId}`);
  }
  return result.rows[0] || null;
};

// ─── Client init ──────────────────────────────────────────────────────────────
const initWhatsAppClient = async (userId) => {
  if (clients.has(userId)) {
    const status = clientStatus.get(userId);
    if (status === 'ready') {
      console.log(`[wa] user ${userId} already connected, skipping init`);
      return;
    }
    console.log(`[wa] destroying stale client for user ${userId} (status=${status})`);
    try { await clients.get(userId).destroy(); } catch (e) {}
    clients.delete(userId);
    clientQR.delete(userId);
  }

  console.log(`[wa] initializing client for user ${userId}`);
  clientStatus.set(userId, 'initializing');

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: `user_${userId}` }),
    puppeteer: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    },
  });

  clients.set(userId, client);

  client.on('qr', async (qr) => {
    console.log(`[wa] QR generated for user ${userId}`);
    clientStatus.set(userId, 'qr');
    try { clientQR.set(userId, await qrcode.toDataURL(qr)); }
    catch (err) { console.error(`[wa] QR toDataURL error:`, err.message); }
  });

  client.on('authenticated', () => {
    console.log(`[wa] authenticated for user ${userId}`);
    clientStatus.set(userId, 'authenticated');
    clientQR.delete(userId);
  });

  client.on('ready', async () => {
    console.log(`[wa] ✅ ready for user ${userId}`);
    clientStatus.set(userId, 'ready');
    clientQR.delete(userId);
    await pool.query(
      'UPDATE users SET whatsapp_connected = TRUE, updated_at = NOW() WHERE id = $1',
      [userId]
    );
  });

  // ─── Debounce buffer ────────────────────────────────────────────────────────
  const pendingReplies = new Map();

  const flushReply = async (bufferKey) => {
    const entry = pendingReplies.get(bufferKey);
    if (!entry) return;
    pendingReplies.delete(bufferKey);

    const { messages, rule, chat } = entry;
    if (!messages.length) return;

    const combined = messages.join('\n');
    console.log(`[flush] key=${bufferKey} msgs=${messages.length} combined="${combined.slice(0, 80)}"`);

    try {
      let history = [];
      try {
        const fetched = await chat.fetchMessages({ limit: 15 });
        const bodySet = new Set(messages);
        history = fetched
          .filter(m => m.body && m.body.trim() && !bodySet.has(m.body))
          .slice(-10)
          .map(m => ({ fromMe: m.fromMe, body: m.body }));
        console.log(`[flush] fetched ${fetched.length} history msgs, using ${history.length}`);
      } catch (e) {
        console.warn(`[flush] fetchMessages failed: ${e.message}`);
      }

      const reply = await generateReply(combined, rule.tone, rule.extra_prompt, rule.contact_name, history, pool, userId);
      console.log(`[flush] sending reply: "${reply.slice(0, 80)}"`);
      await chat.sendMessage(reply);

      await pool.query(
        `INSERT INTO auto_reply_logs (rule_id, user_id, chat_id, incoming_message, outgoing_message, tone)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [rule.id, userId, chat.id._serialized, combined, reply, rule.tone]
      );
      console.log(`[flush] ✅ logged reply for rule ${rule.id}`);
    } catch (err) {
      console.error(`[flush] ❌ error for ${bufferKey}: ${err.message}`);
    }
  };

  // ─── Message listener ────────────────────────────────────────────────────────
  client.on('message', async (msg) => {
    console.log(`\n[msg] ← from=${msg.from} author=${msg.author || '-'} type=${msg.type} body="${(msg.body || '').slice(0, 60)}"`);

    try {
      if (msg.fromMe) {
        console.log(`[msg] skipping — fromMe`);
        return;
      }
      if (!msg.body || msg.body.trim() === '') {
        console.log(`[msg] skipping — empty body (type=${msg.type})`);
        return;
      }

      const chat = await msg.getChat();
      const isGroup = chat.isGroup;
      console.log(`[msg] chat=${chat.id._serialized} isGroup=${isGroup}`);

      const phoneNumber = await resolveContactNumber(msg, client);
      if (!phoneNumber) {
        console.log(`[msg] ⚠ could not resolve phone — skipping`);
        return;
      }

      const rule = await findRuleByNumber(userId, phoneNumber, isGroup);
      if (!rule) {
        console.log(`[msg] no rule matched — ignoring message`);
        return;
      }

      const bufferKey = `${userId}:${chat.id._serialized}`;
      const delayMs   = (rule.reply_delay ?? 5) * 1000;

      if (pendingReplies.has(bufferKey)) {
        const entry = pendingReplies.get(bufferKey);
        clearTimeout(entry.timer);
        entry.messages.push(msg.body);
        entry.timer = setTimeout(() => flushReply(bufferKey), delayMs);
        console.log(`[msg] appended to buffer key=${bufferKey} total=${entry.messages.length} delay=${rule.reply_delay}s`);
      } else {
        const timer = setTimeout(() => flushReply(bufferKey), delayMs);
        pendingReplies.set(bufferKey, { timer, messages: [msg.body], rule, chat });
        console.log(`[msg] new buffer key=${bufferKey} delay=${rule.reply_delay}s`);
      }
    } catch (err) {
      console.error(`[msg] ❌ unhandled error: ${err.message}\n${err.stack}`);
    }
  });
  // ─────────────────────────────────────────────────────────────────────────────

  client.on('auth_failure', async (msg) => {
    console.error(`[wa] ❌ auth_failure for user ${userId}:`, msg);
    clientStatus.set(userId, 'auth_failure');
    clients.delete(userId);
    clientQR.delete(userId);
    await pool.query('UPDATE users SET whatsapp_connected = FALSE, updated_at = NOW() WHERE id = $1', [userId]);
  });

  client.on('disconnected', async (reason) => {
    console.log(`[wa] disconnected for user ${userId}: ${reason}`);
    clientStatus.set(userId, 'disconnected');
    clients.delete(userId);
    clientQR.delete(userId);
    await pool.query('UPDATE users SET whatsapp_connected = FALSE, updated_at = NOW() WHERE id = $1', [userId]);
  });

  client.initialize().catch((err) => {
    console.error(`[wa] ❌ initialize() failed for user ${userId}: ${err.message}`);
    clients.delete(userId);
    clientQR.delete(userId);
    clientStatus.set(userId, 'error');
  });
};

// ─── Send a test message to a phone number (used by test endpoint) ────────────
const sendTestMessage = async (userId, phoneNumber, message) => {
  const client = clients.get(userId);
  if (!client || clientStatus.get(userId) !== 'ready') {
    throw new Error('WhatsApp não está conectado');
  }
  // Format: number@c.us
  const digits = phoneNumber.replace(/\D/g, '');
  const chatId = `${digits}@c.us`;
  console.log(`[test] sending test message to ${chatId}: "${message.slice(0, 60)}"`);
  await client.sendMessage(chatId, message);
  console.log(`[test] ✅ sent`);
};

// ─── Restore sessions on startup ──────────────────────────────────────────────
const restoreActiveSessions = async () => {
  try {
    const result = await pool.query('SELECT id FROM users WHERE whatsapp_connected = TRUE');
    if (result.rows.length === 0) {
      console.log('[wa] no sessions to restore');
      return;
    }
    console.log(`[wa] 🔄 restoring ${result.rows.length} session(s)...`);
    for (const { id } of result.rows) {
      await new Promise(r => setTimeout(r, 1500));
      initWhatsAppClient(id).catch(err =>
        console.error(`[wa] failed to restore session for user ${id}: ${err.message}`)
      );
    }
  } catch (err) {
    console.error('[wa] restoreActiveSessions error:', err.message);
  }
};

const disconnectClient = async (userId) => {
  console.log(`[wa] disconnecting user ${userId}`);
  if (clients.has(userId)) {
    try { await clients.get(userId).destroy(); } catch (e) {}
    clients.delete(userId);
    clientQR.delete(userId);
  }
  clientStatus.set(userId, 'disconnected');
  await pool.query('UPDATE users SET whatsapp_connected = FALSE, updated_at = NOW() WHERE id = $1', [userId]);
};

const getClientStatus = (userId) => clientStatus.get(userId) || 'disconnected';
const getClientQR     = (userId) => clientQR.get(userId) || null;

module.exports = {
  initWhatsAppClient,
  restoreActiveSessions,
  disconnectClient,
  getClientStatus,
  getClientQR,
  sendTestMessage,
};