// =====================================================================
// ГЕОПРОСТРАНСТВЕННОЕ МОДЕЛИРОВАНИЕ ЗАПАСОВ SOC (0–30 см)
// Предгорья Заилийского Алатау, Юго-Восточный Казахстан
// Google Earth Engine — итоговый скрипт
//
// РАБОТА В ДВА ШАГА (иначе "User memory limit exceeded"):
//   STEP = 1 → Run → вкладка Tasks → RUN (ковариаты сохраняются в Asset, 0.5–3 ч)
//   STEP = 2 → Run (когда задача в Tasks завершилась) → модель, оценка, карта
// =====================================================================

// -------------------- НАСТРОЙКИ --------------------
var STEP     = 1;        // 1 = расчёт ковариат; 2 = модель
var USE_DEMO = true;     // true = учебные точки SoilGrids (только для проверки кода!)
                         // false = ваши полевые точки

// Корень ваших ассетов: вкладка Assets слева (например 'projects/ee-myname/assets')
var ROOT       = 'projects/ВАШ_ПРОЕКТ/assets';
var COV_ASSET  = ROOT + '/covariates_30m';
var PTS_ASSET  = ROOT + '/soc_points';   // CSV: point_id, lon, lat, SOC (т/га), split (train/test)

var BOX = ee.Geometry.Rectangle([76.30, 43.05, 78.20, 43.50]);   // предгорья Заилийского Алатау
var ELEV_MIN = 650, ELEV_MAX = 1700;                              // высотный диапазон предгорий
var CRS = 'EPSG:32643';                                           // UTM 43N
var SCALE = 30;

var PAL = ['#ffffcc', '#c2e699', '#78c679', '#31a354', '#006837', '#3d2b1f'];
Map.centerObject(BOX, 9);

// =====================================================================
// ШАГ 1. КОВАРИАТЫ (SCORPAN) → ASSET
// =====================================================================
if (STEP === 1) {

  // ---------- Рельеф ----------
  var dem = ee.ImageCollection('COPERNICUS/DEM/GLO30').filterBounds(BOX).select('DEM')
              .mosaic().setDefaultProjection('EPSG:4326', null, 30).rename('elev');
  var terr = ee.Terrain.products(dem);
  var slope = terr.select('slope');
  var aspRad = terr.select('aspect').multiply(Math.PI / 180);
  var northness = aspRad.cos().rename('northness');
  var eastness  = aspRad.sin().rename('eastness');
  var tpi = dem.subtract(dem.focal_mean({radius: 300, units: 'meters'})).rename('TPI');

  var merit = ee.Image('MERIT/Hydro/v1_0_1');
  var twi = merit.select('upa').multiply(1e6).divide(90)
              .divide(slope.multiply(Math.PI / 180).tan().max(0.001)).log().rename('TWI');
  var hand = merit.select('hnd').rename('HAND');

  // ---------- Sentinel-2 ----------
  var S2_BANDS = ['B2', 'B3', 'B4', 'B5', 'B8', 'B11', 'B12'];
  var maskS2 = function (img) {
    var scl = img.select('SCL');
    var ok = scl.eq(4).or(scl.eq(5)).or(scl.eq(7));   // растительность, открытая поверхность
    return img.select(S2_BANDS).updateMask(ok).divide(10000);
  };
  var s2all = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED').filterBounds(BOX)
                .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 20));

  // Летний композит (июнь–август 2022–2024)
  var s2 = s2all.filterDate('2022-01-01', '2024-12-31')
                .filter(ee.Filter.calendarRange(6, 8, 'month')).map(maskS2).median();
  var ndvi = s2.normalizedDifference(['B8', 'B4']).rename('NDVI');
  var ndmi = s2.normalizedDifference(['B8', 'B11']).rename('NDMI');
  var savi = s2.expression('1.5*(N-R)/(N+R+0.5)',
               {N: s2.select('B8'), R: s2.select('B4')}).rename('SAVI');

  // Композит открытой почвы: весна (III–IV) и осень (IX–X) 2019–2024
  var bare = s2all.filterDate('2019-01-01', '2024-12-31')
    .filter(ee.Filter.or(ee.Filter.calendarRange(3, 4, 'month'),
                         ee.Filter.calendarRange(9, 10, 'month')))
    .map(maskS2)
    .map(function (img) {
      var nd = img.normalizedDifference(['B8', 'B4']);
      var nbr2 = img.normalizedDifference(['B11', 'B12']);
      return img.updateMask(nd.lt(0.25).and(nbr2.lt(0.075)));
    }).median()
    .select(['B2', 'B4', 'B8', 'B11', 'B12'], ['bare_B', 'bare_R', 'bare_N', 'bare_S1', 'bare_S2']);

  // ---------- Климат (TerraClimate, 1991–2020) ----------
  var tc = ee.ImageCollection('IDAHO_EPSCOR/TERRACLIMATE').filterDate('1991-01-01', '2020-12-31');
  var MAP  = tc.select('pr').sum().divide(30).rename('MAP');                  // мм/год
  var TMAX = tc.select('tmmx').mean().multiply(0.1).rename('Tmax');           // °C
  var TMIN = tc.select('tmmn').mean().multiply(0.1).rename('Tmin');           // °C
  var CWD  = tc.select('def').sum().divide(30).multiply(0.1).rename('CWD');   // мм/год

  // ---------- Землепользование ----------
  var lc = ee.ImageCollection('ESA/WorldCover/v200').first().select('Map').rename('LC');

  // ---------- Маска участка: 650–1700 м, без застройки (50) и воды (80) ----------
  var studyMask = dem.gte(ELEV_MIN).and(dem.lte(ELEV_MAX)).and(lc.neq(50)).and(lc.neq(80));

  var cov = ee.Image.cat([
    dem, slope, northness, eastness, tpi, twi, hand,
    s2, ndvi, ndmi, savi, bare,
    MAP, TMAX, TMIN, CWD, lc
  ]).updateMask(studyMask).clip(BOX).float();

  print('Ковариаты (шаг 1):', cov.bandNames());
  Map.addLayer(dem.clip(BOX), {min: 500, max: 2500}, 'Рельеф', false);
  Map.addLayer(ndvi.updateMask(studyMask).clip(BOX),
               {min: 0, max: 0.8, palette: ['#d8c39a', '#2e7d32']}, 'NDVI (участок)');

  Export.image.toAsset({
    image: cov, description: 'covariates_30m', assetId: COV_ASSET,
    region: BOX, scale: SCALE, crs: CRS, maxPixels: 1e13,
    pyramidingPolicy: {'.default': 'mean', 'LC': 'mode'}
  });
  print('Откройте вкладку Tasks → covariates_30m → RUN. После завершения поставьте STEP = 2.');
}

// =====================================================================
// ШАГ 2. МОДЕЛЬ RANDOM FOREST, ОЦЕНКА ТОЧНОСТИ, КАРТА
// =====================================================================
if (STEP === 2) {

  var cov = ee.Image(COV_ASSET);
  // Пиксели без открытой почвы (лес, луг) = -1, чтобы точки не выпадали
  cov = cov.addBands(cov.select('bare_.*').unmask(-1).updateMask(cov.select('elev').mask()),
                     null, true);
  var bands = cov.bandNames();
  var aoi = BOX;

  // ---------- Точки ----------
  var pts;
  if (USE_DEMO) {
    // ТОЛЬКО ДЛЯ ПРОВЕРКИ КОДА: значения из SoilGrids (ocs 0–30 см, т/га)
    pts = ee.Image('projects/soilgrids-isric/ocs_mean').select('ocs_0-30cm_mean').rename('SOC')
            .updateMask(cov.select('elev').mask())
            .sample({region: aoi, scale: 250, numPixels: 400, seed: 1, geometries: true})
            .randomColumn('rnd', 42)
            .map(function (f) {
              return f.set('split', ee.Algorithms.If(ee.Number(f.get('rnd')).lt(0.7), 'train', 'test'));
            });
  } else {
    pts = ee.FeatureCollection(PTS_ASSET);
  }

  var samples = cov.sampleRegions({collection: pts, properties: ['SOC', 'split'],
                                   scale: SCALE, geometries: true});
  var train = samples.filter(ee.Filter.eq('split', 'train'));
  var test  = samples.filter(ee.Filter.eq('split', 'test'));
  print('Точек: всего / train / test', samples.size(), train.size(), test.size());

  // ---------- Модель ----------
  var rf = ee.Classifier.smileRandomForest({
    numberOfTrees: 300, variablesPerSplit: null, minLeafPopulation: 3, bagFraction: 0.632, seed: 42
  }).setOutputMode('REGRESSION')
    .train({features: train, classProperty: 'SOC', inputProperties: bands});

  // ---------- Оценка на независимой выборке ----------
  var pred = test.classify(rf, 'pred');
  var mObs  = ee.Number(pred.aggregate_mean('SOC'));
  var mPred = ee.Number(pred.aggregate_mean('pred'));
  var errs = pred.map(function (f) {
    var o = ee.Number(f.get('SOC')), p = ee.Number(f.get('pred'));
    return f.set({
      se: o.subtract(p).pow(2),
      ae: o.subtract(p).abs(),
      st: o.subtract(mObs).pow(2),
      cv: o.subtract(mObs).multiply(p.subtract(mPred))
    });
  });
  var rmse = ee.Number(errs.aggregate_mean('se')).sqrt();
  var mae  = ee.Number(errs.aggregate_mean('ae'));
  var bias = mPred.subtract(mObs);
  var r2   = ee.Number(1).subtract(ee.Number(errs.aggregate_sum('se'))
                                     .divide(errs.aggregate_sum('st')));
  var vObs  = ee.Number(pred.aggregate_total_var('SOC'));
  var vPred = ee.Number(pred.aggregate_total_var('pred'));
  var ccc = ee.Number(errs.aggregate_mean('cv')).multiply(2)
              .divide(vObs.add(vPred).add(mObs.subtract(mPred).pow(2)));

  print('Оценка точности (test):', ee.Dictionary({
    'RMSE, т/га': rmse, 'MAE, т/га': mae, 'Bias, т/га': bias,
    'R²': r2, 'CCC (Лин)': ccc
  }));

  // График: наблюдённые vs прогноз
  print(ui.Chart.feature.byFeature(pred, 'SOC', 'pred').setChartType('ScatterChart')
    .setOptions({title: 'Наблюдённые vs прогноз (test)', hAxis: {title: 'Наблюдённый SOC, т/га'},
                 vAxis: {title: 'Прогноз SOC, т/га'}, pointSize: 4, legend: {position: 'none'},
                 trendlines: {0: {showR2: true, visibleInLegend: true}}}));

  // График: важность переменных
  var imp = ee.Dictionary(rf.explain().get('importance'));
  var impFc = ee.FeatureCollection(imp.keys().map(function (k) {
    return ee.Feature(null, {variable: k, importance: imp.get(k)});
  })).sort('importance', false);
  print(ui.Chart.feature.byFeature(impFc, 'variable', 'importance').setChartType('BarChart')
    .setOptions({title: 'Важность ковариат (Random Forest)', legend: {position: 'none'}}));

  // ---------- Карта ----------
  var socMap = cov.classify(rf).rename('SOC_stock');
  Map.addLayer(socMap, {min: 20, max: 150, palette: PAL}, 'SOC 0–30 см (модель), т/га');
  Map.addLayer(ee.Image('projects/soilgrids-isric/ocs_mean').select('ocs_0-30cm_mean')
                 .updateMask(cov.select('elev').mask()),
               {min: 20, max: 150, palette: PAL}, 'SoilGrids OCS 0–30 см (сравнение)', false);
  Map.addLayer(train, {color: 'blue'}, 'Точки train', false);
  Map.addLayer(test, {color: 'red'}, 'Точки test', false);

  // Средний запас по высотным поясам
  var zone = cov.select('elev').expression(
    'b < 900 ? 1 : b < 1100 ? 2 : b < 1300 ? 3 : b < 1500 ? 4 : 5', {b: cov.select('elev')}).rename('zone');
  print('Средний запас SOC по высотным поясам (1: <900 м … 5: >1500 м):',
    socMap.addBands(zone).reduceRegion({
      reducer: ee.Reducer.mean().group({groupField: 1, groupName: 'zone'}),
      geometry: aoi, scale: 250, maxPixels: 1e10, tileScale: 4
    }));

  // ---------- Экспорт ----------
  Export.image.toDrive({image: socMap, description: 'SOC_stock_0_30_map', folder: 'SOC_GEE',
    region: aoi, scale: SCALE, crs: CRS, maxPixels: 1e13});
  Export.table.toDrive({collection: samples, description: 'SOC_points_covariates',
    folder: 'SOC_GEE', fileFormat: 'CSV'});           // для R/Python (QRF, неопределённость)
  Export.table.toDrive({collection: errs, description: 'SOC_test_predictions',
    folder: 'SOC_GEE', fileFormat: 'CSV'});
}
