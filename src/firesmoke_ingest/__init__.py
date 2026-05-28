"""BlueSky Canada dispersion forecast ingest into a zarr-v3 store.

See docs/plans/2026-05-26-firesmoke-ingest-design.md for the architecture.
"""
from __future__ import annotations

import re
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
import numpy as np
import typer
import xarray as xr
import zarr
from zarr.codecs import ZstdCodec

DEFAULT_STORE = "./forecasts.zarr"
URL_TEMPLATE = "https://firesmoke.ca/forecasts/{domain}/{run}/dispersion.nc"
CURRENT_URL = "https://firesmoke.ca/forecasts/current/dispersion.nc"

# CF time encoding for valid_time / init_time (int64 seconds since epoch).
TIME_UNITS = "seconds since 1970-01-01 00:00:00"
TIME_CAL = "proleptic_gregorian"
NS_PER_SEC = 1_000_000_000

# Sentinel for "no data here yet" on int64 time arrays. Chosen so that:
#  - it does not collide with any real Unix-second timestamp;
#  - paired with CF attrs it decodes via xarray.open_zarr's _FillValue
#    handling to NaT instead of a plausible 1970 date.
TIME_FILL = np.iinfo(np.int64).min

# PM2.5 storage: signed int16 with CF scale_factor=0.1 µg/m³ per int unit.
# Compresses ~5× better than the source float32 because mostly-zero noise
# in the float mantissa is gone. Range: -32767..32767 → -3276.7..3276.7
# µg/m³, well above any realistic wildfire reading. Fill = -32768 reserves
# the int16 minimum as a NaN sentinel (xarray's decode_cf restores NaN).
PM25_SCALE = 0.1
PM25_OFFSET = 0.0
PM25_FILL = np.int16(-32768)


def _quantize_pm25(arr: np.ndarray) -> np.ndarray:
    """Float32 µg/m³ → int16, with NaN → PM25_FILL."""
    nan_mask = np.isnan(arr)
    scaled = np.round(np.where(nan_mask, 0.0, arr) / PM25_SCALE)
    np.clip(scaled, -32767, 32767, out=scaled)
    out = scaled.astype(np.int16)
    out[nan_mask] = PM25_FILL
    return out

app = typer.Typer(help="Ingest BlueSky Canada dispersion forecasts into zarr-v3.")


# --- run identifier parsing ----------------------------------------------------

_URL_RE = re.compile(
    r"https?://[^/]+/forecasts/(?P<domain>[^/]+)/(?P<run>\d{10})/dispersion\.nc"
)
_ID_RE = re.compile(r"(?P<domain>[^/]+)/(?P<run>\d{10})")
_CURRENT_URL_RE = re.compile(r"https?://[^/]+/forecasts/current/dispersion\.nc")


def parse_run(run_url_or_id: str) -> tuple[str, str | None, str]:
    """Return (domain, run_yyyymmddhh, url).

    For the moving "current" pointer, run is None and the real init_time
    must be read from the downloaded file's IOAPI attrs.
    """
    if run_url_or_id == "current" or _CURRENT_URL_RE.fullmatch(run_url_or_id):
        return "current", None, CURRENT_URL

    m = _URL_RE.match(run_url_or_id) or _ID_RE.fullmatch(run_url_or_id)
    if not m:
        raise typer.BadParameter(
            "Expected one of:\n"
            "  https://firesmoke.ca/forecasts/<DOMAIN>/<YYYYMMDDHH>/dispersion.nc\n"
            "  https://firesmoke.ca/forecasts/current/dispersion.nc\n"
            "  <DOMAIN>/<YYYYMMDDHH>\n"
            "  current"
        )
    domain, run = m.group("domain"), m.group("run")
    return domain, run, URL_TEMPLATE.format(domain=domain, run=run)


# --- IOAPI decode --------------------------------------------------------------


def _parse_ioapi_datetime(sdate: int, stime: int) -> np.datetime64:
    """SDATE = YYYYDDD, STIME = HHMMSS, both UTC."""
    year, doy = divmod(sdate, 1000)
    hh, rem = divmod(stime, 10000)
    mm, ss = divmod(rem, 100)
    dt = datetime(year, 1, 1, tzinfo=timezone.utc) + timedelta(
        days=doy - 1, hours=hh, minutes=mm, seconds=ss
    )
    return np.datetime64(dt.replace(tzinfo=None), "ns")


def _parse_ioapi_tstep_hours(tstep: int) -> int:
    """TSTEP = HHMMSS; expect whole-hour multiples."""
    hh, rem = divmod(tstep, 10000)
    if rem != 0:
        raise ValueError(f"Expected whole-hour TSTEP, got {tstep}")
    return hh


def decode_dispersion(path: Path) -> xr.Dataset:
    """Decode an IOAPI HYSPLIT dispersion.nc into a CF-ish dataset."""
    raw = xr.open_dataset(path, decode_cf=False)
    a = raw.attrs

    init_time = _parse_ioapi_datetime(int(a["SDATE"]), int(a["STIME"]))
    tstep_h = _parse_ioapi_tstep_hours(int(a["TSTEP"]))
    n_steps = raw.sizes["TSTEP"]
    n_rows, n_cols = int(a["NROWS"]), int(a["NCOLS"])

    lead_hour = np.arange(n_steps, dtype=np.int32) * tstep_h
    lat = np.float64(a["YORIG"]) + (np.arange(n_rows) + 0.5) * np.float64(a["YCELL"])
    lon = np.float64(a["XORIG"]) + (np.arange(n_cols) + 0.5) * np.float64(a["XCELL"])

    pm25 = raw["PM25"].values[:, 0, :, :].astype(np.float32, copy=False)  # drop LAY
    raw.close()

    return xr.Dataset(
        data_vars={
            "PM25": (
                ("lead_hour", "lat", "lon"),
                pm25,
                {
                    "units": "ug/m^3",
                    "long_name": "PM2.5 mass concentration at surface",
                },
            ),
        },
        coords={
            "lead_hour": (
                "lead_hour",
                lead_hour,
                {"units": "h", "long_name": "forecast lead time"},
            ),
            "lat": (
                "lat",
                lat,
                {"units": "degrees_north", "standard_name": "latitude"},
            ),
            "lon": (
                "lon",
                lon,
                {"units": "degrees_east", "standard_name": "longitude"},
            ),
            "init_time": ((), init_time),
        },
        attrs={
            "source": f"BlueSky Canada {a.get('GDNAM', '').strip()}",
            "history": "Decoded from IOAPI by firesmoke-ingest",
        },
    )


# --- store IO ------------------------------------------------------------------


def _ns_to_seconds_i64(ns: np.datetime64 | int) -> int:
    if isinstance(ns, np.datetime64):
        ns = int(ns.astype("datetime64[ns]").view("int64"))
    return ns // NS_PER_SEC


def _make_store(store_arg: str) -> zarr.storage.StoreLike:
    """Return a zarr Store object for either a local path or an s3:// URL.

    For S3 we use FsspecStore + s3fs, which picks up credentials from the
    usual AWS_* env vars (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY,
    AWS_ENDPOINT_URL_S3, AWS_REGION). Source Cooperative gives you those
    via their dashboard.
    """
    if store_arg.startswith("s3://"):
        return zarr.storage.FsspecStore.from_url(store_arg)
    p = Path(store_arg)
    p.parent.mkdir(parents=True, exist_ok=True)
    return zarr.storage.LocalStore(str(p))


def _open_or_create_store(store_arg: str, run_ds: xr.Dataset) -> zarr.Group:
    """Open the store if it exists, else create it with the expected schema.

    Idempotent on the structural arrays — re-running against an existing
    store just opens it; this is how scheduled cron ingests work.
    """
    store = _make_store(store_arg)
    # mode="a" = open if exists, create if not. Works for both LocalStore
    # and remote S3-backed FsspecStore without an existence pre-check
    # (which would be awkward over HTTP).
    root = zarr.open_group(store, mode="a")
    if "lat" in root:
        return root

    n_lat = run_ds.sizes["lat"]
    n_lon = run_ds.sizes["lon"]
    n_lead = run_ds.sizes["lead_hour"]
    compressors = [ZstdCodec(level=5)]

    # Coordinates (fixed shape)
    lat_a = root.create_array(
        "lat", shape=(n_lat,), dtype="float64", chunks=(n_lat,),
        compressors=compressors, dimension_names=("lat",),
    )
    lat_a[:] = run_ds["lat"].values
    lat_a.attrs.update({"units": "degrees_north", "standard_name": "latitude"})

    lon_a = root.create_array(
        "lon", shape=(n_lon,), dtype="float64", chunks=(n_lon,),
        compressors=compressors, dimension_names=("lon",),
    )
    lon_a[:] = run_ds["lon"].values
    lon_a.attrs.update({"units": "degrees_east", "standard_name": "longitude"})

    lead_a = root.create_array(
        "lead_hour", shape=(n_lead,), dtype="int32", chunks=(n_lead,),
        compressors=compressors, dimension_names=("lead_hour",),
    )
    lead_a[:] = run_ds["lead_hour"].values
    lead_a.attrs.update({"units": "h", "long_name": "forecast lead time"})

    # Growable coordinates. fill_value=TIME_FILL (int64 min) so any slot
    # that's been resize-extended but not yet written is unambiguously
    # "missing" rather than decoding to a real-looking 1970 timestamp.
    it = root.create_array(
        "init_time", shape=(0,), dtype="int64", chunks=(64,),
        compressors=compressors, dimension_names=("init_time",),
        fill_value=TIME_FILL,
    )
    it.attrs.update({"units": TIME_UNITS, "calendar": TIME_CAL,
                     "long_name": "forecast initialization time",
                     "_FillValue": TIME_FILL})

    vt = root.create_array(
        "valid_time", shape=(0,), dtype="int64", chunks=(720,),
        compressors=compressors, dimension_names=("valid_time",),
        fill_value=TIME_FILL,
    )
    vt.attrs.update({"units": TIME_UNITS, "calendar": TIME_CAL,
                     "long_name": "forecast valid time",
                     "_FillValue": TIME_FILL})

    # Data variables. Stored as int16 with CF scale_factor: 0.1 µg/m³ per
    # int unit. xarray decodes back to float on read (decode_cf default);
    # the viewer's worker reads scale_factor directly and re-quantizes to
    # R8 for the GPU.
    pm25_attrs = {
        "units": "ug/m^3",
        "scale_factor": PM25_SCALE,
        "add_offset": PM25_OFFSET,
        "_FillValue": int(PM25_FILL),
    }
    runs = root.create_array(
        "PM25_runs",
        shape=(0, n_lead, n_lat, n_lon),
        dtype="int16",
        chunks=(1, 1, n_lat, n_lon),
        compressors=compressors,
        fill_value=PM25_FILL,
        dimension_names=("init_time", "lead_hour", "lat", "lon"),
    )
    runs.attrs.update({**pm25_attrs, "long_name": "PM2.5 per-run forecast archive"})

    latest = root.create_array(
        "PM25_latest",
        shape=(0, n_lat, n_lon),
        dtype="int16",
        chunks=(1, n_lat, n_lon),
        compressors=compressors,
        fill_value=PM25_FILL,
        dimension_names=("valid_time", "lat", "lon"),
    )
    latest.attrs.update({**pm25_attrs, "long_name": "PM2.5 latest-wins forecast view"})

    li = root.create_array(
        "latest_init_time",
        shape=(0,),
        dtype="int64",
        chunks=(720,),
        compressors=compressors,
        fill_value=TIME_FILL,
        dimension_names=("valid_time",),
    )
    li.attrs.update({"units": TIME_UNITS, "calendar": TIME_CAL,
                     "long_name": "init_time of the run that currently wins PM25_latest at this valid_time",
                     "_FillValue": TIME_FILL})

    root.attrs.update({
        "created": datetime.now(timezone.utc).isoformat(),
        "schema_version": 1,
        "grid_shape": [n_lat, n_lon],
        "note": "valid_time is stored in arrival order, not sorted. Sort on read if needed.",
    })
    return root


def _check_grid(root: zarr.Group, run_ds: xr.Dataset) -> None:
    saved_lat = root["lat"][:]
    saved_lon = root["lon"][:]
    # Use a tight absolute tolerance: the grid is on integer-spaced
    # 0.1° cell centers, so any cell that should match will match to
    # well within 1e-9. np.allclose's default rtol=1e-5 would silently
    # accept domains whose YORIG drifts by ~1e-3° (~100m at lat 80°).
    new_lat = np.asarray(run_ds["lat"].values)
    new_lon = np.asarray(run_ds["lon"].values)
    if (saved_lat.shape != new_lat.shape
            or not np.allclose(saved_lat, new_lat, rtol=0, atol=1e-9)
            or saved_lon.shape != new_lon.shape
            or not np.allclose(saved_lon, new_lon, rtol=0, atol=1e-9)):
        raise RuntimeError(
            "Grid in store does not match grid in this run. "
            "Multi-domain ingest in one store is out of scope."
        )


def _append_run(root: zarr.Group, run_ds: xr.Dataset, force: bool) -> bool:
    """Append the run to PM25_runs and update PM25_latest.

    Returns True if written, False if skipped as duplicate.

    Write ordering is deliberate: data goes in *before* the coordinate
    array is extended. The init_time coord is the dup-check key, so
    bumping it last means a partial crash either leaves the store
    unchanged from the dup-check's perspective (and the next ingest
    redoes the work cleanly) or leaves a fully-written row that the
    dup check now sees.
    """
    init_s = _ns_to_seconds_i64(run_ds["init_time"].values)
    init_arr = root["init_time"]
    existing = init_arr[:]

    # Quantize once; reused by _update_latest below.
    pm25_q = _quantize_pm25(run_ds["PM25"].values)

    if init_s in existing:
        if not force:
            return False
        idx = int(np.where(existing == init_s)[0][0])
        # Existing slot: just overwrite the data; init_time is already correct.
        root["PM25_runs"][idx, :, :, :] = pm25_q
    else:
        idx = init_arr.shape[0]
        runs = root["PM25_runs"]
        # Data first: extend PM25_runs and fill the new row.
        runs.resize((idx + 1, *runs.shape[1:]))
        runs[idx, :, :, :] = pm25_q
        # Commit: extend init_time and publish the new index. A crash
        # before this line leaves an extra (NaN) row in PM25_runs that
        # the next ingest of the same init_s will overwrite.
        init_arr.resize(idx + 1)
        init_arr[idx] = init_s

    _update_latest(root, init_s, run_ds, pm25_q)
    return True


def _update_latest(
    root: zarr.Group, init_s: int, run_ds: xr.Dataset, pm25_q: np.ndarray,
) -> None:
    """Update PM25_latest with this run's frames where it wins.

    Crash-ordering follows the same principle as _append_run: data
    (PM25_latest + latest_init_time) is written before the valid_time
    coord is published, so a partial crash leaves the store readable.

    Note: this is not a full transaction. If you need bulletproof
    consistency, run under icechunk or do an offline integrity pass.

    `pm25_q` is the already-quantized int16 PM2.5 (n_lead, lat, lon),
    reused from _append_run so we don't re-quantize.
    """
    lead_hours = run_ds["lead_hour"].values
    pm25 = pm25_q  # already int16 quantized

    valid_s = init_s + lead_hours.astype("int64") * 3600

    vt_arr = root["valid_time"]
    li_arr = root["latest_init_time"]
    latest_arr = root["PM25_latest"]

    existing_vt = vt_arr[:]
    existing_li = li_arr[:]
    vt_to_idx: dict[int, int] = {int(v): i for i, v in enumerate(existing_vt)}

    new_vts: list[int] = []
    dst_indices: list[int] = []
    src_indices: list[int] = []

    for src_i, vt in enumerate(valid_s.tolist()):
        if vt in vt_to_idx:
            dst_i = vt_to_idx[vt]
            if init_s >= int(existing_li[dst_i]):
                dst_indices.append(dst_i)
                src_indices.append(src_i)
        else:
            dst_i = len(existing_vt) + len(new_vts)
            vt_to_idx[vt] = dst_i
            new_vts.append(vt)
            dst_indices.append(dst_i)
            src_indices.append(src_i)

    if new_vts:
        new_total = len(existing_vt) + len(new_vts)
        # Extend data + metadata first; valid_time stays at the old length
        # until everything is written. Readers that iterate up to
        # vt_arr.shape[0] won't see any half-filled slots.
        li_arr.resize(new_total)
        latest_arr.resize((new_total, *latest_arr.shape[1:]))

    # Per-slot writes: data, then init metadata.
    for src_i, dst_i in zip(src_indices, dst_indices):
        latest_arr[dst_i, :, :] = pm25[src_i, :, :]
        li_arr[dst_i] = init_s

    # Commit: publish the new valid_time entries. If we crash before this,
    # a re-run of the same init will re-derive the same dst_indices and
    # overwrite the (correct) data — eventually consistent.
    if new_vts:
        vt_arr.resize(len(existing_vt) + len(new_vts))
        vt_arr[len(existing_vt):] = np.array(new_vts, dtype="int64")


# --- fetch ---------------------------------------------------------------------


def fetch(url: str, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    with httpx.stream("GET", url, follow_redirects=True, timeout=300.0) as r:
        r.raise_for_status()
        with dest.open("wb") as f:
            for chunk in r.iter_bytes(chunk_size=1 << 20):
                f.write(chunk)


# --- CLI -----------------------------------------------------------------------


@app.command()
def ingest(
    run: str = typer.Argument(
        ..., help="Full dispersion.nc URL or <domain>/<YYYYMMDDHH>."
    ),
    store: str = typer.Option(
        DEFAULT_STORE,
        help="Zarr store path or s3:// URL. S3 reads creds from the "
        "standard AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / "
        "AWS_ENDPOINT_URL_S3 / AWS_REGION env vars.",
    ),
    force: bool = typer.Option(False, "--force", help="Re-ingest even if already present."),
    keep: Path | None = typer.Option(
        None, "--keep", help="Save downloaded dispersion.nc here instead of a temp file."
    ),
    local: Path | None = typer.Option(
        None, "--local", help="Use this local dispersion.nc instead of fetching."
    ),
) -> None:
    """Ingest one BlueSky Canada dispersion forecast into the zarr store."""
    domain, run_id, url = parse_run(run)

    if local is not None:
        nc_path = local
        typer.echo(f"Using local file: {nc_path}")
    else:
        nc_path = (
            keep if keep is not None
            else Path(tempfile.mkdtemp(prefix="firesmoke-")) / "dispersion.nc"
        )
        typer.echo(f"Fetching {url}")
        fetch(url, nc_path)

    typer.echo("Decoding...")
    run_ds = decode_dispersion(nc_path)
    init = run_ds["init_time"].values
    lh = run_ds["lead_hour"].values
    typer.echo(f"  domain     = {domain}")
    typer.echo(f"  init_time  = {init}")
    typer.echo(f"  lead_hours = {int(lh[0])}..{int(lh[-1])} ({run_ds.sizes['lead_hour']} steps)")
    typer.echo(f"  grid       = {run_ds.sizes['lat']} x {run_ds.sizes['lon']}")

    typer.echo(f"Opening store: {store}")
    root = _open_or_create_store(store, run_ds)
    _check_grid(root, run_ds)

    typer.echo("Writing...")
    wrote = _append_run(root, run_ds, force=force)
    n_runs = int(root["init_time"].shape[0])
    n_vt = int(root["valid_time"].shape[0])
    if wrote:
        typer.echo(f"OK — {n_runs} runs in store, {n_vt} valid_times in PM25_latest.")
    else:
        typer.echo("Skipped: init_time already present (use --force to re-ingest).")


def main() -> None:
    app()


if __name__ == "__main__":
    main()
