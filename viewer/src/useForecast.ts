import { useEffect, useState } from "react";
import type { InitMeta, OutMsg } from "./worker.ts";
import ForecastWorker from "./worker.ts?worker";

export type ForecastMeta = {
  validTimes: number[];
  initTimes: number[];
  selectedIdx: number;
  latMin: number;
  latMax: number;
  lonMin: number;
  lonMax: number;
  width: number;
  height: number;
};

export type Frame = {
  /** PM2.5 quantized to 0-255 against PM_MAX in the worker. Multiply by
   *  PM_MAX/255 to recover µg/m³ for CPU-side consumers; the GPU samples
   *  the r8unorm texture directly into the colormap LUT. */
  data: Uint8Array;
  maxPm25: number;
  initTime: number;
};

export type PrefetchProgress = {
  loaded: number;
  total: number;
  inFlight: boolean;
};

type ReadyState = {
  status: "ready";
  meta: ForecastMeta;
  /** Async fetch — used for prefetch and explicit waits. */
  getFrame: (idx: number) => Promise<Frame>;
  /** Synchronous lookup — returns null if not yet cached. Used by Pm25Layer.draw. */
  peekFrame: (idx: number) => Frame | null;
  /** Bumps every time a new frame lands in the cache. Use as a layer prop
   *  so deck.gl redraws when prefetch progresses. */
  framesVersion: number;
  prefetchAll: () => Promise<void>;
  prefetchProgress: PrefetchProgress;
};

type State =
  | { status: "loading" }
  | { status: "error"; error: string }
  | ReadyState;

const PREFETCH_CONCURRENCY = 6;

export function useForecast(zarrUrl: string, runIdx?: number): State {
  const [state, setState] = useState<State>({ status: "loading" });
  const [progress, setProgress] = useState<PrefetchProgress>({
    loaded: 0,
    total: 0,
    inFlight: false,
  });
  const [framesVersion, setFramesVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const worker: Worker = new ForecastWorker();
    let nextReqId = 1;
    const pending = new Map<
      number,
      { resolve: (f: Frame) => void; reject: (e: Error) => void }
    >();

    // Single message router. init-result resolves the init promise;
    // load-result/error reach the pending map; unsolicited errors flip
    // the React state to "error". Avoid two competing onmessage handlers
    // — they used to race over which one resolved init.
    let resolveInit: (m: InitMeta) => void = () => {};
    let rejectInit: (e: Error) => void = () => {};
    const initPromise = new Promise<InitMeta>((resolve, reject) => {
      resolveInit = resolve;
      rejectInit = reject;
    });
    let initSettled = false;

    worker.onmessage = (ev: MessageEvent<OutMsg>) => {
      const msg = ev.data;
      if (msg.type === "init-result") {
        if (!initSettled) {
          initSettled = true;
          resolveInit(msg.meta);
        }
      } else if (msg.type === "load-result") {
        const p = pending.get(msg.reqId);
        if (!p) return;
        pending.delete(msg.reqId);
        p.resolve({
          data: msg.data,
          maxPm25: msg.maxPm25,
          initTime: msg.initTime,
        });
      } else if (msg.type === "error") {
        if (msg.reqId !== undefined) {
          const p = pending.get(msg.reqId);
          if (p) {
            pending.delete(msg.reqId);
            p.reject(new Error(msg.error));
          }
        } else if (!initSettled) {
          initSettled = true;
          rejectInit(new Error(msg.error));
        } else if (!cancelled) {
          setState({ status: "error", error: msg.error });
        }
      }
    };

    worker.onerror = (ev) => {
      const message =
        (ev as ErrorEvent).message || "Forecast worker crashed";
      if (!initSettled) {
        initSettled = true;
        rejectInit(new Error(message));
      } else if (!cancelled) {
        setState({ status: "error", error: message });
      }
    };

    worker.postMessage({ type: "init", zarrUrl, initIdx: runIdx });

    (async () => {
      try {
        const initMeta = await initPromise;
        if (cancelled) return;

        const sortedIdx = [...initMeta.validTimes.keys()].sort(
          (a, b) => initMeta.validTimes[a]! - initMeta.validTimes[b]!,
        );
        const sortedValidTimes = sortedIdx.map((i) => initMeta.validTimes[i]!);

        const meta: ForecastMeta = {
          validTimes: sortedValidTimes,
          initTimes: initMeta.initTimes,
          selectedIdx: initMeta.selectedIdx,
          latMin: initMeta.lat[0]!,
          latMax: initMeta.lat[initMeta.lat.length - 1]!,
          lonMin: initMeta.lon[0]!,
          lonMax: initMeta.lon[initMeta.lon.length - 1]!,
          width: initMeta.width,
          height: initMeta.height,
        };

        // Plain Map — held in closure, not React state. Pm25Layer reads via
        // peekFrame() each draw; framesVersion bumps when new frames arrive
        // so deck.gl redraws.
        const cache = new Map<number, Frame>();
        const inflight = new Map<number, Promise<Frame>>();

        const peekFrame = (sortedI: number): Frame | null => {
          return cache.get(sortedI) ?? null;
        };

        const requestFrame = (physIdx: number): Promise<Frame> => {
          const reqId = nextReqId++;
          return new Promise<Frame>((resolve, reject) => {
            pending.set(reqId, { resolve, reject });
            worker.postMessage({ type: "load", reqId, physIdx });
          });
        };

        const getFrame = (sortedI: number): Promise<Frame> => {
          const cached = cache.get(sortedI);
          if (cached) return Promise.resolve(cached);
          const ongoing = inflight.get(sortedI);
          if (ongoing) return ongoing;
          const physIdx = sortedIdx[sortedI]!;
          const p = requestFrame(physIdx).then((f) => {
            cache.set(sortedI, f);
            inflight.delete(sortedI);
            setFramesVersion((v) => v + 1);
            return f;
          });
          inflight.set(sortedI, p);
          return p;
        };

        const total = sortedValidTimes.length;

        const prefetchAll = async (): Promise<void> => {
          if (cache.size >= total) return;
          setProgress({ loaded: cache.size, total, inFlight: true });
          const queue = Array.from({ length: total }, (_, i) => i).filter(
            (i) => !cache.has(i),
          );
          const workerFn = async () => {
            while (queue.length > 0) {
              const i = queue.shift();
              if (i === undefined) return;
              try {
                await getFrame(i);
              } catch {
                // Skip; the frame will retry naturally if peekFrame is
                // called again for this index (cache check fails →
                // getFrame is re-invoked). We still want the progress
                // bar to advance so the UI doesn't appear stuck.
              }
              // Functional update — concurrent workers' setProgress calls
              // would otherwise race on a closure-shared `loaded` counter.
              setProgress((prev) => {
                const next = prev.loaded + 1;
                return { loaded: next, total, inFlight: next < total };
              });
            }
          };
          await Promise.allSettled(
            Array.from({ length: PREFETCH_CONCURRENCY }, workerFn),
          );
          // Use the actual cache size — workerFn-driven loaded counter
          // could over- or under-count if a frame got cached by a parallel
          // getFrame call in flight.
          setProgress({ loaded: cache.size, total, inFlight: false });
        };

        setProgress({ loaded: 0, total, inFlight: false });
        setState({
          status: "ready",
          meta,
          getFrame,
          peekFrame,
          framesVersion: 0,
          prefetchAll,
          prefetchProgress: { loaded: 0, total, inFlight: false },
        });
        // Optimistically warm the cache so animation is smooth from the
        // moment the user hits play.
        void prefetchAll();
      } catch (err) {
        if (cancelled) return;
        setState({
          status: "error",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();

    return () => {
      cancelled = true;
      worker.terminate();
      // Reject pending getFrame promises so any awaiting consumer
      // (PointChart sampling, in-flight prefetch) unblocks with an
      // error rather than hanging forever.
      const err = new Error("Forecast worker terminated");
      for (const p of pending.values()) p.reject(err);
      pending.clear();
      if (!initSettled) {
        initSettled = true;
        rejectInit(err);
      }
    };
  }, [zarrUrl, runIdx]);

  if (state.status === "ready") {
    return { ...state, prefetchProgress: progress, framesVersion };
  }
  return state;
}
