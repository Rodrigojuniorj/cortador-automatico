'use strict';
/**
 * Posta o clipe direto no canal do YouTube (vira Short: vertical e ate 3 min),
 * ja com titulo, descricao e tags. So no PC com YOUTUBE_CLIENT_ID e
 * YOUTUBE_CLIENT_SECRET no .env - sem eles o botao nem aparece.
 *
 * Login: cliente OAuth do tipo "App para computador" do Google aceita voltar
 * pra 127.0.0.1 em qualquer porta, entao o proprio programa recebe o
 * /youtube/callback - nada de ngrok aqui.
 *
 * Cota (docs do Google, 2026): envio tem balde proprio de 100 videos por dia.
 * Projeto sem auditoria nao trava mais o video como privado (mudou em 2/11/2026).
 *
 * Agendar: o video sobe na hora como privado com status.publishAt, e o proprio
 * YouTube publica no horario - o PC nao precisa estar ligado.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const pastas = require('./pastas');

// upload + leitura das metricas (YouTube Analytics). Quem conectou antes so com
// upload continua enviando; pra ler metricas precisa conectar de novo.
const ESCOPO_METRICAS = 'https://www.googleapis.com/auth/yt-analytics.readonly';
const ESCOPO = 'https://www.googleapis.com/auth/youtube.upload ' + ESCOPO_METRICAS;
const TOKEN = 'https://oauth2.googleapis.com/token';
const UPLOAD = 'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status';

const cfg = () => ({ id: process.env.YOUTUBE_CLIENT_ID || '', segredo: process.env.YOUTUBE_CLIENT_SECRET || '' });
const ativo = () => { const c = cfg(); return !!(c.id && c.segredo); };

const arquivoTokens = () => path.join(path.dirname(pastas.arquivoConfig()), 'youtube.json');
function lerTokens() {
  try { return JSON.parse(fs.readFileSync(arquivoTokens(), 'utf8')); } catch (_) { return null; }
}
function gravarTokens(t, anterior) {
  const dados = {
    access_token: t.access_token,
    // o Google so manda refresh_token no primeiro login: na renovacao mantem o antigo
    refresh_token: t.refresh_token || (anterior && anterior.refresh_token),
    expira: Date.now() + (Number(t.expires_in) - 60) * 1000,
    escopo: t.scope || (anterior && anterior.escopo) || '',
  };
  fs.mkdirSync(path.dirname(arquivoTokens()), { recursive: true });
  fs.writeFileSync(arquivoTokens(), JSON.stringify(dados, null, 2), 'utf8');
  return dados;
}

async function pedirToken(campos, anterior) {
  const c = cfg();
  const r = await fetch(TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(Object.assign({ client_id: c.id, client_secret: c.segredo }, campos)),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.access_token) throw new Error('O Google recusou o login: ' + (j.error_description || j.error || 'HTTP ' + r.status));
  return gravarTokens(j, anterior);
}

/** Token que vale agora (renova sozinho). null = precisa conectar de novo. */
async function tokenValido() {
  const t = lerTokens();
  if (!t || !t.refresh_token) return null;
  if (Date.now() < t.expira) return t.access_token;
  try {
    return (await pedirToken({ grant_type: 'refresh_token', refresh_token: t.refresh_token }, t)).access_token;
  } catch (_) {
    return null; // a pessoa tirou o acesso na conta Google: conecta de novo
  }
}

// ---------------------------------------------------------------- login

let pendente = null; // { estado, verificador, redirect } entre o "Conectar" e o callback
let ultimoErro = null;

function estado() {
  const t = lerTokens();
  const conectado = !!(t && t.refresh_token);
  return { ativo: ativo(), conectado, metricas: conectado && String(t.escopo || '').includes(ESCOPO_METRICAS), entrando: !!pendente, erro: ultimoErro };
}

/** Link de autorizacao do Google. porta = a do programa (o callback volta nele). */
function entrar(porta) {
  if (!ativo()) throw new Error('Faltam as chaves do YouTube no .env.');
  ultimoErro = null;
  const verificador = crypto.randomBytes(48).toString('base64url');
  pendente = {
    estado: crypto.randomBytes(16).toString('hex'),
    verificador,
    redirect: 'http://127.0.0.1:' + porta + '/youtube/callback',
  };
  return 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    client_id: cfg().id,
    redirect_uri: pendente.redirect,
    response_type: 'code',
    scope: ESCOPO,
    access_type: 'offline',
    prompt: 'consent', // garante o refresh_token mesmo se ja autorizou antes
    state: pendente.estado,
    code_challenge: crypto.createHash('sha256').update(verificador).digest('base64url'),
    code_challenge_method: 'S256',
  });
}

/** Trata a volta do Google. Devolve { ok, mensagem } pra montar a pagina. */
async function callback(params) {
  if (!pendente || params.get('state') !== pendente.estado) return { ok: false, mensagem: 'Link vencido. Volte ao programa e clique em YouTube de novo.' };
  const p = pendente;
  pendente = null;
  const codigo = params.get('code');
  if (!codigo) {
    ultimoErro = params.get('error') === 'access_denied' ? 'Você não autorizou o acesso ao YouTube.' : (params.get('error') || 'O Google não autorizou.');
    return { ok: false, mensagem: ultimoErro };
  }
  try {
    await pedirToken({ code: codigo, grant_type: 'authorization_code', redirect_uri: p.redirect, code_verifier: p.verificador });
    return { ok: true, mensagem: 'YouTube conectado. Pode fechar esta aba e voltar ao programa.' };
  } catch (e) {
    ultimoErro = e.message;
    return { ok: false, mensagem: e.message };
  }
}

// ---------------------------------------------------------------- envio

const ERROS = {
  quotaExceeded: 'Acabou a cota de envios do dia da API do YouTube. Volta amanhã.',
  uploadLimitExceeded: 'O YouTube limitou os envios deste canal por hoje.',
  youtubeSignupRequired: 'Essa conta Google não tem canal no YouTube. Crie o canal e conecte de novo.',
  authError: 'O login do YouTube venceu. Conecte de novo.',
  insufficientPermissions: 'Conecte o YouTube de novo para liberar a leitura das métricas.',
  accessNotConfigured: 'Ative a "YouTube Analytics API" no Google Cloud (mesmo projeto das chaves do .env).',
  SERVICE_DISABLED: 'Ative a "YouTube Analytics API" no Google Cloud (mesmo projeto das chaves do .env).',
};

async function erroDoGoogle(r) {
  const j = await r.json().catch(() => ({}));
  const e = j.error || {};
  const motivo = (e.errors && e.errors[0] && e.errors[0].reason) || e.status || '';
  return new Error(ERROS[motivo] || ('YouTube (' + (motivo || 'HTTP ' + r.status) + '): ' + (e.message || 'sem detalhe')));
}

// Titulo do YouTube: ate 100 caracteres e sem < > (o YouTube recusa). #shorts no
// fim: o YouTube ja reconhece Short pelo formato, mas deixa explicito pra busca.
// Em CAIXA ALTA: no feed de Shorts so aparecem as 3-4 primeiras palavras, e em
// canal novo maiuscula chama mais (video de referencia RunnyIA, 1M views).
function tituloOk(t) {
  let titulo = String(t || 'Corte').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().toUpperCase().replace(/#SHORTS\b/g, '#shorts');
  if (!/#shorts\b/i.test(titulo)) titulo = titulo.slice(0, 100 - ' #shorts'.length).trim() + ' #shorts';
  return titulo.slice(0, 100);
}

// Palavras de GTA 6 com mais busca no Brasil (vidIQ, 25/11/2026). Descricao leva
// 5-6 palavras-chave e as tags vao em quantidade - o YouTube usa as duas pra
// saber pra quem entregar.
const CHAVES_GTA = ['gta 6', 'gta vi', 'gta 6 gameplay', 'gta 6 pc', 'gta 6 mapa'];
const TAGS_GTA = ['gta 6', 'gta vi', 'gta6', 'gta', 'gta 6 gameplay', 'gta 6 pc', 'gta 6 ps5', 'gta 6 xbox series s',
  'gta 6 mapa', 'gta 6 lucia', 'gta 6 leonida', 'gta 6 vice city', 'jason gta 6', 'rockstar games',
  'grand theft auto 6', 'cortes gta 6', 'gta 6 brasil', 'gta 6 pt br'];
// hashtag de alcance do TikTok: no YouTube, muita hashtag em canal novo parece spam
const SO_TIKTOK = new Set(['fyp', 'viral', 'foryou', 'paravoce', 'cortes']);
const LIMITE_TAGS = 450; // o YouTube aceita 500 caracteres somando todas

/**
 * Titulo, descricao e tags do YouTube a partir da copy do clipe.
 * Descricao: resumo da IA primeiro (o algoritmo le a abertura), o texto do post,
 * as palavras-chave separadas por virgula e so 3 hashtags.
 * @param {object} p { titulo, descricao, hashtags, streamer, resumo }
 */
function montarPost(p) {
  const hashtags = (p.hashtags || []).map((h) => String(h).replace(/^#/, '').toLowerCase()).filter(Boolean);
  const gta = hashtags.some((h) => h.startsWith('gta'));
  const streamer = String(p.streamer || '').trim().toLowerCase();
  const nicho = hashtags.filter((h) => !SO_TIKTOK.has(h));
  const unicas = (lista) => [...new Set(lista.filter(Boolean))];

  const chaves = unicas((gta ? CHAVES_GTA : nicho.slice(0, 5)).concat(streamer ? [streamer + (gta ? ' gta 6' : '')] : []));
  const corpo = String(p.descricao || '').split('\n').filter((l) => !/^\s*(#\S+\s*)+$/.test(l)).join('\n').trim();
  const marcas = unicas([gta ? 'gta6' : nicho[0], streamer.replace(/[^a-z0-9]/g, ''), 'shorts']).map((h) => '#' + h).join(' ');
  const descricao = [p.resumo, corpo, chaves.length ? 'Palavras-chave: ' + chaves.join(', ') : '', marcas].filter(Boolean).join('\n\n');

  const candidatas = unicas((gta ? TAGS_GTA : []).concat(
    streamer ? [streamer, 'cortes ' + streamer, streamer + ' ao vivo'].concat(gta ? [streamer + ' gta 6'] : []) : [],
    nicho, ['cortes de live', 'shorts']));
  const tags = [];
  let usado = 0;
  for (const t of candidatas) {
    const custo = t.length + (t.includes(' ') ? 2 : 0) + 1; // o YouTube conta aspas em tag com espaco
    if (usado + custo > LIMITE_TAGS) continue;
    tags.push(t);
    usado += custo;
  }
  return { titulo: p.titulo, descricao, tags };
}

/**
 * Sobe o video ja publicado. Sem auditoria o YouTube o deixa privado mesmo
 * pedindo publico - a resposta diz como ficou.
 * @param {object} post { titulo, descricao, tags }
 */
async function enviar(arquivo, post) {
  const token = await tokenValido();
  if (!token) throw Object.assign(new Error('Conecte o YouTube primeiro.'), { precisaLogin: true });

  const tamanho = fs.statSync(arquivo).size;
  let descricao = String(post.descricao || '').slice(0, 4900);
  if (!/#shorts\b/i.test(descricao)) descricao += (descricao ? ' ' : '') + '#shorts';
  const tags = (post.tags || []).map((t) => String(t).replace(/^#/, '')).filter(Boolean);
  // agendado: o YouTube exige privado + publishAt, e ele mesmo publica na hora
  const status = post.publicarEm
    ? { privacyStatus: 'private', publishAt: post.publicarEm, selfDeclaredMadeForKids: false }
    : { privacyStatus: 'public', selfDeclaredMadeForKids: false };
  const meta = {
    snippet: { title: tituloOk(post.titulo), description: descricao, tags, categoryId: '20' }, // 20 = Jogos
    status,
  };

  const inicio = await fetch(UPLOAD, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Length': String(tamanho),
      'X-Upload-Content-Type': 'video/mp4',
    },
    body: JSON.stringify(meta),
  });
  if (!inicio.ok) throw await erroDoGoogle(inicio);
  const destino = inicio.headers.get('location');
  if (!destino) throw new Error('O YouTube não devolveu o endereço de envio.');

  // shortcut: manda o arquivo inteiro num PUT so (clipe tem ~150 MB no maximo); se cair no meio, recomeca do zero
  const r = await fetch(destino, {
    method: 'PUT',
    headers: { 'Content-Type': 'video/mp4' },
    body: fs.readFileSync(arquivo),
  });
  if (!r.ok) throw await erroDoGoogle(r);
  const v = await r.json();
  return {
    ok: true,
    id: v.id,
    url: 'https://youtube.com/shorts/' + v.id,
    privacidade: v.status && v.status.privacyStatus,
    agendadoPara: post.publicarEm || null,
  };
}

// ---------------------------------------------------------------- agenda

// Horarios de Brasilia, 6 por dia. Fontes (2026, blogs de ferramentas, sem
// dado oficial): pico de Shorts no Brasil 4h-7h (Trendreport, 47 mil videos),
// almoco 12h-14h, e noite 19h-22h na America Latina. Espacados pra um corte
// nao concorrer com o outro.
// shortcut: horario fixo e no fuso do PC; trocar pelo horario de pico do proprio canal quando der pra ler o YouTube Analytics
const HORARIOS = [[7, 0], [12, 0], [14, 0], [17, 0], [19, 0], [21, 0]];
const FOLGA_MS = 20 * 60 * 1000; // nao agenda pra daqui a menos de 20 min

const arquivoAgenda = () => path.join(path.dirname(pastas.arquivoConfig()), 'youtube-agenda.json');
function lerAgenda() {
  try { return JSON.parse(fs.readFileSync(arquivoAgenda(), 'utf8')).filter((t) => Date.parse(t) > Date.now()); }
  catch (_) { return []; }
}
function gravarAgenda(lista) {
  fs.mkdirSync(path.dirname(arquivoAgenda()), { recursive: true });
  fs.writeFileSync(arquivoAgenda(), JSON.stringify(lista.sort(), null, 2), 'utf8');
}

/** Pega o proximo horario livre e ja marca como ocupado. Devolve ISO. */
function reservarHorario() {
  const agora = new Date();
  const ocupados = lerAgenda();
  for (let dia = 0; dia < 365; dia++) {
    for (const [h, m] of HORARIOS) {
      const d = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate() + dia, h, m);
      if (d - agora < FOLGA_MS) continue;
      const iso = d.toISOString();
      if (ocupados.includes(iso)) continue;
      gravarAgenda(ocupados.concat(iso));
      return iso;
    }
  }
  throw new Error('Agenda do YouTube cheia.');
}

/** Devolve o horario se o envio falhou, pra outro clipe usar. */
function liberarHorario(iso) {
  gravarAgenda(lerAgenda().filter((t) => t !== iso));
}

module.exports = { ativo, estado, entrar, callback, enviar, montarPost, reservarHorario, liberarHorario, tokenValido, erroDoGoogle, HORARIOS };
