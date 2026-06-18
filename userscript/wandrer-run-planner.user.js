// ==UserScript==
// @name         Wandrer Run Planner
// @namespace    https://github.com/aslan91/wandrer-run-planner
// x-release-please-start-version
// @version      0.15.0
// x-release-please-end-version
// @description  Plan runs that maximize untravelled (Wandrer red) paths within a target distance. Reads travelled data natively on wandrer.earth's Big Map, or from the Wandrer overlay on Strava's route builder.
// @match        https://www.strava.com/routes*
// @match        https://www.strava.com/maps*
// @match        https://www.strava.com/athlete/maps*
// @match        https://wandrer.earth/dashboard/my_places_iframe/*
// @homepageURL  https://github.com/aslan91/wandrer-run-planner
// @supportURL   https://github.com/aslan91/wandrer-run-planner/issues
// @updateURL    https://raw.githubusercontent.com/aslan91/wandrer-run-planner/main/userscript/wandrer-run-planner.user.js
// @downloadURL  https://raw.githubusercontent.com/aslan91/wandrer-run-planner/main/userscript/wandrer-run-planner.user.js
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      127.0.0.1
// @connect      localhost
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  // ----------------------------------------------------------------------
  // Config
  // ----------------------------------------------------------------------
  // Use 127.0.0.1 (not "localhost"): on Windows, "localhost" often resolves to
  // IPv6 ::1 first, but uvicorn binds IPv4 127.0.0.1 only -> connection refused.
  const BACKEND = "http://127.0.0.1:8000/plan";

  // The script runs in the userscript manager's SANDBOX (because @grant is set),
  // where `window` is NOT the page's real window: the DOM is shared, but page
  // JS globals — crucially `mapboxgl` and any live map instance — live on the
  // REAL window, exposed here as `unsafeWindow`. We must hook/read maps through
  // that page window; the sandbox `window` has no `mapboxgl`. (Confirmed on
  // wandrer.earth: sandbox sees `mapboxgl global=false`, page has it.)
  const PAGE = (typeof unsafeWindow !== "undefined" && unsafeWindow) || window;

  // ----------------------------------------------------------------------
  // Site adapters
  //
  // The planner reads "travelled" geometry off a live Mapbox GL map. The two
  // supported sites expose that data differently, so a per-site adapter isolates
  // the only differences; everything else (map discovery, planning, GPX export)
  // is shared.
  //
  //  - strava : the Wandrer *overlay* browser extension injects vector sources
  //             into Strava's route-builder map. Sources are auto-detected by
  //             regex and travelled is inferred from source/layer name or
  //             per-feature properties. Strava's route builder additionally lets
  //             us create the planned route directly (manual-mode replay).
  //  - wandrer: wandrer.earth's own Big Map (a same-origin iframe) is the
  //             canonical data source. Travelled-on-foot lives entirely in known
  //             source/source-layer pairs, each feature tagged with its OSM way
  //             id (osm_id_str). There is no route builder, so GPX export only.
  // ----------------------------------------------------------------------
  const ADAPTERS = {
    strava: {
      id: "strava",
      siteName: "Strava",
      canCreate: true,
      // Overlay auto-detection knobs (Wandrer extension on Strava's map).
      overlay: {
        // A source is considered a Wandrer overlay if its id or tile URLs match.
        SOURCE_MATCH: /wandrer/i,
        // Prefer sources for this activity when several Wandrer sources exist.
        ACTIVITY_MATCH: /run|foot|walk|hike/i,
        // Wandrer splits travelled vs untravelled into separate sources/layers,
        // so a source/source-layer whose name implies "travelled" means EVERY
        // feature in it is travelled (no per-feature property needed).
        TRAVELLED_NAME: /travel/i,
        UNTRAVELLED_NAME: /untravel|not.?travel|undone|missing/i,
        // Fallback only: if a source is NOT split by name, a feature counts as
        // travelled when any of these properties is truthy.
        TRAVELLED_KEYS: ["traveled", "travelled", "achieved", "done", "v"],
        // Optional manual override if auto-detection picks the wrong source.
        FORCE_SOURCE_ID: "",
      },
    },
    wandrer: {
      id: "wandrer",
      siteName: "Wandrer",
      canCreate: false,
      // Native source list (ordered by preference). Every feature in these
      // source/source-layer pairs is travelled-on-foot. `osm_id_str` is the real
      // OSM way id; `way_id` is a Wandrer-internal composite ("47a…/47a…/0") and
      // must NOT be parsed as an OSM id.
      native: {
        TRAVELLED_SOURCES: [
          { source: "foot-source", sourceLayer: "se" },
          { source: "combined-foot-source", sourceLayer: "se" },
        ],
        OSM_ID_KEYS: ["osm_id_str", "osm_id"],
      },
    },
  };

  // Pick the adapter for the current site. The wandrer adapter runs inside the
  // Big Map iframe (host wandrer.earth); everything else defaults to Strava.
  function detectSite() {
    if (/(^|\.)wandrer\.earth$/i.test(location.hostname)) return ADAPTERS.wandrer;
    return ADAPTERS.strava;
  }
  const SITE = detectSite();

  // Active overlay-detection config for the Strava read path. Unused on wandrer
  // (which reads explicit native sources) but kept defined so the shared
  // overlay helpers below always have a config to reference.
  const WANDRER = SITE.overlay || ADAPTERS.strava.overlay;

  // Does a source/source-layer NAME imply its features are travelled?
  function nameImpliesTravelled(name) {
    if (!name) return false;
    return WANDRER.TRAVELLED_NAME.test(name) && !WANDRER.UNTRAVELLED_NAME.test(name);
  }

  // Is a feature's property bag marked travelled?
  function isTravelled(props) {
    if (!props) return false;
    for (const k of WANDRER.TRAVELLED_KEYS) {
      const val = props[k];
      if (val === true || val === 1 || val === "1" || val === "true") return true;
    }
    return false;
  }

  // ----------------------------------------------------------------------
  // Find the Strava Mapbox GL map instance.
  //
  // Strava bundles Mapbox GL inside a module closure (React app), so the map is
  // not on a global or a DOM property. We therefore:
  //   1. check a few known globals,
  //   2. capture instances via a Map-constructor hook (if mapboxgl is global),
  //   3. walk the React fiber tree from the map canvas and search the object
  //      graph for anything that quacks like a Mapbox GL map.
  // The result is cached.
  // ----------------------------------------------------------------------
  let cachedMap = null;

  function looksLikeMap(o) {
    return (
      o &&
      typeof o === "object" &&
      typeof o.getCenter === "function" &&
      typeof o.querySourceFeatures === "function" &&
      typeof o.getStyle === "function"
    );
  }

  // Record a map instance the first time we see one quack like a Mapbox map.
  function rememberMap(m) {
    try {
      window.__wrpMaps = window.__wrpMaps || [];
      if (looksLikeMap(m) && !window.__wrpMaps.includes(m)) window.__wrpMaps.push(m);
    } catch (_e) { /* ignore */ }
  }

  // Patch the prototype render loop so an ALREADY-created map (one made in a
  // closure before our hook ran — e.g. wandrer.earth's map) is still captured:
  // it records `this` the next time the map paints/resizes. This is the
  // timing-independent capture that the constructor hook alone can miss.
  function patchMapProto(MapCtor) {
    const proto = MapCtor && MapCtor.prototype;
    if (!proto || proto.__wrpProtoHooked) return;
    for (const name of ["_render", "triggerRepaint", "resize"]) {
      const orig = proto[name];
      if (typeof orig !== "function") continue;
      const wrapped = function (...a) { rememberMap(this); return orig.apply(this, a); };
      try { proto[name] = wrapped; } catch (_e) { /* ignore */ }
    }
    try { proto.__wrpProtoHooked = true; } catch (_e) { /* ignore */ }
  }

  function wrapMapbox(mb) {
    if (!mb || !mb.Map) return;
    patchMapProto(mb.Map);
    if (mb.Map.__wrpHooked) return;
    const Orig = mb.Map;
    function Wrapped(...args) {
      const m = new Orig(...args);
      rememberMap(m);
      return m;
    }
    Wrapped.prototype = Orig.prototype;
    Object.setPrototypeOf(Wrapped, Orig);
    Wrapped.__wrpHooked = true;
    try { mb.Map = Wrapped; } catch (_e) { /* ignore */ }
  }

  // Install a constructor hook so future map creations (e.g. after reload) are
  // captured, and patch the prototype of any mapboxgl already present. We hook
  // the PAGE window (unsafeWindow) because that is where mapboxgl actually lives;
  // the sandbox `window` is also hooked in case the manager is not sandboxed.
  (function hookMapboxCtor() {
    window.__wrpMaps = window.__wrpMaps || [];
    const install = (host) => {
      if (!host) return;
      try {
        let mb = host.mapboxgl;
        wrapMapbox(mb);
        Object.defineProperty(host, "mapboxgl", {
          configurable: true,
          get() { return mb; },
          set(v) { mb = v; wrapMapbox(v); },
        });
      } catch (_e) {
        // mapboxgl already non-configurable/absent — still patch what's there.
        try { wrapMapbox(host.mapboxgl); } catch (_e2) { /* ignore */ }
      }
    };
    install(PAGE);
    if (window !== PAGE) install(window);
  })();

  // Nudge already-created, idle maps into a render so the prototype hook can
  // capture them. Mapbox maps (trackResize on by default) call resize() on a
  // window 'resize' event, and our patched prototype records `this` there. Fire
  // on the PAGE window (where the map's resize listener is registered) and the
  // sandbox window, and (re)wrap mapboxgl in case it appeared after init.
  function nudgeMaps() {
    try { wrapMapbox(PAGE.mapboxgl); } catch (_e) { /* ignore */ }
    if (window !== PAGE) { try { wrapMapbox(window.mapboxgl); } catch (_e) { /* ignore */ } }
    const fire = (w) => {
      try { w.dispatchEvent(new (w.Event || Event)("resize")); } catch (_e) { /* ignore */ }
    };
    fire(PAGE);
    if (window !== PAGE) fire(window);
  }

  function getReactFiber(node) {
    for (const k of Object.keys(node)) {
      if (k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$")) {
        return node[k];
      }
    }
    return null;
  }

  // Bounded breadth-first search of an object graph for a map instance.
  // Skips DOM nodes/Window to avoid blowing up the traversal.
  function searchGraph(roots, maxNodes = 30000) {
    const visited = new WeakSet();
    const queue = roots.filter((r) => r && typeof r === "object");
    let count = 0;
    while (queue.length && count < maxNodes) {
      const cur = queue.shift();
      count++;
      if (!cur || typeof cur !== "object" || visited.has(cur)) continue;
      visited.add(cur);
      if (looksLikeMap(cur)) return cur;
      let keys;
      try { keys = Object.keys(cur); } catch (_e) { continue; }
      for (const k of keys) {
        let v;
        try { v = cur[k]; } catch (_e) { continue; }
        if (!v || typeof v !== "object" || visited.has(v)) continue;
        if (v instanceof Node || v === window) continue; // don't descend into DOM
        queue.push(v);
      }
    }
    return null;
  }

  function findMap() {
    if (looksLikeMap(cachedMap) && mapIsVisible(cachedMap)) return cachedMap;
    let best = pickVisibleMap(collectMaps());
    if (best) return (cachedMap = best);
    // Common on wandrer.earth: the map was created in a closure and is idle, so
    // neither the constructor hook nor a repaint has captured it yet. Nudge it
    // into a render and retry once synchronously.
    nudgeMaps();
    best = pickVisibleMap(collectMaps());
    if (best) return (cachedMap = best);
    return null;
  }

  // Async variant of findMap: nudge + retry a few times for maps that only get
  // captured after a repaint settles (e.g. rAF-debounced resize). Used by the
  // click handlers so the first Detect/Plan/Pick click finds an idle map.
  async function ensureMap(retries = 6, delayMs = 200) {
    let map = findMap();
    for (let i = 0; i < retries && !map; i++) {
      nudgeMaps();
      await new Promise((r) => setTimeout(r, delayMs));
      map = findMap();
    }
    return map;
  }

  // True if the map's canvas is attached and has a non-trivial on-screen size.
  function mapIsVisible(map) {
    try {
      const c = map.getCanvas && map.getCanvas();
      if (!c || !c.isConnected) return false;
      const r = c.getBoundingClientRect();
      return r.width > 50 && r.height > 50;
    } catch (_e) {
      return false;
    }
  }

  // Rough on-screen area of a map's canvas (0 if hidden/detached).
  function mapVisibleArea(map) {
    try {
      const c = map.getCanvas && map.getCanvas();
      if (!c || !c.isConnected) return 0;
      const r = c.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return 0;
      // Clip to viewport so an off-screen map scores 0.
      const vw = window.innerWidth, vh = window.innerHeight;
      const w = Math.min(r.right, vw) - Math.max(r.left, 0);
      const h = Math.min(r.bottom, vh) - Math.max(r.top, 0);
      return w > 0 && h > 0 ? w * h : 0;
    } catch (_e) {
      return 0;
    }
  }

  // Among candidate maps, prefer the largest one actually visible on screen
  // (the route-builder map), falling back to any map at all.
  function pickVisibleMap(maps) {
    let best = null, bestArea = 0;
    for (const m of maps) {
      if (!looksLikeMap(m)) continue;
      const area = mapVisibleArea(m);
      if (area > bestArea) { bestArea = area; best = m; }
    }
    if (best) return best;
    return maps.find(looksLikeMap) || null;
  }

  // Gather every candidate Mapbox map instance: known globals, constructor-hook
  // captures, and a bounded React-fiber walk from map DOM nodes.
  function collectMaps() {
    const out = [];
    const push = (m) => { if (looksLikeMap(m) && !out.includes(m)) out.push(m); };

    for (const g of [
      PAGE.map, PAGE.__map,
      PAGE.routeBuilder && PAGE.routeBuilder.map,
      window.map,
      window.__map,
      window.routeBuilder && window.routeBuilder.map,
      ...(window.__wrpMaps || []),
      ...((PAGE.__wrpMaps && PAGE.__wrpMaps !== window.__wrpMaps) ? PAGE.__wrpMaps : []),
    ]) push(g);

    let nodes = [
      ...document.querySelectorAll(".mapboxgl-map, .mapboxgl-canvas, canvas"),
    ];
    if (nodes.length === 0) nodes = [...document.querySelectorAll("div, canvas")];
    const roots = [];
    for (const n of nodes) {
      const fiber = getReactFiber(n);
      if (fiber) roots.push(fiber);
    }
    // searchGraph returns the first match; run it per-root so we can find the
    // map attached to each visible canvas, not just the first one anywhere.
    for (const root of roots) {
      const found = searchGraph([root]);
      if (found) push(found);
    }
    return out;
  }

  // Log what the finder saw, to help diagnose a failed lookup.
  function logMapDiagnostics() {
    const canvases = document.querySelectorAll(".mapboxgl-canvas, canvas");
    const containers = document.querySelectorAll(".mapboxgl-map");
    let withFiber = 0;
    document.querySelectorAll(".mapboxgl-map, .mapboxgl-canvas, canvas").forEach(
      (n) => { if (getReactFiber(n)) withFiber++; }
    );
    const mb = (PAGE && PAGE.mapboxgl) || window.mapboxgl;
    const protoHooked = !!(mb && mb.Map && mb.Map.prototype && mb.Map.prototype.__wrpProtoHooked);
    // eslint-disable-next-line no-console
    console.log(
      "[WRP] map not found.",
      `canvases=${canvases.length}`,
      `mapboxgl-map containers=${containers.length}`,
      `nodes with React fiber=${withFiber}`,
      `hooked maps=${(window.__wrpMaps || []).length}`,
      `mapboxgl global=${!!mb}`,
      `proto hooked=${protoHooked}`,
      "\nTip: make sure the map is visible, then retry. If 'mapboxgl global=false'",
      "even via unsafeWindow, the map's Mapbox is bundled privately and can't be",
      "hooked; if it's true but 'hooked maps=0', pan/zoom the map once and retry."
    );
  }

  // ----------------------------------------------------------------------
  // UI panel
  // ----------------------------------------------------------------------
  let startLatLng = null;
  let pickingStart = false;

  const panel = document.createElement("div");
  panel.id = "wrp-panel";
  panel.style.cssText = [
    "position:fixed", "top:90px", "right:16px", "bottom:auto", "z-index:99999",
    "background:#fff", "border:1px solid #ddd", "border-radius:10px",
    "box-shadow:0 4px 16px rgba(0,0,0,.15)", "padding:12px 14px",
    "font:13px/1.4 system-ui,sans-serif", "width:240px", "color:#222",
    "height:auto", "max-height:calc(100vh - 24px)", "overflow-y:auto",
    "box-sizing:border-box",
  ].join(";");
  // The "create in Strava" flow only exists where there is a route builder
  // (Strava). On wandrer.earth the Big Map is read-only, so we omit the section
  // entirely and the planned route is used via GPX export.
  const createSectionHtml = SITE.canCreate
    ? `
    <details style="margin:4px 0">
      <summary style="cursor:pointer;font-size:12px;color:#666">Advanced: draw in Strava</summary>
      <button id="wrp-create" style="width:100%;margin:6px 0;padding:6px;background:#fff;color:#222;border:1px solid #ccc;border-radius:6px;cursor:pointer" disabled>Create in Strava (experimental)</button>
      <div style="font-size:11px;color:#999">Replays points into Strava's manual mode. Fragile against Strava UI changes — prefer GPX.</div>
    </details>`
    : "";

  panel.innerHTML = `
    <div id="wrp-drag" style="display:flex;align-items:center;gap:8px;font-weight:600;margin:-12px -14px 8px;padding:10px 14px 8px;cursor:move;user-select:none;border-bottom:1px solid #eee;border-radius:10px 10px 0 0"><span style="flex:1;min-width:0">Wandrer Run Planner <span style="font-weight:400;font-size:11px;color:#888">· ${SITE.siteName}</span></span><button id="wrp-eye" title="Hide route" aria-label="Hide route" style="display:none;flex:none;width:22px;height:22px;line-height:1;padding:0;border:1px solid #ccc;border-radius:6px;background:#fff;color:#444;cursor:pointer;font-size:13px">👁</button><button id="wrp-min" title="Minimize" aria-label="Minimize" style="flex:none;width:22px;height:22px;line-height:1;padding:0;border:1px solid #ccc;border-radius:6px;background:#fff;color:#444;cursor:pointer;font-size:14px">–</button></div>
    <div id="wrp-body">
    <label style="display:block;margin:6px 0">Target km
      <input id="wrp-km" type="number" value="6" step="0.5" min="1"
             style="width:100%;box-sizing:border-box"></label>
    <label style="display:block;margin:6px 0">Tolerance km
      <input id="wrp-tol" type="number" value="1" step="0.5" min="0"
             style="width:100%;box-sizing:border-box"></label>
    <button id="wrp-pick" style="width:100%;margin:6px 0;padding:6px;background:#fff;color:#222;border:1px solid #ccc;border-radius:6px;cursor:pointer">Pick start on map</button>
    <input id="wrp-coords" type="text" placeholder="or paste: lat, lng"
           style="width:100%;box-sizing:border-box;margin:2px 0;padding:5px">
    <div id="wrp-start" style="color:#888;font-size:12px;margin:2px 0">start: (none)</div>
    <button id="wrp-detect" style="width:100%;margin:6px 0;padding:6px;background:#fff;color:#222;border:1px solid #ccc;border-radius:6px;cursor:pointer">${SITE.id === "wandrer" ? "Detect travelled" : "Detect overlay"}</button>
    <button id="wrp-plan" style="width:100%;margin:6px 0;padding:6px;background:#fc4c02;color:#fff;border:none;border-radius:6px">Plan route</button>
    <button id="wrp-gpx" style="width:100%;margin:6px 0;padding:6px;background:#fc4c02;color:#fff;border:none;border-radius:6px" disabled>Download GPX</button>
    <div style="font-size:11px;color:#888;margin:2px 0 4px">Recommended: load the GPX on your watch, or import it (Strava subscribers: Routes → Upload a Route; Garmin/Komoot also work).</div>
    ${createSectionHtml}
    <div id="wrp-status" style="margin-top:6px;font-size:12px;color:#444"></div>
    </div>
  `;
  // Defensive styles: some host pages (e.g. wandrer.earth) ship aggressive
  // global CSS that can stretch the panel to full height or strip button chrome.
  // !important here pins the panel's box regardless of those rules.
  const wrpStyle = document.createElement("style");
  wrpStyle.textContent =
    "#wrp-panel{height:auto!important;min-height:0!important;" +
    "max-height:calc(100vh - 24px)!important;bottom:auto!important;" +
    "overflow-y:auto!important;box-sizing:border-box!important;width:240px!important}" +
    "#wrp-panel *{box-sizing:border-box}";
  (document.head || document.documentElement).appendChild(wrpStyle);
  document.body.appendChild(panel);

  // Minimize / restore: collapse the panel to just its title bar so it stays out
  // of the way when not in use. State is persisted across reloads. The button
  // stops pointer/click propagation so clicking it never starts a title drag.
  (function makeCollapsible() {
    const body = panel.querySelector("#wrp-body");
    const btn = panel.querySelector("#wrp-min");
    const apply = (collapsed) => {
      body.style.display = collapsed ? "none" : "";
      btn.textContent = collapsed ? "+" : "–";
      btn.title = btn.ariaLabel = collapsed ? "Restore" : "Minimize";
    };
    let collapsed = false;
    try { collapsed = localStorage.getItem("wrp-collapsed") === "1"; } catch (_e) { /* ignore */ }
    apply(collapsed);
    btn.addEventListener("pointerdown", (e) => e.stopPropagation());
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      collapsed = !collapsed;
      apply(collapsed);
      try { localStorage.setItem("wrp-collapsed", collapsed ? "1" : "0"); } catch (_e) { /* ignore */ }
    });
  })();

  // Eye toggle: show/hide the planned route line on the map. Hidden until a
  // route is drawn (revealed by drawRoute via #wrp-eye). Toggles the Mapbox
  // layer's visibility so the route can be tucked away to inspect the map under
  // it without losing the plan.
  (function makeRouteToggle() {
    const btn = panel.querySelector("#wrp-eye");
    const apply = () => {
      const hidden = btn.dataset.hidden === "1";
      const map = cachedMap;
      if (map && map.getLayer && map.getLayer("wrp-route")) {
        map.setLayoutProperty("wrp-route", "visibility", hidden ? "none" : "visible");
      }
      btn.textContent = hidden ? "🙈" : "👁";
      btn.title = btn.ariaLabel = hidden ? "Show route" : "Hide route";
    };
    btn.addEventListener("pointerdown", (e) => e.stopPropagation());
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      btn.dataset.hidden = btn.dataset.hidden === "1" ? "0" : "1";
      apply();
    });
  })();

  // Make the panel draggable by its title bar. Switches from right-anchored to
  // left/top absolute positioning on first drag so it follows the cursor.
  (function makeDraggable() {
    const handle = panel.querySelector("#wrp-drag");
    let dragging = false;
    let offX = 0;
    let offY = 0;
    handle.addEventListener("pointerdown", (e) => {
      dragging = true;
      const r = panel.getBoundingClientRect();
      offX = e.clientX - r.left;
      offY = e.clientY - r.top;
      panel.style.right = "auto";
      panel.style.left = `${r.left}px`;
      panel.style.top = `${r.top}px`;
      handle.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    handle.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const maxX = window.innerWidth - panel.offsetWidth;
      const maxY = window.innerHeight - panel.offsetHeight;
      const x = Math.min(Math.max(0, e.clientX - offX), Math.max(0, maxX));
      const y = Math.min(Math.max(0, e.clientY - offY), Math.max(0, maxY));
      panel.style.left = `${x}px`;
      panel.style.top = `${y}px`;
    });
    const end = (e) => {
      if (!dragging) return;
      dragging = false;
      try { handle.releasePointerCapture(e.pointerId); } catch (_e) { /* ignore */ }
      // Persist the position so it survives page reloads.
      try {
        localStorage.setItem(
          "wrp-pos",
          JSON.stringify({ left: panel.style.left, top: panel.style.top })
        );
      } catch (_e) { /* storage blocked — non-fatal */ }
    };
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);

    // Restore a previously saved position (clamped to the current viewport).
    try {
      const saved = JSON.parse(localStorage.getItem("wrp-pos") || "null");
      if (saved && saved.left && saved.top) {
        const left = Math.min(parseInt(saved.left, 10) || 0, window.innerWidth - 80);
        const top = Math.min(parseInt(saved.top, 10) || 0, window.innerHeight - 40);
        panel.style.right = "auto";
        panel.style.left = `${Math.max(0, left)}px`;
        panel.style.top = `${Math.max(0, top)}px`;
      }
    } catch (_e) { /* ignore malformed/blocked storage */ }
  })();

  const $ = (id) => panel.querySelector(id);
  const setStatus = (t) => ($("#wrp-status").textContent = t);

  // Record the start point and reflect it in the panel. Used by both the
  // map-picker and the paste field so they stay in sync.
  function setStart(lat, lng) {
    startLatLng = { lat, lng };
    $("#wrp-start").textContent = `start: ${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  }

  // Parse a pasted "lat, lng" string. Accepts comma- or whitespace-separated
  // decimals (e.g. "50.00102, 10.91502", "50.00102 10.91502"), tolerates a
  // surrounding "lat,lng" label, and validates ranges. Returns {lat,lng} or null.
  function parseLatLng(text) {
    if (!text) return null;
    const nums = text.match(/-?\d+(?:\.\d+)?/g);
    if (!nums || nums.length < 2) return null;
    const lat = parseFloat(nums[0]);
    const lng = parseFloat(nums[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
    return { lat, lng };
  }

  // Apply whatever is in the paste field as the start point.
  function applyPastedCoords() {
    const raw = $("#wrp-coords").value.trim();
    if (!raw) return;
    const parsed = parseLatLng(raw);
    if (!parsed) {
      setStatus("Could not parse coordinates. Use: lat, lng (e.g. 50.001, 10.915).");
      return;
    }
    setStart(parsed.lat, parsed.lng);
    setStatus("Start set from pasted coordinates.");
  }

  $("#wrp-coords").addEventListener("change", applyPastedCoords);
  $("#wrp-coords").addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      applyPastedCoords();
    }
  });
  // Apply immediately on paste (after the browser inserts the text).
  $("#wrp-coords").addEventListener("paste", () => setTimeout(applyPastedCoords, 0));

  // Pick start: the next click anywhere over the map sets the start point.
  //
  // We listen on the document at the CAPTURE phase (not on the canvas) because
  // Strava stacks overlay elements (marker layers, interaction divs) above the
  // Mapbox canvas, so the click target is usually NOT the canvas. Capturing at
  // the document lets us intercept the click first, regardless of which child
  // was hit, then convert the pixel to lng/lat via map.unproject().
  $("#wrp-pick").addEventListener("click", async () => {
    setStatus("Looking for the map…");
    const map = await ensureMap();
    if (!map) {
      logMapDiagnostics();
      setStatus("Map not found — make sure the map is visible (see console for details).");
      return;
    }
    const canvas = map.getCanvas ? map.getCanvas() : null;
    const container = map.getContainer ? map.getContainer() : null;
    if (!canvas || !container) {
      setStatus("Map canvas not available.");
      return;
    }
    pickingStart = true;
    setStatus("Click the map to set the start…");
    const prevCursor = container.style.cursor;
    container.style.cursor = "crosshair";

    const cleanup = () => {
      pickingStart = false;
      container.style.cursor = prevCursor;
      document.removeEventListener("click", onDocClick, true);
      document.removeEventListener("pointerdown", swallow, true);
      document.removeEventListener("mousedown", swallow, true);
      document.removeEventListener("keydown", onKey, true);
    };

    // Cancel with Escape.
    const onKey = (ev) => {
      if (ev.key === "Escape") {
        setStatus("Start pick cancelled.");
        cleanup();
      }
    };

    // Swallow the press that precedes the click so Strava doesn't start a
    // waypoint drag on pointerdown/mousedown.
    const swallow = (ev) => {
      const r = canvas.getBoundingClientRect();
      if (
        ev.clientX >= r.left && ev.clientX <= r.right &&
        ev.clientY >= r.top && ev.clientY <= r.bottom
      ) {
        ev.preventDefault();
        ev.stopPropagation();
      }
    };

    const onDocClick = (ev) => {
      const rect = canvas.getBoundingClientRect();
      const inside =
        ev.clientX >= rect.left && ev.clientX <= rect.right &&
        ev.clientY >= rect.top && ev.clientY <= rect.bottom;
      if (!inside) return; // ignore clicks outside the map (e.g. on the panel)

      ev.preventDefault();
      ev.stopPropagation();

      const point = [ev.clientX - rect.left, ev.clientY - rect.top];
      let lngLat;
      try {
        lngLat = map.unproject(point);
      } catch (_e) {
        setStatus("Could not read map coordinate; try again.");
        cleanup();
        return;
      }
      setStart(lngLat.lat, lngLat.lng);
      $("#wrp-coords").value = `${lngLat.lat.toFixed(5)}, ${lngLat.lng.toFixed(5)}`;
      setStatus("Start set.");
      cleanup();    };

    document.addEventListener("pointerdown", swallow, true);
    document.addEventListener("mousedown", swallow, true);
    document.addEventListener("click", onDocClick, true);
    document.addEventListener("keydown", onKey, true);
  });

  // Prevent overlapping runs: Plan and Create are long async flows, and firing
  // a second one while the first is mid-flight corrupts shared state (the map,
  // window.__wrpLast, Strava's manual-mode point stream). guard() ignores
  // re-entrant clicks until the in-flight handler settles.
  let busy = false;
  const guard = (fn) => async (...args) => {
    if (busy) return;
    busy = true;
    try {
      await fn(...args);
    } finally {
      busy = false;
    }
  };

  $("#wrp-plan").addEventListener("click", guard(onPlan));
  $("#wrp-detect").addEventListener("click", onDetect);
  const createBtn = $("#wrp-create");
  if (createBtn) createBtn.addEventListener("click", guard(onCreate));
  $("#wrp-gpx").addEventListener("click", onDownloadGpx);

  // ----------------------------------------------------------------------
  // Enumerate Wandrer vector sources + their source-layers in the live style.
  // ----------------------------------------------------------------------
  function getWandrerSources(map) {
    const style = map.getStyle && map.getStyle();
    if (!style || !style.sources) return [];
    const out = [];
    for (const [id, src] of Object.entries(style.sources)) {
      const hay = id + " " + JSON.stringify(src || {});
      if (WANDRER.SOURCE_MATCH.test(hay)) {
        out.push({ id, sourceLayers: collectSourceLayers(style, id).sourceLayers });
      }
    }
    return out;
  }

  function collectSourceLayers(style, sourceId) {
    const sourceLayers = new Set();
    for (const layer of style.layers || []) {
      if (layer.source === sourceId && layer["source-layer"]) {
        sourceLayers.add(layer["source-layer"]);
      }
    }
    return { sourceId, sourceLayers: [...sourceLayers] };
  }

  // Query one source, returning its loaded features + travelled extraction.
  function probeSource(map, s) {
    const layerArgs = s.sourceLayers.length ? s.sourceLayers : [undefined];
    const srcTravelled = nameImpliesTravelled(s.id);
    let total = 0;
    let travelledCount = 0;
    const keys = new Set();
    const polylines = [];
    const osmIds = new Set();
    const seen = new Set();

    for (const sl of layerArgs) {
      let feats = [];
      try {
        feats = map.querySourceFeatures(s.id, sl ? { sourceLayer: sl } : {});
      } catch (_e) {
        continue;
      }
      const slTravelled = srcTravelled || nameImpliesTravelled(sl);
      for (const f of feats) {
        total++;
        Object.keys(f.properties || {}).forEach((k) => keys.add(k));
        const isTrav = slTravelled || isTravelled(f.properties);
        if (!isTrav) continue;
        const fid = f.id != null ? `${sl}:${f.id}` : null;
        if (fid && seen.has(fid)) continue;
        if (fid) seen.add(fid);
        travelledCount++;
        // Exact match key: Wandrer tags each segment with its OSM way id.
        const props = f.properties || {};
        const oid = props.osm_id_str ?? props.way_id ?? props.osm_id;
        if (oid != null) {
          const n = parseInt(oid, 10);
          if (!Number.isNaN(n)) osmIds.add(n);
        }
        for (const pl of geometryToPolylines(f.geometry)) {
          if (pl.length >= 2) polylines.push(pl);
        }
      }
    }
    return {
      id: s.id,
      sourceLayers: s.sourceLayers,
      total,
      travelled: travelledCount,
      keys: [...keys],
      polylines,
      osmIds: [...osmIds],
      impliesTravelled: srcTravelled,
    };
  }

  // Convert a GeoJSON geometry (lng/lat) into [lat,lng] polylines.
  function geometryToPolylines(geom) {
    if (!geom) return [];
    if (geom.type === "LineString") {
      return [geom.coordinates.map(([ln, la]) => [la, ln])];
    }
    if (geom.type === "MultiLineString") {
      return geom.coordinates.map((line) => line.map(([ln, la]) => [la, ln]));
    }
    return [];
  }

  // ----------------------------------------------------------------------
  // Read travelled geometry off the live map. Dispatches to the active site's
  // reader. Returns { travelled: [[ [lat,lng], ... ], ...], travelledOsmIds,
  // stats } in both cases so onPlan/onDetect are site-agnostic.
  // ----------------------------------------------------------------------
  function readTravelled(map) {
    return SITE.id === "wandrer"
      ? readTravelledNative(map)
      : readTravelledOverlay(map);
  }

  // Native wandrer.earth Big Map: travelled-on-foot lives entirely in known
  // source/source-layer pairs (every feature is travelled). Read them directly
  // and prefer exact OSM-id matching via osm_id_str.
  function readTravelledNative(map) {
    const style = map.getStyle && map.getStyle();
    const cfg = SITE.native;
    const empty = { travelled: [], travelledOsmIds: [], stats: { source: null, all: [] } };
    if (!style || !style.sources) return empty;

    const summary = [];
    let chosen = null;
    for (const { source, sourceLayer } of cfg.TRAVELLED_SOURCES) {
      if (!style.sources[source]) continue;
      let feats = [];
      try {
        feats = map.querySourceFeatures(source, sourceLayer ? { sourceLayer } : {});
      } catch (_e) {
        continue;
      }
      const polylines = [];
      const osmIds = new Set();
      const keys = new Set();
      const seen = new Set();
      for (const f of feats) {
        Object.keys(f.properties || {}).forEach((k) => keys.add(k));
        const fid = f.id != null ? `${sourceLayer}:${f.id}` : null;
        if (fid && seen.has(fid)) continue;
        if (fid) seen.add(fid);
        // Exact match key: osm_id_str is the OSM way id. Do NOT use way_id here
        // (it is a Wandrer composite id, not numeric OSM).
        const props = f.properties || {};
        for (const key of cfg.OSM_ID_KEYS) {
          const oid = props[key];
          if (oid != null) {
            const n = parseInt(oid, 10);
            if (!Number.isNaN(n)) { osmIds.add(n); break; }
          }
        }
        for (const pl of geometryToPolylines(f.geometry)) {
          if (pl.length >= 2) polylines.push(pl);
        }
      }
      const entry = {
        id: source, sourceLayers: [sourceLayer], total: feats.length,
        travelled: feats.length, keys: [...keys], polylines,
        osmIds: [...osmIds], impliesTravelled: true,
      };
      summary.push({
        id: entry.id, total: entry.total, travelled: entry.travelled,
        keys: entry.keys, sourceLayers: entry.sourceLayers, impliesTravelled: true,
      });
      if (!chosen && feats.length > 0) chosen = entry;
    }
    if (!chosen) {
      return { travelled: [], travelledOsmIds: [], stats: { source: null, all: summary } };
    }
    return {
      travelled: chosen.polylines,
      travelledOsmIds: chosen.osmIds,
      stats: {
        source: chosen.id,
        sourceLayers: chosen.sourceLayers,
        total: chosen.total,
        travelled: chosen.travelled,
        keys: chosen.keys,
        osmIdCount: chosen.osmIds.length,
        all: summary,
      },
    };
  }

  // ----------------------------------------------------------------------
  // Strava overlay path: enumerate all Wandrer overlay sources, probe each, and
  // choose the best "travelled" source (preferring the configured activity +
  // most features). Returns { travelled, travelledOsmIds, stats }.
  // ----------------------------------------------------------------------
  function readTravelledOverlay(map) {
    let sources = getWandrerSources(map);
    if (WANDRER.FORCE_SOURCE_ID) {
      sources = sources.filter((s) => s.id === WANDRER.FORCE_SOURCE_ID);
    }
    if (!sources.length) {
      return { travelled: [], stats: { source: null, all: [] } };
    }

    const probes = sources.map((p) => probeSource(map, p));
    const summary = probes.map((p) => ({
      id: p.id,
      total: p.total,
      travelled: p.travelled,
      keys: p.keys,
      sourceLayers: p.sourceLayers,
      impliesTravelled: p.impliesTravelled,
    }));

    // Rank candidate travelled sources: must imply travelled (or have travelled
    // features via properties); prefer the configured activity; then most data.
    const ranked = probes
      .filter((p) => p.impliesTravelled || p.travelled > 0)
      .sort((a, b) => {
        const aAct = WANDRER.ACTIVITY_MATCH.test(a.id) ? 1 : 0;
        const bAct = WANDRER.ACTIVITY_MATCH.test(b.id) ? 1 : 0;
        if (aAct !== bAct) return bAct - aAct;
        return b.total - a.total;
      });

    const chosen = ranked.find((p) => p.total > 0) || ranked[0] || probes[0];

    return {
      travelled: chosen ? chosen.polylines : [],
      travelledOsmIds: chosen ? chosen.osmIds : [],
      stats: {
        source: chosen ? chosen.id : null,
        sourceLayers: chosen ? chosen.sourceLayers : [],
        total: chosen ? chosen.total : 0,
        travelled: chosen ? chosen.travelled : 0,
        keys: chosen ? chosen.keys : [],
        osmIdCount: chosen ? chosen.osmIds.length : 0,
        all: summary,
      },
    };
  }

  async function onDetect() {
    setStatus("Looking for the map…");
    const map = await ensureMap();
    if (!map) {
      logMapDiagnostics();
      return setStatus("Map not found — make sure the map is visible (see console for details).");
    }
    const { stats } = readTravelled(map);
    // Always log the full picture of every Wandrer source.
    // eslint-disable-next-line no-console
    console.log("[WRP] all wandrer sources:", stats.all);
    if (!stats.source) {
      setStatus(
        "No Wandrer source found. Ensure the overlay is ON. " +
        "Console lists available source ids."
      );
      try {
        // eslint-disable-next-line no-console
        console.log("[WRP] style sources:", Object.keys(map.getStyle().sources));
      } catch (_e) { /* ignore */ }
      return;
    }
    const totalAll = (stats.all || []).reduce((n, s) => n + s.total, 0);
    setStatus(
      `Source "${stats.source}" — ${stats.travelled}/${stats.total} travelled ` +
      `in view (${stats.osmIdCount} OSM ids; ${totalAll} features across ` +
      `${stats.all.length} wandrer sources).` +
      (totalAll === 0
        ? " No tiles loaded yet — zoom/pan over your run area and retry."
        : "")
    );
    // eslint-disable-next-line no-console
    console.log("[WRP] chosen:", stats);
  }

  function postPlan(body) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "POST",
        url: BACKEND,
        headers: { "Content-Type": "application/json" },
        data: JSON.stringify(body),
        onload: (r) =>
          r.status >= 200 && r.status < 300
            ? resolve(JSON.parse(r.responseText))
            : reject(new Error(`${r.status}: ${r.responseText}`)),
        onerror: () =>
          reject(
            new Error(
              "Backend unreachable. Is it running on 127.0.0.1:8000? " +
              "If you changed @connect, re-grant the script's connect permission."
            )
          ),
        ontimeout: () => reject(new Error("Backend request timed out.")),
        timeout: 120000,
      });
    });
  }

  function drawRoute(map, coords) {
    const geojson = {
      type: "Feature",
      geometry: { type: "LineString", coordinates: coords.map(([la, ln]) => [ln, la]) },
    };
    if (map.getSource("wrp-route")) {
      map.getSource("wrp-route").setData(geojson);
    } else {
      map.addSource("wrp-route", { type: "geojson", data: geojson });
      map.addLayer({
        id: "wrp-route",
        type: "line",
        source: "wrp-route",
        paint: { "line-color": "#0a84ff", "line-width": 5, "line-opacity": 0.85 },
      });
    }
    // Reveal the eye toggle and apply its current show/hide state to the layer.
    const eye = document.getElementById("wrp-eye");
    if (eye) {
      eye.style.display = "";
      map.setLayoutProperty(
        "wrp-route", "visibility", eye.dataset.hidden === "1" ? "none" : "visible"
      );
    }
  }

  async function onPlan() {
    setStatus("Looking for the map…");
    const map = await ensureMap();
    if (!map) { logMapDiagnostics(); return setStatus("Map not found — make sure the map is visible (see console)."); }
    // Honor coordinates typed into the paste field even if it wasn't blurred.
    applyPastedCoords();
    const start = startLatLng || (() => {
      const c = map.getCenter();
      return { lat: c.lat, lng: c.lng };
    })();

    setStatus("Reading Wandrer overlay…");
    const { travelled, travelledOsmIds, stats } = readTravelled(map);
    if (!stats.source) {
      setStatus("Warning: no Wandrer overlay found — planning as if all paths are new.");
    }

    setStatus("Planning… (this can take a few seconds)");
    try {
      const res = await postPlan({
        start,
        target_km: parseFloat($("#wrp-km").value),
        tolerance_km: parseFloat($("#wrp-tol").value),
        travelled,
        travelled_osm_ids: travelledOsmIds || [],
      });
      drawRoute(map, res.coordinates);
      setStatus(
        `Done: ${res.distance_km} km, new ${res.new_km} km ` +
        `(${res.coverage_pct}% new), repeat ${res.repeat_km} km. ` +
        `Click "Download GPX" to use it.`
      );
      // Stash for create-in-Strava / GPX download and enable those buttons.
      window.__wrpLast = res;
      const createEl = $("#wrp-create");
      if (createEl) createEl.disabled = false;
      $("#wrp-gpx").disabled = false;
    } catch (err) {
      setStatus("Error: " + err.message);
    }
  }

  // --------------------------------------------------------------------------
  // Create the planned route inside Strava's builder using MANUAL mode.
  // In manual mode Strava draws straight segments between clicked points and
  // does NOT snap/re-route, so replaying our points reproduces the path exactly.
  // --------------------------------------------------------------------------

  // Find Strava's "Manual mode" toggle row and its checkbox/switch, if present.
  function findManualToggle() {
    const labels = [...document.querySelectorAll("*")].filter(
      (el) =>
        el.children.length === 0 &&
        /manual mode/i.test(el.textContent || "")
    );
    for (const lbl of labels) {
      // Walk up a few levels to find a row containing a toggle control.
      let row = lbl;
      for (let i = 0; i < 4 && row; i++, row = row.parentElement) {
        const input = row.querySelector('input[type="checkbox"], [role="switch"]');
        if (input) return { row, input };
      }
    }
    return null;
  }

  function isManualOn(toggle) {
    if (!toggle) return false;
    const el = toggle.input;
    if (el.matches('input[type="checkbox"]')) return el.checked;
    const aria = el.getAttribute("aria-checked");
    return aria === "true";
  }

  async function ensureManualMode() {
    const toggle = findManualToggle();
    if (!toggle) return { ok: false, reason: "no-toggle" };
    if (isManualOn(toggle)) return { ok: true };
    toggle.input.click();
    await sleep(200);
    return { ok: isManualOn(toggle), reason: isManualOn(toggle) ? null : "click-failed" };
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Pick the map that ACTUALLY receives clicks: the topmost Mapbox instance at
  // the screen centre. Strava's route builder can host several overlapping map
  // instances (e.g. the base route-builder map plus the Wandrer overlay map).
  // The one whose canvas is on TOP at a pixel is the one whose click handler
  // (manual-mode waypoint add) fires there. Centring/clicking any other instance
  // moves that map around (the "overlay just panned" symptom) without ever
  // adding a waypoint. So we resolve the map from the element actually on top at
  // the screen centre and use THAT same instance for both setCenter and clicks.
  function mapForElement(maps, el) {
    for (let node = el; node; node = node.parentElement) {
      for (const m of maps) {
        let c;
        try { c = m.getContainer && m.getContainer(); } catch (_e) { continue; }
        if (c && c === node) return m;
      }
    }
    return null;
  }

  // A click point near the screen centre but clear of our panel (top-right).
  function centreProbePoint() {
    return {
      x: Math.round(window.innerWidth * 0.4),
      y: Math.round(window.innerHeight * 0.5),
    };
  }

  function findInteractiveMap() {
    const maps = collectMaps().filter(looksLikeMap);
    if (!maps.length) return null;
    const { x, y } = centreProbePoint();
    const owner = mapForElement(maps, document.elementFromPoint(x, y));
    if (owner) return owner;
    // Fall back to the largest visible map if the probe didn't resolve an owner.
    return pickVisibleMap(maps);
  }

  // Reduce points for manual mode: keep enough to follow curves but avoid
  // hundreds of clicks. Ramer–Douglas–Peucker on [lat,lng], capped at maxPoints.
  function pointsForManual(coords, toleranceM = 8, maxPoints = 160, minSpacingM = 15) {
    if (coords.length <= 2) return coords.slice();

    const R = 6371000, toRad = (d) => (d * Math.PI) / 180;
    const hav = (a, b) => {
      const dLat = toRad(b[0] - a[0]); const dLng = toRad(b[1] - a[1]);
      const s =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLng / 2) ** 2;
      return 2 * R * Math.asin(Math.sqrt(s));
    };
    const perp = (p, a, b) => {
      const da = hav(p, a), db = hav(p, b), ab = hav(a, b);
      if (ab === 0) return da;
      const s = (da + db + ab) / 2;
      const area = Math.sqrt(Math.max(0, s * (s - da) * (s - db) * (s - ab)));
      return (2 * area) / ab;
    };

    const keep = new Array(coords.length).fill(false);
    keep[0] = keep[coords.length - 1] = true;
    const stack = [[0, coords.length - 1]];
    while (stack.length) {
      const [lo, hi] = stack.pop();
      if (hi <= lo + 1) continue;
      let maxD = -1, idx = lo;
      for (let i = lo + 1; i < hi; i++) {
        const d = perp(coords[i], coords[lo], coords[hi]);
        if (d > maxD) { maxD = d; idx = i; }
      }
      if (maxD > toleranceM) {
        keep[idx] = true;
        stack.push([lo, idx], [idx, hi]);
      }
    }
    let pts = coords.filter((_, i) => keep[i]);

    // Enforce a minimum spacing between consecutive kept points. Two points that
    // land within ~a marker's width of each other on screen make the second
    // click hit the FIRST point's marker, which opens Strava's context popover
    // ("Start"/Delete…) instead of adding a waypoint — that is what stalls the
    // replay after one point. Dropping near-duplicates removes that trigger;
    // manual mode straight-lines between points so the path barely changes.
    if (pts.length > 2) {
      const spaced = [pts[0]];
      for (let i = 1; i < pts.length - 1; i++) {
        if (hav(spaced[spaced.length - 1], pts[i]) >= minSpacingM) spaced.push(pts[i]);
      }
      const last = pts[pts.length - 1];
      // Drop the closing point if it coincides with the start (loop closure) so
      // we never re-click the start marker; otherwise keep it if well-spaced.
      if (hav(spaced[spaced.length - 1], last) >= minSpacingM &&
          hav(last, pts[0]) >= minSpacingM) {
        spaced.push(last);
      }
      pts = spaced;
    }

    if (pts.length > maxPoints) {
      const step = pts.length / maxPoints;
      const out = [];
      for (let i = 0; i < maxPoints; i++) out.push(pts[Math.floor(i * step)]);
      out[out.length - 1] = pts[pts.length - 1];
      pts = out;
    }
    return pts;
  }

  // Add one waypoint by emitting a synthetic click on Strava's map.
  //
  // Evidence from live testing: dispatching to the cursor overlay element that
  // sits under the point (Map_cursorCrosshairAndGrabbing…) DID place a point;
  // dispatching to getCanvasContainer() placed none. So the element at the
  // pixel (elementFromPoint) is the correct, single target. Earlier we also hit
  // the <canvas> as a second target, which interleaved two pointer streams and
  // tripped Mapbox's DragPan -> the map panned and only one point landed. Now we
  // use ONE target, send a hover move first (so DragPan sees no button held when
  // the pointer arrives), then a down/up at identical coords (= click, not drag).
  function clickXY(target, clientX, clientY) {
    const opts = (type) => ({
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX,
      clientY,
      screenX: clientX,
      screenY: clientY,
      button: 0,
      buttons: type === "mousedown" || type === "pointerdown" ? 1 : 0,
    });
    const ptr = (type) => new PointerEvent(type, {
      ...opts(type), pointerId: 1, pointerType: "mouse", isPrimary: true,
    });
    const mouse = (type) => new MouseEvent(type, opts(type));

    // Hover first (no button) so DragPan is idle, then a clean click.
    target.dispatchEvent(ptr("pointermove"));
    target.dispatchEvent(mouse("mousemove"));
    target.dispatchEvent(ptr("pointerdown"));
    target.dispatchEvent(mouse("mousedown"));
    target.dispatchEvent(ptr("pointerup"));
    target.dispatchEvent(mouse("mouseup"));
    target.dispatchEvent(mouse("click"));
  }

  // Place one waypoint by centring the map on it and clicking the canvas CENTRE.
  //
  // Why the centre instead of projecting the point to its on-screen pixel: at
  // the canvas centre, Strava's own unproject of the click == map.getCenter()
  // == the point we just set, BY CONSTRUCTION. That makes placement immune to
  // projection/zoom/scaling/offset/occlusion errors that smeared earlier
  // attempts. ``setCenter`` is a synchronous jump (no animation), so the camera
  // is updated immediately; we click, then pause so Strava registers it.
  //
  // ``jitter`` nudges the click a couple of pixels off dead-centre on alternate
  // points so two consecutive clicks never share the exact same pixel — that
  // avoids any double-click interpretation (zoom / finish-route). A 2 px nudge
  // is sub-metre-to-a-few-metres on screen and irrelevant in manual mode, which
  // straight-lines between points anyway.
  async function placePointCentered(map, canvas, lng, lat, jitter) {
    try {
      map.setCenter([lng, lat]);
      await sleep(30); // let the repaint/cursor overlay settle
      // A context popover (e.g. the "Start" card Strava opens after the first
      // waypoint) overlays the click point and swallows every later click while
      // the map keeps panning -> "1 point then it just moves". Close it first.
      await dismissStravaPopover();
      const r = canvas.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2 + (jitter ? 2 : -2);
      // Click whatever sits on top at the centre — Strava stacks an interaction
      // layer above the canvas, and THAT element (not the bare canvas) is what
      // registers a waypoint. We deliberately do NOT reject by container
      // membership: the map was chosen as the topmost-at-centre instance, so the
      // element here belongs to it, and over-strict rejection previously dropped
      // every point while setCenter still panned the map.
      const el = document.elementFromPoint(cx, cy) ||
        (map.getCanvasContainer && map.getCanvasContainer()) || canvas;
      clickXY(el, cx, cy);
      return { ok: true, el };
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[WRP] placePointCentered failed:", err);
      return { ok: false, error: err };
    }
  }

  // Strava's waypoint context popover (anchored to a marker) lists these actions
  // together. Match conservatively on the action set so we don't grab unrelated
  // UI, and pick the innermost (last) matching node.
  function findStravaPopover() {
    const nodes = document.querySelectorAll("div, section, aside");
    for (let i = nodes.length - 1; i >= 0; i--) {
      const el = nodes[i];
      const t = el.textContent || "";
      if (t.length <= 200 &&
          /manual mode/i.test(t) && /customize/i.test(t) && /delete/i.test(t)) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) return el;
      }
    }
    return null;
  }

  // Close an open Strava popover. Strava closes its popovers on an OUTSIDE
  // pointer interaction (Escape alone did NOT work here), so we dispatch a real
  // pointerdown/up on our own panel — a safe, map-free, listener-free spot in
  // the top-right corner that can't add a waypoint or trigger the popover's own
  // "Delete" action. Escape is kept as a backup. Returns true if it closed.
  async function dismissStravaPopover() {
    if (!findStravaPopover()) return false;
    const panelEl = document.getElementById("wrp-panel");
    let x = 5, y = 5;
    if (panelEl) {
      const pr = panelEl.getBoundingClientRect();
      x = Math.round(pr.left + pr.width / 2);
      y = Math.round(pr.top + 10); // over the title text (no click handler)
    }
    const el = document.elementFromPoint(x, y) || panelEl || document.body;
    const opts = (type) => ({
      bubbles: true, cancelable: true, composed: true,
      clientX: x, clientY: y, button: 0,
      buttons: type.endsWith("down") ? 1 : 0,
    });
    el.dispatchEvent(new PointerEvent("pointerdown", {
      ...opts("pointerdown"), pointerId: 1, pointerType: "mouse", isPrimary: true,
    }));
    el.dispatchEvent(new MouseEvent("mousedown", opts("mousedown")));
    el.dispatchEvent(new PointerEvent("pointerup", {
      ...opts("pointerup"), pointerId: 1, pointerType: "mouse", isPrimary: true,
    }));
    el.dispatchEvent(new MouseEvent("mouseup", opts("mouseup")));
    // Escape backup.
    for (const type of ["keydown", "keyup"]) {
      document.dispatchEvent(new KeyboardEvent(type, {
        key: "Escape", code: "Escape", keyCode: 27, which: 27,
        bubbles: true, cancelable: true,
      }));
    }
    await sleep(90);
    return !findStravaPopover();
  }

  // While we replay synthetic clicks, Mapbox's own interaction handlers must be
  // OFF. Otherwise each emitted pointerdown/up is partly interpreted as a drag,
  // the map pans a few pixels per point, and that drift accumulates so every
  // later waypoint lands progressively off-route — the tell-tale "star/fan" of
  // crossing segments. Strava's waypoint-add listener is separate from these
  // gesture handlers, so disabling them still lets points register. Returns a
  // restore() that re-enables exactly the handlers we turned off.
  function freezeMapGestures(map) {
    const handlers = [
      "dragPan", "dragRotate", "scrollZoom", "boxZoom",
      "touchZoomRotate", "keyboard", "doubleClickZoom",
    ];
    const reEnable = [];
    for (const name of handlers) {
      try {
        const ctl = map[name];
        if (ctl && typeof ctl.isEnabled === "function" &&
            typeof ctl.disable === "function" && typeof ctl.enable === "function") {
          if (ctl.isEnabled()) {
            ctl.disable();
            reEnable.push(name);
          }
        }
      } catch (_e) { /* ignore individual handler */ }
    }
    return function restore() {
      for (const name of reEnable) {
        try { map[name].enable(); } catch (_e) { /* ignore */ }
      }
    };
  }

  async function onCreate() {
    try {
      const res = window.__wrpLast;
      if (!res) return setStatus("Plan a route first.");
      // Place into the map that actually owns clicks at the screen centre, not
      // just the largest visible map — those can differ, which is what scattered
      // earlier attempts (we drew/projected on one map but Strava read clicks on
      // another). Fall back to the generic finder if hit-testing comes up empty.
      const map = findInteractiveMap() || findMap();
      if (!map) return setStatus("Map not found — click the route-builder map once, then retry.");
      const canvas = map.getCanvas && map.getCanvas();
      if (!canvas) return setStatus("Map canvas not available.");

      const manual = await ensureManualMode();
      if (!manual.ok) {
        setStatus(
          "Enable Strava's \"Manual mode\" toggle first, then click Create again " +
          "(could not toggle it automatically)."
        );
        return;
      }

      const pts = pointsForManual(res.coordinates);
      if (pts.length < 2) return setStatus("Route too short to create.");

      // Log which map we picked, and a snapshot of the centre element, so a
      // failed run is diagnosable: if the centre element is not a Strava map
      // layer, Strava won't register the click as a waypoint.
      try {
        const { x, y } = centreProbePoint();
        const probe = document.elementFromPoint(x, y);
        // eslint-disable-next-line no-console
        console.log("[WRP] create: chosen map + centre element", {
          centreEl: probe && `${probe.tagName}.${(probe.className || "").toString().slice(0, 60)}`,
          mapContainerHasProbe: !!(map.getContainer && map.getContainer().contains(probe)),
          candidateMaps: collectMaps().filter(looksLikeMap).length,
        });
      } catch (_e) { /* ignore diagnostics failure */ }

      // eslint-disable-next-line no-console
      console.log("[WRP] create: placing", pts.length, "points via centre-click");
      setStatus(`Creating route in Strava… 0/${pts.length} points`);

      // Zoom in enough that the ~15 m minimum point spacing maps to a healthy
      // pixel gap, so centring on point N+1 moves point N's marker clear of the
      // click pixel (no accidental re-click -> no context popover). We centre
      // each point individually, so a high zoom never pushes points off-screen.
      try {
        if (typeof map.getZoom === "function" && map.getZoom() < 16) {
          map.setZoom(16);
          await sleep(120);
        }
      } catch (_e) { /* ignore */ }

      let placed = 0, skipped = 0;
      // Freeze Mapbox's drag/zoom handlers on the SAME map we click, so our
      // synthetic clicks can only add waypoints — never pan or (double-click)
      // zoom the map. Freezing the wrong instance is why zoom still happened
      // before. Restored in finally.
      const restoreGestures = freezeMapGestures(map);
      try {
        for (let i = 0; i < pts.length; i++) {
          const [la, ln] = pts[i];
          const r = await placePointCentered(map, canvas, ln, la, i % 2 === 0);
          if (r.ok) placed++; else skipped++;
          if (i === 0) {
            const el = r.el;
            // eslint-disable-next-line no-console
            console.log("[WRP] first point:", {
              lat: la, lng: ln, ok: r.ok,
              clickedEl: el && `${el.tagName}.${(el.className || "").toString().slice(0, 60)}`,
            });
          }
          setStatus(`Creating route in Strava… ${i + 1}/${pts.length} points`);
          // Spacing keeps consecutive clicks apart in time (no double-click) and
          // gives Strava time to register each waypoint.
          await sleep(180);
        }
      } finally {
        restoreGestures();
      }
      // Clear any popover left open by the final waypoint so the user sees a
      // clean map ready for "Save Route".
      await dismissStravaPopover();
      // eslint-disable-next-line no-console
      console.log(`[WRP] create done: placed ${placed}/${pts.length}, ${skipped} skipped`);
      setStatus(
        `Placed ${placed}/${pts.length} points. ` +
        `Review and click Strava's "Save Route".` +
        (skipped ? ` ${skipped} could not be placed.` : "") +
        (placed === 0 ? " Nothing registered — see console." : "")
      );
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[WRP] create failed:", err);
      setStatus("Create failed: " + err.message + " (see console).");
    }
  }

  function onDownloadGpx() {
    const res = window.__wrpLast;
    if (!res || !res.gpx) return setStatus("Plan a route first.");
    const blob = new Blob([res.gpx], { type: "application/gpx+xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const date = new Date().toISOString().slice(0, 10);
    a.download = `wandrer-run-${date}-${res.distance_km}km.gpx`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    setStatus(
      `Saved ${a.download}. Load it on your watch (Garmin/COROS…) or import into ` +
      "your mapping app. In Strava: Dashboard → Routes → Upload a Route (subscriber)."
    );
  }
})();
