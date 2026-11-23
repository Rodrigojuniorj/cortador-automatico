'use strict';
/**
 * Manda o clipe pro TikTok como RASCUNHO: ele chega na caixa de entrada do app
 * e a pessoa so poe a legenda e publica. So funciona no PC que tem as chaves no
 * .env (TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET, TIKTOK_REDIRECT_URI) - sem elas
 * o botao nem aparece e o programa segue sem API nenhuma, como sempre.
 *
 * Por que rascunho e nao postar direto: o app do TikTok esta em sandbox (sem
 * auditoria), e app sem auditoria so posta direto em CONTA privada (erro
 * unaudited_client_can_only_post_to_private_accounts, testado em 2026-11).
 *
 * Login: o TikTok so aceita voltar pra endereco https. Durante o login sobe um
 * servidorzinho na porta 3000 SO com /callback, /terms e /privacy (nunca o
 * programa inteiro) e o ngrok expoe ele no dominio do TIKTOK_REDIRECT_URI.
 * Os dois fecham assim que o token chega.
 */

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const pastas = require('./pastas');

const API = 'https://open.tiktokapis.com';
const PORTA_LOGIN = Number(process.env.TIKTOK_PORTA_LOGIN || 3000);
const UM_PEDACO_ATE = 64 * 1024 * 1024;
const PEDACO = 10 * 1024 * 1024;

const cfg = () => ({
  chave: process.env.TIKTOK_CLIENT_KEY || '',
  segredo: process.env.TIKTOK_CLIENT_SECRET || '',
  redirect: process.env.TIKTOK_REDIRECT_URI || '',
});
const ativo = () => { const c = cfg(); return !!(c.chave && c.segredo && c.redirect); };

// Fica junto do config.json (AppData), fora do repositorio e da pasta de dados
const arquivoTokens = () => path.join(path.dirname(pastas.arquivoConfig()), 'tiktok.json');

function lerTokens() {
  try { return JSON.parse(fs.readFileSync(arquivoTokens(), 'utf8')); } catch (_) { return null; }
}

function gravarTokens(t) {
  const agora = Date.now();
  const dados = {
    access_token: t.access_token,
    refresh_token: t.refresh_token,
    open_id: t.open_id,
    expira: agora + (Number(t.expires_in) - 60) * 1000,
    refreshExpira: agora + (Number(t.refresh_expires_in) - 60) * 1000,
  };
  fs.mkdirSync(path.dirname(arquivoTokens()), { recursive: true });
  fs.writeFileSync(arquivoTokens(), JSON.stringify(dados, null, 2), 'utf8');
  return dados;
}

async function pedirToken(campos) {
  const c = cfg();
  const r = await fetch(API + '/v2/oauth/token/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(Object.assign({ client_key: c.chave, client_secret: c.segredo }, campos)),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.access_token) throw new Error('O TikTok recusou o login: ' + (j.error_description || j.error || 'HTTP ' + r.status));
  return gravarTokens(j);
}

/** Token que vale agora (renova sozinho). null = precisa conectar de novo. */
async function tokenValido() {
  const t = lerTokens();
  if (!t) return null;
  if (Date.now() < t.expira) return t.access_token;
  if (Date.now() >= t.refreshExpira) return null;
  try {
    return (await pedirToken({ grant_type: 'refresh_token', refresh_token: t.refresh_token })).access_token;
  } catch (_) {
    return null; // a pessoa tirou a permissao no app: conecta de novo
  }
}

// ---------------------------------------------------------------- login

let login = null;     // { servidor, ngrok, timer } enquanto espera o TikTok voltar
let ultimoErro = null;

function estado() {
  const t = lerTokens();
  return { ativo: ativo(), conectado: !!(t && Date.now() < t.refreshExpira), entrando: !!login, erro: ultimoErro };
}

function fecharLogin() {
  if (!login) return;
  const l = login;
  login = null;
  clearTimeout(l.timer);
  try { l.servidor.close(); } catch (_) {}
  if (l.ngrok && l.ngrok.exitCode === null) {
    // /T: o ngrok do Chocolatey e um atalho que abre o ngrok de verdade como filho
    if (process.platform === 'win32') execFile('taskkill', ['/PID', String(l.ngrok.pid), '/T', '/F'], () => {});
    else l.ngrok.kill();
  }
}

const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
const pagina = (titulo, texto) => '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
  '<title>' + esc(titulo) + '</title><body style="font-family:system-ui,sans-serif;max-width:560px;margin:48px auto;padding:0 16px;line-height:1.55">' +
  '<h2>' + esc(titulo) + '</h2><p>' + esc(texto) + '</p>';

const TEXTOS = {
  '/terms': ['Termos de uso', 'Ferramenta pessoal do Cortador Automático: envia clipes feitos no próprio PC do criador para a caixa de entrada do TikTok dele, como rascunho. Nada é publicado sem o criador tocar em publicar no app.'],
  '/privacy': ['Privacidade', 'O programa guarda só o token de acesso do TikTok, no próprio PC do criador. Nenhum dado é enviado a terceiros além do vídeo que o criador escolhe mandar para o TikTok.'],
};

/** Liga o servidorzinho + ngrok e devolve o link de autorizacao do TikTok. */
function entrar() {
  if (!ativo()) throw new Error('Faltam as chaves do TikTok no .env.');
  fecharLogin();
  ultimoErro = null;
  const c = cfg();
  const destino = new URL(c.redirect);
  const estadoOAuth = crypto.randomBytes(16).toString('hex');

  const servidor = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://localhost');
    const html = (cod, titulo, texto) => {
      res.writeHead(cod, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(pagina(titulo, texto));
    };
    if (TEXTOS[u.pathname]) return html(200, TEXTOS[u.pathname][0], TEXTOS[u.pathname][1]);
    if (u.pathname !== destino.pathname) return html(200, 'Cortador Automático', 'Envia clipes do PC para o TikTok como rascunho.');
    if (u.searchParams.get('state') !== estadoOAuth) return html(400, 'Link vencido', 'Volte ao programa e clique em conectar de novo.');

    const codigo = u.searchParams.get('code');
    if (!codigo) {
      ultimoErro = u.searchParams.get('error_description') || 'O TikTok não autorizou.';
      html(400, 'Não conectou', ultimoErro);
      return fecharLogin();
    }
    try {
      await pedirToken({ code: codigo, grant_type: 'authorization_code', redirect_uri: c.redirect });
      html(200, 'TikTok conectado', 'Pode fechar esta aba e voltar ao programa.');
    } catch (e) {
      ultimoErro = e.message;
      html(500, 'Não conectou', e.message);
    }
    fecharLogin();
  });
  servidor.on('error', (e) => {
    ultimoErro = e.code === 'EADDRINUSE' ? 'A porta ' + PORTA_LOGIN + ' está ocupada; feche o que usa ela e tente de novo.' : e.message;
    fecharLogin();
  });
  servidor.listen(PORTA_LOGIN, '127.0.0.1');

  const ngrok = spawn(process.env.NGROK_BIN || 'ngrok', ['http', String(PORTA_LOGIN), '--url=' + destino.origin], { stdio: 'ignore', windowsHide: true });
  ngrok.on('error', () => { ultimoErro = 'Não achei o ngrok instalado.'; fecharLogin(); });
  ngrok.on('exit', (cod) => {
    if (!login || login.ngrok !== ngrok) return;
    ultimoErro = 'O ngrok fechou (código ' + cod + '). Rode "ngrok http ' + PORTA_LOGIN + ' --url=' + destino.origin + '" num terminal pra ver o motivo.';
    fecharLogin();
  });

  login = { servidor, ngrok, timer: setTimeout(fecharLogin, 10 * 60 * 1000) };

  return 'https://www.tiktok.com/v2/auth/authorize/?' + new URLSearchParams({
    client_key: c.chave,
    scope: 'user.info.basic,video.upload',
    response_type: 'code',
    redirect_uri: c.redirect,
    state: estadoOAuth,
  });
}

// ---------------------------------------------------------------- envio

const ERROS = {
  spam_risk_too_many_pending_share: 'Já tem 5 rascunhos esperando no app do TikTok. Publique ou apague algum e tente de novo.',
  rate_limit_exceeded: 'Muitos envios seguidos. Espere um minuto e tente de novo.',
  access_token_invalid: 'O login do TikTok venceu. Conecte de novo.',
  scope_not_authorized: 'A conta não deu permissão de envio. Conecte de novo e aceite tudo.',
};

async function api(rota, token, corpo) {
  const r = await fetch(API + rota, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify(corpo),
  });
  const j = await r.json().catch(() => ({}));
  const erro = j.error || {};
  if (erro.code !== 'ok') throw new Error(ERROS[erro.code] || ('TikTok (' + (erro.code || 'HTTP ' + r.status) + '): ' + (erro.message || 'sem detalhe')));
  return j.data || {};
}

const TIPO_VIDEO = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm' };

async function precisaToken() {
  const token = await tokenValido();
  if (!token) throw Object.assign(new Error('Conecte o TikTok primeiro.'), { precisaLogin: true });
  return token;
}

/** Envia o arquivo e espera o TikTok confirmar que chegou na caixa de entrada. */
async function enviar(arquivo) {
  const token = await precisaToken();
  const id = await subir(token, arquivo, '/v2/post/publish/inbox/video/init/', null);
  await esperar(token, id, ['SEND_TO_USER_INBOX', 'PUBLISH_COMPLETE']);
  return { ok: true, publishId: id };
}

/** Inicia o envio na rota pedida, sobe o arquivo em pedacos e devolve o publish_id. */
async function subir(token, arquivo, rota, postInfo) {
  const tamanho = fs.statSync(arquivo).size;
  // shortcut: regra de pedacos vinda de memoria (ate 64 MB vai inteiro; acima, 10 MB e o ultimo leva o resto) - o guia do TikTok deu 403; se der erro de tamanho, conferir la
  const pedaco = tamanho <= UM_PEDACO_ATE ? tamanho : PEDACO;
  const total = Math.floor(tamanho / pedaco);
  const tipo = TIPO_VIDEO[path.extname(arquivo).toLowerCase()] || 'video/mp4';

  const corpo = { source_info: { source: 'FILE_UPLOAD', video_size: tamanho, chunk_size: pedaco, total_chunk_count: total } };
  if (postInfo) corpo.post_info = postInfo;
  const d = await api(rota, token, corpo);

  const fd = fs.openSync(arquivo, 'r');
  try {
    for (let i = 0; i < total; i++) {
      const ini = i * pedaco;
      const fim = i === total - 1 ? tamanho - 1 : ini + pedaco - 1;
      const buf = Buffer.alloc(fim - ini + 1);
      fs.readSync(fd, buf, 0, buf.length, ini);
      const r = await fetch(d.upload_url, {
        method: 'PUT',
        headers: { 'Content-Type': tipo, 'Content-Range': 'bytes ' + ini + '-' + fim + '/' + tamanho },
        body: buf,
      });
      if (!r.ok) throw new Error('O TikTok recusou o arquivo (HTTP ' + r.status + ').');
    }
  } finally {
    fs.closeSync(fd);
  }
  return d.publish_id;
}

/** Espera o TikTok processar ate um dos status de pronto. */
async function esperar(token, publishId, prontos) {
  // O status aceita 30 consultas/minuto; a cada 3 s fica folgado
  for (let i = 0; i < 60; i++) {
    await new Promise((ok) => setTimeout(ok, 3000));
    const s = await api('/v2/post/publish/status/fetch/', token, { publish_id: publishId });
    if (prontos.includes(s.status)) return s;
    if (s.status === 'FAILED') throw new Error('O TikTok não aceitou o vídeo: ' + (s.fail_reason || 'sem motivo informado'));
  }
  throw new Error('O TikTok ainda está processando. Confira o app daqui a pouco.');
}

module.exports = { ativo, estado, entrar, enviar };
