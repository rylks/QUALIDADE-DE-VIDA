// JARVIS - Forja automática RiftStream
// Tempo máximo por tentativa: 15 segundos.
// Em resultado desconhecido, fecha a janela e interrompe por segurança.

(() => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const text = (el) => ((el && (el.innerText || el.textContent)) || "").trim();
  const flat = (s) => String(s).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim();
  const store = chrome.storage.local;

  const RANKS = ["comum", "incomum", "raro", "epico", "lendario", "imortal", "arcano"];
  const rankOf = (s) => RANKS.indexOf(flat(s));
  const KNOWN_CHANCE = { lendario: 50, imortal: 35 };
  const HEAD = /^(.+?)\s*·\s*(.+?)\s*[➜→]\s*(.+?)\s*·\s*(\d+)\s*\/\s*(\d+)/;

  const FORGE_TIMEOUT_MS = 15000;
  const SERVER_RETRY_MS = 10000;
  const SERVER_MAX_ERRORS = 5;

  let busy = false;
  let halted = false;
  let lastStatus = null;
  let openFails = 0;
  let lastOpenKey = "";
  let serverRetryAt = 0;
  let serverErrors = 0;
  let dialogSeen = null;
  let dialogSince = 0;

  const skip = new Set();

  const topDialog = () => {
    const dialogs = [...document.querySelectorAll('div.modal[role="dialog"]')];
    return dialogs.at(-1) || null;
  };

  const labelOf = (d) => flat(d?.getAttribute("aria-label") || "");

  const btnByText = (root, re) => {
    if (!root) return null;
    return [...root.querySelectorAll("button")]
      .find((b) => !b.disabled && re.test(flat(text(b)))) || null;
  };

  const confirmBtn = (d) => {
    if (!d) return null;
    return [...d.querySelectorAll(".d-actions button")]
      .find((b) => !b.disabled && /^forjar\b/.test(flat(text(b)))) || null;
  };

  const serverUnavailable = (d) => {
    if (!d) return false;
    return /service unavailable|servico indisponivel|nao foi possivel falar com o servidor/
      .test(flat(text(d)));
  };

  const itemUnavailable = (d) => {
    if (!d) return false;
    return /item nao encontrado|faltam\s+\d+\s+item/
      .test(flat(text(d)));
  };

  async function setStatus(s) {
    if (s === lastStatus) return;
    lastStatus = s;
    await store.set({ forgeStatus: s });
  }

  async function waitFor(fn, ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const result = fn();
      if (result) return result;
      await sleep(100);
    }
    return null;
  }

  async function closeDialog(d) {
    if (!d) return false;

    const close =
      btnByText(d, /^cancelar$/) ||
      btnByText(d, /^fechar$/) ||
      btnByText(d, /^voltar$/);

    if (!close) return false;

    close.click();

    return !!(await waitFor(
      () => !document.contains(d) || topDialog() !== d,
      3000
    ));
  }

  function parseConfirm(d) {
    const t = d.innerText || d.textContent || "";

    const levels = [...d.querySelectorAll(".forge-slot:not(.result) .lv")]
      .map((e) => parseInt(text(e), 10))
      .filter((n) => !isNaN(n));

    const res = t.match(/N[íi]vel do item resultante:\s*(\d+)\s*a\s*(\d+)/i);
    const ch = t.match(/(\d+)\s*%\s*de chance/i);
    const to = text(d.querySelector(".forge-slot.result span.small")) || "?";
    const risky = /arriscad|roleta/i.test(t);

    return {
      need: parseInt((t.match(/(\d+)\s+itens/i) || [])[1], 10) || 0,
      levels,
      lo: res ? +res[1] : "?",
      hi: res ? +res[2] : "?",
      to,
      risky,
      chance: ch ? +ch[1] : risky ? (KNOWN_CHANCE[flat(to)] || 0) : 100,
      cost: (t.match(/custo:\s*([\d.,]+)\s*g/i) || [])[1] || "?"
    };
  }

  function groups(tab) {
    return [...tab.querySelectorAll(".forge-group")]
      .map((el) => {
        const h = el.querySelector("h3");
        const m = h && text(h).replace(/\s+/g, " ").match(HEAD);
        if (!m) return null;

        const items = [...el.querySelectorAll(".bag-grid button.ibox")]
          .map((b) => ({
            b,
            lv: parseInt(text(b.querySelector(".lv")), 10) || 0
          }));

        items.sort((a, b) => b.lv - a.lv);

        return {
          from: m[1],
          type: m[2],
          to: m[3],
          have: +m[4],
          need: +m[5],
          items,
          key: flat(`${m[1]}|${m[2]}|${m[3]}`)
        };
      })
      .filter(Boolean);
  }

  // Uma tentativa de forja nunca espera mais de 15 segundos.
  async function forge(btn, minChance) {
    const deadline = Date.now() + FORGE_TIMEOUT_MS;
    btn.click();

    while (Date.now() < deadline) {
      await sleep(300);

      const d = topDialog();

      if (!d) {
        return {
          done: false,
          uncertain: true,
          msg: "janela fechou sem resultado confirmado"
        };
      }

      const lb = labelOf(d);

      if (serverUnavailable(d)) {
        return {
          done: false,
          serverError: true,
          msg: "Service Unavailable"
        };
      }

      if (itemUnavailable(d)) {
        return {
          done: false,
          itemError: true,
          msg: "Item não encontrado ou itens insuficientes"
        };
      }

      // Confirmação adicional de forja arriscada.
      const risk = btnByText(d, /^entendo o risco/);

      if (risk) {
        const m = text(d).match(/chance de sucesso[^\d]{0,20}(\d+)\s*%/i);
        const pct = m ? +m[1] : 0;

        if (pct < minChance) {
          const back = btnByText(d, /^voltar$/);
          if (back) back.click();

          return {
            done: false,
            halt: true,
            msg: `Chance ${pct || "desconhecida"}%, abaixo do mínimo de ${minChance}%`
          };
        }

        risk.click();
        await sleep(600);
        continue;
      }

      const cont = btnByText(d, /^continuar$/);

      if (cont) {
        const lost =
          !!d.querySelector(".roulette.lose") ||
          /forja falhou|foram perdidos/.test(flat(text(d)));

        const title = text(d.querySelector(".fr-title"))
          .replace(/\s+/g, " ");

        cont.click();
        await sleep(700);

        if (lost) {
          return {
            done: true,
            ok: false,
            msg: "caiu na caveira, itens perdidos"
          };
        }

        if (lb.startsWith("forja concluida")) {
          await waitFor(() => {
            const x = topDialog();
            return !x || labelOf(x) !== lb;
          }, Math.max(0, deadline - Date.now()));

          return {
            done: true,
            ok: true,
            msg: title || "Forja concluída"
          };
        }

        // A roleta pode abrir outra tela de conclusão.
        continue;
      }

      if (lb !== "forja" && !lb.startsWith("forja concluida")) {
        const c = btnByText(d, /^(ok|entendi)$/);

        if (c) {
          const msg = text(d.querySelector(".modal-body"))
            .replace(/\s+/g, " ")
            .slice(0, 100);

          c.click();
          await sleep(600);

          return {
            done: true,
            ok: false,
            msg: `${d.getAttribute("aria-label")}: ${msg}`
          };
        }
      }
    }

    return {
      done: false,
      uncertain: true,
      msg: "tempo máximo de 15 segundos atingido sem resultado confirmado"
    };
  }

  async function recoverItemError(d) {
    const closed = await closeDialog(d);

    if (!closed) {
      halted = true;
      await setStatus("Itens indisponíveis: não consegui fechar a janela. Parei.");
      return;
    }

    serverRetryAt = Date.now() + SERVER_RETRY_MS;
    openFails = 0;
    lastOpenKey = "";
    dialogSeen = null;

    await setStatus(
      "Itens indisponíveis: janela fechada. Nova verificação em 10 segundos."
    );
  }

  async function recoverServerError(d) {
    const closed = await closeDialog(d);

    if (!closed) {
      halted = true;
      await setStatus(
        "Service Unavailable: não consegui fechar a janela. Parei por segurança."
      );
      return;
    }

    serverErrors++;

    if (serverErrors >= SERVER_MAX_ERRORS) {
      halted = true;
      await setStatus(
        `Erro de servidor ${serverErrors} vezes consecutivas. Automação interrompida.`
      );
      return;
    }

    serverRetryAt = Date.now() + SERVER_RETRY_MS;
    openFails = 0;
    lastOpenKey = "";
    dialogSeen = null;

    await setStatus(
      `Service Unavailable: janela fechada. Nova tentativa em 10 segundos (${serverErrors}/${SERVER_MAX_ERRORS}).`
    );
  }

  async function recoverUncertain(reason) {
    const d = topDialog();
    const closed = d ? await closeDialog(d) : true;

    halted = true;
    dialogSeen = null;

    await setStatus(
      `Forja sem resultado confirmado: ${reason}. ${closed ? "Janela fechada." : "Não consegui fechar a janela."} Automação interrompida. Confira os itens antes de retomar.`
    );
  }

  async function sweep() {
    if (busy) return;
    busy = true;

    try {
      const cfg = await store.get([
        "forgeEnabled",
        "forgeDry",
        "forgeMax",
        "forgeMinChance",
        "forgeTotal",
        "forgeLost",
        "forgePaused",
        "forgePauseAfter",
        "forgeRunBaseTotal"
      ]);

      if (!cfg.forgeEnabled) {
        await setStatus("");
        return;
      }
      // A pausa é respeitada antes de abrir qualquer nova tentativa.
      // Nunca cancela uma tentativa que já foi enviada ao servidor.
      if (cfg.forgePaused) return;
      const doneTotal = Math.max(0, Number(cfg.forgeTotal) || 0) + Math.max(0, Number(cfg.forgeLost) || 0);
      const batchLimit = Math.max(0, Number(cfg.forgePauseAfter) || 0);
      let start = Number(cfg.forgeRunBaseTotal);
      if (!Number.isFinite(start) || cfg.forgeRunBaseTotal === null) {
        start = doneTotal;
        await store.set({ forgeRunBaseTotal: start });
      }
      if (batchLimit && doneTotal - start >= batchLimit) {
        await store.set({forgePaused:true, forgeStatus:`Limite de ${batchLimit} tentativas nesta sessão atingido. Forja pausada; clique em Retomar para uma nova sessão.`});
        return;
      }

      if (halted || Date.now() < serverRetryAt) return;

      const dry = cfg.forgeDry !== false;
      const maxRank = rankOf(cfg.forgeMax || "lendario");
      const minChance = Math.min(
        100,
        Math.max(1, Number(cfg.forgeMinChance) || 100)
      );

      const d = topDialog();
      const lb = labelOf(d);

      // Erros conhecidos são tratados imediatamente.
      if (d && serverUnavailable(d) && !dry) {
        await recoverServerError(d);
        return;
      }

      if (d && itemUnavailable(d) && !dry) {
        await recoverItemError(d);
        return;
      }

      // Janela aberta sem conseguir iniciar uma forja.
      if (d && lb === "forja" && !dry) {
        if (dialogSeen !== d) {
          dialogSeen = d;
          dialogSince = Date.now();
        }

        if (Date.now() - dialogSince >= FORGE_TIMEOUT_MS) {
          const closed = await closeDialog(d);

          if (!closed) {
            halted = true;
            await setStatus(
              "Janela da Forja parada por 15 segundos. Não consegui fechá-la."
            );
            return;
          }

          serverRetryAt = Date.now() + SERVER_RETRY_MS;
          dialogSeen = null;

          await setStatus(
            "Janela parada por 15 segundos. Fechada; nova verificação em 10 segundos."
          );
          return;
        }
      } else if (!d) {
        dialogSeen = null;
      }

      // Janela de confirmação.
      if (d && lb === "forja") {
        const p = parseConfirm(d);

        const info =
          `${p.need} itens → ${p.to}, nível ${p.lo}-${p.hi}, chance ${p.chance ? p.chance + "%" : p.risky ? "desconhecida" : "100%"}, custo ${p.cost}g (itens: ${p.levels.join(", ")})`;

        if (!p.need || p.levels.length !== p.need) {
          await setStatus(
            `Forja: ${info}. Itens incompletos, não forjei.`
          );
          return;
        }

        const cancel = btnByText(d, /^cancelar$/);

        if (rankOf(p.to) > maxRank) {
          skip.add("to:" + flat(p.to));

          await setStatus(
            `Forja: ${info}. Acima do limite, cancelei.`
          );

          if (!dry && cancel) cancel.click();
          return;
        }

        if (p.chance < minChance) {
          skip.add("to:" + flat(p.to));

          await setStatus(
            `Forja: ${info}. Chance abaixo do mínimo de ${minChance}%, cancelei.`
          );

          if (!dry && cancel) cancel.click();
          return;
        }

        const btn = confirmBtn(d);

        if (!btn) {
          await setStatus(
            `Forja: ${info}. Botão de forjar não encontrado.`
          );
          return;
        }

        if (dry) {
          await setStatus(
            `Teste: ${info}. Desligue o modo teste para forjar.`
          );
          return;
        }

        await setStatus(`Forjando: ${info}...`);

        const r = await forge(btn, minChance);

        if (r.serverError) {
          await recoverServerError(topDialog());
          return;
        }

        if (r.itemError) {
          await recoverItemError(topDialog());
          return;
        }

        if (r.uncertain) {
          await recoverUncertain(r.msg);
          return;
        }

        if (!r.done) {
          halted = true;
          await setStatus(
            `Parei: ${r.msg}. Mude uma opção do popup para retomar.`
          );
          return;
        }

        const patch = r.ok
          ? { forgeTotal: (Number(cfg.forgeTotal) || 0) + 1 }
          : { forgeLost: (Number(cfg.forgeLost) || 0) + 1 };

        await store.set(patch);
        const attemptsNow = (Number(patch.forgeTotal ?? cfg.forgeTotal) || 0) +
          (Number(patch.forgeLost ?? cfg.forgeLost) || 0) - start;
        if (batchLimit && attemptsNow >= batchLimit) {
          await store.set({forgePaused:true,forgeStatus:`Limite de ${batchLimit} tentativas atingido (último resultado: ${r.msg}). Forja pausada.`});
          openFails = 0;
          serverErrors = 0;
          dialogSeen = null;
          return;
        }

        await setStatus(
          r.ok
            ? `Forjado: ${r.msg}.`
            : `Resultado: ${r.msg}.`
        );

        openFails = 0;
        serverErrors = 0;
        dialogSeen = null;

        await sleep(800);
        return;
      }

      if (d) {
        await setStatus(
          "Há outra janela aberta. Feche-a para a forja continuar."
        );
        return;
      }

      // Lista de grupos disponíveis.
      const tab = document.querySelector(".forge-tab");

      if (!tab) {
        const tb = [...document.querySelectorAll("button")]
          .find((b) =>
            /^forja\b/i.test(text(b)) &&
            !b.closest(".modal")
          );

        if (tb && !dry) {
          tb.click();
          await sleep(800);
        }

        await setStatus(
          "Abra a aba Forja no inventário do RiftStream."
        );
        return;
      }

      const all = groups(tab);

      const ready = all
        .filter((g) =>
          g.have >= g.need &&
          g.items.length >= g.need &&
          rankOf(g.to) >= 0 &&
          rankOf(g.to) <= maxRank &&
          !skip.has(g.key) &&
          !skip.has("to:" + flat(g.to))
        )
        .sort((a, b) => rankOf(a.to) - rankOf(b.to));

      if (!ready.length) {
        await setStatus(
          `Nenhum grupo pronto para forjar até ${cfg.forgeMax || "lendario"} (${all.length} grupos lidos).`
        );
        return;
      }

      const g = ready[0];
      const label =
        `${g.from} ${g.type} → ${g.to} (${g.have}/${g.need})`;

      if (dry) {
        await setStatus(
          `Teste: ${ready.length} grupos prontos. Próximo: ${label}. Desligue o modo teste para forjar.`
        );
        return;
      }

      const key = g.key + g.items.length;

      if (key === lastOpenKey) {
        openFails++;
      } else {
        openFails = 0;
        lastOpenKey = key;
      }

      if (openFails >= 3) {
        skip.add(g.key);
        openFails = 0;

        await setStatus(
          `Não consegui abrir a forja de ${label}. Pulei esse grupo.`
        );
        return;
      }

      await setStatus(`Abrindo forja: ${label}...`);

      g.items[0].b.click();

      await waitFor(() => {
        const x = topDialog();
        return x && labelOf(x) === "forja";
      }, 3000);

    } catch (err) {
      halted = true;
      await setStatus(
        `Erro interno na Forja: ${err?.message || String(err)}. Automação interrompida.`
      );
    } finally {
      busy = false;
    }
  }

  setInterval(sweep, 2000);

  chrome.storage.onChanged.addListener((ch) => {
    if (
      ch.forgeEnabled ||
      ch.forgeDry ||
      ch.forgeMax ||
      ch.forgeMinChance ||
      (ch.forgePaused && ch.forgePaused.newValue === false)
    ) {
      halted = false;
      serverErrors = 0;
      serverRetryAt = 0;
      dialogSeen = null;
      skip.clear();
      openFails = 0;
      lastStatus = null;
      sweep();
    }
  });
})();