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
      let archiveReason = "";
      if (collectionStale) archiveReason = "De laatste radarcontrole is niet actueel of niet bereikbaar.";
      else if (!safeUrl(item.source?.url)) archiveReason = "Een veilige, controleerbare bronlink ontbreekt.";
      else if (!Object.hasOwn(statuses, item.status)) archiveReason = "De bronstatus is niet vastgesteld.";
      else if (!published || !itemChecked || !expires) archiveReason = "Publicatiedatum, broncheck of hercontrolegrens ontbreekt.";
      else if (published.getTime() > now || itemChecked.getTime() > now || itemChecked < published || expires <= published) archiveReason = "De brondatums zijn niet betrouwbaar genoeg voor het actuele overzicht.";
      else if (expires.getTime() <= now) archiveReason = "De geplande hercontrolegrens van dit bericht is bereikt.";
      else if (now - itemChecked.getTime() > maximumAge) archiveReason = "De itemcontrole is ouder dan 36 uur.";
      const record = { item, archiveReason, published: published?.getTime() || 0 };
      (archiveReason ? archive : recent).push(record);
      if (!archiveReason) deadlines.push(expires.getTime(), itemChecked.getTime() + maximumAge + 1);
    }
    const newestFirst = (a, b) => b.published - a.published || a.item.id.localeCompare(b.item.id);
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
    dates.append(dateLine("Gepubliceerd", item.published_at, "Niet vastgelegd", item.published_precision), dateLine("Broncheck", item.checked_at), dateLine("Hercontrole uiterlijk", item.expires_at));
    article.append(dates);
    const footer = make("div", "radar-card-links");
    const link = sourceLink(item.source?.url, item.source?.label || "Lees de bron");
    if (link) footer.append(link);
    const original = sourceLink(item.original_source_url, "Oorspronkelijke bron ↗");
    if (original && original.href !== link?.href) footer.append(original);
    article.append(footer);
    return article;
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
    const grid = document.querySelector("#radar-grid");
    if (!grid) return;
    const now = Date.now();
    const result = classify(data, state, now);
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

  window.FBSRefresh.register("radar", {
    url: "data/news-radar.json", render,
    validate: (data) => data.game === "FC27" && Array.isArray(data.items) && Array.isArray(data.sources),
  });
})();
