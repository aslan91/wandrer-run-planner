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

  // Wandrer overlay tile source. Capture these from DevTools -> Network while
  // the Wandrer overlay is active (filter ".pbf" / ".mvt" / "wandrer"):
  //   - URL_TEMPLATE: the tile URL with {z}/{x}/{y} placeholders
  //   - TRAVELLED_PROP: the vector-tile feature property that is truthy when a
  //     segment has been travelled (e.g. "traveled", "achieved", "v")
  // Until filled in, the planner treats every path as untravelled.
  const WANDRER = {
    URL_TEMPLATE: "", // e.g. "https://tiles.wandrer.earth/.../{z}/{x}/{y}.pbf?token=..."
    TRAVELLED_PROP: "traveled",
    enabled: false,
  };

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

  // ----------------------------------------------------------------------
  // Read travelled geometry from the Wandrer overlay (placeholder).
  // Once WANDRER is configured, fetch the vector tiles covering the current
  // map bounds, decode them, and return travelled polylines as [[lat,lng],...].
  // ----------------------------------------------------------------------
  async function readTravelled(/* map */) {
    if (!WANDRER.enabled || !WANDRER.URL_TEMPLATE) return [];
    // TODO: fetch tiles for current bounds, decode MVT (e.g. @mapbox/vector-tile),
    // keep features where feature.properties[WANDRER.TRAVELLED_PROP] is truthy,
    // convert their geometry to [lat,lng] polylines.
    return [];
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
    const travelled = await readTravelled(map).catch(() => []);

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
