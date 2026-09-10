(() => {
  "use strict";

  const $ = (selector) => document.querySelector(selector);
  const coinsFormatter = new Intl.NumberFormat("nl-NL");
  const percentFormatter = new Intl.NumberFormat("nl-NL", { style: "percent", signDisplay: "always", maximumFractionDigits: 1 });
  const timeFormatter = new Intl.DateTimeFormat("nl-NL", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Amsterdam" });

  function make(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  const coins = (value) => value === null || value === undefined ? "—" : coinsFormatter.format(value);
  const percentage = (value) => value === null || value === undefined ? "—" : percentFormatter.format(value);
  const trendClass = (value) => value === null || value === undefined || value === 0 ? "flat" : value > 0 ? "positive" : "negative";
  const confidence = (value) => ({ high: "hoog", medium: "gemiddeld", low: "laag" })[value] || value || "onbekend";

  function safeLink(url, label, className = "evidence") {
    try {
      const parsed = new URL(url);
      if (!/^https?:$/.test(parsed.protocol)) return null;
      const link = make("a", className, label);
      link.href = parsed.href;
      link.target = "_blank";
      link.rel = "noreferrer";
      return link;
    } catch (_) { return null; }
  }

  function validDate(value) {
    const date = value ? new Date(value) : null;
    return date && !Number.isNaN(date.getTime()) ? date : null;
  }

  function addReasons(card, title, values, risk) {
    if (!values || values.length === 0) return;
    card.append(make("p", "reason-title", title));
    const list = make("ul", `reason-list${risk ? " risk" : ""}`);
    values.forEach((value) => list.append(make("li", "", value)));
    card.append(list);
  }

  function addEvidence(card, evidence) {
    if (!evidence || evidence.length === 0) return;
    const source = evidence[0];
    const link = safeLink(source.url, `Bron: ${source.source} — ${source.title}`);
    if (link) card.append(link);
  }

  function empty(text) { return make("div", "empty", text); }

  function initials(value) {
    const parts = String(value || "UT").trim().split(/\s+/).filter(Boolean);
    return (parts.length > 1 ? `${parts[0][0]}${parts.at(-1)[0]}` : (parts[0] || "UT").slice(0, 2)).toUpperCase();
  }

  function renderMetrics(data, state) {
    const metrics = $("#metrics");
    metrics.replaceChildren();
    const values = [
      [String(data.summary?.items ?? 0), state.isDemo ? "demo prijsitems" : "prijsitems"],
      [String(data.summary?.signals ?? 0), state.isDemo ? "voorbeeldsignalen" : "bronsignalen"],
      [String(state.isDemo || state.canAnalyse ? data.summary?.recommendations ?? 0 : 0), state.isDemo ? "voorbeeldpicks" : "actieve picks"],
      [String(data.platform || "—").toUpperCase(), "marktplatform"],
    ];
    values.forEach(([value, label]) => {
      const metric = make("div", "metric");
      metric.append(make("span", "value", value), make("span", "label", label));
      metrics.append(metric);
    });
  }

  function renderPick(rec, state) {
    const isBuy = rec.action === "BUY";
    const card = make("article", `pick${isBuy ? "" : " sell"}`);
    const top = make("div", "pick-top");
    const heading = make("div");
    heading.append(make("p", "kicker", state.isDemo ? "VOORBEELD · GEEN ECHTE TRADE" : !state.canAnalyse ? "OUD SIGNAAL · GEEN ACTUELE CALL" : isBuy ? "MOGELIJKE INSTAP" : "UITSTAP / NIET VASTKLAMPEN"));
    heading.append(make("h3", "", rec.item?.label || "Onbekende kaart"));
    top.append(heading, make("span", `action${isBuy ? "" : " sell"}`, state.isDemo ? "DEMO" : !state.canAnalyse ? "ARCHIEF" : isBuy ? "KOPEN" : "VERKOPEN"));
    card.append(top);
    const prices = make("div", "price-row");
    if (isBuy) {
      const buy = make("div"); buy.append(make("span", "", "Niet hoger dan"), make("strong", "", coins(rec.max_buy)));
      const sell = make("div"); sell.append(make("span", "", "Richtprijs verkoop"), make("strong", "", coins(rec.sell_target)));
      prices.append(buy, sell);
    } else {
      const sell = make("div"); sell.append(make("span", "", "Overweeg rond"), make("strong", "", coins(rec.sell_target)));
      const current = make("div"); current.append(make("span", "", "Nu op de teller"), make("strong", "", coins(rec.item?.price)));
      prices.append(sell, current);
    }
    card.append(prices);
    const meta = make("div", "card-meta");
    if (isBuy && rec.estimated_profit !== null && rec.estimated_profit !== undefined) meta.append(make("span", "chip", `Netto ±${coins(rec.estimated_profit)}`));
    meta.append(make("span", `confidence ${rec.confidence || "low"}`, `Signaalsterkte: ${confidence(rec.confidence)} · ${rec.score}/100`));
    card.append(meta);
    addReasons(card, "Waarom op de radar", rec.reasons, false);
    addReasons(card, "Waar het mis kan gaan", rec.risks, true);
    addEvidence(card, rec.evidence);
    return card;
  }

  function renderWatch(watch, state) {
    const card = make("article", "watch");
    if (state.isDemo) card.append(make("p", "kicker", "VOORBEELDSIGNAAL"));
    card.append(make("h3", "", watch.title), make("p", "", watch.detail));
    card.append(make("span", `confidence ${watch.confidence || "low"}`, `Signaalsterkte: ${confidence(watch.confidence)}`));
    addEvidence(card, watch.evidence);
    return card;
  }

  function sparkline(points) {
    const section = make("div", "history");
    const head = make("div", "history-head");
    head.append(make("span", "", "De kronkel van de kaart"), make("span", "", `${points?.length || 0} snapshots`));
    section.append(head);
    if (!points || points.length < 2) { section.append(make("span", "card-label", "Nog wat snapshots nodig voordat deze kaart een persoonlijkheid krijgt.")); return section; }
    const values = points.map((point) => Number(point.price)).filter(Number.isFinite);
    if (values.length < 2) return section;
    const width = 280, height = 56, pad = 4, low = Math.min(...values), spread = Math.max(...values) - low || 1;
    const coords = values.map((value, index) => [pad + index * ((width - pad * 2) / (values.length - 1)), height - pad - ((value - low) / spread) * (height - pad * 2)]);
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "sparkline"); svg.setAttribute("viewBox", `0 0 ${width} ${height}`); svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", `Prijshistorie van ${coins(values[0])} naar ${coins(values.at(-1))}`);
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", coords.map(([x, y], index) => `${index ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" "));
    svg.append(path);
    const [x, y] = coords.at(-1); const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    dot.setAttribute("cx", x.toFixed(1)); dot.setAttribute("cy", y.toFixed(1)); dot.setAttribute("r", "3.25"); svg.append(dot);
    section.append(svg); return section;
  }

  function renderCard(item, state) {
    const rec = item.recommendation;
    const card = make("article", `card scout-card${rec ? " recommended" : ""}${rec?.action === "SELL" ? " sell" : ""}`);
    const visual = make("div", "scout-visual"); visual.setAttribute("aria-hidden", "true");
    visual.append(make("span", "scout-orbit"), make("span", "scout-silhouette"), make("span", "scout-initials", initials(item.name)));
    const badge = make("div", "scout-rating"); badge.append(make("strong", "", item.rating === null || item.rating === undefined ? "—" : String(item.rating)), make("span", "", "RATING"));
    visual.append(badge);
    const signal = rec ? make("span", `action scout-action${rec.action === "SELL" ? " sell" : ""}`, state.isDemo ? "DEMO" : !state.canAnalyse ? "ARCHIEF" : rec.action === "SELL" ? "VERKOPEN" : "KOPEN") : null;
    if (signal) visual.append(signal);
    const content = make("div", "scout-content");
    const title = make("div", "scout-title"); title.append(make("h3", "", item.label || item.name), make("span", "card-label", item.version || "MARKTKAART"));
    content.append(title, make("div", "current-price", coins(item.price)), make("span", "card-label", state.isDemo ? "voorbeeldprijs · geen marktdata" : !state.canAnalyse ? "oud meetpunt · niet actueel" : "laatste gemeten prijs"));
    const changes = make("div", "changes");
    [["24 uur", item.change_24h], ["7 dagen", item.change_7d]].forEach(([label, value]) => {
      const change = make("div", "change"); change.append(make("span", "", label), make("strong", trendClass(value), percentage(value))); changes.append(change);
    });
    content.append(changes, sparkline(item.history));
    const meta = make("div", "card-meta");
    if (item.volume !== null && item.volume !== undefined) meta.append(make("span", "chip", `${coins(item.volume)} verhandeld`));
    if (item.rating !== null && item.rating !== undefined) meta.append(make("span", "chip", `Rating ${item.rating}`));
    meta.append(make("span", "chip", item.in_packs === true ? "Nog uit packs te trekken" : item.in_packs === false ? "Niet meer uit packs" : "Pack-status: mistig")); content.append(meta);
    if (item.tags?.length) { const tags = make("div", "tag-list"); item.tags.forEach((tag) => tags.append(make("span", "chip", tag))); content.append(tags); }
    card.append(visual, content);
    return card;
  }

  function renderMetaCard(player) {
    const variant = player.slot === "elite" ? "elite" : "starter";
    const card = make("article", `football-card football-card--${variant}`);
    card.dataset.position = player.position || "";
    card.append(make("span", "football-card__shine"));
    const head = make("header", "football-card__head");
    const rating = make("div", "football-card__rating");
    rating.append(make("strong", "", player.rating === null || player.rating === undefined ? "—" : String(player.rating)), make("span", "", player.position || "—"));
    const flag = make("span", "flag flag--nl"); flag.setAttribute("aria-label", player.nation || "Nederland"); flag.setAttribute("role", "img");
    head.append(rating, flag); card.append(head);
    const identity = make("div", "football-card__identity");
    const monogram = make("span", "football-card__monogram", initials(player.name)); monogram.setAttribute("aria-hidden", "true");
    identity.append(monogram, make("p", "football-card__eyebrow", player.label || "META WATCH"), make("h3", "", player.name || "Nog geen spelerverhaal"), make("p", "football-card__role", player.role || "Wacht op bronbevestiging"));
    card.append(identity);
    const officialArt = window.FBSCardArt?.create(player, { baseProfile: true });
    if (officialArt) { card.classList.add("has-official-art"); card.append(officialArt); }
    const stats = make("dl", "football-card__stats");
    (player.stats || []).forEach((stat) => {
      const statValue = Number(stat.value);
      const row = make("div", "football-card__stat");
      row.style.setProperty("--stat", Number.isFinite(statValue) ? Math.max(0, Math.min(100, statValue)) : 0);
      row.append(make("dt", "", stat.label || "—"), make("dd", "", Number.isFinite(statValue) ? String(statValue) : "—"));
      stats.append(row);
    });
    card.append(stats);
    const index = make("div", "football-card__index");
    index.append(make("span", "", "BIBS META-METER"), make("strong", "", player.meta_index === null || player.meta_index === undefined ? "—" : `${player.meta_index}/100`));
    card.append(index);
    const playstyles = Array.isArray(player.playstyles)
      ? player.playstyles.filter((style) => typeof style?.name === "string" && style.name.trim())
      : [];
    if (playstyles.length) {
      const playstylePanel = make("section", "football-card__playstyles");
      playstylePanel.append(make("p", "football-card__note-title", "Bevestigde PlayStyles"));
      const playstyleList = make("div", "football-card__playstyle-list");
      playstyles.forEach((style) => {
        const isPlus = String(style.tier || "").trim().toLowerCase() === "playstyle+";
        playstyleList.append(make("span", `playstyle-chip${isPlus ? " playstyle-chip--plus" : ""}`, `${style.name.trim()}${isPlus ? "+" : ""}`));
      });
      playstylePanel.append(playstyleList);
      card.append(playstylePanel);
    }
    const notes = make("div", "football-card__notes");
    notes.append(make("p", "football-card__note-title", "Waarom deze lekker speelt"));
    const strengths = make("ul", "football-card__list"); (player.strengths || []).forEach((reason) => strengths.append(make("li", "", reason))); notes.append(strengths);
    if (player.caveats?.length) {
      notes.append(make("p", "football-card__note-title football-card__note-title--risk", "Waar hij/zij kan prikken"));
      const caveats = make("ul", "football-card__list football-card__list--risk"); player.caveats.forEach((reason) => caveats.append(make("li", "", reason))); notes.append(caveats);
    }
    const report = make("details", "player-details");
    const reportTitle = make("summary", "", "Scoutingsrapport ");
    const reportIcon = make("span", "", "+"); reportIcon.setAttribute("aria-hidden", "true");
    reportTitle.append(reportIcon);
    report.append(reportTitle, notes, make("p", "football-card__meta-note", player.meta_note || "Meta-only · geen prijsgoochelwerk"));
    card.append(report);
    if (player.source?.url) {
      const source = safeLink(player.source.url, player.source.label || "Officiële bron", "meta-source");
      if (source) card.append(source);
    }
    return card;
  }

  function isEligibleDutchMetaPlayer(player) {
    const rating = Number(player?.rating);
    return String(player?.nation_code || "").trim().toUpperCase() === "NL"
      && Number.isFinite(rating)
      && rating > 75;
  }

  function renderMetaWatch(data, state = {}) {
    const grid = $("#meta-watch-grid");
    const method = $("#meta-watch-method");
    grid.replaceChildren(); method.replaceChildren(); method.hidden = true;
    const players = Array.isArray(data?.players) ? data.players.filter(isEligibleDutchMetaPlayer) : [];
    if (players.length === 0) {
      grid.append(empty("Geen Nederlandse 75+ kaart met genoeg bronbewijs. Dan houden we de kleedkamer lekker leeg."));
      return;
    }
    grid.replaceChildren(...players.map(renderMetaCard));
    if (state.error || state.stale) {
      method.hidden = false;
      method.append(make("p", "data-note", state.error ? "Profielen konden niet worden vernieuwd. Je ziet de eerder geladen basisprofielen." : "Deze basisprofielen zijn ouder dan een week; controleer de bron voor wijzigingen."));
    }
    if (data.methodology || data.notice) {
      method.hidden = false;
      const label = make("p", "kicker", data.mode === "verified" ? "HOE WE DE META-METER BOUWEN" : "META-METER WACHT OP BEWIJS");
      const text = make("p", "", data.methodology || "Nog geen bronbevestiging — dus geen stoere score.");
      method.append(label, text);
      if (data.notice) method.append(make("p", "meta-method-note", data.notice));
      if (data.updated_at) {
        const updated = validDate(data.updated_at);
        if (updated) method.append(make("p", "meta-method-updated", `Brondata bijgewerkt ${timeFormatter.format(updated)}`));
      }
    }
  }

  function renderMarketwatch(data, state = {}) {
    const container = $("#marketwatch-card");
    if (!container) return;
    container.replaceChildren();
    if (!data) {
      container.append(empty(state.error ? "De ochtendbriefing is tijdelijk niet bereikbaar" : "De ochtendbriefing is nog onderweg. Geen bron = geen marktdrama."));
      return;
    }
    const article = make("article", "marketwatch-article");
    const head = make("header", "marketwatch-article__head");
    const status = make("span", "marketwatch-status", state.error ? "UPDATE ONBEREIKBAAR" : state.stale ? "OUDERE BRIEFING" : data.status_label || "BRONNEN NODIG");
    const copy = make("div", "");
    copy.append(make("p", "kicker", data.window || "DAGELIJKSE MARKETWATCH"), make("h3", "", data.title || "Marketwatch wacht op bronnen"));
    if (data.summary) copy.append(make("p", "marketwatch-article__summary", data.summary));
    head.append(copy, status);
    article.append(head);
    if (state.error || state.stale) article.append(make("p", "data-note", state.error ? "De laatste controle mislukte. De eerder geladen briefing blijft leesbaar." : "Deze briefing is ouder dan 36 uur. Er is nog geen recentere publicatie geladen."));
    const body = Array.isArray(data.article) ? data.article : [];
    if (body.length) {
      const prose = make("div", "marketwatch-article__prose");
      body.forEach((paragraph) => prose.append(make("p", "", paragraph)));
      article.append(prose);
    }
    const signals = Array.isArray(data.signals) ? data.signals : [];
    if (signals.length) {
      article.append(make("p", "marketwatch-article__label", "WAT WE WEL / NIET WETEN"));
      const list = make("ul", "marketwatch-article__signals");
      signals.forEach((signal) => list.append(make("li", "", signal)));
      article.append(list);
    }
    const sources = Array.isArray(data.sources) ? data.sources : [];
    if (sources.length) {
      const links = make("div", "marketwatch-article__sources");
      sources.forEach((source) => {
        const link = safeLink(source?.url, source?.label || "Bron", "marketwatch-source");
        if (link) links.append(link);
      });
      if (links.children.length) article.append(links);
    }
    if (data.updated_at) {
      const updated = validDate(data.updated_at);
      if (updated) article.append(make("p", "marketwatch-article__updated", `Laatst gecontroleerd ${timeFormatter.format(updated)}`));
    }
    container.append(article);
  }

  function render(data, resourceState) {
    if (!data) {
      $("#mode-badge").textContent = "Data niet bereikbaar";
      $("#mode-badge").className = "badge unavailable";
      $("#status-title").textContent = "De radar kan even niet laden";
      $("#status-detail").textContent = "Probeer straks opnieuw. Er is in dit bezoek nog geen marktdata geladen.";
      $("#updated-at").textContent = "Nog geen gegevens geladen";
      ["#picks-grid", "#watch-grid", "#cards-grid"].forEach((selector) => $(selector).replaceChildren(empty("Gegevens tijdelijk niet bereikbaar.")));
      return;
    }
    const isDemo = data.mode === "demo";
    const state = { isDemo, canAnalyse: !isDemo && data.market_data_licensed === true && !resourceState.stale && !resourceState.error };
    document.title = `de flikkerbibsjes UT Trade watcher · ${(data.platform || "").toUpperCase()}`;
    const badge = $("#mode-badge");
    badge.textContent = resourceState.error ? "Update onbereikbaar" : isDemo ? "Demo · speelgeld" : data.market_data_licensed !== true ? "Prijsfeed ontbreekt" : resourceState.stale ? "Oudere snapshot" : "Recente snapshot";
    badge.className = `badge ${resourceState.error ? "unavailable" : isDemo ? "demo" : state.canAnalyse ? "live" : "stale"}`;
    const generated = validDate(data.generated_at);
    $("#updated-at").textContent = generated ? `Bijgewerkt ${timeFormatter.format(generated)}` : "Tijdstip onbekend";
    $("#status-title").textContent = resourceState.error ? "Laatste update niet bereikbaar" : isDemo ? "Demo op het veld. Echte coins op de bank." : state.canAnalyse ? "Prijsanalyse aan" : "Watch-modus: handen op de coins";
    $("#status-detail").textContent = resourceState.error ? "Eerder geladen gegevens blijven zichtbaar. Controleer de datum; deze prijzen en signalen zijn niet actueel bevestigd." : isDemo ? "Deze prijzen, grafieken en picks zijn voorbeelden. Er is geen actuele prijsfeed aangesloten." : state.canAnalyse ? "Brondata, tax en risico vormen samen een signaal — geen glazen bol." : data.market_data_licensed !== true ? "Geen toegestane live prijsfeed, dus ook geen verzonnen koopprijzen." : "De snapshot is ouder dan één uur of heeft geen geldige datum. Eerdere signalen staan als archief op de radar.";
    renderMetrics(data, state);
    const recommendations = isDemo || data.market_data_licensed === true ? data.recommendations || [] : [];
    const items = isDemo || data.market_data_licensed === true ? data.items || [] : [];
    const pickGrid = $("#picks-grid"); pickGrid.replaceChildren(...recommendations.map((item) => renderPick(item, state))); if (!recommendations.length) pickGrid.append(empty("Vandaag geen stevige pick. Wij verzinnen liever niets dan jullie coins te laten verdwalen."));
    const watchGrid = $("#watch-grid"); watchGrid.replaceChildren(...(data.watches || []).map((item) => renderWatch(item, state))); if (!data.watches?.length) watchGrid.append(empty("Radar stil. Ofwel de markt slaapt, ofwel hij doet alsof."));
    const cardGrid = $("#cards-grid"); cardGrid.replaceChildren(...items.map((item) => renderCard(item, state))); if (!items.length) cardGrid.append(empty("Nog geen prijskaarten. Geen bron, geen cowboyverhaal."));
    const warnings = $("#warnings-list"); warnings.replaceChildren(...(data.warnings || []).map((warning) => make("li", "", warning))); $("#warnings-section").hidden = !(data.warnings?.length);
  }

  window.FBSRefresh.register("market", { url: "data/current.json", render, validate: (data) => typeof data.mode === "string" && Array.isArray(data.items) });
  window.FBSRefresh.register("meta", { url: "data/meta-watch.json", render: renderMetaWatch, validate: (data) => Array.isArray(data.players) });
  window.FBSRefresh.register("marketwatch", { url: "data/marketwatch.json", render: renderMarketwatch, validate: (data) => typeof data.title === "string" });
})();
