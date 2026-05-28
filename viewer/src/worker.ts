/// <reference lib="webworker" />
// Web Worker: owns zarrita FetchStore and zstd decode.
// Posts raw Float32Array slices back to the main thread as transferables.
import * as zarr from "zarrita";

declare const self: DedicatedWorkerGlobalScope;

type InitMsg = { type: "init"; zarrUrl: string };
type LoadMsg = { type: "load"; reqId: number; physIdx: number };
type InMsg = InitMsg | LoadMsg;

type InitMeta = {
  validTimes: number[];     // ms since epoch (in store order, not sorted)
  initTimes: number[];      // ms since epoch — full init_time array, all runs
  selectedIdx: number;      // index into initTimes of the currently-loaded run
  lat: Float64Array;
  lon: Float64Array;
  width: number;            // n_lon
  height: number;           // n_lat
};

type OutMsg =
  | { type: "init-result"; meta: InitMeta }
  | {
      type: "load-result";
      reqId: number;
      physIdx: number;
      data: Float32Array;
      maxPm25: number;
      initTime: number;
    }
  | { type: "error"; reqId?: number; error: string };

let pm25Runs: zarr.Array<zarr.NumberDataType, zarr.Readable> | null = null;
let initTimesAll: number[] = [];
let selectedInitIdx = 0;

// Schemas the viewer knows how to read. Bump when the store layout
// changes in an incompatible way; the ingest writes `schema_version`
// onto the root group attrs (see firesmoke_ingest).
const SUPPORTED_SCHEMA_VERSIONS = new Set([1]);

async function handleInit(msg: InitMsg): Promise<void> {
  try {
    const store = new zarr.FetchStore(msg.zarrUrl);
    const group = await zarr.open(store, { kind: "group" });

    const version = (group.attrs as { schema_version?: number }).schema_version;
    if (version === undefined) {
      throw new Error(
        "Forecast store is missing `schema_version` attr — was it written by " +
          "an older ingest? Re-ingest with the current firesmoke-ingest.",
      );
    }
    if (!SUPPORTED_SCHEMA_VERSIONS.has(version)) {
      throw new Error(
        `Forecast store schema_version=${version} is not supported by this viewer ` +
          `(supports: ${[...SUPPORTED_SCHEMA_VERSIONS].join(", ")}).`,
      );
    }

    const [runsArr, latArr, lonArr, iArr, lhArr] = await Promise.all([
      zarr.open(group.resolve("PM25_runs"), { kind: "array" }),
      zarr.open(group.resolve("lat"), { kind: "array" }),
      zarr.open(group.resolve("lon"), { kind: "array" }),
      zarr.open(group.resolve("init_time"), { kind: "array" }),
      zarr.open(group.resolve("lead_hour"), { kind: "array" }),
    ]);

    const [lat, lon, iv, lh] = await Promise.all([
      zarr.get(latArr as zarr.Array<zarr.NumberDataType, zarr.Readable>),
      zarr.get(lonArr as zarr.Array<zarr.NumberDataType, zarr.Readable>),
      zarr.get(iArr as zarr.Array<zarr.NumberDataType, zarr.Readable>),
      zarr.get(lhArr as zarr.Array<zarr.NumberDataType, zarr.Readable>),
    ]);

    const latData = lat.data as Float64Array;
    const lonData = lon.data as Float64Array;
    const initData = iv.data as unknown as BigInt64Array;
    const leadData = lh.data as Int32Array;

    const initTimes = Array.from(initData, (s) => Number(s) * 1000);
    const leadHoursMs = Array.from(leadData, (h) => h * 3600_000);

    // Default to the most recent run.
    const initIdx = initTimes.length - 1;
    const initMs = initTimes[initIdx]!;
    const validTimes = leadHoursMs.map((dt) => initMs + dt);

    pm25Runs = runsArr as zarr.Array<zarr.NumberDataType, zarr.Readable>;
    initTimesAll = initTimes;
    selectedInitIdx = initIdx;

    const meta: InitMeta = {
      validTimes,
      initTimes,
      selectedIdx: initIdx,
      lat: latData,
      lon: lonData,
      width: lonData.length,
      height: latData.length,
    };

    const out: OutMsg = { type: "init-result", meta };
    // Transfer the coord arrays — the worker doesn't need them after this.
    self.postMessage(out, [latData.buffer, lonData.buffer]);
  } catch (err) {
    const out: OutMsg = {
      type: "error",
      error: err instanceof Error ? err.message : String(err),
    };
    self.postMessage(out);
  }
}

async function handleLoad(msg: LoadMsg): Promise<void> {
  if (!pm25Runs) {
    const out: OutMsg = {
      type: "error",
      reqId: msg.reqId,
      error: "Worker not initialized",
    };
    self.postMessage(out);
    return;
  }
  try {
    const result = await zarr.get(pm25Runs, [
      selectedInitIdx,
      msg.physIdx,
      null,
      null,
    ]);
    const data = result.data as Float32Array;

    let maxPm25 = 0;
    for (let i = 0; i < data.length; i++) {
      const v = data[i]!;
      if (v > maxPm25) maxPm25 = v;
    }

    const out: OutMsg = {
      type: "load-result",
      reqId: msg.reqId,
      physIdx: msg.physIdx,
      data,
      maxPm25,
      initTime: initTimesAll[selectedInitIdx]!,
    };
    self.postMessage(out, [data.buffer]);
  } catch (err) {
    const out: OutMsg = {
      type: "error",
      reqId: msg.reqId,
      error: err instanceof Error ? err.message : String(err),
    };
    self.postMessage(out);
  }
}

self.onmessage = (ev: MessageEvent<InMsg>) => {
  const msg = ev.data;
  if (msg.type === "init") {
    void handleInit(msg);
  } else if (msg.type === "load") {
    void handleLoad(msg);
  }
};

export type { InitMeta, OutMsg, InMsg };
