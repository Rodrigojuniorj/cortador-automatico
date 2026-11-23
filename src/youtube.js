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
 * Projeto do Google sem auditoria: o YouTube trava o video como PRIVADO ate o
 * projeto passar na auditoria (gratis) da YouTube API. A cota padrao (10.000
 * unidades/dia, 1.600 por envio) da uns 6 envios por dia.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const pastas = require('./pastas');

const ESCOPO = 'https://www.googleapis.com/auth/youtube.upload';
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
  return { ativo: ativo(), conectado: !!(t && t.refresh_token), entrando: !!pendente, erro: ultimoErro };
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
  quotaExceeded: 'Acabou a cota do dia da API do YouTube (uns 6 envios). Volta amanhã.',
  uploadLimitExceeded: 'O YouTube limitou os envios deste canal por hoje.',
  youtubeSignupRequired: 'Essa conta Google não tem canal no YouTube. Crie o canal e conecte de novo.',
  authError: 'O login do YouTube venceu. Conecte de novo.',
};

async function erroDoGoogle(r) {
  const j = await r.json().catch(() => ({}));
  const e = j.error || {};
  const motivo = (e.errors && e.errors[0] && e.errors[0].reason) || e.status || '';
  return new Error(ERROS[motivo] || ('YouTube (' + (motivo || 'HTTP ' + r.status) + '): ' + (e.message || 'sem detalhe')));
}

// Titulo do YouTube: ate 100 caracteres e sem < > (o YouTube recusa). #shorts no
// fim: o YouTube ja reconhece Short pelo formato, mas deixa explicito pra busca.
function tituloOk(t) {
  let titulo = String(t || 'Corte').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim();
  if (!/#shorts\b/i.test(titulo)) titulo = titulo.slice(0, 100 - ' #shorts'.length).trim() + ' #shorts';
  return titulo.slice(0, 100);
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
  const meta = {
    snippet: { title: tituloOk(post.titulo), description: descricao, tags, categoryId: '20' }, // 20 = Jogos
    status: { privacyStatus: 'public', selfDeclaredMadeForKids: false },
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
  };
}

module.exports = { ativo, estado, entrar, callback, enviar };
