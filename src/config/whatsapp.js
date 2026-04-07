const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const { pool } = require('../config/database');
const { generateReply } = require('../config/gemini');

const clients = new Map();
const clientStatus = new Map();
const clientQR = new Map();

// Resolve sender's real phone number from a message (handles @lid and @c.us)
const resolveContactNumber = async (msg, client) => {
  try {
    const contact = await msg.getContact();
    if (contact.number) return contact.number.replace(/\D/g, '');
  } catch (e) {}
  // Fallback: parse @c.us directly (won't work for @lid)
  const from = msg.author || msg.from || '';
  if (from.endsWith('@c.us')) return from.split('@')[0].replace(/\D/g, '');
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
  return result.rows[0] || null;
};

const initWhatsAppClient = async (userId) => {
  if (clients.has(userId)) {
    const status = clientStatus.get(userId);
    if (status === 'ready') return;
    try { await clients.get(userId).destroy(); } catch (e) {}
    clients.delete(userId);
    clientQR.delete(userId);
  }

  clientStatus.set(userId, 'initializing');

const client = new Client({
  authStrategy: new LocalAuth({ clientId: `user_${userId}` }),
  puppeteer: {
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu'
    ],
  },
});

  clients.set(userId, client);

  client.on('qr', async (qr) => {
    console.log(`QR generated for user ${userId}`);
    clientStatus.set(userId, 'qr');
    try { clientQR.set(userId, await qrcode.toDataURL(qr)); }
    catch (err) { console.error('QR generation error:', err); }
  });

  client.on('authenticated', () => {
    console.log(`WhatsApp authenticated for user ${userId}`);
    clientStatus.set(userId, 'authenticated');
    clientQR.delete(userId);
  });

  client.on('ready', async () => {
    console.log(`WhatsApp ready for user ${userId}`);
    clientStatus.set(userId, 'ready');
    clientQR.delete(userId);
    await pool.query(
      'UPDATE users SET whatsapp_connected = TRUE, updated_at = NOW() WHERE id = $1',
      [userId]
    );
  });

  // ─── Debounce buffer: key = `${userId}:${chatId}` ──────────────────────────
  // Stores { timer, messages: [], rule, chat, phoneNumber }
  const pendingReplies = new Map();

  const flushReply = async (bufferKey) => {
    const entry = pendingReplies.get(bufferKey);
    if (!entry) return;
    pendingReplies.delete(bufferKey);

    const { messages, rule, chat } = entry;
    if (!messages.length) return;

    // Combine all buffered messages into one string
    const combined = messages.join('\n');
    console.log(`[auto-reply] Flushing ${messages.length} message(s) for key ${bufferKey}, tone: ${rule.tone}`);

    try {
      // Fetch last 10 messages for context (excluding the ones we're about to reply to)
      let history = [];
      try {
        const fetched = await chat.fetchMessages({ limit: 15 });
        const bodySet = new Set(messages);
        history = fetched
          .filter(m => m.body && m.body.trim() && !bodySet.has(m.body))
          .slice(-10)
          .map(m => ({ fromMe: m.fromMe, body: m.body }));
      } catch (e) {
        console.log('[auto-reply] Could not fetch history:', e.message);
      }

      const reply = await generateReply(combined, rule.tone, rule.extra_prompt, rule.contact_name, history, pool, userId);
      await chat.sendMessage(reply);

      await pool.query(
        `INSERT INTO auto_reply_logs (rule_id, user_id, chat_id, incoming_message, outgoing_message, tone)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [rule.id, userId, chat.id._serialized, combined, reply, rule.tone]
      );
    } catch (err) {
      console.error(`[auto-reply] Error flushing reply for ${bufferKey}:`, err.message);
    }
  };

  // ─── Message listener ────────────────────────────────────────────────────────
  client.on('message', async (msg) => {
    try {
      if (msg.fromMe) return;
      if (!msg.body || msg.body.trim() === '') return;

      const chat = await msg.getChat();
      const isGroup = chat.isGroup;

      const phoneNumber = await resolveContactNumber(msg, client);
      if (!phoneNumber) {
        console.log(`[auto-reply] Cannot resolve phone for ${msg.from}, skipping`);
        return;
      }

      const rule = await findRuleByNumber(userId, phoneNumber, isGroup);
      if (!rule) return;

      const bufferKey = `${userId}:${chat.id._serialized}`;
      const delayMs   = (rule.reply_delay ?? 5) * 1000;

      // Add message to buffer
      if (pendingReplies.has(bufferKey)) {
        const entry = pendingReplies.get(bufferKey);
        clearTimeout(entry.timer);
        entry.messages.push(msg.body);
        entry.timer = setTimeout(() => flushReply(bufferKey), delayMs);
        console.log(`[auto-reply] Buffered message for ${bufferKey} (${entry.messages.length} total, delay ${rule.reply_delay}s)`);
      } else {
        const timer = setTimeout(() => flushReply(bufferKey), delayMs);
        pendingReplies.set(bufferKey, { timer, messages: [msg.body], rule, chat });
        console.log(`[auto-reply] New buffer for ${bufferKey} — waiting ${rule.reply_delay}s`);
      }
    } catch (err) {
      console.error(`[auto-reply] Error for user ${userId}:`, err.message);
    }
  });
  // ─────────────────────────────────────────────────────────────────────────────

  client.on('auth_failure', async (msg) => {
    console.error(`Auth failure for user ${userId}:`, msg);
    clientStatus.set(userId, 'auth_failure');
    clients.delete(userId);
    clientQR.delete(userId);
    await pool.query(
      'UPDATE users SET whatsapp_connected = FALSE, updated_at = NOW() WHERE id = $1',
      [userId]
    );
  });

  client.on('disconnected', async (reason) => {
    console.log(`WhatsApp disconnected for user ${userId}:`, reason);
    clientStatus.set(userId, 'disconnected');
    clients.delete(userId);
    clientQR.delete(userId);
    await pool.query(
      'UPDATE users SET whatsapp_connected = FALSE, updated_at = NOW() WHERE id = $1',
      [userId]
    );
  });

  client.initialize().catch((err) => {
    console.error(`Client init error for user ${userId}:`, err);
    clients.delete(userId);
    clientQR.delete(userId);
    clientStatus.set(userId, 'error');
  });
};

// Restore sessions for all users who were connected before the server restarted
const restoreActiveSessions = async () => {
  try {
    const result = await pool.query('SELECT id FROM users WHERE whatsapp_connected = TRUE');
    if (result.rows.length === 0) return;
    console.log(`🔄 Restoring ${result.rows.length} WhatsApp session(s) from DB...`);
    for (const { id } of result.rows) {
      await new Promise(r => setTimeout(r, 1500)); // stagger to avoid Puppeteer overload
      initWhatsAppClient(id).catch(err =>
        console.error(`Failed to restore session for user ${id}:`, err.message)
      );
    }
  } catch (err) {
    console.error('restoreActiveSessions error:', err.message);
  }
};

const disconnectClient = async (userId) => {
  if (clients.has(userId)) {
    try { await clients.get(userId).destroy(); } catch (e) {}
    clients.delete(userId);
    clientQR.delete(userId);
  }
  clientStatus.set(userId, 'disconnected');
  await pool.query(
    'UPDATE users SET whatsapp_connected = FALSE, updated_at = NOW() WHERE id = $1',
    [userId]
  );
};

const getClientStatus = (userId) => clientStatus.get(userId) || 'disconnected';
const getClientQR    = (userId) => clientQR.get(userId) || null;

module.exports = {
  initWhatsAppClient,
  restoreActiveSessions,
  disconnectClient,
  getClientStatus,
  getClientQR,
};