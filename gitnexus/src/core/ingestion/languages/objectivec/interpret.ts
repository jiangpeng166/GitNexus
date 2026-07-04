/**
 * Capture-match → semantic-shape interpreters for Objective-C.
 *
 *   - `interpretObjCTypeBinding`  → `ParsedTypeBinding`
 *
 * Type-binding matches arrive from `synthesizeObjCTypeBindings` in captures.ts.
 * Each `@type-binding.*` anchor carries `@type-binding.name` + `@type-binding.type`.
 *
 * OC type normalization:
 *   UITableViewCell *   → UITableViewCell  (strip pointer)
 *   NSArray<UIView *>    → UIView           (strip single-arg generic wrapper)
 *   nullable NSString *  → NSString         (strip nullable/nonnull qualifiers + pointer)
 *   id<Protocol>         → null             (id is uninformative, skip)
 *   void                 → null             (void return has no receiver)
 *   instancetype         → null             (handled at synthesis level: replaced with class name)
 */

import type { CaptureMatch, ParsedTypeBinding, TypeRef } from 'gitnexus-shared';

// ─── interpretTypeBinding ──────────────────────────────────────────────────

export function interpretObjCTypeBinding(captures: CaptureMatch): ParsedTypeBinding | null {
  const nameCap = captures['@type-binding.name'];
  const typeCap = captures['@type-binding.type'];
  if (nameCap === undefined || typeCap === undefined) return null;

  const rawTypeText = typeCap.text.trim();

  // OC type normalization chain (order matters: nullable before pointer)
  const rawType = stripQualifier(
    stripObjCGeneric(
      stripObjCNullable(
        stripObjCPointer(rawTypeText),
      ),
    ),
  );

  // Skip uninformative types
  if (
    rawType === 'void' ||
    rawType === 'id' ||
    rawType === 'instancetype' ||
    rawType === 'Class' ||
    rawType === 'SEL' ||
    rawType === 'IMP' ||
    rawType === 'BOOL' ||
    rawType === ''
  ) {
    return null;
  }

  // Determine source from anchor capture
  let source: TypeRef['source'] = 'parameter-annotation';
  if (captures['@type-binding.self'] !== undefined) source = 'self';
  else if (captures['@type-binding.constructor'] !== undefined) source = 'constructor-inferred';
  else if (captures['@type-binding.annotation'] !== undefined) source = 'annotation';
  else if (captures['@type-binding.return'] !== undefined) source = 'return-annotation';

  return { boundName: nameCap.text, rawTypeName: rawType, source };
}

// ─── Type normalization helpers ────────────────────────────────────────────

/** `UITableViewCell *` → `UITableViewCell`. Also handles `UITableViewCell **`. */
function stripObjCPointer(text: string): string {
  // Remove trailing pointer stars and whitespace
  const result = text.replace(/\s*\*+\s*$/, '').trim();
  // Also handle middle stars: `NSObject * <Protocol>` won't have middle stars,
  // but `unsigned char *` might — strip trailing only
  return result;
}

/** `nullable NSString *` / `_Nullable NSString *` / `__nonnull NSString *` → `NSString *`
 *  Strip the nullable/nonnull qualifier prefix before pointer stripping happens.
 */
function stripObjCNullable(text: string): string {
  return text
    .replace(/^(?:nullable|nonnull|_Nullable|_Nonnull|__nullable|__nonnull|__null_unspecified|NULLABLE|NONNULL)\s+/, '')
    .trim();
}

/** `NSArray<UIView *>` → `UIView`. Single-argument generic wrappers only.
 *  Multi-arg generics like `NSDictionary<K, V>` are left alone.
 */
function stripObjCGeneric(text: string): string {
  // Match: CollectionType<SingleArg> — extract the single argument
  const singleArgMatch = text.match(
    /^(?:NSArray|NSMutableArray|NSSet|NSMutableSet|NSOrderedSet|NSMutableOrderedSet|Array|Optional|Set|ContiguousArray)<([^,>]+)>$/,
  );
  if (singleArgMatch !== null) {
    let inner = singleArgMatch[1].trim();
    // Strip pointer from inner type too: `UIView *` → `UIView`
    inner = inner.replace(/\s*\*+\s*$/, '').trim();
    return inner;
  }
  return text;
}

/** `UIKit.UIViewController` → `UIViewController`. Strip qualifier prefix. */
function stripQualifier(text: string): string {
  const lastDot = text.lastIndexOf('.');
  if (lastDot === -1) return text;
  return text.slice(lastDot + 1);
}
