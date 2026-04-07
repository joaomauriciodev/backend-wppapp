const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent';

const TONE_PROMPTS = {
  friendly:    'Responda de forma amigável, calorosa e prestativa, como um bom amigo.',
  formal:      'Responda de forma formal, profissional e educada, como em um ambiente corporativo.',
  funny:       'Responda de forma engraçada, com humor, piadas leves e um toque de sarcasmo descontraído.',
  rude:        'Responda de forma rude, ríspida e impaciente, sem rodeios, mas sem xingamentos pesados.',
  aggressive:  'Responda de forma agressiva, direta ao ponto, com tom firme e confrontacional.',
  loving:      'Responda de forma amorosa, carinhosa e afetiva, com muito cuidado e ternura.',
  sarcastic:   'Responda de forma extremamente sarcástica, irônica e debochada.',
  professional:'Responda de forma ultra-profissional, técnica e objetiva.',
  excited:     'Responda de forma super animada, entusiasmada e cheia de energia positiva.',
  mysterious:  'Responda de forma enigmática, misteriosa, como se tivesse segredos a esconder.',
};
 
/**
 * Persist token usage to DB and enforce the user's token limit.
 * If the limit is reached, pauses all rules for the user.
 * Returns { tokensUsed, tokenLimit, limitReached }
 */
const persistTokenUsage = async (pool, userId, tokensConsumed) => {
  const result = await pool.query(
    `UPDATE users
     SET tokens_used = tokens_used + $1,
         updated_at  = NOW()
     WHERE id = $2
     RETURNING tokens_used, token_limit, rules_paused_by_limit`,
    [tokensConsumed, userId]
  );
 
  const { tokens_used, token_limit, rules_paused_by_limit } = result.rows[0];
  const limitReached = tokens_used >= token_limit;
 
  // If limit just crossed and rules are not yet paused, pause them all
  if (limitReached && !rules_paused_by_limit) {
    await pool.query(
      `UPDATE auto_reply_rules
       SET active = FALSE, updated_at = NOW()
       WHERE user_id = $1 AND active = TRUE`,
      [userId]
    );
    await pool.query(
      `UPDATE users SET rules_paused_by_limit = TRUE, updated_at = NOW() WHERE id = $1`,
      [userId]
    );
    console.log(`[gemini] ⚠️  Token limit reached for user ${userId} (${tokens_used}/${token_limit}). All rules paused.`);
  }
 
  return { tokensUsed: tokens_used, tokenLimit: token_limit, limitReached };
};
 
/**
 * Generate a WhatsApp auto-reply using conversation history as context.
 *
 * @param {string}  incomingMessage
 * @param {string}  tone
 * @param {string}  extraPrompt
 * @param {string}  contactName
 * @param {Array}   history         [{fromMe: bool, body: string}] oldest→newest
 * @param {object}  pool            pg Pool instance (for token persistence)
 * @param {string}  userId          UUID of the user (for token persistence)
 */
const generateReply = async (incomingMessage, tone, extraPrompt, contactName, history = [], pool = null, userId = null) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY não configurada');
 
  const toneInstruction = TONE_PROMPTS[tone] || TONE_PROMPTS.friendly;
  const senderInfo = contactName ? `Você está conversando com "${contactName}".` : '';
 
  const systemInstruction = `Você está respondendo mensagens do WhatsApp no lugar de uma pessoa real.
 
${senderInfo}
TOM: ${toneInstruction}
${extraPrompt ? `INSTRUÇÕES EXTRAS: ${extraPrompt}\n` : ''}
REGRAS:
- Responda de forma natural, como um humano faria no WhatsApp
- Use o histórico da conversa para dar continuidade e contexto
- Nunca mencione que é IA ou assistente
- Responda em português brasileiro
- Não use saudações repetitivas se já cumprimentou antes no histórico
- Respostas curtas e naturais como numa conversa real — apenas o necessário`;
 
  // Build multi-turn contents from history
  // fromMe=true (account owner) → role:"model" | fromMe=false (contact) → role:"user"
  const contents = [];
  for (const msg of history) {
    const role = msg.fromMe ? 'model' : 'user';
    if (contents.length > 0 && contents[contents.length - 1].role === role) {
      contents[contents.length - 1].parts[0].text += '\n' + msg.body;
    } else {
      contents.push({ role, parts: [{ text: msg.body }] });
    }
  }
  if (contents.length === 0 || contents[contents.length - 1].role !== 'user') {
    contents.push({ role: 'user', parts: [{ text: incomingMessage }] });
  } else {
    contents[contents.length - 1].parts[0].text += '\n' + incomingMessage;
  }
 
  const body = {
    system_instruction: { parts: [{ text: systemInstruction }] },
    contents,
    generationConfig: { temperature: 0.85, topP: 0.95, maxOutputTokens: 1024 },
  };
 
  const response = await fetch(`${GEMINI_API_URL}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
 
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Gemini API error: ${response.status} — ${err}`);
  }
 
  const data = await response.json();
  const candidate  = data?.candidates?.[0];
  const text       = candidate?.content?.parts?.[0]?.text?.trim();
  const usage      = data?.usageMetadata || {};
  const totalUsed  = usage.totalTokenCount || 0;
 
  console.log(
    `[gemini] prompt: ${usage.promptTokenCount} | output: ${usage.candidatesTokenCount} | total: ${totalUsed}`
  );
 
  // Persist to DB if pool and userId provided
  if (pool && userId && totalUsed > 0) {
    await persistTokenUsage(pool, userId, totalUsed).catch(err =>
      console.error('[gemini] Failed to persist token usage:', err.message)
    );
  }
 
  if (!text) throw new Error('Gemini retornou resposta vazia');
  return text;
};
 
module.exports = { generateReply, TONE_PROMPTS };