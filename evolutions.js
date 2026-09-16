(() => {
  "use strict";

  const controls = document.querySelector("#evo-controls");
  const panel = document.querySelector("#evo-panel");
  const status = document.querySelector("#evo-status");
  if (!controls || !panel || !status || !window.FBSRefresh) return;

  const routes = ["intro", "repeatable", "delivery", "camp", "pathway"];
  const labels = { intro: "Starterboost", repeatable: "Spitsen · 2 rondes", delivery: "Vleugelservice", camp: "Training Camp", pathway: "PlayStyle-keuze" };
  const art = {
    "mats-deijl": "assets/evos/mats-deijl-72.webp",
    "guus-til": "assets/evos/guus-til-78.webp",
    "sami-ouaissa": "assets/evos/sami-ouaissa-74.webp",
    "milan-van-ewijk": "assets/evos/milan-van-ewijk-75.webp",
    "justin-kluivert": "assets/evos/justin-kluivert-79.webp",
  };
  const statLabels = { PAC: "Tempo", SHO: "Schieten", PAS: "Passen", DRI: "Dribbelen", DEF: "Verdedigen", PHY: "Fysiek" };
  const dates = new Intl.DateTimeFormat("nl-NL", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Amsterdam" });
  let currentData = null;
  let selected = "intro";
  let buttons = [];

  function text(value) { return typeof value === "string" && value.trim().length > 0 && value.length < 3000; }
  function source(value) {
    try { const url = new URL(value); return url.protocol === "https:" && url.hostname === "www.fut.gg" && !url.username && !url.password; }
    catch (_) { return false; }
  }
  function rating(value) { return Number.isInteger(value) && value >= 1 && value <= 99; }
  function validate(data) {
    return Boolean(data && data.game === "FC27" && text(data.notice)
      && [data.updated_at, data.verified_at, data.review_after].every((date) => typeof date === "string" && Number.isFinite(Date.parse(date)))
      && Date.parse(data.verified_at) <= Date.parse(data.updated_at) && Date.parse(data.review_after) > Date.parse(data.verified_at)
      && Array.isArray(data.evos) && data.evos.length === 5 && new Set(data.evos.map((evo) => evo?.id)).size === 5
      && data.evos.every((evo) => evo && routes.includes(evo.id)
        && [evo.title, evo.summary, evo.cost, evo.effort, evo.caution].every(text)
        && source(evo.source_url) && [1, 2].includes(evo.uses) && [1, 2].includes(evo.rounds)
        && Array.isArray(evo.requirements) && evo.requirements.length > 0 && evo.requirements.every(text)
        && Array.isArray(evo.players) && evo.players.length === 5 && new Set(evo.players.map((player) => player?.id)).size === 5
        && evo.players.every((player) => player && [player.id, player.name, player.position, player.why, player.caution, player.upgrade].every(text)
          && player.nation_code === "NL" && ["male", "female"].includes(player.gender)
          && rating(player.base_rating) && rating(player.rating) && player.rating >= player.base_rating
          && source(player.source_url) && (player.option === null || text(player.option))
          && player.stats && Object.keys(statLabels).every((stat) => player.stats[stat] === null || rating(player.stats[stat])))));
  }
  function el(tag, className, content) {
    const node = document.createElement(tag);
    node.className = className;
    if (content !== undefined) node.textContent = content;
    return node;
  }
  function link(label, url) {
    const node = el("a", "evo-source", `${label} ↗`);
    node.href = url;
    node.target = "_blank";
    node.rel = "noopener noreferrer";
    return node;
  }
  function stats(player, compact = false) {
    const list = el("dl", compact ? "evo-stats evo-stats--compact" : "evo-stats");
    for (const [key, label] of Object.entries(statLabels)) {
      const item = el("div", "evo-stat");
      item.append(el("dt", "", label), el("dd", "", player.stats[key] ?? "—"));
      list.append(item);
    }
    return list;
  }
  function playerDetails(player) {
    const details = el("details", "evo-player-details");
    details.append(el("summary", "", `Stats & aandachtspunt voor ${player.name}`), stats(player, true), el("p", "evo-caution", player.caution), link(`Bekijk ${player.name} op FUT.GG`, player.source_url));
    return details;
  }
  function drawPanel() {
    const evo = currentData.evos.find((item) => item.id === selected);
    const player = evo.players[0];
    const unchanged = evo.id === "camp" || evo.id === "pathway";
    const heading = el("header", "evo-route-head");
    const headingCopy = el("div", "");
    headingCopy.append(el("p", "kicker", "DE ROUTE"), el("h3", "", evo.title), el("p", "evo-summary", evo.summary));
    const facts = el("div", "evo-facts");
    facts.append(el("span", "evo-cost", evo.cost), el("span", "", evo.effort), el("small", "", `${evo.uses} ${evo.uses === 1 ? "toepassing" : "toepassingen"} beschikbaar · basiskaart niet inbegrepen`));
    heading.append(headingCopy, facts);

    const favorite = el("article", "evo-favorite");
    const figure = el("figure", "evo-card-figure");
    figure.append(el("span", "evo-podium", "01 / ONZE FAVORIET"));
    const imagePath = Object.hasOwn(art, player.id) ? art[player.id] : null;
    if (imagePath) {
      const image = el("img", "evo-card-image");
      image.src = imagePath;
      image.alt = `EA FC 27-basiskaart van ${player.name}, ${player.base_rating} OVR — niet de EVO-eindkaart`;
      image.width = 440;
      image.height = 548;
      image.loading = "lazy";
      image.decoding = "async";
      image.addEventListener("error", () => {
        image.hidden = true;
        figure.append(el("p", "evo-image-fallback", "Kaartbeeld niet beschikbaar. De gegevens staan hiernaast."));
      }, { once: true });
      figure.append(image);
    }
    const caption = el("figcaption", "", imagePath ? "Officiële basiskaart · geen EVO-eindkaart" : "Voor deze favoriet is nog geen kaartvoorbeeld toegevoegd.");
    figure.append(caption);
    if (player.id === "sami-ouaissa") figure.append(el("small", "evo-art-note", "EA toont hier een PSV-badge, maar noemt NEC in de biografie. Het clublogo is dus geen clubbevestiging."));
    const report = el("div", "evo-report");
    report.append(el("p", "kicker", `NEDERLAND · ${player.position} · FBS-KEUZE`), el("h4", "evo-player-name", player.name), el("p", "evo-upgrade", player.upgrade));
    if (player.option) report.append(el("p", "evo-option", `Kies ${player.option}`));
    report.append(el("p", "evo-why", player.why), el("p", "evo-stat-label", unchanged ? "Basisstats · deze EVO verhoogt geen stats" : `Verwachte eindstats · ${evo.rounds === 2 ? "na twee rondes" : "na deze EVO"} · FUT.GG`), stats(player), el("p", "evo-caution", `Even opletten: ${player.caution}`), link(`Check ${player.name} op FUT.GG`, player.source_url));
    favorite.append(figure, report);

    const bench = el("section", "evo-bench");
    const benchHeading = el("div", "evo-bench-head");
    benchHeading.append(el("h4", "", "Ook op het sollicitatiegesprek."), el("p", "", "Vier alternatieven. Geen vier extra kaarten in je gezicht."));
    bench.append(benchHeading);
    const alternatives = el("ol", "evo-alternatives");
    alternatives.start = 2;
    evo.players.slice(1).forEach((option, index) => {
      const row = el("li", "evo-alternative");
      const copy = el("div", "evo-alternative-copy");
      const top = el("div", "evo-alternative-top");
      top.append(el("h5", "", option.name), el("span", "evo-alternative-rating", `${option.position} · ${option.base_rating === option.rating ? `${option.rating} OVR` : `${option.base_rating} → ${option.rating}`}`));
      copy.append(top, el("p", "evo-alternative-why", option.why), el("p", "evo-alternative-upgrade", option.option ? `${option.upgrade} · ${option.option}` : option.upgrade), playerDetails(option));
      const rank = el("span", "evo-rank", `0${index + 2}`);
      rank.setAttribute("aria-hidden", "true");
      row.append(rank, copy);
      alternatives.append(row);
    });
    bench.append(alternatives);

    const rules = el("details", "evo-rules");
    rules.append(el("summary", "", "Voorwaarden, bron & kleine lettertjes"));
    const rulesContent = el("div", "evo-rules-content");
    const list = el("ul", "");
    evo.requirements.forEach((rule) => list.append(el("li", "", rule)));
    rulesContent.append(list, el("p", "", evo.caution), el("p", "", currentData.notice), link("Bekijk deze EVO op FUT.GG", evo.source_url));
    rules.append(rulesContent);
    panel.replaceChildren(heading, favorite, bench, rules);
    panel.setAttribute("aria-label", `${evo.title}: ${player.name} en vier alternatieven`);
    buttons.forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.evo === selected)));
  }

  function render(data, state = {}) {
    if (!data) {
      status.textContent = "De EVO-shortlist is even niet bereikbaar. Probeer ‘Ververs alles’ bovenaan.";
      if (!currentData) panel.replaceChildren(el("p", "evo-loading", "Geen gecontroleerde EVO-keuzes beschikbaar. We verzinnen er geen vijf bij."));
      return;
    }
    if (!validate(data)) return;
    currentData = data;
    const stale = state.stale || Date.now() >= Date.parse(data.review_after) || Date.parse(data.verified_at) > Date.now() + 300000;
    status.textContent = `${state.error ? "Verversen mislukt · eerder geladen selectie" : stale ? "Hercontrole nodig · eerdere selectie" : "Databasecheck · niet in-game getest"} · ${dates.format(new Date(data.verified_at))} (Amsterdam). Geen live prijzen.`;
    status.dataset.state = state.error ? "error" : stale ? "stale" : "current";
    if (!buttons.length) {
      buttons = routes.map((id, index) => {
        const button = el("button", "evo-tab");
        button.type = "button";
        button.dataset.evo = id;
        button.setAttribute("aria-controls", "evo-panel");
        button.append(el("span", "evo-tab-number", `0${index + 1}`), el("span", "", labels[id]));
        button.addEventListener("click", () => {
          if (selected === id) return;
          selected = id;
          drawPanel();
        });
        return button;
      });
      controls.replaceChildren(...buttons);
    }
    drawPanel();
  }
  window.FBSRefresh.register("evos", { url: "data/evolutions.json", validate, render });
})();
