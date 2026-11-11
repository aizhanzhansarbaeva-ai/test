# =====================================================================
# clhs_sampling.R — расстановка точек отбора проб методом cLHS
# Вход:  clhs_candidates.csv (экспорт из gee/02_covariates.js)
# Выход: sampling_points.csv, sampling_points.gpx (для GPS), sampling_points.shp
# install.packages(c("clhs", "sf", "dplyr"))
# =====================================================================
library(clhs)
library(sf)
library(dplyr)

set.seed(42)
N_MAIN  <- 200   # основная выборка (модель + валидация)
N_SPARE <- 40    # резервные точки на случай недоступности

cand <- read.csv("clhs_candidates.csv") |>
  select(-any_of(c("system.index", ".geo"))) |>
  na.omit()

# Ковариаты, по которым покрываем признаковое пространство
covs <- c("elev", "slope", "northness", "TWI", "TPI",
          "NDVI", "NDVI_p90", "bare_R", "bare_S1", "MAP", "CWD")

# Землепользование как фактор (WorldCover: 20 кустарник, 30 луг, 40 пашня)
cand$LC <- factor(cand$LC)
cand$zone <- cut(cand$elev, c(-Inf, 900, 1100, 1300, 1500, Inf), labels = 1:5)

res <- clhs(cand[, c(covs, "LC")], size = N_MAIN + N_SPARE,
            iter = 20000, progress = TRUE, simple = FALSE)
plot(res)   # кривая сходимости целевой функции

pts <- cand[res$index_samples, ] |>
  mutate(point_id = sprintf("TI-%03d", row_number()),
         role = ifelse(row_number() <= N_MAIN, "main", "spare"))

# Фиксированное разбиение train/test (~25% test), стратифицированно по поясам
pts <- pts |>
  group_by(zone) |>
  mutate(split = ifelse(role == "main" & runif(n()) < 0.25, "test",
                        ifelse(role == "main", "train", NA))) |>
  ungroup()

print(table(pts$zone, pts$LC))   # проверка покрытия страт

# Сравнение распределений: кандидаты vs выборка
for (v in c("elev", "NDVI", "TWI")) {
  cat(v, ": KS p =", ks.test(cand[[v]], pts[[v]])$p.value, "\n")
}

write.csv(pts, "sampling_points.csv", row.names = FALSE)

sf_pts <- st_as_sf(pts, coords = c("lon", "lat"), crs = 4326)
st_write(sf_pts |> transmute(name = point_id, desc = paste(role, zone, LC)),
         "sampling_points.gpx", driver = "GPX", dataset_options = "GPX_USE_EXTENSIONS=YES",
         delete_dsn = TRUE)
st_write(sf_pts, "sampling_points.shp", delete_dsn = TRUE)
