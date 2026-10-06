<script lang="ts">
  import { TreemapChart } from 'echarts/charts';
  import { TooltipComponent } from 'echarts/components';
  import * as echarts from 'echarts/core';
  import { CanvasRenderer } from 'echarts/renderers';
  import { formatBytes, formatPercent } from './lib/format';

  echarts.use([TreemapChart, TooltipComponent, CanvasRenderer]);

  export interface Block {
    label: string;
    bytes: number;
    /** Nom d'une variable CSS de couleur, ex. --q-drive. */
    colorVar: string;
  }

  let { blocks, total }: { blocks: Block[]; total: number } = $props();

  let container: HTMLDivElement;

  $effect(() => {
    const chart = echarts.init(container);
    const css = getComputedStyle(container);
    const color = (name: string) => css.getPropertyValue(name).trim();

    chart.setOption({
      tooltip: {
        formatter: (item: { name: string; value: number }) =>
          `${item.name}<br><b>${formatBytes(item.value)}</b> · ${formatPercent(item.value, total)}`,
      },
      series: [
        {
          type: 'treemap',
          left: 0,
          top: 0,
          right: 0,
          bottom: 0,
          roam: false,
          nodeClick: false,
          breadcrumb: { show: false },
          itemStyle: { borderColor: color('--surface'), borderWidth: 2, gapWidth: 2 },
          label: {
            color: '#fff',
            fontSize: 14,
            fontWeight: 600,
            formatter: (item: { name: string; value: number }) => `${item.name}\n${formatBytes(item.value)}`,
          },
          data: blocks
            .filter((block) => block.bytes > 0)
            .map((block) => ({ name: block.label, value: block.bytes, itemStyle: { color: color(block.colorVar) } })),
        },
      ],
    });

    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(container);
    return () => {
      observer.disconnect();
      chart.dispose();
    };
  });
</script>

<div class="treemap" bind:this={container} role="img" aria-label="Répartition du quota Google par zone"></div>

<style>
  .treemap {
    width: 100%;
    height: clamp(260px, 48vh, 460px);
  }
</style>
