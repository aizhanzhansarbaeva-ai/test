// =====================================================================
// 03_model.js — Random Forest для запасов SOC 0–30 см
// Читает готовый стек ковариат из ассета (02_covariates.js → Export.image.toAsset)
// =====================================================================
var cov = ee.Image('projects/YOUR_PROJECT/assets/covariates_30m');
var aoi = cov.geometry();
Map.centerObject(aoi, 9);

// Пиксели, где почва ни разу не была открытой (лес, луг), помечаем -1,
// чтобы точки не выпадали из обучения.
cov = cov.addBands(cov.select('bare_.*').unmask(-1), null, true);
var bands = cov.bandNames();

// true  = ДЕМО (точки из SoilGrids, только для проверки кода)
// false = ваши полевые точки (поле SOC, т/га; поле split = train/test)
var USE_DEMO = true;

var pts;
if (USE_DEMO) {
  pts = ee.Image('projects/soilgrids-isric/ocs_mean').select('ocs_0-30cm_mean').rename('SOC')
          .sample({region: aoi, scale: 250, numPixels: 300, seed: 1, geometries: true})
          .randomColumn('rnd', 42)
          .map(function (f) { return f.set('split', ee.Algorithms.If(ee.Number(f.get('rnd')).lt(0.7), 'train', 'test')); });
} else {
  pts = ee.FeatureCollection('projects/YOUR_PROJECT/assets/soc_points');
}

var samples = cov.sampleRegions({collection: pts, properties: ['SOC', 'split'], scale: 30, geometries: true});
print('Точек для модели:', samples.size());
var train = samples.filter(ee.Filter.eq('split', 'train'));
var test  = samples.filter(ee.Filter.eq('split', 'test'));

var rf = ee.Classifier.smileRandomForest({numberOfTrees: 300, minLeafPopulation: 3, seed: 42})
           .setOutputMode('REGRESSION')
           .train({features: train, classProperty: 'SOC', inputProperties: bands});

var pred = test.classify(rf, 'pred');
var rmse = ee.Number(pred.map(function (f) {
  return f.set('se', ee.Number(f.get('SOC')).subtract(f.get('pred')).pow(2));
}).aggregate_mean('se')).sqrt();
var r = ee.Number(pred.reduceColumns(ee.Reducer.pearsonsCorrelation(), ['SOC', 'pred']).get('correlation'));
print('RMSE (т/га):', rmse);
print('R²:', r.pow(2));
print('Важность переменных:', ee.Dictionary(rf.explain().get('importance')));

var socMap = cov.classify(rf).rename('SOC_stock');
var pal = ['#ffffcc', '#c2e699', '#78c679', '#31a354', '#006837', '#3d2b1f'];
Map.addLayer(socMap, {min: 20, max: 150, palette: pal}, 'SOC stock 0–30 см');
Map.addLayer(pts, {color: 'red'}, 'Точки', false);

Export.image.toDrive({image: socMap, description: 'SOC_stock_map', folder: 'SOC_GEE',
  region: aoi, scale: 30, crs: 'EPSG:32643', maxPixels: 1e13});
