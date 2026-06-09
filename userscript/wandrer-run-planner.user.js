// ==UserScript==
// @name         Wandrer Run Planner
// @namespace    https://github.com/aslan91/wandrer-run-planner
// @version      0.1.0
// @description  Plan Strava runs that maximize untravelled (Wandrer red) paths within a target distance.
// @match        https://www.strava.com/routes*
// @match        https://www.strava.com/maps*
// @match        https://www.strava.com/athlete/maps*
// @grant        GM_xmlhttpRequest
// @connect      localhost
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  // ----------------------------------------------------------------------
  // Config
  // ----------------------------------------------------------------------
  const BACKEND = "http://localhost:8000/plan";

  // The Wandrer overlay is a vector source already loaded into Strava's Mapbox
  // GL map, so we read its features straight off the live map instead of
  // refetching/decoding tiles. These knobs control detection:
  const WANDRER = {
    // A source is considered the Wandrer overlay if its id or tile URLs match.
    SOURCE_MATCH: /wandrer/i,
    // A feature counts as travelled if any of these properties is truthy
    // (Wandrer uses US spelling). Adjust after running "Detect overlay".
    TRAVELLED_KEYS: ["traveled", "travelled", "achieved", "done", "v"],
    // Optional manual override if auto-detection picks the wrong source.
    FORCE_SOURCE_ID: "",
  };

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
  // Strava stores it on a DOM node; we probe known spots and fall back to a
  // canvas walk. Returns the mapboxgl.Map or null.
  // ----------------------------------------------------------------------
  function findMap() {
    const guesses = [
      window.map,
      window.__map,
      window.routeBuilder && window.routeBuilder.map,
    ];
    for (const g of guesses) {
      if (g && typeof g.getCenter === "function") return g;
    }
    // Fall back: look for a node whose internal props hold a map.
    const canvases = document.querySelectorAll(".mapboxgl-canvas, canvas");
    for (const c of canvases) {
      const holder = c.closest(".mapboxgl-map") || c.parentElement;
      for (const key in holder || {}) {
        const val = holder[key];
        if (val && typeof val.getCenter === "function") return val;
      }
    }
    return null;
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
    <div id="wrp-status" style="margin-top:6px;font-size:12px;color:#444"></div>
  `;
  document.body.appendChild(panel);

  const $ = (id) => panel.querySelector(id);
  const setStatus = (t) => ($("#wrp-status").textContent = t);

  // Pick start: next click on the map sets the start point.
  $("#wrp-pick").addEventListener("click", () => {
    const map = findMap();
    if (!map) {
      setStatus("Map not found yet — open the route builder.");
      return;
    }
    pickingStart = true;
    setStatus("Click the map to set the start…");
    map.once("click", (e) => {
      startLatLng = { lat: e.lngLat.lat, lng: e.lngLat.lng };
      pickingStart = false;
      $("#wrp-start").textContent =
        `start: ${startLatLng.lat.toFixed(5)}, ${startLatLng.lng.toFixed(5)}`;
      setStatus("Start set.");
    });
  });

  $("#wrp-plan").addEventListener("click", onPlan);
  $("#wrp-detect").addEventListener("click", onDetect);

  // ----------------------------------------------------------------------
  // Locate the Wandrer vector source + its source-layers within the live
  // Mapbox GL style.
  // ----------------------------------------------------------------------
  function findWandrerSource(map) {
    const style = map.getStyle && map.getStyle();
    if (!style || !style.sources) return null;

    if (WANDRER.FORCE_SOURCE_ID && style.sources[WANDRER.FORCE_SOURCE_ID]) {
      return collectSourceLayers(style, WANDRER.FORCE_SOURCE_ID);
    }
    for (const [id, src] of Object.entries(style.sources)) {
      const hay = JSON.stringify(src) + " " + id;
      if (WANDRER.SOURCE_MATCH.test(hay)) {
        return collectSourceLayers(style, id);
      }
    }
    return null;
  }

  function collectSourceLayers(style, sourceId) {
    const sourceLayers = new Set();
    for (const layer of style.layers || []) {
      if (layer.source === sourceId && layer["source-layer"]) {
        sourceLayers.add(layer["source-layer"]);
      }
    }
    // Vector sources need a source-layer; if none referenced, try empty (some
    // styles let querySourceFeatures work without it).
    return { sourceId, sourceLayers: [...sourceLayers] };
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
  // Read travelled geometry directly from the live Wandrer overlay source.
  // Returns { travelled: [[ [lat,lng], ... ], ...], stats }.
  // ----------------------------------------------------------------------
  function readTravelled(map) {
    const found = findWandrerSource(map);
    if (!found) {
      return { travelled: [], stats: { source: null } };
    }
    const { sourceId, sourceLayers } = found;
    const layerArgs = sourceLayers.length ? sourceLayers : [undefined];

    let total = 0;
    let travelledCount = 0;
    const sampleKeys = new Set();
    const polylines = [];
    const seen = new Set();

    for (const sl of layerArgs) {
      let feats = [];
      try {
        feats = map.querySourceFeatures(sourceId, sl ? { sourceLayer: sl } : {});
      } catch (_e) {
        continue;
      }
      for (const f of feats) {
        total++;
        Object.keys(f.properties || {}).forEach((k) => sampleKeys.add(k));
        if (!isTravelled(f.properties)) continue;
        // Deduplicate features split across tiles by id when available.
        const fid = f.id != null ? `${sl}:${f.id}` : null;
        if (fid && seen.has(fid)) continue;
        if (fid) seen.add(fid);
        travelledCount++;
        for (const pl of geometryToPolylines(f.geometry)) {
          if (pl.length >= 2) polylines.push(pl);
        }
      }
    }

    return {
      travelled: polylines,
      stats: {
        source: sourceId,
        sourceLayers,
        total,
        travelled: travelledCount,
        keys: [...sampleKeys],
      },
    };
  }

  function onDetect() {
    const map = findMap();
    if (!map) return setStatus("Map not found — open the route builder.");
    const { stats } = readTravelled(map);
    if (!stats.source) {
      setStatus(
        "No Wandrer source found. Ensure the overlay is ON, then check " +
        "SOURCE_MATCH. Open the console for available source ids."
      );
      try {
        // eslint-disable-next-line no-console
        console.log("[WRP] sources:", Object.keys(map.getStyle().sources));
      } catch (_e) { /* ignore */ }
      return;
    }
    setStatus(
      `Source "${stats.source}" — ${stats.travelled}/${stats.total} travelled ` +
      `in view. Property keys: ${stats.keys.join(", ") || "(none)"}.`
    );
    // eslint-disable-next-line no-console
    console.log("[WRP] detect:", stats);
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
        onerror: () => reject(new Error("Backend unreachable (is it running on :8000?)")),
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
    const { travelled, stats } = readTravelled(map);
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
      });
      drawRoute(map, res.coordinates);
      setStatus(
        `Done: ${res.distance_km} km, new ${res.new_km} km ` +
        `(${res.coverage_pct}% new), repeat ${res.repeat_km} km.`
      );
      // Stash for the next step (create-in-Strava).
      window.__wrpLast = res;
    } catch (err) {
      setStatus("Error: " + err.message);
    }
  }
})();
