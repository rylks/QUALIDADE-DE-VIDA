// Roda na Twitch só pra uma coisa: digitar $jogar na live escolhida.
(async () => {
  const log = (...a) => console.log("[RSHopper]", ...a);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const send = (m) => chrome.runtime.sendMessage(m).catch(() => null);
  const login = (location.pathname.split("/")[1] || "").toLowerCase();
  if (!login) return;

  let cfg;
  try { cfg = await chrome.runtime.sendMessage({ type: "getConfig" }); } catch (e) { return; }
  if (!cfg || !cfg.active || cfg.login !== login) return;

  const INPUT = '[data-a-target="chat-input"]';
  const SENDBTN = '[data-a-target="chat-send-button"]';
  const OFFLINE = '[class*="channel-status-info--offline"], [data-a-target*="offline"]';

  async function waitFor(fn, ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (fn()) return true; await sleep(300); }
    return false;
  }

  const CHATLINE = '.chat-line__status, .chat-line__message, [data-a-target="chat-line-message"], .seventv-message';
  await waitFor(() => document.querySelector(INPUT), 12000);
  // O chat leva um tempo pra conectar: espera a mensagem de boas-vindas (ou qualquer mensagem) aparecer.
  const connected = await waitFor(() => document.querySelector(CHATLINE), 20000);
  log("chat conectado:", connected);
  await sleep(3000);

  if (document.querySelector(OFFLINE)) {
    log("live offline");
    await send({ type: "report", login, offline: true });
    return;
  }

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

  const METHODS = [
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
      const dt = new DataTransfer();
      dt.setData("text/plain", text);
      el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    },
    async (el, text) => {
      putCaretAtEnd(el);
      el.dispatchEvent(new InputEvent("beforeinput", { inputType: "insertText", data: text, bubbles: true, cancelable: true }));
    },
  ];

  // Retorna "sent" | "no-input" | "type-fail" | "send-fail"
  async function sendChat(text) {
    const el = document.querySelector(INPUT);
    if (!el) { log("campo do chat não encontrado"); return "no-input"; }
    el.click();
    el.focus();
    await clearInput(el);
    el.focus();

    // 1) Teclas "reais" (confiáveis) enviadas pelo depurador do Chrome, via background.
    const cdp = await send({ type: "cdpType", text });
    log("depurador:", cdp);
    if (cdp && cdp.ok) {
      const waitEnd = Date.now() + 2500;
      while (Date.now() < waitEnd && getText(el).includes(text)) await sleep(200);
      if (!getText(el).includes(text)) { log("enviado (depurador):", text); return "sent"; }
    }

    // 2) Plano B: eventos simulados dentro da página.
    let btn = null, typed = false;
    const deadline = Date.now() + 25000;
    for (let i = 0; !btn && Date.now() < deadline; i++) {
      await clearInput(el);
      try { await METHODS[i % METHODS.length](el, text); } catch (e) { log("método", i % METHODS.length, "falhou:", e); }
      await sleep(300);
      if (getText(el).includes(text)) {
        typed = true;
        btn = await waitSendButton(2500);
        log("tentativa", i + 1, "digitou; botão ativo:", !!btn);
      } else {
        log("tentativa", i + 1, "não digitou");
      }
      if (!btn) await sleep(1500);
    }
    if (!typed) { log("não consegui digitar:", text); return "type-fail"; }
    if (!getText(el).includes(text)) { await clearInput(el); await METHODS[0](el, text); await sleep(300); }

    if (btn) btn.click(); else pressEnter(el);
    await sleep(900);
    if (getText(el).includes(text)) { pressEnter(el); await sleep(900); }   // não saiu? Enter
    if (getText(el).includes(text)) { log("texto continua no campo: não enviou"); return "send-fail"; }
    log("enviado:", text);
    return "sent";
  }

  const COOLDOWN = 120 * 1000;
  const store = (await chrome.storage.local.get("lastJogar")).lastJogar || {};
  let res;
  if (Date.now() - (store[login] || 0) < COOLDOWN) res = "cooldown";
  else {
    res = await sendChat("$jogar");
    if (res === "sent") { store[login] = Date.now(); await chrome.storage.local.set({ lastJogar: store }); }
  }
  await send({ type: "report", login, jogar: res });
})();
