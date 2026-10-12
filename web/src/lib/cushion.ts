// Remplissage des briques de treemap pour ECharts.

/** Mélange deux couleurs hexadécimales : t = 0 donne a, t = 1 donne b. */
function mix(a: string, b: string, t: number): string {
  const rgb = (hex: string) => {
    const h = hex.replace('#', '');
    const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h;
    return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
  };
  const [x, y] = [rgb(a), rgb(b)];
  if (x.some(Number.isNaN) || y.some(Number.isNaN)) return a;
  return `rgb(${x.map((v, i) => Math.round(v + (y[i] - v) * t)).join(',')})`;
}

/**
 * Relief « coussin » à la WinDirStat : éclairé en haut à gauche, assombri sur les bords.
 * strength < 1 adoucit l'effet pour les très grands blocs.
 */
export function cushion(color: string, strength = 1) {
  return {
    type: 'radial',
    x: 0.32,
    y: 0.26,
    r: 1.05,
    colorStops: [
      { offset: 0, color: mix(color, '#ffffff', 0.4 * strength) },
      { offset: 0.42, color },
      { offset: 1, color: mix(color, '#000000', 0.45 * strength) },
    ],
  };
}
