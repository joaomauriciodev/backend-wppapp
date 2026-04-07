const express = require('express');
const authMiddleware = require('../middleware/auth');
const {
  initWhatsAppClient,
  disconnectClient,
  getClientStatus,
  getClientQR,
} = require('../config/whatsapp');

const router = express.Router();
router.use(authMiddleware);

// POST /api/whatsapp/connect
router.post('/connect', async (req, res) => {
  const { userId } = req;
  try {
    const status = getClientStatus(userId);
    if (status === 'ready') return res.json({ message: 'WhatsApp já está conectado', status });
    initWhatsAppClient(userId).catch(err => console.error('WhatsApp init error:', err));
    res.json({ message: 'Inicializando WhatsApp...', status: 'initializing' });
  } catch (err) {
    console.error('Connect error:', err);
    res.status(500).json({ error: 'Erro ao iniciar conexão WhatsApp' });
  }
});

// POST /api/whatsapp/disconnect
router.post('/disconnect', async (req, res) => {
  try {
    await disconnectClient(req.userId);
    res.json({ message: 'WhatsApp desconectado com sucesso' });
  } catch (err) {
    console.error('Disconnect error:', err);
    res.status(500).json({ error: 'Erro ao desconectar WhatsApp' });
  }
});

// GET /api/whatsapp/status  — polled by frontend every 2.5s during connection
router.get('/status', (req, res) => {
  const status = getClientStatus(req.userId);
  const qr = status === 'qr' ? getClientQR(req.userId) : null;
  res.json({ status, qr });
});

module.exports = router;
