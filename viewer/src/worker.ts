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
  initTimes: number[];      // ms since epoch
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

let pm25Latest: zarr.Array<zarr.NumberDataType, zarr.Readable> | null = null;
let initTimesAll: number[] = [];

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

    const [latestArr, latArr, lonArr, vtArr, liArr] = await Promise.all([
      zarr.open(group.resolve("PM25_latest"), { kind: "array" }),
      zarr.open(group.resolve("lat"), { kind: "array" }),
      zarr.open(group.resolve("lon"), { kind: "array" }),
      zarr.open(group.resolve("valid_time"), { kind: "array" }),
      zarr.open(group.resolve("latest_init_time"), { kind: "array" }),
    ]);

    const [lat, lon, vt, li] = await Promise.all([
      zarr.get(latArr as zarr.Array<zarr.NumberDataType, zarr.Readable>),
      zarr.get(lonArr as zarr.Array<zarr.NumberDataType, zarr.Readable>),
      zarr.get(vtArr as zarr.Array<zarr.NumberDataType, zarr.Readable>),
      zarr.get(liArr as zarr.Array<zarr.NumberDataType, zarr.Readable>),
    ]);

    const latData = lat.data as Float64Array;
    const lonData = lon.data as Float64Array;
    const vtData = vt.data as unknown as BigInt64Array;
    const liData = li.data as unknown as BigInt64Array;

    const validTimes = Array.from(vtData, (s) => Number(s) * 1000);
    const initTimes = Array.from(liData, (s) => Number(s) * 1000);

    pm25Latest = latestArr as zarr.Array<zarr.NumberDataType, zarr.Readable>;
    initTimesAll = initTimes;

    const meta: InitMeta = {
      validTimes,
      initTimes,
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
  if (!pm25Latest) {
    const out: OutMsg = {
      type: "error",
      reqId: msg.reqId,
      error: "Worker not initialized",
    };
    self.postMessage(out);
    return;
  }
  try {
    const result = await zarr.get(pm25Latest, [msg.physIdx, null, null]);
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
      initTime: initTimesAll[msg.physIdx]!,
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
