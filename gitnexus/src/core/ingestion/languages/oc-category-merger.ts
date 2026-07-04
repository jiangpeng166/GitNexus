/**
 * OC Category merger — post-processing step that collapses duplicate Class
 * nodes created by Objective-C Category files and .h/.m file splits, and
 * links each preserved Category node to its base class via HAS_CATEGORY.
 *
 * In OC, a single class is spread across multiple files:
 *   - Foo.h  — @interface Foo : Parent
 *   - Foo.m  — @implementation Foo
 *   - Foo+Bar.h — @interface Foo (Bar)
 *   - Foo+Bar.m — @implementation Foo (Bar)
 *
 * Each file creates a separate Class node (generateId includes the file
 * path). This merger picks the .m implementation node as canonical and
 * redirects all edges from duplicate base nodes to the primary, then
 * removes the duplicates. Category nodes (Foo+Bar.*) are PRESERVED as
 * independent Class nodes so their methods keep the correct owner, and
 * the base class links to each via a HAS_CATEGORY edge. Without this,
 * impact() returns ambiguous and context() shows empty incoming for OC
 * classes spread across Category files, and every Category's methods
 * collapsed onto the base class losing the Category affiliation
 * (e.g. fznd_back → wrong owner UIViewController).
 */
import type { GraphNode, GraphRelationship, RelationshipType } from 'gitnexus-shared';
import { generateId } from '../../../lib/utils.js';
import { logger } from '../../logger.js';
import { isDev } from '../utils/env.js';
import type { KnowledgeGraph } from '../../graph/types.js';

/** Shape of an OC Class node captured for grouping during the merge pass. */
interface OCClassNodeRef {
  id: string;
  filePath: string;
  isCategory: boolean;
  name: string;
}

/** Per-node incoming/outgoing edge type index used for redirection. */
interface EdgeIndexEntry {
  /** targetId → set of relationship types pointing targetId-ward from this node. */
  outgoing: Map<string, Set<RelationshipType>>;
  /** sourceId → set of relationship types arriving at this node from sourceId. */
  incoming: Map<string, Set<RelationshipType>>;
}

/**
 * `HAS_CATEGORY` is an OC-specific relationship type introduced by this
 * merger; it is not yet a member of the shared `RelationshipType` union
 * (gitnexus-shared/src/graph/types.ts). Cast through the union so this file
 * compiles standalone today; once `HAS_CATEGORY` is added upstream the cast
 * becomes a no-op.
 */
const HAS_CATEGORY: RelationshipType = 'HAS_CATEGORY';

/**
 * Merge duplicate OC Class nodes in the graph.
 *
 * Walks all Class nodes, groups by className, selects a primary (.m >
 * .mm > .h, non-category preferred), redirects edges from secondary
 * BASE nodes to the primary, removes the duplicates, and links each
 * preserved CATEGORY node to the base primary with a HAS_CATEGORY edge.
 *
 * @param graph - the KnowledgeGraph to mutate in place.
 * @returns the number of duplicate base Class nodes collapsed.
 */
export function mergeOCCategories(graph: KnowledgeGraph): { mergedCount: number } {
  // ── 1. Collect OC Class nodes grouped by className ──
  const classGroups = new Map<string, OCClassNodeRef[]>();

  for (const node of graph.iterNodes()) {
    if (node.label !== 'Class') continue;
    const lang = node.properties?.language;
    if (lang !== 'objectivec') continue;

    const name = node.properties?.name;
    if (!name) continue;

    const filePath = node.properties?.filePath || '';
    const isCategory = /\+[^/]+\.(m|mm|h)$/.test(filePath);

    let group = classGroups.get(name);
    if (!group) {
      group = [];
      classGroups.set(name, group);
    }
    group.push({ id: node.id, filePath, isCategory, name });
  }

  // ── 2. For each group with duplicates, merge into primary ──
  let mergedCount = 0;

  // Build edge index once — shared across all groups
  const edgeIndex = buildEdgeIndex(graph);

  for (const [, nodes] of classGroups) {
    if (nodes.length <= 1) continue;

    // Only merge class nodes where the class name matches the file name.
    // Parent-class references (e.g. NSObject captured from @interface Foo : NSObject
    // in Foo.h) have the parent class name in a file that doesn't belong to them.
    // Merging these creates super-hubs that crash noverlap and blow up Safari memory.
    const realNodes = nodes.filter((n) => {
      const base = n.filePath.split('/').pop()!.replace(/\.[^.]+$/, '');
      const baseWithoutCategory = base.split('+')[0];
      return baseWithoutCategory === n.name;
    });
    if (realNodes.length <= 1) continue;

    // Strategy A (improvement #5): separate base nodes (Foo.h/Foo.m — same class
    // split across files) from Category nodes (Foo+Bar.* — distinct extension
    // units). Base nodes still merge into a single canonical node. Category nodes
    // are PRESERVED as independent Class nodes so their methods keep the correct
    // owner, and the base class links to each via a HAS_CATEGORY edge.
    const baseNodes = realNodes.filter((n) => !n.isCategory);
    const categoryNodes = realNodes.filter((n) => n.isCategory);

    if (baseNodes.length > 1) {
      const primary = selectPrimary(baseNodes);
      for (const node of baseNodes) {
        if (node.id === primary.id) continue;
        redirectEdges(graph, edgeIndex, node.id, primary.id);
        graph.removeNode(node.id);
        mergedCount++;
      }
    }

    // Link the canonical base class to each Category node. The base is a
    // surviving non-category node if one exists; otherwise fall back to the
    // highest-priority Category so Categories still connect to something.
    const basePrimary =
      baseNodes.length > 0 ? selectPrimary(baseNodes) : selectPrimary(categoryNodes);
    for (const cat of categoryNodes) {
      graph.addRelationship({
        id: generateId('HAS_CATEGORY', `${basePrimary.id}->${cat.id}`),
        sourceId: basePrimary.id,
        targetId: cat.id,
        type: HAS_CATEGORY,
        confidence: 1.0,
        reason: 'oc-category-link',
      });
    }
  }

  if (isDev && mergedCount > 0) {
    logger.info(`🔗 OC Category merge: ${mergedCount} duplicate Class node(s) collapsed`);
  }

  return { mergedCount };
}

// ─── Primary selection ──────────────────────────────────────────────────────

/**
 * Select the canonical primary node from a group of duplicate Class nodes.
 *
 * Priority (lower = higher priority):
 *   0 — .m  file, non-category
 *   1 — .mm file, non-category
 *   2 — .h  file, non-category
 *  50 — fallback (non-category, unknown extension)
 * 100 — Category file (any extension)
 */
function selectPrimary(nodes: OCClassNodeRef[]): OCClassNodeRef {
  const priority = (n: OCClassNodeRef): number => {
    if (n.isCategory) return 100;
    if (n.filePath.endsWith('.m')) return 0;
    if (n.filePath.endsWith('.mm')) return 1;
    if (n.filePath.endsWith('.h')) return 2;
    return 50;
  };

  nodes.sort((a, b) => priority(a) - priority(b));
  return nodes[0];
}

// ─── Edge index ─────────────────────────────────────────────────────────────

/**
 * Build a temporary node→edges index for efficient edge redirection.
 *
 * Returns Map<nodeId, EdgeIndexEntry>.
 */
function buildEdgeIndex(graph: KnowledgeGraph): Map<string, EdgeIndexEntry> {
  const index = new Map<string, EdgeIndexEntry>();

  const ensure = (nodeId: string): EdgeIndexEntry => {
    let entry = index.get(nodeId);
    if (!entry) {
      entry = { outgoing: new Map(), incoming: new Map() };
      index.set(nodeId, entry);
    }
    return entry;
  };

  for (const rel of graph.iterRelationships()) {
    const src = ensure(rel.sourceId);
    let srcTypes = src.outgoing.get(rel.targetId);
    if (!srcTypes) {
      srcTypes = new Set<RelationshipType>();
      src.outgoing.set(rel.targetId, srcTypes);
    }
    srcTypes.add(rel.type);

    const tgt = ensure(rel.targetId);
    let tgtTypes = tgt.incoming.get(rel.sourceId);
    if (!tgtTypes) {
      tgtTypes = new Set<RelationshipType>();
      tgt.incoming.set(rel.sourceId, tgtTypes);
    }
    tgtTypes.add(rel.type);
  }

  return index;
}

// ─── Edge redirection ───────────────────────────────────────────────────────

/**
 * Redirect all edges touching fromId to instead touch toId.
 *
 * addRelationship is idempotent (skips duplicate IDs), so multiple
 * Category nodes merging into the same primary naturally deduplicate
 * when they share the same target edge.
 */
function redirectEdges(
  graph: KnowledgeGraph,
  edgeIndex: Map<string, EdgeIndexEntry>,
  fromId: string,
  toId: string,
): void {
  const entry = edgeIndex.get(fromId);
  if (!entry) return;

  // Outgoing: fromId -> X  becomes  toId -> X
  for (const [targetId, types] of entry.outgoing) {
    for (const type of types) {
      const relationship: GraphRelationship = {
        id: generateId(type, `${toId}->${targetId}`),
        sourceId: toId,
        targetId,
        type,
        confidence: 1.0,
        reason: 'oc-category-merge',
      };
      graph.addRelationship(relationship);
    }
  }

  // Incoming: X -> fromId  becomes  X -> toId
  for (const [sourceId, types] of entry.incoming) {
    if (sourceId === fromId) continue;
    for (const type of types) {
      const relationship: GraphRelationship = {
        id: generateId(type, `${sourceId}->${toId}`),
        sourceId,
        targetId: toId,
        type,
        confidence: 1.0,
        reason: 'oc-category-merge',
      };
      graph.addRelationship(relationship);
    }
  }
}
