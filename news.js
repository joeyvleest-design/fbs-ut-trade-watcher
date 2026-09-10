(() => {
  "use strict";

  const $ = (selector) => document.querySelector(selector);
  const dateFormatter = new Intl.DateTimeFormat("nl-NL", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Amsterdam" });
  const coinFormatter = new Intl.NumberFormat("nl-NL");
  const localDashboard = new Set(["127.0.0.1", "localhost"]).has(location.hostname) && location.port === "8765";
  const dataUrl = localDashboard ? "/public/data/releases.json" : "data/releases.json";
  const metaDataUrl = localDashboard ? "/public/data/meta-watch.json" : "data/meta-watch.json";
  const standaloneNewsPage = document.body.dataset.page === "news";

  function make(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function safeLink(source, className = "release-source") {
    if (!source?.url || !source?.label) return null;
    try {
      const parsed = new URL(source.url);
      if (!/^https?:$/.test(parsed.protocol)) return null;
      const link = make("a", className, source.label);
      link.href = parsed.href;
      link.target = "_blank";
      link.rel = "noreferrer";
      return link;
    } catch (_) {
      return null;
    }
  }

  function empty(text) {
    return make("div", "release-empty", text);
  }

  function initials(value) {
    const parts = String(value || "UT").trim().split(/\s+/).filter(Boolean);
    return (parts.length > 1 ? `${parts[0][0]}${parts.at(-1)[0]}` : (parts[0] || "UT").slice(0, 2)).toUpperCase();
  }

  function isDutchGold(card) {
    return Boolean(card)
      && ["NL", "NLD"].includes(String(card.nation_code || "").toUpperCase())
      && String(card.base_item_tier || "").toLowerCase() === "gold"
      && Number(card.base_rating) >= 75;
  }

  function normalizedPlayerName(value) {
    return String(value || "")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .trim()
      .toLocaleLowerCase("nl-NL")
      .replace(/\s+/g, " ");
  }

  function isEligibleMetaPlayer(player) {
    return Boolean(player)
      && ["NL", "NLD"].includes(String(player.nation_code || "").toUpperCase())
      && Number(player.rating) > 75;
  }

  function metaPlayerNames(releaseData, metaData) {
    const names = new Set(
      (releaseData?.meta_watch_exclusions || [])
        .map(normalizedPlayerName)
        .filter(Boolean),
    );
    (metaData?.players || [])
      .filter(isEligibleMetaPlayer)
      .map((player) => normalizedPlayerName(player.name))
      .filter(Boolean)
      .forEach((name) => names.add(name));
    return names;
  }

  function stateLabel(status) {
    return ({
      confirmed: "BEVESTIGD",
      awaiting_official_confirmation: "WACHT OP EA",
      source_backed_base_profile: "GOLD WATCH",
    })[status] || "OP DE RADAR";
  }

  function kindLabel(kind) {
    return String(kind || "RELEASE").toUpperCase();
  }

  function marketItemFor(card, marketData) {
    if (!marketData?.market_data_licensed || marketData.mode === "demo" || !Array.isArray(marketData.items)) return null;
    const state = window.FBSRefresh.get("market");
    if (state.stale || state.error) return null;
    if (!card.market_item_id) return null;
    const candidates = marketData.items.filter((item) => String(item.id) === String(card.market_item_id));
    return candidates.length === 1 ? candidates[0] : null;
  }

  function priceStatus(card, marketData) {
    if (!marketData) return "Koppel een toegestane live prijsfeed voor een echte prijs.";
    if (marketData.mode === "demo") return "Demo telt niet als actuele prijs.";
    if (window.FBSRefresh.get("market").stale) return "De prijsdata is verouderd of niet bereikbaar. Wacht op een nieuwe snapshot.";
    if (!marketData.market_data_licensed) return "Live prijsfeed is niet toegestaan of niet vers genoeg.";
    if (!card.market_item_id) return "Exacte kaart-ID ontbreekt nog in de toegestane prijsfeed.";
    return "Deze kaart zit nog niet in de toegestane prijsfeed.";
  }

  function renderCurrentPrice(card, marketData) {
    const item = marketItemFor(card, marketData);
    const price = make("div", "release-price");
    price.append(make("span", "release-price__label", "ACTUELE PRIJS"));
    if (item && item.price !== null && item.price !== "" && Number.isFinite(Number(item.price))) {
      price.classList.add("release-price--live");
      price.append(make("strong", "", coinFormatter.format(Number(item.price))));
      const generated = new Date(marketData.generated_at);
      const updated = Number.isNaN(generated.getTime()) ? "zojuist uit de feed" : `bijgewerkt ${dateFormatter.format(generated)}`;
      price.append(make("small", "", `${String(marketData.platform || "—").toUpperCase()} · ${updated}`));
    } else {
      price.append(make("strong", "", "—"), make("small", "", priceStatus(card, marketData)));
    }
    return price;
  }

  function renderSchedule(schedule) {
    const container = $("#release-schedule");
    container.replaceChildren();
    for (const slot of schedule || []) {
      const kind = kindLabel(slot.kind);
      const card = make("article", `schedule-card schedule-card--${kind.toLowerCase()}`);
      const mark = make("span", "schedule-mark", kind === "TOTW" ? "★" : "✦");
      mark.setAttribute("aria-hidden", "true");
      const copy = make("div", "schedule-copy");
      copy.append(
        make("p", "schedule-day", slot.weekday || "Deze week"),
        make("h3", "", slot.label || kind),
        make("p", "", slot.detail || "Wacht op een officiële bevestiging voordat je kaarten invult."),
      );
      card.append(mark, copy, make("span", "schedule-kind", kind));
      container.append(card);
    }
    if (!container.children.length) container.append(empty("De releasekalender is even kwijt. Kom terug als de radar weer wakker is."));
  }

  function renderStats(stats) {
    const list = make("dl", "release-card__stats");
    for (const stat of stats || []) {
      const value = Number(stat?.value);
      if (!stat?.label || !Number.isFinite(value)) continue;
      const item = make("div", "release-card__stat");
      item.style.setProperty("--stat", String(Math.max(0, Math.min(100, value))));
      item.append(make("dt", "", stat.label), make("dd", "", String(value)));
      list.append(item);
    }
    return list;
  }

  function renderCard(card, options = {}) {
    const dutch = options.dutch || isDutchGold(card);
    const article = make("article", `release-card${dutch ? " release-card--dutch" : ""}`);
    article.dataset.position = card.position || "";
    const visual = make("div", "release-card__visual");
    visual.setAttribute("aria-hidden", "true");
    visual.append(make("span", "release-card__halo"), make("span", "release-card__monogram", initials(card.name)));
    const rating = make("div", "release-card__rating");
    rating.append(make("strong", "", String(card.rating ?? card.base_rating ?? "—")), make("span", "", card.position || "—"));
    visual.append(rating, make("span", "release-card__type", card.card_type || "KAART"));
    if (dutch) {
      const flag = make("span", "flag flag--nl");
      flag.setAttribute("role", "img");
      flag.setAttribute("aria-label", "Nederland");
      visual.append(flag, make("span", "release-card__spotlight", "ORANJE GOUD"));
    }
    const officialArt = window.FBSCardArt?.create(card, { baseProfile: card.card_type === "Gold Watch" });
    if (officialArt) {
      article.classList.add("has-official-art");
      visual.removeAttribute("aria-hidden");
      visual.append(officialArt);
    }

    const content = make("div", "release-card__content");
    content.append(make("p", "release-card__eyebrow", dutch ? "GOLD WATCH · NEDERLAND" : kindLabel(options.kind || card.card_type)));
    content.append(make("h3", "", card.name || "Nog niet bevestigd"));
    content.append(make("p", "release-card__role", card.meta_label || card.position || "Wacht op zichtbare stats"));

    const stats = renderStats(card.stats);
    if (stats.children.length) content.append(stats);

    const meter = make("div", "meta-meter");
    meter.append(make("span", "", "BIBS META-METER"), make("strong", "", card.meta_rating === null || card.meta_rating === undefined ? "—" : `${card.meta_rating}/100`));
    content.append(meter, renderCurrentPrice(card, options.marketData));
    const report = make("details", "player-details");
    const reportTitle = make("summary", "", "Scoutingsrapport ");
    const reportIcon = make("span", "", "+"); reportIcon.setAttribute("aria-hidden", "true");
    reportTitle.append(reportIcon);
    report.append(reportTitle, make("p", "release-card__meta", card.meta_text || "Stats nog niet bevestigd. We gaan er niet op gokken."));
    if (card.meta_basis) report.append(make("p", "release-card__basis", card.meta_basis));
    if (card.release_note) report.append(make("p", "release-card__note", card.release_note));
    content.append(report);
    const source = safeLink(card.source || options.source);
    if (source) content.append(source);
    article.append(visual, content);
    return article;
  }

  function renderRelease(release, marketData) {
    const lane = make("article", `release-lane release-lane--${String(release.kind || "release").toLowerCase()}`);
    const head = make("header", "release-lane__head");
    const copy = make("div", "");
    copy.append(make("p", "kicker", release.window || "DEZE WEEK"), make("h3", "", release.title || kindLabel(release.kind)));
    copy.append(make("p", "release-lane__intro", release.intro || "Wacht op officiële bevestiging."));
    const state = make("span", "release-state", stateLabel(release.status));
    head.append(copy, state);
    lane.append(head);
    const source = safeLink(release.source);
    if (source) lane.append(source);

    const grid = make("div", "release-card-grid");
    const cards = Array.isArray(release.cards) ? release.cards : [];
    if (cards.length) {
      cards.forEach((card) => grid.append(renderCard(card, { kind: release.kind, source: release.source, marketData })));
    } else {
      grid.append(empty("De radar staart nog naar een gesloten pack. Kom terug zodra EA echt iets dropt."));
    }
    lane.append(grid);
    return lane;
  }

  function renderReleaseBoard(releases, marketData) {
    const board = $("#release-board");
    board.replaceChildren();
    if (!releases?.length) {
      board.append(empty("Geen releaseblokken beschikbaar. Geen bron, geen bro-science."));
      return;
    }
    releases.forEach((release) => board.append(renderRelease(release, marketData)));
  }

  function renderDutchGold(data, marketData, metaData) {
    const grid = $("#dutch-gold-grid");
    const rule = $("#dutch-gold-rule");
    const seen = new Set();
    const metaNames = metaPlayerNames(data, metaData);
    const releaseCards = (data.releases || []).flatMap((release) => (release.cards || []).map((card) => ({ ...card, releaseSource: release.source, releaseKind: release.kind })));
    const candidates = [...(data.dutch_gold_watch || []), ...releaseCards]
      .filter(isDutchGold)
      .filter((card) => !metaNames.has(normalizedPlayerName(card.name)))
      .filter((card) => {
        const key = String(card.id || `${card.name}-${card.position}`);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    grid.replaceChildren();
    if (!candidates.length) {
      grid.append(empty("Nog geen bevestigde Nederlandse Gold-kaart op het bord. We gaan er geen uit een pakje trekken."));
    } else {
      candidates.forEach((card) => grid.append(renderCard(card, { dutch: true, kind: card.releaseKind, source: card.releaseSource, marketData })));
    }
    rule.hidden = !data.dutch_gold_rule;
    rule.replaceChildren();
    if (data.dutch_gold_rule) {
      rule.append(make("strong", "", "DE GOUDPASPOORT-REGEL"), make("p", "", data.dutch_gold_rule));
    }
  }

  function renderSbcOfWeek(sbc) {
    const container = $("#sbc-week-card");
    if (!container) return;
    container.replaceChildren();
    const card = make("article", `sbc-card${sbc?.status === "confirmed" ? " sbc-card--confirmed" : ""}`);
    const head = make("header", "sbc-card__head");
    const copy = make("div", "");
    copy.append(make("p", "kicker", sbc?.window || "ZONDAGAVOND · WACHT OP EA"));
    copy.append(make("h3", "", sbc?.title || "Must-do SBC van de week"));
    copy.append(make("p", "sbc-card__summary", sbc?.summary || "Geen officiële SBC-details, dus ook geen geforceerde ‘must do’ uit de duim."));
    head.append(copy, make("span", "sbc-card__status", stateLabel(sbc?.status)));
    card.append(head);
    const reasons = Array.isArray(sbc?.why) ? sbc.why : [];
    if (reasons.length) {
      card.append(make("p", "sbc-card__label", "WAAROM WEL / NIET"));
      const list = make("ul", "sbc-card__reasons");
      reasons.forEach((reason) => list.append(make("li", "", reason)));
      card.append(list);
    }
    if (sbc?.risk) card.append(make("p", "sbc-card__risk", sbc.risk));
    const source = safeLink(sbc?.source);
    if (source) card.append(source);
    container.append(card);
  }

  function render(data, state) {
    const marketData = window.FBSRefresh.get("market").data;
    const metaData = window.FBSRefresh.get("meta").data;
    if (!data) {
      $("#news-mode").textContent = "UPDATE ONBEREIKBAAR";
      $("#news-status-title").textContent = "De nieuwsradar hapert";
      $("#news-status-detail").textContent = "Er is in dit bezoek nog geen release-data geladen. Probeer straks opnieuw.";
      $("#news-updated").textContent = "Nog geen gegevens geladen";
      $("#release-board").replaceChildren(empty("Geen release-data geladen. Ook de leukste chaos heeft een bron nodig."));
      $("#dutch-gold-grid").replaceChildren(empty("Gold Watch is tijdelijk niet bereikbaar."));
      return;
    }
    const releases = Array.isArray(data.releases) ? data.releases : [];
    const cardCount = releases.reduce((total, release) => total + (Array.isArray(release.cards) ? release.cards.length : 0), 0);
    const confirmed = releases.some((release) => release.status === "confirmed");
    if (standaloneNewsPage) document.title = `Nieuws & Releases · de flikkerbibsjes UT Trade watcher`;
    const updated = new Date(data.updated_at || NaN);
    $("#news-updated").textContent = Number.isNaN(updated.getTime()) ? "Bronstatus wordt bijgewerkt" : `Bijgewerkt ${dateFormatter.format(updated)}`;
    $("#news-mode").textContent = state.error ? "UPDATE ONBEREIKBAAR" : state.stale ? "OUDERE BRONDATA" : data.mode === "planning" ? "PLANNER · WACHT OP EA" : "OFFICIËLE BRON GELADEN";
    $("#news-status-title").textContent = confirmed ? `${cardCount} kaarten op het bord` : "De packdeur is nog dicht";
    $("#news-status-detail").textContent = state.error ? "De laatste controle mislukte. Eerder geladen kaartprofielen en releases blijven leesbaar; de brondatum staat erbij." : state.stale ? "Deze publicatie is ouder dan 36 uur. De kaartprofielen blijven ter referentie staan; nieuwe releases zijn nog niet bevestigd." : confirmed
      ? "Elke kaart op dit bord heeft een bron. Nu mogen jullie pas moeilijk gaan doen."
      : (data.notice || "We wachten op de officiële EA-fluit. Tot die tijd geen kaartfantasie.");
    renderSchedule(data.schedule);
    renderReleaseBoard(releases, marketData);
    renderSbcOfWeek(data.sbc_of_week);
    renderDutchGold(data, marketData, metaData);
  }

  let renderedSignature = null;
  function renderLatest(data, state) {
    const market = window.FBSRefresh.get("market");
    const meta = window.FBSRefresh.get("meta");
    const signature = JSON.stringify([data, state.error, state.stale, market.data, market.error, market.stale, meta.data]);
    if (signature === renderedSignature) return;
    render(data, state);
    renderedSignature = signature;
  }

  if (!window.FBSRefresh.has("market")) window.FBSRefresh.register("market", { url: localDashboard ? "/api/dashboard" : "data/current.json", validate: (data) => Array.isArray(data.items) });
  if (!window.FBSRefresh.has("meta")) window.FBSRefresh.register("meta", { url: metaDataUrl, validate: (data) => Array.isArray(data.players) });
  window.FBSRefresh.register("releases", { url: dataUrl, render: renderLatest, validate: (data) => Array.isArray(data.releases) && Array.isArray(data.dutch_gold_watch) });
  document.addEventListener("fbs:data", (event) => {
    if (!["market", "meta"].includes(event.detail.kind)) return;
    const latest = window.FBSRefresh.get("releases");
    if (latest.data) renderLatest(latest.data, latest);
  });
})();
