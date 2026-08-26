# WasserKlima Bayern — Full Implementation Summary

A climate + flood visualization for Bavaria and Upper Austria, built for a
university thesis. React + TypeScript + Vite, deck.gl for the 3D map,
D3.js for the scroll-driven charts, Zustand for global state.

This document summarizes everything implemented across this project's most
recent working session, organized by feature, with exact location in the
app, what it does, and — critically — what's real data vs. simulated/
approximate, since that distinction was treated as a hard requirement
throughout.

---

## 1. Original five "future work" features

### 1.1 Cross-variable correlation (precipitation ↔ flooding)
- **Where:** Drought Signal chart (scrolled story section) → Flood History
  chart directly below it.
- **What:** Hovering a bar on the drought chart checks whether that year
  (or the year after) had a flood peak >4m. If so, the matching bar on the
  flood chart gets a white pulsing outline, a "← same year as [heavy
  rain/drought]" / "← year after [heavy rain/drought]" label, and a plain-
  language insight sentence appears between the two charts.
- **Implementation note:** originally only fired for dry years (drought →
  later flood). Extended to also fire symmetrically for wet years
  (precipitation → flood), since that's the literal case requested. A
  `correlationTrigger: 'dry' | 'wet'` field was added to the store so the
  label text stays accurate about which condition triggered it.
- **Determinism fix:** the underlying simulated flood-data generator was
  switched from `Math.random()` to a seeded deterministic function, so the
  Drought chart and Flood chart — which each hold independent local state —
  always agree on the same year's flood level.

### 1.2 Flood extent polygons (2013 + 2002)
- **Where:** Map → Flood tab, year-range slider set so a documented flood
  year falls inside the selected range.
- **What:** Semi-transparent blue polygon overlays near Passau/Deggendorf
  for the 2013 and 2002 floods, with a slow pulsing opacity animation and a
  floating legend explicitly labeled "Approximate — Source: documented
  flood records."
- **Honesty framing:** these are hand-drawn stylized approximations from
  documented flood descriptions and news coverage, not real GIS survey
  data. Labeled "approximate" in every tooltip/legend instance.
- **Bug found and fixed:** visibility was originally keyed only to the
  range slider's "To" value being within ±1 year of the flood — meaning
  dragging "From" to 2013 while "To" stayed at 2024 never showed the
  overlay. Fixed to check whether the flood year falls anywhere inside the
  selected `[From, To]` range.

### 1.3 Live current conditions
- **Where:** Map → Flood tab — a "● LIVE Danube at Passau: ≈X.Xm ·
  [Normal/Elevated/Warning]" badge at top-center, and a "NOW" marker on the
  Space-Time Wall (brighter panel, floating label; overrides that panel's
  height to match the live value when it differs from the historical
  simulated 2024 figure).
- **Data source reality check:** HND Bayern's real gauge API is confirmed
  dead (returns "object not found," not merely CORS-blocked). The public
  CORS-proxy fallback (corsproxy.io) is also blocked. So the live signal is
  an **estimate derived from live Open-Meteo precipitation data** via a
  simple rainfall→level formula — explicitly labeled "estimated" in the UI,
  never presented as a real sensor reading.

### 1.4 User-steered progressive loading
- **Where:** Warming Stripes chart — hover any stripe.
- **What:** Hovering a stripe sets that decade as "priority," triggering an
  Open-Meteo fetch for that decade's monthly-resolution data ahead of the
  app's default loading schedule. Once loaded, the tooltip expands to show
  12 small colored squares (one per month, colored by relative temperature
  within that year). A shimmer animation plays on stripes in the currently-
  loading priority decade.

### 1.5 Multitouch + immersive analytics (touch-table deployment)
- **Multi-pointer independence:** year-range sliders now stop touch-event
  propagation so dragging a slider doesn't simultaneously pan/rotate the
  map underneath (this was a real bug — both elements listened for the
  same touch events).
- **Position-aware hint:** on displays ≥1920px wide, a CSS `::after` hint
  reads "Touch any region to explore its climate story."
- **First-touch onboarding:** `GestureHints.tsx` — on touch-capable devices
  (`navigator.maxTouchPoints > 1`), a sequence of 4 gesture hints plays
  once per session (tracked via `sessionStorage`).
- **Keyboard shortcuts (desktop demo speed):** Space (play/pause),
  ←/→ (±1 year, Shift = ±10), C (compare mode), H (hotspots), 1/2/3 (tab
  switch), D (replay demo), plus a "?" button showing the full shortcut
  legend.

---

## 2. Professor's nine novelty requests (H-N1–H-N9) — status per item

| # | Request | Status |
|---|---|---|
| H-N1 | Animated heatmap of hotspots over 76 years | Built — district drought/temperature heatmap + year-range scrubbing. No dedicated autoplay "film" button (scrubbing only). |
| H-N2 | Click geography as primary interface | Built — clicking a river line jumps straight to its Flood-tab Space-Time Wall. |
| H-N3 | Precipitation → flood correlation | Built (see 1.1). |
| H-N4 | Flood area beyond riverbanks (Deggendorf) | Built (see 1.2), with the caveat that it's one combined shape, not separated into "river overflow" vs. "soil-saturation" mechanisms. |
| H-N5 | Hotspot detection over 76 years | Built as a >50%-of-years-severe threshold. **Caveat:** district-level severity is a procedurally generated stand-in (keyed off district ID number), not real per-district historical records — only ~11 named towns have real data. |
| H-N6 | Multi-river comparison wall | **Was missing entirely — built from scratch this session.** Pick a second river via the new "VS" selector; its Space-Time Wall renders alongside the first, each with independently-simulated flood series (previously all rivers shared one identical series, which would have made any comparison meaningless). The second wall is always positioned as a fixed offset "behind" the primary wall for legibility, not at its own real city. |
| H-N7 | Live feed of current conditions | Built (see 1.3). Scope is one station (Danube/Passau), not "each measurement point" as literally requested. |
| H-N8 | Cross-border Danube corridor | Built — dual wall (Passau + Linz), tooltip showing the flood wave arrived at Linz ~12h after Passau. Austrian towns selectable with real GeoSphere data. Scope limited to the Danube; Inn (which also crosses into Austria) has no equivalent second wall. |
| H-N9 | Immersive analytics / touch table | Built (see 1.5). Mixed-reality extension explicitly out of scope (was framed as speculative by the professor). |

---

## 3. Literature-derived novelties (L-N1–L-N5) — status per item

| # | Claim | Status |
|---|---|---|
| L-N1 | Multi-stream progressive sync (3 signals) | **Was only true for 2 of 3 — fixed.** Flood chart never participated in the shared decade→yearly→full staging (its simulated data was always instantly fully available). Now shares the same `progressStage`, with a decade-aggregated view (one bar per decade, worst flood that decade) and matching stage badge. |
| L-N2 | Personal lifetime overlay | Verified accurate as built — birth-year input recalculates lifetime average hot days and lifetime warming delta against the 1950–1980 baseline. |
| L-N3 | Scroll-driven progressive disclosure | **Was decorative only — fixed.** Scrolling used to just trigger a fade-in animation while data loaded on its own fixed timer regardless. Now the full-history fetch is genuinely gated behind scrolling into the Drought section (`scrollUnlockedFull` in the store) — if you never scroll that far, full resolution never loads. |
| L-N4 | User-steered progressive loading | Verified accurate — see 1.4. |
| L-N5 | Uncertainty-aware opacity encoding | Verified accurate — decade-stage bars render at ~50–55% opacity vs. 100% for confirmed yearly/full data, consistently across Warming Stripes, Drought, and (after the L-N1 fix) Flood. |

---

## 4. Additional UX work (not from either novelty list)

- **River visibility overhaul:** rivers on the Climate/Drought tabs were
  nearly invisible (1px hairlines at low opacity). Added a glow-underlay +
  brighter core-line treatment, plus procedural wave animation (reusing the
  Flood tab's existing wave math) so rivers visibly flow on every tab, not
  just Flood.
- **Map maximize + glass chart dock:** a maximize button expands the map to
  fill the viewport (Escape to exit, hierarchical — closes the innermost
  open panel first). While maximized, a frosted-glass dock lets you open
  any of the three story charts as a translucent overlay panel directly on
  top of the map, sized to its actual content height.
- **Drought tooltip NaN/percentage bug:** traced a reported "+99%" bug to
  its root cause — during the brief "yearly" loading stage, the 1950–1980
  baseline window has zero matching years in the partial dataset, causing
  a `0/0` division into `NaN`. Fixed with a fallback baseline source.

---

## 5. Data sources (verify-before-claiming, applied throughout)

### Bavaria
- **Climate** (temperature, precipitation): Open-Meteo historical archive
  API — real, free, no API key, verified directly against the live
  endpoint.
- **Flood:** intended source was HND Bayern's official gauge service —
  confirmed dead (`"object not found"` response, not CORS-blocked).
  Flood levels are simulated, anchored to real documented peak levels for
  known major events (1954, 2002, 2013, 2024), interpolated elsewhere.
  Labeled "simulated" throughout the UI.

### Austria
- **Climate** (Linz, Salzburg, Wels, Braunau): GeoSphere Austria DataHub
  API (`dataset.api.hub.geosphere.at`) — Austria's government climate data
  service, CC0-licensed. Verified genuinely CORS-open (real browser
  fetches work, no proxy needed). Station IDs looked up from GeoSphere's
  own metadata endpoint to match each town to its actual nearest active
  station.
- **Flood:** intended source was eHYD, the Austrian Hydrographic Service —
  it has no simple queryable REST API (data is served as HTML pages, not
  JSON), so — same honesty treatment as Bavaria — Austrian flood levels
  are simulated, anchored to real documented events specifically for Linz
  (1954, 1991, 2002, 2006, 2013, June 2024).

### "Live" current conditions
- HND Bayern's live endpoint and the CORS-proxy fallback are both
  confirmed non-functional. The live badge is an estimate derived from
  live Open-Meteo precipitation data via a simple rainfall-to-level
  formula, explicitly labeled "estimated" rather than implying a real
  sensor reading.

---

## 6. Guiding principle applied throughout

Every claim about live/real data, every novelty request, and every bug
report was independently verified against the actual running code or real
API responses before being confirmed or acted on — several "bugs" turned
out to be real, several claimed features turned out to be partially or
fully missing, and both categories were fixed rather than glossed over.
Anything simulated, approximate, or scoped narrower than originally
described is explicitly labeled as such in the UI itself, not just in
documentation.
