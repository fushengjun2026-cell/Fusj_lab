const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function setupWelcome() {
  const gate = document.querySelector('#landing-gate');
  const button = document.querySelector('#enter-universe');
  if (!gate || !button) return;
  if (document.documentElement.classList.contains('has-entered')) {
    gate.remove();
    return;
  }
  document.body.classList.add('gate-active');
  button.addEventListener('click', () => {
    try { localStorage.setItem('universe-entered', 'true'); } catch (error) {}
    document.cookie = 'universe-entered=true; max-age=31536000; path=/; SameSite=Lax';
    gate.classList.add('is-dismissed');
    document.body.classList.remove('gate-active');
    window.setTimeout(() => gate.remove(), prefersReducedMotion ? 0 : 550);
  }, { once: true });
}

function setupNavigation() {
  const header = document.querySelector('.site-header');
  const toggle = document.querySelector('.menu-toggle');
  if (!header || !toggle) return;
  const activePage = document.body.dataset.page;
  document.querySelector(`[data-nav="${activePage}"]`)?.classList.add('active');
  function closeMenu() {
    header.classList.remove('menu-open');
    toggle.setAttribute('aria-expanded', 'false');
  }
  toggle.addEventListener('click', () => {
    const isOpen = header.classList.toggle('menu-open');
    toggle.setAttribute('aria-expanded', String(isOpen));
  });
  document.addEventListener('click', event => {
    if (!header.contains(event.target)) closeMenu();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') closeMenu();
  });
}

setupWelcome();
setupNavigation();
