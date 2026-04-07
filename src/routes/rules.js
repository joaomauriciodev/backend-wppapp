const express = require('express');
const { pool } = require('../config/database');
const authMiddleware = require('../middleware/auth');
const { TONE_PROMPTS } = require('../config/gemini');

const router = express.Router();
router.use(authMiddleware);

// ─── Aggregated logs feed ────────────────────────────────────────────────────
router.get('/logs/all', async (req, res) => {
  const { page = 1, limit = 30, rule_id } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);

  try {
    const params = [req.userId];
    let ruleFilter = '';
    if (rule_id) { ruleFilter = `AND l.rule_id = $${params.length + 1}`; params.push(rule_id); }

    const [logsResult, countResult, statsResult] = await Promise.all([
      pool.query(
        `SELECT l.id, l.rule_id, l.chat_id, l.incoming_message, l.outgoing_message,
                l.tone, l.created_at,
                r.contact_name, r.contact_phone, r.scope, r.active AS rule_active
         FROM auto_reply_logs l
         JOIN auto_reply_rules r ON r.id = l.rule_id
         WHERE l.user_id = $1 ${ruleFilter}
         ORDER BY l.created_at DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, parseInt(limit), offset]
      ),
      pool.query(`SELECT COUNT(*) FROM auto_reply_logs l WHERE l.user_id = $1 ${ruleFilter}`, params),
      pool.query(
        `SELECT COUNT(*) AS total_replies,
                COUNT(DISTINCT l.rule_id) AS active_rules,
                COUNT(DISTINCT DATE(l.created_at)) AS active_days,
                (SELECT tone FROM auto_reply_logs WHERE user_id = $1
                 GROUP BY tone ORDER BY COUNT(*) DESC LIMIT 1) AS top_tone
         FROM auto_reply_logs l WHERE l.user_id = $1`,
        [req.userId]
      ),
    ]);

    res.json({
      logs: logsResult.rows,
      total: parseInt(countResult.rows[0].count),
      stats: statsResult.rows[0],
      page: parseInt(page),
      limit: parseInt(limit),
    });
  } catch (err) {
    console.error('All logs error:', err);
    res.status(500).json({ error: 'Erro ao buscar interações' });
  }
});

// ─── Tones ───────────────────────────────────────────────────────────────────
router.get('/tones', (req, res) => {
  const tones = Object.keys(TONE_PROMPTS).map((key) => ({
    key,
    label: {
      friendly:     '😊 Amigável',
      formal:       '👔 Formal',
      funny:        '😂 Engraçado',
      rude:         '😤 Rude',
      aggressive:   '😡 Agressivo',
      loving:       '❤️ Amoroso',
      sarcastic:    '🙃 Sarcástico',
      professional: '💼 Profissional',
      excited:      '🤩 Animado',
      mysterious:   '🕵️ Misterioso',
    }[key] || key,
  }));
  res.json({ tones });
});

// ─── List all rules ──────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT r.*,
         (SELECT COUNT(*) FROM auto_reply_logs l WHERE l.rule_id = r.id) AS reply_count,
         (SELECT created_at FROM auto_reply_logs l WHERE l.rule_id = r.id ORDER BY created_at DESC LIMIT 1) AS last_reply_at
       FROM auto_reply_rules r
       WHERE r.user_id = $1
       ORDER BY r.created_at DESC`,
      [req.userId]
    );
    res.json({ rules: result.rows });
  } catch (err) {
    console.error('List rules error:', err);
    res.status(500).json({ error: 'Erro ao listar regras' });
  }
});

// ─── Get rule by phone ────────────────────────────────────────────────────────
router.get('/phone/:phone', async (req, res) => {
  try {
    const normalized = req.params.phone.replace(/\D/g, '');
    const result = await pool.query(
      `SELECT * FROM auto_reply_rules
       WHERE user_id = $1 AND REGEXP_REPLACE(contact_phone, '[^0-9]', '', 'g') = $2`,
      [req.userId, normalized]
    );
    res.json({ rule: result.rows[0] || null });
  } catch (err) {
    console.error('Get rule error:', err);
    res.status(500).json({ error: 'Erro ao buscar regra' });
  }
});

// ─── Create / update rule (upsert by phone) ───────────────────────────────────
router.post('/', async (req, res) => {
  const { contact_name, contact_phone, scope, tone, extra_prompt, active, reply_delay } = req.body;

  if (!contact_phone) return res.status(400).json({ error: 'contact_phone é obrigatório' });
  const digits = contact_phone.replace(/\D/g, '');
  if (digits.length < 10) return res.status(400).json({ error: 'Número inválido — informe DDD + número (ex: +55 48 99000-0000)' });
  if (!['private', 'groups', 'both'].includes(scope)) return res.status(400).json({ error: 'scope inválido' });
  if (!TONE_PROMPTS[tone]) return res.status(400).json({ error: 'tone inválido' });

  const delay = Number.isInteger(reply_delay) && reply_delay >= 0 ? reply_delay : 5;

  try {
    const result = await pool.query(
      `INSERT INTO auto_reply_rules (user_id, contact_name, contact_phone, scope, tone, extra_prompt, active, reply_delay)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (user_id, contact_phone) DO UPDATE SET
         contact_name  = EXCLUDED.contact_name,
         scope         = EXCLUDED.scope,
         tone          = EXCLUDED.tone,
         extra_prompt  = EXCLUDED.extra_prompt,
         active        = EXCLUDED.active,
         reply_delay   = EXCLUDED.reply_delay,
         updated_at    = NOW()
       RETURNING *`,
      [req.userId, contact_name || null, digits, scope, tone, extra_prompt || null, active !== false, delay]
    );
    res.status(201).json({ rule: result.rows[0] });
  } catch (err) {
    console.error('Create rule error:', err);
    res.status(500).json({ error: 'Erro ao salvar regra' });
  }
});


// ─── Toggle active ───────────────────────────────────────────────────────────
router.patch('/:id/toggle', async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE auto_reply_rules SET active = NOT active, updated_at = NOW()
       WHERE id = $1 AND user_id = $2 RETURNING *`,
      [req.params.id, req.userId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Regra não encontrada' });
    res.json({ rule: result.rows[0] });
  } catch (err) {
    console.error('Toggle error:', err);
    res.status(500).json({ error: 'Erro ao atualizar regra' });
  }
});

// ─── Delete ──────────────────────────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM auto_reply_rules WHERE id = $1 AND user_id = $2 RETURNING id',
      [req.params.id, req.userId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Regra não encontrada' });
    res.json({ message: 'Regra removida' });
  } catch (err) {
    console.error('Delete error:', err);
    res.status(500).json({ error: 'Erro ao remover regra' });
  }
});

// ─── Logs per rule ───────────────────────────────────────────────────────────
router.get('/:id/logs', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM auto_reply_logs
       WHERE rule_id = $1 AND user_id = $2
       ORDER BY created_at DESC LIMIT 50`,
      [req.params.id, req.userId]
    );
    res.json({ logs: result.rows });
  } catch (err) {
    console.error('Logs error:', err);
    res.status(500).json({ error: 'Erro ao buscar logs' });
  }
});

// ─── Test rule — simulate a reply without sending via WhatsApp ───────────────
router.post('/:id/test', async (req, res) => {
  const { message } = req.body;
  if (!message || !message.trim()) {
    return res.status(400).json({ error: 'message é obrigatório' });
  }

  try {
    const result = await pool.query(
      'SELECT * FROM auto_reply_rules WHERE id = $1 AND user_id = $2',
      [req.params.id, req.userId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Regra não encontrada' });

    const rule = result.rows[0];
    const { generateReply } = require('../config/gemini');

    const reply = await generateReply(
      message,
      rule.tone,
      rule.extra_prompt,
      rule.contact_name,
      [], // no history for test
      pool,
      req.userId
    );

    res.json({ reply });
  } catch (err) {
    console.error('Test rule error:', err);
    res.status(500).json({ error: err.message || 'Erro ao testar regra' });
  }
});

module.exports = router;