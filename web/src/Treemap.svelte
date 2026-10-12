<script lang="ts" module>
  export interface Brick {
    id: string;
    v: number;
    /** Clé de couleur (type de pièce jointe ou de fichier). */
    t: string;
  }

  export interface Node {
    /** Valeur du bloc ; null pour un regroupement « autres ». */
    k: string | null;
    /** Nom à afficher quand il diffère de la valeur (dossier Drive). */
    n?: string;
    v: number;
    c: number;
    children?: Node[];
    bricks?: Brick[];
    rest?: { c: number; v: number };
  }

  /** Bloc qui contient une brique : son chemin depuis la racine affichée et ses totaux. */
  export interface Block {
    path: string[];
    v: number;
    c: number;
  }
</script>

<script lang="ts">
  import { TreemapChart } from 'echarts/charts';
  import * as echarts from 'echarts/core';
  import { CanvasRenderer } from 'echarts/renderers';
  import { cushion } from './lib/cushion';

  echarts.use([TreemapChart, CanvasRenderer]);

  let {
    tree,
    nameOf = (_depth: number, key: string) => key,
    colors,
    selected = new Set<string>(),
    failed = new Set<string>(),
    hatched = false,
    unit = 'conversations',
    label = 'Treemap',
    onbrick,
    onzoom,
  }: {
    tree: Node;
    /** Nom affiché d'un bloc, selon sa profondeur depuis la racine affichée. */
    nameOf?: (depth: number, key: string) => string;
    /** Variable CSS de couleur pour chaque clé de brique. */
    colors: Record<string, string>;
    selected?: Set<string>;
    /** Briques dont le dernier traitement a échoué : encadrées de rouge. */
    failed?: Set<string>;
    hatched?: boolean;
    unit?: string;
    label?: string;
    onbrick?: (brick: Brick, block: Block, additive: boolean) => void;
    onzoom?: (path: string[]) => void;
  } = $props();

  interface Item {
    name: string;
    value: number;
    path?: string[];
    brick?: Brick;
    block?: Block;
    children?: Item[];
    itemStyle?: object;
    label?: object;
  }

  let container: HTMLDivElement;
  let chart: echarts.ECharts | undefined;
  let theme = $state(0);
  let shown: Node | undefined;

  $effect(() => {
    const instance = echarts.init(container);
    chart = instance;
    instance.on('click', (params) => {
      const item = params.data as Item | undefined;
      const mouse = (params.event?.event ?? {}) as MouseEvent;
      if (item?.brick && item.block) onbrick?.(item.brick, item.block, mouse.ctrlKey || mouse.metaKey);
      else if (item?.path) onzoom?.(item.path);
    });
    instance.on('dblclick', (params) => {
      const item = params.data as Item | undefined;
      const first = item?.block?.path[0];
      if (first !== undefined) onzoom?.([first]);
    });
    const observer = new ResizeObserver(() => instance.resize());
    observer.observe(container);
    const scheme = window.matchMedia('(prefers-color-scheme: dark)');
    const onscheme = () => theme++;
    scheme.addEventListener('change', onscheme);
    // Le canevas dessine avec les polices déjà chargées : on redessine une fois qu'elles le sont toutes.
    document.fonts?.ready.then(onscheme);
    return () => {
      scheme.removeEventListener('change', onscheme);
      observer.disconnect();
      instance.dispose();
      chart = undefined;
    };
  });

  $effect(() => {
    void theme;
    if (!chart) return;
    const css = getComputedStyle(container);
    const color = (name: string) => css.getPropertyValue(name).trim();
    const tray = color('--tray');
    const tray2 = color('--tray-2');
    const trayInk = color('--tray-ink');
    const hatch = hatched
      ? { decal: { symbol: 'rect', color: 'rgba(255,255,255,0.45)', dashArrayX: [1, 0], dashArrayY: [3, 5], rotation: -Math.PI / 4 } }
      : {};
    const merged = { color: tray2, borderColor: tray2 };
    const mergedLabel = { show: true, color: trayInk, fontSize: 11, overflow: 'truncate' };
    const display = css.getPropertyValue('--f-display').trim();
    const mono = css.getPropertyValue('--f-mono').trim();
    let depthMax = 0;

    const build = (node: Node, depth: number, path: string[]): Item[] => {
      const items: Item[] = [];
      if (node.children) {
        depthMax = Math.max(depthMax, depth + 1);
        for (const child of node.children) {
          if (child.k === null) {
            items.push({ name: `Autres blocs · ${child.c.toLocaleString('fr-FR')} ${unit}`, value: child.v, itemStyle: merged, label: mergedLabel });
            continue;
          }
          const childPath = [...path, child.k];
          items.push({
            name: child.n ?? nameOf(depth, child.k),
            value: child.v,
            path: childPath,
            itemStyle: merged,
            children: build(child, depth + 1, childPath),
          });
        }
      }
      const block: Block = { path, v: node.v, c: node.c };
      for (const brick of node.bricks ?? []) {
        items.push({
          name: '',
          value: brick.v,
          brick,
          block,
          itemStyle: {
            color: cushion(color(colors[brick.t] ?? '--t-none')),
            ...hatch,
            ...(failed.has(brick.id)
              ? { borderColor: color('--danger'), borderWidth: 2 }
              : selected.has(brick.id)
                ? { borderColor: '#ffffff', borderWidth: 2 }
                : {}),
          },
        });
      }
      if (node.rest && node.rest.v > 0) {
        items.push({
          name: `${node.rest.c.toLocaleString('fr-FR')} plus petit${node.rest.c > 1 ? 's' : ''}`,
          value: node.rest.v,
          itemStyle: merged,
          label: mergedLabel,
        });
      }
      return items;
    };

    const data = build(tree, 0, []);
    // Nouvelle vue (scan, zoom, filtre) : le plateau arrive avec un léger rebond ; une simple sélection ne rejoue rien.
    if (tree !== shown) {
      shown = tree;
      if (!matchMedia('(prefers-reduced-motion: reduce)').matches)
        container.animate([{ opacity: 0.35, transform: 'scale(0.985)' }, { opacity: 1, transform: 'none' }], {
          duration: 480,
          easing: 'cubic-bezier(0.34, 1.4, 0.5, 1)',
        });
    }
    // Sans cette remise à zéro, les en-têtes de la vue précédente restent dessinés par-dessus la nouvelle.
    chart.clear();
    chart.setOption(
      {
        animation: false,
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
            visibleMin: 4,
            childrenVisibleMin: 60,
            label: { show: false },
            upperLabel: { show: true, height: 13, color: trayInk, fontSize: 10, fontFamily: mono },
            emphasis: { disabled: true },
            itemStyle: { color: tray, borderColor: tray, borderWidth: 0, gapWidth: 1 },
            levels: [
              { itemStyle: { borderWidth: 0, gapWidth: 2 } },
              ...Array.from({ length: depthMax }, (_, depth) => ({
                itemStyle: { borderColor: tray2, borderWidth: 1, gapWidth: 1 },
                // Premier niveau : étiquette en pastille jaune postal, lisible sur le plateau.
                upperLabel:
                  depth === 0
                    ? {
                        height: 21,
                        formatter: '{pill|{b}}',
                        rich: {
                          pill: {
                            color: color('--on-stamp'),
                            backgroundColor: color('--stamp'),
                            borderRadius: 9,
                            padding: [3, 7, 2, 7],
                            fontSize: 11,
                            fontWeight: 800,
                            fontFamily: display,
                          },
                        },
                      }
                    : {},
              })),
            ],
            data,
          },
        ],
      },
      true,
    );
  });
</script>

<div class="treemap" bind:this={container} role="img" aria-label={label}></div>

<style>
  .treemap {
    width: 100%;
    height: 100%;
    cursor: pointer;
    background: var(--tray);
  }
</style>
