// Smoke-test the zarr read path that the browser uses, against the vite dev server.
import * as zarr from "zarrita";

const ZARR_URL = "http://localhost:5173/forecasts.zarr";

const store = new zarr.FetchStore(ZARR_URL);
const group = await zarr.open(store, { kind: "group" });
console.log("opened group, attrs:", group.attrs);

const pm25 = await zarr.open(group.resolve("PM25_latest"), { kind: "array" });
console.log("PM25_latest shape:", pm25.shape, "dtype:", pm25.dtype);

const vtArr = await zarr.open(group.resolve("valid_time"), { kind: "array" });
const vt = await zarr.get(vtArr);
console.log("valid_time count:", vt.data.length);
console.log("first valid_time:", new Date(Number(vt.data[0]) * 1000).toISOString());
console.log("last valid_time: ", new Date(Number(vt.data[vt.data.length - 1]) * 1000).toISOString());

const latArr = await zarr.open(group.resolve("lat"), { kind: "array" });
const lat = await zarr.get(latArr);
console.log("lat range:", lat.data[0], "to", lat.data[lat.data.length - 1]);

const t0 = performance.now();
const frame = await zarr.get(pm25, [0, null, null]);
const dt = performance.now() - t0;
console.log(`frame[0] shape: ${frame.shape}, dtype=${frame.data.constructor.name}, fetched in ${dt.toFixed(0)}ms`);

let mx = 0;
for (let i = 0; i < frame.data.length; i++) {
  if (frame.data[i] > mx) mx = frame.data[i];
}
console.log(`frame[0] max PM2.5: ${mx.toFixed(2)} µg/m³`);

console.log("\nOK — end-to-end zarrita read works against the vite dev server.");
