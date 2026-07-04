/**
 * Tree-sitter query for Objective-C scope captures (RFC §5.1).
 *
 * Captures the structural skeleton the generic scope-resolution pipeline
 * consumes: scopes (module/class/function/block), declarations (classes,
 * protocols, methods, properties, C functions/variables, enums, typedefs),
 * imports (#import / #include), and references (message expressions, C calls,
 * field reads/writes).
 *
 * Exposes lazy `Parser` and `Query` singletons so callers don't pay
 * tree-sitter init cost per file.
 */

import Parser from 'tree-sitter';
import { SupportedLanguages } from 'gitnexus-shared';
// `tree-sitter-objc` is an optional/vendored grammar that may be absent on a
// default install. It is loaded lazily + guarded via parser-loader rather than
// statically imported: this module is pulled onto the main thread eagerly by
// the scope-resolution registry and the language-provider index, so a top-level
// `import ObjC from 'tree-sitter-objc'` would throw ERR_MODULE_NOT_FOUND at
// module-load and crash `analyze` even for repos with no OC files. The grammar
// is only ever needed inside the lazy getters below.
import { getLanguageGrammar } from '../../../tree-sitter/parser-loader.js';

/**
 * OC scope query for tree-sitter-objc.
 *
 * Captures scopes, declarations, imports, and references from OC source files.
 * tree-sitter-objc is a superset of tree-sitter-c, so C constructs (function
 * definitions, call expressions, etc.) are captured using the same patterns
 * as C_SCOPE_QUERY, while OC-specific constructs (class_interface,
 * message_expression, protocol_declaration, etc.) use objc grammar node types.
 */
const OC_SCOPE_QUERY = `
;; ── Scopes ────────────────────────────────────────────────────────────
(translation_unit) @scope.module
(class_interface) @scope.class
(class_implementation) @scope.class
(protocol_declaration) @scope.class
(method_definition) @scope.function
(function_definition) @scope.function
(compound_statement) @scope.block
(if_statement) @scope.block
(for_statement) @scope.block
(while_statement) @scope.block
(do_statement) @scope.block
(switch_statement) @scope.block
(case_statement) @scope.block

;; ── Declarations — class @interface ────────────────────────────────────
;; Anchor to "@interface" keyword so the first identifier (class name)
;; is always captured — prevents Category names from overriding.
(class_interface
  "@interface" . (identifier) @declaration.name) @declaration.class

;; ── Declarations — class @implementation ───────────────────────────────
(class_implementation
  "@implementation" . (identifier) @declaration.name) @declaration.class

;; ── Declarations — @protocol ───────────────────────────────────────────
(protocol_declaration
  (identifier) @declaration.name) @declaration.interface

;; ── Declarations — method (declaration in @interface) ──────────────────
;; The '.' anchor ensures we only capture the FIRST identifier after
;; method_type — prevents duplicate matches for multi-segment selectors
;; like 'foo:bar:' which have multiple identifier children.
(method_declaration
  (method_type)
  . (identifier) @declaration.name) @declaration.method

;; ── Declarations — method (definition in @implementation) ──────────────
(implementation_definition
  (method_definition
    (method_type)
    . (identifier) @declaration.name)) @declaration.method

;; ── Declarations — @property (non-pointer type: int count;) ────────────
(property_declaration
  (struct_declaration
    (struct_declarator
      (identifier) @declaration.name))) @declaration.property

;; ── Declarations — @property (pointer type: NSString *name;) ───────────
(property_declaration
  (struct_declaration
    (struct_declarator
      (pointer_declarator
        (identifier) @declaration.name)))) @declaration.property

;; ── Declarations — @property (block type: void (^block)(void);) ────────
(property_declaration
  (struct_declaration
    (struct_declarator
      (function_declarator
        (parenthesized_declarator
          (block_pointer_declarator
            (identifier) @declaration.name)))))) @declaration.property

;; ── Declarations — C function in OC file ───────────────────────────────
(function_definition
  declarator: (function_declarator
    declarator: (identifier) @declaration.name)) @declaration.function

;; ── Declarations — C function with pointer return ──────────────────────
(function_definition
  declarator: (pointer_declarator
    declarator: (function_declarator
      declarator: (identifier) @declaration.name))) @declaration.function

;; ── Declarations — C function declaration (prototype) ──────────────────
(declaration
  declarator: (function_declarator
    declarator: (identifier) @declaration.name)) @declaration.function

(declaration
  declarator: (pointer_declarator
    declarator: (function_declarator
      declarator: (identifier) @declaration.name))) @declaration.function

;; ── Declarations — C variables ─────────────────────────────────────────
(declaration
  declarator: (init_declarator
    declarator: (identifier) @declaration.name)) @declaration.variable

(declaration
  declarator: (identifier) @declaration.name) @declaration.variable

(declaration
  declarator: (pointer_declarator
    declarator: (identifier) @declaration.name)) @declaration.variable

;; ── Declarations — enum ────────────────────────────────────────────────
(enum_specifier
  name: (type_identifier) @declaration.name) @declaration.enum

;; ── Declarations — typedef ─────────────────────────────────────────────
(type_definition
  declarator: (type_identifier) @declaration.name) @declaration.typedef

;; ── Imports (#import and #include) ─────────────────────────────────────
(preproc_include) @import.statement

;; ── References — OC message expressions (method calls) ─────────────────
;; [receiver method:arg keyword:arg2 ...]
;; Full selector and receiver are synthesized in captures.js from the
;; message_expression node.
(message_expression) @reference.call.member

;; ── References — C function calls ──────────────────────────────────────
(call_expression
  function: (identifier) @reference.name) @reference.call.free

;; ── References — field reads (obj.field / self->field) ─────────────────
(field_expression
  argument: (_) @reference.receiver
  field: (field_identifier) @reference.name) @reference.read

;; ── References — field writes (obj.field = x) ──────────────────────────
(assignment_expression
  left: (field_expression
    argument: (_) @reference.receiver
    field: (field_identifier) @reference.name)) @reference.write
`;

let _parser: Parser | null = null;
let _query: Parser.Query | null = null;

export function getObjCParser(): Parser {
  if (_parser === null) {
    _parser = new Parser();
    _parser.setLanguage(
      getLanguageGrammar(SupportedLanguages.ObjectiveC) as Parameters<Parser['setLanguage']>[0],
    );
  }
  return _parser;
}

export function getObjCScopeQuery(): Parser.Query {
  if (_query === null) {
    _query = new Parser.Query(
      getLanguageGrammar(SupportedLanguages.ObjectiveC) as Parameters<Parser['setLanguage']>[0],
      OC_SCOPE_QUERY,
    );
  }
  return _query;
}
