/** Arbre du treemap, commun à Gmail et à Drive : des blocs emboîtés, puis une brique par élément. */

export interface TreeBrick {
  /** Identifiant de l'élément (conversation, fichier). */
  id: string;
  v: number;
  /** Clé de couleur : type de la plus grosse pièce jointe, type du fichier. */
  t: string;
}

export interface TreeNode {
  /** Valeur du bloc ; null pour un regroupement « autres ». */
  k: string | null;
  /** Nom à afficher quand il diffère de la valeur (dossier Drive). */
  n?: string;
  v: number;
  /** Nombre d'éléments. */
  c: number;
  children?: TreeNode[];
  bricks?: TreeBrick[];
  /** Éléments trop petits pour avoir leur brique : nombre et taille cumulée. */
  rest?: { c: number; v: number };
}

// Au-delà, le navigateur peine : les plus petites briques sont fondues dans leur bloc, les plus petits blocs en « autres ».
export const MAX_BRICKS = 4000;
const MAX_CHILDREN = 80;

interface Group {
  v: number;
  c: number;
  children: Map<string, Group>;
  bricks: TreeBrick[];
  restCount: number;
  restSize: number;
}
const newGroup = (): Group => ({ v: 0, c: 0, children: new Map(), bricks: [], restCount: 0, restSize: 0 });

/**
 * Construit l'arbre à partir d'éléments fournis par taille décroissante : les premiers ont leur brique,
 * les suivants sont fondus dans leur bloc. La somme des feuilles égale toujours le total.
 */
export class TreeBuilder {
  readonly #root = newGroup();
  #rank = 0;

  /** Ajoute un élément sous la suite de blocs `keys` (vide : directement à la racine). */
  add(keys: string[], brick: TreeBrick): void {
    let group = this.#root;
    group.v += brick.v;
    group.c++;
    for (const key of keys) {
      let child = group.children.get(key);
      if (!child) group.children.set(key, (child = newGroup()));
      child.v += brick.v;
      child.c++;
      group = child;
    }
    if (brick.v > 0 && this.#rank++ < MAX_BRICKS) group.bricks.push(brick);
    else {
      group.restCount++;
      group.restSize += brick.v;
    }
  }

  build(nameOf?: (key: string) => string | undefined): TreeNode {
    return toNode(null, this.#root, nameOf);
  }
}

function toNode(key: string | null, group: Group, nameOf?: (key: string) => string | undefined): TreeNode {
  const node: TreeNode = { k: key, v: group.v, c: group.c };
  const name = key !== null ? nameOf?.(key) : undefined;
  if (name !== undefined) node.n = name;
  if (group.children.size > 0) {
    const sorted = [...group.children].sort((a, b) => b[1].v - a[1].v);
    node.children = sorted.slice(0, MAX_CHILDREN).map(([childKey, child]) => toNode(childKey, child, nameOf));
    const others = sorted.slice(MAX_CHILDREN);
    if (others.length > 0) {
      node.children.push({
        k: null,
        v: others.reduce((sum, [, child]) => sum + child.v, 0),
        c: others.reduce((sum, [, child]) => sum + child.c, 0),
      });
    }
  }
  // Un dossier peut contenir à la fois des sous-dossiers et des fichiers : ses fichiers restent ses briques.
  if (group.bricks.length > 0 || group.children.size === 0) node.bricks = group.bricks;
  if (group.restCount > 0) node.rest = { c: group.restCount, v: group.restSize };
  return node;
}
