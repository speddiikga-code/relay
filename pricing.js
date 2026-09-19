/* pricing.js — theme toggle + currency switch for the pricing page.
 *
 * Lives in its own file because the page's CSP is `script-src 'self'` with no
 * 'unsafe-inline': an inline <script> is silently blocked, which is exactly the
 * kind of failure that looks like "the button just doesn't work".
 *
 * Keeps the same `relay.theme` storage key as site.js so the theme a visitor
 * picked on the landing page carries over here.
 */
(function () {
  'use strict';

  var $ = function (sel) { return document.querySelector(sel); };

  /* Storage can throw in a private window or with site data blocked, and a
     pricing page that dies on a storage read is a page that takes no money. */
  var store = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) { /* non-fatal */ } }
  };

  /* ---------------- theme ---------------- */
  var THEMES = ['auto', 'light', 'dark'];
  var GLYPH = { auto: '◐', light: '☀', dark: '☾' };
  var themeBtn = $('#theme-toggle');
  var theme = store.get('relay.theme') || 'auto';

  function applyTheme() {
    if (theme === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', theme);
    if (!themeBtn) return;
    themeBtn.textContent = GLYPH[theme];
    themeBtn.setAttribute('aria-label', 'Theme: ' + theme + ' (click to change)');
  }

  if (themeBtn) {
    themeBtn.addEventListener('click', function () {
      theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
      store.set('relay.theme', theme);
      applyTheme();
    });
  }
  applyTheme();

  /* ---------------- currency ----------------
   * Prices are held here rather than in the markup so there is exactly one
   * place to edit them. Keep KRW and USD independently priced — a converted
   * USD figure lands on amounts like $13.42 that read as unconsidered.
   */
  var PRICES = {
    free:     { krw: '₩0',      usd: '$0',  suffix: ' forever' },
    cloud:    { krw: '₩19,000', usd: '$14', suffix: ' / month' },
    business: { krw: 'Talk to us', usd: 'Talk to us', suffix: '' }
  };

  function renderPrices(cur) {
    Object.keys(PRICES).forEach(function (key) {
      var el = document.querySelector('[data-price="' + key + '"]');
      if (!el) return;
      var p = PRICES[key];
      el.textContent = p[cur];
      if (p.suffix) {
        var small = document.createElement('small');
        small.textContent = p.suffix;
        el.appendChild(small);
      }
    });
  }

  var curButtons = Array.prototype.slice.call(document.querySelectorAll('.cur-toggle button'));
  var currency = store.get('relay.currency') || 'krw';

  function applyCurrency() {
    curButtons.forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.dataset.cur === currency));
    });
    renderPrices(currency);
  }

  curButtons.forEach(function (b) {
    b.addEventListener('click', function () {
      currency = b.dataset.cur;
      store.set('relay.currency', currency);
      applyCurrency();
    });
  });

  if (curButtons.length) applyCurrency();

  /* ---------------- checkout ----------------
   * Deliberately a plain navigation to a hosted checkout, not an embedded
   * widget. Stripe.js / Paddle.js would be blocked by this site's CSP, and
   * loosening the CSP to admit them weakens the "this page loads nothing but
   * its own files" guarantee the security model is built on.
   *
   * To go live: set CHECKOUT_URLS to the hosted payment links from your
   * provider (Paddle, Lemon Squeezy, Stripe Payment Links). Leave a value
   * empty and that button keeps its in-page href, which is the waitlist.
   */
  var CHECKOUT_URLS = {
    cloud: ''   // e.g. 'https://pay.example.com/b/xxxxxxxx'
  };

  document.querySelectorAll('[data-checkout]').forEach(function (a) {
    var url = CHECKOUT_URLS[a.dataset.checkout];
    if (!url) return;                 // no link configured — stays a waitlist link
    a.href = url;
    a.rel = 'noopener';
    a.textContent = 'Subscribe';
  });
})();
