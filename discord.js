(() => {
  const joinButton = document.querySelector("#join-discord");
  const title = document.querySelector("#join-title");
  const detail = document.querySelector("#join-detail");
  const status = document.querySelector("#join-status");

  const trustedInvite = (value) => {
    try {
      const url = new URL(value);
      const validHost = url.hostname === "discord.gg" || (url.hostname === "discord.com" && url.pathname.startsWith("/invite/"));
      return url.protocol === "https:" && validHost
        ? url.href
        : null;
    } catch {
      return null;
    }
  };

  const closeInvite = (message) => {
    joinButton.setAttribute("aria-disabled", "true");
    joinButton.removeAttribute("href");
    title.textContent = "De deur staat nog op slot";
    detail.textContent = "Eerst timmeren we de bunker dicht. Daarna krijgen alleen de vier vaste verdachten een tijdelijke sleutel.";
    status.textContent = message;
  };

  fetch("data/community.json", { cache: "no-store" })
    .then((response) => response.ok ? response.json() : Promise.reject(new Error("Community-config ontbreekt.")))
    .then((data) => {
      const invite = trustedInvite(data.discord_invite_url);
      if (!invite) {
        closeInvite(data.invite_status === "closed" ? "De lijst is vol: de vier basisplaatsen zijn bezet." : "Geen openbare invite. We zijn een squad, geen open huis.");
        return;
      }
      joinButton.href = invite;
      joinButton.removeAttribute("aria-disabled");
      title.textContent = "Jullie basisplaats staat klaar";
      detail.textContent = "Tijdelijke sleutel, alleen voor de vaste BIBS-selectie.";
      status.textContent = data.member_limit ? `Max. ${data.member_limit} basisplaatsen — daarna gaat de deur op slot.` : "Invite-only Discord.";
    })
    .catch(() => closeInvite("Invite-status even zoek. Probeer straks nog eens."));
})();
