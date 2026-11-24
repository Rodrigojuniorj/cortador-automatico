'use strict';
/**
 * Metricas dos cortes que o programa postou no YouTube (YouTube Analytics), e o
 * que da pra aprender delas: que duracao, streamer, horario e gancho deram mais
 * views neste canal.
 *
 * So entram os cortes postados pelo programa (os que tem youtubeUrl no
 * sessao.json): de video postado a mao nao da pra saber o gancho nem o trecho.
 *
 * O que volta pro corte:
 *   - ganchosDeReferencia: os ganchos que mais e menos deram views vao pra IA
 *     como pista do que funciona com este publico (a partir de 8 medidos).
 *   - preferenciaDeDuracao: pontos na nota pela faixa de duracao que rende mais
 *     (a partir de 30 medidos). Shorts tem muita sorte no meio: com menos que
 *     isso, um video que estourou por acaso viraria regra.
 */

const fs = require('fs');
const path = require('path');
const pastas = require('./pastas');
const youtube = require('./youtube');
const { infoDeJogo } = require('./copy');
const { nomeDoStreamer } = require('./jogo');

const RELATORIO = 'https://youtubeanalytics.googleapis.com/v2/reports';
const HORA = 60 * 60 * 1000;
const ESPERA_MS = 48 * HORA;   // antes disso o numero ainda nao diz nada
const SEM_LINHA_MS = 96 * HORA; // o Analytics atrasa 1-2 dias: sem linha depois disso = 0 view
const REFAZ_MS = 6 * HORA;      // views continuam subindo, mas nao precisa ler toda hora
const MIN_GANCHOS = 8;
const MIN_AJUSTE = 30;
const MIN_GRUPO = 5;

const arquivo = () => path.join(path.dirname(pastas.arquivoConfig()), 'metricas-youtube.json');
function ler() {
  try { return JSON.parse(fs.readFileSync(arquivo(), 'utf8')) || {}; } catch (_) { return {}; }
}
function gravar(dados) {
  fs.mkdirSync(path.dirname(arquivo()), { recursive: true });
  fs.writeFileSync(arquivo(), JSON.stringify(dados, null, 2), 'utf8');
}

const idDoVideo = (url) => (String(url || '').match(/shorts\/([\w-]{6,})/) || [])[1] || null;

function mediana(xs) {
  if (!xs.length) return 0;
  const o = xs.slice().sort((a, b) => a - b);
  const m = Math.floor(o.length / 2);
  return o.length % 2 ? o[m] : (o[m - 1] + o[m]) / 2;
}

function faixa(duracao) {
  if (duracao < 20) return 'Até 20s';
  if (duracao <= 30) return '20 a 30s';
  return 'Mais de 30s';
}

/** Todos os cortes que o programa postou no YouTube, com o que se sabe deles. */
function postados() {
  const base = path.join(pastas.saida(), 'cortes');
  let nomes = [];
  try { nomes = fs.readdirSync(base); } catch (_) { return []; }
  const vistos = new Set();
  const lista = [];
  for (const nome of nomes) {
    let s;
    try { s = JSON.parse(fs.readFileSync(path.join(base, nome, 'sessao.json'), 'utf8')); } catch (_) { continue; }
    for (const c of s.clipes || []) {
      const id = idDoVideo(c.youtubeUrl);
      if (!id || vistos.has(id)) continue;
      vistos.add(id);
      let info = null;
      try { info = c.contextoJogo ? infoDeJogo(c, c.contextoJogo) : null; } catch (_) { /* sem contexto: fica sem nome */ }
      lista.push({
        id, url: c.youtubeUrl, projeto: nome, numero: c.numero,
        titulo: c.titulo || '', gancho: c.gancho || null,
        // live gravada pelo programa nao guarda o canal no clipe, mas a pasta tem: Nome-Do-Canal_ao-vivo_...
        streamer: (info && info.streamer) || nomeDoStreamer((nome.match(/^(.+?)_ao-vivo_/) || [])[1]) || null,
        duracao: Number(c.duracao) || 0, nota: c.nota || null,
        publicado: c.youtubeAgendado || c.enviadoYouTube,
        miniatura: c.miniatura || null,
      });
    }
  }
  return lista;
}

/** Postados que ja tem metrica gravada, com ela em p.metricas. */
function medidos() {
  const m = ler();
  return postados().filter((p) => m[p.id]).map((p) => Object.assign(p, { metricas: m[p.id] }));
}

/** Busca no YouTube Analytics as metricas dos cortes com 48h ou mais. */
async function atualizar() {
  const token = await youtube.tokenValido();
  if (!token) throw Object.assign(new Error('Conecte o YouTube primeiro.'), { precisaLogin: true });
  if (!youtube.estado().metricas) {
    throw Object.assign(new Error('Conecte o YouTube de novo para liberar a leitura das métricas.'), { precisaLogin: true });
  }

  const salvas = ler();
  const agora = Date.now();
  const idade = (p) => agora - Date.parse(p.publicado);
  const alvo = postados().filter((p) => idade(p) >= ESPERA_MS &&
    !(salvas[p.id] && agora - Date.parse(salvas[p.id].em) < REFAZ_MS));

  const hoje = new Date().toLocaleDateString('sv-SE'); // AAAA-MM-DD no fuso do PC
  for (let i = 0; i < alvo.length; i += 200) {
    const lote = alvo.slice(i, i + 200);
    const q = new URLSearchParams({
      ids: 'channel==MINE',
      startDate: '2020-01-01',
      endDate: hoje,
      metrics: 'views,averageViewDuration,averageViewPercentage,likes,subscribersGained',
      dimensions: 'video',
      filters: 'video==' + lote.map((p) => p.id).join(','),
      sort: '-views',
      maxResults: '200',
    });
    const r = await fetch(RELATORIO + '?' + q, { headers: { Authorization: 'Bearer ' + token } });
    if (!r.ok) throw await youtube.erroDoGoogle(r);
    const j = await r.json();
    const nomes = (j.columnHeaders || []).map((h) => h.name);
    const linhas = new Map((j.rows || []).map((row) => [row[0], Object.fromEntries(nomes.map((n, k) => [n, row[k]]))]));
    for (const p of lote) {
      const l = linhas.get(p.id);
      if (!l && idade(p) < SEM_LINHA_MS) continue;
      salvas[p.id] = {
        views: Number(l && l.views) || 0,
        retencao: Number(l && l.averageViewPercentage) || 0,
        tempoMedio: Number(l && l.averageViewDuration) || 0,
        likes: Number(l && l.likes) || 0,
        inscritos: Number(l && l.subscribersGained) || 0,
        em: new Date().toISOString(),
      };
    }
  }
  gravar(salvas);
  return resumo();
}

function agrupar(lista, chave) {
  const g = new Map();
  for (const p of lista) {
    const k = chave(p);
    if (!g.has(k)) g.set(k, []);
    g.get(k).push(p);
  }
  return [...g].map(([nome, ps]) => ({
    nome,
    videos: ps.length,
    views: mediana(ps.map((p) => p.metricas.views)),
    retencao: Math.round(mediana(ps.map((p) => p.metricas.retencao))),
  })).sort((a, b) => b.views - a.views);
}

/** O que o painel mostra: lista por views e grupos (mediana, nao media: um viral distorce). */
function resumo() {
  const m = ler();
  const lista = postados().map((p) => (m[p.id] ? Object.assign(p, { metricas: m[p.id] }) : p));
  const med = lista.filter((p) => p.metricas);
  lista.sort((a, b) => (b.metricas ? b.metricas.views : -1) - (a.metricas ? a.metricas.views : -1));
  return {
    total: lista.length,
    medidos: med.length,
    minimoAjuste: MIN_AJUSTE,
    minimoGanchos: MIN_GANCHOS,
    ajusteLigado: med.length >= MIN_AJUSTE,
    ganchosLigados: med.filter((p) => p.gancho).length >= MIN_GANCHOS,
    lista,
    grupos: med.length ? {
      streamer: agrupar(med, (p) => p.streamer || 'Sem nome'),
      duracao: agrupar(med, (p) => faixa(p.duracao)),
      horario: agrupar(med, (p) => String(new Date(p.publicado).getHours()).padStart(2, '0') + 'h'),
    } : null,
  };
}

/** Ganchos que mais e menos deram views, pra IA. null = poucos dados. */
function ganchosDeReferencia() {
  const com = medidos().filter((p) => p.gancho).sort((a, b) => b.metricas.views - a.metricas.views);
  if (com.length < MIN_GANCHOS) return null;
  const n = Math.min(5, Math.floor(com.length / 2));
  const so = (p) => ({ gancho: p.gancho, views: p.metricas.views, retencao: Math.round(p.metricas.retencao) });
  return { bons: com.slice(0, n).map(so), ruins: com.slice(-n).map(so) };
}

/**
 * Pontos pela faixa de duracao, comparando a mediana de views dela com a do
 * canal. Devolve (duracao) => { pontos, fator } | null, ou null se faltar dado.
 */
function preferenciaDeDuracao() {
  const med = medidos();
  if (med.length < MIN_AJUSTE) return null;
  const geral = mediana(med.map((p) => p.metricas.views));
  const pontos = {};
  for (const g of agrupar(med, (p) => faixa(p.duracao))) {
    if (g.videos < MIN_GRUPO) continue;
    // +10 nos dois lados: canal pequeno com mediana 3 vs 6 nao vira "o dobro"
    pontos[g.nome] = Math.max(-5, Math.min(5, Math.round(4 * Math.log2((g.views + 10) / (geral + 10)))));
  }
  return (duracao) => {
    const nome = faixa(duracao);
    const p = pontos[nome];
    if (!p) return null;
    return { pontos: p, fator: (p > 0 ? 'Duração que rende mais no seu canal' : 'Duração que rende menos no seu canal') + ' (' + nome + ')' };
  };
}

module.exports = { postados, atualizar, resumo, ganchosDeReferencia, preferenciaDeDuracao, faixa, mediana, idDoVideo };
