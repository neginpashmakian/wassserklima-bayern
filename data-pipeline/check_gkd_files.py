"""
Phase 5a/5b bridge: lists which GKD Bayern files from data/raw/gkd/README.md's
checklist are present in data/raw/gkd/, and for each present file, shows the
header metadata (station, site number, unit, gauge-zero history, date range,
row count) -- WITHOUT assuming a fixed column layout, since no real GKD file
was available to inspect while writing this (only the Austria eHYD format
had been verified directly). The header parser is generic/defensive: it
prints whatever key;value header lines it finds before the "Werte:" marker,
the same convention eHYD uses, and falls back to printing the raw header
verbatim if that marker or that structure isn't found, so the real format is
still visible even if this script's assumptions turn out wrong on the first
real file.

Run: python3 data-pipeline/check_gkd_files.py
"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
GKD_DIR = ROOT / 'data/raw/gkd'

# (station label, required W filename, optional Q filename or None)
# Kept in sync with data/raw/gkd/README.md's table -- update both together.
EXPECTED = [
    ('Neu-Ulm / Donau (10026293)',                 'neu-ulm-10026293_W.csv',                       None),
    ('Neu-Ulm Bad Held / Donau Q (10026301)',      'neu-ulm-bad-held-10026301_Q.csv',              None),
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

DATE_RE = re.compile(r'^\s*(\d{2}\.\d{2}\.\d{4})')
GAP_WORDS = {'lücke', 'lucke', 'luecke', ''}  # tolerate encoding fallback spellings


def sniff_encoding(path: Path) -> str:
    raw = path.read_bytes()
    for enc in ('utf-8-sig', 'utf-8'):
        try:
            raw.decode(enc)
            return enc
        except UnicodeDecodeError:
            continue
    return 'latin-1'  # GKD/eHYD convention, confirmed for eHYD directly


def parse_file(path: Path):
    enc = sniff_encoding(path)
    with open(path, encoding=enc, newline='') as f:
        lines = f.readlines()

    werte_idx = next((i for i, l in enumerate(lines) if l.strip().lower().startswith('werte:')), None)
    header_lines = lines[:werte_idx] if werte_idx is not None else lines
    data_lines = lines[werte_idx + 1:] if werte_idx is not None else []

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
            # a date-keyed row under a "Pegelnullpunkt" / gauge-zero block
            gauge_zero_history.append((key, rest))
            continue
        if key and key not in meta:
            meta[key] = rest

    n_total = len(data_lines)
    n_gap = 0
    first_date = last_date = None
    for line in data_lines:
        m = DATE_RE.match(line)
        if m:
            d = m.group(1)
            if first_date is None:
                first_date = d
            last_date = d
        val = line.rsplit(';', 1)[-1].strip().lower() if ';' in line else ''
        if val in GAP_WORDS or 'lücke' in line.lower() or 'luecke' in line.lower():
            n_gap += 1

    return {
        'encoding': enc,
        'werte_marker_found': werte_idx is not None,
        'meta': meta,
        'gauge_zero_history': gauge_zero_history,
        'n_rows': n_total,
        'n_gaps': n_gap,
        'first_date': first_date,
        'last_date': last_date,
        'raw_header_preview': header_lines[:20],
    }


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
            print(f'  encoding detected: {info["encoding"]}')
            if not info['werte_marker_found']:
                print('  WARNING: no "Werte:" marker found -- format differs from eHYD\'s convention.')
                print('  Raw header (first 20 lines), inspect manually:')
                for l in info['raw_header_preview']:
                    print('   ', l.rstrip())
                continue
            m = info['meta']
            for key in ('messstelle', 'gewässer', 'betreiber', 'messstellenbetreiber', 'dienststelle', 'einheit', 'hzb-nummer', 'dbms-nummer'):
                if key in m:
                    print(f'  {key}: {m[key]}')
            if info['gauge_zero_history']:
                print('  Pegelnullpunkt history:')
                for date, val in info['gauge_zero_history']:
                    print(f'    {date}: {val}')
            else:
                print('  Pegelnullpunkt: not found in expected header format -- check raw header manually.')
            print(f'  date range: {info["first_date"]} .. {info["last_date"]}')
            print(f'  rows: {info["n_rows"]} total, {info["n_gaps"]} gaps ({info["n_gaps"]/info["n_rows"]*100:.1f}%)' if info['n_rows'] else '  rows: 0')

    if missing:
        print('\n--- Missing ---')
        for label, kind, fname in missing:
            print(f'  [{kind}] {label}: {fname}')


if __name__ == '__main__':
    main()
