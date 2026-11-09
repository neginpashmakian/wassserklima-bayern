"""
Phase 3: per-district temperature, precipitation, SPI drought index, and hot
days — computed from real HYRAS-DE v6-1 gridded data and DWD's hot_days
grids, replacing BavariaHeatmap.tsx's getDistrictDrought/getClimateAnomaly/
getDecadeAvg formulas.

Inputs (already downloaded to data/raw/):
  - data/raw/hyras/tas/tas_hyras_1_<year>_v6-1_de_monmean.nc   (1951-2024, monthly mean temp, EPSG:3035)
  - data/raw/hyras/pr/pr_hyras_1_1931_2024_v6-1_de_monsum.nc   (1931-2024, monthly precip sum, EPSG:3035)
  - data/raw/dwd-hot-days/grids_germany_annual_hot_days_<year>_17.asc (1951-2024, EPSG:31467)
  - data-pipeline/districts_3035.geojson / districts_31467.geojson (VG250 Bavaria, reprojected)

Zonal statistic method: rasterstats default (pixel-CENTER-in-polygon mean),
not exact fractional-pixel-area weighting — documented here and in
sources.json rather than overclaiming precision. At 1km resolution against
district polygons spanning tens of km, this is a standard, widely-used
approximation; the difference from true area-weighting is small except for
unusually narrow districts.

Output: public/data/districts-climate.json
"""
import json
from pathlib import Path

import numpy as np
import xarray as xr
import rioxarray  # noqa: F401 -- registers the .rio accessor on xarray objects
import geopandas as gpd
import rasterio
from rasterstats import zonal_stats
from climate_indices import indices, compute

ROOT = Path(__file__).resolve().parents[2]
TAS_DIR = ROOT / 'data/raw/hyras/tas'
PR_FILE = ROOT / 'data/raw/hyras/pr/pr_hyras_1_1931_2024_v6-1_de_monsum.nc'
HOTDAYS_DIR = ROOT / 'data/raw/dwd-hot-days'
OUT_FILE = ROOT / 'public/data/districts-climate.json'

START_YEAR, END_YEAR = 1951, 2024
BASELINE_START, BASELINE_END = 1961, 1990
SPI_START_YEAR = 1930  # pr series actually starts 1930-01, NOT 1931 as the filename
                        # (pr_hyras_1_1931_2024_...) implies -- verified directly from
                        # the file's own time coordinate before trusting the filename.
                        # SPI itself is still calibrated on 1961-1990 regardless.

DROUGHT_CLASSES = [
    (-2.0, 'D4'), (-1.6, 'D3'), (-1.3, 'D2'), (-0.8, 'D1'), (-0.5, 'D0'),
]
D1_THRESHOLD = -0.8  # moderate drought or worse — used for decadeAvg.spiD1Share below

def spi_to_class(spi):
    if spi is None or np.isnan(spi):
        return None
    for threshold, label in DROUGHT_CLASSES:
        if spi <= threshold:
            return label
    return None  # not in drought

districts = gpd.read_file(ROOT / 'data-pipeline/districts_3035.geojson')
districts_31467 = gpd.read_file(ROOT / 'data-pipeline/districts_31467.geojson')
AGS_LIST = districts['AGS'].tolist()
NAME_BY_AGS = dict(zip(districts['AGS'], districts['GEN']))
BEZ_BY_AGS = dict(zip(districts['AGS'], districts['BEZ']))

print(f'Processing {len(AGS_LIST)} districts, {START_YEAR}-{END_YEAR}...')

# ---------------------------------------------------------------------------
# 1. TAS — annual mean per district, per year
# ---------------------------------------------------------------------------
tas_annual = {ags: {} for ags in AGS_LIST}
for year in range(START_YEAR, END_YEAR + 1):
    f = TAS_DIR / f'tas_hyras_1_{year}_v6-1_de_monmean.nc'
    ds = xr.open_dataset(f).sortby('y', ascending=False)
    ds = ds.rio.write_crs('EPSG:3035').rio.set_spatial_dims(x_dim='x', y_dim='y')
    annual_mean = ds['tas'].mean(dim='time', skipna=True)
    transform = annual_mean.rio.transform()
    stats = zonal_stats(districts.geometry, annual_mean.values, affine=transform, stats=['mean'], nodata=np.nan)
    for ags, s in zip(AGS_LIST, stats):
        tas_annual[ags][year] = s['mean']
    ds.close()
print('TAS done.')

# ---------------------------------------------------------------------------
# 2. PR — monthly sum per district, full 1931-2024 series (needed for SPI),
#    plus annual sum 1951-2024 for the app's yearly precip figure.
# ---------------------------------------------------------------------------
ds_pr = xr.open_dataset(PR_FILE).sortby('y', ascending=False)
ds_pr = ds_pr.rio.write_crs('EPSG:3035').rio.set_spatial_dims(x_dim='x', y_dim='y')
n_months = ds_pr.sizes['time']
print(f'PR file has {n_months} months starting {str(ds_pr.time.values[0])[:7]}')

pr_monthly = {ags: [] for ags in AGS_LIST}  # one list per district, chronological, 1931-01 onward
for t in range(n_months):
    da = ds_pr['pr'].isel(time=t)
    transform = da.rio.transform()
    stats = zonal_stats(districts.geometry, da.values, affine=transform, stats=['mean'], nodata=np.nan)
    for ags, s in zip(AGS_LIST, stats):
        pr_monthly[ags].append(s['mean'] if s['mean'] is not None else np.nan)
    if t % 120 == 0:
        print(f'  PR month {t}/{n_months}')
ds_pr.close()
print('PR monthly done.')

# annual PR sum per district (for 1951-2024 display)
pr_annual = {ags: {} for ags in AGS_LIST}
for ags in AGS_LIST:
    series = pr_monthly[ags]
    for year in range(START_YEAR, END_YEAR + 1):
        start_idx = (year - SPI_START_YEAR) * 12
        months = series[start_idx:start_idx + 12]
        pr_annual[ags][year] = float(np.nansum(months)) if len(months) == 12 else None

# ---------------------------------------------------------------------------
# 3. SPI-12 (Dec value = calendar-year cumulative) and SPI-3 (Aug value =
#    JJA summer cumulative), gamma distribution, calibrated 1961-1990.
# ---------------------------------------------------------------------------
spi12_annual = {ags: {} for ags in AGS_LIST}
spi3_summer = {ags: {} for ags in AGS_LIST}
for ags in AGS_LIST:
    values = np.array(pr_monthly[ags], dtype=float)
    try:
        spi12 = indices.spi(
            values, scale=12, distribution=compute.Distribution.gamma,
            data_start_year=SPI_START_YEAR,
            calibration_year_initial=BASELINE_START, calibration_year_final=BASELINE_END,
            periodicity=compute.Periodicity.monthly,
        )
        spi3 = indices.spi(
            values, scale=3, distribution=compute.Distribution.gamma,
            data_start_year=SPI_START_YEAR,
            calibration_year_initial=BASELINE_START, calibration_year_final=BASELINE_END,
            periodicity=compute.Periodicity.monthly,
        )
    except Exception as e:
        print(f'  SPI failed for {ags}: {e}')
        continue
    for year in range(START_YEAR, END_YEAR + 1):
        dec_idx = (year - SPI_START_YEAR) * 12 + 11  # December
        aug_idx = (year - SPI_START_YEAR) * 12 + 7   # August (end of JJA)
        spi12_annual[ags][year] = float(spi12[dec_idx]) if 0 <= dec_idx < len(spi12) else None
        spi3_summer[ags][year] = float(spi3[aug_idx]) if 0 <= aug_idx < len(spi3) else None
print('SPI done.')

# ---------------------------------------------------------------------------
# 4. Hot days — area-weighted mean per district, per year (EPSG:31467)
# ---------------------------------------------------------------------------
hotdays_annual = {ags: {} for ags in AGS_LIST}
for year in range(START_YEAR, END_YEAR + 1):
    f = HOTDAYS_DIR / f'grids_germany_annual_hot_days_{year}_17.asc'
    with rasterio.open(f) as src:
        arr = src.read(1).astype(float)
        arr[arr == src.nodata] = np.nan
        stats = zonal_stats(districts_31467.geometry, arr, affine=src.transform, stats=['mean'], nodata=np.nan)
    for ags, s in zip(AGS_LIST, stats):
        hotdays_annual[ags][year] = s['mean']
print('Hot days done.')

# ---------------------------------------------------------------------------
# 5. Temperature anomaly vs 1961-1990 baseline, per district
# ---------------------------------------------------------------------------
baseline_mean = {}
for ags in AGS_LIST:
    vals = [tas_annual[ags][y] for y in range(BASELINE_START, BASELINE_END + 1) if tas_annual[ags].get(y) is not None]
    baseline_mean[ags] = float(np.mean(vals)) if vals else None

# ---------------------------------------------------------------------------
# 6. Assemble output JSON, with decade summaries
# ---------------------------------------------------------------------------
def decade_of(year):
    return (year // 10) * 10

output = {}
for ags in AGS_LIST:
    yearly = {}
    for year in range(START_YEAR, END_YEAR + 1):
        tas = tas_annual[ags].get(year)
        anomaly = (tas - baseline_mean[ags]) if (tas is not None and baseline_mean[ags] is not None) else None
        spi12 = spi12_annual[ags].get(year)
        yearly[str(year)] = {
            'tasMean': round(tas, 2) if tas is not None else None,
            'tasAnomaly': round(anomaly, 2) if anomaly is not None else None,
            'prSum': round(pr_annual[ags][year], 1) if pr_annual[ags].get(year) is not None else None,
            'spi12': round(spi12, 2) if spi12 is not None else None,
            'spi3Summer': round(spi3_summer[ags].get(year), 2) if spi3_summer[ags].get(year) is not None else None,
            'droughtClass': spi_to_class(spi12),
            'hotDays': round(hotdays_annual[ags][year], 1) if hotdays_annual[ags].get(year) is not None else None,
        }

    decades = {}
    for d in range(1950, 2021, 10):
        years_in_decade = [y for y in range(max(d, START_YEAR), min(d + 10, END_YEAR + 1))]
        if not years_in_decade:
            continue
        def avg_field(field):
            vals = [yearly[str(y)][field] for y in years_in_decade if yearly[str(y)][field] is not None]
            return round(float(np.mean(vals)), 2) if vals else None
        # Share of years in this decade with SPI-12 <= D1_THRESHOLD (moderate
        # drought or worse), over years with real data only -- a missing year
        # is excluded from the denominator, not counted as "not dry". NOT
        # wired into the UI yet (computed for discussion only, per request):
        # a candidate alternative to decadeAvg.spi12 for the split map, since
        # a straight decade-averaged SPI washes out single dry years badly
        # (e.g. 2015/2018 averaged against several wetter years in the same
        # decade) -- this is a direct per-year frequency instead.
        spi_vals_in_decade = [yearly[str(y)]['spi12'] for y in years_in_decade if yearly[str(y)]['spi12'] is not None]
        spi_d1_share = (
            round(sum(1 for v in spi_vals_in_decade if v <= D1_THRESHOLD) / len(spi_vals_in_decade), 3)
            if spi_vals_in_decade else None
        )
        decades[str(d)] = {
            'tasMean': avg_field('tasMean'),
            'tasAnomaly': avg_field('tasAnomaly'),
            'prSum': avg_field('prSum'),
            'spi12': avg_field('spi12'),
            'hotDays': avg_field('hotDays'),
            'spiD1Share': spi_d1_share,
        }

    output[ags] = {
        'name': NAME_BY_AGS[ags],
        'bez': BEZ_BY_AGS[ags],
        'provenance': 'gridded-observation (HYRAS-DE v6-1 tas/pr; DWD grids_germany hot_days) with derived anomaly/SPI/droughtClass',
        'baselineTasMean1961_1990': round(baseline_mean[ags], 2) if baseline_mean[ags] is not None else None,
        'yearly': yearly,
        'decadeAvg': decades,
    }

OUT_FILE.parent.mkdir(parents=True, exist_ok=True)
with open(OUT_FILE, 'w') as f:
    json.dump(output, f, ensure_ascii=False)

print(f'Saved {OUT_FILE} ({OUT_FILE.stat().st_size / 1024:.0f} KB)')
