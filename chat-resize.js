(() => {
  const panel = document.getElementById('chatWindow');
  let saved;
  let preferred;
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  function apply(rect) {
    const width = clamp(rect.width, Math.min(300, innerWidth - 16), innerWidth - 16);
    const height = clamp(rect.height, Math.min(360, innerHeight - 16), innerHeight - 16);
    const left = clamp(rect.left, 8, innerWidth - width - 8);
    const top = clamp(rect.top, 8, innerHeight - height - 8);
    Object.assign(panel.style, { width: `${width}px`, height: `${height}px`, left: `${left}px`, top: `${top}px`, right: 'auto', bottom: 'auto' });
    saved = { width, height, left, top };
  }
  function persist() {
    if (!saved) apply(panel.getBoundingClientRect());
    preferred = { ...saved, xRatio: (saved.left - 8) / Math.max(1, innerWidth - saved.width - 16), yRatio: (saved.top - 8) / Math.max(1, innerHeight - saved.height - 16) };
    try { localStorage.setItem('fund-chat-rect', JSON.stringify(preferred)); } catch {}
  }
  function fitViewport() {
    if (!preferred) return;
    const width = Math.min(preferred.width, innerWidth - 16), height = Math.min(preferred.height, innerHeight - 16);
    apply({ width, height, left: 8 + preferred.xRatio * Math.max(0, innerWidth - width - 16), top: 8 + preferred.yRatio * Math.max(0, innerHeight - height - 16) });
  }
  try {
    const rect = JSON.parse(localStorage.getItem('fund-chat-rect'));
    if (rect && ['width', 'height', 'left', 'top'].every(key => Number.isFinite(rect[key]))) {
      if (Number.isFinite(rect.xRatio) && Number.isFinite(rect.yRatio)) {
        preferred = { ...rect, xRatio: clamp(rect.xRatio, 0, 1), yRatio: clamp(rect.yRatio, 0, 1) }; fitViewport();
      } else { apply(rect); persist(); }
    }
  } catch {}
  function resize(rect, edge, dx, dy) {
    let { left, top, width, height } = rect;
    const right = left + width, bottom = top + height;
    if (edge.includes('w')) { left = clamp(left + dx, 8, right - Math.min(300, innerWidth - 16)); width = right - left; }
    if (edge.includes('e')) width = clamp(width + dx, Math.min(300, innerWidth - 16), innerWidth - left - 8);
    if (edge.includes('n')) { top = clamp(top + dy, 8, bottom - Math.min(360, innerHeight - 16)); height = bottom - top; }
    if (edge.includes('s')) height = clamp(height + dy, Math.min(360, innerHeight - 16), innerHeight - top - 8);
    apply({ left, top, width, height });
  }
  for (const edge of ['n', 's', 'e', 'w', 'nw', 'ne', 'sw', 'se']) {
    const grip = document.createElement('div');
    grip.className = `chat-resize chat-resize-${edge}`;
    grip.dataset.edge = edge;
    grip.title = '拖动调整窗口大小';
    grip.setAttribute('aria-hidden', 'true');
    let drag;
    grip.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      event.preventDefault();
      drag = { rect: panel.getBoundingClientRect(), x: event.clientX, y: event.clientY };
      grip.setPointerCapture(event.pointerId);
      panel.classList.add('chat-resizing');
    });
    grip.addEventListener('pointermove', event => {
      if (drag) resize(drag.rect, edge, event.clientX - drag.x, event.clientY - drag.y);
    });
    const finish = () => { if (drag) persist(); drag = null; panel.classList.remove('chat-resizing'); };
    grip.addEventListener('pointerup', finish);
    grip.addEventListener('pointercancel', finish);
    grip.addEventListener('lostpointercapture', finish);
    panel.append(grip);
  }
  const header = panel.querySelector('.chat-header');
  header.tabIndex = 0;
  header.title = '拖动移动窗口；聚焦后可用方向键移动';
  let moving;
  header.addEventListener('pointerdown', event => {
    if (event.button !== 0 || event.target.closest('button')) return;
    event.preventDefault();
    moving = { rect: panel.getBoundingClientRect(), x: event.clientX, y: event.clientY };
    header.setPointerCapture(event.pointerId);
    panel.classList.add('chat-moving');
  });
  header.addEventListener('pointermove', event => {
    if (!moving) return;
    const r = moving.rect;
    apply({ width: r.width, height: r.height, left: r.left + event.clientX - moving.x, top: r.top + event.clientY - moving.y });
  });
  const stopMoving = () => { if (moving) persist(); moving = null; panel.classList.remove('chat-moving'); };
  for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) header.addEventListener(event, stopMoving);
  header.addEventListener('keydown', event => {
    if (event.target !== header || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault(); const r = panel.getBoundingClientRect(); const step = event.shiftKey ? 40 : 10;
    apply({ width: r.width, height: r.height, left: r.left + (event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0), top: r.top + (event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0) }); persist();
  });
  window.addEventListener('resize', fitViewport);
})();
