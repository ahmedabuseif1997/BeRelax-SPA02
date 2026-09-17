/* BE RELAX — attribution.js · §10.1–10.5. Loaded by consent.js, only after a
   granted consent. DORMANT without window.BERELAX_ATTRIBUTION_API: no read, no
   write, no request. */
(function () {
  "use strict";

  var API = window.BERELAX_ATTRIBUTION_API;   /* the one switch; unset is how this ships */
  if (typeof API !== "string" || !API) return;
  API = API.replace(/\/+$/, "");

  var KEY = "berelax_attr";
  var WINDOW_MS = 90 * 864e5;   /* the store dies with its FIRST touch, not its last */
  var GAP = 18e5;               /* 30 quiet minutes start a new session */
  var MAX = 10;
  var TRACK = /^(utm_|gclid=|fbclid=|msclkid=|ttclid=|igshid=)/i;
  var SEARCH = /(^|\.)(google|bing|duckduckgo|yahoo|ecosia)\./;
  var SOCIAL = /(^|\.)(instagram|facebook|tiktok|snapchat|twitter|linkedin)\./;

  /* Lengths capped to packages/contracts schemas.ts: an over-long campaign
     costs one field, not the whole beacon to a 422. */
  function clip(s, n) { return s ? String(s).slice(0, n) : undefined; }

  /* Hand-rolled — URLSearchParams and URL are missing on the older iOS Safari
     that still walks through the door, and a malformed %xx throws. */
  function q(k, n) {
    var m = new RegExp("[?&]" + k + "=([^&]*)").exec(location.search);
    try { return m ? clip(decodeURIComponent(m[1].replace(/\+/g, " ")), n) : undefined; }
    catch (e) { return undefined; }
  }
  function host(u) {
    var m = /^[a-z][a-z0-9+.\-]*:\/\/([^\/?#]+)/i.exec(u || "");
    return m ? m[1].replace(/:\d+$/, "").replace(/^www\./i, "").toLowerCase() : "";
  }

  /* Private mode throws on write, blocked storage on read, quota whenever it
     likes. The site does not break because analytics did. */
  function read() {
    try {
      var s = JSON.parse(localStorage.getItem(KEY));
      if (!s || s.v !== 1 || !s.first || !s.last) return null;
      return Date.now() - new Date(s.createdAt).getTime() > WINDOW_MS ? null : s;
    } catch (e) { return null; }
  }
  function write(s) { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) {} }

  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (x) {
      var r = (Math.random() * 16) | 0;
      return (x === "x" ? r : (r & 3) | 8).toString(16);
    });
  }

  function classify() {
    var ref = host(document.referrer), src = q("utm_source", 120), m;
    var t = {
      ts: new Date().toISOString(),
      landing: clip(location.pathname, 300),   /* path only, never the query */
      referrer: clip(ref, 253), campaign: q("utm_campaign", 200),
      term: q("utm_term", 200), content: q("utm_content", 200),
      gclid: q("gclid", 200), fbclid: q("fbclid", 200)
    };
    if (src) { t.source = src; t.medium = q("utm_medium", 60) || "unknown"; }
    else if (t.gclid) { t.source = "google"; t.medium = "cpc"; }
    else if (t.fbclid) { t.source = "facebook"; t.medium = "paid_social"; }
    /* The matched name, not the first label: Instagram and Facebook send most
       of their traffic through l.instagram.com and m.facebook.com. */
    else if ((m = SEARCH.exec(ref))) { t.source = m[2]; t.medium = "organic"; }
    else if ((m = SOCIAL.exec(ref))) { t.source = m[2]; t.medium = "social"; }
    else if (ref && ref !== host(location.href)) { t.source = clip(ref, 120); t.medium = "referral"; }
    else { t.source = "direct"; t.medium = "none"; }
    return t;
  }

  var now = Date.now(), store = read(), touch = classify();

  if (!store) {
    store = { v: 1, visitorId: uuid(), first: touch, last: touch,
      touches: [touch], createdAt: touch.ts, updatedAt: touch.ts };
  } else {
    var fresh = now - new Date(store.updatedAt).getTime() > GAP;
    var moved = touch.source !== store.last.source || touch.medium !== store.last.medium;
    /* A direct hit NEVER overwrites a known last touch: someone who found the
       spa on Google and came back by typing the address was still found on
       Google, and the spend that brought them keeps the credit. */
    if (touch.medium !== "none" && (fresh || moved)) {
      store.last = touch;
      store.touches.push(touch);
      /* Oldest MIDDLE touches drop; first and most recent always survive. */
      if (store.touches.length > MAX) store.touches = [store.touches[0]].concat(store.touches.slice(1 - MAX));
    }
    store.updatedAt = new Date(now).toISOString();
  }

  write(store);
  window.__berelaxAttr = store;   /* the booking form posts this blob whole — §10.3 */

  /* A visitor who never submits a form still counts, and only a response header
     can set the cookie that outlives Safari's seven-day cap on script storage
     (§10.5) — sendBeacon always sends credentials, which is what brings it back.
     The body is the whole store because that is what attributionSchema takes;
     application/json because express.json() parses nothing else. */
  var url = API + "/public/attribution/touch", body = JSON.stringify(store);
  try {
    if (!(navigator.sendBeacon && navigator.sendBeacon(url, new Blob([body], { type: "application/json" }))) && window.fetch) {
      fetch(url, { method: "POST", body: body, credentials: "include", keepalive: true,
        headers: { "Content-Type": "application/json" } }).catch(function () {});
    }
  } catch (e) {}

  /* A shared link should carry no campaign — but keep parameters that are not
     ours rather than flattening the query. */
  if (location.search && history.replaceState) {
    var all = location.search.slice(1).split("&").filter(Boolean), keep = [];
    for (var i = 0; i < all.length; i++) if (!TRACK.test(all[i])) keep.push(all[i]);
    try {
      if (keep.length !== all.length) history.replaceState(null, "",
        location.pathname + (keep.length ? "?" + keep.join("&") : "") + location.hash);
    } catch (e) {}
  }
}());
