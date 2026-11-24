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
  '- Não conte o desfecho. Não invente nome de personagem, lugar ou objeto.',
  '- Sem emoji, sem hashtag, sem aspas, sem palavrão.',
  '- A transcrição é automática e erra palavras: entenda a ideia, não copie frases soltas.',
  '- Pense em 3 opções com ideias diferentes e escolha a que mais faria você parar de rolar.',
  '- Se a fala não deixar claro o que acontece, responda apenas: NADA',
  '',
  'Responda só com o gancho escolhido, sem explicação.',
].join('\n');

/**
 * @param {object} p { fala, antes, streamer, jogo, evitar: Set }
 * @returns {Promise<string|null>} gancho em caixa alta, ou null (usar o de regra)
 */
async function ganchoDaIa(p) {
  if (!ativo()) return null;
  const fala = String(p.fala || '').trim();
  if (fala.split(/\s+/).length < 4) return null; // sem fala nao ha o que entender

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
  ].join('\n');

  const r = await cliente.beta.messages.create({
    model: MODELO,
    max_tokens: 2000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',               // se o modelo recusar, outro modelo tenta na mesma chamada
    output_config: { effort: 'medium' }, // pensar nas 3 opcoes antes de escolher (low saia literal demais)
    system: SISTEMA,
    messages: [{ role: 'user', content: pedido }],
  });
  if (r.stop_reason === 'refusal') return null;

  const texto = r.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ');
  return limparGancho(texto);
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

module.exports = { ativo, ganchoDaIa, limparGancho, MODELO };
