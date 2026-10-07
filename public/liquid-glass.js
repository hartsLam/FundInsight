(() => {
  const desktop = matchMedia('(min-width: 1024px) and (hover: hover) and (pointer: fine)');
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const reducedTransparency = matchMedia('(prefers-reduced-transparency: reduce)');
  let active = null, frame = 0, latest = null;
  const enabled = () => desktop.matches && !reducedMotion.matches && !reducedTransparency.matches;
  function clear() {
    cancelAnimationFrame(frame); frame = 0; latest = null;
    if (active) {
      active.style.removeProperty('--liquid-angle');
      active.style.removeProperty('--liquid-position');
      active = null;
    }
  }
  function paint() {
    frame = 0;
    if (!enabled() || !active?.isConnected || !latest) { clear(); return; }
    const rect = active.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (latest.x - rect.left) / Math.max(1, rect.width)));
    const y = Math.max(0, Math.min(1, (latest.y - rect.top) / Math.max(1, rect.height)));
    active.style.setProperty('--liquid-angle', `${108 + y * 28}deg`);
    active.style.setProperty('--liquid-position', `${35 + x * 35}%`);
  }
  // Repaint only the surface under a mouse pointer; touch devices have no tracking.
  document.addEventListener('pointermove', event => {
    if (!enabled() || event.pointerType !== 'mouse') { if (active) clear(); return; }
    const target = event.target.closest?.('.panel,.metric,.sage-sidebar,.fund-dialog,.theme-dialog,.chat-window');
    if (target !== active) { clear(); active = target; }
    if (!active) return;
    latest = { x: event.clientX, y: event.clientY };
    if (!frame) frame = requestAnimationFrame(paint);
  }, { passive: true });
  document.documentElement.addEventListener('pointerleave', clear);
  window.addEventListener('blur', clear);
  document.addEventListener('visibilitychange', () => { if (document.hidden) clear(); });
  for (const media of [desktop, reducedMotion, reducedTransparency]) media.addEventListener('change', clear);
})();
