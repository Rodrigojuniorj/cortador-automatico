'use strict';
/**
 * Manda a legenda do clipe pro Telegram de quem clipa, pra copiar no celular
 * com um toque e colar no rascunho do TikTok (a API de rascunho nao aceita
 * legenda). Opcional: so liga com TELEGRAM_BOT_TOKEN e TELEGRAM_CHAT_ID no .env.
 */

const fs = require('fs');
const path = require('path');

const ativo = () => !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);

const esc = (s) => String(s).replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]));

async function chamar(metodo, corpo) {
  const json = !(corpo instanceof FormData);
  const r = await fetch('https://api.telegram.org/bot' + process.env.TELEGRAM_BOT_TOKEN + '/' + metodo, {
    method: 'POST',
    headers: json ? { 'Content-Type': 'application/json' } : undefined,
    body: json ? JSON.stringify(corpo) : corpo,
  });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error('Telegram: ' + (j.description || 'HTTP ' + r.status));
}

/** true = mandou; false = Telegram nao configurado. Erro do Telegram vira excecao. */
async function enviarLegenda(titulo, legenda) {
  if (!ativo()) return false;
  await chamar('sendMessage', {
    chat_id: process.env.TELEGRAM_CHAT_ID,
    parse_mode: 'HTML',
    // <pre>: no app do Telegram um toque no bloco copia o texto inteiro
    text: '<b>' + esc(titulo || 'Clipe novo') + '</b>\nJá está nos rascunhos do TikTok. Toque no bloco pra copiar a legenda:\n\n<pre>' + esc(legenda || titulo || '') + '</pre>',
  });
  return true;
}

// Musicas em alta no TikTok que combinam com corte de GTA (vidIQ, 11 a 24/11/2026).
// shortcut: lista fixa, envelhece em ~2 semanas; refazer a pesquisa no vidIQ e trocar aqui
const MUSICAS = [
  'Flower In A Hurricane (trilha do GTA VI - Justice, Tame Impala, SZA)',
  'Midnight City (M83)',
  'LUNATIC - Slowed (CASAP)',
];
const MUSICA_ENGRACADA = 'Saxophones getting louder - Sped Up';

/** A sugerida roda pelo numero do clipe: clipes da mesma live nao saem todos com a mesma. */
function musicaDoClipe(numero) {
  const i = Math.abs(Number(numero) || 1) - 1;
  return { sugerida: MUSICAS[i % MUSICAS.length], outras: MUSICAS.filter((_, j) => j !== i % MUSICAS.length).concat(MUSICA_ENGRACADA) };
}

const LIMITE_BOT = 50 * 1024 * 1024; // bot do Telegram nao manda arquivo maior que 50 MB

/**
 * Pra postar no YouTube pelo celular, com musica em alta (a API nao tem a
 * biblioteca de musicas): manda o mp4 com a musica sugerida e, logo depois,
 * o titulo e a descricao do YouTube em blocos de um toque pra copiar.
 * @param {object} post { titulo, descricao } ja no formato do YouTube
 */
async function enviarParaYouTube(arquivo, post, musica) {
  if (!ativo()) throw new Error('Telegram não configurado: falta TELEGRAM_BOT_TOKEN e TELEGRAM_CHAT_ID no .env.');
  if (fs.statSync(arquivo).size > LIMITE_BOT) throw new Error('Telegram: o vídeo passa de 50 MB, o bot não consegue mandar.');
  const form = new FormData();
  form.append('chat_id', process.env.TELEGRAM_CHAT_ID);
  form.append('supports_streaming', 'true');
  form.append('caption', ('Música: ' + musica.sugerida + '\nVolume da música bem baixo, perto de 3.\nOutras: ' + musica.outras.join(', ')).slice(0, 1024));
  form.append('video', await fs.openAsBlob(arquivo, { type: 'video/mp4' }), path.basename(arquivo));
  await chamar('sendVideo', form);
  await chamar('sendMessage', {
    chat_id: process.env.TELEGRAM_CHAT_ID,
    parse_mode: 'HTML',
    text: ('<b>Título</b> (toque pra copiar):\n<pre>' + esc(post.titulo) + '</pre>\n\n<b>Descrição</b>:\n<pre>' + esc(post.descricao) + '</pre>\n\n' +
      'No app do YouTube: salve o vídeo na galeria, + > Criar um Short, Adicionar som (' + esc(musica.sugerida) + '), ' +
      'Volume: som original no máximo e a música quase zerada.').slice(0, 4096),
  });
  return true;
}

module.exports = { ativo, enviarLegenda, enviarParaYouTube, musicaDoClipe };
