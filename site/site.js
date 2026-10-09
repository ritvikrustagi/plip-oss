/* Jade site — three small behaviours, no dependencies. */
(function () {
  "use strict";

  // Header gets a hairline + tightens once you scroll past the top.
  var header = document.querySelector(".site-header");
  if (header) {
    var onScroll = function () {
      header.dataset.stuck = window.scrollY > 24 ? "true" : "false";
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
      if (small.matches) {
        actions.hidden = toggle.getAttribute("aria-expanded") !== "true";
      } else {
        actions.hidden = false;
      }
    };
    toggle.addEventListener("click", function () {
      var open = toggle.getAttribute("aria-expanded") === "true";
      toggle.setAttribute("aria-expanded", String(!open));
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
  }, { rootMargin: "0px 0px -12% 0px", threshold: 0.08 });
  items.forEach(function (el) { io.observe(el); });
})();
