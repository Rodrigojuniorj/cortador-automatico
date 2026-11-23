'use strict';
/**
 * Manda a legenda do clipe pro Telegram de quem clipa, pra copiar no celular
 * com um toque e colar no rascunho do TikTok (a API de rascunho nao aceita
 * legenda). Opcional: so liga com TELEGRAM_BOT_TOKEN e TELEGRAM_CHAT_ID no .env.
 */

const ativo = () => !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);

const esc = (s) => String(s).replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]));

/** true = mandou; false = Telegram nao configurado. Erro do Telegram vira excecao. */
async function enviarLegenda(titulo, legenda) {
  if (!ativo()) return false;
  const r = await fetch('https://api.telegram.org/bot' + process.env.TELEGRAM_BOT_TOKEN + '/sendMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: process.env.TELEGRAM_CHAT_ID,
      parse_mode: 'HTML',
      // <pre>: no app do Telegram um toque no bloco copia o texto inteiro
      text: '<b>' + esc(titulo || 'Clipe novo') + '</b>\nJá está nos rascunhos do TikTok. Toque no bloco pra copiar a legenda:\n\n<pre>' + esc(legenda || titulo || '') + '</pre>',
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error('Telegram: ' + (j.description || 'HTTP ' + r.status));
  return true;
}

module.exports = { ativo, enviarLegenda };
