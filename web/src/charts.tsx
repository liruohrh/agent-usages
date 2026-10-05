/**
 * ECharts, wrapped small.
 *
 * Only the pieces the dashboard draws are registered (line and bar, plus grid,
 * tooltip and legend — no pie: sized slices of thirty entries are unreadable),
 * which keeps the bundle near 400 kB instead of the ~1 MB the full `echarts`
 * entry pulls in. The wrapper itself is twenty lines: create once, `setOption`
 * on change, resize with the element.
 */

import { useEffect, useRef } from 'react';
import * as echarts from 'echarts/core';
import { BarChart, LineChart } from 'echarts/charts';
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';

import type { AgentTotals, TimeseriesBucket, TokenBuckets } from './types';
import { agentColor, agentLabel, chartTheme, formatCost, formatDayShort, formatTokens } from './format';
import { t as catalogue } from './i18n';

echarts.use([LineChart, BarChart, GridComponent, TooltipComponent, LegendComponent, CanvasRenderer]);

/** Any option ECharts accepts; the concrete shape is per chart below. */
export type ChartOption = Parameters<echarts.ECharts['setOption']>[0];

/** The host element, with the ECharts instance reachable for imperative work. */
interface ChartHost extends HTMLDivElement {
  /** The live instance, for `resize()` and for the end-to-end tests. */
  chartInstance?: echarts.ECharts | undefined;
}

/**
 * One chart, bound to a div.
 *
 * A click on a series element reports the category index it landed on; the
 * caller decides what that means (the time series drills into it). Clicks on the
 * legend, the axis or the empty canvas are not series clicks and are ignored —
 * a reader re-reading the legend must not lose their place in the data.
 *
 * @param props - the option, the height, an optional class, and the callbacks.
 */
export function EChart({
  option,
  height,
  className,
  onSelect,
  fullscreen = false,
}: {
  option: ChartOption;
  height: number;
  className?: string;
  onSelect?: ((index: number) => void) | undefined;
  fullscreen?: boolean | undefined;
}): React.ReactElement {
  const host = useRef<ChartHost | null>(null);
  const chart = useRef<echarts.ECharts | null>(null);
  const select = useRef(onSelect);
  select.current = onSelect;

  useEffect(() => {
    const element = host.current;
    if (element === null) return;
    const instance = echarts.init(element, undefined, { renderer: 'canvas' });
    chart.current = instance;
    element.chartInstance = instance;
    const observer = new ResizeObserver(() => instance.resize());
    observer.observe(element);
    // `trigger: 'item'`-style clicks only; ECharts reports what was hit, and a
    // hit on anything but a series is not a selection.
    const onClick = (params: { componentType?: string; dataIndex?: number }): void => {
      if (params.componentType !== 'series' || typeof params.dataIndex !== 'number') return;
      select.current?.(params.dataIndex);
    };
    instance.on('click', onClick);
    return () => {
      observer.disconnect();
      instance.dispose();
      element.chartInstance = undefined;
      chart.current = null;
    };
  }, []);

  useEffect(() => {
    chart.current?.setOption(option, true);
  }, [option]);

  // Fullscreen resizes the element without a layout pass the observer can see in
  // time, and Esc leaves it without React knowing, so resize on the event too.
  useEffect(() => {
    const resize = (): void => chart.current?.resize();
    resize();
    document.addEventListener('fullscreenchange', resize);
    window.addEventListener('resize', resize);
    return () => {
      document.removeEventListener('fullscreenchange', resize);
      window.removeEventListener('resize', resize);
    };
  }, [fullscreen]);

  return <div ref={host} className={className} style={{ height, width: '100%' }} />;
}

/** Shared tooltip styling for both themes. */
function tooltip(dark: boolean): Record<string, unknown> {
  const theme = chartTheme(dark);
  return {
    backgroundColor: theme.tooltipBg,
    borderColor: theme.tooltipBorder,
    textStyle: { color: theme.text, fontSize: 12 },
    confine: true,
  };
}

/** Which quantity the time series draws. */
export type SeriesMetric = 'cost' | 'requests' | 'tokens';

/** Per-agent lines over time, plus the total. */
export function timeseriesOption(
  points: readonly TimeseriesBucket[],
  agents: readonly AgentTotals[],
  metric: SeriesMetric,
  symbol: string,
  dark: boolean,
): ChartOption {
  const theme = chartTheme(dark);
  const valueOf = (bucket: TimeseriesBucket, agentId: string): number => {
    if (agentId === '*') {
      return metric === 'cost' ? Number(bucket.cost) : metric === 'requests' ? bucket.requests : totalTokens(bucket.tokens);
    }
    const entry = bucket.byAgent[agentId];
    if (entry === undefined) return 0;
    return metric === 'cost' ? Number(entry.cost) : metric === 'requests' ? entry.requests : totalTokens(entry.tokens);
  };
  const present = agents.filter((agent) => points.some((bucket) => (bucket.byAgent[agent.id]?.requests ?? 0) > 0));
  const series = [
    ...present.map((agent) => ({
      name: agentLabel(agent.id),
      type: 'line' as const,
      smooth: true,
      showSymbol: points.length <= 40,
      symbolSize: 5,
      lineStyle: { width: 2, color: agentColor(agent.id) },
      itemStyle: { color: agentColor(agent.id) },
      areaStyle: present.length === 1 ? { opacity: 0.14 } : undefined,
      data: points.map((bucket) => valueOf(bucket, agent.id)),
    })),
    {
      name: catalogue().tables.chartTotal,
      type: 'line' as const,
      smooth: true,
      showSymbol: false,
      lineStyle: { width: 2, type: 'dashed' as const, color: theme.axis },
      itemStyle: { color: theme.axis },
      data: points.map((bucket) => valueOf(bucket, '*')),
    },
  ];
  const format = (value: number): string =>
    metric === 'cost' ? formatCost(String(value), symbol) : formatTokens(value, true);
  return {
    grid: { left: 8, right: 16, top: 28, bottom: 8, containLabel: true },
    tooltip: {
      ...tooltip(dark),
      trigger: 'axis',
      valueFormatter: format,
    },
    legend: { top: 0, textStyle: { color: theme.axis, fontSize: 11 }, icon: 'roundRect' },
    xAxis: {
      type: 'category',
      boundaryGap: false,
      data: points.map((bucket) => bucket.label),
      axisLabel: {
        color: theme.axis,
        fontSize: 10,
        hideOverlap: true,
        formatter: (value: string) => (value.includes(' ') ? value.slice(5) : formatDayShort(Date.parse(`${value}T00:00:00`))),
      },
      axisLine: { lineStyle: { color: theme.split } },
      axisTick: { show: false },
    },
    yAxis: {
      type: 'value',
      axisLabel: { color: theme.axis, fontSize: 10, formatter: (value: number) => format(value) },
      splitLine: { lineStyle: { color: theme.split } },
    },
    series,
  };
}

/** The four disjoint buckets added up (reasoning is already inside output). */
function totalTokens(tokens: TokenBuckets): number {
  return tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
}

/** Requests per project, as a horizontal bar — the ranking the tree cannot show. */
export function projectBarOption(
  rows: readonly { name: string; value: number; extra: string }[],
  symbol: string,
  dark: boolean,
): ChartOption {
  const theme = chartTheme(dark);
  return {
    grid: { left: 8, right: 24, top: 8, bottom: 8, containLabel: true },
    tooltip: { ...tooltip(dark), trigger: 'item', formatter: (params: { name: string; data: { extra: string } }) => `${params.name}<br/>${params.data.extra}` },
    xAxis: {
      type: 'value',
      axisLabel: { color: theme.axis, fontSize: 10, formatter: (value: number) => formatCost(String(value), symbol) },
      splitLine: { lineStyle: { color: theme.split } },
    },
    yAxis: {
      type: 'category',
      inverse: true,
      data: rows.map((row) => row.name),
      axisLabel: { color: theme.axis, fontSize: 10, width: 120, overflow: 'truncate' },
      axisLine: { lineStyle: { color: theme.split } },
      axisTick: { show: false },
    },
    series: [
      {
        type: 'bar',
        barMaxWidth: 14,
        itemStyle: { color: '#58a6ff', borderRadius: [0, 4, 4, 0] },
        data: rows.map((row) => ({ value: row.value, extra: row.extra })),
      },
    ],
  };
}
