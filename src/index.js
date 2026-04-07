require('dotenv').config();
const express = require('express');
const cors = require('cors');

const { initDB, pool } = require('./config/database');
const { restoreActiveSessions } = require('./config/whatsapp');
const authMiddleware = require('./middleware/auth');
const authRoutes = require('./routes/auth');
const whatsappRoutes = require('./routes/whatsapp');
const rulesRoutes = require('./routes/rules');

const app = express();

app.use(cors({
  origin: "https://frontend-wppapp-production.up.railway.app",
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true
}));
app.use(express.json());

app.use('/api/auth', authRoutes);
app.use('/api/whatsapp', whatsappRoutes);
app.use('/api/rules', rulesRoutes);

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// GET /api/stats/tokens — current user's token usage & limit
app.get('/api/stats/tokens', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT tokens_used, token_limit, rules_paused_by_limit FROM users WHERE id = $1',
      [req.userId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Usuário não encontrado' });
    const { tokens_used, token_limit, rules_paused_by_limit } = result.rows[0];
    res.json({
      tokensUsed:         tokens_used,
      tokenLimit:         token_limit,
      tokensRemaining:    Math.max(0, token_limit - tokens_used),
      percentUsed:        +((tokens_used / token_limit) * 100).toFixed(1),
      rulesPausedByLimit: rules_paused_by_limit,
    });
  } catch (err) {
    console.error('Token stats error:', err);
    res.status(500).json({ error: 'Erro ao buscar estatísticas' });
  }
});

// PATCH /api/stats/tokens/limit — update token limit
app.patch('/api/stats/tokens/limit', authMiddleware, async (req, res) => {
  const { limit } = req.body;
  if (!Number.isInteger(limit) || limit < 1000) {
    return res.status(400).json({ error: 'Limite deve ser um inteiro >= 1000' });
  }
  try {
    const result = await pool.query(
      `UPDATE users
       SET token_limit = $1,
           -- If new limit is higher than current usage, re-enable rules that were paused by limit
           rules_paused_by_limit = CASE WHEN tokens_used < $1 THEN FALSE ELSE rules_paused_by_limit END,
           updated_at = NOW()
       WHERE id = $2
       RETURNING tokens_used, token_limit, rules_paused_by_limit`,
      [limit, req.userId]
    );
    const row = result.rows[0];
    // If limit was raised and rules were paused by limit, re-activate them
    if (!row.rules_paused_by_limit) {
      await pool.query(
        `UPDATE auto_reply_rules SET active = TRUE, updated_at = NOW()
         WHERE user_id = $1`,
        [req.userId]
      );
    }
    res.json({
      tokensUsed:         row.tokens_used,
      tokenLimit:         row.token_limit,
      tokensRemaining:    Math.max(0, row.token_limit - row.tokens_used),
      percentUsed:        +((row.tokens_used / row.token_limit) * 100).toFixed(1),
      rulesPausedByLimit: row.rules_paused_by_limit,
    });
  } catch (err) {
    console.error('Update limit error:', err);
    res.status(500).json({ error: 'Erro ao atualizar limite' });
  }
});

// POST /api/stats/tokens/reset — reset token counter (admin/debug)
app.post('/api/stats/tokens/reset', authMiddleware, async (req, res) => {
  try {
    await pool.query(
      `UPDATE users SET tokens_used = 0, rules_paused_by_limit = FALSE, updated_at = NOW() WHERE id = $1`,
      [req.userId]
    );
    // Re-activate rules that were paused by limit
    await pool.query(
      `UPDATE auto_reply_rules SET active = TRUE, updated_at = NOW() WHERE user_id = $1`,
      [req.userId]
    );
    res.json({ message: 'Contador resetado e regras reativadas.' });
  } catch (err) {
    console.error('Reset error:', err);
    res.status(500).json({ error: 'Erro ao resetar' });
  }
});

const PORT = process.env.PORT || 3001;

const start = async () => {
  try {
    await initDB();
    app.listen(PORT, () => {
      console.log(`🚀 Server running on http://localhost:${PORT}`);
    });
    await restoreActiveSessions();
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
};

start();