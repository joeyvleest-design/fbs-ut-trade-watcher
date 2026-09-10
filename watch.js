(() => {
  "use strict";
  const lines = ["goalkeeper", "defense", "midfield", "attack"];
  const names = { goalkeeper: "Keepers", defense: "Verdediging", midfield: "Middenveld", attack: "Aanval" };
  const dateFormat = new Intl.DateTimeFormat("nl-NL", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Amsterdam" });
  const dayFormat = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: "Europe/Amsterdam" });
  const coins = (value) => Number.isFinite(value) ? new Intl.NumberFormat("nl-NL").format(value) : "—";
  const make = (tag, className, text) => {
    const node = document.createElement(tag);
    node.className = className || "";
    if (text !== null && text !== undefined) node.textContent = text;
    return node;
  };
  function link(source) {
    try {
      const url = new URL(source?.url);
      if (url.protocol !== "https:") return null;
      const node = make("a", "release-source", source.label || "Bekijk de bron");
      node.href = url.href; node.target = "_blank"; node.rel = "noreferrer";
      return node;
    } catch (_) { return null; }
  }
  function validTime(value) {
    const date = new Date(value || NaN);
    return Number.isFinite(date.getTime()) ? date : null;
  }
  const normalizedName = (value) => String(value || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").trim().toLocaleLowerCase("nl-NL").replace(/\s+/g, " ");
  function isPromo(card) {
    return card.confirmed === true && Number(card.rating) >= 75 && Boolean(card.card_type)
      && !/icon|hero|hall of fut|^gold(?: watch| rare| common)?$/i.test(card.card_type);
  }
  function selectRoster(candidates, exclusions = []) {
    const seen = new Set(exclusions.map(normalizedName));
    const roster = Object.fromEntries(lines.map((line) => [line, []]));
    const eligible = candidates.filter((card) => card?.gender === "male" && ["NL", "NLD"].includes(card.nation_code)
      && lines.includes(card.line) && card.confirmed === true && Boolean(link(card.source || card.releaseSource))
      && ((card.base_item_tier === "gold" && Number(card.base_rating) >= 75) || isPromo(card)));
    eligible.sort((a, b) => Number(isPromo(b)) - Number(isPromo(a)) || (b.meta_rating || 0) - (a.meta_rating || 0));
    for (const card of eligible) {
      const name = normalizedName(card.name);
      if (!name || seen.has(name) || roster[card.line].length >= 2) continue;
      seen.add(name); roster[card.line].push(card);
    }
    return roster;
  }
  function appendParagraphs(container, values) {
    if (!Array.isArray(values)) return;
    values.filter((value) => typeof value === "string").forEach((value) => container.append(make("p", "", value)));
  }
  function renderDaily(data, state) {
    const container = document.querySelector("#daily-trade-card");
    if (!container) return;
    container.replaceChildren();
    if (!data) { container.append(make("p", "", "De dagcheck is tijdelijk niet bereikbaar. Geen actuele call beschikbaar.")); return; }
    const checked = validTime(data.checked_at);
    const today = dayFormat.format(new Date());
    const current = data.date === today && checked && checked.getTime() <= Date.now() + 300000 && !state.stale && !state.error;
    const candidate = current && data.status === "candidate" && data.trade;
    const top = make("div", "daily-topline");
    top.append(make("span", "daily-state", !current ? "ARCHIEF · GEEN ACTUELE CALL" : candidate ? "ONDERBOUWDE KANDIDAAT" : "VANDAAG · GEEN KOOPCALL"));
    if (checked) { const time = make("time", "", `Dagcheck ${dateFormat.format(checked)}`); time.dateTime = checked.toISOString(); top.append(time); }
    container.append(top, make("h3", "", !current ? "Een nieuwe dagcheck is nog onderweg." : data.title), make("p", "daily-summary", data.summary));
    if (!current) container.append(make("p", "data-note", "De onderstaande afweging hoort bij een eerdere of niet-verifieerbare dagcheck. Oude koopgrenzen worden niet getoond."));
    if (candidate) {
      const trade = data.trade;
      container.append(make("p", "daily-player", `${trade.name} · ${trade.version}`));
      const prices = make("div", "daily-prices");
      [["Max. inkoop", trade.buy_price], ["Verkoopdoel", trade.sell_target], ["Netto indicatie", trade.net_profit]].forEach(([label, amount]) => {
        const column = make("div"); column.append(make("small", "", label), make("strong", "", `${coins(amount)} coins`)); prices.append(column);
      });
      container.append(prices);
      appendParagraphs(container, trade.why);
      appendParagraphs(container, trade.risks);
      container.append(make("p", "daily-risk", `Indicatieve ROI ${trade.roi_pct}% · downside ${coins(trade.downside_coins)} coins · signaalsterkte ${trade.confidence}. Geen winstgarantie.`));
      const source = link(trade.source); if (source) container.append(source);
    }
    const details = make("details", "daily-method");
    details.append(make("summary", "", "Lees de afweging & bronstatus +"));
    const paragraphs = [...new Set([...(data.article || []), ...(data.data_quality?.reasons || [])])].filter((text) => text !== data.summary);
    appendParagraphs(details, paragraphs);
    const coverage = data.coverage;
    if (coverage) details.append(make("p", "", coverage.complete ? "Selectiecheck: 2 mannen per linie + 2 Nederlandse meta-vrouwen aanwezig. Dit controleert de gepubliceerde selectie, niet opnieuw de externe kaartbron." : "De selectie is nog niet volledig bronbevestigd. Open plekken worden niet met verzonnen kaarten gevuld."));
    if (data.tax?.status === "assumption_pending_fc27_confirmation") details.append(make("p", "", "Rekenmodel: 5% verkooptax als aanname; nog niet opnieuw bevestigd voor FC 27."));
    container.append(details);
  }
  function renderLegend(card, state) {
    const article = make("article", `legend-card${card.confirmed ? " legend-card--confirmed" : ""}`);
    article.append(make("p", "kicker", card.card_type || "LEGEND"));
    const emblem = make("span", "legend-emblem", card.card_type === "Icon" ? "✦" : card.card_type === "Hero" ? "★" : "∞");
    emblem.setAttribute("aria-hidden", "true"); article.append(emblem);
    if (card.confirmed === true && link(card.source)) article.append(make("span", "confirmed-badge", "✓ SPELER BEVESTIGD"));
    article.append(make("h3", "", card.name || "De volgende held?"), make("p", "legend-role", [card.nation, card.position].filter(Boolean).join(" · ")));
    const stats = make("div", "legend-numbers");
    [["ALG", card.rating], ["META", card.meta_rating]].forEach(([label, value]) => { const item = make("div"); item.append(make("small", "", label), make("strong", "", value == null ? "Nog niet bekend" : label === "META" ? `${value}/100` : String(value))); stats.append(item); });
    article.append(stats, make("p", "legend-meta", card.meta_text || "Nog geen bevestigde kaartstats voor een eerlijke Meta-score."));
    if (card.confirmation_scope) article.append(make("p", "legend-scope", card.confirmation_scope));
    const preview = card.preview;
    if (preview?.status === "third_party_preview" && link(preview.source)) {
      const box = make("details", "legend-preview");
      box.append(make("summary", "", `Voorlopige preview · Meta ${preview.meta_rating ?? "—"}/100 +`), make("p", "", `${preview.label} · ${preview.rating} ALG · ${preview.position}`));
      box.append(make("p", "", preview.meta_text), make("p", "", preview.disclaimer), make("small", "", "Profielscore: 25% SNL + 25% SCH + 20% PAS + 20% DRI + 10% FYS. Geen gameplaytest of officiële rating."), link(preview.source));
      article.append(box);
    }
    const price = card.price;
    const priceTime = validTime(price?.checked_at);
    const fresh = priceTime && Date.now() - priceTime.getTime() <= 3600000 && Date.now() >= priceTime.getTime() - 300000;
    const validPrice = !state.error && !state.stale && price && Number.isFinite(price.amount) && price.amount > 0 && String(price.platform).toLowerCase() === "ps" && price.currency === "coins" && fresh && link(price.source);
    const pricePanel = make("div", "release-price");
    pricePanel.append(make("small", "release-price__label", "PS PRIJS"), make("strong", "", validPrice ? `${coins(price.amount)} coins` : "Nog niet beschikbaar"), make("small", "", validPrice ? `Gemeten ${dateFormat.format(priceTime)}` : card.price_reason || "Geen recente prijs voor precies deze FC 27-kaart."));
    if (validPrice) pricePanel.append(link(price.source));
    article.append(pricePanel);
    const source = link(card.source); if (source) article.append(source);
    if (card.confirmed_at) { const date = validTime(card.confirmed_at); if (date) article.append(make("small", "legend-checked", `Aangekondigd ${dateFormat.format(date)}`)); }
    return article;
  }
  function renderLegends(data, state) {
    const grid = document.querySelector("#legends-grid");
    if (!grid) return;
    const notice = document.querySelector("#legends-notice");
    notice.textContent = state.error ? "Nieuwe brondata niet bereikbaar; eerder geladen bevestigingen blijven zichtbaar." : data?.notice || "Een bevestigde naam betekent nog geen bevestigde rating, PlayStyles of marktprijs.";
    grid.replaceChildren(...(data?.cards || []).map((card) => renderLegend(card, state)));
    for (const family of data?.families || []) {
      if ((data.cards || []).some((card) => card.card_type === family.card_type)) continue;
      const pending = make("article", "legend-card legend-pending");
      pending.append(make("p", "kicker", family.card_type), make("h3", "", "Wie wordt jullie Hero?"), make("p", "", family.detail), make("p", "", "Meta en prijs volgen zodra een exacte kaart bevestigd is."));
      const source = link(family.source); if (source) pending.append(source);
      grid.append(pending);
    }
    if (!grid.children.length) grid.append(make("p", "empty", "De Legends-radar wacht op bronnen."));
  }
  window.FBSWatch = Object.freeze({ selectRoster, lines, names, isPromo });
  window.FBSRefresh.register("daily", { url: "data/trade-of-day.json", render: renderDaily, validate: (data) => ["candidate", "no_trade"].includes(data.status) && typeof data.date === "string" });
  window.FBSRefresh.register("legends", { url: "data/legends.json", render: renderLegends, validate: (data) => data.game === "FC27" && Array.isArray(data.cards) });
})();
