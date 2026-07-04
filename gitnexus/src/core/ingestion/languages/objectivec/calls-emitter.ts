/**
 * OC cross-file CALLS edge emitter — post-resolution graph-level synthesis
 * for Objective-C `message_expression` call sites.
 *
 * The standard `emitReceiverBoundCalls` pass resolves receiver types through
 * scope-resolution bindings and walks the MRO chain (DefId-based) to find
 * the target method. For OC, this path is incomplete because:
 *
 *   1. OC `#import` is `wildcard-transitive` — `interpretCImport` returns
 *      `{ kind: 'wildcard', targetRaw: ... }`, and `expandsWildcardTo`
 *      returns `[]`. The finalize phase therefore creates NO BindingRefs
 *      for the imported file's class names, so `findClassBindingInScope`
 *      cannot find superclass names in the importing file's scope.
 *
 *   2. The MRO chain (`buildMro`) translates graph node IDs to scope-resolution
 *      DefIds via `defIdByGraphId`, which is built from `parsedFiles.localDefs`.
 *      Pod/framework class stub nodes (created by the heritage-emitter) are
 *      NOT in `parsedFiles.localDefs`, so the MRO chain stops at the first
 *      stub ancestor. Methods defined on further ancestors (e.g.,
 *      `UIViewController`'s `pushPageViewWithID:withTitle:params:`) are
 *      unreachable.
 *
 * This emitter fills those gaps:
 *
 *   - Builds a `classGraphId → {methodName → methodGraphId}` index from
 *     HAS_METHOD edges, so all methods are findable regardless of whether
 *     their owning class is in `parsedFiles.localDefs`.
 *
 *   - Walks the graph-level EXTENDS chain (bypassing the DefId-based MRO)
 *     to find methods on ancestor classes, including stub nodes.
 *
 *   - For `self` receivers, resolves the enclosing class via the scope chain
 *     (using `scopeTree.getScope` which works even after disk sealing).
 *
 *   - For class-name receivers (e.g., `[MyClass classMethod]`), resolves
 *     the class name against graph Class nodes.
 *
 * Runs as `emitPostResolutionEdges` in the scope-resolver, after all
 * standard edge emission passes. Deduplicates against existing CALLS edges.
 */

import type { ParsedFile, ScopeId } from 'gitnexus-shared';
import { generateId } from '../../../../lib/utils.js';
import {
  resolveDefGraphId,
  resolveCallerGraphId,
} from '../../scope-resolution/graph-bridge/ids.js';
import type { GraphNodeLookup } from '../../scope-resolution/graph-bridge/node-lookup.js';
import type { KnowledgeGraph } from '../../../graph/types.js';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import { logger } from '../../../logger.js';

/** Class-like labels that can own methods via HAS_METHOD edges. */
const CLASS_LIKE = new Set<string>(['Class', 'Interface', 'Struct', 'Enum', 'Trait', 'Record']);

/** A method discoverable via a HAS_METHOD edge, keyed by graph node ID. */
interface MethodInfo {
  readonly graphId: string;
  readonly filePath: string | undefined;
}

/** Statistics returned by {@link emitObjCCrossFileCalls} for telemetry. */
export interface ObjCCrossFileCallsResult {
  readonly edgesEmitted: number;
  readonly skippedNoReceiver: number;
  readonly skippedNoCaller: number;
  readonly skippedNoTarget: number;
  readonly skippedNoMethod: number;
  readonly skippedDuplicate: number;
}

/**
 * Emit OC cross-file CALLS edges for `message_expression` call sites that
 * the standard `emitReceiverBoundCalls` pass could not resolve because
 * the MRO chain is incomplete (stub nodes break the DefId-based chain).
 *
 * @param graph       The mutable graph to write edges into.
 * @param parsedFiles All OC files (scopes may be stripped after sealing).
 * @param nodeLookup  Maps `(filePath, qualifiedName)` → graph node ID.
 * @param indexes     Finalized scope-resolution indexes.
 * @returns           Emission statistics.
 */
export function emitObjCCrossFileCalls(
  graph: KnowledgeGraph,
  parsedFiles: readonly ParsedFile[],
  nodeLookup: GraphNodeLookup,
  indexes: ScopeResolutionIndexes,
): ObjCCrossFileCallsResult {
  // ── Step 1: Build class → methods map from HAS_METHOD edges ──────────
  // classGraphId → Map<methodName, MethodInfo>
  const methodsByClassGraphId = new Map<string, Map<string, MethodInfo>>();
  for (const rel of graph.iterRelationshipsByType('HAS_METHOD')) {
    const methodNode = graph.getNode(rel.targetId);
    if (methodNode === undefined) continue;
    const methodName = methodNode.properties?.name;
    if (methodName === undefined || methodName === '') continue;

    let methods = methodsByClassGraphId.get(rel.sourceId);
    if (methods === undefined) {
      methods = new Map<string, MethodInfo>();
      methodsByClassGraphId.set(rel.sourceId, methods);
    }
    // First-seen wins for duplicate declarations (.h + .m)
    if (!methods.has(methodName)) {
      methods.set(methodName, {
        graphId: rel.targetId,
        filePath: methodNode.properties?.filePath,
      });
    }
  }

  // ── Step 2: Build EXTENDS chain (graph-level, bypasses DefId MRO) ────
  // classGraphId → [parentGraphId]
  const parentsByGraphId = new Map<string, string[]>();
  for (const rel of graph.iterRelationshipsByType('EXTENDS')) {
    let parents = parentsByGraphId.get(rel.sourceId);
    if (parents === undefined) {
      parents = [];
      parentsByGraphId.set(rel.sourceId, parents);
    }
    parents.push(rel.targetId);
  }

  // ── Step 3: Build class name → graphId map (from graph nodes) ────────
  // Prefer real nodes over stub nodes. Ambiguous names → null (skip).
  const graphIdByClassName = new Map<string, string | null>();
  for (const node of graph.iterNodes()) {
    if (!CLASS_LIKE.has(node.label)) continue;
    const name = node.properties?.name;
    if (name === undefined || name === '') continue;

    const existing = graphIdByClassName.get(name);
    if (existing === undefined) {
      graphIdByClassName.set(name, node.id);
    } else if (existing !== null) {
      const existingNode = graph.getNode(existing);
      const existingIsStub = existingNode?.properties?.stub === 'true';
      const newIsStub = node.properties?.stub === 'true';
      if (existingIsStub && !newIsStub) {
        // Replace stub with real node
        graphIdByClassName.set(name, node.id);
      } else if (!existingIsStub && newIsStub) {
        // Keep existing real node, ignore stub
      } else {
        // Both real or both stub — ambiguous, mark as skip
        graphIdByClassName.set(name, null);
      }
    }
  }

  // ── Step 4: Pre-seed existing CALLS edges for dedup ──────────────────
  const emitted = new Set<string>();
  for (const rel of graph.iterRelationshipsByType('CALLS')) {
    emitted.add(`${rel.sourceId}->${rel.targetId}`);
  }

  // ── Diagnostic: graphIdByClassName map size (#2367 OC CALLS regression) ─
  let classLikeNodeCount = 0;
  for (const node of graph.iterNodes()) {
    if (CLASS_LIKE.has(node.label)) classLikeNodeCount++;
  }
  logger.info(
    `[oc-calls] graphIdByClassName.size=${graphIdByClassName.size} classLikeNodes=${classLikeNodeCount}`,
  );

  // ── Step 5: Process message_expression reference sites ────────────────
  let edgesEmitted = 0;
  let skippedNoReceiver = 0;
  let skippedNoCaller = 0;
  let skippedNoTarget = 0;
  let skippedNoMethod = 0;
  let skippedDuplicate = 0;
  const missingTargetNames = new Map<string, number>();

  for (const parsed of parsedFiles) {
    for (const site of parsed.referenceSites) {
      // Only process member-call sites (message_expression)
      if (site.kind !== 'call') continue;
      if (site.callForm !== 'member') continue;

      const receiverName = site.explicitReceiver?.name;
      if (receiverName === undefined || receiverName === '') {
        skippedNoReceiver++;
        continue;
      }

      const methodName = site.name;
      if (methodName === undefined || methodName === '') continue;

      // ── Find the caller method via scope chain ────────────────────
      const callerMethodGraphId = resolveCallerGraphId(
        site.inScope,
        indexes,
        nodeLookup,
        site.atRange,
      );
      if (callerMethodGraphId === undefined) {
        skippedNoCaller++;
        continue;
      }

      // ── Resolve receiver to a class graphId ───────────────────────
      let targetClassGraphId: string | undefined;

      if (receiverName === 'self') {
        // Find enclosing class via scope chain walk
        targetClassGraphId = findEnclosingClassGraphId(
          site.inScope,
          indexes,
          parsed.filePath,
          nodeLookup,
        );
      } else if (receiverName === 'super') {
        // super → find enclosing class, then start from its parent
        const enclosingClassId = findEnclosingClassGraphId(
          site.inScope,
          indexes,
          parsed.filePath,
          nodeLookup,
        );
        if (enclosingClassId !== undefined) {
          const parents = parentsByGraphId.get(enclosingClassId);
          // For super, walk the EXTENDS chain starting from the first parent
          // (skipping self). The walkExtendsChainForMethod already BFS-walks
          // the chain, so we just need to start from the parent.
          if (parents !== undefined && parents.length > 0) {
            // Walk each parent's chain to find the method
            for (const parentId of parents) {
              const methodInfo = walkExtendsChainForMethod(
                parentId,
                methodName,
                methodsByClassGraphId,
                parentsByGraphId,
              );
              if (methodInfo !== undefined) {
                targetClassGraphId = parentId;
                break;
              }
            }
          }
        }
        if (targetClassGraphId === undefined) {
          skippedNoTarget++;
          continue;
        }
        // We've already found the method above — skip the normal chain walk
        const superMethodInfo = walkExtendsChainForMethod(
          targetClassGraphId,
          methodName,
          methodsByClassGraphId,
          parentsByGraphId,
        );
        if (superMethodInfo === undefined) {
          skippedNoMethod++;
          continue;
        }
        if (callerMethodGraphId === superMethodInfo.graphId) continue;
        const superEdgeKey = `${callerMethodGraphId}->${superMethodInfo.graphId}`;
        if (emitted.has(superEdgeKey)) {
          skippedDuplicate++;
          continue;
        }
        emitted.add(superEdgeKey);

        const superCallerFile = parsed.filePath;
        const superTargetFile = superMethodInfo.filePath;
        const superIsCrossFile = superCallerFile !== superTargetFile;

        graph.addRelationship({
          id: generateId('CALLS', superEdgeKey),
          sourceId: callerMethodGraphId,
          targetId: superMethodInfo.graphId,
          type: 'CALLS',
          confidence: superIsCrossFile ? 0.70 : 0.85,
          reason: superIsCrossFile
            ? `objc-calls: [super ${methodName}] (cross-file via EXTENDS)`
            : `objc-calls: [super ${methodName}]`,
        });
        edgesEmitted++;
        continue;
      } else {
        // Try class name lookup in graph nodes
        const id = graphIdByClassName.get(receiverName);
        if (id === undefined || id === null) {
          skippedNoTarget++;
          missingTargetNames.set(receiverName, (missingTargetNames.get(receiverName) ?? 0) + 1);
          continue;
        }
        targetClassGraphId = id;
      }

      if (targetClassGraphId === undefined) {
        skippedNoTarget++;
        continue;
      }

      // ── Walk EXTENDS chain to find the method ─────────────────────
      const targetMethodInfo = walkExtendsChainForMethod(
        targetClassGraphId,
        methodName,
        methodsByClassGraphId,
        parentsByGraphId,
      );
      if (targetMethodInfo === undefined) {
        skippedNoMethod++;
        continue;
      }

      // Skip self-calls (caller method IS the target method)
      if (callerMethodGraphId === targetMethodInfo.graphId) continue;

      // ── Dedup ─────────────────────────────────────────────────────
      const edgeKey = `${callerMethodGraphId}->${targetMethodInfo.graphId}`;
      if (emitted.has(edgeKey)) {
        skippedDuplicate++;
        continue;
      }
      emitted.add(edgeKey);

      // ── Emit CALLS edge ───────────────────────────────────────────
      const callerFile = parsed.filePath;
      const targetFile = targetMethodInfo.filePath;
      const isCrossFile = callerFile !== targetFile;

      graph.addRelationship({
        id: generateId('CALLS', edgeKey),
        sourceId: callerMethodGraphId,
        targetId: targetMethodInfo.graphId,
        type: 'CALLS',
        confidence: isCrossFile ? 0.70 : 0.85,
        reason: isCrossFile
          ? `objc-calls: [${receiverName} ${methodName}] (cross-file via EXTENDS)`
          : `objc-calls: [${receiverName} ${methodName}]`,
      });
      edgesEmitted++;
    }
  }

  const topMissing = [...missingTargetNames.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([name, cnt]) => `${name}(${cnt})`)
    .join(' ');
  logger.info(
    `[oc-calls] missingTarget distinct=${missingTargetNames.size} top20=${topMissing}`,
  );

  return {
    edgesEmitted,
    skippedNoReceiver,
    skippedNoCaller,
    skippedNoTarget,
    skippedNoMethod,
    skippedDuplicate,
  };
}

/**
 * Walk the EXTENDS chain (BFS) to find a method by name.
 *
 * Starts from `startClassGraphId` and walks the EXTENDS edges breadth-first,
 * checking each class's HAS_METHOD map for the target method name.
 *
 * Returns the first match (most-derived class wins, as in BFS order).
 */
function walkExtendsChainForMethod(
  startClassGraphId: string,
  methodName: string,
  methodsByClassGraphId: ReadonlyMap<string, ReadonlyMap<string, MethodInfo>>,
  parentsByGraphId: ReadonlyMap<string, readonly string[]>,
): MethodInfo | undefined {
  const visited = new Set<string>();
  const queue: string[] = [startClassGraphId];

  while (queue.length > 0) {
    const classId = queue.shift()!;
    if (visited.has(classId)) continue;
    visited.add(classId);

    // Check this class's methods
    const methods = methodsByClassGraphId.get(classId);
    if (methods !== undefined) {
      const methodInfo = methods.get(methodName);
      if (methodInfo !== undefined) return methodInfo;
    }

    // Enqueue parent classes
    const parents = parentsByGraphId.get(classId);
    if (parents !== undefined) {
      for (const parentId of parents) {
        if (!visited.has(parentId)) {
          queue.push(parentId);
        }
      }
    }
  }

  return undefined;
}

/**
 * Walk the scope chain upward from `startScope` to find the innermost
 * Class scope, then resolve its class-like def to a graph node ID.
 *
 * Uses `scopeTree.getScope` which works even after disk sealing.
 *
 * @returns Graph node ID of the enclosing class, or `undefined`.
 */
function findEnclosingClassGraphId(
  startScope: ScopeId,
  scopes: ScopeResolutionIndexes,
  filePath: string,
  nodeLookup: GraphNodeLookup,
): string | undefined {
  let current: ScopeId | null = startScope;
  const visited = new Set<ScopeId>();

  while (current !== null) {
    if (visited.has(current)) return undefined;
    visited.add(current);

    const scope = scopes.scopeTree.getScope(current);
    if (scope === undefined) break;

    if (scope.kind === 'Class') {
      const classDef = scope.ownedDefs.find((d) => CLASS_LIKE.has(d.type));
      if (classDef !== undefined) {
        return resolveDefGraphId(filePath, classDef, nodeLookup);
      }
    }

    current = scope.parent;
  }

  return undefined;
}
