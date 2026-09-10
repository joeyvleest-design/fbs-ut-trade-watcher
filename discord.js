(() => {
  const byId = (id) => document.querySelector(`#${id}`);
  const joinButton = byId("join-discord");
  if (!joinButton) return;

  const inviteButton = byId("join-invite");
  const refreshButton = byId("connection-refresh");
  let currentData = {};
  let expiryTimer;
  let loading = false;

  const setText = (id, text) => { const node = byId(id); if (node) node.textContent = text; };
  const validUrl = (value) => {
    if (typeof value !== "string" || value !== value.trim()) return null;
    try {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password && !url.port && !url.search && !url.hash ? url : null;
    } catch { return null; }
  };
  const discordLink = (value, kind, guild) => {
    const url = validUrl(value);
    if (!url || url.hostname !== "discord.com") return null;
    const pattern = kind === "server" ? /^\/channels\/(\d{15,22})\/?$/ : /^\/channels\/(\d{15,22})\/(\d{15,22})\/?$/;
    const parts = url.pathname.match(pattern);
    return parts && (!guild || parts[1] === guild) ? { href: url.href, guild: parts[1] } : null;
  };
  const activeInvite = (data) => {
    if (!["open", "active"].includes(data.invite_status)) return null;
    const url = validUrl(data.discord_invite_url);
    if (!url) return null;
    const isInvite = (url.hostname === "discord.gg" && /^\/[A-Za-z0-9_-]+\/?$/.test(url.pathname))
      || (url.hostname === "discord.com" && /^\/invite\/[A-Za-z0-9_-]+\/?$/.test(url.pathname));
    if (!isInvite) return null;
    if (data.invite_expires_at != null) {
      if (typeof data.invite_expires_at !== "string") return null;
      const expires = Date.parse(data.invite_expires_at);
      if (!Number.isFinite(expires) || expires <= Date.now()) return null;
    }
    return url.href;
  };
  const setLink = (node, url, label, hideIfEmpty = true) => {
    if (!node) return;
    node.hidden = hideIfEmpty && !url;
    node.textContent = label;
    if (url) {
      node.href = url;
      node.removeAttribute("aria-disabled");
    } else {
      node.removeAttribute("href");
      node.setAttribute("aria-disabled", "true");
    }
  };
  const connectionState = (id, state, labels) => {
    const node = byId(id);
    if (!node) return;
    const safeState = ["configured", "verified"].includes(state) ? state : "pending";
    node.dataset.state = safeState;
    node.textContent = labels[safeState];
  };
  const render = (data) => {
    clearTimeout(expiryTimer);
    const server = discordLink(data.discord_server_url, "server");
    const invite = activeInvite(data);
    setLink(joinButton, server?.href || invite, server ? "Open onze Discord ↗" : invite ? "Gebruik de uitnodiging ↗" : "Discord-link volgt", false);
    setLink(inviteButton, server && invite ? invite : null, "Nog geen lid? Gebruik de uitnodiging ↗");
    if (server) {
      setText("join-title", "Jullie kleedkamer staat klaar");
      setText("join-detail", "Al lid? Open de server. Discord controleert zelf of je toegang hebt.");
      setText("join-status", invite ? "De uitnodiging hieronder is openbaar. Deel haar bewust." : "Geen openbare uitnodiging. Nieuwe leden krijgen hun sleutel via de groep.");
    } else if (invite) {
      setText("join-title", "Er ligt een uitnodiging klaar");
      setText("join-detail", "Deze link opent de Discord-uitnodiging. Een uitnodiging op de website is openbaar.");
      setText("join-status", data.invite_expires_at ? "Tijdelijk beschikbaar; Discord bepaalt of de uitnodiging nog geldig is." : "Discord bepaalt of de uitnodiging nog geldig is.");
    } else {
      setText("join-title", "De kleedkamer wacht op haar link");
      setText("join-detail", "Er is nog geen bruikbare serverlink op de site gekoppeld. Vraag de groep om toegang.");
      const expiry = typeof data.invite_expires_at === "string" ? Date.parse(data.invite_expires_at) : NaN;
      setText("join-status", Number.isFinite(expiry) && expiry <= Date.now() ? "De gepubliceerde uitnodiging is verlopen." : "Geen openbare uitnodiging beschikbaar.");
    }

    connectionState("server-connection", server ? "configured" : "pending", { pending: "Link nog niet gekoppeld", configured: "Serverlink beschikbaar", verified: "Serverlink beschikbaar" });
    connectionState("trading-connection", data.automation_status, { pending: "Nog niet gekoppeld", configured: "Ingesteld · nog niet bevestigd", verified: "Testbericht bevestigd" });
    connectionState("chemistry-connection", data.chemistry_status, { pending: "Bot nog niet actief", configured: "Ingesteld · nog niet bevestigd", verified: "Werking bevestigd" });
    setText("chemistry-description", data.chemistry_status === "verified"
      ? "Een screenshot erin, hulp met chemistry en chem styles eruit. Open het kanaal voor de instructies; jullie eigen squadgesprek blijft welkom."
      : "Bespreek je squad, chemistry en chem styles met de groep. Automatisch screenshotadvies komt erbij zodra de bot werkt.");

    const channels = data.channels && typeof data.channels === "object" ? data.channels : {};
    for (const [key, label] of [["chat", "Open chat ↗"], ["trading", "Open trading ↗"], ["chemistry", "Open chemistry ↗"]]) {
      const item = channels[key];
      const channel = server && item?.status === "available" ? discordLink(item.url, "channel", server.guild) : null;
      setLink(byId(`${key}-link`), channel?.href, label);
      const state = byId(`${key}-status`);
      if (state) {
        state.textContent = channel ? "Voor serverleden" : "Kanaallink volgt";
        state.classList.toggle("channel-status--pending", !channel);
        state.classList.toggle("channel-status--available", !!channel);
      }
    }
    if (invite && data.invite_expires_at) {
      const delay = Math.min(Date.parse(data.invite_expires_at) - Date.now(), 2147483647);
      expiryTimer = setTimeout(() => render(currentData), Math.max(0, delay));
    }
  };

  const refresh = async () => {
    if (loading) return;
    loading = true;
    if (refreshButton) refreshButton.disabled = true;
    setText("connection-feedback", "Verbinding controleren…");
    try {
      const response = await fetch("data/community.json", { cache: "no-store" });
      if (!response.ok) throw new Error("Config niet beschikbaar");
      const data = await response.json();
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Config ongeldig");
      currentData = data;
      render(data);
      setText("connection-feedback", "Laatste gepubliceerde verbindingsstatus geladen. Dit is geen live aanwezigheidscheck.");
    } catch {
      currentData = {};
      render({});
      setText("connection-feedback", "De verbindingsstatus is even niet bereikbaar. Probeer opnieuw.");
    } finally {
      loading = false;
      if (refreshButton) refreshButton.disabled = false;
    }
  };
  refreshButton?.addEventListener("click", refresh);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") refresh(); });
  refresh();
})();
