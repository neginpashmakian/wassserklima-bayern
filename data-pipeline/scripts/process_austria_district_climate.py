"""
Phase 3 (Upper Austria extension): per-district temperature, precipitation,
and SPI drought index for the 18 Upper Austria Bezirke, computed from real
GeoSphere Austria SPARTACUS v2.1 monthly 1km grids.

Inputs (already downloaded to data/raw/geosphere-spartacus/):
  - tm/spartacus_TM_<start>_<end>.nc   (1961-2024, monthly mean temp, EPSG:3416)
  - rr/spartacus_RR_<start>_<end>.nc   (1961-2024, monthly precip sum, EPSG:3416)
  - data-pipeline/austria_districts_3416.geojson (18 Upper Austria Bezirke, reprojected)

SPARTACUS only starts 1961 -- unlike HYRAS/Bavaria, there is NO 1951-1960
coverage for Austria. Those years are intentionally left absent (not filled,
not zeroed) in the output, per the explicit instruction to mark them missing.

No DWD-style hot_days product exists for Austria in this pipeline; hotDays
stays null for all years/districts here (town-level Austria hot-days, if
ever added, would come from GeoSphere station data in Phase 4, not this file).

Output: public/data/austria-districts-climate.json, keyed by Bezirk iso/GKZ
code (401-418) -- the same key austriaSeed() already produces in
BavariaHeatmap.tsx.
"""
import glob
import json
from pathlib import Path

import numpy as np
import xarray as xr
import rioxarray  # noqa: F401
import geopandas as gpd
from rasterstats import zonal_stats
from climate_indices import indices, compute

ROOT = Path(__file__).resolve().parents[2]
TM_FILES = sorted(glob.glob(str(ROOT / 'data/raw/geosphere-spartacus/tm/*.nc')))
RR_FILES = sorted(glob.glob(str(ROOT / 'data/raw/geosphere-spartacus/rr/*.nc')))
OUT_FILE = ROOT / 'public/data/austria-districts-climate.json'

DATA_START_YEAR = 1961  # SPARTACUS coverage start -- no data before this, left absent
START_YEAR, END_YEAR = 1961, 2024
BASELINE_START, BASELINE_END = 1961, 1990

DROUGHT_CLASSES = [
    (-2.0, 'D4'), (-1.6, 'D3'), (-1.3, 'D2'), (-0.8, 'D1'), (-0.5, 'D0'),
]

def spi_to_class(spi):
    if spi is None or np.isnan(spi):
        return None
    for threshold, label in DROUGHT_CLASSES:
        if spi <= threshold:
            return label
    return None

districts = gpd.read_file(ROOT / 'data-pipeline/austria_districts_3416.geojson')
ISO_LIST = districts['iso'].tolist()
NAME_BY_ISO = dict(zip(districts['iso'], districts['name']))

print(f'Processing {len(ISO_LIST)} Upper Austria districts, {START_YEAR}-{END_YEAR}...')

# ---------------------------------------------------------------------------
# Load and concatenate all TM / RR chunk files into one monthly time series
# ---------------------------------------------------------------------------
def load_concat(files, varname):
    datasets = []
    for f in files:
        ds = xr.open_dataset(f).sortby('y', ascending=False)
        ds = ds.rio.write_crs('EPSG:3416').rio.set_spatial_dims(x_dim='x', y_dim='y')
        datasets.append(ds)
    combined = xr.concat(datasets, dim='time').sortby('time')
    # SPARTACUS chunk requests overlap at year boundaries (3-year windows
    # starting every 3 years do NOT overlap, but guard anyway in case of
    # a re-run with different chunk boundaries).
    _, unique_idx = np.unique(combined['time'].values, return_index=True)
    combined = combined.isel(time=sorted(unique_idx))
    return combined

tm_ds = load_concat(TM_FILES, 'TM')
rr_ds = load_concat(RR_FILES, 'RR')
print(f'TM: {tm_ds.sizes["time"]} months, {str(tm_ds.time.values[0])[:7]} to {str(tm_ds.time.values[-1])[:7]}')
print(f'RR: {rr_ds.sizes["time"]} months, {str(rr_ds.time.values[0])[:7]} to {str(rr_ds.time.values[-1])[:7]}')

# ---------------------------------------------------------------------------
# 1. TM -- annual mean per district, per year
# ---------------------------------------------------------------------------
tas_annual = {iso: {} for iso in ISO_LIST}
for year in range(START_YEAR, END_YEAR + 1):
    da_year = tm_ds['TM'].sel(time=tm_ds['time'].dt.year == year)
    if da_year.sizes['time'] == 0:
        continue
    annual_mean = da_year.mean(dim='time', skipna=True)
    # recalc=True: after concat-ing per-chunk files and re-sorting by time,
    # rioxarray's cached transform (set once per chunk, before the concat)
    # goes stale and silently reverts to a positive-dy (south-up) affine --
    # verified directly against the raw y-coordinate order, same failure
    # mode as the earlier HYRAS y-axis bug but one layer deeper this time.
    transform = annual_mean.rio.transform(recalc=True)
    stats = zonal_stats(districts.geometry, annual_mean.values, affine=transform, stats=['mean'], nodata=np.nan)
    for iso, s in zip(ISO_LIST, stats):
        tas_annual[iso][year] = s['mean']
print('TM done.')

# ---------------------------------------------------------------------------
# 2. RR -- monthly sum per district (for SPI), plus annual sum for display
# ---------------------------------------------------------------------------
n_months = rr_ds.sizes['time']
pr_monthly = {iso: [] for iso in ISO_LIST}
for t in range(n_months):
    da = rr_ds['RR'].isel(time=t)
    transform = da.rio.transform(recalc=True)
    stats = zonal_stats(districts.geometry, da.values, affine=transform, stats=['mean'], nodata=np.nan)
    for iso, s in zip(ISO_LIST, stats):
        pr_monthly[iso].append(s['mean'] if s['mean'] is not None else np.nan)
print('RR monthly done.')

pr_annual = {iso: {} for iso in ISO_LIST}
for iso in ISO_LIST:
    series = pr_monthly[iso]
    for year in range(START_YEAR, END_YEAR + 1):
        start_idx = (year - DATA_START_YEAR) * 12
        months = series[start_idx:start_idx + 12]
        pr_annual[iso][year] = float(np.nansum(months)) if len(months) == 12 else None

# ---------------------------------------------------------------------------
# 3. SPI-12 (Dec) and SPI-3 (Aug/JJA), gamma distribution, 1961-1990 calib
# ---------------------------------------------------------------------------
spi12_annual = {iso: {} for iso in ISO_LIST}
spi3_summer = {iso: {} for iso in ISO_LIST}
for iso in ISO_LIST:
    values = np.array(pr_monthly[iso], dtype=float)
    try:
        spi12 = indices.spi(
            values, scale=12, distribution=compute.Distribution.gamma,
            data_start_year=DATA_START_YEAR,
            calibration_year_initial=BASELINE_START, calibration_year_final=BASELINE_END,
            periodicity=compute.Periodicity.monthly,
        )
        spi3 = indices.spi(
            values, scale=3, distribution=compute.Distribution.gamma,
            data_start_year=DATA_START_YEAR,
            calibration_year_initial=BASELINE_START, calibration_year_final=BASELINE_END,
            periodicity=compute.Periodicity.monthly,
        )
    except Exception as e:
        print(f'  SPI failed for {iso}: {e}')
        continue
    for year in range(START_YEAR, END_YEAR + 1):
        dec_idx = (year - DATA_START_YEAR) * 12 + 11
        aug_idx = (year - DATA_START_YEAR) * 12 + 7
        spi12_annual[iso][year] = float(spi12[dec_idx]) if 0 <= dec_idx < len(spi12) else None
        spi3_summer[iso][year] = float(spi3[aug_idx]) if 0 <= aug_idx < len(spi3) else None
print('SPI done.')

# ---------------------------------------------------------------------------
# 4. Baseline + assemble, with 1951-1960 left absent (no key in `yearly`)
# ---------------------------------------------------------------------------
baseline_mean = {}
for iso in ISO_LIST:
    vals = [tas_annual[iso][y] for y in range(BASELINE_START, BASELINE_END + 1) if tas_annual[iso].get(y) is not None]
    baseline_mean[iso] = float(np.mean(vals)) if vals else None

output = {}
for iso in ISO_LIST:
    yearly = {}
    for year in range(START_YEAR, END_YEAR + 1):
        tas = tas_annual[iso].get(year)
        anomaly = (tas - baseline_mean[iso]) if (tas is not None and baseline_mean[iso] is not None) else None
        spi12 = spi12_annual[iso].get(year)
        yearly[str(year)] = {
            'tasMean': round(tas, 2) if tas is not None else None,
            'tasAnomaly': round(anomaly, 2) if anomaly is not None else None,
            'prSum': round(pr_annual[iso][year], 1) if pr_annual[iso].get(year) is not None else None,
            'spi12': round(spi12, 2) if spi12 is not None else None,
            'spi3Summer': round(spi3_summer[iso].get(year), 2) if spi3_summer[iso].get(year) is not None else None,
            'droughtClass': spi_to_class(spi12),
            'hotDays': None,  # no Austria hot-days product in this pipeline
        }
    decades = {}
    for d in range(1960, 2021, 10):
        years_in_decade = [y for y in range(max(d, START_YEAR), min(d + 10, END_YEAR + 1))]
        if not years_in_decade:
            continue
        def avg_field(field):
            vals = [yearly[str(y)][field] for y in years_in_decade if yearly[str(y)][field] is not None]
            return round(float(np.mean(vals)), 2) if vals else None
        decades[str(d)] = {
            'tasMean': avg_field('tasMean'),
            'tasAnomaly': avg_field('tasAnomaly'),
            'prSum': avg_field('prSum'),
            'spi12': avg_field('spi12'),
            'hotDays': None,
        }

    output[iso] = {
        'name': NAME_BY_ISO[iso],
        'provenance': 'gridded-observation (GeoSphere Austria SPARTACUS v2.1 TM/RR) with derived anomaly/SPI/droughtClass; no data before 1961',
        'baselineTasMean1961_1990': round(baseline_mean[iso], 2) if baseline_mean[iso] is not None else None,
        'yearly': yearly,
        'decadeAvg': decades,
    }

OUT_FILE.parent.mkdir(parents=True, exist_ok=True)
with open(OUT_FILE, 'w') as f:
    json.dump(output, f, ensure_ascii=False)
print(f'Saved {OUT_FILE} ({OUT_FILE.stat().st_size / 1024:.0f} KB)')
