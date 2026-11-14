# GKD Bayern download checklist — Phase 5

Originally written as a manual download checklist. Updated 2026-11-13: the
exact "Direkter Download" request was found and reproduced automatically
(Playwright driving the real browser flow — select Gesamtzeitraum +
Tageswerte, submit, the request goes to `/de/downloadcenter/enqueue_download`
which returns a `deeplink` token URL, poll that same URL in the same browser
session until it says "Ihr Download steht zur Verfügung", then fetch
`<deeplink>&dl=1` for the actual file). GKD never blocked this — no WAF/
captcha was hit across all 17 stations, one at a time, 12s apart, normal
browser UA. Manual steps below are kept as a fallback/reference in case the
automated flow ever needs re-deriving (e.g. if GKD changes the flow).

**Real file format** (verified directly against actual downloads, NOT the
same as eHYD's "Werte:" convention this checklist originally assumed):
UTF-8 with a BOM (despite the page's own text claiming ISO-8859-1 — checked
the actual file bytes, don't trust the page's claim), header is `Key:;value`
lines, then a `Datum;Mittelwert;Maximum;Minimum;Prüfstatus` column header
with no separate marker line, then semicolon-separated rows with ISO dates
already, decimal comma. Status is "Geprueft" (quality-checked) or "Rohdaten"
(provisional, normal for the most recent ~2 weeks). A full-period download
often comes back as a **ZIP of several date-range-split CSVs** whose
filenames do NOT sort chronologically (e.g. "...01.01.2026_31.10.2026..."
sorts before "...beginn_bis_31.12.2025..." alphabetically) — sort by each
chunk's own first data date before concatenating, not by filename.

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

**Status as of 2026-11-13: all 17 W files + 2 real Q files fetched automatically** (see Part A step 3 of the Phase 5b prompt — reproduced the exact "Direkter Download" request via Playwright; GKD never blocked it, no hand-downloads were needed). Table below corrected against the real files actually received — two URLs/labels in the original research were wrong and are fixed here:

| # | App id | Station name | Site no. | River | Operator | Stammdaten URL | Save as |
|---|--------|---------------|----------|-------|----------|-----------------|---------|
| 1 | `ulm` | Neu-Ulm / Donau | 10026293 | Donau | WWA Donauwörth | https://www.gkd.bayern.de/de/fluesse/wasserstand/bayern/neu-ulm-10026293 | `neu-ulm-10026293_W.csv` |
| 2 | — | Neu-Ulm Bad Held / Donau — a separate W-only gauge, NOT a Q companion to #1 despite the "-q-" in its URL slug (verified: its download is "Tageswerte Wasserstand", not Abfluss) | 10026301 | Donau | WWA Donauwörth | https://www.gkd.bayern.de/de/fluesse/wasserstand/kelheim/neu-ulm-bad-held-q-10026301 | `neu-ulm-bad-held-10026301_W.csv` |
| 3 | `ingolstadt` | Ingolstadt Luitpoldstraße / Donau | 10046105 | Donau | WWA Ingolstadt | https://www.gkd.bayern.de/de/fluesse/wasserstand/kelheim/ingolstadt-luitpoldstrasse-10046105 | `ingolstadt-luitpoldstrasse-10046105_W.csv` (no Q found for this gauge) |
| 4 | `regensburg` | Schwabelweis / Donau | 10062000 | Donau | WSA Donau MDK | https://www.gkd.bayern.de/de/fluesse/wasserstand/passau/schwabelweis-10062000 | `schwabelweis-10062000_W.csv` (no Q found) |
| 5 | `deggendorf` | Deggendorf / Donau | 10081004 | Donau | WSA Donau MDK | https://www.gkd.bayern.de/de/fluesse/wasserstand/passau/deggendorf-10081004 | `deggendorf-10081004_W.csv` (no Q found; **note: this station's entire series, 2001-2026, is marked "Rohdaten"/provisional — never quality-checked, unlike every other station here**) |
| 6 | `passau` | **Passau / Donau** (= Pegelonline "PASSAU DONAU") | 10091008 | Donau | WSA Donau MDK | https://www.gkd.bayern.de/de/fluesse/wasserstand/bayern/passau-10091008 | `passau-10091008_W.csv` (no Q found for this exact gauge — Abfluss for the Passau area is only published under Passau-Ilzstadt, 10092000, a different physical station; not fetched, to avoid mixing datums under one label) — **not** Passau-Ilzstadt |
| 7 | `donauwoerth` | Donauwörth / Donau | 10039802 | Donau | WWA Donauwörth | https://www.gkd.bayern.de/de/fluesse/wasserstand/bayern/donauwoerth-10039802 | `donauwoerth-10039802_W.csv` |
| 8 | `rosenheim` | Rosenheim o.d. Mangfallmündung / Inn | 18001508 | Inn | WWA Rosenheim | https://www.gkd.bayern.de/de/fluesse/wasserstand/bayern/rosenheim-o-d-mangfallmuendung-18001508 | `rosenheim-od-mangfallmuendung-18001508_W.csv` |
| 9 | `muehldorf` | Mühldorf / Inn | 18004506 | Inn | WWA Rosenheim | https://www.gkd.bayern.de/de/fluesse/wasserstand/isar/muehldorf-18004506 | `muehldorf-18004506_W.csv` (no Q found) |
| 10 | `braunau` | **Passau Ingling / Inn** (replaces Braunau-Simbach KW — see note) | 18008008 | Inn | WWA Deggendorf | https://www.gkd.bayern.de/de/fluesse/wasserstand/passau/passau-ingling-18008008 | `passau-ingling-18008008_W.csv` |
| 11 | `munich` | München / Isar — **corrected URL**: the original research URL (`/fluesse/abfluss/...`) was the Abfluss page, not Wasserstand; a `/fluesse/wasserstand/...` page for the same site number also exists and is the real source for `_W.csv` | 16005701 | Isar | WWA München | https://www.gkd.bayern.de/de/fluesse/wasserstand/isar/muenchen-16005701 (W) / https://www.gkd.bayern.de/de/fluesse/abfluss/bayern/muenchen-16005701 (Q) | `muenchen-16005701_W.csv` + `muenchen-16005701_Q.csv` (both fetched, both real) |
| 12 | `landshut` | **Landshut Birket / Isar** (not Flutmulde) — same URL correction as München | 16007004 | Isar | WWA Landshut | https://www.gkd.bayern.de/de/fluesse/wasserstand/isar/landshut-birket-16007004 (W) / https://www.gkd.bayern.de/de/fluesse/abfluss/isar/landshut-birket-16007004 (Q) | `landshut-birket-16007004_W.csv` + `landshut-birket-16007004_Q.csv` (both fetched, both real) |
| 13 | `augsburg` | Augsburg u. d. Wertachmündung / Lech | 12006000 | Lech | WWA Donauwörth | https://www.gkd.bayern.de/de/fluesse/wasserstand/bayern/augsburg-u-d-wertachmuendung-12006000 | `augsburg-uwertachmuendung-12006000_W.csv` — this is the lowest (most downstream) state-operated Lech gauge; none exists further downstream (verified) |
| 14 | `chiemsee` | Stock / Chiemsee | 18400503 | Chiemsee (lake) | WWA Rosenheim | https://www.gkd.bayern.de/de/seen/wasserstand/isar/stock-18400503 | `stock-18400503_W.csv` — unit in the file is **m ü. NN**, not cm |
| 15 | `starnberg` | Starnberg / Starnberger See | 16663002 | Starnberger See (lake) | WWA Weilheim | https://www.gkd.bayern.de/de/seen/wasserstand/isar/starnberg-16663002 | `starnberg-16663002_W.csv` — unit **m ü. NN** |
| 16 | `ammersee` | Stegen / Ammersee | 16602008 | Ammersee (lake) | WWA Weilheim | https://www.gkd.bayern.de/de/seen/wasserstand/isar/stegen-16602008 | `stegen-16602008_W.csv` — unit **m ü. NN** |

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
