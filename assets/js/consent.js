/* BE RELAX — consent.js · §11.3. The gate that decides whether attribution.js
   ever loads. DORMANT without window.BERELAX_ATTRIBUTION_API: no banner, no
   footer link, no storage, no script — the page is exactly as it was.

   It is also inert without a privacy-notice version to file the consent
   against. privacy.html is the published source of that string and carries it
   in <meta name="berelax:privacy-version">; see §7 of the README beside this
   file. There is no literal fallback: a consent recorded against a version
   that names no readable document is not proof of anything. */
(function () {
  "use strict";

  if (typeof window.BERELAX_ATTRIBUTION_API !== "string" || !window.BERELAX_ATTRIBUTION_API) return;

  var KEY = "berelax_consent";
  var DOC = window.BERELAX_PRIVACY_URL || "privacy.html";

  /* The version string is stored WITH each consent and is the proof of what the
     guest actually agreed to. It must name a REAL PUBLISHED notice: a consent
     filed against a version that names no document proves nothing, so there is
     deliberately no literal fallback here.

     One published source, two ways to reach it, in this order:

       1. window.BERELAX_PRIVACY_VERSION, set explicitly by the page.
       2. <meta name="berelax:privacy-version" content="..."> in this page's
          head — which is what privacy.html itself carries, so the published
          notice states its own version and the page that shows it cannot drift
          from the page a guest can read.

     Neither set? The gate does not open: no banner, no storage, no script. That
     is the safe failure. See assets/js/README.md §7. (This script is loaded with
     defer, so the head is parsed before the meta tag is read.) */
  function published() {
    var m;
    try { m = document.querySelector('meta[name="berelax:privacy-version"]'); } catch (e) { m = null; }
    return m ? (m.getAttribute("content") || "").replace(/^\s+|\s+$/g, "") : "";
  }
  var VER = typeof window.BERELAX_PRIVACY_VERSION === "string" && window.BERELAX_PRIVACY_VERSION
          ? window.BERELAX_PRIVACY_VERSION
          : published();
  if (!VER) {
    if (window.console && console.error) {
      console.error("BE RELAX consent: no privacy-notice version. The banner will not " +
        "be shown and nothing will be stored. Set window.BERELAX_PRIVACY_VERSION to the " +
        "version published in privacy.html, or copy privacy.html's " +
        '<meta name="berelax:privacy-version"> tag into this page. See assets/js/README.md.');
    }
    return;
  }
  var SRC = window.BERELAX_ATTRIBUTION_SRC || "assets/js/attribution.js";

  /* Injected rather than added to the site stylesheet, so removing the two
     script tags leaves no orphan rules. Colours read the site's own custom
     properties and fall back to their literals. One class serves both answers:
     Accept and Decline cannot drift apart later. */
  var CSS =
    ".brx-c,.brx-c-link{font-family:var(--sans,-apple-system,Helvetica,Arial,sans-serif)}" +
    ".brx-c{position:fixed;left:0;right:0;bottom:0;z-index:95;padding:17px 16px;padding-bottom:calc(17px + env(safe-area-inset-bottom));background:var(--mint-50,#FBF6EF);color:var(--ink,#26241F);border-top:1px solid var(--line,#E6D8C4);box-shadow:0 -12px 40px rgba(58,40,26,.14);animation:brx-in .3s cubic-bezier(.4,0,.2,1)}" +
    ".brx-c>div{max-width:620px;margin:0 auto}" +
    ".brx-c h2{font-family:var(--serif,Georgia,serif);font-weight:400;font-size:21px;line-height:1.2;margin:0 0 7px}" +
    ".brx-c p{margin:0 0 15px;font-size:13.5px;line-height:1.6;font-weight:300;color:var(--muted,#6E675D)}" +
    ".brx-c a{color:var(--mint-700,#2A6E66);text-decoration:underline}" +
    ".brx-c-row{display:grid;gap:10px}" +
    ".brx-c-btn{font:inherit;font-size:12px;font-weight:500;letter-spacing:.14em;text-transform:uppercase;padding:13px 20px;border-radius:999px;cursor:pointer;border:1px solid var(--mint-600,#3E9A8E);background:var(--white,#fff);color:var(--mint-800,#2A2724)}" +
    ".brx-c-btn:hover{background:var(--mint-100,#F5EDE1)}" +
    ".brx-c-link{background:none;border:0;padding:0;font-size:13px;color:inherit;cursor:pointer;text-decoration:underline}" +
    ".brx-c-link:hover{color:#fff}" +
    ".brx-c-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}" +
    ".brx-c-btn:focus,.brx-c-link:focus{outline:2px solid var(--sand,#C08A43);outline-offset:3px}" +
    /* A browser without :focus-visible skips the next rule and keeps the ring. */
    ".brx-c-btn:focus:not(:focus-visible),.brx-c-link:focus:not(:focus-visible){outline:0}" +
    "@keyframes brx-in{from{transform:translateY(100%)}}" +
    "@media(min-width:620px){.brx-c-row{grid-template-columns:1fr 1fr}}" +
    "@media(prefers-reduced-motion:reduce){.brx-c{animation:none}}" +
    /* Dark mode borrows the site's own dark surface — its footer. */
    "@media(prefers-color-scheme:dark){.brx-c{background:var(--mint-900,#1B1A17);color:#F1E7D8;border-top-color:rgba(192,138,67,.34)}.brx-c p{color:#C7B49A}.brx-c a{color:var(--mint-500,#5FB8AC)}.brx-c-btn{background:transparent;color:#F1E7D8;border-color:rgba(241,231,216,.5)}}";

  function put(v) { try { localStorage.setItem(KEY, v + "|" + VER); } catch (e) {} }
  var saved;
  try { saved = (localStorage.getItem(KEY) || "").split("|"); } catch (e) { saved = []; }
  var choice = saved[1] === VER ? saved[0] : "";   /* a newer notice re-asks */

  var box = null, back = null, fab = null, ring = [], status = null, loaded = false;

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text) n.appendChild(document.createTextNode(text));
    return n;
  }

  function load() {
    if (loaded) return;
    loaded = true;
    var s = document.createElement("script");
    s.src = SRC; s.defer = true;
    document.body.appendChild(s);
  }

  /* Withdrawal undoes what the browser can. The server's httpOnly mirror cookie
     is not ours to delete — see README. */
  function forget() {
    try { localStorage.removeItem("berelax_attr"); } catch (e) {}
    window.__berelaxAttr = null;
  }

  function trap(e) {
    /* Escape is neither consent nor refusal: it closes, stores nothing, loads
       nothing, and we ask again next visit. */
    if (e.key === "Escape" || e.keyCode === 27) { close(); return; }
    if (e.key !== "Tab" && e.keyCode !== 9) return;
    var i = ring.indexOf(document.activeElement);
    e.preventDefault();
    ring[i < 0 ? 0 : (i + (e.shiftKey ? ring.length - 1 : 1)) % ring.length].focus();
  }

  function close() {
    if (!box) return;
    document.removeEventListener("keydown", trap, true);
    box.parentNode.removeChild(box);
    box = null;
    if (fab) { fab.style.bottom = ""; fab = null; }
    if (back && back.focus) back.focus();   /* focus goes back where it came from */
  }

  function decide(yes) {
    put(yes ? "granted" : "denied");
    close();
    if (yes) load(); else forget();
    if (status) status.textContent = yes ? "Analytics on. You can change this from the footer."
                                        : "Analytics off. Nothing is stored.";
  }

  function open() {
    if (box) return;
    back = document.activeElement;
    box = el("div", "brx-c");
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    box.setAttribute("aria-labelledby", "brx-c-t");
    box.setAttribute("aria-describedby", "brx-c-d");

    var wrap = el("div");
    var head = el("h2", "", "Before we count this visit");
    head.id = "brx-c-t";
    var copy = el("p", "", "With your permission we keep a random ID on this device for 90 days " +
      "and remember how you arrived — a search, an advert, a link. No name, no number, nothing " +
      "you type. Booking and WhatsApp work exactly the same either way. ");
    copy.id = "brx-c-d";
    var link = el("a", "", "Privacy notice");
    link.href = DOC;
    copy.appendChild(link);

    var row = el("div", "brx-c-row");
    var yes = el("button", "brx-c-btn", "Accept");
    var no = el("button", "brx-c-btn", "Decline");
    yes.type = no.type = "button";
    yes.onclick = function () { decide(1); };
    no.onclick = function () { decide(0); };   /* one click, not a settings journey */
    row.appendChild(yes); row.appendChild(no);

    wrap.appendChild(head); wrap.appendChild(copy); wrap.appendChild(row);
    box.appendChild(wrap);
    document.body.appendChild(box);

    /* Lift the WhatsApp button clear of the sheet. A banner sitting on top of
       the one control a guest came to tap would gate a booking on analytics. */
    fab = document.querySelector(".fab");
    if (fab) fab.style.bottom = ((box.offsetHeight || 0) + 16) + "px";

    ring = [link, yes, no];
    document.addEventListener("keydown", trap, true);
    yes.focus();
  }

  function start() {
    var css = document.createElement("style");
    css.textContent = CSS;
    document.head.appendChild(css);

    /* The persistent way back in: consent must be as easy to withdraw as it was
       to give, so this sits in the footer whatever the visitor chose. */
    var seat = document.querySelector(".f-bottom") || document.querySelector("footer .wrap") || document.body;
    var slot = el("span");
    var again = el("button", "brx-c-link", "Analytics choice");
    again.type = "button";
    again.onclick = open;
    status = el("span", "brx-c-sr");
    status.setAttribute("aria-live", "polite");
    slot.appendChild(again); slot.appendChild(status);
    seat.appendChild(slot);

    if (choice === "granted") load();
    else if (choice !== "denied") open();
  }

  /* Nothing here gates the booking form or the WhatsApp buttons: those are
     contract necessity, and holding a booking hostage to analytics would
     invalidate the consent anyway. */
  /* reopen() is the public name: privacy.html's "Manage your choice" control
     looks for it and stays hidden when this script is dormant. open() is kept
     as an alias so nothing that already calls it breaks. version is exposed so
     a page can show the string a consent would be filed against. */
  window.__berelaxConsent = {
    reopen: open, open: open, version: VER,
    grant: function () { decide(1); }, deny: function () { decide(0); }
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
}());
