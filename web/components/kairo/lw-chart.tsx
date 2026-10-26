"use client";

import * as React from "react";
import {
  AreaSeries,
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  LineStyle,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type LineWidth,
  type UTCTimestamp,
} from "lightweight-charts";

import type { Candle, Point } from "@/lib/price-feed";
import { cn } from "@/lib/utils";

/**
 * The price chart, drawn with TradingView's Lightweight Charts (Apache 2.0). The library puts its own "TradingView" mark in
 * the corner of every chart, which is the attribution it asks for; the credit line below the charts on the site names it too.
 * Line: the trades as an area line. Candles: Bitfinex 1-minute candles (lime when the minute closed higher, lilac when lower).
 * An optional dashed line marks the round's start price. The data is Bitfinex's, nothing here is made up.
 */

/** The colour a CSS variable really is, as r,g,b: the chart library cannot read oklch(), so it is painted on a canvas and read back. */
function resolveColour(css: string, alpha = 1): string {
  try {
    const probe = document.createElement("span");
    probe.style.color = css;
    document.body.appendChild(probe);
    const resolved = getComputedStyle(probe).color;
    probe.remove();
    const ctx = document
      .createElement("canvas")
      .getContext("2d", { willReadFrequently: true });
    if (!ctx) return css;
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = resolved;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  } catch {
    return css;
  }
}

const localClock = (unixSec: number) => new Date(unixSec * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

const sec = (ms: number) => Math.floor(ms / 1000) as UTCTimestamp;

export type HoverReading = {
  time: number;
  price: number;
  detail?: string;
} | null;

export function LwChart({
  mode,
  candles,
  points,
  startPrice,
  rising = true,
  height = 240,
  onHover,
  className,
}: {
  mode: "line" | "candles";
  /** 1-minute candles, oldest first */
  candles: Candle[];
  /** trades as (time ms, price), oldest first; used by the line */
  points: Point[];
  startPrice: number | null;
  /** colours the line: lime when the price is up, lilac when down */
  rising?: boolean;
  height?: number;
  onHover?: (reading: HoverReading) => void;
  className?: string;
}) {
  const box = React.useRef<HTMLDivElement>(null);
  const chartRef = React.useRef<IChartApi | null>(null);
  const hoverRef = React.useRef(onHover);
  React.useEffect(() => {
    hoverRef.current = onHover;
  });

  // (re)build the chart when the kind of chart or the colour changes; the data is poured in by the next effect
  const [ready, setReady] = React.useState<{
    mode: "line" | "candles";
    chart: IChartApi;
    series: ISeriesApi<"Area"> | ISeriesApi<"Candlestick">;
  } | null>(null);
  React.useEffect(() => {
    const el = box.current;
    if (!el) return;
    const up = resolveColour("var(--color-up)");
    const down = resolveColour("var(--color-down)");
    const grid = resolveColour("var(--color-border)", 0.6);
    const text = resolveColour("var(--color-muted-foreground)");
    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: text,
        fontFamily: "var(--font-geist-mono), ui-monospace, monospace",
        fontSize: 11,
      },
      grid: {
        vertLines: { visible: false },
        horzLines: { color: grid, style: LineStyle.Dotted },
      },
      rightPriceScale: {
        borderVisible: false,
        scaleMargins: { top: 0.12, bottom: 0.12 },
      },
      timeScale: {
        borderVisible: false,
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 2,
        // the library shows UTC; show the viewer's own clock
        tickMarkFormatter: (time: number) => localClock(time),
      },
      localization: { timeFormatter: (time: number) => localClock(time) },
      crosshair: {
        mode: CrosshairMode.Magnet,
        vertLine: { color: text, labelVisible: false },
        horzLine: { visible: false, labelVisible: false },
      },
      handleScroll: false,
      handleScale: false,
    });
    const colour = rising ? up : down;
    const series =
      mode === "candles"
        ? chart.addSeries(CandlestickSeries, {
            upColor: up,
            downColor: down,
            borderUpColor: up,
            borderDownColor: down,
            wickUpColor: up,
            wickDownColor: down,
            priceLineVisible: false,
            lastValueVisible: false,
          })
        : chart.addSeries(AreaSeries, {
            lineColor: colour,
            topColor: colour.replace(/[\d.]+\)$/, "0.28)"),
            bottomColor: colour.replace(/[\d.]+\)$/, "0)"),
            lineWidth: 2 as LineWidth,
            priceLineVisible: false,
            lastValueVisible: false,
            crosshairMarkerRadius: 5,
          });
    chart.subscribeCrosshairMove((p) => {
      if (!p.time || !p.seriesData.size) return hoverRef.current?.(null);
      const d = p.seriesData.get(series) as
        | {
            value?: number;
            close?: number;
            open?: number;
            high?: number;
            low?: number;
          }
        | undefined;
      if (!d) return hoverRef.current?.(null);
      const price = d.value ?? d.close;
      if (price === undefined) return hoverRef.current?.(null);
      hoverRef.current?.({
        time: (p.time as number) * 1000,
        price,
        detail:
          d.open !== undefined && d.high !== undefined && d.low !== undefined
            ? `O ${d.open.toLocaleString("en-US", { maximumFractionDigits: 2 })}  H ${d.high.toLocaleString("en-US", { maximumFractionDigits: 2 })}  L ${d.low.toLocaleString("en-US", { maximumFractionDigits: 2 })}`
            : undefined,
      });
    });
    chartRef.current = chart;
    setReady({ mode, chart, series });
    return () => {
      // the library may still have a paint queued for the next frame; taking the chart down after it avoids an error from that paint
      requestAnimationFrame(() => requestAnimationFrame(() => chart.remove()));
      chartRef.current = null;
      setReady(null);
    };
  }, [mode, rising]);

  // the data and the start price line
  React.useEffect(() => {
    if (!ready || ready.mode !== mode) return; // the chart for the other kind is still being swapped out
    const { chart, series } = ready;
    if (mode === "candles") {
      (series as ISeriesApi<"Candlestick">).setData(
        candles.map((c) => ({
          time: sec(c.t),
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
        })),
      );
    } else {
      // one value per second, in time order (the library needs strictly increasing times)
      const bySecond = new Map<number, number>();
      for (const [t, v] of points) bySecond.set(sec(t), v);
      (series as ISeriesApi<"Area">).setData(
        [...bySecond.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([time, value]) => ({ time: time as UTCTimestamp, value })),
      );
    }
    const line =
      startPrice !== null
        ? series.createPriceLine({
            price: startPrice,
            color: resolveColour("var(--color-muted-foreground)"),
            lineWidth: 2,
            lineStyle: LineStyle.Dashed,
            axisLabelVisible: true,
            title: "start",
          })
        : null;
    chart.timeScale().fitContent();
    return () => {
      try {
        if (line) series.removePriceLine(line);
      } catch {
        /* the chart was already taken down */
      }
    };
  }, [ready, mode, candles, points, startPrice]);

  return (
    <div
      ref={box}
      className={cn("w-full", className)}
      style={{ height }}
      onPointerLeave={() => onHover?.(null)}
    />
  );
}
