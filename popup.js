const DEFAULTS = {
  enabled: false, livesText: "", lives: [], resetZone: 1, scanGapSec: 120, autoJogar: true,
  phase: "idle", results: {}, char: null, current: null, status: "", nextScanAt: 0, errStreak: 0, siteError: false,
  forgeEnabled: false, forgeDry: true, forgeMax: "lendario", forgeMinChance: 100, forgeLost: 0, forgeStatus: "", forgeTotal: 0,
  disabled: [], stallMin: 5, charFrames: null, charFrameMs: 90,
  bgVis: 70, autoScanMin: 2, nextAutoScanAt: 0, rejoinMin: 0, lastScanStart: 0, lastJoined: null, lastJogarAt: 0,
  discoverEnabled: true, discoverMin: 2, discoverTop: 20, discoveredLives: [], nextDiscoverAt: 0, discoverBusy: false, discoverStatus: "",
  autoFollow: false, followWaitSec: 15, sendMethod: "chat", twitchClientId: "", hiddenStats: [], equipmentHidden: false, suggestedLive: null,
  liveMode: "manual", allowedLives: [], muteLives: true,
  forgePaused: false, forgePauseAfter: 0, forgeRunBaseTotal: null,
  ui: { mine: true, lives: true, chat: false, appearance: false, forge: false, cfg: false, monitor: false },
};
const $ = (id) => document.getElementById(id);
const nums = ["resetZone", "scanGapSec", "stallMin", "autoScanMin", "discoverMin", "discoverTop", "followWaitSec", "forgePauseAfter"];
const checks = ["autoJogar", "forgeEnabled", "forgeDry", "discoverEnabled", "autoFollow", "muteLives"];
const score = (z, w) => z * 100 + (w || 0);
const fmtNum = (n) => Number(n).toLocaleString("pt-BR", { maximumFractionDigits: 0 });
// Exibe a soma exata no card: FC 62.264.159, sem arredondar para milhões.
const fmtFcCard = (n) => fmtNum(n);
const freshFc = (r) => Number.isSafeInteger(r?.fcTotal) && (
  r.fcSource !== "boardNow" || (Number(r.fcCheckedAt) > 0 && Date.now() - r.fcCheckedAt <= 6 * 60_000)
);
const freshResult = (r, st) => {
  if (!r || !r.zone) return false;
  const checkedAt = Number(r.checkedAt) || Number(st.lastScanStart) || 0;
  return checkedAt > 0 && Date.now() - checkedAt <= 5 * 60_000;
};
let cur = DEFAULTS;
let frames = null, frameMs = 90, frameIdx = 0, frameTimer = null;
let statToolsOpen = false;
const expandedEquipment = new Set();
let authInfo = { connected: false, login: "", redirect: "" };

// "Zona agora" fica fixa. Os demais atributos podem ser ocultados individualmente.
const STAT_ITEMS = [
  ["best", "Maior zona"], ["level", "Nível"], ["rank", "Ranking"],
  ["fc", "FC"], ["gold", "Ouro"], ["hp", "Vida"], ["atk", "Ataque"],
  ["def", "Defesa"], ["spd", "Velocidade"], ["crit", "Crítico"], ["critDmg", "Dano crítico"],
];
const STAT_KEYS = new Set(STAT_ITEMS.map(([key]) => key));
async function setStatVisible(key, visible) {
  if (!STAT_KEYS.has(key)) return;
  const { hiddenStats = [] } = await chrome.storage.local.get("hiddenStats");
  const next = new Set(hiddenStats);
  if (visible) next.delete(key); else next.add(key);
  await chrome.storage.local.set({ hiddenStats: [...next] });
}

function renderStatOptions(host, hidden) {
  const tools = mk("details", "stat-tools");
  const summary = mk("summary");
  summary.title = "Personalizar os atributos do personagem";
  summary.setAttribute("aria-label", "Personalizar atributos do personagem");
  const gear = mk("span", "stat-icon", "⚙");
  gear.setAttribute("aria-hidden", "true");
  const count = mk("span", "stat-badge", `${STAT_ITEMS.length - hidden.size}/${STAT_ITEMS.length}`);
  summary.append(gear, mk("span", "", "Atributos"), count);
  tools.append(summary);

  const options = mk("div", "stat-options");
  const top = mk("div", "stat-options-head");
  top.append(mk("span", "stat-options-title", "Exibir no personagem"));
  const actions = mk("div", "stat-actions");
  for (const [label, keys] of [
    ["Todos", []],
    ["Nenhum", STAT_ITEMS.map(([key]) => key)],
  ]) {
    const btn = mk("button", "stat-action", label);
    btn.type = "button";
    btn.addEventListener("click", () => chrome.storage.local.set({ hiddenStats: keys }));
    actions.append(btn);
  }
  top.append(actions);
  options.append(top);
  const grid = mk("div", "stat-options-grid");
  for (const [key, label] of STAT_ITEMS) {
    const row = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox"; cb.checked = !hidden.has(key);
    cb.addEventListener("change", () => setStatVisible(key, cb.checked));
    row.append(cb, document.createTextNode(label));
    grid.append(row);
  }
  options.append(grid);
  tools.append(options);
  host.append(tools);
}


function parseLives(text) {
  const out = [];
  for (let s of text.split(/[\s,;]+/)) {
    s = s.trim().replace(/^https?:\/\//i, "").replace(/^(www\.)?twitch\.tv\//i, "").split(/[/?#]/)[0].replace(/^@/, "");
    if (/^[A-Za-z0-9_]{2,25}$/.test(s) && !out.includes(s.toLowerCase())) out.push(s.toLowerCase());
  }
  return out;
}

function mk(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function renderLives(st) {
  const ul = $("liveList");
  ul.replaceChildren();
  if (!st.lives.length) {
    ul.append(mk("li", "empty", "Nenhuma live. Abra as configurações e cole os links."));
    $("livesCount").textContent = "";
    return;
  }
  const mine = st.char && st.char.zone ? score(st.char.zone, st.char.wave) : 0;
  const off = (l) => (st.disabled || []).includes(l);
  const permitted = new Set(st.allowedLives || []);
  const val = (r) => (r && r.zone ? score(r.zone, r.wave) : -1);
  const rows = st.lives.map((login) => ({ login, r: st.results[login] || null, off: off(login) }));
  rows.sort((a, b) => (a.off - b.off) || (val(b.r) - val(a.r)));
  const bestLogin = rows.length && !rows[0].off && val(rows[0].r) > mine ? rows[0].login : null;
  const activeRows = rows.filter((x) => !x.off);
  const online = activeRows.filter((x) => x.r && x.r.zone).length;
  $("livesCount").textContent = `(${online} com run ativa de ${activeRows.length})`;

  for (const { login, r, off: isOff } of rows) {
    const li = mk("li", (login === bestLogin ? "best" : "") + (isOff ? " off" : ""));
    const cb = document.createElement("input");
    cb.type = "checkbox"; cb.className = "lv-on"; cb.checked = !isOff;
    cb.title = isOff ? "Desativada: a busca ignora esta live. Clique para ativar." : "Ativa. Clique para desativar (a busca vai ignorar esta live).";
    cb.addEventListener("change", () => toggleLive(login, cb.checked));
    const name = mk("span", "name", login);
    if ((st.discoveredLives || []).includes(login)) name.append(mk("span", "tag", "top"));
    if (st.phase === "joining" && st.current === login) name.append(mk("span", "tag", "entrando"));
    const left = mk("span", "left");
    left.append(cb, name);
    let v;
    if (isOff) v = mk("span", "val muted", "desativada");
    else if (!r) v = mk("span", "val muted", "sem busca");
    else if (r.zone) v = mk("span", "val good", `zona ${r.zone}-${r.wave}`);
    else v = mk("span", "val " + (r.serverError ? "bad" : "muted"), r.bad || "?");
    li.append(left, v);

    // Pessoas em jogo ≠ espectadores da Twitch. FC soma somente se o backend
    // fornecer um total validado (não inventa FC quando o dado estiver ausente).
    const stats = mk("div", "live-stat-row");
    const fresh = !isOff && (freshResult(r, st) || (r?.fcSource === "boardNow" && freshFc(r)));
    const people = fresh && Number.isFinite(r.players) ? fmtNum(r.players) : "—";
    const power = fresh && freshFc(r) ? fmtFcCard(r.fcTotal) : "—";
    const peopleChip = mk("span", "live-stat people", `👥 ${people} jogando`);
    const hasFc = fresh && freshFc(r);
    const canRetry = !isOff && !!r?.zone && !hasFc;
    const powerChip = mk(canRetry ? "button" : "span", "live-stat power" + (canRetry ? " live-fc-retry" : ""),
      `⚔ FC ${power}${canRetry ? " ↻" : ""}`);
    peopleChip.title = fresh && Number.isFinite(r.players)
      ? r.fcSource === "boardNow" && freshFc(r)
        ? "Total de jogadores confirmado no ranking Jogando agora"
        : "Jogadores informados pela API do canal; consultando ranking Jogando agora"
      : "Contagem ainda não informada ou dados antigos";
    powerChip.title = hasFc
      ? `FC total dos ${fmtNum(r.boardPlayers ?? r.players ?? 0)} jogadores ativos: ${fmtNum(r.fcTotal)} (ranking Jogando agora, todas as páginas)`
      : `${r?.fcError ? `Motivo: ${r.fcError}. ` : "Ainda não houve uma leitura completa. "}${canRetry ? "Clique para consultar novamente." : ""}`;
    if (canRetry) {
      powerChip.type = "button";
      powerChip.setAttribute("aria-label", `Consultar novamente FC total da live ${login}`);
      powerChip.addEventListener("click", async () => {
        powerChip.disabled = true;
        powerChip.textContent = "⚔ Consultando...";
        try {
          const response = await chrome.runtime.sendMessage({type:"refreshLiveFc",login});
          if (response?.ok === false) powerChip.title = response.error || "Não foi possível consultar agora.";
        } catch (e) { powerChip.title = String(e?.message || e); }
        finally {
          // Se a storage não atualizou a UI, libera o botão para nova tentativa.
          if (powerChip.isConnected) { powerChip.disabled = false; powerChip.textContent = "⚔ FC — ↻"; }
        }
      });
    }
    stats.append(peopleChip, powerChip);
    li.append(stats);
    // Permitir uma live NÃO inicia imediatamente $jogar. Libera a escolha automática
    // somente no modo "Só lives permitidas", após a próxima consulta.
    const allow = mk("button", "allowed-action" + (permitted.has(login) ? " is-allowed" : ""),
      permitted.has(login) ? "✓ Permitida" : "+ Permitir");
    allow.type = "button";
    allow.setAttribute("aria-pressed", String(permitted.has(login)));
    allow.title = permitted.has(login)
      ? "Remover esta live da lista de entrada automática"
      : "Autorizar entrada automática apenas neste canal (no modo Só lives permitidas)";
    allow.addEventListener("click", () => toggleAllowedLive(login));
    const actions = mk("div", "live-actions");
    actions.append(allow);
    if (!isOff && r?.zone && st.enabled && (st.liveMode || "manual") === "manual") {
      const go = mk("button", "live-go", "Ir"); go.type = "button";
      go.disabled = st.phase === "joining" || st.char?.playingIn?.toLowerCase() === login;
      go.title = "Autorizar uma única entrada nesta live";
      go.addEventListener("click", () => chrome.runtime.sendMessage({ type: "approveLive", login }));
      actions.append(go);
    }
    li.append(actions);
    ul.append(li);
  }
}

function renderMonitor(st) {
  const active = (st.lives || []).filter(login => !(st.disabled || []).includes(login));
  const current = String(st.char?.playingIn || (st.phase === "joined" ? st.current : "") || "").toLowerCase();
  const currentResult = st.results?.[current];
  const playersFresh = r => freshResult(r, st) || (r?.fcSource === "boardNow" && freshFc(r));
  const currentPlayers = playersFresh(currentResult) && Number.isFinite(currentResult.players)
    ? currentResult.players : null;
  const measured = active.map(login => st.results?.[login]).filter(r =>
    playersFresh(r) && Number.isFinite(r.players));
  const total = measured.reduce((sum, r) => sum + r.players, 0);
  $("monitorLivePlayers").textContent = currentPlayers === null ? "—" : fmtNum(currentPlayers);
  $("monitorAllPlayers").textContent = measured.length ? fmtNum(total) : "—";
  $("monitorLivesMeasured").textContent = `${measured.length}/${active.length} lives com dados`;
  $("monitorLiveName").textContent = current ? `na ${current}` : "live atual";
  $("monitorAllPlayers").title = "Soma somente de lives com consulta recente e contagem válida; não inclui as não verificadas.";
}

function renderMine(st) {
  const box = $("mine");
  box.replaceChildren();
  const c = st.char;
  const s = c && c.stats;
  if (!c || !s) { box.append(mk("div", "empty-note", "Abra a aba /character do RiftStream, logado, para ler seus status.")); return; }

  const hero = mk("div", "hero" + (st.charImg || (st.charFrames && st.charFrames.length) ? " has-art" : ""));
  const main = mk("div", "hero-main");
  const head = mk("div", "hero-head");
  head.append(mk("strong", "", s.name || "Seu personagem"));
  if (s.cls) head.append(mk("span", "sub", s.cls[0].toUpperCase() + s.cls.slice(1)));
  if (c.playingIn) head.append(mk("span", "in", "Jogando em " + c.playingIn));
  main.append(head);

  // O valor "Vida" nos atributos é HP de ficha, não necessariamente o HP atual.
  // Dados de batalha são mostrados somente se vieram explicitamente da API /me.
  const v = st.charVitals || {};
  const age=Date.now()-(Number(v.at)||0);
  const fresh=age>=0 && age<90_000; // após 90 s não anunciar estado antigo como se fosse ao vivo
  const apiState=fresh && ["alive","dead"].includes(v.state) ? v.state : null;
  const state=["alive","dead"].includes(c.lifeState) ? c.lifeState : apiState;
  // Se o selo da página e a API divergem, não exibe HP que pode estar desatualizado.
  const compatible=!c.lifeState || !apiState || c.lifeState===apiState;
  const currentHp=fresh && compatible && Number.isFinite(v.currentHp) && v.currentHp>=0 ? v.currentHp : null;
  const maxHp=fresh && Number.isFinite(v.maxHp) && v.maxHp>0 ? v.maxHp : null;
  const vitals=mk("div","char-vitals");
  const label=state==="alive" ? "● Vivo" : state==="dead" ? "● Morto" : "○ Estado indisponível";
  const badge=mk("span","char-life "+(state||"unknown"),label);
  badge.title=state ? (c.lifeState ? "Estado mostrado no cabeçalho do RiftStream." :
    "Estado informado pela última resposta da API (até 90 segundos).") :
    "O site e a API ainda não informaram um estado confiável.";
  vitals.append(badge);
  if(currentHp!==null) {
    const format=(n)=>new Intl.NumberFormat("pt-BR",{maximumFractionDigits:1}).format(n);
    const health=mk("span","char-hp-now", `HP ${format(currentHp)}${maxHp!==null ? " / "+format(maxHp) : ""}`);
    vitals.append(health);
    if(maxHp!==null) {
      const meter=mk("span","char-hp-meter");
      const fill=mk("i",""); fill.style.width=Math.min(100,Math.max(0,currentHp/maxHp*100))+"%";
      meter.append(fill); vitals.append(meter);
    }
  }
  main.append(vitals);

  // FC individual acima continua sendo do personagem. Esta faixa mostra a
  // força SOMADA da live em que o personagem realmente está jogando.
  const playingLogin = String(c.playingIn || "").trim().toLowerCase();
  if (playingLogin) {
    const live = st.results?.[playingLogin];
    const recent = freshResult(live, st) || (live?.fcSource === "boardNow" && freshFc(live));
    const livePeople = recent && Number.isSafeInteger(live?.players) ? fmtNum(live.players) : "—";
    const livePower = recent && freshFc(live) ? fmtFcCard(live.fcTotal) : "—";
    const summary = mk("div", "char-live-metrics");
    const people = mk("span", "char-live-people", `👥 ${livePeople} jogando`);
    people.title = `Jogadores na live ${playingLogin}`;
    const fc = mk("span", "char-live-fc", `⚔ FC total da live: ${livePower}`);
    fc.title = livePower !== "—" ? `Soma de FC dos jogadores ativos em ${playingLogin}, conforme o ranking Jogando agora.` :
      (live?.fcError ? `FC indisponível: ${live.fcError}` :
        "FC ainda não confirmado. É necessário que a live esteja monitorada e que o ranking responda por completo.");
    summary.append(people, fc);
    main.append(summary);
  }

  const cells = [
    ["Zona agora", c.zone != null ? `${c.zone}-${c.wave}` : null, true, "zone"],
    ["Maior zona", s.best, false, "best"], ["Nível", s.level, false, "level"], ["Ranking", (() => {
      const external = st.charRanking;
      const key = x => String(x || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").trim().replace(/^@/, "").toLowerCase();
      const matches = external && external.name && s.name && key(external.name) === key(s.name);
      const fresh = external && Date.now() - (Number(external.at) || 0) < 60 * 60 * 1000;
      const rank = matches && fresh && Number.isInteger(external.rank) && external.rank > 0 ? external.rank : s.rank;
      return rank ? "#" + rank : null;
    })(), false, "rank"],
    ["FC", s.fc, false, "fc"], ["Ouro", s.gold, false, "gold"],
    ["Vida", s.hp, false, "hp"], ["Ataque", s.atk, false, "atk"], ["Defesa", s.def, false, "def"],
    ["Velocidade", s.spd, false, "spd"], ["Crítico", s.crit, false, "crit"], ["Dano crít.", s.critDmg, false, "critDmg"],
  ];
  const grid = mk("div", "grid");
  const hidden = new Set(Array.isArray(st.hiddenStats) ? st.hiddenStats : []);
  for (const [label, value, hl, key] of cells) {
    if (key !== "zone" && hidden.has(key)) continue;
    const cell = mk("div", "cell" + (hl ? " hl" : ""));
    cell.dataset.k = key;
    cell.append(mk("small", "", label), mk("b", value && String(value).length > 8 ? "long" : "", value || "—"));
    if (key !== "zone") {
      const btn = mk("button", "cell cell-toggle" + (hl ? " hl" : ""));
      btn.type = "button"; btn.dataset.k = key;
      btn.title = `${label}: ${value || "—"} — clique para ocultar`;
      btn.setAttribute("aria-label", `${label}: ${value || "—"}. Ocultar atributo`);
      btn.replaceChildren(...cell.childNodes);
      btn.addEventListener("click", () => setStatVisible(key, false));
      grid.append(btn);
    } else {
      if (value) cell.title = `${label}: ${value}`;
      grid.append(cell);
    }
  }
  main.append(grid);

  if (s.xp) {
    const [a, b] = s.xp.split("/").map((x) => parseInt(x.replace(/\D/g, ""), 10));
    const pct = a && b ? Math.min(100, Math.round((a / b) * 100)) : 0;
    const xp = mk("div", "xp");
    const bar = mk("div", "bar");
    const fill = document.createElement("i");
    fill.style.width = pct + "%";
    bar.append(fill);
    xp.append(mk("span", "", "XP"), bar, mk("span", "", `${s.xp} (${pct}%)`));
    main.append(xp);
  }
  hero.append(main);
  const firstFrame = frames ? frames[frameIdx % frames.length] : st.charImg;
  if (firstFrame) {
    const art = mk("div", "hero-art");
    const img = document.createElement("img");
    img.src = firstFrame;
    img.alt = "";
    art.append(img);
    hero.append(art);
  }
  box.append(hero);
  // Este pequeno painel mantém um modo de reexibir o que foi ocultado por clique.
  const toolsContainer = mk("div", "");
  renderStatOptions(toolsContainer, hidden);
  const tools = toolsContainer.firstElementChild;
  tools.open = statToolsOpen;
  tools.addEventListener("toggle", () => { statToolsOpen = tools.open; });
  box.append(tools);
  const equip = st.charEquipment;
  const all = Array.isArray(equip?.items) ? equip.items : [];
  const cls = String(s.cls || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const relevant = all.filter(i => !i.cls || cls === String(i.cls).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, ""));
  const group = mk("section", "equipment-block");
  const header = mk("div", "equipment-header");
  header.append(mk("span", "equipment-label", `EQUIPAMENTOS EM USO${relevant.length ? ` (${relevant.length})` : ""}`));
  const toggle = mk("button", "equipment-toggle", st.equipmentHidden ? "▸ Mostrar" : "▾ Ocultar");
  toggle.type = "button";
  toggle.setAttribute("aria-expanded", String(!st.equipmentHidden));
  toggle.addEventListener("click", () => chrome.storage.local.set({ equipmentHidden: !st.equipmentHidden }));
  header.append(toggle);
  group.append(header);
  if (!st.equipmentHidden) {
    if (relevant.length) {
      const grid = mk("div", "equipment-grid");
      const visuals = Array.isArray(st.charEquipmentIcons?.icons) ? st.charEquipmentIcons.icons : [];
      const normalize = s => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
      const iconFallbacks = {arma:"⚔",weapon:"⚔",helmet:"♜",elmo:"♜",armor:"🛡",armadura:"🛡",ring:"◉",anel:"◉",amulet:"✧",amuleto:"✧",shield:"🛡",escudo:"🛡"};
      relevant.slice(0, 16).forEach((item, idx) => {
        const id = `${item.cls||""}|${item.slot||""}|${item.name||""}|${item.level||""}`;
        const detail = mk("details", "equipment-item");
        detail.open = expandedEquipment.has(id);
        detail.addEventListener("toggle", () => { if(detail.open) expandedEquipment.add(id); else expandedEquipment.delete(id); });
        const summary = mk("summary", "equipment-main");
        const thumb = mk("span", "equipment-icon");
        const match = visuals.find(v => v.label && normalize(v.label).includes(normalize(item.name)) && normalize(item.name));
        const visual = match || (visuals.length === relevant.length ? visuals[idx] : null);
        const imageUrl = item.icon || visual?.icon || "";
        if (imageUrl) {
          const img = document.createElement("img");
          img.src = imageUrl; img.alt = ""; img.loading = "lazy"; img.referrerPolicy = "no-referrer";
          img.addEventListener("error", () => { img.remove(); thumb.textContent = "✦"; }, {once:true});
          thumb.append(img);
        } else {
          const key=normalize(item.slot);
          thumb.textContent = Object.entries(iconFallbacks).find(([k])=>key.includes(k))?.[1] || "✦";
        }
        const text = mk("span", "equipment-info");
        text.append(mk("span", "equipment-slot", item.slot || "Equipado"),
          mk("strong", "equipment-name", item.name));
        const info = [item.rarity, item.level ? `Nv ${item.level}` : ""].filter(Boolean).join(" · ");
        if (info) text.append(mk("span", "equipment-extra", info));
        const stats = Array.isArray(item.stats) ? item.stats.filter(x=>x&&x.label&&x.value).slice(0,10) : [];
        summary.title = stats.length ? stats.map(x=>`${x.label}: ${x.value}`).join(" | ") : item.name;
        summary.append(thumb,text,mk("span", "equipment-caret", "▸"));
        detail.append(summary);
        const list = mk("div", "equipment-stats");
        if (stats.length) {
          for (const v of stats) {
            const row = mk("div", "equipment-stat");
            row.append(mk("span", "", v.label),mk("b", "", v.value));
            list.append(row);
          }
        } else list.append(mk("span", "equipment-no-stats", "Sem bônus detalhados na resposta da API."));
        detail.append(list);
        grid.append(detail);
      });
      group.append(grid);
    } else {
      const note = !equip ? "Aguardando /api/me. Abra ou atualize seu personagem no RiftStream."
        : !equip.identified ? "A API respondeu, mas não reconheci o formato dos equipamentos."
        : "Nenhum equipamento identificado para esta classe.";
      group.append(mk("div", "equipment-note", note));
    }
  }
  box.append(group);
}

function renderMeta() {
  const st = cur;
  // Expira leituras de HP sem precisar que o usuário reabra o popup.
  if(st.charVitals && Date.now()-(Number(st.charVitals.at)||0)>=90_000) {
    document.querySelectorAll(".char-hp-now,.char-hp-meter").forEach(el=>el.remove());
    if (!st.char?.lifeState) {
      const life=document.querySelector(".char-life");
      if(life) {life.className="char-life unknown";life.textContent="○ Estado indisponível";
        life.title="A última leitura da API está desatualizada.";}
    }
  }
  const c = st.char;
  $("me").textContent = c && c.playingIn ? `Jogando em ${c.playingIn}` : "Fora de live";
  const fmtT = (s) => (s >= 60 ? `${Math.ceil(s / 60)} min` : `${s} s`);
  const now = Date.now();
  let next = "", next2 = "";
  if (st.enabled && st.autoScanMin > 0 && st.nextAutoScanAt) {
    // O tempo mostrado é o mesmo usado pelo monitor automático no background.
    // Quando a API está em backoff, o relógio acompanha esse intervalo maior.
    const due = Math.max(st.nextAutoScanAt, st.nextScanAt || 0);
    const a = Math.ceil((due - now) / 1000);
    if (a > 0) next = `Busca automática em ${fmtT(a)}`;
    else next = st.phase === "joining" ? "Consulta após entrar na live" : "Busca automática em breve";
  }
  if (!next) {
    const left = Math.ceil((st.nextScanAt - now) / 1000);
    if (st.enabled && st.phase === "idle" && left > 0) next = `Próxima busca em ${fmtT(left)}`;
  }
  if (c?.at) {
    const seconds = Math.max(0, Math.floor((now - Number(c.at)) / 1000));
    next2 = seconds <= 12 ? `Zona atualizada há ${seconds}s` : `Última leitura da zona há ${fmtT(seconds)}`;
  }
  let next3 = "";
  if (st.enabled && st.discoverEnabled && st.nextDiscoverAt && !st.discoverBusy) {
    const d = Math.ceil((st.nextDiscoverAt - now) / 1000);
    next3 = d > 0 ? `Ranking de lives em ${fmtT(d)}` : "Lendo o ranking em breve";
  } else if (st.discoverBusy) next3 = "Lendo o ranking de lives...";
  $("next").textContent = next;
  $("next2").textContent = next2;
  $("next3").textContent = next3;
}

// Quanto do fundo aparece: 0 = painéis opacos, 100 = fundo bem visível. Os números continuam legíveis.
function applyVeil(v) {
  const b = Math.min(100, Math.max(0, +v || 0)) / 100, r = document.documentElement.style;
  r.setProperty("--va", (0.85 * (1 - b) + 0.05).toFixed(2));
  r.setProperty("--pa", (0.85 - 0.5 * b).toFixed(2));
  r.setProperty("--ba", (0.9 - 0.6 * b).toFixed(2));
}

function render(st) {
  cur = st;
  if (document.activeElement !== $("bgVis")) { $("bgVis").value = st.bgVis; applyVeil(st.bgVis); }
  if (document.activeElement !== $("livesText")) $("livesText").value = st.livesText;
  nums.forEach((f) => { if (document.activeElement !== $(f)) $(f).value = st[f]; });
  checks.forEach((f) => ($(f).checked = !!st[f]));
  if (document.activeElement !== $("forgeMax")) $("forgeMax").value = st.forgeMax || "lendario";
  if (document.activeElement !== $("forgeMinChance")) $("forgeMinChance").value = st.forgeMinChance || 100;
  if (document.activeElement !== $("twitchClientId")) $("twitchClientId").value = st.twitchClientId || "";
  if (document.activeElement !== $("sendMethod")) $("sendMethod").value = st.sendMethod === "api" ? "api" : "chat";
  if (document.activeElement !== $("liveMode")) $("liveMode").value = ["allowed", "automatic"].includes(st.liveMode) ? st.liveMode : "manual";
  $("allowedCount").textContent = `${(st.allowedLives || []).length} ${(st.allowedLives || []).length === 1 ? "permitida" : "permitidas"}`;
  const hints = {
    manual: "A Jarvis procura a cada 2 minutos, mas só entra quando você clicar em Ir. Nenhuma entrada é automática.",
    allowed: "A Jarvis procura e entra sozinha SOMENTE nos canais marcados como Permitida. Nenhuma outra live será escolhida.",
    automatic: "A Jarvis procura e entra sozinha na melhor live ativa encontrada, sem precisar confirmar cada entrada."
  };
  const mode = ["allowed", "automatic"].includes(st.liveMode) ? st.liveMode : "manual";
  $("liveModeHint").textContent = hints[mode] + (mode === "allowed" && !(st.allowedLives || []).length ? " Marque pelo menos uma em Configurações → Lives." : "");
  $("apiSetup").hidden = st.sendMethod !== "api";
  $("autoFollow").disabled = st.sendMethod === "api";
  $("followWaitSec").disabled = st.sendMethod === "api";
  renderAuthStatus();
  frames = st.charFrames && st.charFrames.length > 1 ? st.charFrames : null;
  frameMs = st.charFrameMs || 90;
  $("enabled").checked = !!st.enabled;

  const ui = { ...DEFAULTS.ui, ...(st.ui || {}) };
  document.querySelectorAll("details[data-key]").forEach((d) => { if (d.open !== !!ui[d.dataset.key]) d.open = !!ui[d.dataset.key]; });

  const phaseTxt = { idle: "Monitorando", joining: "Entrando na live", joined: "Na live" };
  $("subtitle").textContent = st.enabled ? phaseTxt[st.phase] || "Monitorando" : "Desligado";
  $("status").textContent = st.status || (st.enabled ? "Iniciando..." : "Desligado.");

  const kind = !st.enabled ? "" : st.siteError || st.errStreak > 0 ? "err" : st.phase === "joining" ? "busy" : "ok";
  $("statusBox").className = "status " + kind;
  $("scanNow").disabled = !st.enabled || st.phase === "joining";
  $("discoverNow").disabled = !!st.discoverBusy || st.phase === "joining";
  $("discoverStatus").textContent = st.discoverStatus || "Descubra canais do ranking e filtre os que estiverem online com run ativa.";

  const totalSuccess = Math.max(0, Number(st.forgeTotal) || 0);
  const totalFailed = Math.max(0, Number(st.forgeLost) || 0);
  const count = totalSuccess + totalFailed;
  const sessionStart = Number.isFinite(Number(st.forgeRunBaseTotal)) && st.forgeRunBaseTotal !== null
    ? Math.max(0, Number(st.forgeRunBaseTotal)) : count;
  const sessionCount = Math.max(0, count - sessionStart);
  const limit = Math.max(0, Number(st.forgePauseAfter) || 0);
  $("forgeStatus").textContent = st.forgePaused ? (st.forgeStatus || "Forja pausada. Retome quando quiser.") :
    st.forgeEnabled ? (st.forgeStatus || "Aguardando a janela da forja...") : "Desativado.";
  $("forgeStatus").className = "note" + (st.forgePaused ? " is-paused" : /erro|incerto|interrompid|parei|falh/i.test(st.forgeStatus || "") ? " is-error" : "");
  $("forgeCount").textContent = totalSuccess || totalFailed ? `(${totalSuccess} concluídas, ${totalFailed} falhas)` : "";
  $("forgeSuccessCount").textContent = totalSuccess.toLocaleString("pt-BR");
  $("forgeFailCount").textContent = totalFailed.toLocaleString("pt-BR");
  $("forgeSessionCount").textContent = sessionCount.toLocaleString("pt-BR");
  $("forgePauseButton").textContent = st.forgePaused ? "▶ Retomar forja" : "⏸ Pausar forja";
  $("forgePauseButton").disabled = !st.forgeEnabled;
  $("forgeLimitBar").hidden = !limit;
  $("forgeLimitFill").style.width = limit ? (Math.min(100, sessionCount / limit * 100) + "%") : "0%";
  $("forgeLimitText").textContent = !st.forgeEnabled ? "Forja desligada" : st.forgePaused ? "Pausada · nenhuma nova tentativa será iniciada" :
    limit ? `${Math.min(sessionCount, limit)} de ${limit} tentativas nesta sessão` : "Sem limite de tentativas · pausa manual disponível";
  const quick = $("quickState");
  quick.replaceChildren();
  const pill = (label, cls = "") => quick.append(mk("span", "quick-pill " + cls, label));
  pill(st.enabled ? (mode === "manual" ? "◎ Manual" : mode === "allowed" ? "✓ Só permitidas" : "↻ Automático") : "○ Jarvis desligada", st.enabled ? "ok" : "");
  pill(st.muteLives !== false ? "🔇 Lives silenciosas" : "🔊 Som habilitado", st.muteLives !== false ? "ok" : "warn");
  pill(!st.forgeEnabled ? "⚒ Forja desligada" : st.forgePaused ? "⏸ Forja pausada" : st.forgeDry !== false ? "⚒ Forja: teste" : "⚒ Forja ativa", st.forgePaused ? "warn" : "");

  const suggestion = st.suggestedLive;
  const box = $("suggestionBox");
  box.hidden = !st.enabled || (st.liveMode || "manual") !== "manual" || !suggestion || st.phase === "joining";
  if (!box.hidden) $("suggestionText").textContent = `${suggestion.login} • Zona ${suggestion.zone}-${suggestion.wave} • Clique para autorizar a entrada.`;
  renderMine(st);
  renderLives(st);
  renderMonitor(st);
  renderMeta();
}

async function load() { render({ ...DEFAULTS, ...(await chrome.storage.local.get(null)) }); }

async function save() {
  const v = { livesText: $("livesText").value };
  v.lives = [...new Set([...parseLives(v.livesText), ...(cur.discoveredLives || []), ...(cur.allowedLives || [])])];
  nums.forEach((f) => (v[f] = Math.max(0, parseInt($(f).value, 10) || 0)));
  v.scanGapSec = Math.max(30, v.scanGapSec);
  v.autoScanMin = v.autoScanMin ? Math.max(2, v.autoScanMin) : 0;   // mín. 2 min para não martelar a API
  v.discoverMin = Math.max(2, v.discoverMin || 30);                // mín. 2 min: consulta a API sem abrir aba
  v.discoverTop = Math.min(50, Math.max(1, v.discoverTop || 20));
  v.followWaitSec = Math.max(0, Math.min(180, v.followWaitSec));
  v.forgePauseAfter = Math.max(0, Math.min(10000, v.forgePauseAfter));
  v.rejoinMin = 0; // nunca reenvia automaticamente na mesma live
  // Alterar a frequência reinicia o contador, sem disparar uma consulta antes da hora.
  const old = await chrome.storage.local.get(["autoScanMin", "enabled", "discoverMin", "liveMode", "phase", "forgeEnabled", "forgePauseAfter", "forgeTotal", "forgeLost"]);
  v.liveMode = ["manual", "allowed", "automatic"].includes($("liveMode").value) ? $("liveMode").value : "manual";
  if (v.liveMode !== (old.liveMode || "manual")) {
    v.suggestedLive = null;
    v.nextScanAt = 0;
    v.nextAutoScanAt = old.enabled && v.autoScanMin > 0 ? Date.now() : 0;
    if (old.phase === "joining") {
      v.phase = "idle"; // mudar modo revoga uma entrada em andamento
      v.current = null;
    }
    v.status = v.liveMode === "manual" ? "Modo manual ativado; aguardando sua autorização." :
      v.liveMode === "allowed" ? "Modo somente permitidas ativado. Aguardando canais autorizados." :
      "Modo automático ativado. Buscando a melhor live disponível.";
  }
  if (v.autoScanMin !== (Number(old.autoScanMin) || 0)) {
    v.nextAutoScanAt = old.enabled && v.autoScanMin > 0 ? Date.now() + v.autoScanMin * 60000 : 0;
  }
  checks.forEach((f) => (v[f] = $(f).checked));
  if (v.discoverEnabled && !cur.discoverEnabled) v.nextDiscoverAt = Date.now();
  else if (v.discoverMin !== (Number(old.discoverMin) || 30)) v.nextDiscoverAt = Date.now() + v.discoverMin * 60000;   // mudou o intervalo: reinicia o relógio
  if (!v.discoverEnabled) v.nextDiscoverAt = 0;
  v.sendMethod = $("sendMethod").value === "api" ? "api" : "chat";
  v.twitchClientId = $("twitchClientId").value.trim().toLowerCase();
  v.forgeMax = $("forgeMax").value;
  v.forgeMinChance = Math.min(100, Math.max(1, parseInt($("forgeMinChance").value, 10) || 100));
  // Um novo lote inicia ao ligar a forja ou alterar o limite escolhido.
  if ((v.forgeEnabled && !old.forgeEnabled) || v.forgePauseAfter !== (Number(old.forgePauseAfter) || 0)) {
    v.forgeRunBaseTotal = (Number(old.forgeTotal) || 0) + (Number(old.forgeLost) || 0);
    v.forgePaused = false;
  }
  await chrome.storage.local.set(v);
  chrome.runtime.sendMessage({ type: "apply" });
}

["liveMode", "livesText", "forgeMax", "forgeMinChance", "sendMethod", "twitchClientId", ...nums, ...checks].forEach((f) => $(f).addEventListener("change", save));

function renderAuthStatus(message = "") {
  const status = $("twitchStatus");
  if (message) status.textContent = message;
  else status.textContent = authInfo.connected
    ? `Conectado como ${authInfo.login || "conta Twitch"} (permissão para enviar $jogar).`
    : "Não conectado. O modo Chat continua disponível.";
  $("twitchDisconnect").disabled = !authInfo.connected;
  $("twitchRedirect").textContent = authInfo.redirect || "Carregando URL...";
}
async function refreshAuthStatus() {
  try {
    authInfo = await chrome.runtime.sendMessage({ type: "twitchAuthStatus" }) || { connected: false };
  } catch (e) { authInfo = { connected: false, error: String(e.message || e) }; }
  renderAuthStatus(authInfo.error ? `Erro: ${authInfo.error}` : "");
}
$("twitchConnect").addEventListener("click", async () => {
  await save();
  $("twitchConnect").disabled = true;
  renderAuthStatus("Abrindo autorização oficial da Twitch...");
  try {
    const result = await chrome.runtime.sendMessage({ type: "twitchConnect" });
    if (result?.error) renderAuthStatus(`Não foi possível conectar: ${result.error}`);
    else await refreshAuthStatus();
  } catch (e) { renderAuthStatus(`Erro: ${String(e.message || e)}`); }
  finally { $("twitchConnect").disabled = false; }
});
$("twitchDisconnect").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "twitchDisconnect" });
  await refreshAuthStatus();
});

// Menu flutuante dos atributos: fecha ao clicar fora ou pressionar Esc.
document.addEventListener("pointerdown", (event) => {
  const tools = document.querySelector("details.stat-tools[open]");
  if (tools && !tools.contains(event.target)) { tools.open = false; statToolsOpen = false; }
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    const tools = document.querySelector("details.stat-tools[open]");
    if (tools) { tools.open = false; statToolsOpen = false; tools.querySelector("summary")?.focus(); }
  }
});

// Lembra quais seções você deixou abertas ou recolhidas.
document.querySelectorAll("details[data-key]").forEach((d) => d.addEventListener("toggle", async () => {
  const k = d.dataset.key;
  const ui = { ...DEFAULTS.ui, ...(cur.ui || {}) };
  if (ui[k] === d.open) return;
  await chrome.storage.local.set({ ui: { ...ui, [k]: d.open } });
}));

$("enabled").addEventListener("change", async () => {
  await save();
  const on = $("enabled").checked;
  const { autoScanMin = 0 } = await chrome.storage.local.get("autoScanMin");
  await chrome.storage.local.set({
    enabled: on, phase: "idle", suggestedLive: null, nextScanAt: 0, errStreak: 0, siteError: false,
    nextAutoScanAt: on && autoScanMin > 0 ? Date.now() + autoScanMin * 60000 : 0,
    status: on ? "Iniciando..." : "Desligado.",
  });
  if (on) chrome.runtime.sendMessage({ type: "apply" });
});

$("forgePauseButton").addEventListener("click", async () => {
  const st = await chrome.storage.local.get(["forgeEnabled", "forgePaused", "forgeTotal", "forgeLost"]);
  if (!st.forgeEnabled) return;
  const resuming = !!st.forgePaused;
  await chrome.storage.local.set({
    forgePaused: !resuming,
    // Retomar conta como nova sessão, evitando re-pauses imediatos após atingir o limite.
    ...(resuming ? {forgeRunBaseTotal:(Number(st.forgeTotal)||0)+(Number(st.forgeLost)||0),forgeStatus:"Retomando forja com as opções atuais..."} :
      {forgeStatus:"Forja pausada manualmente. Se houver uma tentativa em andamento, ela será concluída antes da pausa."})
  });
});
$("forgeResetCount").addEventListener("click", async () => {
  if (!window.confirm("Zerar os contadores da forja? Isso não desfaz as forjas já realizadas.")) return;
  await chrome.storage.local.set({forgeTotal:0,forgeLost:0,forgeRunBaseTotal:0});
});

$("discoverNow").addEventListener("click", async () => {
  await save();
  chrome.runtime.sendMessage({ type: "discoverLives" });
});

$("approveLive").addEventListener("click", () => {
  if (cur.suggestedLive?.login) chrome.runtime.sendMessage({ type: "approveLive", login: cur.suggestedLive.login });
});
$("dismissLive").addEventListener("click", () => chrome.runtime.sendMessage({ type: "dismissLive" }));

$("scanNow").addEventListener("click", async () => {
  await save();
  const st = await chrome.storage.local.get("enabled");
  if (!st.enabled) { await chrome.storage.local.set({ status: "Ligue a extensão primeiro." }); return; }
  chrome.runtime.sendMessage({ type: "scanNow" });
});

async function toggleAllowedLive(login) {
  if (!/^[a-z0-9_]{2,25}$/.test(login)) return;
  const st = await chrome.storage.local.get(["allowedLives", "lives", "liveMode", "enabled"]);
  const allowed = new Set(Array.isArray(st.allowedLives) ? st.allowedLives : []);
  if (allowed.has(login)) allowed.delete(login); else allowed.add(login);
  const update = { allowedLives: [...allowed], lives: [...new Set([...(st.lives || []), login])] };
  if (st.liveMode === "allowed" && st.enabled) {
    update.nextScanAt = 0;
    update.nextAutoScanAt = Date.now();
  }
  await chrome.storage.local.set(update);
  if (st.enabled && st.liveMode === "allowed") chrome.runtime.sendMessage({ type: "scanNow" });
}

async function toggleLive(login, on) {
  const { disabled = [] } = await chrome.storage.local.get("disabled");
  const set = new Set(disabled);
  if (on) set.delete(login); else set.add(login);
  await chrome.storage.local.set({ disabled: [...set] });
  chrome.runtime.sendMessage({ type: "apply" });
}

// Anima o personagem trocando os quadros capturados da página.
function animate() {
  clearTimeout(frameTimer);
  const tick = () => {
    const img = document.querySelector(".hero-art img");
    if (img && frames) { frameIdx = (frameIdx + 1) % frames.length; img.src = frames[frameIdx]; }
    frameTimer = setTimeout(tick, frameMs);
  };
  frameTimer = setTimeout(tick, frameMs);
}

$("bgVis").addEventListener("input", () => applyVeil($("bgVis").value));
$("bgVis").addEventListener("change", () => chrome.storage.local.set({ bgVis: +$("bgVis").value }));

chrome.storage.onChanged.addListener(load);
setInterval(() => { renderMeta(); renderMonitor(cur); }, 1000);
load();
refreshAuthStatus();
animate();
