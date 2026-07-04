// gitnexus/src/core/ingestion/field-extractors/configs/objectivec.ts
//
// Objective-C @property field (Property) extraction config.
//
// WHY THIS EXISTS — OC must NOT reuse c-cpp's config:
// The C/C++ config (`cConfig`) only recognizes C `struct_specifier`/
// `union_specifier` as type-declaration owners, `field_declaration_list` as the
// body container, and `field_declaration` as field nodes. None of those node
// types appear in OC source: an OC class is `class_interface`/`class_implementation`,
// an OC @property is a `property_declaration`, and properties sit as DIRECT
// children of the class node (there is no dedicated body wrapper like Swift's
// `class_body`). As a result `cConfig.extract()` short-circuits at the
// `isTypeDeclaration` gate (generic.js) and returns null, so parse-worker never
// received a `declaredType` for any OC Property — every @property landed in the
// graph with an empty declaredType (only real C struct fields, which DO match
// cConfig, ever got types).
//
// tree-sitter-objc AST shape for @property (the whole point of this file):
//
//   property_declaration            "@property (nonatomic, strong) UILabel *titleLabel;"
//   ├── property_attributes_declaration   "(nonatomic, strong)"
//   └── struct_declaration          "UILabel *titleLabel;"   ← the type spec
//       ├── type_identifier         "UILabel"                ← the TYPE (first named child)
//       └── struct_declarator       "*titleLabel"
//           └── pointer_declarator
//               └── identifier     "titleLabel"             ← the NAME
//
// Variants covered by extractType/extractName:
//   - `UIView *v`        → struct_declaration > type_identifier(UIView) ... pointer_declarator > identifier
//   - `NSInteger count`  → struct_declaration > type_identifier(NSInteger) ... struct_declarator > identifier
//   - `id<Proto> d`      → struct_declaration > typedefed_specifier(id<Proto>) ... identifier
//   - `void(^blk)(void)` → struct_declaration > primitive_type(void) ... function_declarator > ... > identifier

import { SupportedLanguages } from 'gitnexus-shared';
import type { FieldExtractionConfig } from '../generic.js';
import { extractSimpleTypeName } from '../../type-extractors/shared.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';
import type { FieldVisibility } from '../../field-types.js';

/** Walk a subtree looking for the first `identifier` node — the property NAME
 *  lives under a struct_declarator, possibly wrapped in pointer_declarator (for
 *  pointers: `*name`) or function_declarator (for block properties:
 *  `void(^name)(void)`). */
function findFirstIdentifier(node: SyntaxNode): SyntaxNode | null {
  if (node.type === 'identifier') return node;
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;
    const found = findFirstIdentifier(child);
    if (found) return found;
  }
  return null;
}

/**
 * Collect the NAME of EVERY declarator in a property_declaration — OC allows
 * comma-separated multi-variable declarations sharing one type:
 *   @property (nonatomic, strong) UIView *a, *b, *c;
 * Each struct_declarator under struct_declaration is one variable. We return
 * one name per declarator so the generic extractor emits one Property node
 * per declared variable (all sharing the same declaredType). Single-variable
 * declarations still produce a 1-element array (not a scalar) so they flow
 * through the same extractNames path.
 */
function extractObjCPropertyNames(propNode: SyntaxNode): string[] {
  const names: string[] = [];
  for (let i = 0; i < propNode.namedChildCount; i++) {
    const sd = propNode.namedChild(i);
    if (!sd || sd.type !== 'struct_declaration') continue;
    for (let j = 0; j < sd.namedChildCount; j++) {
      const sdec = sd.namedChild(j);
      if (!sdec || sdec.type !== 'struct_declarator') continue;
      const id = findFirstIdentifier(sdec);
      if (id) names.push(id.text);
    }
  }
  return names;
}

/** Required by FieldExtractionConfig.extractName: return the single (first)
 *  declarator name. Multi-variable declarations are handled via extractNames. */
function extractObjCPropertyName(propNode: SyntaxNode): string | undefined {
  return extractObjCPropertyNames(propNode)[0];
}

function extractObjCPropertyType(propNode: SyntaxNode): string | undefined {
  for (let i = 0; i < propNode.namedChildCount; i++) {
    const sd = propNode.namedChild(i);
    if (!sd || sd.type !== 'struct_declaration') continue;
    // The type is the struct_declaration's FIRST named child. For the
    // common forms this is a type_identifier (UILabel) / typedefed_specifier
    // (id<Proto>) / primitive_type (void). extractSimpleTypeName normalizes
    // these; fall back to raw text for any unhandled node type.
    const typeNode = sd.namedChild(0);
    if (!typeNode) continue;
    return extractSimpleTypeName(typeNode) ?? typeNode.text?.trim();
  }
  return undefined;
}

function extractObjCPropertyAttributes(propNode: SyntaxNode): string | undefined {
  // The `property_attributes_declaration` node "(nonatomic, strong)" is a
  // DIRECT named child of property_declaration but is NOT exposed under a
  // tree-sitter field name, so childForFieldName() misses it — walk the
  // named children by node type instead.
  for (let i = 0; i < propNode.namedChildCount; i++) {
    const child = propNode.namedChild(i);
    if (child?.type === 'property_attributes_declaration') return child.text;
  }
  return undefined;
}

function extractObjCVisibility(propNode: SyntaxNode): FieldVisibility {
  // OC @property has no access-control keywords (unlike C++ public/private);
  // `readonly`/`readwrite` are setter-generation toggles, not visibility. Map
  // every property to `public` to mirror how the C/C++ config treats C, and to
  // keep OC consistent with its C ancestry.
  void propNode;
  return 'public';
}

function extractObjCClassName(classNode: SyntaxNode): string | undefined {
  // OC class nodes do NOT expose a named "name" field — the class name is the
  // FIRST `identifier` child (e.g. class_interface > "@interface", identifier,
  // identifier,... where the first identifier is the class name and a second
  // one is the Category name in `Foo+Bar` cases).
  for (let i = 0; i < classNode.namedChildCount; i++) {
    const child = classNode.namedChild(i);
    if (child?.type === 'identifier') return child.text;
  }
  return undefined;
}

export const objectivecFieldConfig: FieldExtractionConfig = {
  language: SupportedLanguages.ObjectiveC,
  // OC owners that can declare @property. protocol_declaration (OC @protocol)
  // can also declare properties and is in CLASS_CONTAINER_TYPES.
  typeDeclarationNodes: ['class_interface', 'class_implementation', 'protocol_declaration'],
  fieldNodeTypes: ['property_declaration'],
  // Unlike Swift/C#, OC has NO dedicated body container: @property is a
  // DIRECT child of the class node. Return the class node itself so the
  // generic extractor walks its direct children for property_declaration.
  bodyNodeTypes: [],
  findBodyNodes: (classNode: SyntaxNode) => [classNode],
  defaultVisibility: 'public',
  extractOwnerName: extractObjCClassName,
  extractNames: extractObjCPropertyNames,
  extractName: extractObjCPropertyName,
  extractType: extractObjCPropertyType,
  extractVisibility: extractObjCVisibility,
  isStatic(_node: SyntaxNode) {
    // @property does not carry a C-style static keyword; class-level vs
    // instance is conveyed by the owning context, not the declaration.
    return false;
  },
  isReadonly(node: SyntaxNode) {
    const attrs = extractObjCPropertyAttributes(node);
    return !!(attrs && /readonly\b/.test(attrs));
  },
};
