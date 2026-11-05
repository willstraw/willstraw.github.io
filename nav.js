// Burger menu for phones and small screens: the button opens and closes the nav links
(() => {
  const nav = document.getElementById('nav');
  const toggle = nav.querySelector('.nav-toggle');

  // Show the current page's name in the middle of the bar, taken from its nav link
  const current = nav.querySelector('a[aria-current="page"]');
  if (current) {
    const title = document.createElement('span');
    title.className = 'nav-title';
    title.textContent = current.textContent;
    nav.prepend(title);
  }

  // "WB" initials on the left that link home (only shown on small screens)
  const brand = document.createElement('a');
  brand.className = 'nav-brand';
  brand.href = 'index.html';
  brand.textContent = 'WB';
  brand.setAttribute('aria-label', 'Home');
  nav.prepend(brand);

  function setOpen(open) {
    nav.classList.toggle('open', open);
    toggle.setAttribute('aria-expanded', open);
  }

  toggle.addEventListener('click', () => setOpen(!nav.classList.contains('open')));
  // Close when tapping anywhere outside the menu, or pressing Escape
  document.addEventListener('click', e => { if (!nav.contains(e.target)) setOpen(false); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') setOpen(false); });
})();
