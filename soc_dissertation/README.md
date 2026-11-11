# Запасы SOC в предгорьях ЮВ Казахстана — рабочие материалы

| Файл | Назначение |
|---|---|
| `gee/01_aoi.js` | Граница участка (Заилийский Алатау, 650–1700 м), высотные пояса, экспорт SHP |
| `gee/02_covariates.js` | Стек ковариат (рельеф, Sentinel-2, композит открытой почвы, климат, LC); экспорт GeoTIFF и кандидатов для cLHS |
| `R/clhs_sampling.R` | Расстановка 200 + 40 резервных точек методом cLHS; CSV / GPX / SHP |
| `templates/SOC_field_data.xlsx` | Шаблон полевых и лабораторных данных с формулами запасов |
| `templates/sites.csv`, `samples.csv` | Те же таблицы в CSV |
| `templates/gee_upload.csv` | Формат для загрузки точек в Earth Engine (поле `SOC` — запас 0–30 см, т/га) |

## Порядок работы
1. `01_aoi.js` → ассет `users/<вы>/aoi_transili`.
2. `02_covariates.js` → `covariates_30m.tif`, `clhs_candidates.csv` (Google Drive, папка SOC_GEE).
3. `clhs_sampling.R` → `sampling_points.gpx` в навигатор.
4. Поле + лаборатория → `SOC_field_data.xlsx`.
5. Лист `gee_upload` → CSV → Assets → New → CSV (X = `lon`, Y = `lat`) → `users/<вы>/soc_points`.
6. Скрипт моделирования (RF) использует этот ассет.

## Формулы
- SOC (%) = гумус по Тюрину (%) / 1.724
- Запас слоя (т/га) = SOC (%) × BD (г/см³) × толщина (см) × (1 − камни %/100)
- Запас 0–30 см = сумма слоёв 0–10, 10–20, 20–30 см
