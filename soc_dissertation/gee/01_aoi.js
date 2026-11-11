// =====================================================================
// 01_aoi.js — граница участка: предгорья Заилийского Алатау (650–1700 м)
// Запускать в https://code.earthengine.google.com/
// Замените YOUR_NAME на имя вашего аккаунта/проекта Earth Engine.
// =====================================================================
var box = ee.Geometry.Rectangle([76.30, 43.05, 78.20, 43.50]);
var ELEV_MIN = 650, ELEV_MAX = 1700;

var dem = ee.ImageCollection('COPERNICUS/DEM/GLO30').select('DEM')
            .filterBounds(box).mosaic().rename('elev');
var lc  = ee.ImageCollection('ESA/WorldCover/v200').first().select('Map');

// Высотная маска без застройки (50) и воды (80)
var mask = dem.gte(ELEV_MIN).and(dem.lte(ELEV_MAX))
              .and(lc.neq(50)).and(lc.neq(80))
              .selfMask()
              .focal_mode({radius: 3, units: 'pixels'});

var aoi = mask.reduceToVectors({
  geometry: box, scale: 90, geometryType: 'polygon',
  eightConnected: true, maxPixels: 1e10
}).filter(ee.Filter.gt('count', 500))     // убрать полигоны < ~4 км²
  .union(100);

// Высотные пояса для стратификации (уточните по почвенной карте)
var zones = dem.updateMask(mask).expression(
  'b < 900 ? 1 : b < 1100 ? 2 : b < 1300 ? 3 : b < 1500 ? 4 : 5', {b: dem}
).rename('zone').toByte();

Map.centerObject(box, 9);
Map.addLayer(dem.clip(box), {min: 500, max: 2500}, 'DEM', false);
Map.addLayer(zones.clip(box), {min: 1, max: 5,
  palette: ['#f4e3b1', '#d9b26f', '#a6763c', '#5a4a2f', '#2e5d34']}, 'Высотные пояса');
Map.addLayer(aoi.style({color: 'red', fillColor: '00000000'}), {}, 'AOI');
print('Площадь AOI, км²:', aoi.geometry().area(100).divide(1e6));

// Площадь по поясам
var areaByZone = ee.Image.pixelArea().divide(1e6).addBands(zones).reduceRegion({
  reducer: ee.Reducer.sum().group({groupField: 1, groupName: 'zone'}),
  geometry: aoi.geometry(), scale: 90, maxPixels: 1e10
});
print('Площадь по поясам, км²:', areaByZone);

Export.table.toDrive({collection: aoi, description: 'AOI_TransIli_foothills', fileFormat: 'SHP'});
Export.table.toAsset({collection: aoi, description: 'AOI_asset',
                      assetId: 'users/YOUR_NAME/aoi_transili'});
