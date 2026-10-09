/* Jade site — four small behaviours, no dependencies. */
(function () {
  "use strict";

  // Header picks up a background once you leave the hero.
  var header = document.querySelector(".site-header");
  if (header) {
    var onScroll = function () {
      header.dataset.stuck = window.scrollY > 32 ? "true" : "false";
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
  }

  // Mobile nav.
  var toggle = document.querySelector(".nav-toggle");
  var actions = document.querySelector(".header-actions");
  if (toggle && actions) {
    var small = window.matchMedia("(max-width: 860px)");
    var sync = function () {
      actions.hidden = small.matches && toggle.getAttribute("aria-expanded") !== "true";
    };
    toggle.addEventListener("click", function () {
      toggle.setAttribute("aria-expanded", String(toggle.getAttribute("aria-expanded") !== "true"));
      sync();
    });
    actions.addEventListener("click", function (e) {
      if (e.target.closest("a") && small.matches) {
        toggle.setAttribute("aria-expanded", "false");
        sync();
      }
    });
    small.addEventListener("change", sync);
    sync();
  }

  // Wall of love — arrows scroll one card at a time.
  var wall = document.getElementById("wall");
  if (wall) {
    document.querySelectorAll("[data-wall]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var card = wall.querySelector(".note");
        var step = card ? card.offsetWidth + 22 : wall.clientWidth * 0.8;
        wall.scrollBy({
          left: btn.dataset.wall === "next" ? step : -step,
          behavior: "smooth"
        });
      });
    });
  }

  // Sections fade up as they arrive.
  var items = document.querySelectorAll(".reveal");
  if (!items.length) return;
  if (!("IntersectionObserver" in window)) {
    items.forEach(function (el) { el.classList.add("in"); });
    return;
  }
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (!entry.isIntersecting) return;
      entry.target.classList.add("in");
      io.unobserve(entry.target);
    });
  }, { rootMargin: "0px 0px -10% 0px", threshold: 0.05 });
  items.forEach(function (el) { io.observe(el); });
})();
