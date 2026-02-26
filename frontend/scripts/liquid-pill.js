/*
  Liquid Pill Controller (Scoped)
  ================================

  This controller ONLY binds to elements within .liquid-pill containers.
  It does NOT attach to:
  - window
  - document.body
  - Any global scroll hijacking

  Motion contract respected:
  - Expand: click expands the pill (scale + height) with continuity
  - Morph: border radius changes as part of expansion/compression
  - Compress: click again compresses the pill back
  - Settle: all motion eases into stability (no jitter)

  Forbidden transitions avoided:
  - Snap: no instant state jumps; we use continuous interpolation
  - Fade-cut: no fade transitions
  - Teleport: state changes move through space, never appearing elsewhere instantly

  Usage:
  - Only used in the AI/Chatbot section
  - Lives inside a normal .glass-card container
  - "This is where intelligence lives."
*/

(function () {
  'use strict';

  // Only target elements within .liquid-pill containers
  const pills = document.querySelectorAll('.liquid-pill');

  if (!pills.length) return;

  pills.forEach(function(pill) {
    initPillController(pill);
  });

  function initPillController(pill) {
    const viewport = pill.querySelector('.lp-viewport');
    const track = pill.querySelector('[data-track]');
    const modeButtons = Array.from(pill.querySelectorAll('.lp-micro-pill[data-mode]'));
    const panels = Array.from(pill.querySelectorAll('.lp-state'));

    if (!viewport || !track) return;

    // Motion constants
    const cfg = {
      collapsedVh: 26,
      expandedVh: 60,
      collapsedScale: 0.98,
      expandedScale: 1.0,
      collapsedRadius: 34,
      expandedRadius: 22,
      boundaryThreshold: 1.0,
      pressureGain: 0.003,
      maxNudgePx: 14,
      lerpRate: 0.14,
    };

    // State
    let expanded = false;
    let internalScrollActive = false;
    let visualExpand = 0;
    let targetExpand = 0;
    let visualIndex = 0;
    let targetIndex = 0;
    let pressure = 0;
    let pressureDir = 0;
    let nudgePx = 0;
    let animating = false;

    // Utility functions
    function clamp(n, a, b) {
      return Math.max(a, Math.min(b, n));
    }

    function lerp(a, b, t) {
      return a + (b - a) * t;
    }

    function setCssVar(name, value) {
      pill.style.setProperty(name, value);
    }

    function activeIndex() {
      const idx = Math.round(visualIndex);
      return clamp(idx, 0, panels.length - 1);
    }

    function getActivePanelEl() {
      return panels[activeIndex()] || null;
    }

    function updateActivePanelFlags() {
      const idx = activeIndex();
      for (let i = 0; i < panels.length; i++) {
        panels[i].setAttribute('data-active', i === idx ? 'true' : 'false');
      }
    }

    function applyMotionToDom() {
      const hVh = lerp(cfg.collapsedVh, cfg.expandedVh, visualExpand);
      const scale = lerp(cfg.collapsedScale, cfg.expandedScale, visualExpand);
      const radius = lerp(cfg.collapsedRadius, cfg.expandedRadius, visualExpand);

      setCssVar('--lp-h', hVh.toFixed(2) + 'vh');
      setCssVar('--lp-scale', scale.toFixed(4));
      setCssVar('--lp-radius', radius.toFixed(2) + 'px');
      setCssVar('--lp-track-index', String(visualIndex));
      setCssVar('--lp-track-nudge', nudgePx.toFixed(2) + 'px');

      pill.setAttribute('data-expanded', expanded ? 'true' : 'false');
      pill.setAttribute('data-internal-scroll', internalScrollActive ? 'true' : 'false');

      updateActivePanelFlags();
    }

    function settlePressure() {
      pressure = lerp(pressure, 0, 0.18);
      if (Math.abs(pressure) < 0.001) pressure = 0;
      nudgePx = lerp(nudgePx, 0, 0.22);
      if (Math.abs(nudgePx) < 0.05) nudgePx = 0;
    }

    function startAnimation() {
      if (!animating) {
        animating = true;
        requestAnimationFrame(tick);
      }
    }

    function onClick(ev) {
      var t = ev.target;

      // Don't toggle expansion when clicking footer or chat input
      if (t && t.closest) {
        if (t.closest('.lp-footer') || t.closest('.lp-chat-input')) {
          return;
        }
      }

      expanded = !expanded;
      targetExpand = expanded ? 1 : 0;

      // When collapsing, internal scroll must be off
      if (!expanded) {
        internalScrollActive = false;
      }

      startAnimation();
    }

    function isScrollable(el) {
      if (!el) return false;
      return el.scrollHeight > el.clientHeight + 1;
    }

    function canScrollFurther(el, deltaY) {
      if (!el) return false;
      if (!isScrollable(el)) return false;

      var top = el.scrollTop;
      var max = el.scrollHeight - el.clientHeight;

      if (deltaY > 0) return top < max - 1;
      if (deltaY < 0) return top > 1;
      return false;
    }

    function attemptBoundaryCross(dir, deltaY) {
      if (dir !== pressureDir) {
        pressureDir = dir;
        pressure = 0;
      }

      pressure = clamp(pressure + Math.abs(deltaY) * cfg.pressureGain, 0, 1.35);

      // Resistance feedback (felt delay near boundary)
      var sign = dir > 0 ? -1 : 1;
      nudgePx = sign * cfg.maxNudgePx * Math.min(1, pressure);

      // Yield when sustained pressure clears threshold
      if (pressure >= cfg.boundaryThreshold) {
        var maxIndex = panels.length - 1;
        var next = clamp(targetIndex + dir, 0, maxIndex);

        if (next !== targetIndex) {
          targetIndex = next;
        }

        pressure = 0;
        pressureDir = 0;
        nudgePx = 0;
      }

      startAnimation();
    }

    function onWheel(ev) {
      var deltaY = ev.deltaY;

      // Internal scroll requires full expansion
      internalScrollActive = expanded && visualExpand >= 0.98;

      var activeEl = getActivePanelEl();

      // If internal scroll is active and content can scroll, let browser handle it
      if (internalScrollActive && canScrollFurther(activeEl, deltaY)) {
        return;
      }

      // Prevent default and stop propagation - scoped to this pill only
      ev.preventDefault();
      ev.stopPropagation();

      // Use wheel as intent to move between narrative slices
      if (deltaY > 0) {
        attemptBoundaryCross(+1, deltaY);
      } else if (deltaY < 0) {
        attemptBoundaryCross(-1, deltaY);
      }
    }

    function onModeClick(ev) {
      var btn = ev.currentTarget;
      var nextMode = btn.getAttribute('data-mode');

      // Update aria-pressed states
      for (var i = 0; i < modeButtons.length; i++) {
        var b = modeButtons[i];
        var m = b.getAttribute('data-mode');
        b.setAttribute('aria-pressed', m === nextMode ? 'true' : 'false');
      }

      // Map mode to panel index
      var modeMap = {
        'insights': 0,
        'events': 0,
        'summary': 1,
        'earlier': 1,
        'trends': 2,
        'recent': 2
      };

      if (modeMap[nextMode] !== undefined) {
        targetIndex = modeMap[nextMode];
        startAnimation();
      }
    }

    function tick() {
      // Settle: ease motion into stability
      visualExpand = lerp(visualExpand, targetExpand, cfg.lerpRate);
      visualIndex = lerp(visualIndex, targetIndex, cfg.lerpRate);

      // Clamp to avoid drift
      if (Math.abs(visualExpand - targetExpand) < 0.002) visualExpand = targetExpand;
      if (Math.abs(visualIndex - targetIndex) < 0.002) visualIndex = targetIndex;

      settlePressure();
      applyMotionToDom();

      // Check if still animating
      var stillAnimating =
        Math.abs(visualExpand - targetExpand) > 0.001 ||
        Math.abs(visualIndex - targetIndex) > 0.001 ||
        Math.abs(pressure) > 0.001 ||
        Math.abs(nudgePx) > 0.01;

      if (stillAnimating) {
        requestAnimationFrame(tick);
      } else {
        animating = false;
      }
    }

    // Wire events ONLY to this pill's elements (no global listeners)
    pill.addEventListener('click', onClick);
    viewport.addEventListener('wheel', onWheel, { passive: false });

    for (var i = 0; i < modeButtons.length; i++) {
      modeButtons[i].addEventListener('click', onModeClick);
    }

    // Initial render
    applyMotionToDom();
  }
})();
