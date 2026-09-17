(() => {
  "use strict";
  // Exact FC 27 Gold items observed on EA's public ratings pages.
  // Provenance: assets/cards/sources.json. A different version needs its own art.
  const cards = [
    ["frenkie-de-jong", "228702", 86],
    ["vivianne-miedema", "233746", 87],
    ["ryan-gravenberch", "246104", 85],
    ["virgil-van-dijk", "203376", 88],
    ["jill-roord", "240714", 85],
    ["denzel-dumfries", "233096", 83],
    ["bart-verbruggen", "258498", 81],
    ["mark-flekken", "211738", 77],
    ["donyell-malen", "231447", 83],
    ["brian-brobbey", "251810", 78],
  ];
  // Full item artwork manually selected through FUT.GG's visible download UI.
  // These fixed local files are independent of a payload's arbitrary image URL.
  const totwCards = [
    ["fc27-totw1-lamine-yamal", "https://www.fut.gg/players/277643-lamine-yamal-lamine-yamal/27-67386507/", "totw1-lamine-yamal", 91, "RW", "Lamine Yamal"],
    ["fc27-totw1-marcus-thuram", "https://www.fut.gg/players/228093-marcus-thuram/27-67336957/", "totw1-marcus-thuram", 86, "ST", "Marcus Thuram"],
    ["fc27-totw1-esmee-brugts", "https://www.fut.gg/players/267530-esmee-brugts/27-67376394/", "totw1-esmee-brugts", 85, "LB", "Esmee Brugts"],
    ["fc27-totw1-sven-mijnans", "https://www.fut.gg/players/254789-sven-mijnans/27-67363653/", "totw1-sven-mijnans", 80, "ST", "Sven Mijnans"],
  ];
  const objectiveCards = [
    ["summerville-otw-exhibition", "https://www.fut.gg/objectives/seasonal/88-season-1-ones-to-watch-exhibition/", "otw-crysencio-summerville", 83, "LM", "Crysencio Summerville"],
    ["diomande-otw-exhibition-completionist", "https://futmind.com/objectives/79/season-1:-ones-to-watch-exhibition-completionist", "otw-ousmane-diomande", 83, "CB", "Ousmane Diomandé"],
  ];

  function createImage(slug, alt, family) {
    const image = document.createElement("img");
    image.className = "official-card-art";
    image.dataset.artFamily = family;
    image.src = `assets/cards/${slug}.${family === "gold" ? "webp" : "avif"}`;
    image.alt = alt;
    image.width = family === "gold" ? 440 : 360;
    image.height = family === "gold" ? 548 : 503;
    image.loading = "lazy";
    image.decoding = "async";
    image.addEventListener("error", () => {
      image.closest(".has-official-art")?.classList.remove("has-official-art");
      image.remove();
    }, { once: true });
    return image;
  }

  function exactMatch(player, entries) {
    return entries.find(([id, source, , rating, position]) => player?.id === id
      && player.source?.url === source && Number(player.rating) === rating && player.position === position);
  }

  window.FBSCardArt = Object.freeze({
    create(player, { baseProfile = false, objective = false } = {}) {
      if (!player || (player.game != null && player.game !== "FC27")) return null;
      if (objective) {
        if (baseProfile || player.card_type !== "OTW") return null;
        const match = exactMatch(player, objectiveCards);
        return match ? createImage(match[2], `FC27 OTW-kaart van ${match[5]}, ${match[3]} ALG, via FUT.GG`, "objective") : null;
      }
      if (player.game === "FC27" && player.card_type === "TOTW 1") {
        const match = exactMatch(player, totwCards);
        return match ? createImage(match[2], `FC27 TOTW 1-kaart van ${match[5]}, ${match[3]} ALG, via FUT.GG`, "totw") : null;
      }
      if (!baseProfile) return null;
      if (player.card_type != null && !/^gold(?: watch| rare| common)?$/i.test(player.card_type)) return null;
      const match = cards.find(([slug, id, rating]) =>
        player?.source?.url === `https://www.ea.com/nl/games/ea-sports-fc/ratings/player-ratings/${slug}/${id}`
        && Number(player.rating ?? player.base_rating) === rating);
      if (!match) return null;
      return createImage(match[0], `Officiële EA SPORTS FC 27 Gold-kaart: ${player.name}, ${match[2]} ALG`, "gold");
    },
  });
})();
