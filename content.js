// Roda na Twitch: opcionalmente segue o canal e envia $jogar após liberar o chat.
(async () => {
  const log = (...a) => console.log("[RSHopper]", ...a);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const send = (m) => chrome.runtime.sendMessage(m).catch(() => null);
  const login = (location.pathname.split("/")[1] || "").toLowerCase();
  if (!login) return;

  let cfg;
  try { cfg = await chrome.runtime.sendMessage({ type: "getConfig" }); } catch (e) { return; }
  if (!cfg || !cfg.active || cfg.login !== login) return;
  if (!cfg.autoJogar) {
    await send({type:"report",login,jogar:"skipped",follow:"disabled"});
    return;
  }

  const INPUT = '[data-a-target="chat-input"]';
  const SENDBTN = '[data-a-target="chat-send-button"]';
  const OFFLINE = '[class*="channel-status-info--offline"], [data-a-target*="offline"]';

  async function waitFor(fn, ms, interval = 100) {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (fn()) return true; await sleep(interval); }
    return false;
  }

  const CHATLINE = '.chat-line__status, .chat-line__message, [data-a-target="chat-line-message"], .seventv-message';

  const isField = (el) => el.tagName === "TEXTAREA" || el.tagName === "INPUT";
  const getText = (el) => (isField(el) ? el.value : el.textContent) || "";

  function putCaretAtEnd(el) {
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  async function clearInput(el) {
    el.focus();
    if (isField(el)) {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value").set;
      setter.call(el, "");
      el.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand("delete");
    }
    await sleep(150);
  }

  // Espera o botão "Chat" ficar ativo: é a prova de que o editor da Twitch registrou o texto.
  async function waitSendButton(ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const b = document.querySelector(SENDBTN);
      if (b && !b.disabled && b.getAttribute("aria-disabled") !== "true") return b;
      await sleep(150);
    }
    return null;
  }

  function pressEnter(el) {
    el.focus();
    const init = { key: "Enter", code: "Enter", keyCode: 13, which: 13, charCode: 13, bubbles: true, cancelable: true };
    el.dispatchEvent(new KeyboardEvent("keydown", init));
    el.dispatchEvent(new KeyboardEvent("keypress", init));
    el.dispatchEvent(new KeyboardEvent("keyup", init));
  }

  // Fallbacks dentro da página, na ordem: colar (paste), insertText, beforeinput.
  const METHODS = [
    async (el, text) => {
      putCaretAtEnd(el);
      const dt = new DataTransfer();
      dt.setData("text/plain", text);
      el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    },
    async (el, text) => {
      if (isField(el)) {
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value").set;
        setter.call(el, text);
        el.dispatchEvent(new Event("input", { bubbles: true }));
      } else {
        putCaretAtEnd(el);
        document.execCommand("insertText", false, text);
      }
    },
    async (el, text) => {
      putCaretAtEnd(el);
      el.dispatchEvent(new InputEvent("beforeinput", { inputType: "insertText", data: text, bubbles: true, cancelable: true }));
    },
  ];

  const norm = (s) => String(s || "").replace(/[\u200b\ufeff]/g, "").trim();

  // Retorna "sent" | "no-input" | "type-fail" | "send-fail"
  async function sendChat(text) {
    const el = document.querySelector(INPUT);
    if (!el) { log("campo do chat não encontrado"); return "no-input"; }
    const exact = () => norm(getText(el)) === text;   // o campo tem EXATAMENTE "$jogar"

    // 1) Coloca o texto inteiro de uma vez (como Ctrl+V) e CONFERE antes de enviar.
    let typed = false;
    for (let i = 0; i < 6 && !typed; i++) {
      el.click(); el.focus();
      await clearInput(el);
      el.focus();
      if (i % 2 === 0) {
        const r = await send({ type: "cdpInsert", text });     // inserção confiável pelo depurador
        log("tentativa", i + 1, "inserção (depurador):", r);
      } else {
        try { await METHODS[((i - 1) / 2) % METHODS.length](el, text); } catch (e) { log("método falhou:", e); }
        log("tentativa", i + 1, "colar na página");
      }
      typed = await waitFor(exact, 1500);
      if (!typed) { log("campo contém:", JSON.stringify(norm(getText(el)))); await sleep(500); }
    }
    if (!typed) { await clearInput(el); log("não consegui colocar o texto:", text); return "type-fail"; }

    // UMA tentativa de envio. Nada de fallback com múltiplos Enters/botão,
    // pois a Twitch pode entregar a mensagem sem limpar o editor imediatamente.
    const claim = await send({ type: "claimJogar", login });
    if (!claim?.ok) { await clearInput(el); return "cooldown"; }
    const result = await send({ type: "cdpEnter" });
    if (!result?.ok) return "uncertain";
    const gone = () => !getText(el).includes(text);
    if (await waitFor(gone, 2500)) return "sent";
    return "uncertain"; // não repetimos mesmo sem confirmação visual

  }

  // Detecta apenas o botão de follow do CANAL atual, nunca um de recomendação
  // nem "Deixar de seguir". A Twitch altera a marcação do site com frequência.
  const normalized = (s) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
  const isFollowingText = (s) => /(?:^|\b)(?:deixar de seguir|seguindo|unfollow|following)(?:\b|$)/i.test(normalized(s));
  const followLabel = (s) => /^(?:seguir|follow)(?:\s+(?:canal|channel|@?[a-z0-9_]+))?$/i.test(normalized(s));
  const followSelectors = [
    'button[data-a-target="follow-button"]', '[data-a-target="follow-button"][role="button"]',
    'button[data-test-selector="follow-button"]', 'button[aria-label]',
    'button[title]', 'main button', 'main [role="button"]'
  ];
  const followElements = () => [...new Set(followSelectors.flatMap(s => [...document.querySelectorAll(s)]))];
  const getLabel = (b) => [b.getAttribute("aria-label"), b.getAttribute("title"),
    b.getAttribute("data-a-target"), b.textContent].filter(Boolean).join(" ").trim();
  function channelButton(b) {
    if (b.disabled || b.getAttribute("aria-disabled") === "true" ||
        b.closest('aside, [role="dialog"], [data-a-target="chat-room-component"], [data-test-selector="side-nav"]')) return false;
    // Recusa follow em recomendações de outros canais, cards e links do site.
    const a = b.closest("a[href]");
    if (a) {
      try {
        const u = new URL(a.href, location.href);
        if (u.hostname === "www.twitch.tv" && u.pathname.split("/")[1]?.toLowerCase() !== login) return false;
      } catch (_) { return false; }
    }
    return true;
  }
  const followingButton = (b) => {
    if (!channelButton(b)) return false;
    const t = (b.getAttribute("data-a-target") || "") + " " + getLabel(b);
    return /(?:unfollow-button|following-button)/i.test(t) || isFollowingText(t);
  };
  function alreadyFollowing() {
    return followElements().some(followingButton);
  }
  function followButton() {
    return followElements().find(b => {
      if (!channelButton(b) || followingButton(b)) return false;
      const at = b.getAttribute("data-a-target") || "";
      const test = b.getAttribute("data-test-selector") || "";
      if (at === "follow-button" || test === "follow-button") return true;
      return [b.getAttribute("aria-label"), b.getAttribute("title"), b.textContent]
        .some(t => followLabel(t));
    }) || null;
  }
  function followPoint(button) {
    button.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
    const r = button.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    if (r.width < 8 || r.height < 8 || x < 0 || y < 0 ||
        x >= window.innerWidth || y >= window.innerHeight) return null;
    const el = document.elementFromPoint(x, y);
    if (el !== button && !button.contains(el)) return null; // modal/overlay cobrindo botão
    return { x: Math.round(x), y: Math.round(y) };
  }
  async function followIfRequested() {
    if (!cfg.autoFollow) return "disabled";
    await send({ type: "followProgress", login, phase: "checking" });
    const exists = await waitFor(() => alreadyFollowing() || followButton(), 22000, 350);
    if (!exists) {
      if (document.querySelector('[data-a-target="login-button"], button[data-test-selector="login-button"]')) return "needs-login";
      return "not-found";
    }
    if (alreadyFollowing()) return "already";
    const btn = followButton();
    if (!btn) return "not-found";
    const point = followPoint(btn);
    if (!point) return "click-fail";
    // O Input.dispatchMouseEvent simula um clique real pelo navegador. O .click()
    // sintético anterior não era confiável na UI React da Twitch.
    const clicked = await send({ type: "cdpClickFollow", ...point });
    if (!clicked?.ok) { log("erro ao clicar follow:", clicked); return "click-fail"; }
    const confirmed = await waitFor(alreadyFollowing, 12000, 350);
    if (!confirmed) return "confirm-fail";
    const waitSeconds = Math.max(0, Math.min(180, Number(cfg.followWaitSec) || 0));
    await send({ type: "followProgress", login, phase: "waiting", seconds: waitSeconds });
    log("follow confirmado; aguardando", waitSeconds, "segundos para $jogar");
    if (waitSeconds) await sleep(waitSeconds * 1000);
    return "followed";
  }

  const canWrite = (el) => !!el && !el.disabled && !el.readOnly && el.getAttribute("aria-disabled") !== "true" && el.getAttribute("contenteditable") !== "false";

  const COOLDOWN = 10 * 60 * 1000;
  const store = (await chrome.storage.local.get("lastJogar")).lastJogar || {};
  const cooldown = Date.now() - (store[login] || 0) < COOLDOWN;
  // Follow ANTES de aguardar o chat: se a Twitch demorar para conectar,
  // o clique não fica perdido atrás de 30+ segundos de carregamento.
  if (document.querySelector(OFFLINE)) {
    await send({ type: "report", login, offline: true });
    return;
  }
  // O cooldown evita re-seguir ou reenviar o mesmo comando.
  const follow = !cooldown ? await followIfRequested() : "cooldown";
  if (cfg.autoFollow && !cooldown && !["already", "followed"].includes(follow)) {
    await send({ type: "report", login, jogar: "follow-unconfirmed", follow });
    return;
  }
  if (document.querySelector(OFFLINE)) {
    await send({ type: "report", login, offline: true });
    return;
  }
  await waitFor(() => document.querySelector(INPUT), 18000);
  const connected = await waitFor(() => document.querySelector(CHATLINE), 22000);
  log("chat conectado:", connected);
  await sleep(1500);

  let res;
  if (cooldown) res = "cooldown";
  else {
    // Respeita o tempo como seguidor e bloqueios reais do chat.
    const writable = await waitFor(() => canWrite(document.querySelector(INPUT)), 60000);
    if (!writable) res = "chat-locked";
    else {
      res = await sendChat("$jogar");
      // O background reserva o envio antes do único Enter.
    }
  }
  await send({ type: "report", login, jogar: res, follow });
})();
