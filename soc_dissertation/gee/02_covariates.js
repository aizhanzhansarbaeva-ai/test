// =====================================================================
// 02_covariates.js — стек ковариат (SCORPAN) и экспорт для cLHS / моделирования
// Требует ассет AOI из 01_aoi.js.
// =====================================================================
var aoi = ee.FeatureCollection('users/YOUR_NAME/aoi_transili').geometry();
var SCALE = 30;
Map.centerObject(aoi, 9);

// ---------- Рельеф ----------
var dem = ee.ImageCollection('COPERNICUS/DEM/GLO30').select('DEM')
            .filterBounds(aoi).mosaic().setDefaultProjection('EPSG:4326', null, 30)
            .rename('elev');
var terr = ee.Terrain.products(dem);
var slope = terr.select('slope');
var northness = terr.select('aspect').multiply(Math.PI / 180).cos().rename('northness');
var eastness  = terr.select('aspect').multiply(Math.PI / 180).sin().rename('eastness');
var merit = ee.Image('MERIT/Hydro/v1_0_1');
var tanSlope = slope.multiply(Math.PI / 180).tan().max(0.001);
var twi  = merit.select('upa').multiply(1e6).divide(90).divide(tanSlope).log().rename('TWI');
var hand = merit.select('hnd').rename('HAND');
// Относительное положение на склоне (TPI, окно ~300 м)
var tpi = dem.subtract(dem.focal_mean({radius: 300, units: 'meters'})).rename('TPI');

// ---------- Sentinel-2 ----------
function maskS2(img) {
  var scl = img.select('SCL');
  var ok = scl.neq(3).and(scl.neq(8)).and(scl.neq(9)).and(scl.neq(10)).and(scl.neq(11));
  return img.select(['B2', 'B3', 'B4', 'B5', 'B8', 'B11', 'B12']).updateMask(ok).divide(10000)
            .copyProperties(img, ['system:time_start']);
}
var s2col = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED').filterBounds(aoi)
  .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 30)).map(maskS2);

var s2 = s2col.filterDate('2021-01-01', '2025-12-31')
  .filter(ee.Filter.calendarRange(5, 9, 'month')).median();
var ndvi = s2.normalizedDifference(['B8', 'B4']).rename('NDVI');
var ndmi = s2.normalizedDifference(['B8', 'B11']).rename('NDMI');
var savi = s2.expression('1.5*(N-R)/(N+R+0.5)', {N: s2.select('B8'), R: s2.select('B4')}).rename('SAVI');

// Сезонная амплитуда NDVI (продуктивность)
var ndviCol = s2col.filterDate('2021-01-01', '2025-12-31')
  .map(function (i) { return i.normalizedDifference(['B8', 'B4']).rename('nd'); });
var ndviP90 = ndviCol.reduce(ee.Reducer.percentile([90])).rename('NDVI_p90');
var ndviP10 = ndviCol.reduce(ee.Reducer.percentile([10])).rename('NDVI_p10');

// Композит открытой почвы
var bare = s2col.filterDate('2018-01-01', '2025-12-31').map(function (img) {
  var nd = img.normalizedDifference(['B8', 'B4']);
  var nbr2 = img.normalizedDifference(['B11', 'B12']);
  return img.updateMask(nd.lt(0.25).and(nbr2.lt(0.075)));
}).median().select(['B2', 'B3', 'B4', 'B8', 'B11', 'B12'],
                   ['bare_B', 'bare_G', 'bare_R', 'bare_N', 'bare_S1', 'bare_S2']);

// ---------- Климат (TerraClimate, 1991–2020) ----------
var tc = ee.ImageCollection('IDAHO_EPSCOR/TERRACLIMATE').filterDate('1991-01-01', '2020-12-31');
var MAP  = tc.select('pr').sum().divide(30).rename('MAP');
var TMAX = tc.select('tmmx').mean().multiply(0.1).rename('Tmax');
var TMIN = tc.select('tmmn').mean().multiply(0.1).rename('Tmin');
var CWD  = tc.select('def').sum().divide(30).multiply(0.1).rename('CWD');

// ---------- Землепользование ----------
var lc = ee.ImageCollection('ESA/WorldCover/v200').first().select('Map').rename('LC');

var cov = ee.Image.cat([
  dem, slope, northness, eastness, twi, hand, tpi,
  ndvi, ndmi, savi, ndviP90, ndviP10, bare,
  MAP, TMAX, TMIN, CWD, lc
]).clip(aoi).float();
print('Ковариаты:', cov.bandNames());

Map.addLayer(cov.select('NDVI'), {min: 0, max: 0.8, palette: ['#d8c39a', '#2e7d32']}, 'NDVI');
Map.addLayer(cov.select(['bare_S1', 'bare_N', 'bare_R']), {min: 0.05, max: 0.35}, 'Открытая почва', false);

// ---------- Экспорт ----------
// 0) Стек ковариат в Asset: модель (03_model.js) читает готовый ассет,
//    иначе интерактивный расчёт упирается в "User memory limit exceeded".
Export.image.toAsset({image: cov, description: 'covariates_30m_asset',
  assetId: 'projects/YOUR_PROJECT/assets/covariates_30m',
  region: aoi, scale: SCALE, crs: 'EPSG:32643', maxPixels: 1e13,
  pyramidingPolicy: {'.default': 'mean', 'LC': 'mode'}});

// 1) Стек ковариат (GeoTIFF, UTM 43N) — для моделирования в R/Python
Export.image.toDrive({image: cov, description: 'covariates_30m', folder: 'SOC_GEE',
  region: aoi, scale: SCALE, crs: 'EPSG:32643', maxPixels: 1e13});

// 2) Сетка кандидатов для cLHS (~20 000 точек), только доступные классы
//    (пашня 40, луг/пастбище 30, кустарник 20). Добавьте фильтр по дорогам при необходимости.
var candidates = cov.updateMask(lc.eq(40).or(lc.eq(30)).or(lc.eq(20)))
  .sample({region: aoi, scale: 100, numPixels: 20000, seed: 1, geometries: true})
  .map(function (f) {
    var c = f.geometry().coordinates();
    return f.set({lon: c.get(0), lat: c.get(1)});
  });
Export.table.toDrive({collection: candidates, description: 'clhs_candidates',
  folder: 'SOC_GEE', fileFormat: 'CSV'});

// 3) После полевых работ: ковариаты в точках отбора (gee_upload.csv → ассет)
// var pts = ee.FeatureCollection('users/YOUR_NAME/soc_points');
// var tab = cov.sampleRegions({collection: pts, properties: ['point_id','SOC','split'],
//                              scale: SCALE, geometries: true});
// Export.table.toDrive({collection: tab, description: 'soc_points_covariates', fileFormat: 'CSV'});
