"""
Phase 4: per-town warming trend and hot days, computed from real gridded
data (HYRAS-DE v6-1 tas + DWD hot_days for Bavaria; GeoSphere SPARTACUS TM
+ GeoSphere station daily tlmax for Upper Austria), replacing the hand-typed
`warming`/`hotDays` fields on BAVARIAN_TOWNS/AUSTRIA_TOWNS in geoData.ts.

Unlike Phase 3 (zonal/area stats over district polygons), this is POINT
extraction: nearest grid cell to each town's (lat, lon), reprojected into
each grid's native CRS.

Bavaria towns: HYRAS tas 1951-2024 (EPSG:3035) + DWD hot_days 1951-2024
(EPSG:31467), same rasters already downloaded for Phase 3.

Austria towns: GeoSphere SPARTACUS TM (EPSG:3416) for the warming trend,
starting at the OWN station's real valid_from year (verified directly
against GeoSphere's metadata endpoint, not assumed) -- Linz 1895, Salzburg
1987, Wels 1983, Braunau 1961 -- common comparison window capped at 1951
like Bavaria (Linz has data back to 1895 but there's no real benefit in
starting earlier than Bavaria's own 1951 baseline). Hot days come from
GeoSphere's own station DAILY tlmax (fetched live here, offline script ->
no browser CORS concern), counting days with tlmax >= 30C per year -- a
point station measurement, arguably more precise than a gridded product,
and the only hot-days-equivalent source available for Austria in this
pipeline (no DWD-style grid exists for Austria).

Output: public/data/towns-climate.json, keyed by town name.
"""
import json
import time
from pathlib import Path

import numpy as np
import xarray as xr
import rioxarray  # noqa: F401
import rasterio
import requests
from pyproj import Transformer

ROOT = Path(__file__).resolve().parents[2]
TAS_DIR = ROOT / 'data/raw/hyras/tas'
HOTDAYS_DIR = ROOT / 'data/raw/dwd-hot-days'
SPARTACUS_TM_FILES = sorted((ROOT / 'data/raw/geosphere-spartacus/tm').glob('*.nc'))
OUT_FILE = ROOT / 'public/data/towns-climate.json'

START_YEAR, END_YEAR = 1951, 2024
BASELINE_START, BASELINE_END = 1961, 1990

BAVARIAN_TOWNS = [
    {'name': 'Passau',        'lat': 48.5748, 'lon': 13.4647},
    {'name': 'München',       'lat': 48.1372, 'lon': 11.5755},
    {'name': 'Nürnberg',      'lat': 49.4521, 'lon': 11.0767},
    {'name': 'Regensburg',    'lat': 49.0134, 'lon': 12.1016},
    {'name': 'Augsburg',      'lat': 48.3717, 'lon': 10.8983},
    {'name': 'Würzburg',      'lat': 49.7913, 'lon': 9.9534},
    {'name': 'Berchtesgaden', 'lat': 47.6317, 'lon': 13.0017},
]

# stationStartYear verified 2026-11-09 directly against
# https://dataset.api.hub.geosphere.at/v1/station/historical/klima-v2-1d/metadata
AUSTRIA_TOWNS = [
    {'name': 'Linz',     'lat': 48.3069, 'lon': 14.2858, 'stationId': '56',   'stationStartYear': 1895},
    {'name': 'Salzburg', 'lat': 47.8095, 'lon': 13.0550, 'stationId': '145',  'stationStartYear': 1987},
    {'name': 'Wels',     'lat': 48.1567, 'lon': 14.0289, 'stationId': '4905', 'stationStartYear': 1983},
    {'name': 'Braunau',  'lat': 48.2561, 'lon': 13.0344, 'stationId': '75',   'stationStartYear': 1961},
]

# ---------------------------------------------------------------------------
# Bavaria: HYRAS tas (annual mean) + DWD hot_days, nearest grid cell
# ---------------------------------------------------------------------------
to_3035 = Transformer.from_crs('EPSG:4326', 'EPSG:3035', always_xy=True)
to_31467 = Transformer.from_crs('EPSG:4326', 'EPSG:31467', always_xy=True)

bavaria_points_3035 = {t['name']: to_3035.transform(t['lon'], t['lat']) for t in BAVARIAN_TOWNS}
bavaria_points_31467 = {t['name']: to_31467.transform(t['lon'], t['lat']) for t in BAVARIAN_TOWNS}

print('Bavaria town points (EPSG:3035):', bavaria_points_3035)

tas_by_town = {t['name']: {} for t in BAVARIAN_TOWNS}
for year in range(START_YEAR, END_YEAR + 1):
    f = TAS_DIR / f'tas_hyras_1_{year}_v6-1_de_monmean.nc'
    ds = xr.open_dataset(f).sortby('y', ascending=False)
    annual_mean = ds['tas'].mean(dim='time', skipna=True)
    for name, (x, y) in bavaria_points_3035.items():
        val = annual_mean.sel(x=x, y=y, method='nearest').item()
        tas_by_town[name][year] = None if np.isnan(val) else float(val)
    ds.close()
print('Bavaria TAS done.')

hotdays_by_town = {t['name']: {} for t in BAVARIAN_TOWNS}
for year in range(START_YEAR, END_YEAR + 1):
    f = HOTDAYS_DIR / f'grids_germany_annual_hot_days_{year}_17.asc'
    with rasterio.open(f) as src:
        arr = src.read(1).astype(float)
        arr[arr == src.nodata] = np.nan
        for name, (x, y) in bavaria_points_31467.items():
            row, col = src.index(x, y)
            val = arr[row, col]
            hotdays_by_town[name][year] = None if np.isnan(val) else float(val)
print('Bavaria hot days done.')

# ---------------------------------------------------------------------------
# Austria: SPARTACUS TM (annual mean), nearest grid cell, from each town's
# own real station start year (not before) -- no artificial backfill.
# ---------------------------------------------------------------------------
to_3416 = Transformer.from_crs('EPSG:4326', 'EPSG:3416', always_xy=True)
austria_points_3416 = {t['name']: to_3416.transform(t['lon'], t['lat']) for t in AUSTRIA_TOWNS}
print('Austria town points (EPSG:3416):', austria_points_3416)

spartacus_datasets = []
for f in SPARTACUS_TM_FILES:
    ds = xr.open_dataset(f).sortby('y', ascending=False)
    spartacus_datasets.append(ds)
tm_combined = xr.concat(spartacus_datasets, dim='time').sortby('time')
_, unique_idx = np.unique(tm_combined['time'].values, return_index=True)
tm_combined = tm_combined.isel(time=sorted(unique_idx))
print(f'SPARTACUS TM: {tm_combined.sizes["time"]} months, {str(tm_combined.time.values[0])[:7]} to {str(tm_combined.time.values[-1])[:7]}')

austria_tas_by_town = {t['name']: {} for t in AUSTRIA_TOWNS}
for town in AUSTRIA_TOWNS:
    name = town['name']
    x, y = austria_points_3416[name]
    real_start = max(town['stationStartYear'], 1961)  # SPARTACUS itself starts 1961 regardless of station age
    for year in range(real_start, END_YEAR + 1):
        da_year = tm_combined['TM'].sel(time=tm_combined['time'].dt.year == year)
        if da_year.sizes['time'] == 0:
            continue
        annual_mean = da_year.mean(dim='time', skipna=True)
        val = annual_mean.sel(x=x, y=y, method='nearest').item()
        austria_tas_by_town[name][year] = None if np.isnan(val) else float(val)
print('Austria SPARTACUS TM done.')

# ---------------------------------------------------------------------------
# Austria hot days: GeoSphere station daily tlmax, real history, counting
# days >= 30C per year. Offline script -- no CORS concern, unlike the app's
# own browser fetches to the same endpoint.
# ---------------------------------------------------------------------------
GEOSPHERE_DAILY_URL = 'https://dataset.api.hub.geosphere.at/v1/station/historical/klima-v2-1d'

def fetch_station_tlmax_hotdays(station_id: str, start_year: int, end_year: int) -> dict:
    hot_days = {}
    # Fetch in <=20-year chunks to stay well under any response-size limits
    chunk = 20
    for chunk_start in range(start_year, end_year + 1, chunk):
        chunk_end = min(chunk_start + chunk - 1, end_year)
        params = {
            'station_ids': station_id,
            'parameters': 'tlmax',
            'start': f'{chunk_start}-01-01',
            'end': f'{chunk_end}-12-31',
            'output_format': 'geojson',
        }
        resp = requests.get(GEOSPHERE_DAILY_URL, params=params, timeout=60)
        resp.raise_for_status()
        data = resp.json()
        feature = (data.get('features') or [None])[0]
        if feature is None:
            continue
        tlmax = feature['properties']['parameters'].get('tlmax', {}).get('data', [])
        timestamps = data.get('timestamps', [])
        for ts, val in zip(timestamps, tlmax):
            if val is None:
                continue
            year = int(ts[:4])
            if val >= 30.0:
                hot_days[year] = hot_days.get(year, 0) + 1
            else:
                hot_days.setdefault(year, hot_days.get(year, 0))  # ensure year key exists even with 0 hot days so far
        time.sleep(0.3)  # polite pacing between chunk requests
    return hot_days

austria_hotdays_by_town = {}
for town in AUSTRIA_TOWNS:
    name = town['name']
    # Clamp to START_YEAR (1951) even for Linz (real station start 1895) --
    # there's no comparison benefit to fetching 56 extra years nobody else
    # in this dataset has, and it would be a needlessly large live request.
    fetch_start = max(town['stationStartYear'], START_YEAR)
    print(f'Fetching GeoSphere daily tlmax for {name} (station {town["stationId"]}, {fetch_start}-2024)...')
    austria_hotdays_by_town[name] = fetch_station_tlmax_hotdays(town['stationId'], fetch_start, END_YEAR)
print('Austria hot days done.')

# ---------------------------------------------------------------------------
# Assemble output: per-town yearly series, decade averages, and a single
# "warming" total-change figure (OLS linear-trend total over the real
# available span, not a raw first-year-vs-last-year difference).
# ---------------------------------------------------------------------------
def linear_trend_total(yearly: dict) -> float | None:
    years = sorted(y for y, v in yearly.items() if v is not None)
    if len(years) < 10:
        return None
    vals = [yearly[y] for y in years]
    slope, intercept = np.polyfit(years, vals, 1)
    return float(slope * (years[-1] - years[0]))

def decade_avg(yearly: dict, start: int, end: int) -> float | None:
    vals = [yearly[y] for y in range(start, end + 1) if yearly.get(y) is not None]
    return round(float(np.mean(vals)), 2) if vals else None

output = {}

for town in BAVARIAN_TOWNS:
    name = town['name']
    tas = tas_by_town[name]
    hd = hotdays_by_town[name]
    decades = {}
    for d in range(1950, 2021, 10):
        decades[str(d)] = {
            'tasMean': decade_avg(tas, max(d, START_YEAR), min(d + 9, END_YEAR)),
            'hotDays': decade_avg(hd, max(d, START_YEAR), min(d + 9, END_YEAR)),
        }
    output[name] = {
        'country': 'DE',
        'provenance': 'gridded-observation point extraction (HYRAS-DE v6-1 tas; DWD grids_germany hot_days), nearest 1km cell to town coordinates',
        'yearly': {
            str(y): {'tasMean': round(tas[y], 2) if tas.get(y) is not None else None,
                      'hotDays': round(hd[y], 1) if hd.get(y) is not None else None}
            for y in range(START_YEAR, END_YEAR + 1)
        },
        'decadeAvg': decades,
        'warmingTrendTotal': round(linear_trend_total(tas), 2) if linear_trend_total(tas) is not None else None,
        'warmingTrendPeriod': f'{START_YEAR}-{END_YEAR}',
        'hotDaysRecent': decade_avg(hd, 2015, 2024),
    }

for town in AUSTRIA_TOWNS:
    name = town['name']
    tas = austria_tas_by_town[name]
    hd = austria_hotdays_by_town[name]
    real_start = max(town['stationStartYear'], 1961)
    decades = {}
    for d in range(1950, 2021, 10):
        decades[str(d)] = {
            'tasMean': decade_avg(tas, max(d, real_start), min(d + 9, END_YEAR)),
            'hotDays': decade_avg(hd, max(d, town['stationStartYear']), min(d + 9, END_YEAR)),
        }
    output[name] = {
        'country': 'AT',
        'provenance': f'gridded-observation point extraction (GeoSphere SPARTACUS v2.1 TM, nearest 1km cell) from {real_start}; hot days from GeoSphere station {town["stationId"]} real daily tlmax from {max(town["stationStartYear"], START_YEAR)} (point station measurement, not gridded; station itself active since {town["stationStartYear"]})',
        'yearly': {
            str(y): {'tasMean': round(tas[y], 2) if tas.get(y) is not None else None, 'hotDays': None}
            for y in range(real_start, END_YEAR + 1)
        },
        'decadeAvg': decades,
        'warmingTrendTotal': round(linear_trend_total(tas), 2) if linear_trend_total(tas) is not None else None,
        'warmingTrendPeriod': f'{real_start}-{END_YEAR}',
        'hotDaysRecent': decade_avg(hd, 2015, 2024),
    }
    # merge real hot-day years into the yearly series (separate dict, station-sourced)
    for y, v in hd.items():
        if str(y) in output[name]['yearly']:
            output[name]['yearly'][str(y)]['hotDays'] = v

OUT_FILE.parent.mkdir(parents=True, exist_ok=True)
with open(OUT_FILE, 'w') as f:
    json.dump(output, f, ensure_ascii=False, indent=None)
print(f'Saved {OUT_FILE} ({OUT_FILE.stat().st_size / 1024:.0f} KB)')
for name, rec in output.items():
    print(name, 'warming:', rec['warmingTrendTotal'], f"({rec['warmingTrendPeriod']})", 'hotDaysRecent:', rec['hotDaysRecent'])
