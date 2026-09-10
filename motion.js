(() => {
  "use strict";
  const $ = (selector) => document.querySelector(selector);
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  const sourceStates = new Map();
  const observed = new WeakSet();
  let selectedPosition = "all";
  let pausePreference = null;
  try { pausePreference = localStorage.getItem("fbs-motion"); } catch (_) { /* Storage may be disabled. */ }
  let paused = pausePreference === "paused" || reduced.matches;
  const motionAllowed = () => !paused && !reduced.matches;
  const dates = new Intl.DateTimeFormat("nl-NL", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Amsterdam" });
  const labels = { market: "Marktprijzen", marketwatch: "Marketwatch", meta: "Meta Meter", releases: "Releases & Gold Watch" };
  const make = (tag, className, text) => {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  function applyMotionPreference() {
    document.body.classList.toggle("motion-paused", paused || reduced.matches);
    const toggle = $("#motion-toggle");
    if (toggle) {
      toggle.setAttribute("aria-pressed", String(paused || reduced.matches));
      toggle.textContent = reduced.matches ? "Rustige weergave (systeem)" : paused ? "Animaties inschakelen" : "Animaties pauzeren";
    }
  }
  $("#motion-toggle")?.addEventListener("click", () => {
    if (reduced.matches) return;
    paused = !paused;
    try { localStorage.setItem("fbs-motion", paused ? "paused" : "on"); } catch (_) { /* Optional preference. */ }
    applyMotionPreference();
  });
  reduced.addEventListener("change", applyMotionPreference);
  applyMotionPreference();

  const reveal = "IntersectionObserver" in window ? new IntersectionObserver((entries) => {
    entries.forEach(({ target, isIntersecting }) => {
      if (!isIntersecting) return;
      if (motionAllowed()) target.classList.add("is-entering");
      reveal.unobserve(target);
      target.addEventListener("animationend", () => target.classList.remove("is-entering"), { once: true });
    });
  }, { threshold: .09 }) : null;

  function decorateCards() {
    document.querySelectorAll(".section-head, .football-card, .release-card, .pick, .watch, .scout-card, .schedule-card, .club-banner").forEach((node, index) => {
      if (observed.has(node)) return;
      observed.add(node);
      node.style.setProperty("--reveal-delay", `${Math.min(index % 4, 2) * 65}ms`);
      reveal?.observe(node);
      if (node.matches(".football-card, .release-card")) {
        const name = node.querySelector("h3")?.textContent || String(index);
        node.style.viewTransitionName = `fbs-${node.classList.contains("football-card") ? "meta" : "gold"}-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${index}`;
        node.addEventListener("pointermove", (event) => {
          if (!motionAllowed() || event.pointerType !== "mouse") return;
          const rect = node.getBoundingClientRect();
          node.style.setProperty("--tilt-y", `${((event.clientX - rect.left) / rect.width - .5) * 3}deg`);
          node.style.setProperty("--tilt-x", `${((event.clientY - rect.top) / rect.height - .5) * -3}deg`);
          node.style.setProperty("--glow-x", `${(event.clientX - rect.left) / rect.width * 100}%`);
        });
        node.addEventListener("pointerleave", () => {
          node.style.setProperty("--tilt-x", "0deg");
          node.style.setProperty("--tilt-y", "0deg");
        });
      }
    });
    document.querySelectorAll(".football-card__index, .meta-meter").forEach((meter) => {
      const value = Number.parseFloat(meter.querySelector("strong")?.textContent);
      meter.style.setProperty("--score", String(Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0));
    });
  }

  const navLinks = [...document.querySelectorAll(".section-nav a")];
  let scrollFrame = null;
  function updateNavigation() {
    scrollFrame = null;
    let current = navLinks[0];
    navLinks.forEach((link) => {
      const section = $(link.getAttribute("href"));
      if (section && section.getBoundingClientRect().top <= 155) current = link;
    });
    navLinks.forEach((link) => {
      link.classList.toggle("is-active", link === current);
      if (link === current) link.setAttribute("aria-current", "location");
      else link.removeAttribute("aria-current");
    });
    const progress = $("#reading-progress");
    if (progress) {
      const total = document.documentElement.scrollHeight - innerHeight;
      progress.style.transform = `scaleX(${total > 0 ? Math.min(1, scrollY / total) : 0})`;
    }
  }
  const progress = make("div", "reading-progress");
  progress.id = "reading-progress";
  progress.setAttribute("aria-hidden", "true");
  document.body.append(progress);
  window.addEventListener("scroll", () => { if (!scrollFrame) scrollFrame = requestAnimationFrame(updateNavigation); }, { passive: true });
  window.addEventListener("resize", updateNavigation, { passive: true });

  function filterGold(animate = false) {
    const roles = { defence: ["GK", "DM", "CB", "LB", "RB", "LWB", "RWB", "CV", "LV", "RV", "RA", "LA"], midfield: ["CDM", "CM", "CAM", "LM", "RM", "CVM"], attack: ["ST", "CF", "LW", "RW", "SP", "LS", "RS"] };
    const cards = [...document.querySelectorAll("#dutch-gold-grid .release-card")];
    let visible = 0;
    cards.forEach((card) => {
      const position = String(card.dataset.position || "").toUpperCase();
      card.hidden = selectedPosition !== "all" && !roles[selectedPosition]?.includes(position);
      if (!card.hidden) {
        visible += 1;
        if (animate && motionAllowed()) {
          card.animate([{ opacity: .25, transform: "translateY(12px) scale(.98)" }, { opacity: 1, transform: "none" }], { duration: 340, delay: (visible - 1) * 45, easing: "cubic-bezier(.2,.7,.3,1)" });
        }
      }
    });
    if ($("#gold-count")) $("#gold-count").textContent = `${visible} ${visible === 1 ? "speler" : "spelers"} op de radar`;
    if ($("#gold-filter-empty")) $("#gold-filter-empty").hidden = visible > 0 || !cards.length;
    document.querySelectorAll(".filter-button").forEach((button) => {
      const active = button.dataset.position === selectedPosition;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    });
  }
  document.querySelectorAll(".filter-button").forEach((button) => button.addEventListener("click", () => {
    if (selectedPosition === button.dataset.position) return;
    selectedPosition = button.dataset.position;
    if (document.startViewTransition && motionAllowed()) {
      document.startViewTransition(() => filterGold());
    } else filterGold(true);
  }));

  function renderUpdates() {
    const grid = $("#updates-grid");
    if (!grid) return;
    const items = Object.entries(labels).map(([kind, label]) => {
      const state = sourceStates.get(kind);
      const item = make("article", "update-item");
      const status = state?.status || "loading";
      item.dataset.state = state?.error ? "error" : status;
      let description = ({ current: "Brondata beschikbaar", stale: "Oudere brondata", unavailable: "Tijdelijk niet bereikbaar", demo: "Voorbeeldprijzen · geen live feed", unlicensed: "Geen live prijsfeed", loading: "Wordt opgehaald…" })[status];
      if (kind === "releases" && state?.data?.mode === "planning" && !state.error) description = "Planner · wacht op bevestiging";
      if (kind === "meta" && state?.data && !state.error) description = state.stale ? "Basisprofielen · brondata ouder" : "Basisprofielen · referentiedata";
      if (kind === "marketwatch" && ["source_gated", "awaiting_allowed_data"].includes(state?.data?.mode) && !state.error) description = "Wacht op bruikbare bronnen";
      item.append(make("h3", "", label), make("p", "", description || "Status onbekend"));
      const date = state?.sourceAt ? new Date(state.sourceAt) : null;
      const time = make("time", "", date ? `Brondata: ${dates.format(date)}` : "Geen brondatum beschikbaar");
      if (date) time.dateTime = date.toISOString();
      item.append(time);
      return item;
    });
    grid.replaceChildren(...items);
    const states = [...sourceStates.values()];
    const errors = states.filter((state) => state.error).length;
    const old = states.filter((state) => state.stale && state.kind !== "market").length;
    $("#update-summary").textContent = errors ? `${errors} ${errors === 1 ? "onderdeel" : "onderdelen"} tijdelijk niet bereikbaar` : old ? "Oudere brondata · bekijk de laatste publicaties" : states.length === 4 ? "Alle onderdelen geladen · bekijk de brondata" : "Bronstatus laden…";
  }

  const amsterdamParts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Amsterdam", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  function localParts(date) {
    return Object.fromEntries(amsterdamParts.formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
  }
  function amsterdamInstant(year, month, day, hour, minute) {
    const wall = Date.UTC(year, month - 1, day, hour, minute);
    let instant = wall;
    for (let i = 0; i < 2; i += 1) {
      const p = localParts(new Date(instant));
      instant += wall - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    }
    return new Date(instant);
  }
  function nextCheck() {
    if (!$("#next-check")) return;
    const now = new Date();
    const local = localParts(now);
    const slots = [];
    for (let offset = 0; offset < 8; offset += 1) {
      const calendar = new Date(Date.UTC(local.year, local.month - 1, local.day + offset, 12));
      const day = calendar.getUTCDay();
      const makeSlot = (hour, minute, name) => {
        const at = amsterdamInstant(calendar.getUTCFullYear(), calendar.getUTCMonth() + 1, calendar.getUTCDate(), hour, minute);
        if (at > now) slots.push({ at, name, offset });
      };
      makeSlot(8, 0, "De ochtend-Marketwatch");
      if (day === 3) makeSlot(19, 1, "Team of the Week");
      if (day === 5) makeSlot(19, 1, "Vrijdag: nieuwe promo");
      if (day === 0) makeSlot(19, 1, "Mini-releases & SBC van de week");
    }
    const next = slots.sort((a, b) => a.at - b.at)[0];
    if (!next) return;
    const day = next.offset === 0 ? "Vandaag" : next.offset === 1 ? "Morgen" : new Intl.DateTimeFormat("nl-NL", { timeZone: "Europe/Amsterdam", weekday: "long" }).format(next.at);
    const time = new Intl.DateTimeFormat("nl-NL", { timeZone: "Europe/Amsterdam", hour: "2-digit", minute: "2-digit" }).format(next.at);
    $("#next-check").textContent = next.name;
    $("#next-check-time").textContent = `${day} rond ${time} · Amsterdam`;
  }

  document.addEventListener("fbs:data", ({ detail }) => {
    if (!detail?.kind) return;
    sourceStates.set(detail.kind, detail);
    renderUpdates();
    decorateCards();
    filterGold();
    updateNavigation();
  });
  document.addEventListener("fbs:refresh", ({ detail }) => {
    document.body.classList.toggle("is-refreshing", Boolean(detail?.loading));
    if (!detail?.loading && detail?.reason === "manual" && motionAllowed()) {
      $(".update-overview")?.animate([{ opacity: .65, transform: "translateY(5px)" }, { opacity: 1, transform: "none" }], { duration: 450, easing: "ease-out" });
    }
  });
  document.addEventListener("toggle", ({ target: details }) => {
    if (details.tagName !== "DETAILS") return;
    if (!details.open || !motionAllowed()) return;
    [...details.children].filter((node) => node.tagName !== "SUMMARY").forEach((node) => node.animate([{ opacity: .3, transform: "translateY(-5px)" }, { opacity: 1, transform: "none" }], { duration: 280, easing: "ease-out" }));
  }, true);
  decorateCards();
  nextCheck();
  updateNavigation();
  setInterval(() => { if (document.visibilityState === "visible") nextCheck(); }, 60000);
})();
