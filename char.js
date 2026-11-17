// Roda na página do RiftStream e lê "JOGANDO EM <live>", "ZONA x-y" e os status do seu personagem.
(() => {
  // O script em mundo MAIN observa a resposta /api/me já recebida pelo site.
  // Este listener encaminha SOMENTE nomes/metadados de itens, nunca o JSON bruto.
  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== location.origin ||
        event.data?.source !== "JARVIS_EQUIPMENT_FROM_ME_V1" ||
        !location.pathname.startsWith("/character")) return;
    const entries = Array.isArray(event.data.items) ? event.data.items.slice(0, 24) : [];
    const safe = (s, max) => typeof s === "string" ? s.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, max) : "";
    const safeIcon = (s) => typeof s === "string" && (
      (/^data:image\/(?:png|webp|gif|jpeg);base64,[a-z0-9+/=]+$/i.test(s) && s.length < 70000) ||
      (s.length < 400 && /^https:\/\//i.test(s) && (() => {
        try { const u = new URL(s); return u.hostname === "z6ywq6r3ub.execute-api.us-east-1.amazonaws.com" ||
          /(^|\.)riftstream\.com\.br$/i.test(u.hostname); } catch (_) {return false;}
      })())
    ) ? s : "";
    const items = entries.filter((i) => i && typeof i === "object" && typeof i.name === "string").map((i) => ({
      slot: safe(i.slot, 28), name: safe(i.name, 75), rarity: safe(i.rarity, 25),
      level: safe(i.level, 10), cls: safe(i.cls, 20), icon: safeIcon(i.icon),
      stats: (Array.isArray(i.stats) ? i.stats : []).slice(0, 10).filter(v => v && typeof v === "object")
        .map(v => ({label:safe(v.label,38),value:safe(v.value,40)})).filter(v=>v.label&&v.value)
    }));
    chrome.runtime.sendMessage({ type:"charEquipment", items, identified: event.data.identified === true }).catch(() => {});
  });
  // Estado e HP são capturados apenas quando a API fornecer campos explícitos.
  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== location.origin ||
        event.data?.source !== "JARVIS_VITALS_FROM_ME_V1" ||
        !location.pathname.startsWith("/character")) return;
    const {state,currentHp,maxHp} = event.data;
    const validNumber = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1e12 ? v : null;
    chrome.runtime.sendMessage({
      type:"charVitals",
      state:state === "alive" || state === "dead" ? state : null,
      currentHp:validNumber(currentHp), maxHp:validNumber(maxHp)
    }).catch(()=>{});
  });
  window.postMessage({source:"JARVIS_EQUIPMENT_REQUEST_V1"}, location.origin);

  // Segundo caminho para ícones: reaproveita o desenho já mostrado na área EQUIPADO.
  // Se a API não incluir URLs das imagens, capta imagens/canvas pequenos da própria página.
  let lastIconSignature="",lastIconAttempt=0;
  function captureEquippedIcons() {
    if (Date.now()-lastIconAttempt < 15000) return;
    lastIconAttempt=Date.now();
    const heading=[...document.querySelectorAll("h1,h2,h3,h4,h5,h6,div,span,strong,b,small")]
      .find(el=>el.children.length===0 && /^equipados?$/i.test((el.textContent||"").trim()));
    if(!heading)return;
    let root=heading.parentElement, images=[];
    for(let hop=0;root&&hop<4;hop++,root=root.parentElement){
      images=[...root.querySelectorAll("img,canvas,svg")].filter(el=>{
        const r=el.getBoundingClientRect();
        return r.width>=24&&r.width<=88&&r.height>=24&&r.height<=88;
      });
      if(images.length>=2&&images.length<=8)break;
      images=[];
    }
    if(!images.length)return;
    function snapshot(el){
      try {
        const width=el.tagName==="IMG"?el.naturalWidth:el.width?.baseVal?.value||el.width;
        const height=el.tagName==="IMG"?el.naturalHeight:el.height?.baseVal?.value||el.height;
        if(!width||!height)return "";
        const canvas=document.createElement("canvas"); canvas.width=48;canvas.height=48;
        const ctx=canvas.getContext("2d"); ctx.imageSmoothingEnabled=false;
        ctx.drawImage(el,0,0,48,48);
        const data=canvas.toDataURL("image/png");
        return data.length<70000?data:"";
      }catch(_){return "";}
    }
    const icons=images.slice(0,8).map(el=>({
      icon:snapshot(el),
      label:(el.closest("[title],[aria-label]")?.getAttribute("title") ||
        el.closest("[title],[aria-label]")?.getAttribute("aria-label") || el.getAttribute("alt") || "").slice(0,80)
    })).filter(i=>i.icon);
    if(!icons.length)return;
    const signature=icons.map(i=>i.icon.slice(0,60)+i.icon.length).join("|");
    if(signature===lastIconSignature)return;
    lastIconSignature=signature;
    chrome.runtime.sendMessage({type:"charEquipmentIcons",icons}).catch(()=>{});
  }
  setTimeout(captureEquippedIcons, 6500);
  setInterval(captureEquippedIcons, 30000);

  const leaf = (re) => {
    for (const el of document.querySelectorAll("span,div,a,p,li,b,strong,button,small")) {
      if (el.children.length) continue;
      const m = (el.textContent || "").trim().match(re);
      if (m) return m;
    }
    return null;
  };
  const siteFailed = () => /n[ãa]o foi poss[íi]vel carregar/i.test(document.body.innerText || "");
  const numOf = (s) => parseFloat(String(s).replace(/,/g, "")) || 0;

  // 1) Rótulo e valor em elementos vizinhos (ex.: <span>DEFESA</span><b>6358.6</b>).
  function labeled(labelRe) {
    for (const el of document.querySelectorAll("span,div,p,small,label,dt,b,strong")) {
      if (el.children.length || !labelRe.test((el.textContent || "").trim())) continue;
      const sib = el.nextElementSibling;
      const v = sib && (sib.textContent || "").trim();
      if (v && /^[\d.,]+%?$/.test(v)) return v;
    }
    return null;
  }

  function readStats() {
    const t = (document.body.innerText || "").normalize("NFC");
    const first = (re) => { const m = t.match(re); return m ? m[1].replace(/\s+/g, " ").trim() : null; };
    // Se o rótulo aparece em mais de um lugar (ex.: lista de upgrades), fica com o MAIOR valor: é o do card de atributos.
    const largest = (re) => {
      let best = null;
      for (const m of t.matchAll(new RegExp(re.source, "gi"))) if (!best || numOf(m[1]) > numOf(best)) best = m[1];
      return best;
    };
    const attr = (labelRe, textRe) => labeled(labelRe) || largest(textRe);

    const lv = t.match(/(GUERREIRO|CL[ÉE]RIGO|ARQUEIRO)\s+N[ÍI]VEL\s*:?\s*(\d+)/i);
    // Nível: procura no cabeçalho do personagem (perto do nome) em vários formatos, depois na página.
    const hh = document.querySelector("h1");
    const scope = hh && hh.parentElement ? ((hh.parentElement.parentElement || hh.parentElement).innerText || "").normalize("NFC") : "";
    const lvPats = [/N[ÍI]VEL\s*:?\s*(\d{1,4})\b/i, /\b(?:NV|LVL?)\.?\s*:?\s*(\d{1,4})\b/i, /\b(\d{1,4})\s*N[ÍI]VEL\b/i];
    let level = lv ? lv[2] : null;
    for (const src of [scope, t]) {
      if (level) break;
      for (const re of lvPats) { const m = src.match(re); if (m) { level = m[1]; break; } if (src === t) break; }
    }
    if (!level) level = labeled(/^n[íi]vel$/i);
    const h = document.querySelector("h1");
    const name = h && h.firstChild ? (h.firstChild.textContent || "").trim() : "";
    return {
      name: name || null,
      cls: lv ? lv[1].toLowerCase() : null,
      level,
      // Ex.: "#1.234 no ranking", "Ranking #1234" ou "Posição 1234".
      rank: (() => {
        const txt = first(/#\s*([\d.,]+)\s+NO\s+RANKING/i) ||
          first(/\bRANKING\s*(?:GERAL)?\s*[:#º°-]?\s*#?\s*([\d.,]+)/i) ||
          first(/\bPOSI[ÇC][ÃA]O\s*(?:NO\s+RANKING)?\s*[:#º°-]?\s*#?\s*([\d.,]+)/i);
        const number = txt ? Number(txt.replace(/[.,\s]/g, "")) : null;
        return Number.isSafeInteger(number) && number > 0 ? number : null;
      })(),
      hp: attr(/^vida$/i, /\bVIDA\s+([\d.,]+)/),
      atk: attr(/^ataque$/i, /\bATAQUE\s+([\d.,]+)/),
      def: attr(/^defesa$/i, /\bDEFESA\s+([\d.,]+)/),
      spd: attr(/^vel\.?$/i, /\bVEL\.?\s+([\d.,]+)/),
      crit: attr(/^cr[íi]t\.?$/i, /(?<!DANO )\bCR[ÍI]T\.?\s+([\d.,]+%?)/),
      critDmg: attr(/^dano cr[íi]t\.?$/i, /DANO CR[ÍI]T\.?\s+([\d.,]+%)/),
      best: first(/MAIOR ZONA\s+(\d+\s*-\s*\d+)/i),
      fc: first(/\bFC\s+([\d.,]+)/i),
      gold: first(/\bOURO\s+([\d.,]+)/i),
      xp: first(/([\d.]+\s*\/\s*[\d.]+)\s*XP/i),
    };
  }

  // O RiftStream também desenha VIVO/MORTO no cabeçalho do personagem.
  // Procura apenas perto do h1 do personagem para não confundir com outras lives.
  function readLifeFromHeader() {
    const nameHeading = document.querySelector("h1");
    if (!nameHeading) return null;
    let scope = nameHeading.parentElement;
    for (let hop=0;scope&&hop<3;hop++,scope=scope.parentElement) {
      if (scope===document.body || (scope.innerText||"").length>5000) break;
      const labels=[...scope.querySelectorAll("span,small,strong,b,em,div")]
        .filter(e=>!e.children.length)
        .map(e=>(e.textContent||"").trim().toUpperCase());
      if (labels.includes("MORTO")) return "dead";
      if (labels.includes("VIVO")) return "alive";
    }
    return null;
  }

  let cachedStats = null, statsAt = 0;
  function read() {
    let z = leaf(/^zona\s+(\d+)\s*-\s*(\d+)$/i);
    let p = leaf(/^jogando em\s+(.+)$/i);
    if (!z) z = (document.body.innerText || "").match(/\bzona\s+(\d+)\s*-\s*(\d+)\b/i);
    if (!p) p = (document.body.innerText || "").match(/jogando em\s+([A-Za-z0-9_]+)/i);
    return {
      zone: z ? +z[1] : null,
      wave: z ? +z[2] : null,
      playingIn: p ? p[1].trim().toLowerCase() : null,
      lifeState: readLifeFromHeader(),
      // Evita reprocessar todo o perfil a cada alteração de texto (zona/onda).
      stats: (() => {
        if (!cachedStats || Date.now() - statsAt >= 12000) {
          cachedStats = readStats(); statsAt = Date.now();
        }
        return cachedStats;
      })(),
    };
  }
  // Desenho do seu personagem (maior canvas/img da própria página) para mostrar no popup.
  function findSprite() {
    let best = null, area = 0;
    for (const el of document.querySelectorAll("canvas, img")) {
      const r = el.getBoundingClientRect();
      if (r.width < 80 || r.height < 80) continue;
      if (el.tagName === "IMG" && /jtvnw|kick\.com|profile_image|favicon/i.test(el.currentSrc || el.src)) continue;
      if (r.width * r.height > area) { area = r.width * r.height; best = el; }
    }
    return best;
  }
  // Copia o desenho para um canvas pequeno e devolve um PNG. Imagem de outra origem não é lida (retorna null).
  function snap(el, max) {
    const w = el.tagName === "CANVAS" ? el.width : el.naturalWidth;
    const h = el.tagName === "CANVAS" ? el.height : el.naturalHeight;
    if (!w || !h) return null;
    const k = Math.min(1, max / Math.max(w, h));
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(w * k));
    c.height = Math.max(1, Math.round(h * k));
    const ctx = c.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    try {
      ctx.drawImage(el, 0, 0, c.width, c.height);
      return c.toDataURL("image/png");
    } catch (e) { return null; }
  }
  let lastSpriteAt = 0, lastSprite = null;
  function sendSprite() {
    if (lastSprite && Date.now() - lastSpriteAt < 60000) return;   // depois de capturado, no máx. 1x por minuto
    lastSpriteAt = Date.now();
    const el = findSprite();
    const data = el && snap(el, 220);
    if (!data || data === lastSprite || data.length > 600000) return;
    lastSprite = data;
    chrome.runtime.sendMessage({ type: "charImg", data }).catch(() => {});
  }

  // Várias capturas seguidas para o popup animar o personagem.
  async function sendFrames() {
    if (!location.pathname.startsWith("/character")) return;
    const el = findSprite();
    if (!el) return;
    const frames = [];
    for (let i = 0; i < 20; i++) {
      const f = snap(el, 220);
      if (!f) return;
      frames.push(f);
      await new Promise((r) => setTimeout(r, 90));
    }
    const list = new Set(frames).size === 1 ? [frames[0]] : frames;
    chrome.runtime.sendMessage({ type: "charFrames", frames: list, interval: 90 }).catch(() => {});
  }

  let lastReportAt = 0, lastSignature = "", lastSpriteCheck = 0;
  function report() {
    if (!location.pathname.startsWith("/character")) return;
    const now = Date.now();
    const msg = siteFailed() ? { type: "char", error: true } : { type: "char", ...read() };
    const signature = msg.error ? "erro" :
      [msg.zone,msg.wave,msg.playingIn,msg.lifeState,msg.stats?.name,msg.stats?.fc].join("|");
    // Mudou a zona, a onda ou o canal? Publica imediatamente. Caso contrário,
    // envia um heartbeat a cada 8s para identificar leitura desatualizada.
    if (signature !== lastSignature || now - lastReportAt > 8000) {
      lastSignature = signature; lastReportAt = now;
      chrome.runtime.sendMessage(msg).catch(() => {});
    }
    if (!msg.error && now - lastSpriteCheck > 12000) {
      lastSpriteCheck = now;
      sendSprite();
    }
  }
  // Dados mudando no DOM são percebidos sem aguardar o polling ou reload.
  // Limitamos a leitura para não sobrecarregar a página durante as animações.
  let observerTimer = null, lastObserverRead = 0;
  const observer = new MutationObserver(() => {
    if (observerTimer || Date.now() - lastObserverRead < 1500) return;
    observerTimer = setTimeout(() => {
      observerTimer = null; lastObserverRead = Date.now(); report();
    }, 300);
  });
  if (document.documentElement) observer.observe(document.documentElement,
    {subtree:true,childList:true,characterData:true});
  setTimeout(sendFrames, 5000);
  setInterval(sendFrames, 3 * 60 * 1000);
  setTimeout(report, 1200);
  setInterval(report, 2500);
})();
