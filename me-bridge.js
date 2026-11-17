// Observa APENAS o GET /api/me recebido pela própria página do RiftStream.
// Encaminha à extensão somente metadados de itens equipados: nome, imagem e bônus.
// Nunca copia cookies, tokens, IDs de sessão nem o JSON completo.
(() => {
  "use strict";
  const API_HOST = "z6ywq6r3ub.execute-api.us-east-1.amazonaws.com";
  const SIGNAL = "JARVIS_EQUIPMENT_FROM_ME_V1";
  let lastPacket = null;
  let lastVitalsPacket = null;
  const VITALS_SIGNAL = "JARVIS_VITALS_FROM_ME_V1";

  // Leitura conservadora: estado somente se o retorno da conta trouxer um campo
  // explícito; HP atual somente com um campo de HP atual (não confundir com Vida base).
  function extractVitals(root) {
    const object = (x) => x && typeof x === "object" && !Array.isArray(x);
    const get = (o, keys) => {
      if (!object(o)) return null;
      for (const key of keys) if (Object.prototype.hasOwnProperty.call(o, key) && o[key] != null) return o[key];
      return null;
    };
    const number = (value) => {
      if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : null;
      if (typeof value !== "string") return null;
      let s = value.trim();
      if (!/^[\d., ]{1,22}$/.test(s)) return null;
      s = s.replace(/ /g, "");
      if (/^\d{1,3}(?:\.\d{3})+$/.test(s)) s = s.replace(/\./g, "");
      else if (/^\d{1,3}(?:,\d{3})+$/.test(s)) s = s.replace(/,/g, "");
      else if (s.includes(",") && s.includes(".")) s = s.lastIndexOf(",") > s.lastIndexOf(".")
        ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
      else s = s.replace(",", ".");
      const n = Number(s);
      return Number.isFinite(n) && n >= 0 ? n : null;
    };
    const normalClass = (s) => {
      const t = String(s || "").trim().normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
      if (["warrior","guerreiro"].includes(t)) return "warrior";
      if (["archer","arqueiro"].includes(t)) return "archer";
      if (["cleric","clerigo","priest"].includes(t)) return "cleric";
      return "";
    };
    const isClass = (s) => !!normalClass(s);
    const activeClass = normalClass(get(root,["activeClass","selectedClass","currentClass","playingClass","classeAtiva","active_class"]) ||
      get(root?.me,["activeClass","selectedClass","currentClass"]) || get(root?.player,["activeClass","selectedClass","currentClass"]));
    function stateFrom(o) {
      const dead = get(o,["isDead","dead","is_dead","morto","estaMorto"]);
      if (typeof dead === "boolean") return dead ? "dead" : "alive";
      const alive = get(o,["isAlive","alive","is_alive","vivo","estaVivo"]);
      if (typeof alive === "boolean") return alive ? "alive" : "dead";
      const st = get(o,["lifeStatus","life_status","combatStatus","battleStatus","status","estado"]);
      if (typeof st !== "string") return null;
      const normalized = st.trim().toLowerCase();
      if (["alive","living","vivo","viva","active","em_combate"].includes(normalized)) return "alive";
      if (["dead","death","morto","morta","died","dead_character"].includes(normalized)) return "dead";
      return null;
    }
    function readNode(node) {
      if (!object(node)) return null;
      const scopes = [node, ...["vitals","combat","combatState","battle","battleState","life","healthState","statusInfo","runtime"].map(k=>node[k]).filter(object)];
      let state=null, currentHp=null, maxHp=null;
      for (const o of scopes) {
        if (state == null) state=stateFrom(o);
        if (currentHp == null) currentHp=number(get(o,["currentHp","currentHP","hpCurrent","currentHealth","healthCurrent","currentLife","hpAtual","vidaAtual","vida_atual","hp_now","hpNow","health_now"]));
        if (maxHp == null) maxHp=number(get(o,["maxHp","maxHP","hpMax","maxHealth","healthMax","maximumHp","maximumHealth","totalHp","maxLife","vidaMaxima","vida_maxima"]));
        // hp/health sozinhos podem ser o atributo Vida do personagem. Só assumir que
        // são HP corrente quando vierem com um máximo explícito no mesmo objeto.
        if (currentHp == null) {
          const withMax=number(get(o,["maxHp","maxHP","hpMax","maxHealth","healthMax","maximumHp","totalHp","vidaMaxima"]));
          if (withMax !== null) currentHp=number(get(o,["hp","health"]));
        }
      }
      if (state === null && currentHp === null) return null;
      if (currentHp !== null && maxHp !== null && maxHp > 0 && currentHp > maxHp) currentHp=null;
      if (state === null && currentHp !== null && maxHp !== null && maxHp > 0)
        state = currentHp <= 0 ? "dead" : "alive";
      return {state, currentHp, maxHp};
    }
    // Prioriza o personagem selecionado. Não lê arbitrariamente qualquer vida de
    // uma lista de classes ou de personagens de outras lives.
    const candidates=[];
    const add=(node,score,cls="")=>{
      if (!object(node)) return;
      const c=normalClass(cls || get(node,["class","classe","className","characterClass","character_class"]));
      if (activeClass && c && c!==activeClass) return;
      candidates.push({node,score:score+(c&&activeClass&&c===activeClass?15:0)});
    };
    add(root,50);
    for (const key of ["activeCharacter","selectedCharacter","currentCharacter","activeHero","myCharacter"]) add(root?.[key],100);
    for (const key of ["character","hero","player","me"]) add(root?.[key],60);
    for (const groupKey of ["characters","heroes","classes"]) {
      const group=root?.[groupKey];
      if (Array.isArray(group)) {
        for (const entry of group.slice(0,8)) {
          const c=normalClass(get(entry,["class","classe","className","characterClass"]));
          if (entry?.active===true || entry?.selected===true || entry?.isActive===true) add(entry,95,c);
          else if (activeClass && c===activeClass) add(entry,85,c);
        }
      } else if (object(group)) {
        for (const [name, entry] of Object.entries(group).slice(0,8)) {
          const c=normalClass(name);
          if (entry?.active===true || entry?.selected===true || entry?.isActive===true) add(entry,95,c);
          else if (activeClass && c===activeClass) add(entry,85,c);
          // Se o retorno trouxer exatamente uma classe, ela pode ser a ativa.
          else if (!activeClass && isClass(name) && Object.keys(group).filter(isClass).length===1) add(entry,65,c);
        }
      }
    }
    const evaluated = candidates.map(({node,score}) => {
      const v=readNode(node);
      return v ? {...v,score} : null;
    }).filter(Boolean);
    if (!evaluated.length) return {state:null,currentHp:null,maxHp:null};
    evaluated.sort((a,b)=>b.score-a.score);
    const best=evaluated[0];
    if (evaluated.length>1 && evaluated[1].score===best.score &&
       (evaluated[1].state!==best.state || evaluated[1].currentHp!==best.currentHp))
      return {state:null,currentHp:null,maxHp:null};
    return {state:best.state,currentHp:best.currentHp,maxHp:best.maxHp};
  }


  const isMe = (url) => {
    try {
      const u = new URL(typeof url === "string" ? url : url?.url, location.href);
      return u.hostname === API_HOST && u.pathname.replace(/\/+$/, "") === "/api/me";
    } catch (_) { return false; }
  };
  const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
  const str = (v, n=70) => typeof v === "string" ? v.replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0,n) :
    typeof v === "number" && Number.isFinite(v) ? String(v).slice(0,n) : "";
  const pick = (o, keys) => {
    for (const k of keys) if (o && o[k] !== undefined && o[k] !== null && o[k] !== "") return o[k];
    return null;
  };
  const clsName = (v) => {
    const s = str(v,30).toLowerCase();
    if (/^(?:warrior|guerreiro)$/.test(s)) return "guerreiro";
    if (/^(?:archer|arqueiro)$/.test(s)) return "arqueiro";
    if (/^(?:cleric|cl[eé]rigo|priest)$/.test(s)) return "clérigo";
    return "";
  };
  const IMG_KEYS = ["iconUrl", "iconURL", "icon_url", "imageUrl", "imageURL", "image_url",
    "spriteUrl", "spriteURL", "sprite_url", "iconSrc", "imgSrc", "icon", "image", "sprite", "thumbnail", "art"];
  function safeImage(v) {
    if (isObj(v)) v = pick(v, ["url", "src", "href", "png", "data", "imageUrl", "image_url"]);
    if (typeof v !== "string") return "";
    const s = v.trim();
    if (/^data:image\/(?:png|webp|gif|jpeg);base64,[a-z0-9+/=]+$/i.test(s) && s.length < 70000) return s;
    // Um ID de sprite (ex.: "sword") não é uma URL; deixe o fallback tentar o desenho da página.
    if (!/^(?:https:\/\/|\/|\.\/)/i.test(s) && !/\.(?:png|webp|gif|jpe?g)(?:[?#]|$)/i.test(s)) return "";
    try {
      const u = new URL(s, location.origin);
      if (u.protocol !== "https:") return "";
      // Só carrega ícones do jogo ou da API já permitida no manifest.
      if (!/(^|\.)riftstream\.com\.br$/i.test(u.hostname) && u.hostname !== API_HOST) return "";
      return u.href.slice(0,400);
    } catch (_) { return ""; }
  }
  function findIcon(...objs) {
    for (const o of objs) {
      if (!isObj(o)) continue;
      for (const k of IMG_KEYS) {
        const image = safeImage(o[k]);
        if (image) return image;
      }
      for (const k of ["visual", "appearance", "artwork", "assets", "images"])
        if (isObj(o[k])) {
          for (const n of IMG_KEYS) { const image = safeImage(o[k][n]); if (image) return image; }
        }
    }
    return "";
  }

  const STAT_LABELS = {
    attack:"Ataque",atk:"Ataque",damage:"Dano",attackdamage:"Ataque",forca:"Força",strength:"Força",
    defense:"Defesa",def:"Defesa",armor:"Armadura",armour:"Armadura",
    hp:"Vida",health:"Vida",vida:"Vida",vitality:"Vitalidade",vitalidade:"Vitalidade",
    speed:"Velocidade",attackspeed:"Vel. ataque",velocidade:"Velocidade",agility:"Agilidade",agilidade:"Agilidade",
    crit:"Crítico",critical:"Crítico",critchance:"Chance crít.",criticalchance:"Chance crít.",
    critdamage:"Dano crít.",criticaldamage:"Dano crít.",criticalmultiplier:"Dano crít.",
    luck:"Sorte",sorte:"Sorte",dodge:"Esquiva",evasion:"Esquiva",block:"Bloqueio",
    lifesteal:"Roubo de vida",regen:"Regeneração",regeneration:"Regeneração",
    gold:"Ouro",goldbonus:"Bônus ouro",dropchance:"Chance drop",loot:"Loot",power:"Poder",
    resistance:"Resistência",resistanceall:"Resistência",healing:"Cura",healingpower:"Poder de cura"
  };
  const norm = (s) => str(s,60).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const IGNORE = /^(?:id|itemid|userid|owner|name|nome|title|class|classe|level|lvl|rarity|tier|rank|slot|type|quality|index|seed|createdat|updatedat|durability|icon|image|sprite|color|colors|quantity|count|amount|weight)$/;
  function statName(s, strict=false) {
    const key = norm(s);
    if (STAT_LABELS[key]) return STAT_LABELS[key];
    if (IGNORE.test(key) || !key) return "";
    if (!strict && /(?:bonus|percent|chance|multiplier|damage|resist|heal|attack|armor|crit|defense|speed)/.test(key)) return str(s,38);
    return "";
  }
  function extractStats(v, template) {
    const result = [], seen = new Set();
    function push(label, value) {
      if (result.length >= 10) return;
      const l = str(label,38), val = str(value,40);
      if (!l || !val || /^(?:\[object Object\]|undefined|null)$/i.test(val)) return;
      const sig = `${norm(l)}|${val}`;
      if (seen.has(sig)) return;
      seen.add(sig); result.push({label:l, value:val});
    }
    function scan(obj, depth=0) {
      if (depth > 3 || result.length >= 10 || !obj) return;
      if (typeof obj === "string") {
        const m = obj.match(/^\s*([^:]{2,35})\s*:\s*([^:]{1,36})\s*$/);
        if (m && statName(m[1])) push(statName(m[1]),m[2]);
        return;
      }
      if (Array.isArray(obj)) {
        for (const entry of obj.slice(0,30)) {
          if (isObj(entry)) {
            const label = pick(entry,["label","stat","statName","key","name","namePt","type"]);
            const value = pick(entry,["value","amount","bonus","val","percent","total"]);
            const n = statName(label, false);
            if (n && value != null && typeof value !== "object") push(n,value);
            else scan(entry,depth+1);
          } else if (typeof entry === "string") scan(entry,depth+1);
        }
      } else if (isObj(obj)) {
        for (const [k,val] of Object.entries(obj).slice(0,80)) {
          const label = statName(k);
          if (label && (typeof val === "number" || typeof val === "string")) push(label,val);
          else if ((Array.isArray(val) || isObj(val)) && depth < 3) scan(val,depth+1);
        }
      }
    }
    const fields = ["stats","attributes","atributos","bonuses","bonus","modifiers","modificadores",
      "affixes","effects","efeitos","rolls","bonusStats","statBonuses","extraStats","properties", "perks"];
    for (const obj of [v, template]) {
      if (!isObj(obj)) continue;
      for (const k of fields) if (obj[k] != null) scan(obj[k]);
      // Alguns retornos trazem bônus diretamente em campos planos do item.
      for (const [k,value] of Object.entries(obj).slice(0,100)) {
        const label = statName(k, true);
        if (label && (typeof value === "number" || typeof value === "string")) push(label,value);
      }
    }
    return result;
  }

  function extract(root) {
    const items=[], visited=new WeakSet();
    let identified=false, nodes=0;
    function add(v, slot="", cls="") {
      if (!isObj(v)) return;
      const obj = isObj(v.item) ? v.item : isObj(v.equipmentItem) ? v.equipmentItem : v;
      const template = isObj(obj.template) ? obj.template : isObj(obj.definition) ? obj.definition : {};
      const name = str(pick(obj,["name","nome","displayName","itemName","item_name","title","baseName"]) ||
        pick(template,["name","nome","title"]),75);
      if (!name) return;
      const sl = str(slot || pick(v,["equippedSlot","equipmentSlot","slotName","slot","position","type","tipo"]) || "Item",28);
      const rarity = str(pick(obj,["rarity","raridade","rank","tier","quality","rarityName"]) || pick(template,["rarity"]),25);
      const rawLevel = pick(obj,["level","lvl","itemLevel","upgradeLevel","enhancementLevel"]);
      const level = rawLevel == null ? "" : str(rawLevel,10);
      const icon = findIcon(v,obj,template);
      const stats = extractStats(obj,template);
      const key = `${cls}|${sl}|${name}|${level}`.toLowerCase();
      const existing = items.find(i => i.key===key);
      if (existing) { if (!existing.icon) existing.icon=icon; if (!existing.stats.length) existing.stats=stats; return; }
      items.push({key,slot:sl,name,rarity,level,cls,icon,stats});
    }
    const gearKeys=/^(?:equipment|equipments|equipped|equippedItems|equipped_items|equipamentos|itensEquipados|gear|loadout|equipmentSlots)$/i;
    function readGear(value, cls="") {
      identified=true;
      if (Array.isArray(value)) value.slice(0,80).forEach(e => { if (e) add(e,"",cls); });
      else if (isObj(value)) {
        if (isObj(value.slots)||Array.isArray(value.slots)) readGear(value.slots,cls);
        if (pick(value,["name","nome","displayName","itemName","item_name","title"])) add(value,"",cls);
        else for (const [slot,v] of Object.entries(value).slice(0,50)) {
          if (!v || slot==="slots") continue;
          if (Array.isArray(v)) v.slice(0,20).forEach(i=>add(i,slot,cls));
          else add(v,slot,cls);
        }
      }
    }
    function walk(node, cls="", depth=0) {
      if (!node || typeof node !== "object" || visited.has(node) || depth > 8 || nodes++ > 2500) return;
      visited.add(node);
      if (Array.isArray(node)) { node.slice(0,150).forEach(x=>walk(x,cls,depth+1)); return; }
      const localClass = clsName(pick(node,["class","classe","className","characterClass","character_class"])) || cls;
      if (node.equipped===true || node.isEquipped===true || node.is_equipped===true || node.equipado===true || node.equippedSlot || node.equipped_slot) {
        identified=true;
        add(node,str(node.equippedSlot || node.equipped_slot || node.slot || "Item",28),localClass);
      }
      for (const [k,v] of Object.entries(node).slice(0,150)) {
        const keyClass=clsName(k)||localClass;
        if (gearKeys.test(k)) readGear(v,keyClass);
        if (v && typeof v==="object") walk(v,keyClass,depth+1);
      }
    }
    walk(root);
    return {items:items.slice(0,24).map(({key,...rest})=>rest),identified};
  }
  function onData(data) {
    try {
      const {items,identified}=extract(data);
      lastPacket={source:SIGNAL,items,identified};
      window.postMessage(lastPacket,location.origin);
      // Envia apenas estado e HP; nunca o objeto /api/me completo.
      lastVitalsPacket={source:VITALS_SIGNAL,...extractVitals(data)};
      window.postMessage(lastVitalsPacket,location.origin);
    } catch (_) { /* Nunca bloqueia o site. */ }
  }
  window.addEventListener("message",e=>{
    if (e.source===window && e.origin===location.origin && e.data?.source==="JARVIS_EQUIPMENT_REQUEST_V1") {
      if(lastPacket) window.postMessage(lastPacket,location.origin);
      if(lastVitalsPacket) window.postMessage(lastVitalsPacket,location.origin);
    }
  });
  const originalFetch=window.fetch;
  if (typeof originalFetch==="function") window.fetch=function(...args) {
    const wanted=isMe(args[0]) && (!args[1]?.method || String(args[1].method).toUpperCase()==="GET");
    const p=originalFetch.apply(this,args);
    if (wanted) p.then(r=>{if(r.ok)r.clone().json().then(onData).catch(()=>{});}).catch(()=>{});
    return p;
  };
  const proto=XMLHttpRequest.prototype;
  const originalOpen=proto.open,originalSend=proto.send;
  proto.open=function(method,url,...rest) {
    this.__jarvis_me=String(method).toUpperCase()==="GET" && isMe(url);
    return originalOpen.call(this,method,url,...rest);
  };
  proto.send=function(...args) {
    if(this.__jarvis_me) this.addEventListener("load",()=>{
      if(this.status<200||this.status>=300)return;
      try{onData(this.responseType==="json"?this.response:JSON.parse(this.responseText));}catch(_){}
    },{once:true});
    return originalSend.apply(this,args);
  };
})();
