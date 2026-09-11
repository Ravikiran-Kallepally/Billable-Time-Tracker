// lib/ripple.js — a minimal, dependency-free Material-style ripple.
// Call attachRipple() once per page. Any element with class "ripple-host"
// (buttons, tabs, snackbar actions) gets a ripple spawned from the pointer
// location on pointerdown, tinted to the element's own text color via
// `currentColor` (see the .ripple rule in theme.css).

export function attachRipple(root = document) {
  root.addEventListener('pointerdown', (e) => {
    if (e.button !== undefined && e.button !== 0) return; // left click / primary touch only
    const host = e.target.closest('.ripple-host');
    if (!host || host.disabled) return;

    const rect = host.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height) * 1.6;
    const ripple = document.createElement('span');
    ripple.className = 'ripple';
    ripple.style.width = ripple.style.height = `${size}px`;
    ripple.style.left = `${e.clientX - rect.left - size / 2}px`;
    ripple.style.top = `${e.clientY - rect.top - size / 2}px`;

    host.appendChild(ripple);
    ripple.addEventListener('animationend', () => ripple.remove());
  });
}
