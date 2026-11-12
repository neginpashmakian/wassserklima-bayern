# eHYD download checklist — Phase 5 (Linz)

Only one station needed here: **Linz / Donau**, HZB-Nummer **207068**,
operator **via donau – Österreichische Wasserstraßen-GmbH**.

Unlike GKD Bayern, eHYD's own search UI (ehyd.gv.at) is a JavaScript
single-page app that can't be scraped directly — but its CSV **export
endpoint itself is a plain, working, unauthenticated URL**, verified
directly in Phase 5a:

```
https://ehyd.gv.at/services/MessstellenExtraData/owf?id=207068&file=<n>
```

`<n>` selects which file; each returns a different `Content-Disposition`
filename (confirmed 2026-11-09):

| `file=` | Filename | Contents | Use |
|---|---|---|---|
| 1 | `Stammdaten-207068.csv` | Station master data — name, operator, gauge-zero history (3 changes recorded: 1821, 1939, 1959), coordinate history | metadata only |
| 2 | **`W-Tagesmittel-207068.csv`** | **Daily mean water level, 1921-01-01 to 2024-01-01 (~1 MB, ~37,500 rows), cm** | **the one we need** |
| 3 | `W-Monatsminima-207068.csv` | Monthly minima | optional cross-check |
| 4 | `W-Monatsmaxima-207068.csv` | Monthly maxima | optional cross-check |
| 5 | `WT-Monatsmittel-207068.csv` | Monthly mean water temperature | not needed |

`file=6` upward returned nothing for this station — no separate discharge
(Q) export was found via this endpoint for Linz; if Q turns out to be
needed later, it may be published under a different HZB number specific to
discharge (not investigated further in this pass).

## To download

Either:
- **Browser**: open
  `https://ehyd.gv.at/services/MessstellenExtraData/owf?id=207068&file=2`
  directly — it triggers an immediate file download, no login, no form.
- **Command line** (works, already verified):
  ```
  curl -s "https://ehyd.gv.at/services/MessstellenExtraData/owf?id=207068&file=2" \
    -A "Mozilla/5.0" -o data/raw/ehyd/linz-207068_W-Tagesmittel.csv
  ```

Save it as: `linz-207068_W-Tagesmittel.csv`

Also grab `file=1` (Stammdaten) and save as `linz-207068_Stammdaten.csv` —
the processing script needs it for the gauge-zero history (it changed at
least 3 times: 1821, 1939, 1959 — a real example of the "changed gauge
zero over time" case Phase 5b's validation step needs to flag).

## Format note (inspect before writing the parser)

- Encoding has non-ASCII mangled under plain `curl` output (ß/ü etc. show as
  `�`) — confirm the real encoding (likely ISO-8859-1 or Windows-1252, not
  UTF-8) before parsing.
- Semicolon-separated, header block before a `Werte:` marker line, then
  `DD.MM.YYYY HH:MM:SS;  value` rows.
- Missing days are marked literally as `Lücke` (gap) in the value column —
  log these, don't fill them (matches the existing "never fill gaps" rule
  for GKD too).
- Values are in cm, relative to the gauge zero valid at that date — watch
  for the 1959 gauge-zero change when computing a continuous series.
