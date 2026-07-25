/**
 * OC heritage-edge emitter — cross-file EXTENDS + IMPLEMENTS edges
 * for Objective-C class inheritance and protocol conformance.
 *
 * The standard `preEmitInheritanceEdges` (in run.js) handles `inherits`
 * reference sites by resolving them through scope-chain binding lookups.
 * For OC, this path is incomplete because:
 *
 *   1. OC `#import` is `wildcard-transitive` — `interpretCImport` returns
 *      `{ kind: 'wildcard', targetRaw: ... }`, and `expandsWildcardTo`
 *      returns `[]`. The finalize phase therefore creates NO BindingRefs
 *      for the imported file's class names, so `findClassBindingInScope`
 *      cannot find `FZBaseRootViewController` in the importing file's scope.
 *
 *   2. Many OC base classes (from Pods sub-projects, system SDK) are not
 *      indexed as Class nodes at all — their .h files are outside the
 *      analyzed workspace, so no Class def exists in `parsedFiles`.
 *
 * This emitter fills those gaps:
 *
 *   - For base classes that exist in the graph as Class nodes (e.g. from
 *     framework headers like `UIViewController+Hundsun.h`) but are not
 *     reachable via scope bindings, emit EXTENDS edges directly by
 *     matching the base name against all Class-like graph nodes.
 *
 *   - For base classes that do NOT exist in the graph (system SDK classes,
 *     Pod sub-project classes), create stub Class + File nodes and emit
 *     EXTENDS edges to them. Stub nodes carry `stub: true` so downstream
 *     tools can distinguish real definitions from inferred ones.
 *
 *   - For protocol references, emit IMPLEMENTS edges — the standard
 *     `preEmitInheritanceEdges` already handles these when the target
 *     resolves to an Interface kind, but this emitter provides a fallback
 *     for protocols not in the graph.
 *
 * Discriminates EXTENDS vs IMPLEMENTS by the reference site's context:
 *   - Superclass in `@interface` declaration → EXTENDS
 *   - Protocol in `<...>` conformance list → IMPLEMENTS
 *
 * The `inherits` site kind is unified — both class and protocol bases
 * arrive as `kind: 'inherits'`. Discrimination is based on the
 * `@reference.receiver` marker added in captures.js:
 *   - Protocol conformance sites carry `explicitReceiver: { name: 'protocol-conformance' }`
 *   - Superclass sites have no explicitReceiver (or a different one)
 *
 * For sites without the receiver marker, we fall back to the resolved
 * target's symbol kind: Interface/Trait → IMPLEMENTS, else → EXTENDS.
 * This mirrors the discriminator in `preEmitInheritanceEdges` (run.js).
 */

import { readFileSync } from 'fs';
import { basename, extname } from 'path';
import type { NodeLabel, ParsedFile, ReferenceSite, SymbolDefinition } from 'gitnexus-shared';
import { generateId } from '../../../../lib/utils.js';
import { resolveDefGraphId } from '../../scope-resolution/graph-bridge/ids.js';
import type { GraphNodeLookup } from '../../scope-resolution/graph-bridge/node-lookup.js';
import type { KnowledgeGraph } from '../../../graph/types.js';

/** Class-like labels that can be superclass targets of EXTENDS edges. */
const CLASS_LIKE = new Set<string>(['Class', 'Interface', 'Struct', 'Enum', 'Trait', 'Record']);

/** A class-like def from `parsedFiles` indexed by simple name. */
interface IndexedDef {
  readonly def: SymbolDefinition;
  readonly filePath: string;
  readonly graphId: string;
}

/** A Class/Interface graph node indexed by name, with its label. */
interface IndexedGraphNode {
  readonly graphId: string;
  readonly label: string;
}

/** A resolved base class/protocol target — graphId + the node label. */
interface ResolvedTarget {
  readonly graphId: string;
  readonly label: string;
}

/** Statistics returned by {@link emitObjCHeritageEdges} for telemetry. */
export interface ObjCHeritageResult {
  readonly stubsCreated: number;
  readonly edgesEmitted: number;
}

/**
 * Emit OC-specific heritage edges (EXTENDS for class inheritance,
 * IMPLEMENTS for protocol conformance) that the standard
 * `preEmitInheritanceEdges` cannot produce because OC's wildcard-transitive
 * imports don't create symbol bindings in the finalize phase.
 *
 * @param graph       The mutable graph to write edges into.
 * @param parsedFiles All OC files processed by scope-extraction.
 * @param nodeLookup  Maps `(filePath, qualifiedName)` → graph node ID.
 * @param headerPaths Optional set of all header file paths in the project
 *                    (used to complete transitive stub EXTENDS chains).
 */
export function emitObjCHeritageEdges(
  graph: KnowledgeGraph,
  parsedFiles: readonly ParsedFile[],
  nodeLookup: GraphNodeLookup,
  headerPaths?: ReadonlySet<string>,
): ObjCHeritageResult {
  // ── Step 1: Build Class → graphId index from parsedFiles ───────────────
  const defBySimpleName = new Map<string, IndexedDef[]>(); // simpleName → IndexedDef[]
  for (const parsed of parsedFiles) {
    for (const def of parsed.localDefs) {
      if (!CLASS_LIKE.has(def.type)) continue;
      const qn = def.qualifiedName ?? '';
      const simple = qn.includes('.') ? qn.slice(qn.lastIndexOf('.') + 1) : qn;
      if (simple === '') continue;
      const graphId = resolveDefGraphId(parsed.filePath, def, nodeLookup);
      if (graphId === undefined) continue;
      let list = defBySimpleName.get(simple);
      if (list === undefined) {
        list = [];
        defBySimpleName.set(simple, list);
      }
      list.push({ def, filePath: parsed.filePath, graphId });
    }
  }

  // ── Step 2: Build Class name → graphId index from existing graph nodes ──
  // This catches classes from framework headers and other sources that
  // are NOT in parsedFiles (e.g. UIViewController from .xcframework headers).
  const graphNodeByClassName = new Map<string, IndexedGraphNode[]>(); // className → IndexedGraphNode[]
  for (const node of graph.iterNodes()) {
    if (node.label !== 'Class' && node.label !== 'Interface') continue;
    const name = node.properties?.name;
    if (name === undefined || name === '') continue;
    let list = graphNodeByClassName.get(name);
    if (list === undefined) {
      list = [];
      graphNodeByClassName.set(name, list);
    }
    list.push({ graphId: node.id, label: node.label });
  }

  // ── Step 3: Pre-seed existing EXTENDS edges for dedup ───────────────────
  const emitted = new Set<string>();
  for (const rel of graph.iterRelationshipsByType('EXTENDS')) {
    emitted.add(`${rel.sourceId}->${rel.targetId}`);
  }
  for (const rel of graph.iterRelationshipsByType('IMPLEMENTS')) {
    emitted.add(`${rel.sourceId}->${rel.targetId}`);
  }

  // ── Step 4: Collect all inherits reference sites ─────────────────────────
  const inheritsSites: { readonly site: ReferenceSite; readonly filePath: string }[] = [];
  for (const parsed of parsedFiles) {
    for (const site of parsed.referenceSites) {
      if (site.kind !== 'inherits') continue;
      inheritsSites.push({ site, filePath: parsed.filePath });
    }
  }

  // ── Step 5: Resolve and emit heritage edges ─────────────────────────────
  let stubsCreated = 0;
  let edgesEmitted = 0;

  for (const { site, filePath } of inheritsSites) {
    const baseName = site.name;
    if (baseName === undefined || baseName === '') continue;

    // Find the deriving (child) class graphId.
    // The site.inScope should be inside a Class scope — walk up to find it.
    const childGraphId = findEnclosingClassGraphId(site, filePath, parsedFiles, nodeLookup);
    if (childGraphId === undefined) continue;

    // Discriminate EXTENDS vs IMPLEMENTS:
    // Protocol conformance sites carry explicitReceiver = 'protocol-conformance'
    // (set in captures.js emitProtocolReferences). Superclass sites have no such marker.
    const isProtocolSite = site.explicitReceiver?.name === 'protocol-conformance';

    // Try to find the base class/protocol graphId through multiple strategies.
    const targetInfo = resolveBaseTarget(baseName, defBySimpleName, graphNodeByClassName, graph);

    // Determine edge type based on protocol marker and resolved target label.
    //   - Protocol-conformance site → IMPLEMENTS
    //   - Target resolved as Interface/Trait → IMPLEMENTS
    //   - Otherwise → EXTENDS
    let edgeType: 'EXTENDS' | 'IMPLEMENTS';
    if (isProtocolSite) {
      edgeType = 'IMPLEMENTS';
    } else if (
      targetInfo !== undefined &&
      (targetInfo.label === 'Interface' || targetInfo.label === 'Trait')
    ) {
      edgeType = 'IMPLEMENTS';
    } else {
      edgeType = 'EXTENDS';
    }

    if (targetInfo === undefined) {
      // Base class/protocol not found anywhere — create stub node.
      // Use protocol-conformance marker to decide stub label:
      //   Protocol → Interface stub,  Class → Class stub
      const stubId = isProtocolSite
        ? createStubInterfaceNode(graph, baseName)
        : createStubClassNode(graph, baseName);
      stubsCreated++;
      emitHeritageEdgeWithType(graph, childGraphId, stubId, edgeType, baseName, emitted);
      edgesEmitted++;
      continue;
    }

    emitHeritageEdgeWithType(graph, childGraphId, targetInfo.graphId, edgeType, baseName, emitted);
    edgesEmitted++;
  }

  // ── Step 6: Complete transitive EXTENDS chains for stub nodes ──────────
  // Stub nodes are created for classes that are referenced in @interface
  // declarations but not in the graph (e.g., Pod sub-project classes).
  // These stubs have no EXTENDS edges to their own superclasses, which
  // breaks the MRO chain and prevents cross-file CALLS edge emission.
  //
  // This step scans the project's header files for each stub's @interface
  // declaration, extracts the superclass name, and creates transitive
  // EXTENDS edges. The process is recursive: if the superclass is also
  // not in the graph, another stub is created for it.
  const transitiveStubEdges = completeStubExtendsChains(
    graph,
    emitted,
    graphNodeByClassName,
    headerPaths,
  );
  edgesEmitted += transitiveStubEdges;
  stubsCreated += transitiveStubEdges > 0 ? 1 : 0; // approximate count

  return { stubsCreated, edgesEmitted };
}

/**
 * Find the graph node ID of the Class scope enclosing an inherits site.
 * Walks the parsedFiles' scopes to find the innermost Class scope,
 * then resolves its class-like def to a graph node ID.
 *
 * OC .h and .m files are parsed separately — the same class may appear
 * in both, but graph nodes are typically keyed by the .m file path.
 * When a .h file's Class def cannot be resolved via nodeLookup, we
 * fall back to searching all parsedFiles for the same class name and
 * try to resolve it from the .m file's Class def instead.
 */
function findEnclosingClassGraphId(
  site: ReferenceSite,
  filePath: string,
  parsedFiles: readonly ParsedFile[],
  nodeLookup: GraphNodeLookup,
): string | undefined {
  // Find the parsedFile for this filePath
  const parsed = parsedFiles.find((p) => p.filePath === filePath);
  if (parsed === undefined) return undefined;

  // Walk scopes to find the innermost Class scope containing the site
  let scopeId = site.inScope;
  const visited = new Set<string>();
  while (scopeId !== null) {
    if (visited.has(scopeId)) return undefined;
    visited.add(scopeId);
    const scope = parsed.scopes.find((s) => s.id === scopeId);
    if (scope === undefined) return undefined;
    if (scope.kind === 'Class') {
      // Found the enclosing Class scope — look for its class-like def
      const classDef = scope.ownedDefs.find((d) => CLASS_LIKE.has(d.type));
      if (classDef !== undefined) {
        // Try resolving from the same file first
        const graphId = resolveDefGraphId(filePath, classDef, nodeLookup);
        if (graphId !== undefined) return graphId;

        // Fallback: OC .h files share the same class with .m files,
        // but nodeLookup keys are typically from .m. Search across
        // all parsedFiles for a class with the same qualifiedName
        // and resolve from its .m file.
        //
        // `qualifiedName` is the canonical class name; some SymbolDefinition
        // records also carry a `name` field at runtime (it isn't part of the
        // shared interface), so read it defensively for parity with the JS.
        const className = classDef.qualifiedName ?? (classDef as SymbolDefinition & { name?: string }).name;
        if (className !== undefined) {
          for (const otherParsed of parsedFiles) {
            // Only try .m files (OC convention: @implementation is in .m)
            if (!otherParsed.filePath.endsWith('.m')) continue;
            for (const otherDef of otherParsed.localDefs) {
              if (!CLASS_LIKE.has(otherDef.type)) continue;
              const otherName = otherDef.qualifiedName ?? '';
              const otherSimple = otherName.includes('.')
                ? otherName.slice(otherName.lastIndexOf('.') + 1)
                : otherName;
              if (otherSimple === className) {
                const altGraphId = resolveDefGraphId(otherParsed.filePath, otherDef, nodeLookup);
                if (altGraphId !== undefined) return altGraphId;
              }
            }
          }
        }
      }
    }
    scopeId = scope.parent;
  }
  return undefined;
}

/**
 * Resolve a base class/protocol name to a graph node ID.
 * Tries multiple strategies in order:
 *
 *   1. parsedFiles' localDefs (scope-resolution index)
 *   2. Existing graph Class/Interface nodes (covers framework headers)
 *   3. Returns undefined if not found anywhere
 */
function resolveBaseTarget(
  baseName: string,
  defBySimpleName: ReadonlyMap<string, readonly IndexedDef[]>,
  graphNodeByClassName: ReadonlyMap<string, readonly IndexedGraphNode[]>,
  graph: KnowledgeGraph,
): ResolvedTarget | undefined {
  // Strategy 1: Look in parsedFiles' Class defs (single-match only)
  const defs = defBySimpleName.get(baseName);
  if (defs !== undefined && defs.length === 1) {
    return { graphId: defs[0].graphId, label: defs[0].def.type };
  }
  // For multiple defs with the same name, we can't pick — skip here;
  // the standard preEmitInheritanceEdges already tried disambiguation.

  // Strategy 2: Look in existing graph nodes (covers framework headers,
  // Pod .h files that are indexed but not scope-extracted)
  const graphNodes = graphNodeByClassName.get(baseName);
  if (graphNodes !== undefined && graphNodes.length === 1) {
    return { graphId: graphNodes[0].graphId, label: graphNodes[0].label };
  }
  // Multiple graph nodes with the same name — try to pick the most
  // relevant one: prefer nodes from the project (not from frameworks)
  if (graphNodes !== undefined && graphNodes.length > 1) {
    // Prefer the one whose filePath is NOT inside a .framework or xcframework
    const projectNode = graphNodes.find((n) => {
      const node = graph.getNode(n.graphId);
      const fp = node?.properties?.filePath;
      return fp !== undefined && !fp.includes('.framework/') && !fp.includes('.xcframework/');
    });
    if (projectNode !== undefined) {
      return { graphId: projectNode.graphId, label: projectNode.label };
    }
    // Fall back: pick the first one (framework header) — better than nothing
    return { graphId: graphNodes[0].graphId, label: graphNodes[0].label };
  }

  // Strategy 3: Not found — will create stub
  return undefined;
}

/**
 * Create a stub Interface node for an OC protocol that doesn't exist in the graph.
 * Stub nodes carry `stub: 'true'` and `filePath: 'objc-stubs/<ProtocolName>.h'`
 * so downstream tools can distinguish them from real definitions.
 */
function createStubInterfaceNode(graph: KnowledgeGraph, protocolName: string): string {
  const stubId = generateId('Interface', `objc-stubs/${protocolName}`);
  // Check if stub already exists (idempotent)
  const existing = graph.getNode(stubId);
  if (existing !== undefined) return stubId;

  // Create a virtual File node to host the stub interface
  const stubFileId = generateId('File', `objc-stubs/${protocolName}.h`);
  const existingFile = graph.getNode(stubFileId);
  if (existingFile === undefined) {
    graph.addNode({
      id: stubFileId,
      label: 'File',
      properties: {
        name: `objc-stubs/${protocolName}.h`,
        filePath: `objc-stubs/${protocolName}.h`,
        stub: 'true',
        language: 'ObjectiveC',
      },
    });
    graph.addRelationship({
      id: generateId('CONTAINS', `${stubFileId}->${stubId}`),
      sourceId: stubFileId,
      targetId: stubId,
      type: 'CONTAINS',
      confidence: 1.0,
      reason: 'objc-heritage-stub',
    });
  }

  graph.addNode({
    id: stubId,
    label: 'Interface',
    properties: {
      name: protocolName,
      filePath: `objc-stubs/${protocolName}.h`,
      stub: 'true',
    },
  });

  return stubId;
}

/**
 * Create a stub Class node for a base class that doesn't exist in the graph.
 * Stub nodes carry `stub: 'true'` and `filePath: 'objc-stubs/<ClassName>.h'`
 * so downstream tools can distinguish them from real definitions.
 */
function createStubClassNode(graph: KnowledgeGraph, className: string): string {
  const stubId = generateId('Class', `objc-stubs/${className}`);
  // Check if stub already exists (idempotent)
  const existing = graph.getNode(stubId);
  if (existing !== undefined) return stubId;

  // Create a virtual File node to host the stub class
  const stubFileId = generateId('File', `objc-stubs/${className}.h`);
  const existingFile = graph.getNode(stubFileId);
  if (existingFile === undefined) {
    graph.addNode({
      id: stubFileId,
      label: 'File',
      properties: {
        name: `objc-stubs/${className}.h`,
        filePath: `objc-stubs/${className}.h`,
        stub: 'true',
        language: 'ObjectiveC',
      },
    });
    // CONTAINS edge: File → Class
    graph.addRelationship({
      id: generateId('CONTAINS', `${stubFileId}->${stubId}`),
      sourceId: stubFileId,
      targetId: stubId,
      type: 'CONTAINS',
      confidence: 1.0,
      reason: 'objc-heritage-stub',
    });
  }

  graph.addNode({
    id: stubId,
    label: 'Class',
    properties: {
      name: className,
      filePath: `objc-stubs/${className}.h`,
      stub: 'true',
    },
  });

  return stubId;
}

/**
 * Complete transitive EXTENDS chains for stub Class nodes by scanning
 * the project's header files for each stub's @interface declaration.
 *
 * When a stub like `FZBaseNavViewController` is created, this function:
 *   1. Finds the stub's header file (e.g., `FZBaseNavViewController.h`)
 *      in the project's header paths.
 *   2. Reads the header file and extracts the superclass name from the
 *      `@interface ClassName : SuperClass` declaration.
 *   3. If the superclass is not in the graph, creates a stub for it.
 *   4. Creates an EXTENDS edge from the stub to the superclass/stub.
 *   5. Recurses to complete the chain for the superclass stub.
 *
 * @returns The number of edges emitted.
 */
function completeStubExtendsChains(
  graph: KnowledgeGraph,
  emitted: Set<string>,
  _graphNodeByClassName: ReadonlyMap<string, readonly IndexedGraphNode[]>,
  headerPaths?: ReadonlySet<string>,
): number {
  if (headerPaths === undefined || headerPaths.size === 0) return 0;

  // Build a fast lookup: headerBaseName → fullPath
  const headerByBaseName = new Map<string, string>();
  for (const h of headerPaths) {
    const base = basename(h);
    // Only index .h files (not .hpp, etc.)
    if (extname(base) === '.h') {
      // Prefer the first path found; for duplicate names this is good enough
      if (!headerByBaseName.has(base)) {
        headerByBaseName.set(base, h);
      }
    }
  }

  // Collect all stub Class nodes
  const stubNodes: { readonly graphId: string; readonly name: string }[] = [];
  for (const node of graph.iterNodes()) {
    if (node.label !== 'Class') continue;
    if (node.properties?.stub !== 'true') continue;
    const name = node.properties?.name;
    if (name === undefined || name === '') continue;
    stubNodes.push({ graphId: node.id, name });
  }

  if (stubNodes.length === 0) return 0;

  // Build a reverse index: className → graphId (from graph nodes, updated as we create stubs)
  const graphIdByName = new Map<string, string>();
  for (const node of graph.iterNodes()) {
    if (node.label !== 'Class' && node.label !== 'Interface') continue;
    const name = node.properties?.name;
    if (name === undefined || name === '') continue;
    if (!graphIdByName.has(name)) {
      graphIdByName.set(name, node.id);
    }
  }

  let edgesEmitted = 0;
  const processed = new Set<string>(); // stub names already processed

  for (const stub of stubNodes) {
    if (processed.has(stub.name)) continue;
    processed.add(stub.name);

    // Find the stub's header file
    const headerFileName = `${stub.name}.h`;
    const headerPath = headerByBaseName.get(headerFileName);
    if (headerPath === undefined) continue;

    // Read the header file and extract the superclass
    let headerContent: string;
    try {
      headerContent = readFileSync(headerPath, 'utf-8');
    } catch {
      continue;
    }

    const superclassName = extractSuperclassNameFromHeader(headerContent, stub.name);
    if (superclassName === undefined) continue;

    // Resolve the superclass to a graphId
    let superclassGraphId = graphIdByName.get(superclassName);

    if (superclassGraphId === undefined) {
      // Superclass not in graph — create a stub for it
      superclassGraphId = createStubClassNode(graph, superclassName);
      graphIdByName.set(superclassName, superclassGraphId);
    }

    const actualEdgeKey = `${stub.graphId}->${superclassGraphId}`;
    if (emitted.has(actualEdgeKey)) continue;
    emitted.add(actualEdgeKey);

    graph.addRelationship({
      id: generateId('EXTENDS', actualEdgeKey),
      sourceId: stub.graphId,
      targetId: superclassGraphId,
      type: 'EXTENDS',
      confidence: 0.70,
      reason: `objc-heritage: stub transitive ${superclassName}`,
    });
    edgesEmitted++;

    // Recursively process the superclass if it's also a stub and not yet processed
    if (!processed.has(superclassName)) {
      const superNode = graph.getNode(superclassGraphId);
      if (superNode?.properties?.stub === 'true') {
        processed.add(superclassName);
        // Try to complete the chain for the superclass too
        const superHeaderFileName = `${superclassName}.h`;
        const superHeaderPath = headerByBaseName.get(superHeaderFileName);
        if (superHeaderPath !== undefined) {
          try {
            const superContent = readFileSync(superHeaderPath, 'utf-8');
            const superSuperName = extractSuperclassNameFromHeader(superContent, superclassName);
            if (superSuperName !== undefined) {
              let superSuperGraphId = graphIdByName.get(superSuperName);
              if (superSuperGraphId === undefined) {
                superSuperGraphId = createStubClassNode(graph, superSuperName);
                graphIdByName.set(superSuperName, superSuperGraphId);
              }
              const superEdgeKey = `${superclassGraphId}->${superSuperGraphId}`;
              if (!emitted.has(superEdgeKey)) {
                emitted.add(superEdgeKey);
                graph.addRelationship({
                  id: generateId('EXTENDS', superEdgeKey),
                  sourceId: superclassGraphId,
                  targetId: superSuperGraphId,
                  type: 'EXTENDS',
                  confidence: 0.65,
                  reason: `objc-heritage: stub transitive ${superSuperName}`,
                });
                edgesEmitted++;
              }
            }
          } catch {
            // Ignore errors reading the superclass header
          }
        }
      }
    }
  }

  return edgesEmitted;
}

/**
 * Extract the superclass name from an OC header file's @interface declaration.
 *
 * Matches: `@interface ClassName : SuperClassName`
 * Returns the SuperClassName, or undefined if not found.
 */
function extractSuperclassNameFromHeader(
  content: string,
  stubName: string,
): string | undefined {
  // Match: @interface ClassName : SuperClassName
  // Handle multi-line declarations and optional protocol lists
  const pattern = new RegExp(
    `@interface\\s+${escapeRegex(stubName)}\\s*:\\s*([A-Za-z_][A-Za-z0-9_]*)`,
    'm',
  );
  const match = content.match(pattern);
  if (match !== null) {
    const superclassName = match[1];
    // Filter out known non-class tokens
    if (superclassName === 'NSObject' || /^[A-Z]/.test(superclassName)) {
      return superclassName;
    }
  }
  return undefined;
}

/**
 * Escape special regex characters in a string.
 */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Emit a single heritage (EXTENDS or IMPLEMENTS) edge, deduplicated against
 * `emitted`. Confidence is 0.85 for directly-resolved edges (stub-transitive
 * chains use their own lower confidences above).
 */
function emitHeritageEdgeWithType(
  graph: KnowledgeGraph,
  sourceId: string,
  targetId: string,
  edgeType: 'EXTENDS' | 'IMPLEMENTS',
  baseName: string,
  emitted: Set<string>,
): void {
  const edgeKey = `${sourceId}->${targetId}`;
  if (emitted.has(edgeKey)) return;
  emitted.add(edgeKey);

  const reason =
    edgeType === 'IMPLEMENTS'
      ? `objc-heritage: protocol ${baseName}`
      : `objc-heritage: superclass ${baseName}`;

  graph.addRelationship({
    id: generateId(edgeType, `${sourceId}->${targetId}`),
    sourceId,
    targetId,
    type: edgeType,
    confidence: 0.85,
    reason,
  });
}
