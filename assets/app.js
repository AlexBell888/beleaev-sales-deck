// Cited. — shared client-side JS
(function() {

  // ========== Mobile nav toggle ==========
  const burger = document.querySelector('.nav-burger');
  const links = document.querySelector('.nav-links');
  if (burger && links) {
    burger.addEventListener('click', () => links.classList.toggle('open'));
  }

  // ========== Active nav highlight ==========
  const path = location.pathname.replace(/\/$/, '') || '/';
  document.querySelectorAll('.nav-links a').forEach(a => {
    const href = a.getAttribute('href').replace(/\/$/, '');
    if ((href === '/' && path === '/') ||
        (href !== '/' && (path === href || path.startsWith(href + '/')))) {
      a.classList.add('active');
    }
  });

  // ========== Back-to-top button ==========
  const btt = document.createElement('button');
  btt.className = 'back-to-top';
  btt.setAttribute('aria-label', 'Back to top');
  btt.innerHTML = '↑';
  btt.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
  document.body.appendChild(btt);
  window.addEventListener('scroll', () => {
    btt.classList.toggle('show', window.scrollY > 600);
  }, { passive: true });

  // ========== Cookie consent banner ==========
  function getConsent() {
    try {
      const raw = localStorage.getItem('cited_consent');
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }
  function setConsent(obj) {
    try { localStorage.setItem('cited_consent', JSON.stringify({ ...obj, ts: Date.now() })); } catch {}
  }
  const existing = getConsent();
  if (!existing) {
    const banner = document.createElement('div');
    banner.className = 'consent-banner';
    banner.setAttribute('role', 'dialog');
    banner.setAttribute('aria-label', 'Cookie consent');
    banner.innerHTML = `
      <h4>We use only what we need.</h4>
      <p>Essential cookies are always on. Analytics is privacy-preserving and aggregated — no behavioural tracking, no ad networks. You can change this any time on our <a href="/cookies">Cookie Policy</a> page.</p>
      <div class="consent-actions">
        <button class="btn btn-ghost btn-sm" data-act="reject">Essential only</button>
        <button class="btn btn-primary btn-sm" data-act="accept">Accept all</button>
      </div>`;
    document.body.appendChild(banner);
    requestAnimationFrame(() => banner.classList.add('show'));
    banner.addEventListener('click', (e) => {
      const act = e.target?.dataset?.act;
      if (!act) return;
      setConsent({ analytics: act === 'accept', essential: true });
      banner.classList.remove('show');
      setTimeout(() => banner.remove(), 400);
    });
  }

  // ========== Contact / Snapshot form handler ==========
  document.addEventListener('submit', async (e) => {
    const form = e.target;
    if (!form.matches('[data-cited-form]')) return;
    e.preventDefault();

    const btn = form.querySelector('button[type="submit"]');
    const originalText = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }

    const data = Object.fromEntries(new FormData(form).entries());
    data.source = form.dataset.citedForm || 'contact';

    let ok = false;
    try {
      const resp = await fetch('/api/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
      const json = await resp.json().catch(() => ({ ok: true }));
      ok = resp.ok && json.ok !== false;
    } catch { ok = false; }

    // Render result
    const resultSlot = form.querySelector('[data-form-result]') || form;
    const alert = document.createElement('div');
    alert.className = 'alert ' + (ok ? 'alert-success' : 'alert-error');
    alert.innerHTML = ok
      ? '<strong>✓ Thanks — we got it.</strong> You will hear from us within 2 working days, with your Snapshot arriving 5 working days after that. Check your inbox for a confirmation from hello@cited.agency.'
      : '<strong>Something went wrong.</strong> Please try again, or email hello@cited.agency directly.';
    if (resultSlot !== form) {
      resultSlot.innerHTML = '';
      resultSlot.appendChild(alert);
    } else {
      form.insertBefore(alert, form.firstChild);
    }

    if (ok) {
      // Hide form inputs on success
      form.querySelectorAll('input, select, textarea, button').forEach(el => {
        if (el.type !== 'submit') el.disabled = true;
        else el.style.display = 'none';
      });
    } else if (btn) {
      btn.disabled = false; btn.textContent = originalText;
    }
  });

  // ========== Newsletter subscribe handler ==========
  document.addEventListener('submit', async (e) => {
    const form = e.target;
    if (!form.matches('[data-cited-newsletter]')) return;
    e.preventDefault();
    const btn = form.querySelector('button[type="submit"]');
    const email = form.querySelector('input[type="email"]')?.value;
    if (!email) return;
    if (btn) { btn.disabled = true; btn.textContent = 'Subscribing…'; }
    try {
      await fetch('/api/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Newsletter', email, source: 'newsletter', notes: 'Cited Weekly subscription' })
      });
    } catch {}
    const msg = document.createElement('div');
    msg.className = 'alert alert-success';
    msg.innerHTML = '<strong>✓ You are on the list.</strong> Next issue ships Monday 07:00 UK.';
    form.replaceWith(msg);
  });

  // ========== Reveal on scroll ==========
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver((entries) => {
      entries.forEach(e => {
        if (e.isIntersecting) {
          e.target.classList.add('revealed');
          io.unobserve(e.target);
        }
      });
    }, { threshold: 0.1 });
    document.querySelectorAll('[data-reveal]').forEach(el => io.observe(el));
  }

})();
