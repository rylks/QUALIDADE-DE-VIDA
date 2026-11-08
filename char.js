// Roda na página do RiftStream e lê "JOGANDO EM <live>" e "ZONA x-y" do seu personagem.
(() => {
  const leaf = (re) => {
    for (const el of document.querySelectorAll("span,div,a,p,li,b,strong,button,small")) {
      if (el.children.length) continue;
      const m = (el.textContent || "").trim().match(re);
      if (m) return m;
    }
    return null;
  };
  function read() {
    let z = leaf(/^zona\s+(\d+)\s*-\s*(\d+)$/i);
    let p = leaf(/^jogando em\s+(.+)$/i);
    if (!z) z = (document.body.innerText || "").match(/\bzona\s+(\d+)\s*-\s*(\d+)\b/i);
    if (!p) p = (document.body.innerText || "").match(/jogando em\s+([A-Za-z0-9_]+)/i);
    return {
      zone: z ? +z[1] : null,
      wave: z ? +z[2] : null,
      playingIn: p ? p[1].trim().toLowerCase() : null,
    };
  }
  function report() {
    if (!location.pathname.startsWith("/character")) return;
    chrome.runtime.sendMessage({ type: "char", ...read() }).catch(() => {});
  }
  setTimeout(report, 3000);
  setInterval(report, 5000);
})();
