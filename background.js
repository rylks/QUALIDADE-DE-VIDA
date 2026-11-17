const API = "https://z6ywq6r3ub.execute-api.us-east-1.amazonaws.com/api/ranking/channel";
const CHAR_URL = "https://riftstream.com.br/character";
const DEFAULTS = {
  enabled: false, livesText: "", lives: [],
  resetZone: 1, scanGapSec: 120, autoJogar: true,
  phase: "idle", queue: [], results: {}, joinQueue: [], joinIdx: 0,
  visitDeadline: 0, nextScanAt: 0, lastScanStart: 0, errStreak: 0, siteError: false,
  prevTabId: null, char: null, tabId: null, charTabId: null, lastCharReload: 0,
  current: null, status: "", scanSummary: "",
  disabled: [], stallMin: 5, zoneKey: null, zoneSince: 0, stalledScan: false,
  autoScanMin: 2, autoScan: false, nextAutoScanAt: 0, rejoinMin: 0, lastJoined: null, lastJogarAt: 0,
  discoverEnabled: true, discoverMin: 2, discoverTop: 20, discoveredLives: [], nextDiscoverAt: 0, discoverBusy: false, discoverStartedAt: 0, discoverStatus: "",
  discoverFailStreak: 0, lastDiscoverOkAt: 0, lastDiscoverAttemptAt: 0,
  autoFollow: false, followWaitSec: 15, sendMethod: "chat", twitchClientId: "",
  suggestedLive: null, approvedLive: null,
  liveMode: "manual", allowedLives: [], // modos: manual, allowed, automatic
  muteLives: true, // Twitch abre com o áudio da aba desligado (Chrome nativo)
};
const VISIT_TIMEOUT = 100 * 1000; // mantém o limite original quando follow automático está desligado
const CHAR_RELOAD_MS = 30 * 1000;         // atualiza a página a cada ~45-60s; DOM é lido a cada 5s
const CHAR_RELOAD_ERR_MS = 3 * 60 * 1000; // se o servidor falhar, evita insistir em excesso
const FETCH_TIMEOUT = 8000;
const FETCH_GAP_MS = 800;                  // pausa entre uma live e outra
const MAX_BACKOFF_MS = 15 * 60 * 1000;
const MAX_DISCOVER_BACKOFF_MS = 30 * 60 * 1000;
const MIN_DISCOVER_SPACING_MS = 20 * 1000;
const RANKING_CROWDS_API = "https://z6ywq6r3ub.execute-api.us-east-1.amazonaws.com/api/ranking/crowds";
const RANKING_CHARACTERS_API = "https://z6ywq6r3ub.execute-api.us-east-1.amazonaws.com/api/ranking/characters";
const RANK_CHECK_MS = 10 * 60 * 1000; // ranking de personagem não exige recarregar o perfil
const CHECK_WORKERS = 4; // consultas de lives concorrentes, mas limitadas para não saturar a API

const RANKING_PAGE_SIZE = 20;             // endpoint confirmado no ranking; pagina para alcançar o Top 50
const CACHE_MS = 45 * 1000;                   // reaproveita consultas recentes (a descoberta já consulta a API)
// A tabela "JOGANDO AGORA" usa /board?board=now. Cada jogador possui "power" (= FC).
// Lemos TODAS as páginas antes de apresentar um FC total. Nunca somamos apenas o Top 20.
const FC_BOARD_PAGE_SIZE = 20;
const FC_BOARD_MAX_PAGES = 150;       // limite de segurança; em resposta maior exibimos indisponível
const FC_BOARD_REFRESH_MS = 3 * 60 * 1000;
const FC_BOARD_FRESH_MS = 6 * 60 * 1000;
const FC_BOARD_RETRY_MS = 60 * 1000; // falhas transitórias recebem nova chance mais cedo
const FC_BOARD_WORKERS = 2;          // baixo paralelismo, separado da busca de zonas
let fcRefreshBusy = false;
const fcInFlight = new Set(); // evita consultar o mesmo canal simultaneamente
let fcLargePageSupported = null; // usa páginas maiores apenas se a API as aceitar
let fcPauseUntilLocal = 0;
const chanCache = new Map();
const discoverMs = (st) => Math.max(2, Number(st.discoverMin) || 30) * 60000;
const discoverTop = (st) => Math.min(50, Math.max(1, Number(st.discoverTop) || 20));
const MIN_SCAN_SPACING = 10 * 1000;        // trava anti-spam (inclusive no "Procurar agora")
const validLogin = (login) => /^[a-z0-9_]{2,25}$/.test(String(login || ""));
const modeOf = (st) => ["manual", "allowed", "automatic"].includes(st.liveMode) ? st.liveMode : "manual";
const allowedList = (st) => [...new Set(Array.isArray(st.allowedLives) ? st.allowedLives : [])]
  .filter(validLogin);
const canUseLive = (st, login) => !st.disabled.includes(login) &&
  (modeOf(st) !== "allowed" || allowedList(st).includes(login));

// Entrada opcional sem abrir Twitch: OAuth implícito oficial (app sem backend).
// O token NÃO fica em storage.local, mas em storage.session (acesso de contextos confiáveis),
// e precisa de nova autorização após reiniciar o navegador.
const TWITCH_SCOPE = "user:write:chat";
const TWITCH_COOLDOWN_MS = 10 * 60000; // anti-duplicação por canal (inclui tentativas sem confirmação)
const AUTH_VALIDATE_MS = 60 * 60000;
const TWITCH_API_TIMEOUT_MS = 12000;
const getAuth = async () => (await chrome.storage.session.get("twitchAuth")).twitchAuth || null;
const authRedirect = () => chrome.identity.getRedirectURL("twitch");

async function twitchFetch(url, options = {}) {
  const ctl = new AbortController();
  const timeout = setTimeout(() => ctl.abort(), TWITCH_API_TIMEOUT_MS);
  try { return await fetch(url, { ...options, signal: ctl.signal, credentials: "omit", cache: "no-store" }); }
  finally { clearTimeout(timeout); }
}

async function validateTwitch(token) {
  const resp = await twitchFetch("https://id.twitch.tv/oauth2/validate", {
    headers: { Authorization: `OAuth ${token}` },
  });
  if (!resp.ok) throw new Error(resp.status === 401 ? "Autorização expirada ou inválida." : `Validação da Twitch: HTTP ${resp.status}.`);
  const data = await resp.json();
  if (!data.user_id || !data.client_id || !Array.isArray(data.scopes) || !data.scopes.includes(TWITCH_SCOPE)) {
    throw new Error("A Twitch não autorizou a permissão user:write:chat.");
  }
  return data;
}

async function connectTwitch() {
  const { twitchClientId } = await chrome.storage.local.get("twitchClientId");
  const clientId = String(twitchClientId || "").trim().toLowerCase();
  if (!/^[a-z0-9]{10,64}$/.test(clientId)) {
    throw new Error("Preencha o Client ID do aplicativo cadastrado no Twitch Developers.");
  }
  const stateBytes = new Uint8Array(24);
  crypto.getRandomValues(stateBytes);
  const state = [...stateBytes].map((x) => x.toString(16).padStart(2, "0")).join("");
  const redirect = authRedirect();
  const u = new URL("https://id.twitch.tv/oauth2/authorize");
  u.search = new URLSearchParams({
    client_id: clientId, redirect_uri: redirect, response_type: "token", scope: TWITCH_SCOPE, state,
  }).toString();
  // Iniciado pelo usuário em Configurações. O popup pode fechar durante a autorização.
  const finalUrl = await chrome.identity.launchWebAuthFlow({ url: u.href, interactive: true });
  if (!finalUrl || !finalUrl.startsWith(redirect + "#")) throw new Error("A Twitch não concluiu o redirecionamento configurado.");
  const params = new URLSearchParams(new URL(finalUrl).hash.slice(1));
  if (params.get("state") !== state) throw new Error("Estado OAuth inválido: conexão cancelada por segurança.");
  if (params.get("error")) throw new Error(`Autorização recusada: ${params.get("error_description") || params.get("error")}`);
  const token = params.get("access_token");
  if (!token) throw new Error("Nenhum token retornado pela Twitch.");
  const verified = await validateTwitch(token);
  if (verified.client_id !== clientId) throw new Error("O Client ID não corresponde à autorização recebida.");
  await chrome.storage.session.set({ twitchAuth: {
    token, clientId, senderId: String(verified.user_id), login: String(verified.login || ""), validatedAt: Date.now(),
  } });
  return { connected: true, login: verified.login || "conta Twitch", redirect };
}

async function twitchAuthStatus() {
  const session = await getAuth();
  const { twitchClientId } = await chrome.storage.local.get("twitchClientId");
  const connected = !!(session && session.clientId === String(twitchClientId || "").trim().toLowerCase());
  return { connected, login: connected ? session.login : "", redirect: authRedirect() };
}

// Não tenta novamente quando o resultado de um POST é desconhecido: evita duplicar $jogar.
// Reserva compartilhada entre chat e API. A fila de mensagens no worker evita corridas.
async function reserveJogar(login) {
  const name = String(login || "").toLowerCase();
  if (!/^[a-z0-9_]{2,25}$/.test(name)) return false;
  const data = await chrome.storage.local.get("lastJogar");
  const map = data.lastJogar || {};
  if (Date.now() - (Number(map[name]) || 0) < TWITCH_COOLDOWN_MS) return false;
  await chrome.storage.local.set({ lastJogar: { ...map, [name]: Date.now() } });
  return true;
}

async function sendJogarApi(login) {
  const name = String(login || "").toLowerCase();
  if (!/^[a-z0-9_]{2,25}$/.test(name)) return { code: "error", reason: "Nome de canal inválido." };
  const config = await chrome.storage.local.get(["twitchClientId", "lastJogar"]);
  const sentAt = Number((config.lastJogar || {})[name]) || 0;
  if (Date.now() - sentAt < TWITCH_COOLDOWN_MS) return { code: "cooldown" };
  let auth = await getAuth();
  if (!auth || auth.clientId !== String(config.twitchClientId || "").trim().toLowerCase()) {
    return { code: "auth", reason: "Conecte sua conta Twitch em Configurações → Lives → Envio pela API." };
  }
  try {
    if (Date.now() - auth.validatedAt >= AUTH_VALIDATE_MS) {
      const info = await validateTwitch(auth.token);
      if (info.client_id !== auth.clientId || String(info.user_id) !== auth.senderId) throw new Error("A autenticação mudou. Reconecte a Twitch.");
      auth = { ...auth, validatedAt: Date.now() };
      await chrome.storage.session.set({ twitchAuth: auth });
    }
    const headers = { "Authorization": `Bearer ${auth.token}`, "Client-Id": auth.clientId };
    // Busca o broadcaster_id usando o login público do canal.
    const users = await twitchFetch(`https://api.twitch.tv/helix/users?login=${encodeURIComponent(name)}`, { headers });
    if (users.status === 401) {
      await chrome.storage.session.remove("twitchAuth");
      return { code: "auth", reason: "Sessão Twitch expirada. Conecte novamente nas Configurações." };
    }
    if (!users.ok) return { code: "error", reason: `A Twitch não identificou o canal (HTTP ${users.status}).` };
    const account = (await users.json()).data?.[0];
    if (!account?.id) return { code: "error", reason: `Canal ${name} não encontrado na Twitch.` };

    // Se a automação foi desligada ou a live mudou durante a consulta, não envie.
    const beforeSend = await getState();
    if (!beforeSend.enabled || beforeSend.phase !== "joining" || beforeSend.current !== name ||
        beforeSend.sendMethod !== "api" || !canUseLive(beforeSend, name)) {
      return { code: "error", reason: "Consulta cancelada: a automação mudou antes do envio." };
    }
    // Reserva a tentativa ANTES da requisição: um timeout jamais causa reenvio.
    if (!await reserveJogar(name)) return { code: "cooldown" };
    // Daqui em diante não repetimos automaticamente em falhas de rede ou timeout.
    let response;
    try {
      response = await twitchFetch("https://api.twitch.tv/helix/chat/messages", {
        method: "POST", headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ broadcaster_id: String(account.id), sender_id: auth.senderId, message: "$jogar" }),
      });
    } catch (e) {
      return { code: "uncertain", reason: "O envio pela API não teve confirmação (rede ou timeout). Não vou reenviar para evitar duplicação." };
    }
    if (response.status === 401) {
      await chrome.storage.session.remove("twitchAuth");
      return { code: "auth", reason: "Autorização Twitch expirada. Reconecte sua conta." };
    }
    if (response.status === 403) return { code: "blocked", reason: "A Twitch não permitiu enviar neste chat (verifique follow, tempo como seguidor ou outras restrições)." };
    if (response.status === 429) return { code: "blocked", reason: "Limite de mensagens da Twitch atingido. Aguarde antes de tentar novamente." };
    if (!response.ok) return { code: "error", reason: `Twitch respondeu HTTP ${response.status}; envio não confirmado.` };
    let data;
    try { data = await response.json(); } catch (e) { return { code: "uncertain", reason: "Resposta Twitch ilegível; envio não será repetido." }; }
    const item = data?.data?.[0];
    if (!item || item.is_sent !== true) {
      return { code: "blocked", reason: `Twitch não enviou $jogar: ${String(item?.drop_reason?.message || item?.drop_reason?.code || "restrição do chat")}`.slice(0, 220) };
    }
    return { code: "sent" };
  } catch (e) {
    if (/expirada|inválid|autenticaç/i.test(String(e?.message || ""))) {
      await chrome.storage.session.remove("twitchAuth");
      return { code: "auth", reason: String(e.message) };
    }
    return { code: "error", reason: `Falha ao consultar Twitch: ${String(e?.message || e)}`.slice(0, 190) };
  }
}

async function visitViaApi(login) {
  const result = await sendJogarApi(login);
  if (result.code === "sent" || result.code === "cooldown") {
    return finishJoin({ login, jogar: result.code === "sent" ? "sent" : "cooldown", viaApi: true });
  }
  const st = await getState();
  if (!st.enabled || st.phase !== "joining" || st.current !== login) return;
  const wait = Math.max(120000, Number(st.scanGapSec || 120) * 1000);
  await set({ phase: "idle", nextScanAt: Date.now() + wait,
    status: `API Twitch em ${login}: ${result.reason || "Não foi possível enviar."} Modo chat continua disponível nas Configurações.`,
  });
}


const score = (z, w) => z * 100 + (w || 0);
// Busca de ranking sem depender exclusivamente do filtro "search": algumas
// versões do backend ignoram o filtro ou devolvem total apenas dos resultados
// filtrados. As páginas NÃO filtradas determinam o ranking geral por FC.
const rankKey = (v) => String(v || "").normalize("NFKD")
  .replace(/[\u0300-\u036f]/g, "").trim().replace(/^@/, "").toLowerCase();
const rankPower = (v) => {
  if (typeof v === "number") return Number.isFinite(v) && v > 0 ? v : null;
  const str = String(v ?? "").trim().replace(/\s/g, "");
  if (!str || !/^[\d.,]+$/.test(str)) return null;
  // FC no site pode ser exibido como 1.234.567 ou 1,234,567.
  const normalized = /^(?:\d{1,3}[.,]){1,}\d{3}$/.test(str)
    ? str.replace(/[.,]/g, "") : str.replace(",", ".");
  const value = Number(normalized);
  return Number.isFinite(value) && value > 0 ? value : null;
};
const rankPosition = (v) => {
  if (typeof v === "string") v = v.trim().replace(/^#/, "").replace(/[.,\s]/g, "");
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};
const RANK_PAGE_SIZE = 20;
let rankLookupBusy = false;
async function rankPage(page, search = "") {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 7500);
  try {
    const q = new URLSearchParams({page:String(page),size:String(RANK_PAGE_SIZE),sort:"power"});
    if (search) q.set("search", search);
    const response = await fetch(`${RANKING_CHARACTERS_API}?${q}`, {
      signal:ctl.signal,credentials:"omit",cache:"no-store"
    });
    if (!response.ok) throw new Error(`Ranking de personagens HTTP ${response.status}`);
    const data = await response.json();
    if (!Array.isArray(data?.items)) throw new Error("Resposta de ranking inesperada");
    return data;
  } finally { clearTimeout(timer); }
}
function characterRankFrom(items, name, unfilteredPage = 0) {
  for (const [i, row] of (Array.isArray(items) ? items : []).entries()) {
    const nodes = [row, row?.character, row?.player, row?.user].filter(x => x && typeof x === "object");
    const aliases = nodes.flatMap(x => [x.login, x.name, x.username, x.userName,
      x.displayName, x.display_name, x.playerName, x.characterName,
      x.twitchLogin, x.twitchName, x.twitch_login, x.nick, x.nickname]);
    if (!aliases.some(x => rankKey(x) === name)) continue;
    // Filtro de busca pode mudar os índices. Somente páginas sem filtro podem
    // usar (número da página × tamanho) como posição global, se rank ausente.
    for (const x of nodes) for (const key of ["rank", "ranking", "position", "place", "globalRank", "rankPosition"]) {
      const rank = rankPosition(x[key]);
      if (rank) return rank;
    }
    return unfilteredPage ? (unfilteredPage - 1) * RANK_PAGE_SIZE + i + 1 : null;
  }
  return null;
}
const rankingRowPower = (row) => rankPower(row?.power ?? row?.fc ?? row?.combatPower ??
  row?.totalPower ?? row?.stats?.power ?? row?.character?.power ?? row?.character?.fc);
async function findCharacterRank(name, power) {
  // Pesquisa filtrada é mais rápida quando o backend a suporta e informa rank.
  // Se o backend não oferecer esse filtro, o caminho abaixo ainda funciona.
  try {
    const filtered = await rankPage(1, name);
    const found = characterRankFrom(filtered.items, name);
    if (found) return found;
  } catch (e) {
    console.info("[JARVIS rank] Busca filtrada não disponível; usando ranking geral:", String(e?.message || e));
  }
  // O total deve ser SEMPRE o total global, nunca o total de uma busca filtrada.
  const first = await rankPage(1);
  let found = characterRankFrom(first.items, name, 1);
  if (found) return found;
  if (!power) return null;
  const total = Number(first.total ?? first.totalItems ?? first.totalCount ??
    first.pagination?.total ?? first.pagination?.totalItems ?? first.meta?.total);
  if (!Number.isFinite(total) || total < 1) return null;
  const pages = Math.min(100000, Math.ceil(total / RANK_PAGE_SIZE));
  let low = 2, high = pages, tries = 0;
  while (low <= high && tries++ < 16) {
    const middle = Math.floor((low + high) / 2);
    const data = await rankPage(middle);
    const rows = data.items;
    if (!rows.length) break;
    found = characterRankFrom(rows, name, middle);
    if (found) return found;
    const top = rankingRowPower(rows[0]);
    const bottom = rankingRowPower(rows[rows.length - 1]);
    if (top === null || bottom === null || top < bottom) break;
    if (power > top) high = middle - 1;
    else if (power < bottom) low = middle + 1;
    else {
      // Empates de FC ou atualização do ranking podem deslocar o jogador.
      // Confirma páginas vizinhas, sem atribuir uma posição por aproximação.
      for (let distance = 1; distance <= 3; distance++) {
        for (const p of [middle - distance, middle + distance]) {
          if (p < 1 || p > pages) continue;
          found = characterRankFrom((await rankPage(p)).items, name, p);
          if (found) return found;
        }
      }
      break;
    }
  }
  return null;
}
async function refreshCharacterRank(name, fc) {
  const normalized = rankKey(name);
  if (!/^[a-z0-9_]{2,25}$/.test(normalized) || rankLookupBusy) return;
  const now = Date.now();
  const old = await chrome.storage.local.get(["charRanking", "nextRankCheckAt"]);
  if (old.charRanking?.name === normalized && now < (Number(old.nextRankCheckAt) || 0)) return;
  rankLookupBusy = true;
  // Bloqueia solicitações paralelas enquanto a consulta é executada.
  await set({nextRankCheckAt: now + 90_000});
  try {
    const result = await findCharacterRank(normalized, rankPower(fc));
    const latest = await chrome.storage.local.get("char");
    if (rankKey(latest.char?.stats?.name) !== normalized) return;
    if (result) {
      await set({charRanking:{name:normalized,rank:result,at:Date.now(),source:"api"},
        nextRankCheckAt:Date.now() + RANK_CHECK_MS});
    } else {
      // Falha transitória da busca não apaga a última posição confirmada.
      // Mantém a data original; o popup para de mostrá-la quando ficar velha.
      const previous = old.charRanking?.name === normalized && rankPosition(old.charRanking.rank)
        ? old.charRanking : null;
      await set({charRanking:{name:normalized,rank:previous?.rank || null,
        at:previous?.at || Date.now(),source:"api",error:"Personagem não localizado no ranking público."},
        nextRankCheckAt:Date.now() + 120_000});
    }
  } catch (e) {
    console.warn("[JARVIS rank]", String(e?.message || e));
    const previous = old.charRanking?.name === normalized ? old.charRanking : null;
    await set({charRanking:{name:normalized,rank:previous?.rank || null,
      at:previous?.at || Date.now(),source:"api",error:String(e?.message || e).slice(0,180)},
      nextRankCheckAt:Date.now() + 90_000});
  } finally { rankLookupBusy = false; }
}
const getState = async () => ({ ...DEFAULTS, ...(await chrome.storage.local.get(null)) });
const set = (o) => chrome.storage.local.set(o);
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (ms) => (ms >= 60000 ? Math.round(ms / 60000) + " min" : Math.round(ms / 1000) + " s");

// Tudo que mexe no estado roda em fila, uma coisa por vez.
let chain = Promise.resolve();
function serial(fn) {
  const p = chain.then(fn);
  chain = p.catch((e) => console.error("[RSHopper]", e));
  return p;
}

// Nunca carrega uma live antes de aplicar o mute nativo da aba. Assim
// evitamos o instante de áudio que ocorria com create({url: twitch}).
async function openLive(login) {
  if (!validLogin(login)) throw new Error("Canal Twitch inválido.");
  const settings = await chrome.storage.local.get(["tabId", "muteLives"]);
  const mustMute = settings.muteLives !== false;
  const url = `https://www.twitch.tv/${login}`;
  let tab = null;
  if (settings.tabId) {
    try {
      const candidate = await chrome.tabs.get(settings.tabId);
      // Só reutiliza a aba se ela ainda for a aba Twitch gerenciada pela Jarvis.
      if (/^https:\/\/www\.twitch\.tv\/[a-z0-9_]+(?:[/?#]|$)/i.test(candidate.url || "")) tab = candidate;
    } catch (_) { /* aba já foi fechada */ }
  }
  let created = false;
  try {
    if (!tab) {
      // Uma aba vazia NÃO reproduz som. Silencia antes de navegar à Twitch.
      tab = await chrome.tabs.create({ url: "about:blank", active: false });
      created = true;
    }
    await chrome.tabs.update(tab.id, { muted: mustMute });
    const muted = await chrome.tabs.get(tab.id);
    if (mustMute && muted.mutedInfo?.muted !== true) throw new Error("Não consegui silenciar a aba da Twitch.");
    // A navegação só começa depois de confirmar o estado de mute.
    await chrome.tabs.update(tab.id, { url, active: true });
    await set({ tabId: tab.id });
  } catch (e) {
    if (created && tab?.id) { try { await chrome.tabs.remove(tab.id); } catch (_) {} }
    await set({ status: `Não abri ${login}: ${String(e?.message || e)}. Nenhuma entrada enviada.` });
    throw e;
  }
}

// Proteção de abas: IDs guardados no storage podem ficar desatualizados depois
// que o Chrome reinicia, a aba é fechada/reaproveitada ou o usuário navega.
// NUNCA recarregue uma aba com base apenas no ID: confira o endereço real.
function isRiftUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === "https:" &&
      (u.hostname === "riftstream.com.br" || u.hostname === "www.riftstream.com.br");
  } catch (_) { return false; }
}
function isCharacterUrl(url) {
  if (!isRiftUrl(url)) return false;
  try { return /^\/character(?:\/|$)/.test(new URL(url).pathname); }
  catch (_) { return false; }
}
async function getManagedRiftTab(tabId) {
  if (!Number.isInteger(tabId) || tabId <= 0) return null;
  try {
    const tab = await chrome.tabs.get(tabId);
    // pendingUrl também conta: não toque na aba se estiver saindo do Rift.
    if (tab.pendingUrl && !isRiftUrl(tab.pendingUrl)) return null;
    if (isRiftUrl(tab.url)) return tab;
    // Uma aba recém-criada pode estar navegando de about:blank para o Rift.
    if ((!tab.url || tab.url === "about:blank") && isRiftUrl(tab.pendingUrl)) return tab;
  } catch (_) { /* aba fechada ou inacessível */ }
  return null;
}
async function reloadManagedCharacterTab(tabId, now) {
  const tab = await getManagedRiftTab(tabId);
  // Mesmo dentro do Rift, só o endereço /character pode ser recarregado.
  // /login ou qualquer outra página não será interrompida.
  if (!tab || !isCharacterUrl(tab.url) ||
      (tab.pendingUrl && !isCharacterUrl(tab.pendingUrl))) return false;
  // Reserva a próxima atualização antes da recarga para evitar repetições.
  await set({ lastCharReload: now });
  await chrome.tabs.reload(tab.id);
  return true;
}

// Uma única aba de Rift por monitoramento. Primeiro procura as que já existem
// (inclusive abertas manualmente ou por versões antigas), evitando duplicatas
// quando a referência guardada no storage expira ou muda depois de reiniciar.
// Não fecha nenhuma aba do usuário e não interfere com sites que não são Rift.
async function ensureCharTab(st, now) {
  let assigned = await getManagedRiftTab(st.charTabId);
  if (assigned && isCharacterUrl(assigned.url)) return assigned;
  // Chrome.tabs.query encontra abas existentes de Rift nos diferentes domínios.
  let candidates = [];
  try {
    const tabs = await chrome.tabs.query({url: [
      "https://riftstream.com.br/*", "https://www.riftstream.com.br/*"
    ]});
    candidates = tabs.filter(tab => isRiftUrl(tab.url) &&
      (!tab.pendingUrl || isRiftUrl(tab.pendingUrl)));
  } catch (e) {
    console.warn("[JARVIS] Não consegui consultar abas do Rift:", e);
    if (assigned) return assigned; // falha transitória: NÃO cria duplicata
    return null;
  }
  // Se existir uma /character, é essa que o monitor de personagem usa.
  // Caso contrário, acompanha a aba Rift existente sem tomar controle de
  // Forja/Inventário; ela poderá ser aberta em /character pelo usuário.
  const chosen = candidates.find(tab => isCharacterUrl(tab.url)) ||
    assigned || candidates[0] || null;
  if (chosen) {
    if (chosen.id !== st.charTabId) await set({charTabId:chosen.id,lastCharReload:now});
    return chosen;
  }
  // Outra chamada de doTick não cria uma nova aba enquanto esta criação está
  // em andamento porque todas as chamadas passam pela fila serial.
  const created = await chrome.tabs.create({url:CHAR_URL,active:false});
  await set({charTabId:created.id,lastCharReload:now});
  return created;
}

async function pollCharacter() {
  const st = await chrome.storage.local.get(["enabled", "charTabId", "lastCharReload", "siteError"]);
  if (!st.enabled || !st.charTabId) return;
  const now = Date.now();
  const interval = st.siteError ? CHAR_RELOAD_ERR_MS : CHAR_RELOAD_MS;
  if (now - (Number(st.lastCharReload) || 0) < interval) return;
  try {
    await reloadManagedCharacterTab(st.charTabId, now);
  } catch (e) {
    console.warn("[JARVIS] Falha ao atualizar somente a página do personagem:", e);
  }
}

async function restorePrev(st) {
  if (st.prevTabId) { try { await chrome.tabs.update(st.prevTabId, { active: true }); } catch (e) { /* ignora */ } }
}

async function visit(login) {
  const st = await getState();
  if (!st.enabled || st.phase !== "joining" || !st.lives.includes(login) || !canUseLive(st, login)) {
    await set({ phase: "idle", status: `Entrada cancelada: ${login} não está autorizado nas preferências atuais.` });
    return;
  }
  // Só estende o limite se o usuário ativou follow automático: pode haver demora
  // para autenticar o botão e aguardar a janela de envio do chat.
  const delayMs = Math.max(0, Math.min(180, Number(st.followWaitSec) || 0)) * 1000;
  const visitMs = st.autoFollow && st.autoJogar ? Math.max(VISIT_TIMEOUT, delayMs + 150000) : VISIT_TIMEOUT;
  await set({ current: login, visitDeadline: Date.now() + visitMs });
  if (st.autoJogar && st.sendMethod === "api") return visitViaApi(login);
  try { await openLive(login); }
  catch (e) {
    await set({ phase: "idle", current: null, visitDeadline: 0, nextScanAt: Date.now() + Math.max(30000, st.scanGapSec * 1000) });
  }
}

// Campos públicos opcionais: a contagem já vem de playersNow. Não estimamos FC
// pelos espectadores da Twitch, pela zona ou pelo recorde da live.
const nonNegativeNumber = (v) => {
  if (typeof v === "number") return Number.isFinite(v) && v >= 0 ? v : null;
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!/^(?:\d+|\d{1,3}(?:[.,]\d{3})+)$/.test(s)) return null;
  const n = Number(s.replace(/[.,]/g, ""));
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
};
function channelFcTotal(data, playersNow) {
  // Aceita SOMENTE totais explícitos de FC/power presentes na resposta do canal.
  // O backend pode mudar nomes: na ausência do campo, a interface mostra "—".
  const fields = ["totalFc", "totalFC", "fcTotal", "sumFc", "fcSum", "totalPower",
    "powerTotal", "powerSum", "sumPower", "playersPowerNow", "playersFcNow", "totalCombatPower"];
  for (const obj of [data, data?.stats, data?.totals, data?.summary]) {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) continue;
    for (const key of fields) {
      const n = nonNegativeNumber(obj[key]);
      if (n !== null) return n;
    }
  }
  // Lista integral de jogadores presentes: soma FC somente se for COMPLETA.
  // Não soma Top N nem uma lista parcial: isso mentiria sobre o total.
  const list = Array.isArray(data?.players) ? data.players :
    Array.isArray(data?.activePlayers) ? data.activePlayers : null;
  if (list && playersNow !== null && list.length === playersNow) {
    const powers = list.map(x => nonNegativeNumber(x?.fc ?? x?.power ?? x?.combatPower));
    if (powers.every(x => x !== null)) return powers.reduce((total, n) => total + n, 0);
  }
  return null;
}

// Preserva a última leitura completa do board em scans normais de zona (que usam
// outra rota), mas não mantém FC de uma live offline nem números antigos para sempre.
function mergeChannelResult(previous, incoming) {
  if (!incoming?.zone || !previous) return incoming;
  const meta = {};
  for (const key of ["fcCheckedAt", "fcSource", "fcRetryAt", "fcError", "boardPlayers"]) {
    if (Object.prototype.hasOwnProperty.call(previous, key)) meta[key] = previous[key];
  }
  const result = { ...incoming, ...meta };
  if (previous.fcSource === "boardNow" &&
      Number.isSafeInteger(previous.fcTotal) && Number.isSafeInteger(previous.boardPlayers) &&
      Date.now() - (Number(previous.fcCheckedAt) || 0) < FC_BOARD_FRESH_MS) {
    result.fcTotal = previous.fcTotal;
    result.players = previous.boardPlayers; // count do mesmo board que forneceu o FC
  }
  return result;
}
function mergeChannelResults(existing, updates) {
  const all = { ...(existing || {}) };
  for (const [login, data] of Object.entries(updates || {})) {
    all[login] = mergeChannelResult(all[login], data);
  }
  return all;
}

function fcBoardError(message, status = null, retryAfterMs = 0) {
  const e = new Error(message);
  e.status = status;
  e.retryAfterMs = retryAfterMs;
  return e;
}
async function fetchFcBoardPage(login, page, requestedSize = FC_BOARD_PAGE_SIZE) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT);
  const url = `${API}/${encodeURIComponent(login)}/board?board=now&page=${page}&size=${requestedSize}`;
  try {
    const response = await fetch(url, { signal: ctl.signal, credentials: "omit", cache: "no-store" });
    if (!response.ok) {
      const retry = response.headers.get("Retry-After");
      const seconds = retry && /^\d+(?:\.\d+)?$/.test(retry) ? Number(retry) : null;
      const timestamp = retry ? Date.parse(retry) : NaN;
      const retryAfterMs = seconds !== null ? Math.max(0, seconds * 1000) :
        Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : 0;
      throw fcBoardError(`Ranking Jogando agora: HTTP ${response.status}`, response.status, retryAfterMs);
    }
    const data = await response.json();
    const total = nonNegativeNumber(data?.total);
    const actualPage = nonNegativeNumber(data?.page);
    if (!data || !Array.isArray(data.items) || !Number.isSafeInteger(total) ||
        !Number.isSafeInteger(actualPage) || actualPage !== page || data.items.length > requestedSize) {
      throw fcBoardError(`Resposta inesperada no ranking (página ${page})`);
    }
    return { ...data, total, page: actualPage };
  } catch (e) {
    if (e?.name === "AbortError") throw fcBoardError(`Tempo esgotado consultando FC (página ${page})`);
    throw e;
  } finally { clearTimeout(timer); }
}

function playerIdentity(player) {
  // IDs de personagem diferenciam contas que possam ter apelidos iguais.
  for (const k of ["characterId", "playerId", "userId", "id", "login", "name", "username"]) {
    const v = player?.[k];
    if (v !== undefined && v !== null && String(v).trim()) return `${k}:${String(v).trim().toLowerCase()}`;
  }
  return null;
}

async function fetchFcBoardSnapshot(login, size) {
  let total = null;
  let seenRows = 0;
  let fcTotal = 0;
  let players = 0;
  const seen = new Set();
  for (let page = 1; page <= FC_BOARD_MAX_PAGES; page++) {
    const data = await fetchFcBoardPage(login, page, size);
    if (total === null) {
      total = data.total;
      if (Math.ceil(total / size) > FC_BOARD_MAX_PAGES)
        throw fcBoardError("Ranking maior que o limite de páginas suportado");
    }
    if (data.total !== total)
      throw fcBoardError(`Ranking mudou de ${total} para ${data.total} jogadores durante a leitura`);
    for (const player of data.items) {
      if (!player || typeof player !== "object")
        throw fcBoardError(`Jogador inválido na página ${page}`);
      const id = playerIdentity(player);
      if (!id || seen.has(id))
        throw fcBoardError(`Ranking mudou ou repetiu jogador na página ${page}`);
      seen.add(id);
      if (player.now === false) continue;
      const power = nonNegativeNumber(player.power ?? player.fc ?? player.combatPower ?? player.stats?.power);
      if (power === null || !Number.isSafeInteger(power))
        throw fcBoardError(`Jogador sem FC válido no ranking (página ${page})`);
      fcTotal += power;
      if (!Number.isSafeInteger(fcTotal)) throw fcBoardError("FC total fora do intervalo seguro");
      players++;
    }
    seenRows += data.items.length;
    if (seenRows === total) return { fcTotal, players, checkedAt: Date.now() };
    if (seenRows > total || data.items.length === 0 || data.items.length < size)
      throw fcBoardError(`Página ${page} incompleta: ${seenRows}/${total} registros`);
    await sleepMs(120);
  }
  throw fcBoardError("Limite de páginas do ranking atingido");
}

async function fetchFcBoard(login) {
  if (!validLogin(login)) throw fcBoardError("Login inválido no ranking de FC");
  // Uma live com menos jogadores também pode mudar entre páginas. Tentamos
  // primeiro o formato conhecido (20), depois uma página maior (se suportada)
  // para obter um retrato mais estável, e finalmente repetimos 20.
  const sizes = fcLargePageSupported === false ? [20, 20, 20] : [20, 100, 20];
  let lastError;
  for (let attempt = 0; attempt < sizes.length; attempt++) {
    const size = sizes[attempt];
    try {
      const snapshot = await fetchFcBoardSnapshot(login, size);
      if (size > FC_BOARD_PAGE_SIZE) fcLargePageSupported = true;
      return snapshot;
    } catch (e) {
      lastError = e;
      const status = Number(e?.status) || 0;
      // Não insiste em autenticação, bloqueio/rate-limit ou canal inexistente.
      if ([401, 403, 404, 429, 503].includes(status)) throw e;
      // Algumas APIs aceitam 'size=100' mas devolvem só 20, outras retornam
      // HTTP 400/422. Nesses casos, próximas leituras usam 20 diretamente.
      if (size > FC_BOARD_PAGE_SIZE && (status === 400 || status === 413 || status === 422 ||
          /incompleta|resposta inesperada/i.test(String(e?.message || "")))) {
        fcLargePageSupported = false;
      }
      // FC inválido individual não se transforma em zero nem em soma parcial.
      if (/sem FC válido|fora do intervalo seguro/i.test(String(e?.message || ""))) break;
      if (attempt < sizes.length - 1) await sleepMs(300 + attempt * 300);
    }
  }
  throw lastError || fcBoardError("Não foi possível confirmar o FC total");
}

// FC não participa da decisão de entrar na live: o ranking roda em paralelo
// e nunca segura a consulta rápida das zonas. As gravações são serializadas
// com os scans para não sobrescrever resultados atualizados.
async function updateLiveFc(login) {
  if (fcInFlight.has(login)) return false;
  fcInFlight.add(login);
  try {
    const board = await fetchFcBoard(login);
    await serial(async () => {
      const latest = await getState();
      const current = latest.results?.[login];
      if (!latest.enabled || !current?.zone || !latest.lives.includes(login) || latest.disabled.includes(login)) return;
      await set({ results: { ...latest.results, [login]: {
        ...current, players: board.players, boardPlayers: board.players,
        fcTotal: board.fcTotal, fcCheckedAt: board.checkedAt, fcSource: "boardNow",
        fcRetryAt: 0, fcError: "",
      } } });
    });
    return true;
  } catch (e) {
    const status = Number(e?.status) || 0;
    const now = Date.now();
    const wait = status === 429 || status === 503
      ? Math.max(5 * 60000, Math.min(Number(e.retryAfterMs) || 0, 30 * 60000))
      : FC_BOARD_RETRY_MS;
    if (status === 429 || status === 503) fcPauseUntilLocal = now + wait;
    await serial(async () => {
      const latest = await getState();
      const current = latest.results?.[login];
      if (!current) return;
      await set({
        ...(status === 429 || status === 503 ? { fcPausedUntil: fcPauseUntilLocal } : {}),
        results: { ...latest.results, [login]: {
          ...current, fcRetryAt: now + wait, fcError: String(e?.message || e).slice(0, 170),
        } },
      });
    });
    console.warn(`[JARVIS FC] ${login}: ${String(e?.message || e)}`);
    return false;
  } finally { fcInFlight.delete(login); }
}

async function refreshFcBoards() {
  if (fcRefreshBusy) return;
  fcRefreshBusy = true;
  try {
    const st = await getState();
    const now = Date.now();
    if (!st.enabled || now < Math.max(Number(st.fcPausedUntil) || 0, fcPauseUntilLocal)) return;
    const targets = (st.lives || []).filter(login => {
      const r = st.results?.[login];
      return validLogin(login) && !st.disabled.includes(login) && r?.zone && !fcInFlight.has(login) &&
        now - (Number(r.fcCheckedAt) || 0) >= FC_BOARD_REFRESH_MS &&
        now >= (Number(r.fcRetryAt) || 0);
    });
    if (!targets.length) return;
    let index = 0;
    const worker = async () => {
      while (index < targets.length && Date.now() >= fcPauseUntilLocal) {
        await updateLiveFc(targets[index++]);
        await sleepMs(220);
      }
    };
    await Promise.all(Array.from({length:Math.min(FC_BOARD_WORKERS,targets.length)}, () => worker()));
  } finally { fcRefreshBusy = false; }
}

// O campo FC — no card pode solicitar uma nova leitura sem reiniciar as buscas
// de zona. Evita consultas repetidas por clique e respeita 429/503.
async function refreshLiveFcManual(login) {
  const st = await getState();
  const r = st.results?.[login];
  const now = Date.now();
  if (!st.enabled || !validLogin(login) || !st.lives.includes(login) || st.disabled.includes(login) || !r?.zone)
    return {ok:false,error:"Live sem run ativa ou Jarvis desligada."};
  const pausedUntil = Math.max(Number(st.fcPausedUntil)||0,fcPauseUntilLocal);
  if (now < pausedUntil) return {ok:false,error:"A API limitou as consultas. Tente novamente após a pausa."};
  if (fcInFlight.has(login)) return {ok:true,pending:true};
  if (now < (Number(r.fcManualAt)||0) + 45_000)
    return {ok:false,error:"Espere 45 segundos entre as atualizações manuais."};
  await serial(async () => {
    const latest=await getState();
    const current=latest.results?.[login];
    if (!current) return;
    await set({results:{...latest.results,[login]:{
      ...current,fcManualAt:Date.now(),fcError:"Atualizando FC solicitado manualmente..."
    }}});
  });
  const ok=await updateLiveFc(login);
  return ok ? {ok:true} : {ok:false,error:"Consulta incompleta; passe o mouse no FC para ver o motivo."};
}

function scheduleFcRefresh() {
  // Nunca aguardado de dentro de serial(): a atualização pontual usa a fila
  // serial() para escrever dados e não deve causar deadlock.
  refreshFcBoards().catch(e => console.warn("[JARVIS FC] Falha inesperada", e));
}

// Consulta a API pública do canal (zona/onda ATUAIS, e se a live está no ar).
// serverError = problema do lado deles (5xx, 429, timeout, rede): serve para ativar o backoff.
async function fetchChannel(login, maxAge = 0) {
  const hit = chanCache.get(login);
  if (maxAge && hit && Date.now() - hit.at < maxAge) return hit.r;
  const r = await fetchChannelRaw(login);
  if (!r.serverError) chanCache.set(login, { r, at: Date.now() });
  return r;
}
async function fetchChannelRaw(login) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT);
  try {
    const r = await fetch(`${API}/${encodeURIComponent(login)}`, { signal: ctl.signal, credentials: "omit", cache: "no-store" });
    if (!r.ok) return { bad: `erro ${r.status}`, serverError: r.status >= 500 || r.status === 429 };
    const j = await r.json();
    const checkedAt = Date.now();
    if (!j.live) return { bad: "offline", checkedAt };
    if (!j.zone) return { bad: "sem run", checkedAt };
    const players = nonNegativeNumber(j.playersNow);
    return { zone: j.zone, wave: j.wave, players, fcTotal: channelFcTotal(j, players), checkedAt };
  } catch (e) {
    return { bad: e && e.name === "AbortError" ? "timeout" : "erro de rede", serverError: true };
  } finally {
    clearTimeout(timer);
  }
}

// Mesma normalização do popup, para que a descoberta preserve canais adicionados à mão.
function parseLiveNames(text) {
  const out = [];
  for (let s of String(text || "").split(/[\s,;]+/)) {
    s = s.trim().replace(/^https?:\/\//i, "").replace(/^(www\.)?twitch\.tv\//i, "").split(/[/?#]/)[0].replace(/^@/, "").toLowerCase();
    if (/^[a-z0-9_]{2,25}$/.test(s) && !out.includes(s)) out.push(s);
  }
  return out;
}

// Consulta o ranking diretamente pela API que alimenta o site. Não abre abas.
// online=true -> só canais no ar; o endpoint já vem ordenado pelo ranking
// de recorde de jogadores simultâneos (peakPlayers / rank).
// 429 = respeitar a pausa do servidor; 5xx/timeout = no máximo uma nova tentativa.
async function fetchRankingPage(page) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT);
    try {
      const url = `${RANKING_CROWDS_API}?page=${page}&size=${RANKING_PAGE_SIZE}&online=true`;
      const response = await fetch(url, { signal: ctl.signal, credentials: "omit", cache: "no-store" });
      if (!response.ok) {
        const e = new Error(`A API do ranking respondeu HTTP ${response.status}.`);
        e.status = response.status;
        if (response.status === 429 || response.status === 503) {
          const value = response.headers.get("Retry-After");
          const seconds = Number(value);
          const date = Date.parse(value || "");
          e.retryAfterMs = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 :
            Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0;
        }
        throw e;
      }
      const data = await response.json();
      if (!data || !Array.isArray(data.items)) throw new Error("Formato inesperado da resposta do ranking.");
      return data;
    } catch (err) {
      const e = err && err.name === "AbortError" ? new Error("Tempo esgotado ao consultar o ranking.") : err;
      // Não repetir 429, erros 4xx ou formatos inesperados.
      if (attempt || (e.status && e.status < 500) || e.retryAfterMs > 0 || /Formato inesperado/.test(e.message)) throw e;
    } finally {
      clearTimeout(timer);
    }
    await sleepMs(1500);
  }
}
async function readLivesRanking(top) {
  const names = [];
  const seen = new Set();
  for (let page = 1; page <= 10 && names.length < top; page++) {
    const data = await fetchRankingPage(page);
    for (const row of data.items) {
      if (!row || row.online !== true) continue;
      // A extensão abre apenas canais Twitch; nomes prefixados com outras plataformas são ignorados.
      const login = String(row.login || "").trim().toLowerCase();
      if (!/^[a-z0-9_]{2,25}$/.test(login) || seen.has(login)) continue;
      seen.add(login);
      names.push(login);
      if (names.length >= top) break;
    }
    const total = Number(data.total);
    if (data.items.length < RANKING_PAGE_SIZE ||
        (Number.isFinite(total) && page * RANKING_PAGE_SIZE >= total)) break;
    if (names.length < top) await sleepMs(250);
  }
  return names;
}

function discoverRetryMs(streak, retryAfterMs = 0) {
  const backoff = Math.min(MAX_DISCOVER_BACKOFF_MS, 2 * 60000 * 2 ** Math.min(streak - 1, 10));
  return Math.max(backoff, Math.min(Math.max(0, retryAfterMs || 0), 60 * 60000));
}

// Consulta simultânea moderada (4 por vez) com cache e apenas um retry em falhas
// transitórias. Evita esperar 20 x (latência + 800 ms), sem disparar rajadas ilimitadas.
async function checkLiveBatch(logins, checked = null) {
  const replies = Object.create(null);
  let cursor = 0, answered = 0, failures = 0, stop = false;
  const worker = async (workerIndex) => {
    if (workerIndex) await sleepMs(workerIndex * 120);
    while (!stop && cursor < logins.length) {
      const login = logins[cursor++];
      const known = checked && Object.prototype.hasOwnProperty.call(checked, login);
      let r = known ? checked[login] : await fetchChannel(login, CACHE_MS);
      if (!known && r.serverError && !/429/.test(r.bad || "")) {
        await sleepMs(650);
        r = await fetchChannel(login);
      }
      replies[login] = r;
      if (r.serverError) failures++; else answered++;
      if (!answered && failures >= 4) stop = true; // API indisponível: respeita backoff
    }
  };
  await Promise.all(Array.from({length:Math.min(CHECK_WORKERS,logins.length)},(_,i)=>worker(i)));
  return {replies,answered,failures};
}

async function discoverLives(manual = false) {
  const old = await getState();
  if ((old.discoverBusy && Date.now() - (old.discoverStartedAt || 0) < 5 * 60000) || old.phase === "joining") return;
  if (!manual && (!old.enabled || !old.discoverEnabled)) return;
  // Mesmo a descoberta manual não deve disparar vários pedidos ao mesmo tempo.
  if (manual && Date.now() - (old.lastDiscoverAttemptAt || 0) < MIN_DISCOVER_SPACING_MS) return;
  const started = Date.now();
  const top = discoverTop(old);
  await set({
    discoverBusy: true, discoverStartedAt: started, lastDiscoverAttemptAt: started,
    discoverStatus: "Consultando a API do ranking (sem abrir aba)...",
    nextDiscoverAt: started + discoverMs(old),
  });
  try {
    const names = await readLivesRanking(top);
    if (!names.length) throw new Error("Ranking sem canais Twitch online; lista anterior preservada.");
    await set({ discoverStatus: `Verificando as ${names.length} lives encontradas no ranking...` });
    const online = [];
    const {replies:checked, answered, failures} = await checkLiveBatch(names);
    const stale = new Set(old.discoveredLives || []);
    for (const login of names) {
      const r = checked[login];
      if (!r) continue;
      if (r.serverError) {
        // Usa o último resultado válido se o serviço retornar erro temporário.
        if (stale.has(login)) online.push(login);
      } else if (r.zone && r.wave != null) online.push(login);
    }
    if (!answered) throw new Error("A API de canais não respondeu; lista anterior preservada.");
    const latest = await getState();
    const manualNames = parseLiveNames(latest.livesText);
    const all = [...new Set([...manualNames, ...online, ...allowedList(latest)])];
    const streak = failures ? (Number(old.discoverFailStreak) || 0) + 1 : 0;
    const nextMs = failures ? discoverRetryMs(streak) : discoverMs(latest);
    await set({
      discoveredLives: online, lives: all, results: mergeChannelResults(latest.results, checked),
      discoverBusy: false, discoverStartedAt: 0,
      discoverFailStreak: streak, ...(failures ? {} : { lastDiscoverOkAt: Date.now() }),
      discoverStatus: failures
        ? `${online.length} lives disponíveis (${failures} consultas falharam; cache preservado). Nova tentativa em ${fmt(nextMs)}.`
        : `${online.length} de ${names.length} lives online com run ativa. Próxima leitura em ${fmt(nextMs)}.`,
      nextDiscoverAt: Date.now() + nextMs,
    });
    scheduleFcRefresh();
    // Só inicia busca se a automação já estiver habilitada, sem criar consultas duplicadas.
    if (latest.enabled && all.length && Date.now() >= (latest.nextScanAt || 0) &&
        Date.now() - (latest.lastScanStart || 0) >= MIN_SCAN_SPACING) {
      // Usa os dados recém-consultados: não espera uma segunda rodada do mesmo ranking.
      await startScan("ranking online", { auto: true, checked });
    }
  } catch (e) {
    const streak = (Number(old.discoverFailStreak) || 0) + 1;
    const wait = discoverRetryMs(streak, e && e.retryAfterMs);
    await set({
      discoverBusy: false, discoverStartedAt: 0, discoverFailStreak: streak,
      discoverStatus: `Ranking indisponível: ${String(e.message || e)} Cache mantido. Nova tentativa em ${fmt(wait)}.`,
      nextDiscoverAt: Date.now() + wait,
    });
  }
}

async function startScan(reason, opts = {}) {
  const st = await getState();
  if (!st.enabled || !st.lives.length || st.phase === "joining") return;
  // Em modo "Somente permitidas", NENHUM outro canal pode entrar na busca.
  const active = st.lives.filter((l) => canUseLive(st, l));
  if (!active.length) {
    await set({ phase: "idle", suggestedLive: null, nextScanAt: Date.now() + 60000,
      stalledScan: false, autoScan: false,
      status: modeOf(st) === "allowed"
        ? "Nenhuma live permitida e ativa. Marque 'Permitir' nos canais desejados."
        : "Todas as lives estão desativadas." });
    return;
  }
  const startedAt = Date.now();
  if (startedAt - st.lastScanStart < MIN_SCAN_SPACING) return;   // trava: nada de buscas em rajada
  // Tanto a consulta manual quanto a automática reiniciam o contador da próxima consulta.
  // Compartilham EXATAMENTE a mesma função de busca e as mesmas regras de escolha de live.
  const autoMs = Math.max(0, Number(st.autoScanMin) || 0) * 60000;
  await set({
    lastScanStart: startedAt,
    nextAutoScanAt: autoMs ? startedAt + autoMs : 0,
    stalledScan: !!opts.stalled, autoScan: !!opts.auto,
    status: `Consultando ${active.length} lives (${reason})...`,
  });

  // Consulta lives em paralelo, com limite seguro e uso da mesma leitura da descoberta.
  const {replies:results} = await checkLiveBatch(active, opts.checked || null);

  let prev = null;
  try {
    const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (t && t.id !== st.tabId && t.id !== st.charTabId) prev = t.id;
  } catch (e) { /* ignora */ }
  const latest = await getState();
  await set({ queue: [...active], results: mergeChannelResults(latest.results, results), prevTabId: prev || st.prevTabId || null });
  scheduleFcRefresh();
  await finishScan();
}

async function finishScan() {
  const st = await getState();
  const now = Date.now();
  const gapMs = st.scanGapSec * 1000;
  const retryMs = Math.max(30, Math.min(st.scanGapSec, 45)) * 1000;   // tenta de novo em 30-45 s
  const ranked = Object.entries(st.results)
    .filter(([login, r]) => r.zone && st.lives.includes(login) && canUseLive(st, login))
    .map(([login, r]) => ({ login, zone: r.zone, wave: r.wave, s: score(r.zone, r.wave) }))
    .sort((a, b) => b.s - a.s);
  // Zona parada (ou live desativada): não volta para a live em que você já está.
  const leave = st.char?.playingIn ? String(st.char.playingIn).toLowerCase() : null;
  const cands = ranked.filter((x) => x.login !== leave);
  const summary = st.queue.map((l) => {
    const r = st.results[l];
    return r && r.zone ? `${l} ${r.zone}-${r.wave}` : `${l} (${(r && r.bad) || "?"})`;
  }).join(" | ");
  const failed = st.queue.filter((l) => { const r = st.results[l]; return r && (r.serverError || r.skipped); }).length;
  const c = st.char;
  const mine = c && c.zone ? score(c.zone, c.wave) : 0;
  // Na comparação automática, a referência é a melhor entre a zona do boneco
  // e a zona atual da live em que ele já está. Isso evita trocas para uma live pior.
  const playing = c?.playingIn ? String(c.playingIn).toLowerCase() : "";
  const liveNow = ranked.find((x) => x.login === playing);
  // Mesmo na busca manual, não trocar para uma zona inferior à live atual.
  const baseline = liveNow ? Math.max(mine, liveNow.s) : mine;
  let above = cands.filter((x) => x.s > baseline);
  if (st.stalledScan && !above.length) above = cands;   // zona parada: aceita live de zona mais baixa

  // API instável: espera cada vez mais (2x, 4x, 8x o intervalo, até 15 min) em vez de martelar.
  if (!ranked.length && failed) {
    const streak = st.errStreak + 1;
    const wait = Math.min(gapMs * 2 ** streak, MAX_BACKOFF_MS);
    await set({
      phase: "idle", errStreak: streak, nextScanAt: now + wait, scanSummary: summary, stalledScan: false, autoScan: false,
      status: `API do RiftStream instável. Nova tentativa em ${fmt(wait)}.`,
    });
    return;
  }
  const ok = { errStreak: 0, stalledScan: false, autoScan: false };

  if (!ranked.length) {
    await set({ ...ok, phase: "idle", nextScanAt: now + retryMs, scanSummary: summary, suggestedLive: null, status: "Nenhuma live da lista está no ar com run ativa." });
    return;
  }
  if (!above.length) {
    await set({
      ...ok, phase: "idle", nextScanAt: now + retryMs, scanSummary: summary, suggestedLive: null,
      status: `Nenhuma ${leave ? "outra " : ""}live acima da sua zona (${c ? c.zone + "-" + c.wave : "?"}).${cands.length ? ` Melhor: ${cands[0].login} ${cands[0].zone}-${cands[0].wave}.` : ""}`,
    });
    return;
  }
  const mode = modeOf(st);
  // Evita regressos para um canal que acabou de receber $jogar.
  // Este filtro vale para ambos os modos automáticos; a trava real fica em reserveJogar.
  const recent = st.lastJogar || {};
  const choices = mode === "manual" || !st.autoJogar ? above
    : above.filter(x => now - (Number(recent[x.login]) || 0) >= TWITCH_COOLDOWN_MS);
  const best = choices[0];
  if (!best) {
    await set({ ...ok, phase: "idle", suggestedLive: null,
      nextScanAt: now + gapMs, scanSummary: summary,
      status: "Lives disponíveis, mas $jogar já foi tentado recentemente. Aguardando o próximo ciclo sem repetir mensagens." });
    return;
  }
  if (mode === "manual") {
    await set({
      ...ok, phase: "idle", nextScanAt: now + gapMs, scanSummary: summary,
      suggestedLive: { login: best.login, zone: best.zone, wave: best.wave, foundAt: now },
      status: `Sugestão: ${best.login} na zona ${best.zone}-${best.wave}. Clique em Ir para autorizar.`,
    });
    return;
  }
  // Modo allowed: apenas canais explicitamente permitidos; automatic: todos os ativos.
  // Atualiza as preferências ANTES da ação, para impedir entrar caso tenham mudado durante a consulta.
  const latest = await getState();
  if (!latest.enabled || modeOf(latest) !== mode || !latest.lives.includes(best.login) ||
      !canUseLive(latest, best.login) || latest.phase === "joining") {
    await set({ ...ok, phase: "idle", suggestedLive: null,
      nextScanAt: now + gapMs, scanSummary: summary,
      status: "Preferências alteradas durante a busca. Aguardando nova consulta." });
    return;
  }
  await set({
    ...ok, phase: "joining", suggestedLive: null,
    joinQueue: [best.login], joinIdx: 0,
    nextScanAt: now + gapMs, scanSummary: summary,
    status: `Modo ${mode === "allowed" ? "somente permitidas" : "automático"}: entrando em ${best.login} (zona ${best.zone}-${best.wave}).`,
  });
  await visit(best.login);
}

async function joinNext(why) {
  const st = await getState();
  const next = st.joinQueue.length; // sem trocar para outra live sem nova autorização
  if (next < st.joinQueue.length) {
    await set({ joinIdx: next, status: `${why}. Tentando ${st.joinQueue[next]}...` });
    await visit(st.joinQueue[next]);
  } else {
    await set({ phase: "idle", nextScanAt: Date.now() + st.scanGapSec * 1000, status: `Não consegui entrar em nenhuma live (${why}).` });
    await restorePrev(st);
  }
}

async function finishJoin(msg) {
  const st = await getState();
  await set({
    phase: "joined", nextScanAt: Date.now() + st.scanGapSec * 1000, zoneSince: Date.now(),
    lastJoined: msg.login, ...(msg.jogar === "sent" ? { lastJogarAt: Date.now() } : {}),
    status: msg.jogar === "skipped"
      ? `Live ${msg.login} aberta sem $jogar, conforme a opção de entrada no chat.`
      : msg.viaApi
      ? `$jogar ${msg.jogar === "sent" ? "enviado pela API da Twitch" : "já enviado recentemente (cooldown)"} em ${msg.login}. Aguardando o personagem confirmar a entrada.`
      : `Mensagem de $jogar em ${msg.login}: ${msg.follow === "followed" ? "follow realizado; " : msg.follow === "not-found" ? "botão Seguir não encontrado; " : msg.follow === "confirm-fail" ? "follow não confirmado; " : ""}${msg.jogar === "sent" ? "enviada pelo chat" : "não reenviada (cooldown)"}. Aguardando o personagem confirmar.`,
  });
  chrome.alarms.create("charReload", { when: Date.now() + 8000 });
  if (!msg.viaApi) await restorePrev(st);
}

async function doTick() {
  const st = await getState();
  if (!st.enabled) return;
  const now = Date.now();
  await ensureCharTab(st, now);
  if (st.discoverEnabled && st.phase !== "joining" && !st.discoverBusy && (!st.nextDiscoverAt || now >= st.nextDiscoverAt)) {
    await discoverLives(false);
    return;
  }
  if (!st.lives.length) { await set({ status: st.discoverEnabled ? "Aguardando a descoberta de lives online do ranking." : "Cole os links das lives no popup." }); return; }

  if (st.phase === "joining") {
    if (now > st.visitDeadline) return joinNext("tempo esgotado");
    return;
  }

  // Consulta periódica = mesmo caminho do botão "Procurar agora".
  // Não depende do status do personagem estar atualizado, justamente para se recuperar
  // quando a leitura da zona fica travada ou o site do personagem apresenta erro.
  // Mantém o intervalo mínimo entre buscas e o backoff da API quando há falhas.
  const autoMs = Math.max(0, Number(st.autoScanMin) || 0) * 60000;
  if (autoMs > 0) {
    if (!st.nextAutoScanAt) {
      // Inicialização segura para quem atualizou a extensão com a opção já ligada.
      const last = Number(st.lastScanStart) || 0;
      const next = last > 0 && last + autoMs > now ? last + autoMs : now + autoMs;
      await set({ nextAutoScanAt: next });
    } else if (now >= st.nextAutoScanAt && now >= st.nextScanAt) {
      return startScan(`automática a cada ${st.autoScanMin} min`, { auto: true });
    }
  }

  const c = st.char;
  if (!c || now - c.at > 4 * 60 * 1000) {
    await set({ status: st.siteError ? "RiftStream com erro no servidor. Aguardando voltar..." : "Aguardando a leitura da página do seu personagem..." });
    return;
  }
  if (c.zone == null) { await set({ status: "Não achei sua zona na página do personagem (está logado no RiftStream?)" }); return; }

  const stallMs = (Number(st.stallMin) || 0) * 60000;
  const stalled = stallMs > 0 && st.zoneSince && now - st.zoneSince >= stallMs;
  const inDisabled = !!c.playingIn && st.disabled.includes(c.playingIn);
  if (c.zone > st.resetZone && (stalled || inDisabled)) {
    if (now >= st.nextScanAt) {
      return startScan(inDisabled ? `${c.playingIn} está desativada` : `zona ${c.zone}-${c.wave} parada há ${fmt(now - st.zoneSince)}`, { stalled: true });
    }
    return;
  }
  if (c.zone <= st.resetZone) {
    if (now >= st.nextScanAt) return startScan(`sua zona está em ${c.zone}-${c.wave}`);
    return;   // aguardando o intervalo/backoff: mantém a mensagem da última busca
  }

  // Reenvio automático na mesma live desabilitado: evita mensagens repetidas.
  const rejoinMs = (Number(st.rejoinMin) || 0) * 60000;
  if (false && rejoinMs > 0 && c.playingIn) {
    if (st.lastJoined !== c.playingIn) {
      await set({ lastJoined: c.playingIn, lastJogarAt: now });   // começa a contar a partir de agora
    } else if (!st.disabled.includes(c.playingIn) && now - st.lastJogarAt >= rejoinMs) {
      return startRejoin(st, c.playingIn);
    }
  }
  await set({ status: `Você: zona ${c.zone}-${c.wave}${c.playingIn ? " em " + c.playingIn : ""}. Esperando a zona reiniciar.` });
}

async function startRejoin(st, live) {
  let prev = null;
  try {
    const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (t && t.id !== st.tabId && t.id !== st.charTabId) prev = t.id;
  } catch (e) { /* ignora */ }
  await set({
    phase: "joining", joinQueue: [live], joinIdx: 0, prevTabId: prev || st.prevTabId || null,
    status: `Digitando $jogar de novo em ${live} (a cada ${st.rejoinMin} min)...`,
  });
  await visit(live);
}

async function handleConfig(sender) {
  const st = await getState();
  return {
    active: !!st.enabled && st.phase === "joining" && !!sender.tab && sender.tab.id === st.tabId &&
      canUseLive(st, st.current),
    login: st.current,
    autoJogar: !!st.autoJogar,
    autoFollow: !!st.autoFollow && !!st.autoJogar,
    followWaitSec: Math.max(0, Math.min(180, Number(st.followWaitSec) || 0)),
  };
}

async function handleReport(msg, sender) {
  const st = await getState();
  if (!st.enabled || st.phase !== "joining" || !sender.tab || sender.tab.id !== st.tabId || msg.login !== st.current) return;
  if (msg.offline) return joinNext(`${msg.login} offline`);
  if (msg.jogar === "follow-unconfirmed") {
    const reasons = { "not-found": "botão Seguir não encontrado", "confirm-fail": "Twitch não confirmou o follow",
      "click-fail": "clique no botão Seguir não funcionou", "needs-login": "é necessário entrar na conta Twitch" };
    await set({ phase: "idle", current: null, visitDeadline: 0,
      nextScanAt: Date.now() + Math.max(60000, st.scanGapSec * 1000),
      status: `Follow em ${msg.login}: ${reasons[msg.follow] || "não confirmado"}. $jogar NÃO foi enviado. Confira sua conta Twitch e o botão da live.` });
    return;
  }
  if (msg.jogar === "chat-locked") {
    await set({ phase: "idle", nextScanAt: Date.now() + Math.max(60000, st.scanGapSec * 1000),
      status: `Chat de ${msg.login} bloqueado (pode exigir tempo como seguidor). $jogar não enviado; respeitando restrição da Twitch.` });
    return;
  }
  if (msg.jogar === "send-fail") {
    // digitou mas o chat não enviou: para aqui e deixa a aba aberta pra você apertar Enter
    await set({ phase: "idle", nextScanAt: Date.now() + st.scanGapSec * 1000, status: `Digitei $jogar em ${msg.login}, mas o chat não enviou. Aperte Enter na aba.` });
    return;
  }
  if (msg.jogar === "uncertain") { await set({phase:"idle", status:`Envio de $jogar em ${msg.login} sem confirmação. Não vou reenviar automaticamente.`}); return; }
  if (msg.jogar === "no-input" || msg.jogar === "type-fail") return joinNext(`não consegui digitar em ${msg.login}`);
  return finishJoin(msg);
}

async function handleChar(msg) {
  const st = await chrome.storage.local.get(["char", "zoneKey", "siteError", "enabled"]);
  if (msg.error) {   // a página do RiftStream mostrou "não foi possível carregar": não sobrescreve a última zona lida
    if (!st.siteError) await set({ siteError: true });
    return;
  }
  // Durante um carregamento parcial, mantém a última zona válida.
  if (!Number.isFinite(msg.zone) || !Number.isFinite(msg.wave) || msg.zone < 1 || msg.wave < 1) return;
  const prev = st.char;
  const key = `${msg.zone}-${msg.wave}`;
  if (key !== st.zoneKey) await set({ zoneKey: key, zoneSince: Date.now() });
  const stats = msg.stats?.name ? msg.stats : (prev?.stats || null);
  // Não lê o ranking da tela antiga: ele é pesquisado na API de personagens.
  await set({ siteError: false, char: { zone: msg.zone, wave: msg.wave, playingIn: msg.playingIn,
    lifeState: msg.lifeState === "alive" || msg.lifeState === "dead" ? msg.lifeState : null,
    stats, at: Date.now() } });
  if (stats?.name) refreshCharacterRank(stats.name, stats.fc).catch(e => console.warn("[JARVIS rank]",e));
  if (st.enabled && (!prev || prev.zone !== msg.zone || prev.wave !== msg.wave || prev.playingIn !== msg.playingIn))
    serial(doTick);
}

// Relatórios do personagem NÃO esperam a fila de consultas de lives (que pode
// levar dezenas de segundos). Ações de troca de live continuam serializadas.
let charChain = Promise.resolve();
function charSerial(fn) {
  const p = charChain.then(fn);
  charChain = p.catch((e) => console.error("[JARVIS char]", e));
  return p;
}

// Ações "reais" (confiáveis) no campo de chat via depurador do Chrome.
async function cdpRun(tabId, fn) {
  const target = { tabId };
  await chrome.debugger.attach(target, "1.3");
  try { await fn(target); }
  finally { try { await chrome.debugger.detach(target); } catch (e) { /* ignora */ } }
}
// Insere o texto INTEIRO de uma vez (equivale a um Ctrl+V): não perde letras.
const cdpInsert = (tabId, text) => cdpRun(tabId, async (t) => {
  await chrome.debugger.sendCommand(t, "Input.insertText", { text });
});
const cdpClickFollow = (tabId, x, y) => cdpRun(tabId, async (t) => {
  await chrome.debugger.sendCommand(t, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await chrome.debugger.sendCommand(t, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await chrome.debugger.sendCommand(t, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
});
const cdpEnter = (tabId) => cdpRun(tabId, async (t) => {
  const enter = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
  await chrome.debugger.sendCommand(t, "Input.dispatchKeyEvent", { type: "keyDown", ...enter, text: "\r", unmodifiedText: "\r" });
  await chrome.debugger.sendCommand(t, "Input.dispatchKeyEvent", { type: "keyUp", ...enter });
  await sleepMs(200);
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "cdpInsert" || msg.type === "cdpEnter" || msg.type === "cdpClickFollow") {
    getState().then(async (s) => {
      const sourceLogin = (() => {
        try {
          const u = new URL(sender.tab?.url || "");
          return u.origin === "https://www.twitch.tv" ? (u.pathname.split("/")[1] || "").toLowerCase() : "";
        } catch (_) { return ""; }
      })();
      if (!s.enabled || s.phase !== "joining" || !sender.tab || sender.tab.id !== s.tabId ||
          !canUseLive(s, s.current) || s.sendMethod !== "chat" || sourceLogin !== s.current)
        return sendResponse({ ok: false, error: "não autorizado" });
      try {
        if (msg.type === "cdpInsert") await cdpInsert(sender.tab.id, String(msg.text).slice(0, 50));
        else if (msg.type === "cdpEnter") await cdpEnter(sender.tab.id);
        else {
          const x = Number(msg.x), y = Number(msg.y);
          if (!s.autoFollow || !Number.isFinite(x) || !Number.isFinite(y) ||
              x < 0 || y < 0 || x > 5000 || y > 5000) throw new Error("Clique de follow inválido.");
          await cdpClickFollow(sender.tab.id, x, y);
        }
        sendResponse({ ok: true });
      } catch (e) { sendResponse({ ok: false, error: String(e && e.message || e) }); }
    });
    return true;
  }
  if (msg.type === "twitchAuthStatus") {
    twitchAuthStatus().then(sendResponse).catch((e) => sendResponse({ connected: false, error: String(e.message || e) }));
    return true;
  }
  if (msg.type === "twitchConnect") {
    connectTwitch().then(sendResponse).catch((e) => sendResponse({ connected: false, error: String(e.message || e) }));
    return true;
  }
  if (msg.type === "twitchDisconnect") {
    chrome.storage.session.remove("twitchAuth").then(() => sendResponse({ connected: false })).catch((e) => sendResponse({ error: String(e.message || e) }));
    return true;
  }
  if (msg.type === "followProgress") serial(async () => {
    const st = await getState();
    if (!st.enabled || st.phase !== "joining" || sender.tab?.id !== st.tabId ||
        msg.login !== st.current || !st.autoFollow || st.sendMethod !== "chat") return;
    if (msg.phase === "checking") await set({ status: `Procurando o botão Seguir na live ${msg.login}...` });
    else if (msg.phase === "waiting") {
      const seconds = Math.max(0, Math.min(180, Number(msg.seconds) || 0));
      await set({ status: `Follow confirmado em ${msg.login}. Aguardando ${seconds}s antes de $jogar...` });
    }
  });
  if (msg.type === "getConfig") { handleConfig(sender).then(sendResponse); return true; }
  if (msg.type === "report") serial(() => handleReport(msg, sender));
  if (msg.type === "char") charSerial(() => handleChar(msg));
  if (msg.type === "charVitals" && sender.tab?.url &&
      /^https:\/\/(?:www\.)?riftstream\.com\.br\/character(?:[/?#]|$)/.test(sender.tab.url)) {
    const bounded=(x)=> typeof x === "number" && Number.isFinite(x) && x>=0 && x<=1e12 ? x : null;
    const state=msg.state === "alive" || msg.state === "dead" ? msg.state : null;
    set({charVitals:{state,currentHp:bounded(msg.currentHp),maxHp:bounded(msg.maxHp),at:Date.now()}});
  }
  if (msg.type === "charEquipment" && sender.tab?.url &&
      /^https:\/\/(?:www\.)?riftstream\.com\.br\/character(?:[/?#]|$)/.test(sender.tab.url) &&
      Array.isArray(msg.items) && msg.items.length <= 24) {
    set({ charEquipment: {
      items: msg.items.map((i) => ({
        slot: String(i.slot || "").slice(0, 28), name: String(i.name || "").slice(0, 75),
        rarity: String(i.rarity || "").slice(0, 25), level: String(i.level || "").slice(0, 10),
        cls: String(i.cls || "").slice(0, 20),
        icon: (() => {
          const icon = typeof i.icon === "string" ? i.icon : "";
          if (/^data:image\/(?:png|webp|gif|jpeg);base64,[a-z0-9+/=]+$/i.test(icon) && icon.length < 70000) return icon;
          try { const u = new URL(icon); return u.protocol === "https:" &&
            (u.hostname === "z6ywq6r3ub.execute-api.us-east-1.amazonaws.com" || /(^|\.)riftstream\.com\.br$/i.test(u.hostname))
            ? icon.slice(0, 400) : ""; } catch (_) { return ""; }
        })(),
        stats: (Array.isArray(i.stats) ? i.stats : []).slice(0, 10)
          .map(x => ({ label: String(x?.label || "").slice(0, 38), value: String(x?.value || "").slice(0, 40) }))
          .filter(x => x.label && x.value)
      })),
      identified: msg.identified === true, at: Date.now()
    } });
  }

  // Imagens alternativas retiradas apenas do quadro EQUIPADO da página /character.
  if (msg.type === "charEquipmentIcons" && sender.tab?.url &&
      /^https:\/\/(?:www\.)?riftstream\.com\.br\/character(?:[/?#]|$)/.test(sender.tab.url) &&
      Array.isArray(msg.icons) && msg.icons.length <= 8) {
    const icons = msg.icons.map(i=>({
      icon: typeof i?.icon === "string" && /^data:image\/png;base64,[a-z0-9+/=]+$/i.test(i.icon) && i.icon.length<70000 ? i.icon : "",
      label: String(i?.label||"").slice(0,80)
    })).filter(x=>x.icon);
    if (icons.length && icons.reduce((n,x)=>n+x.icon.length,0)<500000)
      set({charEquipmentIcons:{icons,at:Date.now()}});
  }

  if (msg.type === "charFrames" && Array.isArray(msg.frames) && msg.frames.length && msg.frames.length <= 24 && msg.frames.every((f) => typeof f === "string" && f.startsWith("data:image/")) && msg.frames.reduce((n, f) => n + f.length, 0) < 3000000) set({ charFrames: msg.frames, charFrameMs: Math.max(40, Math.min(500, +msg.interval || 90)) });
  if (msg.type === "charImg" && typeof msg.data === "string" && msg.data.startsWith("data:image/") && msg.data.length < 600000) set({ charImg: msg.data });
  if (msg.type === "apply") serial(doTick);
  if (msg.type === "scanNow") serial(() => startScan("manual"));
  if (msg.type === "refreshLiveFc" && !sender.tab) {
    const login = String(msg.login || "").trim().toLowerCase();
    refreshLiveFcManual(login).then(sendResponse)
      .catch(e => sendResponse({ok:false,error:String(e?.message || e)}));
    return true;
  }
  if (msg.type === "approveLive") serial(async () => {
    const st = await getState();
    const login = String(msg.login || "").toLowerCase();
    // Somente lives verificadas e habilitadas podem ser autorizadas.
    if (!st.enabled || modeOf(st) !== "manual" || st.phase === "joining" ||
        !canUseLive(st, login) || !(st.results[login]?.zone) || !st.lives.includes(login)) return;
    if (st.char?.playingIn?.toLowerCase() === login) {
      await set({ suggestedLive: null, status: `Você já está jogando em ${login}. Nenhum $jogar adicional foi enviado.` });
      return;
    }
    const stNow = await getState();
    if (stNow.phase === "joining") return;
    await set({ suggestedLive: null, phase: "joining", joinQueue: [login], joinIdx: 0,
      status: `Entrada em ${login} autorizada manualmente. Uma única tentativa de $jogar.` });
    await visit(login);
  });
  if (msg.type === "dismissLive") serial(async () => {
    const st = await getState();
    if (st.phase !== "joining") await set({ suggestedLive: null, status: "Sugestão dispensada. Continuarei buscando novas lives." });
  });
  if (msg.type === "claimJogar") {
    serial(async () => {
      const st = await getState();
      if (!st.enabled || st.phase !== "joining" || !sender.tab || sender.tab.id !== st.tabId ||
          st.current !== msg.login || st.sendMethod !== "chat" || !canUseLive(st, msg.login)) return false;
      return reserveJogar(msg.login);
    }).then(ok => sendResponse({ ok })).catch(() => sendResponse({ok:false}));
    return true;
  }
  if (msg.type === "discoverLives") serial(() => discoverLives(true));
});

const ensureAlarm = () => {
  chrome.alarms.create("tick", { periodInMinutes: 0.5 });
  chrome.alarms.create("charPoll", { periodInMinutes: 0.5 });
  chrome.alarms.create("fcBoards", { periodInMinutes: 1 });
  chrome.storage.local.remove(["sellEnabled", "sellDry", "sellMinLevel", "sellMax", "sellTotal", "sellStatus"]);   // venda removida
};
// Aplica o intervalo pedido uma única vez quando a versão nova entra em uso.
// Depois disso, os intervalos voltam a ser totalmente editáveis no popup.
async function migrateFastMonitoring() {
  const st = await chrome.storage.local.get(["fastMonitoring087", "enabled", "errStreak"]);
  if (st.fastMonitoring087) return;
  const enabled = st.enabled === true;
  await set({
    fastMonitoring087: true,
    discoverEnabled: true, discoverMin: 2, autoScanMin: 2, scanGapSec: 120,
    // Não cancela um backoff por instabilidade já em andamento.
    ...(enabled && !(Number(st.errStreak) > 0) ? { nextScanAt: 0 } : {}),
    nextDiscoverAt: enabled ? Date.now() : 0,
    nextAutoScanAt: enabled ? Date.now() + 2 * 60000 : 0,
  });
  if (enabled) await doTick();
}
chrome.runtime.onInstalled.addListener(() => { ensureAlarm(); serial(migrateFastMonitoring); });
chrome.runtime.onStartup.addListener(ensureAlarm);
// Mesmo se o service worker iniciar sem disparar onInstalled (extensão descompactada),
// aplica a migração pendente, uma única vez.
serial(migrateFastMonitoring);
chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name === "tick") serial(doTick);
  if (a.name === "charPoll") pollCharacter().catch(e => console.error("[JARVIS zona]", e));
  if (a.name === "fcBoards") scheduleFcRefresh();
  if (a.name === "charReload") {
    const { enabled, charTabId } = await chrome.storage.local.get(["enabled", "charTabId"]);
    if (enabled && charTabId) {
      try { await reloadManagedCharacterTab(charTabId, Date.now()); }
      catch (e) { console.warn("[JARVIS] Recarga do Rift não concluída:", e); }
    }
  }
});

// Se a aba monitorada navegar para outro site, solte o ID imediatamente.
// Isso evita que futuras consultas atinjam Crunchyroll, YouTube e outras abas.
chrome.tabs.onUpdated.addListener((id, changeInfo) => {
  if (!changeInfo.url || isRiftUrl(changeInfo.url)) return;
  chrome.storage.local.get("charTabId").then(({ charTabId }) => {
    if (id === charTabId) return set({ charTabId: null, lastCharReload: 0 });
  }).catch((e) => console.warn("[JARVIS] Não consegui liberar aba antiga:", e));
});

chrome.tabs.onRemoved.addListener(async (id) => {
  const { tabId, charTabId } = await chrome.storage.local.get(["tabId", "charTabId"]);
  if (id === tabId) await set({ tabId: null, phase: "idle", status: "Aba da live fechada." });
  if (id === charTabId) await set({ charTabId: null });
});
