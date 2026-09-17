(() => {
  "use strict";

  const statuses = {
    confirmed_official: { label: "OFFICIËLE BRON", icon: "✓" },
    reported: { label: "GEMELD · NIET BEVESTIGD", icon: "↗" },
    rumour: { label: "GERUCHT · ONBEVESTIGD", icon: "?" },
    opinion: { label: "MENING · GEEN NIEUWSFEIT", icon: "✎" },
  };
  const sourceStatuses = { ok: "BEREIKBAAR BIJ CHECK", unavailable: "NIET BEREIKBAAR", manual_only: "ALLEEN HANDMATIG", disabled: "NIET INGESCHAKELD" };
  const dateFormat = new Intl.DateTimeFormat("nl-NL", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Amsterdam" });
  const dayFormat = new Intl.DateTimeFormat("nl-NL", { dateStyle: "medium", timeZone: "UTC" });
  const maximumAge = 36 * 60 * 60 * 1000;
  let expiryTimer = null;

  // Prepared club copy, not generated news. Stable for an Amsterdam calendar
  // week; refreshed through the existing dashboard events, without an API.
  const welcomeMessages = [
    ["De kleedkamer is weer open.", "Schoenen uit, praatjes aan. De bibsies zijn terug. Wie roept dat hij rustig gaat opbouwen, mag dat eerst even onder ede verklaren."],
    ["Nieuwe week. Dezelfde clowns.", "Welkom terug, bibsies. Grootse plannen, twijfelachtige opstellingen en de klassieke uitspraak: ik had hem eigenlijk gisteren moeten verkopen."],
    ["Knalfuifje aan de knoppen.", "Knalfuifje heeft een plan. Dat hadden we vorige keer ook. Pak een stoel en geniet van de persconferentie achteraf."],
    ["Uncle Gerroe opent de bestuursvergadering.", "Agenda: voetbal, coins en waarom het uiteraard aan de verbinding lag. De rondvraag duurt tot iemand toegeeft dat die sliding nergens op sloeg."],
    ["Surimi stokje. Zoute nabeschouwing.", "De analyses zijn pittig, de tackles twijfelachtig en Surimi stokje serveert alles met een snufje zout. Bij deze club worden zelfs de excuses nabesproken."],
    ["vleesbeker is weer wedstrijdklaar.", "Shirt strak, mond groot, wisselbeleid onverklaarbaar. De bibsies verzamelen zich voor een week waarin zelfs de reservekeeper een mening over de trainer heeft."],
    ["Welkom bij FC Grootspraak.", "Vóór de aftrap zijn we tactische genieën. Na afloop bespreken we het gras, de scheidsrechter en werkelijk alles behalve onze eigen beslissingen."],
    ["Vier managers. Eén gedeelde hersencel.", "Knalfuifje, Uncle Gerroe, Surimi stokje en vleesbeker melden zich weer. De hersencel rouleert; excuses voor eventuele vertraging tijdens de overdracht."],
    ["Bibsies, poets die denkbeeldige prijzenkast.", "We spelen voor de eer, zeggen we. Tot iemand één wedstrijd wint en drie werkdagen lang niet meer normaal kan doen."],
    ["De VAR bekijkt de groepschat.", "Na uitvoerig onderzoek: vier overtredingen op het gezonde verstand. De wedstrijd gaat gewoon door. Niemand kon de juiste knop vinden."],
    ["Nieuwe tactiek: iemand anders de schuld.", "De opstelling is rond. De smoesjes ook. Welkom terug bij de bibsies, waar zelfs een gelijke stand om een crisisoverleg vraagt."],
    ["De derde helft begint hier.", "Koffie klaar, ego opgepompt. Vandaag bewijzen we weer dat een uitgebreide analyse en een verstandige beslissing twee totaal verschillende hobby’s zijn."],
  ];
  const clubDayFormat = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Amsterdam", year: "numeric", month: "2-digit", day: "2-digit" });
  function renderWelcome() {
    const title = document.querySelector("#bibs-welcome-title");
    const copy = document.querySelector("#bibs-welcome-copy");
    const label = document.querySelector("#bibs-welcome-label");
    if (!title || !copy || !label) return;
    const now = new Date();
    const parts = Object.fromEntries(clubDayFormat.formatToParts(now).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
    const localDay = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day));
    const monday = localDay - ((new Date(localDay).getUTCDay() + 6) % 7) * 86400000;
    const week = Math.floor((monday - Date.UTC(2026, 8, 14)) / 604800000);
    const prelaunch = now.getTime() < Date.parse("2026-09-16T17:00:00Z");
    const key = prelaunch ? "prelaunch" : String(week);
    if (title.dataset.welcomeWeek === key) return;
    title.dataset.welcomeWeek = key;
    const message = prelaunch
      ? ["Welkom bibsies, het gaat bijna beginnen.", "De clubnaam is geregeld, het verstand ligt op de bank. Trek je wedstrijdonderbroek aan: straks mogen onze coins weer een eigen leven leiden."]
      : welcomeMessages[((week % welcomeMessages.length) + welcomeMessages.length) % welcomeMessages.length];
    title.textContent = message[0]; copy.textContent = message[1];
    label.textContent = prelaunch ? "DE BIBSIES VERZAMELEN · BIJNA AFTRAP" : "DE WEKELIJKSE KLEEDKAMERPRAAT · VANAF " + dayFormat.format(new Date(monday));
  }

  const make = (tag, className, text) => {
    const node = document.createElement(tag);
    node.className = className || "";
    if (typeof text === "string" || typeof text === "number") node.textContent = String(text);
    return node;
  };
  function timestamp(value) {
    if (typeof value !== "string" || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) return null;
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed : null;
  }
  function safeUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password ? url : null;
    } catch (_) { return null; }
  }
  function officialUrl(value) {
    const url = safeUrl(value);
    return Boolean(url && (url.hostname === "ea.com" || url.hostname.endsWith(".ea.com")));
  }
  function sourceLink(url, label, className = "radar-link") {
    const safe = safeUrl(url);
    if (!safe) return null;
    const node = make("a", className, label || "Bekijk de bron");
    node.href = safe.href;
    node.target = "_blank";
    node.rel = "noopener noreferrer";
    return node;
  }
  function dateLine(label, value, fallback = "Niet vastgelegd", precision = "datetime") {
    const row = make("div", "radar-date");
    row.append(make("dt", "", label));
    const content = make("dd");
    const date = timestamp(value);
    if (date) {
      const time = make("time", "", precision === "date" ? `${dayFormat.format(date)} · tijd onbekend` : dateFormat.format(date));
      time.dateTime = date.toISOString();
      content.append(time);
    } else content.append(make("span", "", fallback));
    row.append(content);
    return row;
  }
  function unknownPublication(item) {
    return item.source_id === "editorial" && item.published_at === null && item.published_precision === "unknown";
  }
  function publicationDates(item) {
    return unknownPublication(item)
      ? [dateLine("Publicatiedatum onbekend · gecontroleerd", item.checked_at)]
      : [dateLine("Gepubliceerd", item.published_at, "Niet vastgelegd", item.published_precision), dateLine("Broncheck", item.checked_at)];
  }
  function itemStatus(item) {
    if (!Object.hasOwn(statuses, item.status)) return "reported";
    if (item.status === "confirmed_official" && !officialUrl(item.source?.url) && !officialUrl(item.original_source_url)) return "reported";
    return item.status;
  }
  function classify(data, state, now) {
    const checked = timestamp(data?.checked_at);
    const collectionStale = Boolean(state.error || state.stale || !checked || checked.getTime() > now || now - checked.getTime() > maximumAge);
    const recent = [], archive = [], deadlines = [];
    const seen = new Set();
    for (const item of Array.isArray(data?.items) ? data.items : []) {
      if (!item || typeof item.id !== "string" || !item.id || typeof item.title !== "string" || !item.title.trim() || seen.has(item.id)) continue;
      seen.add(item.id);
      const published = timestamp(item.published_at), itemChecked = timestamp(item.checked_at), expires = timestamp(item.expires_at);
      const unknown = unknownPublication(item);
      let archiveReason = "";
      if (collectionStale) archiveReason = "De laatste radarcontrole is niet actueel of niet bereikbaar.";
      else if (!safeUrl(item.source?.url)) archiveReason = "Een veilige, controleerbare bronlink ontbreekt.";
      else if (!Object.hasOwn(statuses, item.status)) archiveReason = "De bronstatus is niet vastgesteld.";
      else if ((!published && !unknown) || !itemChecked || !expires) archiveReason = "Publicatiedatum, broncheck of hercontrolegrens ontbreekt.";
      else if ((item.published_precision === "unknown" && !unknown) || itemChecked.getTime() > now || (unknown ? expires <= itemChecked : published.getTime() > now || itemChecked < published || expires <= published)) archiveReason = "De brondatums zijn niet betrouwbaar genoeg voor het actuele overzicht.";
      else if (expires.getTime() <= now) archiveReason = "De geplande hercontrolegrens van dit bericht is bereikt.";
      else if (now - itemChecked.getTime() > maximumAge) archiveReason = "De itemcontrole is ouder dan 36 uur.";
      const record = { item, archiveReason, sortAt: (unknown ? itemChecked : published)?.getTime() || 0 };
      (archiveReason ? archive : recent).push(record);
      if (!archiveReason) deadlines.push(expires.getTime(), itemChecked.getTime() + maximumAge + 1);
    }
    const newestFirst = (a, b) => b.sortAt - a.sortAt || a.item.id.localeCompare(b.item.id);
    recent.sort(newestFirst); archive.sort(newestFirst);
    if (!collectionStale && checked) deadlines.push(checked.getTime() + maximumAge + 1);
    return { recent, archive, collectionStale, nextDeadline: Math.min(...deadlines.filter((value) => value > now)) };
  }

  function renderItem(record) {
    const { item, archiveReason } = record;
    const status = itemStatus(item);
    const article = make("article", `radar-card radar-card--${status}${archiveReason ? " radar-card--archived" : ""}`);
    article.dataset.status = status;
    const heading = make("div", "radar-card-top");
    const badge = make("span", "radar-badge", `${statuses[status].icon} ${statuses[status].label}`);
    heading.append(badge);
    if (archiveReason) heading.append(make("span", "radar-archive-label", "ARCHIEF"));
    article.append(heading, make("h3", "", item.title));
    if (typeof item.summary === "string" && item.summary) article.append(make("p", "radar-summary", item.summary));
    if (item.status === "confirmed_official" && status !== item.status) article.append(make("p", "radar-warning", "Officiële bevestiging niet verifieerbaar via een EA-bron. Dit blijft een onbevestigde melding."));
    if (status === "rumour") article.append(make("p", "radar-warning", "Niet bevestigd. Een gerucht is geen kaartrelease en geen koopsein."));
    if (status === "opinion") article.append(make("p", "radar-warning", "Interpretatie van de auteur, geen vastgesteld marktfeit."));
    const impact = typeof item.impact === "string" ? [item.impact] : Array.isArray(item.impact) ? item.impact.filter((value) => typeof value === "string") : [];
    if (impact.length) {
      const box = make("div", "radar-impact");
      box.append(make("strong", "", "Wat betekent dit voor de club?"));
      impact.forEach((text) => box.append(make("p", "", text)));
      article.append(box);
    }
    if (archiveReason) article.append(make("p", "radar-expired", `${archiveReason} Alleen als context; geen actueel signaal.`));
    const dates = make("dl", "radar-dates");
    dates.append(...publicationDates(item), dateLine("Hercontrole uiterlijk", item.expires_at));
    article.append(dates);
    const footer = make("div", "radar-card-links");
    const link = sourceLink(item.source?.url, item.source?.label || "Lees de bron");
    if (link) footer.append(link);
    const original = sourceLink(item.original_source_url, "Oorspronkelijke bron ↗");
    if (original && original.href !== link?.href) footer.append(original);
    article.append(footer);
    return article;
  }

  // These are research questions, never automatically promoted to trade calls.
  const watchTopics = [
    { id: "prices", matches: /\b(web app|companion|marktprijs|marktprijzen)\b/i, title: "De eerste marktmetingen", detail: "Vergelijk dezelfde kaart op hetzelfde platform, met een meetmoment erbij. Eén losse prijs is nog geen trend." },
    { id: "selection", matches: /\b(totw|promo|promokaart|destined for glory)\b/i, title: "Wie haalt de selectie?", detail: "Eerst de officiële selectie en exacte kaartversie controleren. Een voorspelling krijgt hier geen koopknop." },
    { id: "rewards", matches: /\b(seizoenspas|season pass|premium pas|premium pass|sbc|sbcs|objectives?)\b/i, title: "Verdienen of kopen?", detail: "Onderzoek de route via SBC, objective of pas. Vergelijk pas daarna de kosten, speelduur en verhandelbaarheid met een aankoop." },
  ];
  function renderBriefing(data, result) {
    const news = document.querySelector("#briefing-news");
    const watch = document.querySelector("#briefing-watchlist");
    const status = document.querySelector("#briefing-status");
    if (!news || !watch) return;
    news.replaceChildren(); watch.replaceChildren();
    // Prioritize a verified official source, preserving date order within
    // each group. Use exactly the same freshness rules as the full news radar.
    const current = [...result.recent].sort((a, b) => Number(itemStatus(b.item) === "confirmed_official") - Number(itemStatus(a.item) === "confirmed_official"));
    for (const { item } of current.slice(0, 2)) {
      const kind = itemStatus(item), badge = statuses[kind];
      const card = make("article", "briefing-story radar-card--" + kind);
      card.dataset.status = kind;
      card.append(make("span", "radar-badge", badge.icon + " " + badge.label), make("h4", "", item.title));
      if (typeof item.summary === "string") card.append(make("p", "briefing-story-summary", item.summary));
      if (kind !== "confirmed_official") card.append(make("p", "briefing-caution", kind === "opinion" ? "Voorspelling of mening, geen EA-bevestiging." : "Niet officieel bevestigd. Geen koopsein."));
      const dates = make("dl", "briefing-dates");
      dates.append(...publicationDates(item));
      card.append(dates);
      const source = sourceLink(item.source?.url, item.source?.label || "Lees de bron");
      if (source) card.append(source);
      const original = sourceLink(item.original_source_url, "Oorspronkelijke bron ↗");
      if (original && original.href !== source?.href) card.append(original);
      news.append(card);
    }
    let topics = 0;
    for (const topic of watchTopics) {
      const record = current.find(({ item }) => topic.matches.test(item.title + " " + (item.summary || "")));
      if (!record) continue;
      const row = make("li", "briefing-watch-item");
      row.dataset.topic = topic.id;
      row.append(make("span", "briefing-follow", "VOLGEN · GEEN KOOPCALL"), make("h4", "", topic.title), make("p", "", topic.detail));
      const kind = itemStatus(record.item);
      row.append(make("small", "briefing-topic-basis", "Aanleiding: " + statuses[kind].label.toLocaleLowerCase("nl-NL")));
      const source = sourceLink(record.item.source?.url, record.item.title);
      if (source) row.append(source);
      watch.append(row); topics++;
    }
    if (!news.children.length) news.append(make("p", "radar-empty", "Nog geen recente, controleerbare berichten. Eerdere verhalen blijven in het nieuwsarchief; we noemen ze niet opnieuw actueel."));
    if (!topics) watch.append(make("li", "briefing-watch-empty", "Geen actuele onderzoekspunten uit de gecontroleerde berichten. De clubkas hoeft niet uit verveling open."));
    if (status) {
      const checked = timestamp(data?.checked_at);
      status.textContent = (result.collectionStale ? "Geen actuele nieuwscheck beschikbaar" : "Laatste gepubliceerde nieuwscheck") + (checked ? " · " + dateFormat.format(checked) + " · Amsterdam" : "") + ". Nieuw opgehaald is niet hetzelfde als nieuw gepubliceerd.";
      status.dataset.state = result.collectionStale ? "stale" : "current";
    }
  }

  function renderSources(sources, stale) {
    const grid = document.querySelector("#radar-sources-grid");
    if (!grid) return;
    grid.replaceChildren();
    for (const source of Array.isArray(sources) ? sources : []) {
      if (!source || typeof source.name !== "string") continue;
      const known = Object.hasOwn(sourceStatuses, source.status);
      const article = make("article", "radar-source");
      article.dataset.state = known ? source.status : "unknown";
      const heading = make("div", "radar-source-top");
      heading.append(make("h4", "", source.name), make("span", "radar-source-state", known ? sourceStatuses[source.status] : "STATUS ONBEKEND"));
      article.append(heading);
      if (typeof source.detail === "string") article.append(make("p", "radar-source-detail", source.detail));
      if (typeof source.usage_note === "string" && source.usage_note !== source.detail) article.append(make("p", "radar-source-usage", source.usage_note));
      if (stale) article.append(make("p", "radar-source-stale", "Bewaarde bronstatus; geen bevestiging van huidige bereikbaarheid."));
      const dates = make("dl", "radar-source-dates");
      dates.append(dateLine("Laatste poging", source.checked_at, "Geen automatische poging vastgelegd"), dateLine("Laatste geslaagde check", source.last_success_at, "Nog geen geslaagde check"));
      const count = make("div", "radar-date");
      const matches = source.status === "ok" && timestamp(source.checked_at) && Number.isInteger(source.matched_items) && source.matched_items >= 0 ? source.matched_items : null;
      count.append(make("dt", "", "Matches bij laatste check"), make("dd", "", matches === null ? "Niet vastgesteld" : String(matches)));
      dates.append(count); article.append(dates);
      const links = make("div", "radar-card-links");
      const sourceUrl = sourceLink(source.url, "Bron bekijken ↗"), policy = sourceLink(source.policy_url, "Toegangsgrond ↗");
      const terms = sourceLink(source.terms_url, "Gebruiksvoorwaarden ↗");
      if (sourceUrl) links.append(sourceUrl);
      if (policy) links.append(policy);
      if (terms && terms.href !== policy?.href) links.append(terms);
      article.append(links); grid.append(article);
    }
    if (!grid.children.length) grid.append(make("p", "radar-empty", "Bronstatus is nog niet gepubliceerd. Geen stilzwijgende ‘alles groen’ van de redactie."));
    const count = document.querySelector("#radar-source-count");
    if (count) count.textContent = `${Array.isArray(sources) ? sources.filter((source) => source && typeof source.name === "string").length : 0} bronnen`;
  }

  function render(data, state = {}) {
    clearTimeout(expiryTimer);
    renderWelcome();
    const grid = document.querySelector("#radar-grid");
    if (!grid) return;
    const now = Date.now();
    const result = classify(data, state, now);
    renderBriefing(data, result);
    const recent = result.recent.slice(0, 12), archived = result.archive.slice(0, 12 - recent.length);
    grid.replaceChildren(...recent.map(renderItem));
    if (!recent.length) grid.append(make("p", "radar-empty", state.error ? "Nieuwe radar niet bereikbaar. Bewaarde berichten staan hieronder als archief; er is geen nieuw actueel signaal." : "Geen recente, controleerbare berichten. De geruchtenmolen mag even op de bank."));
    const archive = document.querySelector("#radar-archive"), archiveGrid = document.querySelector("#radar-archive-grid");
    if (archiveGrid) archiveGrid.replaceChildren(...archived.map(renderItem));
    if (archive) archive.hidden = !archived.length;
    const archiveCount = document.querySelector("#radar-archive-count");
    if (archiveCount) archiveCount.textContent = `${archived.length} van ${result.archive.length} bewaarde berichten`;
    const status = document.querySelector("#radar-status");
    if (status) {
      const checked = timestamp(data?.checked_at);
      status.textContent = `${result.collectionStale ? "GEEN ACTUELE RADARCHECK" : "LAATSTE GEPUBLICEERDE RADAR"}${checked ? ` · ${dateFormat.format(checked)}` : " · datum onbekend"}`;
      status.dataset.state = result.collectionStale ? "stale" : "current";
    }
    const count = document.querySelector("#radar-count");
    if (count) count.textContent = `${result.recent.length} recente berichten · ${result.archive.length} in archief · maximaal 12 getoond`;
    const notice = document.querySelector("#radar-notice");
    if (notice) notice.textContent = typeof data?.notice === "string" ? data.notice : "Geplande controles van toegestane bronnen; geen continue of volledige internetmonitor.";
    const editorial = document.querySelector("#radar-editorial-note");
    if (editorial) editorial.textContent = typeof data?.editorial_notice === "string" ? data.editorial_notice : "De hercontrolegrens is onze redactionele controletermijn, niet een deadline of aankondiging van EA. Is alleen de publicatiedag bekend, dan tonen we geen verzonnen tijdstip.";
    renderSources(data?.sources, result.collectionStale);
    // FBSRefresh deliberately avoids rendering unchanged payloads. A local
    // expiry timer still retires articles on time, without making any request.
    if (Number.isFinite(result.nextDeadline)) expiryTimer = setTimeout(() => render(data, state), Math.min(2147483647, Math.max(1, result.nextDeadline - now + 1)));
  }

  renderWelcome();
  // Existing refresh notifications also fire for unchanged payloads. This
  // changes the weekly greeting within the regular refresh cycle, not the news.
  document.addEventListener?.("fbs:data", renderWelcome);
  document.addEventListener?.("visibilitychange", renderWelcome);
  window.FBSRefresh.register("radar", {
    url: "data/news-radar.json", render,
    validate: (data) => data.game === "FC27" && Array.isArray(data.items) && Array.isArray(data.sources),
  });
})();
