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
  window.FBSCardArt = Object.freeze({
    create(player, { baseProfile = false } = {}) {
      if (!baseProfile) return null;
      const match = cards.find(([slug, id, rating]) =>
        player?.source?.url === `https://www.ea.com/nl/games/ea-sports-fc/ratings/player-ratings/${slug}/${id}`
        && Number(player.rating ?? player.base_rating) === rating);
      if (!match) return null;
      const image = document.createElement("img");
      image.className = "official-card-art";
      image.src = `assets/cards/${match[0]}.webp`;
      image.alt = `Officiële EA SPORTS FC 27 Gold-kaart: ${player.name}, ${match[2]} ALG`;
      image.width = 440;
      image.height = 548;
      image.loading = "lazy";
      image.decoding = "async";
      image.addEventListener("error", () => {
        image.closest(".has-official-art")?.classList.remove("has-official-art");
        image.remove();
      }, { once: true });
      return image;
    },
  });
})();
