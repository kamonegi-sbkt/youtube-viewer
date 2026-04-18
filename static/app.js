(function () {
  const overlay = document.getElementById("player-overlay");
  const iframe = document.getElementById("player-iframe");
  const closeBtn = overlay.querySelector(".player-close");

  function openPlayer(videoId) {
    const src = `https://www.youtube.com/embed/${videoId}?autoplay=1&rel=0&modestbranding=1&playsinline=1`;
    iframe.src = src;
    overlay.hidden = false;
    document.body.style.overflow = "hidden";
  }

  function closePlayer() {
    iframe.src = "";
    overlay.hidden = true;
    document.body.style.overflow = "";
  }

  document.querySelectorAll(".card").forEach((card) => {
    card.addEventListener("click", () => {
      const id = card.dataset.videoId;
      if (id) openPlayer(id);
    });
  });

  closeBtn.addEventListener("click", closePlayer);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closePlayer();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !overlay.hidden) closePlayer();
  });
})();
