'use strict';
/**
 * Gancho de tela escrito pela IA (Claude), que le o que foi dito no corte e
 * antes dele e descreve a SITUACAO ("ELE ROUBOU O CARRO ERRADO") - coisa que a
 * regra nao consegue, porque nao entende a cena.
 *
 * Opcional: so liga com ANTHROPIC_API_KEY no .env e o pacote @anthropic-ai/sdk
 * instalado (dependencia opcional). Sem isso, ou se a IA falhar/recusar, quem
 * chama usa o gancho por regra de sempre.
 */

let Anthropic = null;
try { Anthropic = require('@anthropic-ai/sdk').default; } catch (_) { /* sem o pacote: fica desligado */ }

const MODELO = process.env.ANTHROPIC_MODELO || 'claude-opus-5-5';
let cliente = null;

const ativo = () => !!(Anthropic && process.env.ANTHROPIC_API_KEY);

// Primeira versao pedia "descreva a situacao" e saiu certo mas sem graca ("DA PRA
// LER OS PRODUTOS NO GTA 6"). Gancho que para o dedo cria tensao ou lacuna -
// por isso os exemplos de bom e ruim e as 3 opcoes antes de escolher.
const SISTEMA = [
  'Você escreve o gancho que aparece na tela de cortes verticais de lives de jogos (principalmente',
  'GTA 6), postados no YouTube Shorts e no TikTok por um canal brasileiro de cortes.',
  'A pessoa está rolando o feed rápido. O gancho tem uma única função: fazer ela PARAR e assistir.',
  'Um gancho que só descreve a cena falhou, mesmo estando certo.',
  '',
  'O que faz parar (use uma destas ideias, a que combinar com o trecho):',
  '- Lacuna: algo que só fecha assistindo. "NINGUÉM REPAROU NISSO NO GTA 6"',
  '- Contraste ou surpresa: "NO GTA 5 ISSO ERA UM BORRÃO"',
  '- Tensão ou aposta: "O CHAT ESCOLHEU E DEU RUIM", "ELE SABIA QUE IA DAR ERRADO"',
  '- Reação forte do streamer: "ELE NÃO ACREDITOU NO PREÇO"',
  '- Pergunta que provoca opinião: "ISSO É O MAIS REALISTA DO GTA 6?"',
  '',
  'Ruim (descreve e não provoca): "ELE ENTROU NO MERCADINHO", "DÁ PRA LER OS PRODUTOS NO GTA 6".',
  'Bom (mesmo trecho): "NO GTA 6 DÁ PRA LER ATÉ ISSO", "O DETALHE DO GTA 6 QUE NINGUÉM VIU".',
  '',
  'Regras:',
  '- De 3 a 7 palavras, português do Brasil falado, tudo em CAIXA ALTA.',
  '- Tem que ser verdade no trecho: não prometa ação, susto, briga ou final que a fala não mostra.',
  '  Exagero de tom é ok ("ABSURDO", "INSANO") só se o streamer reagiu assim.',
  '- Exclamação ("caraca", "nossa", "meu deus") ou voz alta NÃO prova susto, choque ou surto. Só diga',
  '  que ele se assustou, surtou, gritou, ficou sem reação ou não acreditou se a fala mostrar isso.',
  '  Vale para o gancho, o título e o resumo.',
  '- Não conte o desfecho. Não invente nome de personagem, lugar ou objeto.',
  '- Sem emoji, sem hashtag, sem aspas, sem palavrão.',
  '- A transcrição é automática e erra palavras: entenda a ideia, não copie frases soltas.',
  '- Pense em 3 opções com ideias diferentes e escolha a que mais faria você parar de rolar.',
  '',
  'Você também escreve o TÍTULO do post (o texto embaixo do vídeo no YouTube e no TikTok).',
  'Nos cortes de GTA que mais deram views em 2026, o título conta a cena com o nome do streamer:',
  '"PAULINHO LOKO ACHOU CAVALOS NO GTA 6", "As meninas do chat escolheram o cabelo da Lucia no GTA 6",',
  '"Todyn fingiu ser o dono do morro e o coringa não deixou barato".',
  'Título genérico, que serve pra qualquer vídeo, não funciona: "O momento mais insano da live",',
  '"Olha essa reação", "Ninguém esperava isso", "surtou com isso".',
  'Regras do título:',
  '- De 5 a 12 palavras, no máximo 70 caracteres, português do Brasil.',
  '- Comece pelo nome do streamer quando ele for informado. Cite o jogo se couber natural.',
  '- Diga o que acontece de concreto no trecho, com tensão ou curiosidade, sem contar o desfecho.',
  '- Tem que ser verdade no trecho, igual ao gancho. Não invente nome, lugar ou objeto.',
  '- Diferente do gancho: o gancho prende na tela, o título diz do que é o vídeo.',
  '- Sem emoji, sem hashtag, sem aspas, sem palavrão.',
  '',
  'Por fim, o RESUMO: a primeira frase da descrição do YouTube, que o algoritmo lê pra saber do que',
  'é o vídeo. Uma frase de 8 a 25 palavras que conta o que acontece no trecho, com o nome do streamer',
  'e do jogo. Sem emoji, sem hashtag, sem inventar.',
  '',
  'Responda em exatamente três linhas, sem explicação:',
  'GANCHO: <o gancho escolhido>',
  'TITULO: <o título>',
  'RESUMO: <a frase>',
  'Se a fala não deixar claro o que acontece, escreva NADA no lugar do texto.',
].join('\n');

/**
 * Gancho de tela e titulo do post, numa chamada so.
 * @param {object} p { fala, antes, streamer, jogo, evitar: Set, evitarTitulos: Set,
 *                     referencia: { bons, ruins } | null }
 * @returns {Promise<{gancho, titulo, resumo: string|null}>} null = usar o de regra
 */
async function textosDaIa(p) {
  const nada = { gancho: null, titulo: null, resumo: null };
  if (!ativo()) return nada;
  const fala = String(p.fala || '').trim();
  if (fala.split(/\s+/).length < 4) return nada; // sem fala nao ha o que entender

  if (!cliente) cliente = new Anthropic({ maxRetries: 2, timeout: 60 * 1000 });
  const usados = p.evitar && p.evitar.size ? [...p.evitar].join(' | ') : 'nenhum';
  const pedido = [
    'Streamer: ' + (p.streamer || 'não informado'),
    'Jogo: ' + (p.jogo || 'não informado'),
    '',
    'Fala nos 20 segundos antes do corte (só contexto):',
    String(p.antes || '').trim() || '(nada)',
    '',
    'Fala dentro do corte:',
    fala,
    '',
    'Ganchos já usados em outros cortes desta live (não repita): ' + usados,
    // titulo repetido no canal tem cara de robo (ja aconteceu: dois videos com o mesmo)
    'Títulos já usados no canal (não repita nem chegue perto): ' +
      (p.evitarTitulos && p.evitarTitulos.size ? [...p.evitarTitulos].slice(-40).join(' | ') : 'nenhum'),
  ].concat(p.referencia ? [
    '',
    'Ganchos deste canal que MAIS deram views (pista do que funciona com este público; não copie):',
    ...p.referencia.bons.map((g) => '- ' + g.gancho + ' (' + g.views + ' views, ' + g.retencao + '% assistido)'),
    'Ganchos deste canal que MENOS deram views (evite esse jeito):',
    ...p.referencia.ruins.map((g) => '- ' + g.gancho + ' (' + g.views + ' views, ' + g.retencao + '% assistido)'),
  ] : []).join('\n');

  const r = await cliente.beta.messages.create({
    model: MODELO,
    max_tokens: 2000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',               // se o modelo recusar, outro modelo tenta na mesma chamada
    output_config: { effort: 'medium' }, // pensar nas 3 opcoes antes de escolher (low saia literal demais)
    system: SISTEMA,
    messages: [{ role: 'user', content: pedido }],
  });
  if (r.stop_reason === 'refusal') return nada;

  const texto = r.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  return lerResposta(texto, p.evitarTitulos);
}

/** As linhas "GANCHO: ..." e "TITULO: ...". Linha fora do formato vira null. */
function lerResposta(texto, evitarTitulos) {
  const linha = (rotulo) => (String(texto || '').match(new RegExp('^\\s*' + rotulo + '\\s*:\\s*(.+)$', 'im')) || [])[1];
  const titulo = limparTitulo(linha('T[IÍ]TULO'));
  return {
    gancho: limparGancho(linha('GANCHO')),
    titulo: titulo && !(evitarTitulos && evitarTitulos.has(titulo.toLowerCase())) ? titulo : null,
    resumo: limparResumo(linha('RESUMO')),
  };
}

function limparResumo(texto) {
  const t = String(texto || '')
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, '')
    .replace(/["“”«»*]/g, '')
    .replace(/#\S+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t || /^nada\.?$/i.test(t) || t.split(' ').length < 5 || t.length > 250) return null;
  return /[.!?]$/.test(t) ? t : t + '.';
}

function limparTitulo(texto) {
  const t = String(texto || '')
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, '')
    .replace(/["“”«»*]/g, '')
    .replace(/#\S+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.]+$/, '');
  const palavras = t.split(' ').filter(Boolean).length;
  if (!t || /^nada$/i.test(t) || palavras < 3 || palavras > 16 || t.length > 90) return null;
  return t;
}

/** Confere o formato que a IA devolveu. Fora do combinado vira null (usa a regra). */
function limparGancho(texto) {
  const t = String(texto || '')
    .replace(/[\p{Extended_Pictographic}\u{FE0F}]/gu, '')
    .replace(/["'“”«»#*]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase()
    .replace(/[.]+$/, '');
  const palavras = t.split(' ').filter(Boolean).length;
  if (!t || t === 'NADA' || palavras < 2 || palavras > 9 || t.length > 60) return null;
  return t;
}

module.exports = { ativo, textosDaIa, lerResposta, limparGancho, limparTitulo, limparResumo, MODELO };
