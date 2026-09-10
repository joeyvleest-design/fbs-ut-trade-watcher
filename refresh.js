(() => {
  "use strict";

  const resources = new Map();
  const intervalMs = 5 * 60 * 1000;
  const maxAge = { market: 60 * 60 * 1000, marketwatch: 36 * 60 * 60 * 1000, releases: 36 * 60 * 60 * 1000, meta: 7 * 24 * 60 * 60 * 1000 };
  let inFlight = null;
  let lastRefresh = 0;

  function describe(kind, data, error = null, now = Date.now()) {
    const rawDate = kind === "daily" ? data?.checked_at : data?.generated_at || data?.updated_at;
    const timestamp = rawDate ? new Date(rawDate).getTime() : NaN;
    const sourceAt = Number.isFinite(timestamp) && timestamp <= now + 5 * 60 * 1000 ? new Date(timestamp).toISOString() : null;
    const ageMs = sourceAt ? Math.max(0, now - timestamp) : null;
    const dailyExpired = kind === "daily" && data?.date !== new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Amsterdam", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(now));
    const limit = kind === "daily" && data?.status === "candidate" ? maxAge.market : (maxAge[kind] || maxAge.marketwatch);
    const stale = Boolean(error) || dailyExpired || ageMs === null || ageMs > limit;
    let status = !data ? "unavailable" : error ? "unavailable" : stale ? "stale" : "current";
    if (data && !error && kind === "market" && data.mode === "demo") status = "demo";
    else if (data && !error && kind === "market" && data.market_data_licensed !== true) status = "unlicensed";
    return { kind, data, error, sourceAt, ageMs, stale, status };
  }

  function state(kind) {
    const resource = resources.get(kind);
    return { ...describe(kind, resource?.data || null, resource?.error || null), checkedAt: resource?.checkedAt || null, lastSuccessAt: resource?.lastSuccessAt || null };
  }

  function notify(kind) {
    const resource = resources.get(kind);
    const detail = state(kind);
    const signature = JSON.stringify([detail.data, detail.error, detail.status, detail.stale]);
    try {
      if (signature !== resource.renderSignature) {
        resource.render?.(detail.data, detail);
        resource.renderSignature = signature;
      }
    }
    finally { document.dispatchEvent(new CustomEvent("fbs:data", { detail })); }
  }

  async function loadResource(kind, resource) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(resource.url, { cache: "no-store", headers: { Accept: "application/json" }, signal: controller.signal });
      if (!response.ok) throw new Error(`Niet beschikbaar (HTTP ${response.status})`);
      const data = await response.json();
      if (!data || typeof data !== "object" || Array.isArray(data) || (resource.validate && !resource.validate(data))) throw new Error("De update bevat geen bruikbare gegevens.");
      resource.data = data;
      resource.error = null;
      resource.lastSuccessAt = new Date().toISOString();
    } catch (error) {
      resource.error = error?.name === "AbortError" ? "De controle duurde te lang." : typeof error?.message === "string" ? error.message : "De update kon niet worden geladen.";
    } finally {
      clearTimeout(timeout);
      resource.checkedAt = new Date().toISOString();
      notify(kind);
    }
  }

  function refresh(reason = "manual") {
    if (inFlight) return inFlight;
    const button = document.querySelector("#refresh-button");
    const feedback = document.querySelector("#refresh-feedback");
    if (button) { button.disabled = true; button.setAttribute("aria-busy", "true"); }
    if (feedback) feedback.textContent = "Gepubliceerde updates ophalen…";
    document.dispatchEvent(new CustomEvent("fbs:refresh", { detail: { loading: true, reason } }));
    inFlight = Promise.allSettled([...resources].map(([kind, resource]) => loadResource(kind, resource)))
      .then((results) => {
        const failures = [...resources.values()].filter((resource) => resource.error).length;
        const renderFailures = results.filter((result) => result.status === "rejected").length;
        if (feedback) feedback.textContent = failures || renderFailures
          ? "Niet alle updates zijn bereikbaar. Eerder geladen gegevens blijven staan; bekijk de bronstatus."
          : "Controle klaar. Je ziet de laatst gepubliceerde gegevens; de brondatum staat erbij.";
        return [...resources.keys()].map(state);
      })
      .finally(() => {
        lastRefresh = Date.now();
        inFlight = null;
        if (button) { button.disabled = false; button.setAttribute("aria-busy", "false"); }
        document.dispatchEvent(new CustomEvent("fbs:refresh", { detail: { loading: false, reason } }));
      });
    return inFlight;
  }

  window.FBSRefresh = Object.freeze({
    register(kind, options) {
      if (resources.has(kind)) return;
      resources.set(kind, { ...options, data: null, error: null });
    },
    has: (kind) => resources.has(kind),
    get: state,
    describe,
    refresh,
    intervalMs,
  });

  function start() {
    document.querySelector("#refresh-button")?.addEventListener("click", () => refresh("manual"));
    refresh("initial");
    setInterval(() => {
      if (document.visibilityState === "visible") refresh("automatic");
    }, intervalMs);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && Date.now() - lastRefresh >= intervalMs) refresh("return");
    });
  }
  // Deferred scripts run while the document is interactive. Wait until every
  // following deferred renderer has registered before starting the first fetch.
  if (document.readyState !== "complete") document.addEventListener("DOMContentLoaded", start, { once: true });
  else queueMicrotask(start);
})();
