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

DEFAULT_STORE = Path("./forecasts.zarr")
URL_TEMPLATE = "https://firesmoke.ca/forecasts/{domain}/{run}/dispersion.nc"
CURRENT_URL = "https://firesmoke.ca/forecasts/current/dispersion.nc"

# CF time encoding for valid_time / init_time (int64 seconds since epoch).
TIME_UNITS = "seconds since 1970-01-01 00:00:00"
TIME_CAL = "proleptic_gregorian"
NS_PER_SEC = 1_000_000_000

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


def _open_or_create_store(store_path: Path, run_ds: xr.Dataset) -> zarr.Group:
    if store_path.exists():
        return zarr.open_group(str(store_path), mode="r+")

    store_path.parent.mkdir(parents=True, exist_ok=True)
    root = zarr.open_group(str(store_path), mode="w")

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

    # Growable coordinates
    it = root.create_array(
        "init_time", shape=(0,), dtype="int64", chunks=(64,),
        compressors=compressors, dimension_names=("init_time",),
    )
    it.attrs.update({"units": TIME_UNITS, "calendar": TIME_CAL,
                     "long_name": "forecast initialization time"})

    vt = root.create_array(
        "valid_time", shape=(0,), dtype="int64", chunks=(720,),
        compressors=compressors, dimension_names=("valid_time",),
    )
    vt.attrs.update({"units": TIME_UNITS, "calendar": TIME_CAL,
                     "long_name": "forecast valid time"})

    # Data variables
    runs = root.create_array(
        "PM25_runs",
        shape=(0, n_lead, n_lat, n_lon),
        dtype="float32",
        chunks=(1, 1, n_lat, n_lon),
        compressors=compressors,
        fill_value=np.float32("nan"),
        dimension_names=("init_time", "lead_hour", "lat", "lon"),
    )
    runs.attrs.update({"units": "ug/m^3", "long_name": "PM2.5 per-run forecast archive"})

    latest = root.create_array(
        "PM25_latest",
        shape=(0, n_lat, n_lon),
        dtype="float32",
        chunks=(1, n_lat, n_lon),
        compressors=compressors,
        fill_value=np.float32("nan"),
        dimension_names=("valid_time", "lat", "lon"),
    )
    latest.attrs.update({"units": "ug/m^3", "long_name": "PM2.5 latest-wins forecast view"})

    li = root.create_array(
        "latest_init_time",
        shape=(0,),
        dtype="int64",
        chunks=(720,),
        compressors=compressors,
        fill_value=-1,
        dimension_names=("valid_time",),
    )
    li.attrs.update({"units": TIME_UNITS, "calendar": TIME_CAL,
                     "long_name": "init_time of the run that currently wins PM25_latest at this valid_time"})

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
    if (saved_lat.shape != run_ds["lat"].shape
            or not np.allclose(saved_lat, run_ds["lat"].values)
            or saved_lon.shape != run_ds["lon"].shape
            or not np.allclose(saved_lon, run_ds["lon"].values)):
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

    if init_s in existing:
        if not force:
            return False
        idx = int(np.where(existing == init_s)[0][0])
        # Existing slot: just overwrite the data; init_time is already correct.
        root["PM25_runs"][idx, :, :, :] = run_ds["PM25"].values
    else:
        idx = init_arr.shape[0]
        runs = root["PM25_runs"]
        # Data first: extend PM25_runs and fill the new row.
        runs.resize((idx + 1, *runs.shape[1:]))
        runs[idx, :, :, :] = run_ds["PM25"].values
        # Commit: extend init_time and publish the new index. A crash
        # before this line leaves an extra (NaN) row in PM25_runs that
        # the next ingest of the same init_s will overwrite.
        init_arr.resize(idx + 1)
        init_arr[idx] = init_s

    _update_latest(root, init_s, run_ds)
    return True


def _update_latest(root: zarr.Group, init_s: int, run_ds: xr.Dataset) -> None:
    """Update PM25_latest with this run's frames where it wins.

    Crash-ordering follows the same principle as _append_run: data
    (PM25_latest + latest_init_time) is written before the valid_time
    coord is published, so a partial crash leaves the store readable.

    Note: this is not a full transaction. If you need bulletproof
    consistency, run under icechunk or do an offline integrity pass.
    """
    lead_hours = run_ds["lead_hour"].values
    pm25 = run_ds["PM25"].values  # (n_lead, lat, lon)

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
    store: Path = typer.Option(DEFAULT_STORE, help="Zarr store path."),
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
