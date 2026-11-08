const API = "https://4o9ys9ib13.execute-api.us-east-1.amazonaws.com/api/ranking/channel";
const CHAR_URL = "https://riftstream.com.br/character";
const DEFAULTS = {
  enabled: false, livesText: "", lives: [],
  resetZone: 1, scanGapSec: 120, autoJogar: true,
  phase: "idle", queue: [], results: {}, joinQueue: [], joinIdx: 0,
  visitDeadline: 0, lastScanEnd: 0, prevTabId: null,
  char: null, tabId: null, charTabId: null, lastCharReload: 0,
  current: null, status: "", scanSummary: "",
};
const VISIT_TIMEOUT = 100 * 1000;
const score = (z, w) => z * 100 + (w || 0);
const getState = async () => ({ ...DEFAULTS, ...(await chrome.storage.local.get(null)) });
const set = (o) => chrome.storage.local.set(o);

// Tudo que mexe no estado roda em fila, uma coisa por vez.
let chain = Promise.resolve();
function serial(fn) {
  const p = chain.then(fn);
  chain = p.catch((e) => console.error("[RSHopper]", e));
  return p;
}

async function openLive(login) {
  const { tabId } = await chrome.storage.local.get("tabId");
  const url = `https://www.twitch.tv/${login}`;
  if (tabId) {
    try { await chrome.tabs.update(tabId, { url, active: true }); return; } catch (e) { /* aba sumiu */ }
  }
  const t = await chrome.tabs.create({ url, active: true });
  await set({ tabId: t.id });
}

async function ensureCharTab(st, now) {
  let ok = false;
  if (st.charTabId) { try { await chrome.tabs.get(st.charTabId); ok = true; } catch (e) { /* fechada */ } }
  if (!ok) {
    const t = await chrome.tabs.create({ url: CHAR_URL, active: false });
    await set({ charTabId: t.id, lastCharReload: now });
    return;
  }
  if (now - st.lastCharReload >= 60 * 1000) {
    try { await chrome.tabs.reload(st.charTabId); } catch (e) { /* ignora */ }
    await set({ lastCharReload: now });
  }
}

async function restorePrev(st) {
  if (st.prevTabId) { try { await chrome.tabs.update(st.prevTabId, { active: true }); } catch (e) { /* ignora */ } }
}

async function visit(login) {
  await set({ current: login, visitDeadline: Date.now() + VISIT_TIMEOUT });
  await openLive(login);
}

// Consulta a API pública do canal (zona/onda ATUAIS, e se a live está no ar).
async function fetchChannel(login) {
  try {
    const r = await fetch(`${API}/${encodeURIComponent(login)}`);
    if (!r.ok) return { bad: `erro ${r.status}` };
    const j = await r.json();
    if (!j.live) return { bad: "offline" };
    if (!j.zone) return { bad: "sem run" };
    return { zone: j.zone, wave: j.wave, players: j.playersNow };
  } catch (e) {
    return { bad: "erro de rede" };
  }
}

async function startScan(reason) {
  const st = await getState();
  if (!st.enabled || !st.lives.length) return;
  await set({ status: `Consultando ${st.lives.length} lives (${reason})...` });
  const entries = await Promise.all(st.lives.map(async (l) => [l, await fetchChannel(l)]));
  const results = Object.fromEntries(entries);

  let prev = null;
  try {
    const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (t && t.id !== st.tabId && t.id !== st.charTabId) prev = t.id;
  } catch (e) { /* ignora */ }
  await set({ queue: [...st.lives], results, prevTabId: prev || st.prevTabId || null });
  await finishScan();
}

async function finishScan() {
  const st = await getState();
  const now = Date.now();
  const retrySoon = now - Math.max(0, st.scanGapSec - 30) * 1000;   // tenta de novo em ~30 s
  const ranked = Object.entries(st.results)
    .filter(([, r]) => r.zone)
    .map(([login, r]) => ({ login, zone: r.zone, wave: r.wave, s: score(r.zone, r.wave) }))
    .sort((a, b) => b.s - a.s);
  const summary = st.queue.map((l) => {
    const r = st.results[l];
    return r && r.zone ? `${l} ${r.zone}-${r.wave}` : `${l} (${(r && r.bad) || "?"})`;
  }).join(" | ");
  const c = st.char;
  const mine = c && c.zone ? score(c.zone, c.wave) : 0;
  const above = ranked.filter((x) => x.s > mine);

  if (!ranked.length) {
    await set({ phase: "idle", lastScanEnd: retrySoon, scanSummary: summary, status: "Nenhuma live da lista está no ar com run ativa." });
    return;
  }
  if (!above.length) {
    await set({
      phase: "idle", lastScanEnd: retrySoon, scanSummary: summary,
      status: `Nenhuma live acima da sua zona (${c ? c.zone + "-" + c.wave : "?"}). Melhor: ${ranked[0].login} ${ranked[0].zone}-${ranked[0].wave}.`,
    });
    return;
  }
  const best = above[0];
  if (!st.autoJogar) {
    await set({
      phase: "idle", lastScanEnd: now, scanSummary: summary,
      status: `Melhor live: ${best.login} (zona ${best.zone}-${best.wave}). Digite $jogar.`,
    });
    return visit(best.login);
  }
  await set({
    phase: "joining", joinQueue: above.map((x) => x.login), joinIdx: 0, scanSummary: summary,
    status: `Entrando em ${best.login} (zona ${best.zone}-${best.wave})...`,
  });
  await visit(best.login);
}

async function joinNext(why) {
  const st = await getState();
  const next = st.joinIdx + 1;
  if (next < st.joinQueue.length) {
    await set({ joinIdx: next, status: `${why}. Tentando ${st.joinQueue[next]}...` });
    await visit(st.joinQueue[next]);
  } else {
    await set({ phase: "idle", lastScanEnd: Date.now(), status: `Não consegui entrar em nenhuma live (${why}).` });
    await restorePrev(st);
  }
}

async function finishJoin(msg) {
  const st = await getState();
  await set({
    phase: "joined", lastScanEnd: Date.now(),
    status: `Entrei em ${msg.login}: $jogar ${msg.jogar === "sent" ? "enviado" : "não reenviado (cooldown)"}.`,
  });
  chrome.alarms.create("charReload", { when: Date.now() + 8000 });
  await restorePrev(st);
}

async function doTick() {
  const st = await getState();
  if (!st.enabled) return;
  const now = Date.now();
  if (!st.lives.length) { await set({ status: "Cole os links das lives no popup." }); return; }

  await ensureCharTab(st, now);

  if (st.phase === "joining") {
    if (now > st.visitDeadline) return joinNext("tempo esgotado");
    return;
  }

  const c = st.char;
  if (!c || now - c.at > 4 * 60 * 1000) { await set({ status: "Aguardando a leitura da página do seu personagem..." }); return; }
  if (c.zone == null) { await set({ status: "Não achei sua zona na página do personagem (está logado no RiftStream?)" }); return; }

  if (c.zone <= st.resetZone && now - (st.lastScanEnd || 0) >= st.scanGapSec * 1000) {
    return startScan(`sua zona está em ${c.zone}-${c.wave}`);
  }
  await set({ status: `Você: zona ${c.zone}-${c.wave}${c.playingIn ? " em " + c.playingIn : ""}. Esperando a zona reiniciar.` });
}

async function handleConfig(sender) {
  const st = await getState();
  return {
    active: !!st.enabled && st.phase === "joining" && !!sender.tab && sender.tab.id === st.tabId,
    login: st.current,
  };
}

async function handleReport(msg, sender) {
  const st = await getState();
  if (!st.enabled || st.phase !== "joining" || !sender.tab || sender.tab.id !== st.tabId || msg.login !== st.current) return;
  if (msg.offline) return joinNext(`${msg.login} offline`);
  if (msg.jogar === "send-fail") {
    // digitou mas o chat não enviou: para aqui e deixa a aba aberta pra você apertar Enter
    await set({ phase: "idle", lastScanEnd: Date.now(), status: `Digitei $jogar em ${msg.login}, mas o chat não enviou. Aperte Enter na aba.` });
    return;
  }
  if (msg.jogar === "no-input" || msg.jogar === "type-fail") return joinNext(`não consegui digitar em ${msg.login}`);
  return finishJoin(msg);
}

async function handleChar(msg) {
  const st = await getState();
  const prev = st.char;
  await set({ char: { zone: msg.zone, wave: msg.wave, playingIn: msg.playingIn, at: Date.now() } });
  if (st.enabled && (!prev || prev.zone !== msg.zone)) return doTick();
}

// Digita no campo focado da aba com teclas "reais" (confiáveis) e aperta Enter.
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
async function cdpType(tabId, text) {
  const target = { tabId };
  await chrome.debugger.attach(target, "1.3");
  try {
    for (const ch of text) {
      await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", { type: "keyDown", key: ch, text: ch, unmodifiedText: ch });
      await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", { type: "keyUp", key: ch });
      await sleepMs(40);
    }
    await sleepMs(500);
    const enter = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
    await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", { type: "keyDown", ...enter, text: "\r", unmodifiedText: "\r" });
    await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", { type: "keyUp", ...enter });
    await sleepMs(300);
  } finally {
    try { await chrome.debugger.detach(target); } catch (e) { /* ignora */ }
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "cdpType") {
    const st = chrome.storage.local.get(["enabled", "tabId", "phase"]);
    st.then(async (s) => {
      if (!s.enabled || s.phase !== "joining" || !sender.tab || sender.tab.id !== s.tabId) return sendResponse({ ok: false, error: "não autorizado" });
      try { await cdpType(sender.tab.id, msg.text); sendResponse({ ok: true }); }
      catch (e) { sendResponse({ ok: false, error: String(e && e.message || e) }); }
    });
    return true;
  }
  if (msg.type === "getConfig") { handleConfig(sender).then(sendResponse); return true; }
  if (msg.type === "report") serial(() => handleReport(msg, sender));
  if (msg.type === "char") serial(() => handleChar(msg));
  if (msg.type === "apply") serial(doTick);
  if (msg.type === "scanNow") serial(() => startScan("manual"));
});

const ensureAlarm = () => chrome.alarms.create("tick", { periodInMinutes: 0.5 });
chrome.runtime.onInstalled.addListener(ensureAlarm);
chrome.runtime.onStartup.addListener(ensureAlarm);
chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name === "tick") serial(doTick);
  if (a.name === "charReload") {
    const { charTabId } = await chrome.storage.local.get("charTabId");
    if (charTabId) { try { await chrome.tabs.reload(charTabId); } catch (e) { /* ignora */ } }
  }
});

chrome.tabs.onRemoved.addListener(async (id) => {
  const { tabId, charTabId } = await chrome.storage.local.get(["tabId", "charTabId"]);
  if (id === tabId) await set({ tabId: null, phase: "idle", status: "Aba da live fechada." });
  if (id === charTabId) await set({ charTabId: null });
});
