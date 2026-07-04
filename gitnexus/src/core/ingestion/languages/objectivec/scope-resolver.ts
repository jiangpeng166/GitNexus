/**
 * Objective-C `ScopeResolver` — minimal resolver for the scope-resolution
 * pipeline (RFC #909 Ring 3), registered in `SCOPE_RESOLVERS` and consumed
 * by the generic `runScopeResolution` orchestrator.
 *
 * OC extends C with:
 *   - Single inheritance (leftmost-base MRO)
 *   - Protocol conformance (IMPLEMENTS edges, handled by heritage queries)
 *   - Class methods and instance methods (selector-based dispatch)
 *   - `#import` is wildcard-transitive (all symbols visible)
 *
 * This resolver reuses C's import resolution and MRO strategy, adapted
 * for OC's `#import` semantics and class hierarchy.
 */

import type { ParsedFile, ScopeId } from 'gitnexus-shared';
import { SupportedLanguages } from 'gitnexus-shared';
import { buildMro, defaultLinearize } from '../../scope-resolution/passes/mro.js';
import { populateClassOwnedMembers } from '../../scope-resolution/scope/walkers.js';
import type { GraphNodeLookup } from '../../scope-resolution/graph-bridge/node-lookup.js';
import type { KnowledgeGraph } from '../../../graph/types.js';
import type { ScopeResolver } from '../../scope-resolution/contract/scope-resolver.js';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import { objectivecProvider } from '../objectivec.js';
import { cArityCompatibility, cMergeBindings } from '../c/index.js';
import { resolveCImportTarget } from '../c/import-target.js';
import { scanHeaderFiles } from '../c/header-scan.js';
import { emitObjCHeritageEdges } from './heritage-emitter.js';
import { emitObjCCrossFileCalls } from './calls-emitter.js';
import { logger } from '../../../logger.js';

/**
 * Module-level cache for the workspace's header file paths, set by
 * `loadResolutionConfig` once per pass and threaded into
 * `emitHeritageEdges` (which scans them to complete transitive stub
 * EXTENDS chains). Kept module-local because `emitHeritageEdges` is a
 * `ScopeResolver` hook that, per contract, only receives
 * `(graph, parsedFiles, nodeLookup, scopes?)` — the header set is not
 * part of that signature, so it is stashed here.
 */
let _cachedHeaderPaths: ReadonlySet<string> | undefined;

/**
 * Per-pass memo of the augmented `#import`-resolution file set
 * (`allFilePaths` ∪ header `.h` paths), keyed on the two stable source
 * sets. Mirrors the C resolver's memo: `resolveImportTarget` runs once
 * per `#import` and the union is rebuilt only on the first call per
 * pass, then reused. `WeakMap`-keyed → reclaimed with the pass.
 */
const augmentedPathsByPass = new WeakMap<
  ReadonlySet<string>,
  WeakMap<ReadonlySet<string>, ReadonlySet<string>>
>();

function augmentedFilePaths(
  allFilePaths: ReadonlySet<string>,
  headerPaths: ReadonlySet<string>,
): ReadonlySet<string> {
  let byHeaders = augmentedPathsByPass.get(allFilePaths);
  if (byHeaders === undefined) {
    byHeaders = new WeakMap();
    augmentedPathsByPass.set(allFilePaths, byHeaders);
  }
  let augmented = byHeaders.get(headerPaths);
  if (augmented === undefined) {
    const set = new Set<string>(allFilePaths);
    for (const h of headerPaths) set.add(h);
    augmented = set;
    byHeaders.set(headerPaths, augmented);
  }
  return augmented;
}

export const objectivecScopeResolver: ScopeResolver = {
  language: SupportedLanguages.ObjectiveC,
  languageProvider: objectivecProvider,
  importEdgeReason: 'objc-scope: #import',

  loadResolutionConfig: (repoPath: string): ReadonlySet<string> => {
    _cachedHeaderPaths = scanHeaderFiles(repoPath);
    return _cachedHeaderPaths;
  },

  resolveImportTarget: (
    targetRaw: string,
    fromFile: string,
    allFilePaths: ReadonlySet<string>,
    resolutionConfig?: unknown,
  ): string | readonly string[] | null => {
    const headerPaths = resolutionConfig as ReadonlySet<string> | undefined;
    if (headerPaths !== undefined && headerPaths.size > 0) {
      return resolveCImportTarget(
        targetRaw,
        fromFile,
        augmentedFilePaths(allFilePaths, headerPaths),
      );
    }
    return resolveCImportTarget(targetRaw, fromFile, allFilePaths);
  },

  // OC `#import` is wildcard-transitive — no namespace expansion needed.
  expandsWildcardTo: (_targetModuleScope: ScopeId, _parsedFiles: readonly ParsedFile[]): readonly string[] => [],

  mergeBindings: (existing, incoming, scopeId) => cMergeBindings(existing, incoming, scopeId),

  arityCompatibility: (callsite, def) => cArityCompatibility(def, callsite),

  // OC uses leftmost-base MRO for single inheritance.
  buildMro: (
    graph: KnowledgeGraph,
    parsedFiles: readonly ParsedFile[],
    nodeLookup: GraphNodeLookup,
  ): Map<string, string[]> => buildMro(graph, parsedFiles, nodeLookup, defaultLinearize),

  populateOwners: (parsed: ParsedFile): void => {
    populateClassOwnedMembers(parsed);
  },

  // OC has a `super` keyword — check if the receiver text is literally `super`.
  isSuperReceiver: (text: string): boolean => text === 'super',

  // OC is statically typed — the field-fallback heuristic over-connects.
  fieldFallbackOnMethodLookup: false,

  // OC method return types should propagate.
  propagatesReturnTypesAcrossImports: true,

  // OC `#import` brings in all symbols.
  allowGlobalFreeCallFallback: true,

  // No file-local linkage concept in OC class code (no `static` functions
  // in classes).
  isFileLocalDef: (): boolean => false,

  // Emit cross-file EXTENDS + IMPLEMENTS edges that the standard
  // `preEmitInheritanceEdges` cannot produce because OC's
  // wildcard-transitive `#import` doesn't create symbol bindings in the
  // finalize phase. Also creates stub nodes for SDK/Pod classes not in
  // the graph.
  emitHeritageEdges: (
    graph: KnowledgeGraph,
    parsedFiles: readonly ParsedFile[],
    nodeLookup: GraphNodeLookup,
  ): void => {
    emitObjCHeritageEdges(graph, parsedFiles, nodeLookup, _cachedHeaderPaths);
  },

  // Emit cross-file CALLS edges for OC `message_expression` call sites
  // that the standard `emitReceiverBoundCalls` pass cannot resolve
  // because the MRO chain is incomplete (stub nodes break the
  // DefId-based chain). Walks the graph-level EXTENDS chain and uses
  // HAS_METHOD edges to find target methods, bypassing the
  // scope-resolution DefId limitation.
  emitPostResolutionEdges: (
    graph: KnowledgeGraph,
    parsedFiles: readonly ParsedFile[],
    nodeLookup: GraphNodeLookup,
    indexes: ScopeResolutionIndexes,
  ): void => {
    const result = emitObjCCrossFileCalls(graph, parsedFiles, nodeLookup, indexes);
    // Return value is edge-count telemetry; the contract hook returns void.
    // Log the skip breakdown so OC CALLS edge regressions are locatable.
    logger.info(
      `[oc-calls] emitted=${result.edgesEmitted} noReceiver=${result.skippedNoReceiver} noCaller=${result.skippedNoCaller} noTarget=${result.skippedNoTarget} noMethod=${result.skippedNoMethod} duplicate=${result.skippedDuplicate}`,
    );
  },
};
