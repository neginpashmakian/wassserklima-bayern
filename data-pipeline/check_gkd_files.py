"""
Phase 5a/5b bridge: lists which GKD Bayern files from data/raw/gkd/README.md's
checklist are present in data/raw/gkd/, and for each present file, shows the
header metadata (station, site number, unit, gauge zero, date range, row
count).

Format verified directly against a real download (Passau/Donau, 10091008,
"Direkter Download" flow reproduced via Playwright) -- this is NOT eHYD's
format, despite the README's original assumption that they'd match:
  - Encoding is UTF-8 with a BOM, even though the GKD page itself states
    "Die Zeichenkodierung der Downloaddatei ist ISO 8859-1" -- verified
    directly against the actual file bytes (EF BB BF) rather than trusted.
  - No "Werte:" marker (eHYD's convention) -- the data block starts right
    after a "Datum;Mittelwert;Maximum;Minimum;Pruefstatus" column header
    line, semicolon-separated, decimal comma, ISO dates already.
  - Pegelnullpunktshoehe is a single current value here, not a dated
    history table like eHYD's Stammdaten export -- if a station's own page
    documents historical changes, that information isn't in this file and
    would need to come from the station's Stammdaten page separately.
  - Quality column is "Geprueft" (checked) or "Rohdaten" (provisional/raw,
    seen for the most recent ~2 weeks) -- not itself a gap marker. A true
    gap's exact representation (empty value field vs a missing date row
    entirely) was not yet confirmed against a real gap when this was
    written; both are checked for defensively.

The parser still falls back to a generic key;value scan (same as before)
for any file that doesn't match this structure, so an unexpected format is
visible rather than silently mis-parsed.

Run: python3 data-pipeline/check_gkd_files.py
"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
GKD_DIR = ROOT / 'data/raw/gkd'

EXPECTED = [
    ('Neu-Ulm / Donau (10026293)',                 'neu-ulm-10026293_W.csv',                       None),
    # Despite the "-q-" in its URL slug, this station's download is real
    # Wasserstand data, not Abfluss -- verified directly against the file's
    # own "Tageswerte Wasserstand [cm]" header line. It's a separate W-only
    # gauge from Neu-Ulm (10026293), not that station's Q companion.
    ('Neu-Ulm Bad Held / Donau (10026301)',        'neu-ulm-bad-held-10026301_W.csv',              None),
    ('Ingolstadt Luitpoldstraße / Donau (10046105)','ingolstadt-luitpoldstrasse-10046105_W.csv',   'ingolstadt-luitpoldstrasse-10046105_Q.csv'),
    ('Schwabelweis / Donau (10062000)',             'schwabelweis-10062000_W.csv',                  'schwabelweis-10062000_Q.csv'),
    ('Deggendorf / Donau (10081004)',               'deggendorf-10081004_W.csv',                    'deggendorf-10081004_Q.csv'),
    ('Passau / Donau (10091008)',                   'passau-10091008_W.csv',                        'passau-10091008_Q.csv'),
    ('Donauwörth / Donau (10039802)',               'donauwoerth-10039802_W.csv',                   None),
    ('Rosenheim o.d. Mangfallmündung / Inn (18001508)', 'rosenheim-od-mangfallmuendung-18001508_W.csv', None),
    ('Mühldorf / Inn (18004506)',                   'muehldorf-18004506_W.csv',                     'muehldorf-18004506_Q.csv'),
    ('Passau Ingling / Inn (18008008)',             'passau-ingling-18008008_W.csv',                None),
    ('München / Isar (16005701)',                   'muenchen-16005701_W.csv',                      'muenchen-16005701_Q.csv'),
    ('Landshut Birket / Isar (16007004)',           'landshut-birket-16007004_W.csv',                'landshut-birket-16007004_Q.csv'),
    ('Augsburg u.d. Wertachmündung / Lech (12006000)', 'augsburg-uwertachmuendung-12006000_W.csv', None),
    ('Stock / Chiemsee (18400503)',                 'stock-18400503_W.csv',                          None),
    ('Starnberg / Starnberger See (16663002)',      'starnberg-16663002_W.csv',                      None),
    ('Stegen / Ammersee (16602008)',                'stegen-16602008_W.csv',                         None),
]

DATE_RE = re.compile(r'^(\d{4}-\d{2}-\d{2})')
GAP_WORDS = {'lücke', 'lucke', 'luecke', 'fehlt', ''}


def sniff_encoding(path: Path) -> str:
    raw = path.read_bytes()
    if raw[:3] == b'\xef\xbb\xbf':
        return 'utf-8-sig'
    for enc in ('utf-8',):
        try:
            raw.decode(enc)
            return enc
        except UnicodeDecodeError:
            continue
    return 'latin-1'


def parse_gkd_file(lines):
    """Real GKD format: key;value header lines, then a 'Datum;...' column
    header, then data rows directly (no separate 'Werte:' marker)."""
    col_header_idx = next((i for i, l in enumerate(lines) if l.startswith('Datum;')), None)
    if col_header_idx is None:
        return None

    meta = {}
    for line in lines[:col_header_idx]:
        if ';' not in line:
            continue
        key, _, rest = line.partition(';')
        key = key.strip().rstrip(':').lower()
        rest = rest.strip()
        if key and rest and key not in meta:
            meta[key] = rest

    data_lines = [l for l in lines[col_header_idx + 1:] if l.strip()]
    n_total = len(data_lines)
    n_gap = 0
    n_rohdaten = 0
    first_date = last_date = None
    for line in data_lines:
        m = DATE_RE.match(line)
        if m:
            d = m.group(1)
            if first_date is None:
                first_date = d
            last_date = d
        parts = line.strip().split(';')
        if len(parts) < 2 or parts[1].strip().lower() in GAP_WORDS:
            n_gap += 1
        if len(parts) >= 5 and 'rohdaten' in parts[4].strip().lower():
            n_rohdaten += 1

    return {
        'format': 'gkd',
        'meta': meta,
        'gauge_zero_history': [(meta['pegelnullpunktshoehe'], None)] if 'pegelnullpunktshoehe' in meta else [],
        'n_rows': n_total,
        'n_gaps': n_gap,
        'n_provisional': n_rohdaten,
        'first_date': first_date,
        'last_date': last_date,
    }


def parse_ehyd_style_file(lines):
    """Fallback: eHYD's 'Werte:' marker convention, in case a GKD station
    ever exports in that shape too."""
    werte_idx = next((i for i, l in enumerate(lines) if l.strip().lower().startswith('werte:')), None)
    if werte_idx is None:
        return None
    header_lines = lines[:werte_idx]
    data_lines = [l for l in lines[werte_idx + 1:] if l.strip()]

    meta = {}
    gauge_zero_history = []
    for line in header_lines:
        if ';' not in line:
            continue
        key, _, rest = line.partition(';')
        key = key.strip().rstrip(':').lower()
        rest = rest.strip()
        if not rest:
            continue
        if re.match(r'^\d{2}\.\d{2}\.\d{4}$', key):
            gauge_zero_history.append((key, rest))
            continue
        if key and key not in meta:
            meta[key] = rest

    n_gap = sum(1 for l in data_lines if 'lücke' in l.lower() or 'luecke' in l.lower())
    date_re_de = re.compile(r'^(\d{2}\.\d{2}\.\d{4})')
    first_date = last_date = None
    for l in data_lines:
        m = date_re_de.match(l)
        if m:
            if first_date is None:
                first_date = m.group(1)
            last_date = m.group(1)

    return {
        'format': 'ehyd',
        'meta': meta,
        'gauge_zero_history': gauge_zero_history,
        'n_rows': len(data_lines),
        'n_gaps': n_gap,
        'n_provisional': None,
        'first_date': first_date,
        'last_date': last_date,
    }


def parse_file(path: Path):
    enc = sniff_encoding(path)
    with open(path, encoding=enc, newline='') as f:
        raw_lines = f.readlines()
    lines = [l.rstrip('\r\n') for l in raw_lines]

    info = parse_gkd_file(lines) or parse_ehyd_style_file(lines)
    if info is None:
        return {
            'format': 'unknown', 'encoding': enc, 'meta': {}, 'gauge_zero_history': [],
            'n_rows': 0, 'n_gaps': 0, 'n_provisional': None, 'first_date': None, 'last_date': None,
            'raw_header_preview': lines[:20],
        }
    info['encoding'] = enc
    return info


def main():
    if not GKD_DIR.exists():
        print(f'{GKD_DIR} does not exist.')
        return

    present, missing = [], []
    for label, w_file, q_file in EXPECTED:
        for fname, kind in ((w_file, 'W'), (q_file, 'Q')):
            if fname is None:
                continue
            path = GKD_DIR / fname
            if path.exists():
                present.append((label, kind, path))
            else:
                missing.append((label, kind, fname))

    print(f'=== {len(present)} file(s) present, {len(missing)} missing ===\n')

    if present:
        print('--- Present ---')
        for label, kind, path in present:
            print(f'\n[{kind}] {label}  ->  {path.name}')
            try:
                info = parse_file(path)
            except Exception as e:
                print(f'  FAILED TO PARSE: {e}')
                continue
            print(f'  format: {info["format"]}, encoding: {info["encoding"]}')
            if info['format'] == 'unknown':
                print('  WARNING: neither GKD nor eHYD structure recognized.')
                print('  Raw header (first 20 lines), inspect manually:')
                for l in info['raw_header_preview']:
                    print('   ', l)
                continue
            m = info['meta']
            for key in ('messstellen-name', 'messstelle', 'messstellen-nr.', 'gewässer', 'pegelnullpunktshoehe', 'pegelnullpunktshöhe'):
                if key in m:
                    print(f'  {key}: {m[key]}')
            if info['gauge_zero_history']:
                print('  Pegelnullpunkt:')
                for date, val in info['gauge_zero_history']:
                    print(f'    {date}' + (f': {val}' if val else ''))
            print(f'  date range: {info["first_date"]} .. {info["last_date"]}')
            gap_pct = f'{info["n_gaps"]/info["n_rows"]*100:.2f}%' if info['n_rows'] else 'n/a'
            print(f'  rows: {info["n_rows"]} total, {info["n_gaps"]} gaps ({gap_pct})', end='')
            if info['n_provisional'] is not None:
                print(f', {info["n_provisional"]} marked Rohdaten (provisional)')
            else:
                print()

    if missing:
        print('\n--- Missing ---')
        for label, kind, fname in missing:
            print(f'  [{kind}] {label}: {fname}')


if __name__ == '__main__':
    main()
