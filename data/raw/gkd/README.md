# GKD Bayern download checklist — Phase 5

Manual download checklist for `data/raw/gkd/`. GKD Bayern (gkd.bayern.de) is a
web-UI-only portal — no scrapable bulk-download API was found, so these have
to be downloaded by hand, one station at a time (the portal also WAF-blocks
rapid automated/parallel requests).

## General procedure (same for every station below)

1. Open the station's **Stammdaten URL** given below.
2. Click **Datendownload** in the page's side navigation (or go directly to
   `<stammdaten-url>/download`).
3. You'll see two resolution options:
   - **Einzelwerte** (high-resolution, ~15-min values)
   - **Tageswerte** (daily mean values) — **use this one**, it's what the
     processing script expects.
4. Pick water level (**Wasserstand**) first; repeat the whole station entry a
   second time for discharge (**Abfluss**) where the table below says "W+Q".
5. Choose the time range: select **"Gesamter Zeitraum" (entire period)** —
   do NOT restrict to current month/year. No login or email is required for
   this preset (only custom date ranges require an email for async
   delivery, per GKD's own page — unnecessary here).
6. Click **Direkter Download**. You'll get a CSV
   (ISO-8859-1 encoded, semicolon-separated, decimal comma, with a short
   metadata header before the actual Werte: rows — same format as the
   Austria eHYD files, inspect a real file's header before writing the
   parser).
7. Save the file using the exact filename pattern below into this folder
   (`data/raw/gkd/`) — the processing script will look for these exact
   names.

## Stations (Wasserstand = W, Abfluss = Q where available)

| # | App id | Station name | Site no. | River | Operator | Stammdaten URL | Save as |
|---|--------|---------------|----------|-------|----------|-----------------|---------|
| 1 | `ulm` | Neu-Ulm / Donau | 10026293 | Donau | WWA Donauwörth | https://www.gkd.bayern.de/de/fluesse/wasserstand/bayern/neu-ulm-10026293 | `neu-ulm-10026293_W.csv` |
| 2 | `ulm` (Q) | Neu-Ulm Bad Held / Donau | 10026301 | Donau | WWA Donauwörth | https://www.gkd.bayern.de/de/fluesse/wasserstand/kelheim/neu-ulm-bad-held-q-10026301 | `neu-ulm-bad-held-10026301_Q.csv` |
| 3 | `ingolstadt` | Ingolstadt Luitpoldstraße / Donau | 10046105 | Donau | WWA Ingolstadt | https://www.gkd.bayern.de/de/fluesse/wasserstand/kelheim/ingolstadt-luitpoldstrasse-10046105 | `ingolstadt-luitpoldstrasse-10046105_W.csv` (+ `_Q.csv`, same page has Abfluss tab) |
| 4 | `regensburg` | Schwabelweis / Donau | 10062000 | Donau | WSA Donau MDK | https://www.gkd.bayern.de/de/fluesse/wasserstand/passau/schwabelweis-10062000 | `schwabelweis-10062000_W.csv` (+ `_Q.csv`) |
| 5 | `deggendorf` | Deggendorf / Donau | 10081004 | Donau | WSA Donau MDK | https://www.gkd.bayern.de/de/fluesse/wasserstand/passau/deggendorf-10081004 | `deggendorf-10081004_W.csv` (+ `_Q.csv`) |
| 6 | `passau` | **Passau / Donau** (= Pegelonline "PASSAU DONAU") | 10091008 | Donau | WSA Donau MDK | https://www.gkd.bayern.de/de/fluesse/wasserstand/bayern/passau-10091008 | `passau-10091008_W.csv` (+ `_Q.csv`) — **not** Passau-Ilzstadt (10092000) |
| 7 | `donauwoerth` | Donauwörth / Donau | 10039802 | Donau | WWA Donauwörth | https://www.hnd.bayern.de/pegel/donau_bis_kelheim/donauwoerth-10039802/stammdaten (confirm the gkd.bayern.de equivalent URL when you open it — same site number) | `donauwoerth-10039802_W.csv` |
| 8 | `rosenheim` | Rosenheim o.d. Mangfallmündung / Inn | 18001508 | Inn | WWA Rosenheim | https://www.gkd.bayern.de/de/fluesse/wasserstand/bayern/rosenheim-o-d-mangfallmuendung-18001508 | `rosenheim-od-mangfallmuendung-18001508_W.csv` |
| 9 | `muehldorf` | Mühldorf / Inn | 18004506 | Inn | WWA Rosenheim | https://www.gkd.bayern.de/de/fluesse/wasserstand/isar/muehldorf-18004506 | `muehldorf-18004506_W.csv` (+ `_Q.csv`) |
| 10 | `braunau` | **Passau Ingling / Inn** (replaces Braunau-Simbach KW — see note) | 18008008 | Inn | WWA Deggendorf | https://www.gkd.bayern.de/de/fluesse/wasserstand/passau/passau-ingling-18008008 | `passau-ingling-18008008_W.csv` |
| 11 | `munich` | München / Isar | 16005701 | Isar | WWA München | https://www.gkd.bayern.de/de/fluesse/abfluss/bayern/muenchen-16005701 | `muenchen-16005701_W.csv` (+ `_Q.csv`) |
| 12 | `landshut` | **Landshut Birket / Isar** (not Flutmulde) | 16007004 | Isar | WWA Landshut | https://www.gkd.bayern.de/de/fluesse/abfluss/isar/landshut-birket-16007004 | `landshut-birket-16007004_W.csv` (+ `_Q.csv`) |
| 13 | `augsburg` | Augsburg u. d. Wertachmündung / Lech | 12006000 | Lech | WWA Donauwörth | https://www.gkd.bayern.de/de/fluesse/wasserstand/bayern/augsburg-u-d-wertachmuendung-12006000 | `augsburg-uwertachmuendung-12006000_W.csv` — this is the lowest (most downstream) state-operated Lech gauge; none exists further downstream (verified) |
| 14 | `chiemsee` | Stock / Chiemsee | 18400503 | Chiemsee (lake) | WWA Rosenheim | https://www.gkd.bayern.de/de/seen/wasserstand/isar/stock-18400503 | `stock-18400503_W.csv` |
| 15 | `starnberg` | Starnberg / Starnberger See | 16663002 | Starnberger See (lake) | WWA Weilheim | https://www.gkd.bayern.de/de/seen/wasserstand/isar/starnberg-16663002 | `starnberg-16663002_W.csv` |
| 16 | `ammersee` | Stegen / Ammersee | 16602008 | Ammersee (lake) | WWA Weilheim | https://www.gkd.bayern.de/de/seen/wasserstand/isar/stegen-16602008 | `stegen-16602008_W.csv` |

## Notes

- **Braunau-Simbach KW (18005702)** was NOT used — confirmed operated by
  Verbund AG Wasserkraft Österreich (a hydropower company), not a Bavarian
  government agency. Replaced with **Passau Ingling (18008008)**, operated
  by WWA Deggendorf, at the very mouth of the Inn — a different physical
  location from Braunau itself; see the Phase 5a report for the exact
  reasoning and how this should be reflected in `geoData.ts`.
- **Donauwörth** is on the Danube, not the Lech — moved lists accordingly.
- For federally-operated gauges (WSA Donau MDK: Passau, Schwabelweis,
  Deggendorf), the same GKD download UI was confirmed to work with no
  extra login — GKD aggregates display/download access uniformly regardless
  of which agency actually operates the gauge.
- If any station's download page behaves differently from this checklist
  (extra confirmation step, missing Tageswerte option, etc.), note it here
  before reporting back — don't guess at a workaround.
