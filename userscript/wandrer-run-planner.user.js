// ==UserScript==
// @name         Wandrer Run Planner
// @namespace    https://github.com/aslan91/wandrer-run-planner
// @version      0.9.1
// @description  Plan Strava runs that maximize untravelled (Wandrer red) paths within a target distance.
// @match        https://www.strava.com/routes*
// @match        https://www.strava.com/maps*
// @match        https://www.strava.com/athlete/maps*
// @grant        GM_xmlhttpRequest
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

  // The Wandrer overlay is a vector source already loaded into Strava's Mapbox
  // GL map, so we read its features straight off the live map instead of
  // refetching/decoding tiles. These knobs control detection:
  const WANDRER = {
    // A source is considered a Wandrer overlay if its id or tile URLs match.
    SOURCE_MATCH: /wandrer/i,
    // Prefer sources for this activity when several Wandrer sources exist.
    ACTIVITY_MATCH: /run|foot|walk|hike/i,
    // Wandrer splits travelled vs untravelled into separate sources/layers, so
    // a source/source-layer whose name implies "travelled" means EVERY feature
    // in it is travelled (no per-feature property needed).
    TRAVELLED_NAME: /travel/i,
    UNTRAVELLED_NAME: /untravel|not.?travel|undone|missing/i,
    // Fallback only: if a source is NOT split by name, a feature counts as
    // travelled when any of these properties is truthy.
    TRAVELLED_KEYS: ["traveled", "travelled", "achieved", "done", "v"],
    // Optional manual override if auto-detection picks the wrong source.
    FORCE_SOURCE_ID: "",
  };

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

  // Install a constructor hook so future map creations (e.g. after reload) are
  // captured. Only works when mapboxgl is exposed globally; harmless otherwise.
  (function hookMapboxCtor() {
    window.__wrpMaps = window.__wrpMaps || [];
    function wrap(mb) {
      if (!mb || !mb.Map || mb.Map.__wrpHooked) return;
      const Orig = mb.Map;
      function Wrapped(...args) {
        const m = new Orig(...args);
        try { window.__wrpMaps.push(m); } catch (_e) { /* ignore */ }
        return m;
      }
      Wrapped.prototype = Orig.prototype;
      Object.setPrototypeOf(Wrapped, Orig);
      Wrapped.__wrpHooked = true;
      try { mb.Map = Wrapped; } catch (_e) { /* ignore */ }
    }
    try {
      let mb = window.mapboxgl;
      wrap(mb);
      Object.defineProperty(window, "mapboxgl", {
        configurable: true,
        get() { return mb; },
        set(v) { mb = v; wrap(v); },
      });
    } catch (_e) { /* mapboxgl already non-configurable or absent */ }
  })();

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
    const all = collectMaps();
    const best = pickVisibleMap(all);
    if (best) return (cachedMap = best);
    return null;
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
      window.map,
      window.__map,
      window.routeBuilder && window.routeBuilder.map,
      ...(window.__wrpMaps || []),
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
    // eslint-disable-next-line no-console
    console.log(
      "[WRP] map not found.",
      `canvases=${canvases.length}`,
      `mapboxgl-map containers=${containers.length}`,
      `nodes with React fiber=${withFiber}`,
      `hooked maps=${(window.__wrpMaps || []).length}`,
      "\nTip: make sure the route builder map is visible, then retry. If counts",
      "are all 0, the map may not be a Mapbox GL map or lives in a frame."
    );
  }

  // ----------------------------------------------------------------------
  // UI panel
  // ----------------------------------------------------------------------
  let startLatLng = null;
  let pickingStart = false;

  const panel = document.createElement("div");
  panel.style.cssText = [
    "position:fixed", "top:90px", "right:16px", "z-index:99999",
    "background:#fff", "border:1px solid #ddd", "border-radius:10px",
    "box-shadow:0 4px 16px rgba(0,0,0,.15)", "padding:12px 14px",
    "font:13px/1.4 system-ui,sans-serif", "width:240px", "color:#222",
  ].join(";");
  panel.innerHTML = `
    <div style="font-weight:600;margin-bottom:8px">Wandrer Run Planner</div>
    <label style="display:block;margin:6px 0">Target km
      <input id="wrp-km" type="number" value="6" step="0.5" min="1"
             style="width:100%;box-sizing:border-box"></label>
    <label style="display:block;margin:6px 0">Tolerance km
      <input id="wrp-tol" type="number" value="1" step="0.5" min="0"
             style="width:100%;box-sizing:border-box"></label>
    <button id="wrp-pick" style="width:100%;margin:6px 0;padding:6px">Pick start on map</button>
    <div id="wrp-start" style="color:#888;font-size:12px;margin:2px 0">start: (none)</div>
    <button id="wrp-detect" style="width:100%;margin:6px 0;padding:6px">Detect overlay</button>
    <button id="wrp-plan" style="width:100%;margin:6px 0;padding:6px;background:#fc4c02;color:#fff;border:none;border-radius:6px">Plan route</button>
    <button id="wrp-create" style="width:100%;margin:6px 0;padding:6px" disabled>Create in Strava (manual)</button>
    <button id="wrp-gpx" style="width:100%;margin:6px 0;padding:6px" disabled>Download GPX</button>
    <div id="wrp-status" style="margin-top:6px;font-size:12px;color:#444"></div>
  `;
  document.body.appendChild(panel);

  const $ = (id) => panel.querySelector(id);
  const setStatus = (t) => ($("#wrp-status").textContent = t);

  // Pick start: the next click anywhere over the map sets the start point.
  //
  // We listen on the document at the CAPTURE phase (not on the canvas) because
  // Strava stacks overlay elements (marker layers, interaction divs) above the
  // Mapbox canvas, so the click target is usually NOT the canvas. Capturing at
  // the document lets us intercept the click first, regardless of which child
  // was hit, then convert the pixel to lng/lat via map.unproject().
  $("#wrp-pick").addEventListener("click", () => {
    const map = findMap();
    if (!map) {
      logMapDiagnostics();
      setStatus("Map not found — open the route builder (see console for details).");
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
      startLatLng = { lat: lngLat.lat, lng: lngLat.lng };
      $("#wrp-start").textContent =
        `start: ${startLatLng.lat.toFixed(5)}, ${startLatLng.lng.toFixed(5)}`;
      setStatus("Start set.");
      cleanup();
    };

    document.addEventListener("pointerdown", swallow, true);
    document.addEventListener("mousedown", swallow, true);
    document.addEventListener("click", onDocClick, true);
    document.addEventListener("keydown", onKey, true);
  });

  $("#wrp-plan").addEventListener("click", onPlan);
  $("#wrp-detect").addEventListener("click", onDetect);
  $("#wrp-create").addEventListener("click", onCreate);
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
  // Read travelled geometry directly from the live Wandrer overlay sources.
  // Enumerates all Wandrer sources, probes each, and chooses the best
  // "travelled" source (preferring the configured activity + most features).
  // Returns { travelled: [[ [lat,lng], ... ], ...], stats }.
  // ----------------------------------------------------------------------
  function readTravelled(map) {
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

  function onDetect() {
    const map = findMap();
    if (!map) {
      logMapDiagnostics();
      return setStatus("Map not found — open the route builder (see console for details).");
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
  }

  async function onPlan() {
    const map = findMap();
    if (!map) return setStatus("Map not found.");
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
        `(${res.coverage_pct}% new), repeat ${res.repeat_km} km.`
      );
      // Stash for create-in-Strava / GPX download and enable those buttons.
      window.__wrpLast = res;
      $("#wrp-create").disabled = false;
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

  // Fit the map so the whole route is visible (clicks must land in the canvas).
  // Returns the route's bounds + centroid so the caller can verify the map
  // actually moved there.
  function fitRoute(map, coords) {
    let minLat = Infinity, minLng = Infinity, maxLat = -Infinity, maxLng = -Infinity;
    for (const [la, ln] of coords) {
      if (la < minLat) minLat = la;
      if (la > maxLat) maxLat = la;
      if (ln < minLng) minLng = ln;
      if (ln > maxLng) maxLng = ln;
    }
    try {
      map.fitBounds(
        [[minLng, minLat], [maxLng, maxLat]],
        { padding: 80, duration: 0, animate: false }
      );
    } catch (_e) { /* ignore */ }
    return {
      minLat, minLng, maxLat, maxLng,
      center: { lat: (minLat + maxLat) / 2, lng: (minLng + maxLng) / 2 },
    };
  }

  // Great-circle distance in metres between two {lat,lng}.
  function distM(a, b) {
    const R = 6371000, toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
    const s =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  }

  // Reduce points for manual mode: keep enough to follow curves but avoid
  // hundreds of clicks. Ramer–Douglas–Peucker on [lat,lng], capped at maxPoints.
  function pointsForManual(coords, toleranceM = 12, maxPoints = 120) {
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
    if (pts.length > maxPoints) {
      const step = pts.length / maxPoints;
      const out = [];
      for (let i = 0; i < maxPoints; i++) out.push(pts[Math.floor(i * step)]);
      out[out.length - 1] = coords[coords.length - 1];
      pts = out;
    }
    return pts;
  }

  // Add one waypoint by emitting a synthetic click on Strava's map canvas.
  //
  // map.fire('click', …) reaches Mapbox's internal event bus but Strava's manual
  // builder did NOT react to it — it listens to real DOM events on the canvas
  // (which Mapbox itself turns into a map 'click'). So we dispatch a genuine
  // pointer+mouse+click gesture on the canvas element at the projected pixel.
  // The browser does not synthesize 'click' from synthetic mousedown/up, so we
  // emit it explicitly. Same point for down+up => Mapbox treats it as a click,
  // not a drag.
  function clickAt(map, canvas, lat, lng) {
    try {
      const point = map.project([lng, lat]); // Point {x, y} in canvas pixels
      const rect = canvas.getBoundingClientRect();
      const clientX = rect.left + point.x;
      const clientY = rect.top + point.y;
      const onScreen =
        clientX >= rect.left && clientX <= rect.right &&
        clientY >= rect.top && clientY <= rect.bottom;

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
      const ptrOpts = (type) => ({
        ...opts(type),
        pointerId: 1,
        pointerType: "mouse",
        isPrimary: true,
      });

      // The element actually under the point (Mapbox listens on the canvas, but
      // an overlay may sit on top); dispatch to both to be safe.
      const top = document.elementFromPoint(clientX, clientY) || canvas;
      const targets = top === canvas ? [canvas] : [top, canvas];

      for (const target of targets) {
        target.dispatchEvent(new PointerEvent("pointerdown", ptrOpts("pointerdown")));
        target.dispatchEvent(new MouseEvent("mousedown", opts("mousedown")));
        target.dispatchEvent(new PointerEvent("pointerup", ptrOpts("pointerup")));
        target.dispatchEvent(new MouseEvent("mouseup", opts("mouseup")));
        target.dispatchEvent(new MouseEvent("click", opts("click")));
      }
      return { ok: true, onScreen, point, target: top && top.className };
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[WRP] clickAt failed:", err);
      return { ok: false, error: err };
    }
  }

  async function onCreate() {
    try {
      const res = window.__wrpLast;
      if (!res) return setStatus("Plan a route first.");
      const map = findMap();
      if (!map) return setStatus("Map not found.");
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
      const box = fitRoute(map, pts);
      await sleep(350); // let the map settle after fitBounds

      // Sanity-check: did we move the RIGHT map to the route? If the chosen map
      // ended up far from the route centroid, we likely grabbed the wrong map
      // instance (Strava can have several) — abort instead of clicking blindly.
      let center = null;
      try { const c = map.getCenter(); center = { lat: c.lat, lng: c.lng }; } catch (_e) { /* */ }
      const drift = center ? distM(center, box.center) : Infinity;
      // eslint-disable-next-line no-console
      console.log("[WRP] create: map check", {
        mapCenter: center,
        routeCenter: box.center,
        driftMeters: Math.round(drift),
        visibleMaps: collectMaps().map(mapVisibleArea),
      });
      if (drift > 3000) {
        setStatus(
          `Wrong map detected (center is ${(drift / 1000).toFixed(1)} km from the ` +
          "route). Click directly on the route-builder map once, then retry Create. " +
          "Or use Download GPX."
        );
        return;
      }

      // eslint-disable-next-line no-console
      console.log("[WRP] create: placing", pts.length, "points via DOM events");
      setStatus(`Creating route in Strava… 0/${pts.length} points`);
      let placed = 0, offscreen = 0;
      for (let i = 0; i < pts.length; i++) {
        const [la, ln] = pts[i];
        const r = clickAt(map, canvas, la, ln);
        if (r.ok) placed++;
        if (r.ok && r.onScreen === false) offscreen++;
        if (i === 0) {
          // eslint-disable-next-line no-console
          console.log("[WRP] first point:", { lat: la, lng: ln, result: r });
        }
        setStatus(`Creating route in Strava… ${i + 1}/${pts.length} points`);
        await sleep(120); // give Strava time to register each vertex
      }
      // eslint-disable-next-line no-console
      console.log(`[WRP] create done: placed ${placed}/${pts.length}, ${offscreen} off-screen`);
      setStatus(
        `Placed ${placed}/${pts.length} points. Review and click Strava's "Save Route".` +
        (offscreen ? ` (${offscreen} were off-screen.)` : "") +
        (placed === 0 ? " Nothing registered — see console; we may need a different click channel." : "")
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
    a.download = `wandrer-run-${res.distance_km}km.gpx`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    setStatus("GPX downloaded. Import via Strava → Routes → Upload, or load on your watch.");
  }
})();
