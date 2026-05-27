# firesmoke-zarr

A Zarr-v3 conversion of the [BlueSky Canada](https://firesmoke.ca) wildfire smoke dispersion forecasts, plus a deck.gl/MapLibre web viewer that animates them smoothly in the browser.

BlueSky publishes IOAPI NetCDF (HYSPLIT output) four times a day with a 51-hour PM2.5 forecast horizon. This repo turns that into a Zarr store a JS client can range-read over HTTP, and ships a viewer that cross-fades between hourly frames on the GPU.

```text
firesmoke.ca/dispersion.nc  ──►  firesmoke-ingest  ──►  forecasts.zarr  ──►  viewer
```

Zarr product available on Source Cooperative: https://source.coop/alukach/firesmoke

## Data

Each run is a `PM25(TSTEP=51, LAY=1, ROW=381, COL=1081)` IOAPI NetCDF. The ingest decodes the grid and time from global attrs, drops the singleton `LAY`, and writes two variables into a single Zarr v3 group:

```text
forecasts.zarr/
├── PM25_runs           (init_time, lead_hour, lat, lon)   chunks (1, 1, 381, 1081)
├── PM25_latest         (valid_time, lat, lon)             chunks (1, 381, 1081)
└── latest_init_time    (valid_time,)                      which run currently wins
```

`PM25_runs` is the full per-run archive. `PM25_latest` is the latest-wins view the viewer animates: each `valid_time = init_time + lead_hour` slot is overwritten only when the incoming run is at least as new as `latest_init_time[valid_time]`. That makes ingest commutative — backfilling an older run never clobbers a fresher forecast. The single-frame chunk shape means one HTTP range request = one frame.

```bash
uv run firesmoke-ingest <domain>/<run>   # or: uv run firesmoke-ingest current
```

## Viewer

A Vite + React app that opens `forecasts.zarr` directly via [`zarrita`](https://github.com/manzt/zarrita.js) and draws it with a custom deck.gl `BitmapLayer` on a MapLibre basemap.

- A Web Worker owns the `zarr.FetchStore` so chunk fetches and zstd decode stay off the main thread. Each frame load is one `zarr.get(PM25_latest, [i, null, null])` and the `Float32Array` is posted back as a transferable. Every frame is prefetched (6 concurrent) so the cache is warm by the time the user hits play.
- The PM2.5 palette is baked into a 256×1 RGBA8 LUT and sampled on the GPU with linear filtering. Switching palettes just re-uploads the 1 KB texture.
- `Pm25Layer.draw()` reads `performance.now()` each tick to derive a continuous playhead, binds frame A and frame B, and the fragment shader does `mix(A, B, tMix)` where `tMix` is the fractional part. This GPU cross-fade is what makes the animation feel continuous instead of clicking through 51 stills. React doesn't re-render per animation tick.

## Running it

```bash
uv sync
uv run firesmoke-ingest current

cd viewer
npm install
npm run dev
```

Override the store URL with `?zarr=<url>` or `VITE_ZARR_URL`.
