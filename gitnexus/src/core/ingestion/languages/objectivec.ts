/**
 * Objective-C language provider (v1.6.7 adaptation).
 *
 * Heritage extraction is driven entirely by tree-sitter query captures
 * (no dedicated heritage extractor). Protocol conformance is likewise
 * handled via query captures rather than a dedicated extractor.
 *
 * OC's signature call shape is the bracketed message expression
 * (`[receiver selector:arg]`), which the generic call-analysis path
 * cannot parse. `parseObjCMessageExpression` provides the language-specific
 * call-site extractor that turns a `message_expression` node into the
 * `ExtractedCallSite` consumed by the resolution pipeline.
 */
import { SupportedLanguages } from 'gitnexus-shared';
import type { NodeLabel } from 'gitnexus-shared';
import { createClassExtractor } from '../class-extractors/generic.js';
import { cClassConfig } from '../class-extractors/configs/c-cpp.js';
import { defineLanguage } from '../language-provider.js';
import type { LanguageProvider } from '../language-provider.js';
import { typeConfig as cCppConfig } from '../type-extractors/c-cpp.js';
import { cCppExportChecker } from '../export-detection.js';
import { createImportResolver } from '../import-resolvers/resolver-factory.js';
import { cImportConfig } from '../import-resolvers/configs/c-cpp.js';
import { OBJC_QUERIES } from '../tree-sitter-queries.js';
import { createFieldExtractor } from '../field-extractors/generic.js';
import { objectivecFieldConfig as ocFieldConfig } from '../field-extractors/configs/objectivec.js';
import { createMethodExtractor } from '../method-extractors/generic.js';
import { cMethodConfig } from '../method-extractors/configs/c-cpp.js';
import { createVariableExtractor } from '../variable-extractors/generic.js';
import { cVariableConfig } from '../variable-extractors/configs/c-cpp.js';
import { createCallExtractor } from '../call-extractors/generic.js';
import type { CallExtractionConfig, ExtractedCallSite } from '../call-types.js';
import type { SyntaxNode } from '../utils/ast-helpers.js';
import { emitObjCScopeCaptures } from './objectivec/index.js';
import { interpretObjCTypeBinding } from './objectivec/interpret.js';
import { interpretCImport } from './c/index.js';

const C_BUILT_INS: ReadonlySet<string> = new Set([
  'alloc',
  'init',
  'initWithFrame:',
  'dealloc',
  'release',
  'retain',
  'autorelease',
  'copy',
  'mutableCopy',
  'description',
  'debugDescription',
  'isEqual:',
  'hash',
  'class',
  'superclass',
  'respondsToSelector:',
  'performSelector:',
  'performSelector:withObject:',
  'addSubview:',
  'removeFromSuperview',
  'array',
  'dictionary',
  'set',
  'objectAtIndex:',
  'objectForKey:',
  'count',
  'CGPointMake',
  'CGRectMake',
  'CGSizeMake',
  'NSLog',
  'NSAssert',
  'NSStringFromClass',
  'NSStringFromSelector',
]);

/**
 * Extract an Objective-C call site from a `message_expression` node
 * (`[receiver selector:arg label:arg]`).
 *
 * The selector name is the concatenation of each selector segment + `:`
 * (e.g. `tableView:numberOfRowsInSection:`). The receiver determines
 * dispatch: an uppercase-leading identifier/field expression that isn't
 * `self`/`super`/`nil` is treated as a class receiver.
 *
 * Returns `null` for any non-`message_expression` node so the generic
 * call-analysis path can take over for standard call shapes.
 */
function parseObjCMessageExpression(callNode: SyntaxNode): ExtractedCallSite | null {
  if (callNode.type !== 'message_expression') return null;
  const methodNodes = callNode.childrenForFieldName('method');
  if (!methodNodes || methodNodes.length === 0) return null;
  const segments: string[] = [];
  for (const methodNode of methodNodes) {
    segments.push(methodNode.text);
    const nextUnnamed = findNextUnnamedSibling(methodNode);
    if (nextUnnamed && nextUnnamed.text === ':') segments.push(':');
  }
  const methodName = segments.join('');
  const receiverNode = callNode.childForFieldName('receiver') ?? callNode.firstNamedChild;
  if (!receiverNode) return null;
  let receiverName: string | undefined;
  if (receiverNode.type === 'identifier') receiverName = receiverNode.text;
  else if (receiverNode.type === 'field_expression') receiverName = receiverNode.text;
  else if (receiverNode.type === 'class_expression') receiverName = receiverNode.text;
  const isClassMethod =
    !!receiverName &&
    /^[A-Z]/.test(receiverName) &&
    !['self', 'super', 'nil'].includes(receiverName);
  return {
    calledName: methodName,
    // OC message sends dispatch via the receiver — model as a member call.
    // `CallForm` has no `'static'` variant; the uppercase receiver is
    // preserved via `receiverName` so downstream type-as-receiver handling
    // still applies.
    callForm: 'member',
    receiverName: receiverName || undefined,
    ...(isClassMethod ? { typeAsReceiverHeuristic: true } : {}),
  };
}

/**
 * Return the first unnamed sibling immediately following `node`, if any.
 * Used to detect the `:` separator that tree-sitter attaches between
 * selector segments of a parameterized message expression.
 */
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
    if (!child?.isNamed) return child;
    return null;
  }
  return null;
}

const objcCallConfig: CallExtractionConfig = {
  language: SupportedLanguages.ObjectiveC,
  extractLanguageCallSite: parseObjCMessageExpression,
};

/**
 * Extract the Objective-C selector name + label for a captured method node.
 *
 * OC selectors are the concatenation of each parameterized part's label
 * plus `:` (e.g. `tableView:numberOfRowsInSection:`). Walk the method
 * definition's named children, appending `:` when the segment is followed
 * by a `method_parameter` node. Returns `null` (fall through to generic)
 * for non-method nodes, and `{ funcName: null, label: 'Method' }` when the
 * node is a method but no selector could be derived so the captured name
 * remains used as-is with the `Method` label.
 */
function extractObjCSelectorName(
  node: SyntaxNode,
): { funcName: string | null; label: NodeLabel } | null {
  if (node.type !== 'method_definition' && node.type !== 'method_declaration') {
    return null;
  }
  const parts: string[] = [];
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;
    if (child.type === 'identifier') {
      const nextSibling = node.namedChild(i + 1);
      const hasParam = nextSibling?.type === 'method_parameter';
      parts.push(child.text + (hasParam ? ':' : ''));
    }
  }
  return { funcName: parts.length > 0 ? parts.join('') : null, label: 'Method' };
}

export const objectivecProvider: LanguageProvider = defineLanguage({
  id: SupportedLanguages.ObjectiveC,
  extensions: ['.m', '.mm', '.h'],
  entryPointPatterns: [
    /^viewDidLoad$/,
    /^viewWillAppear$/,
    /^viewDidAppear$/,
    /^viewWillDisappear$/,
    /^viewDidDisappear$/,
    /^viewWillLayoutSubviews$/,
    /^viewDidLayoutSubviews$/,
    /^tableView$/,
    /^numberOfSections/,
    /^numberOfRows/,
    /^setup/,
    /^layout[A-Z]/,
    /^init[A-Z]/,
    /^confirm[A-Z]/,
    /^send[A-Z]/,
    /^bind[A-Z]/,
    /^update[A-Z]/,
    /^load[A-Z]/,
    /^create[A-Z]/,
    /[Bb]utton[A-Z]/,
    /[Tt]apped$/,
    /[Cc]licked$/,
    /[Pp]ressed$/,
    /^page[A-Z]/,
    /^component[A-Z]/,
    /^did[A-Z]/,
    /^will[A-Z]/,
    /^check[A-Z]/,
    /^do[A-Z]/,
    /^request[A-Z]/,
    /^refresh[A-Z]/,
    /^reset[A-Z]/,
    /^clear[A-Z]/,
  ],
  treeSitterQueries: OBJC_QUERIES,
  typeConfig: cCppConfig,
  exportChecker: cCppExportChecker,
  importResolver: createImportResolver(cImportConfig),
  mroStrategy: 'leftmost-base',
  callExtractor: createCallExtractor(objcCallConfig),
  fieldExtractor: createFieldExtractor(ocFieldConfig),
  methodExtractor: createMethodExtractor({
    ...cMethodConfig,
    extractFunctionName: extractObjCSelectorName,
  }),
  variableExtractor: createVariableExtractor(cVariableConfig),
  classExtractor: createClassExtractor(cClassConfig),
  resolveEnclosingOwner: (current: SyntaxNode) => {
    // OC @property declarations wrap their type+name in a struct_declaration
    // node. This struct_declaration is NOT a class container — it's just the
    // property's type specification (e.g. "UIView *mainView"). When walking
    // up from a property's identifier, findEnclosingClassInfo would stop at
    // this struct_declaration (since it's in CLASS_CONTAINER_TYPES) and
    // incorrectly return the property TYPE as the enclosing class. Skip it
    // so the walk continues up to the real class_interface / class_implementation.
    if (current.type === 'struct_declaration' && current.parent?.type === 'property_declaration') {
      return null;
    }
    return current;
  },
  builtInNames: C_BUILT_INS,
  emitScopeCaptures: emitObjCScopeCaptures,
  interpretTypeBinding: interpretObjCTypeBinding,
  interpretImport: interpretCImport,
});
