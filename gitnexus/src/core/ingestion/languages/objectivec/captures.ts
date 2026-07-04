/**
 * `emitScopeCaptures` for Objective-C (RFC #909 Ring 3).
 *
 * Drives the OC scope query against tree-sitter-objc and groups raw
 * matches into `CaptureMatch[]` for the central `ScopeExtractor`. This
 * hook is the entry point for the scope-resolution pipeline — without it,
 * `scope-extractor-bridge.js` short-circuits and returns `undefined`,
 * skipping ALL OC files (no CALLS, IMPLEMENTS, or Process edges).
 *
 * Synthesizes several streams on top of the raw query captures:
 *
 *   1. **Decomposed imports** — each `preproc_include` (#import/#include)
 *      is re-emitted via `splitCInclude` with `@import.kind/source` markers.
 *   2. **Full selector names** — tree-sitter's `@declaration.name` only
 *      captures the first keyword segment of OC methods. We walk the
 *      method_definition/method_declaration node to build the complete
 *      selector (e.g., `tableView:cellForRowAtIndexPath:`).
 *   3. **Message expression call sites** — `message_expression` nodes are
 *      enriched with synthesized `@reference.name` (full selector) and
 *      `@reference.receiver` (receiver text) captures.
 *   4. **Inheritance references** — walks class_interface and
 *      protocol_declaration nodes to synthesize `@reference.inherits`
 *      captures for EXTENDS and IMPLEMENTS edges.
 *   5. **Arity metadata** — `@declaration.parameter-count` on function
 *      declarations so the registry can narrow by arity.
 *
 * Pure given the input source text. No I/O, no globals consulted.
 */
import type { Capture, CaptureMatch } from 'gitnexus-shared';
import {
  nodeIfType,
  nodeToCapture,
  syntheticCapture,
  type SyntaxNode,
} from '../../utils/ast-helpers.js';
import { getObjCParser, getObjCScopeQuery } from './query.js';
import { splitCInclude } from '../c/import-decomposer.js';
import { getTreeSitterBufferSize } from '../../constants.js';
import { parseSourceSafe } from '../../../tree-sitter/safe-parse.js';

export function emitObjCScopeCaptures(
  sourceText: string,
  _filePath: string,
  cachedTree?: unknown,
): CaptureMatch[] {
  // Preprocess OC source text to strip macros that tree-sitter-objc
  // cannot parse. NS_ASSUME_NONNULL_BEGIN/END and other common macros
  // create ERROR nodes that corrupt the AST, preventing class_interface
  // and other OC-specific nodes from being recognized.
  // Replace with spaces of equal length to preserve line/column positions.
  const cleanedSource = preprocessObjCSource(sourceText);

  // Always parse fresh with cleanedSource — the parse-worker's cachedTree
  // was parsed from original (unpreprocessed) text and may contain ERROR
  // nodes from unknown macros.
  const tree = parseSourceSafe(getObjCParser(), cleanedSource, undefined, {
    bufferSize: getTreeSitterBufferSize(cleanedSource),
  });
  const rawMatches = getObjCScopeQuery().matches(tree.rootNode);
  const out: CaptureMatch[] = [];

  for (const m of rawMatches) {
    const grouped: Record<string, Capture> = {};
    const nodeMap: Record<string, SyntaxNode> = {};

    for (const c of m.captures) {
      const tag = '@' + c.name;
      if (tag.startsWith('@_')) continue;
      grouped[tag] = nodeToCapture(tag, c.node);
      nodeMap[tag] = c.node;
    }

    if (Object.keys(grouped).length === 0) continue;

    // ── Handle #import / #include statements ──────────────────────────
    // Reuse C's splitCInclude — tree-sitter-objc uses the same
    // `preproc_include` node for both #import and #include.
    if (grouped['@import.statement'] !== undefined) {
      const includeNode = nodeIfType(nodeMap['@import.statement'], 'preproc_include');
      if (includeNode !== null) {
        const split = splitCInclude(includeNode);
        if (split !== null) {
          out.push(split);
          continue;
        }
      }
    }

    // ── Synthesize full selector name for method declarations ─────────
    // tree-sitter only captures the first keyword identifier as
    // @declaration.name. Walk the definition node to build the complete
    // selector (e.g., "tableView:cellForRowAtIndexPath:").
    if (grouped['@declaration.method'] !== undefined) {
      // Guard: skip matches without @declaration.name (shouldn't happen
      // with the `.` anchor in the query, but be defensive).
      if (grouped['@declaration.name'] === undefined) continue;
      const methodAnchorNode = nodeMap['@declaration.method'];
      const fullSelector = extractFullSelector(methodAnchorNode);
      if (fullSelector !== undefined && fullSelector !== grouped['@declaration.name']?.text) {
        grouped['@declaration.name'] = syntheticCapture(
          '@declaration.name',
          methodAnchorNode,
          fullSelector,
        );
      }
    }

    // ── Enrich message expression call sites ──────────────────────────
    // Synthesize @reference.name (full selector) and @reference.receiver
    // from the message_expression node.
    if (grouped['@reference.call.member'] !== undefined) {
      const msgNode = nodeIfType(nodeMap['@reference.call.member'], 'message_expression');
      if (msgNode !== null) {
        const parsed = parseMessageExpression(msgNode);
        if (parsed !== null) {
          grouped['@reference.name'] = syntheticCapture(
            '@reference.name',
            msgNode,
            parsed.calledName,
          );
          if (parsed.receiverName !== undefined) {
            grouped['@reference.receiver'] = syntheticCapture(
              '@reference.receiver',
              msgNode,
              parsed.receiverName,
            );
          }
        }
      }
    }

    // ── Enrich function declarations with arity ───────────────────────
    if (grouped['@declaration.function'] !== undefined) {
      const fnNode = nodeIfType(
        nodeMap['@declaration.function'],
        'function_definition',
        'declaration',
      );
      if (fnNode !== null) {
        const arity = computeCDeclarationArity(fnNode);
        if (arity.parameterCount !== undefined) {
          grouped['@declaration.parameter-count'] = syntheticCapture(
            '@declaration.parameter-count',
            fnNode,
            String(arity.parameterCount),
          );
        }
      }
    }

    // ── Enrich call references with arity ─────────────────────────────
    const callAnchorNode =
      nodeMap['@reference.call.free'] ?? nodeMap['@reference.call.member'];
    if (callAnchorNode !== undefined && grouped['@reference.arity'] === undefined) {
      const callNode = nodeIfType(callAnchorNode, 'call_expression', 'message_expression');
      if (callNode !== null) {
        grouped['@reference.arity'] = syntheticCapture(
          '@reference.arity',
          callNode,
          String(countCallArguments(callNode)),
        );
      }
    }

    out.push(grouped);
  }

  // ── Emit inheritance references for EXTENDS / IMPLEMENTS edges ────────
  // Walk class_interface and protocol_declaration nodes to synthesize
  // @reference.inherits captures consumed by the registry-primary
  // graph bridge. The lookup name is the bare class/protocol name.
  synthesizeObjCInheritanceReferences(tree.rootNode, out);

  // ── Emit type bindings for CALLS edge cross-file resolution ───────────
  // Without @type-binding.* captures, emitReceiverBoundCalls cannot
  // resolve receiver types (e.g., "self" → MyClass, "tableView" → UITableView).
  // Synthesize self, parameter, return-type, annotation, and constructor
  // bindings from the AST so Case 4 (simple typeBinding) can find typeRefs.
  synthesizeObjCTypeBindings(tree.rootNode, out);

  return out;
}

// ── Source preprocessing ─────────────────────────────────────────────────

/**
 * Strip OC macros that tree-sitter-objc cannot parse, replacing them with
 * spaces of equal length to preserve line/column positions.
 *
 * tree-sitter-objc does not understand C preprocessor macros. Common macros
 * like NS_ASSUME_NONNULL_BEGIN/END expand to _Pragma directives that create
 * ERROR nodes in the AST, preventing class_interface, method_declaration,
 * and other OC-specific nodes from being recognized.
 *
 * This preprocessing is applied BEFORE parsing, so the AST is clean.
 */
const OC_MACRO_PATTERNS: ReadonlyArray<{
  pattern: RegExp;
  replacement: string | ((match: string) => string);
}> = [
  // NS_ASSUME_NONNULL_BEGIN / NS_ASSUME_NONNULL_END
  // These are the most common macros that break OC parsing.
  { pattern: /NS_ASSUME_NONNULL_BEGIN/g, replacement: '                       ' },
  { pattern: /NS_ASSUME_NONNULL_END/g, replacement: '                     ' },
  // NS_SWIFT_UNAVAILABLE("msg") — common in SDK headers
  { pattern: /NS_SWIFT_UNAVAILABLE\s*\([^)]*\)/g, replacement: (match) => ' '.repeat(match.length) },
  // NS_REFINED_FOR_SWIFT — common in SDK headers
  { pattern: /NS_REFINED_FOR_SWIFT/g, replacement: '                    ' },
  // API_AVAILABLE / API_UNAVAILABLE macros
  { pattern: /API_AVAILABLE\s*\([^)]*\)/g, replacement: (match) => ' '.repeat(match.length) },
  { pattern: /API_UNAVAILABLE\s*\([^)]*\)/g, replacement: (match) => ' '.repeat(match.length) },
];

function preprocessObjCSource(sourceText: string): string {
  let result = sourceText;
  for (const { pattern, replacement } of OC_MACRO_PATTERNS) {
    if (typeof replacement === 'function') {
      result = result.replace(pattern, replacement);
    } else {
      result = result.replace(pattern, replacement);
    }
  }
  return result;
}

// ── Selector name extraction ───────────────────────────────────────────────

/**
 * Build the full OC selector from a method_declaration or method_definition node.
 *
 * OC method declarations use keyword segments separated by colons:
 *   - (void)foo;              → selector "foo"
 *   - (void)foo:(id)arg;      → selector "foo:"
 *   - (void)foo:(id)arg bar:(id)arg2;  → selector "foo:bar:"
 */
function extractFullSelector(definitionNode: SyntaxNode): string | undefined {
  // The captured node may be an implementation_definition (for @implementation
  // methods), a method_definition, or a method_declaration.
  let methodNode: SyntaxNode | undefined;
  if (definitionNode.type === 'method_definition' || definitionNode.type === 'method_declaration') {
    methodNode = definitionNode;
  } else if (definitionNode.type === 'implementation_definition') {
    // Find the inner method_definition
    for (let i = 0; i < definitionNode.namedChildCount; i++) {
      const child = definitionNode.namedChild(i);
      if (child?.type === 'method_definition') {
        methodNode = child;
        break;
      }
    }
  }
  if (!methodNode) return undefined;

  const parts: string[] = [];
  for (let i = 0; i < methodNode.namedChildCount; i++) {
    const child = methodNode.namedChild(i);
    if (!child) continue;
    if (child.type === 'identifier') {
      const nextSibling = methodNode.namedChild(i + 1);
      const hasParam = nextSibling?.type === 'method_parameter';
      parts.push(child.text + (hasParam ? ':' : ''));
    }
  }
  if (parts.length === 0) return undefined;
  return parts.join('');
}

// ── Message expression parsing ─────────────────────────────────────────────

/** Parsed result of an OC message_expression node. */
interface ParsedMessageExpression {
  calledName: string;
  receiverName?: string;
}

/**
 * Parse an OC message_expression node ([receiver method:arg keyword:arg2 ...]).
 *
 * Returns the full selector and receiver name.
 */
function parseMessageExpression(callNode: SyntaxNode): ParsedMessageExpression | null {
  if (callNode.type !== 'message_expression') return null;

  // Collect all method identifiers via the 'method' field (multiple=true)
  const methodNodes = callNode.childrenForFieldName('method');
  if (!methodNodes || methodNodes.length === 0) return null;

  const segments: string[] = [];
  for (const methodNode of methodNodes) {
    segments.push(methodNode.text);
    // Check if the next unnamed sibling is ':' (colon)
    const nextUnnamed = findNextUnnamedSibling(methodNode);
    if (nextUnnamed && nextUnnamed.text === ':') {
      segments.push(':');
    }
  }
  const methodName = segments.join('');

  // Receiver is the first named child or the 'receiver' field
  const receiverNode = callNode.childForFieldName('receiver') ?? callNode.firstNamedChild;
  if (!receiverNode) return null;

  let receiverName: string | undefined;
  if (receiverNode.type === 'identifier') {
    receiverName = receiverNode.text;
  } else if (receiverNode.type === 'field_expression') {
    receiverName = receiverNode.text;
  } else if (receiverNode.type === 'class_expression') {
    receiverName = receiverNode.text;
  }

  return {
    calledName: methodName,
    receiverName: receiverName || undefined,
  };
}

/** Find the next unnamed sibling of a node within its parent's children. */
function findNextUnnamedSibling(node: SyntaxNode): SyntaxNode | null {
  const parent = node.parent;
  if (!parent) return null;
  let foundSelf = false;
  for (let i = 0; i < parent.childCount; i++) {
    const child = parent.child(i);
    if (child === node) {
      foundSelf = true;
      continue;
    }
    if (!foundSelf) continue;
    if (child !== null && !child.isNamed) return child;
    return null;
  }
  return null;
}

/** Find the next unnamed sibling of a node within its parent's ALL children (named and unnamed). */
function findNextUnnamedSiblingInParent(node: SyntaxNode): SyntaxNode | null {
  const parent = node.parent;
  if (!parent) return null;
  let foundSelf = false;
  for (let i = 0; i < parent.childCount; i++) {
    const child = parent.child(i);
    if (child === node) {
      foundSelf = true;
      continue;
    }
    if (!foundSelf) continue;
    if (child !== null && !child.isNamed) return child;
  }
  return null;
}

// ── Arity helpers ──────────────────────────────────────────────────────────

/**
 * Count the number of arguments in a call_expression or message_expression.
 * For message_expression, counts the number of ':' (colon) separators
 * which equals the number of arguments.
 */
function countCallArguments(node: SyntaxNode): number {
  if (node.type === 'call_expression') {
    const argList = node.childForFieldName('arguments');
    if (argList === null) return 0;
    let count = 0;
    for (let i = 0; i < argList.namedChildCount; i++) {
      const child = argList.namedChild(i);
      if (child !== null && child.type !== ',' && child.type !== '(' && child.type !== ')') {
        count++;
      }
    }
    return count;
  }
  if (node.type === 'message_expression') {
    // Count colon separators — each colon indicates one argument.
    // The method segments minus 1 is the argument count (for multi-segment),
    // or 0 for no-argument messages.
    const methodNodes = node.childrenForFieldName('method');
    if (!methodNodes || methodNodes.length === 0) return 0;
    let colonCount = 0;
    for (const mn of methodNodes) {
      const next = findNextUnnamedSibling(mn);
      if (next && next.text === ':') colonCount++;
    }
    return colonCount;
  }
  return 0;
}

/** Computed arity metadata for a C function-like declaration. */
interface CDeclarationArity {
  parameterCount?: number;
  requiredParameterCount?: number;
}

/**
 * Compute the parameter count of a C function_definition or declaration node.
 * Mirrors C's computeCDeclarationArity.
 */
function computeCDeclarationArity(fnNode: SyntaxNode): CDeclarationArity {
  const funcDeclarator = findFunctionDeclarator(fnNode);
  if (funcDeclarator === null) return {};
  const params = funcDeclarator.childForFieldName('parameters');
  if (params === null) return {};
  let count = 0;
  for (let i = 0; i < params.namedChildCount; i++) {
    const child = params.namedChild(i);
    if (child !== null && child.type === 'parameter_declaration') {
      count++;
    }
  }
  return { parameterCount: count, requiredParameterCount: count };
}

/** Find the function_declarator inside a function_definition or declaration. */
function findFunctionDeclarator(fnNode: SyntaxNode): SyntaxNode | null {
  const direct = fnNode.childForFieldName('declarator');
  let cur = direct;
  let hops = 8;
  while (cur !== null && hops-- > 0) {
    if (cur.type === 'function_declarator') return cur;
    if (cur.type === 'pointer_declarator' || cur.type === 'reference_declarator') {
      cur = cur.childForFieldName('declarator');
      continue;
    }
    break;
  }
  // Fallback: search descendants
  return findFirstDescendantOfType(fnNode, 'function_declarator');
}

function findFirstDescendantOfType(node: SyntaxNode, type: string): SyntaxNode | null {
  if (node.type === type) return node;
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c === null) continue;
    const hit = findFirstDescendantOfType(c, type);
    if (hit !== null) return hit;
  }
  return null;
}

// ── Inheritance reference synthesis ────────────────────────────────────────

/**
 * Walk every OC class_interface and protocol_declaration to synthesize
 * `@reference.inherits` captures for EXTENDS / IMPLEMENTS edges.
 *
 * - @interface ClassName : ParentClass → ClassName EXTENDS ParentClass
 * - @interface ClassName : ParentClass <P1, P2> → EXTENDS ParentClass, IMPLEMENTS P1, P2
 * - @interface ClassName <P1, P2> → IMPLEMENTS P1, P2
 * - @protocol ProtoName <ParentProto> → ProtoName EXTENDS ParentProto
 *
 * The EXTENDS-vs-IMPLEMENTS split is decided downstream from the resolved
 * target's symbol kind (Interface = IMPLEMENTS, else EXTENDS), so every
 * base is emitted with the same `inherits` kind here.
 */
function synthesizeObjCInheritanceReferences(root: SyntaxNode, out: CaptureMatch[]): void {
  const stack: SyntaxNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;

    if (node.type === 'class_interface') {
      const identifiers: SyntaxNode[] = [];
      let parameterizedArgs: SyntaxNode | null = null;
      let isCategoryDeclaration = false;
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child === null) continue;
        if (child.type === 'identifier') {
          identifiers.push(child);
        } else if (child.type === 'parameterized_arguments') {
          parameterizedArgs = child;
        }
      }

      // OC Category declarations have parentheses around a name:
      //   @interface UIViewController (Hundsun)  — Category, NOT inheritance
      //   @interface MyVC : UIViewController     — Superclass inheritance
      //
      // In tree-sitter-objc, the Category name appears as an unnamed child
      // inside parentheses. Detect Category by checking for '(' immediately
      // after the class name identifier — if the text between the class name
      // and the next named child starts with '(' then it's a Category.
      //
      // Alternative detection: walk unnamed children after the first identifier
      // and check if the next unnamed sibling is '('.
      if (identifiers.length >= 1) {
        const classNameNode = identifiers[0];
        // Walk children to find '(' after the class name
        for (let i = 0; i < node.childCount; i++) {
          const child = node.child(i);
          if (child === classNameNode) {
            // Check the next unnamed sibling
            const nextUnnamed = findNextUnnamedSiblingInParent(child);
            if (nextUnnamed !== null && nextUnnamed.text === '(') {
              isCategoryDeclaration = true;
            }
            break;
          }
        }
      }

      // Skip Category declarations — they do NOT represent inheritance.
      // @interface ClassName (CategoryName) adds methods to ClassName,
      // it does NOT create a new class that inherits CategoryName.
      if (isCategoryDeclaration) {
        // Recurse into children but do NOT emit inheritance edges
        for (let i = 0; i < node.childCount; i++) {
          const child = node.child(i);
          if (child !== null) stack.push(child);
        }
        continue;
      }

      // First identifier is the class name, second is the superclass
      const superclassName = identifiers.length >= 2 ? identifiers[1].text : undefined;

      // Emit EXTENDS edge for superclass
      if (superclassName !== undefined && identifiers[1] !== undefined) {
        out.push({
          '@reference.inherits': nodeToCapture('@reference.inherits', identifiers[1]),
          '@reference.name': syntheticCapture('@reference.name', identifiers[1], superclassName),
        });
      }

      // Emit IMPLEMENTS edges for protocol conformance
      if (parameterizedArgs !== null) {
        emitProtocolReferences(parameterizedArgs, out);
      }
    } else if (node.type === 'protocol_declaration') {
      // Protocol inheritance: @protocol Child <Parent1, Parent2>
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child?.type === 'protocol_reference_list') {
          emitProtocolReferences(child, out);
          break;
        }
      }
    }

    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child !== null) stack.push(child);
    }
  }
}

/**
 * Emit @reference.inherits captures for each protocol name in a
 * protocol_reference_list or parameterized_arguments node.
 */
function emitProtocolReferences(protocolsNode: SyntaxNode, out: CaptureMatch[]): void {
  for (let i = 0; i < protocolsNode.namedChildCount; i++) {
    const child = protocolsNode.namedChild(i);
    let protoName: string | null = null;
    let nameNode: SyntaxNode | null = null;

    if (child?.type === 'identifier') {
      // protocol_reference_list: direct identifier children
      protoName = child.text;
      nameNode = child;
    } else if (child?.type === 'type_name') {
      // parameterized_arguments: type_name > type_identifier
      const typeId =
        child.descendantsOfType('type_identifier')[0] ??
        child.descendantsOfType('identifier')[0];
      if (typeId) {
        protoName = typeId.text;
        nameNode = typeId;
      }
    }

    if (protoName && nameNode) {
      out.push({
        '@reference.inherits': nodeToCapture('@reference.inherits', nameNode),
        '@reference.name': syntheticCapture('@reference.name', nameNode, protoName),
        // Mark protocol-conformance sites so heritage emitters can
        // discriminate EXTENDS vs IMPLEMENTS. The @reference.receiver
        // field is read by scope-extractor Pass 5 as explicitReceiver
        // and preserved in the referenceSite for downstream consumers.
        '@reference.receiver': syntheticCapture('@reference.receiver', nameNode, 'protocol-conformance'),
      });
    }
  }
}

// ── Type-binding synthesis for CALLS edge resolution ──────────────────────────

/**
 * Synthesize @type-binding.* captures for Objective-C so the scope-resolution
 * pipeline can resolve receiver types for cross-file CALLS edges.
 *
 * Five binding streams are synthesized:
 *
 *   1. **@type-binding.self** — binds `self` to the enclosing class name inside
 *      instance method bodies. This is the highest-impact fix: `[self method:]`
 *      is the most common OC call pattern (~60% of all message sends).
 *
 *   2. **@type-binding.parameter** — binds each method parameter to its declared
 *      type (e.g., `tableView → UITableView` in `tableView:cellForRowAtIndexPath:`).
 *
 *   3. **@type-binding.return** — binds the method's full selector name to its
 *      return type. Anchored on the method node itself (auto-hoisted to Module
 *      scope by scope-extractor). Enables `propagateImportedReturnTypes` to
 *      mirror return-type bindings across import boundaries.
 *      Special handling: `instancetype` is replaced with the current class name.
 *
 *   4. **@type-binding.annotation** — binds local variable names to their
 *      declared types inside method bodies (e.g., `UITableViewCell *cell → cell`).
 *
 *   5. **@type-binding.constructor** — binds local variables assigned from
 *      `[[ClassName alloc] init]` patterns to ClassName.
 *
 * All bindings use the same three-capture format required by scope-extractor
 * Pass 4 (type-binding collection):
 *   - anchor capture (@type-binding.<kind>)
 *   - @type-binding.name (bound local name)
 *   - @type-binding.type (raw type text, normalized by interpretObjCTypeBinding)
 */
function synthesizeObjCTypeBindings(root: SyntaxNode, out: CaptureMatch[]): void {
  // Phase 1: Walk class_implementation nodes to find class names and methods
  const classStack: SyntaxNode[] = [root];

  while (classStack.length > 0) {
    const node = classStack.pop();
    if (!node) continue;

    if (node.type === 'class_implementation') {
      const className = extractClassNameFromImpl(node);
      if (className !== null) {
        // Walk methods inside this @implementation
        processMethodsInClass(node, className, out);
        // Walk local variable declarations inside method bodies
        processLocalVariablesInClass(node, out);
      }
    }

    // Also process class_interface for return-type bindings on declarations
    if (node.type === 'class_interface') {
      const className = extractClassNameFromInterface(node);
      if (className !== null) {
        processMethodDeclarationsInInterface(node, className, out);
      }
    }

    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child !== null) classStack.push(child);
    }
  }
}

/**
 * Extract class name from a class_implementation node.
 * AST: (class_implementation " @implementation" . (identifier))
 */
function extractClassNameFromImpl(implNode: SyntaxNode): string | null {
  for (let i = 0; i < implNode.namedChildCount; i++) {
    const child = implNode.namedChild(i);
    if (child?.type === 'identifier') {
      return child.text;
    }
    // Stop at first identifier (class name); second would be category name
    // which we don't want for type bindings — the class name itself is what
    // `self` resolves to. For categories like @implementation NSString (MyCat),
    // the first identifier is still the class name.
    break;
  }
  return null;
}

/**
 * Extract class name from a class_interface node.
 * AST: (class_interface "@interface" . (identifier) ...)
 */
function extractClassNameFromInterface(interfaceNode: SyntaxNode): string | null {
  for (let i = 0; i < interfaceNode.namedChildCount; i++) {
    const child = interfaceNode.namedChild(i);
    if (child?.type === 'identifier') {
      return child.text;
    }
    break;
  }
  return null;
}

/**
 * Process all method_definition nodes inside a class_implementation.
 * Synthesize self, parameter, and return-type bindings.
 */
function processMethodsInClass(implNode: SyntaxNode, className: string, out: CaptureMatch[]): void {
  const stack: SyntaxNode[] = [implNode];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;

    if (node.type === 'implementation_definition' || node.type === 'method_definition') {
      // Only process method_definition (not plain implementation_definition which
      // is the wrapper for methods inside @implementation)
      if (node.type === 'method_definition') {
        const isInstanceMethod = isInstanceMethodNode(node);
        const bodyNode = findMethodBody(node);
        if (bodyNode === null) {
          // Method without body (shouldn't happen in @implementation,
          // but be defensive) — skip self/parameter bindings
          // but still emit return-type binding
          const returnType = extractMethodReturnType(node);
          if (returnType !== null) {
            const fullSelector = extractFullSelector(node);
            if (fullSelector !== undefined) {
              // instancetype → className replacement
              const effectiveType = returnType === 'instancetype' ? className : returnType;
              out.push(buildBindingMatch(node, '@type-binding.return', fullSelector, effectiveType));
            }
          }
        } else {
          // ── @type-binding.self: bind "self" to className ──────────
          if (isInstanceMethod) {
            out.push(buildBindingMatch(bodyNode, '@type-binding.self', 'self', className));
          }

          // ── @type-binding.parameter: bind param names to types ───
          processMethodParameters(node, bodyNode, out);

          // ── @type-binding.return: bind selector to return type ───
          const returnType = extractMethodReturnType(node);
          if (returnType !== null) {
            const fullSelector = extractFullSelector(node);
            if (fullSelector !== undefined) {
              const effectiveType = returnType === 'instancetype' ? className : returnType;
              out.push(buildBindingMatch(node, '@type-binding.return', fullSelector, effectiveType));
            }
          }
        }
      }

      // Don't recurse into method_definition's children — we've processed them
      if (node.type === 'method_definition') continue;
    }

    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child !== null) stack.push(child);
    }
  }
}

/**
 * Process method_declaration nodes inside a class_interface (header files).
 * Synthesize parameter and return-type bindings for declarations (not definitions).
 */
function processMethodDeclarationsInInterface(interfaceNode: SyntaxNode, className: string, out: CaptureMatch[]): void {
  const stack: SyntaxNode[] = [interfaceNode];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;

    if (node.type === 'method_declaration') {
      // method_declaration has no body, so parameter bindings can't land
      // in a Function scope. We skip parameter bindings for declarations
      // and only emit return-type bindings (which auto-hoist to Module scope).

      const returnType = extractMethodReturnType(node);
      if (returnType !== null) {
        const fullSelector = extractFullSelector(node);
        if (fullSelector !== undefined) {
          const effectiveType = returnType === 'instancetype' ? className : returnType;
          out.push(buildBindingMatch(node, '@type-binding.return', fullSelector, effectiveType));
        }
      }
      continue; // Don't recurse into method_declaration children
    }

    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child !== null) stack.push(child);
    }
  }
}

/**
 * Process method_parameter nodes within a method_definition to synthesize
 * @type-binding.parameter bindings.
 */
function processMethodParameters(methodNode: SyntaxNode, bodyNode: SyntaxNode, out: CaptureMatch[]): void {
  for (let i = 0; i < methodNode.namedChildCount; i++) {
    const child = methodNode.namedChild(i);
    if (child?.type === 'method_parameter') {
      const paramInfo = extractMethodParameter(child);
      if (paramInfo !== null) {
        out.push(buildBindingMatch(bodyNode, '@type-binding.parameter', paramInfo.name, paramInfo.type));
      }
    }
  }
}

/** Extracted parameter name and type. */
interface MethodParameterInfo {
  name: string;
  type: string;
}

/**
 * Extract parameter name and type from a method_parameter node.
 *
 * AST structure (verified):
 *   method_parameter → ":" method_type "(" type_name ")" identifier
 *
 * The type_name text includes the pointer star if present
 * (e.g., "UITableView *", "NSIndexPath *", "NSString *").
 * The identifier is the parameter name (e.g., "tableView", "indexPath").
 */
function extractMethodParameter(paramNode: SyntaxNode): MethodParameterInfo | null {
  let paramType: string | null = null;
  let paramName: string | null = null;

  for (let i = 0; i < paramNode.namedChildCount; i++) {
    const child = paramNode.namedChild(i);
    if (child === null) continue;

    // method_type contains the parameter type
    if (child.type === 'method_type') {
      paramType = extractTypeNameFromMethodType(child);
    }

    // identifier is the parameter name (last identifier in method_parameter)
    if (child.type === 'identifier') {
      paramName = child.text;
    }
  }

  if (paramName !== null && paramType !== null) {
    return { name: paramName, type: paramType };
  }
  return null;
}

/**
 * Extract the type name text from a method_type node.
 *
 * method_type AST: "(" type_name ")"
 * type_name text: "UITableViewCell *", "void", "UITableView *", etc.
 *
 * We strip the surrounding parentheses and return the raw type_name text.
 */
function extractTypeNameFromMethodType(methodTypeNode: SyntaxNode): string {
  // Walk children for type_name
  for (let i = 0; i < methodTypeNode.namedChildCount; i++) {
    const child = methodTypeNode.namedChild(i);
    if (child?.type === 'type_name') {
      return child.text.trim();
    }
  }
  // Fallback: use method_type text minus parentheses
  const text = methodTypeNode.text.trim();
  if (text.startsWith('(') && text.endsWith(')')) {
    return text.slice(1, -1).trim();
  }
  return text;
}

/**
 * Extract the return type from a method_definition or method_declaration node.
 *
 * The method_type node contains the return type. In tree-sitter-objc, the
 * grammar does not define a 'method_type' field name, so we must iterate
 * named children to find the method_type node.
 *
 * For: - (UITableViewCell *)tableView:...
 *   method_type → "(" type_name ")"
 *   type_name text → "UITableViewCell *"
 *
 * Returns null for void (uninformative) or if no method_type found.
 * instancetype is returned as-is; the caller replaces it with className.
 */
function extractMethodReturnType(methodNode: SyntaxNode): string | null {
  // tree-sitter-objc doesn't define field names, so iterate children
  for (let i = 0; i < methodNode.namedChildCount; i++) {
    const child = methodNode.namedChild(i);
    if (child?.type === 'method_type') {
      const typeName = extractTypeNameFromMethodType(child);
      if (typeName === 'void') return null; // void returns no usable type binding
      return typeName;
    }
  }
  return null;
}

/**
 * Check if a method_definition node is an instance method (- prefix)
 * rather than a class method (+ prefix).
 */
function isInstanceMethodNode(methodNode: SyntaxNode): boolean {
  // The first unnamed child is "-" or "+"
  const firstChild = methodNode.child(0);
  if (firstChild !== null && !firstChild.isNamed) {
    return firstChild.text === '-';
  }
  // Fallback: check node text prefix
  return methodNode.text.trimStart().startsWith('-');
}

/**
 * Find the method body (compound_statement) in a method_definition node.
 *
 * tree-sitter-objc does not define a 'body' field name for method_definition,
 * so we cannot use childForFieldName('body'). Instead, we search the named
 * children for the last compound_statement node, which is the method body.
 *
 * Verified: The compound_statement is always the last named child of
 * method_definition in the @implementation context.
 */
function findMethodBody(methodNode: SyntaxNode): SyntaxNode | null {
  // Search from the end — body is always last named child
  for (let i = methodNode.namedChildCount - 1; i >= 0; i--) {
    const child = methodNode.namedChild(i);
    if (child?.type === 'compound_statement') {
      return child;
    }
  }
  return null;
}

/**
 * Process local variable declarations inside method bodies.
 * Synthesize @type-binding.annotation and @type-binding.constructor bindings.
 *
 * OC local variable patterns:
 *   UITableViewCell *cell = [tableView dequeueReusableCellWithIdentifier:@"cell"];
 *   UIView *contentView = [[UIView alloc] init];
 *   NSString *name = @"hello";
 */
function processLocalVariablesInClass(implNode: SyntaxNode, out: CaptureMatch[]): void {
  const stack: SyntaxNode[] = [implNode];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;

    // Only process declarations inside method bodies (compound_statement)
    if (node.type === 'declaration' && node.parent?.type === 'compound_statement') {
      processLocalVariableDeclaration(node, out);
      continue; // Don't recurse into declaration children further
    }

    // Don't recurse into method_definition — already processed in processMethodsInClass
    if (node.type === 'method_definition') continue;

    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child !== null) stack.push(child);
    }
  }
}

/**
 * Process a single local variable declaration node.
 *
 * AST structure (verified):
 *   declaration → type_identifier init_declarator(pointer_declarator>identifier "=" value) ";"
 *   declaration → type_identifier pointer_declarator>identifier ";"
 *
 * Two binding types:
 *   - @type-binding.annotation: simple typed variable (UITableViewCell *cell = ...)
 *   - @type-binding.constructor: [[ClassName alloc] init] assignment
 */
function processLocalVariableDeclaration(declNode: SyntaxNode, out: CaptureMatch[]): void {
  // Extract type name from the declaration
  const typeName = extractLocalVariableType(declNode);
  if (typeName === null) return;

  // Extract variable name from init_declarator or direct pointer_declarator
  const varName = extractLocalVariableName(declNode);
  if (varName === null) return;

  // Check for constructor pattern: [[ClassName alloc] init]
  const constructorClassName = extractConstructorClassName(declNode);
  if (constructorClassName !== null) {
    // Constructor pattern takes precedence over annotation
    out.push(buildBindingMatch(declNode, '@type-binding.constructor', varName, constructorClassName));
    // Also emit annotation binding as a fallback (lower strength)
    // The constructor binding (source='constructor-inferred') has strength 1,
    // annotation has strength 2 — annotation wins. But constructor provides
    // a more specific type in some cases. Skip annotation when constructor
    // is available to avoid confusion.
    return;
  }

  // Skip primitive types that aren't useful for CALLS resolution
  if (isPrimitiveObjCType(typeName)) return;

  // Regular typed local variable → annotation binding
  out.push(buildBindingMatch(declNode, '@type-binding.annotation', varName, typeName));
}

/**
 * Extract the type name from a local variable declaration node.
 * Returns the type_identifier text (e.g., "UITableViewCell", "UIView").
 * For pointer types, we append "*" since OC objects are always pointer types.
 */
function extractLocalVariableType(declNode: SyntaxNode): string | null {
  for (let i = 0; i < declNode.namedChildCount; i++) {
    const child = declNode.namedChild(i);
    if (child?.type === 'type_identifier') {
      // OC object types are always pointers, append * for interpret.js
      // to strip later — this preserves the OC type semantics
      return child.text;
    }
  }
  // Check for primitive_type (int, float, etc.) — skip these
  for (let i = 0; i < declNode.childCount; i++) {
    const child = declNode.child(i);
    if (child?.type === 'primitive_type') {
      return child.text; // Will be filtered by isPrimitiveObjCType
    }
  }
  return null;
}

/**
 * Extract the variable name from a local variable declaration node.
 * Looks inside init_declarator or direct pointer_declarator/identifier.
 */
function extractLocalVariableName(declNode: SyntaxNode): string | null {
  for (let i = 0; i < declNode.namedChildCount; i++) {
    const child = declNode.namedChild(i);
    if (child?.type === 'init_declarator') {
      return extractVariableNameFromDeclarator(child);
    }
    if (child?.type === 'pointer_declarator') {
      return extractVariableNameFromPointerDeclarator(child);
    }
    if (child?.type === 'identifier') {
      // Direct identifier (non-pointer, non-init): int count;
      return child.text;
    }
  }
  return null;
}

/**
 * Extract variable name from an init_declarator node.
 * init_declarator → pointer_declarator>identifier | identifier "=" value
 */
function extractVariableNameFromDeclarator(initDeclNode: SyntaxNode): string | null {
  for (let i = 0; i < initDeclNode.namedChildCount; i++) {
    const child = initDeclNode.namedChild(i);
    if (child?.type === 'pointer_declarator') {
      return extractVariableNameFromPointerDeclarator(child);
    }
    if (child?.type === 'identifier') {
      return child.text;
    }
  }
  return null;
}

/**
 * Extract variable name from a pointer_declarator node.
 * pointer_declarator → "*" identifier | identifier (in some grammar versions)
 */
function extractVariableNameFromPointerDeclarator(ptrDeclNode: SyntaxNode): string | null {
  for (let i = 0; i < ptrDeclNode.namedChildCount; i++) {
    const child = ptrDeclNode.namedChild(i);
    if (child?.type === 'identifier') {
      return child.text;
    }
    if (child?.type === 'pointer_declarator') {
      // Nested pointer declarator (rare: **)
      return extractVariableNameFromPointerDeclarator(child);
    }
  }
  return null;
}

/**
 * Detect [[ClassName alloc] init] / [[ClassName alloc] initWithX:...] constructor
 * pattern in a local variable declaration and extract the ClassName.
 *
 * Returns null if the init value is not a constructor call.
 */
function extractConstructorClassName(declNode: SyntaxNode): string | null {
  // Find the init_declarator and its value
  for (let i = 0; i < declNode.namedChildCount; i++) {
    const child = declNode.namedChild(i);
    if (child?.type === 'init_declarator') {
      // The value is the RHS of the "=" assignment
      // In tree-sitter-objc: init_declarator has "value" field
      const valueNode = child.childForFieldName('value');
      if (valueNode !== null) {
        return extractClassNameFromMessageExpression(valueNode);
      }
      // Fallback: walk children for message_expression
      for (let j = 0; j < child.namedChildCount; j++) {
        const subchild = child.namedChild(j);
        if (subchild?.type === 'message_expression') {
          const name = extractClassNameFromMessageExpression(subchild);
          if (name !== null) return name;
        }
      }
    }
  }
  return null;
}

/**
 * Extract the class name from a message_expression that represents a constructor call.
 *
 * Patterns:
 *   [[UIView alloc] init]              → nested message_expression, outer receiver is [UIView alloc]
 *   [UIView new]                        → class_expression receiver
 *   [[MyClass alloc] initWithX:...]     → same nested pattern
 *
 * For nested [[Class alloc] init]:
 *   The outer message_expression's receiver is itself a message_expression [Class alloc].
 *   That inner message_expression's receiver is a class_expression or uppercase identifier.
 *
 * For [Class new]:
 *   The receiver is a class_expression or uppercase identifier.
 */
function extractClassNameFromMessageExpression(msgNode: SyntaxNode): string | null {
  if (msgNode.type !== 'message_expression') return null;

  const receiverNode = msgNode.childForFieldName('receiver') ?? msgNode.firstNamedChild;
  if (receiverNode === null) return null;

  // Nested: [[Class alloc] init] — receiver is a message_expression
  if (receiverNode.type === 'message_expression') {
    const innerReceiver = receiverNode.childForFieldName('receiver') ?? receiverNode.firstNamedChild;
    if (innerReceiver?.type === 'class_expression' || innerReceiver?.type === 'identifier') {
      const name = innerReceiver.text;
      // Verify it looks like a class name (uppercase first char, not self/super/nil)
      if (isValidClassName(name)) return name;
    }
  }

  // Direct: [Class new] — receiver is class_expression or uppercase identifier
  if (receiverNode.type === 'class_expression' || receiverNode.type === 'identifier') {
    const name = receiverNode.text;
    if (isValidClassName(name)) return name;
  }

  return null;
}

/**
 * Check if a name looks like an OC class name.
 * OC class names start with uppercase and are not self/super/nil.
 */
function isValidClassName(name: string): boolean {
  return /^[A-Z]/.test(name) && !['self', 'super', 'nil', 'Nil', 'YES', 'NO', 'TRUE', 'FALSE'].includes(name);
}

/**
 * Check if a type name is a primitive C/OC type that shouldn't produce
 * a type binding (not useful for CALLS resolution).
 */
function isPrimitiveObjCType(typeName: string): boolean {
  const primitives = new Set([
    'void', 'int', 'float', 'double', 'char', 'short', 'long',
    'unsigned', 'signed', 'BOOL', 'NSInteger', 'NSUInteger',
    'CGFloat', 'NSTimeInterval', 'CGSize', 'CGPoint', 'CGRect',
    'UIEdgeInsets', 'CGVector', 'CGAffineTransform',
    'bool', 'size_t', 'uint8_t', 'uint16_t', 'uint32_t', 'uint64_t',
    'int8_t', 'int16_t', 'int32_t', 'int64_t',
  ]);
  return primitives.has(typeName);
}

/**
 * Build a type-binding match with the required three-capture format.
 *
 * This mirrors Swift's `buildBindingMatch` in `signature-bindings.js`.
 * The anchor capture determines scope placement and source strength.
 * scope-extractor Pass 4 processes these captures via `interpretObjCTypeBinding`.
 */
function buildBindingMatch(
  anchorNode: SyntaxNode,
  sourceTag: string,
  name: string,
  typeText: string,
): CaptureMatch {
  return {
    [sourceTag]: nodeToCapture(sourceTag, anchorNode),
    '@type-binding.name': syntheticCapture('@type-binding.name', anchorNode, name),
    '@type-binding.type': syntheticCapture('@type-binding.type', anchorNode, typeText),
  };
}
