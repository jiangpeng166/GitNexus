/**
 * Language Provider Registry — compile-time exhaustive provider table.
 *
 * To add a new language:
 * 1. Add enum member to SupportedLanguages
 * 2. Create `languages/<lang>.ts` exporting a LanguageProvider
 * 3. Add one line to the `providers` table below
 * 4. Run `tsc --noEmit` to verify
 */

import { SupportedLanguages, isBladeTemplateFilename, isOCHeaderContent } from 'gitnexus-shared';
import type { LanguageProvider } from '../language-provider.js';

import { typescriptProvider, javascriptProvider } from './typescript.js';
import { pythonProvider } from './python.js';
import { javaProvider } from './java.js';
import { kotlinProvider } from './kotlin.js';
import { goProvider } from './go.js';
import { rustProvider } from './rust.js';
import { csharpProvider } from './csharp.js';
import { cProvider, cppProvider } from './c-cpp.js';
import { phpProvider } from './php.js';
import { rubyProvider } from './ruby.js';
import { swiftProvider } from './swift.js';
import { dartProvider } from './dart.js';
import { vueProvider } from './vue.js';
import { cobolProvider } from './cobol.js';
import { objectivecProvider } from './objectivec.js';

export const providers = {
  [SupportedLanguages.JavaScript]: javascriptProvider,
  [SupportedLanguages.TypeScript]: typescriptProvider,
  [SupportedLanguages.Python]: pythonProvider,
  [SupportedLanguages.Java]: javaProvider,
  [SupportedLanguages.Kotlin]: kotlinProvider,
  [SupportedLanguages.Go]: goProvider,
  [SupportedLanguages.Rust]: rustProvider,
  [SupportedLanguages.CSharp]: csharpProvider,
  [SupportedLanguages.C]: cProvider,
  [SupportedLanguages.CPlusPlus]: cppProvider,
  [SupportedLanguages.PHP]: phpProvider,
  [SupportedLanguages.Ruby]: rubyProvider,
  [SupportedLanguages.Swift]: swiftProvider,
  [SupportedLanguages.Dart]: dartProvider,
  [SupportedLanguages.Vue]: vueProvider,
  [SupportedLanguages.Cobol]: cobolProvider,
  [SupportedLanguages.ObjectiveC]: objectivecProvider,
} satisfies Record<SupportedLanguages, LanguageProvider>;

/** Get provider by language enum (always succeeds for SupportedLanguages). */
export function getProvider(language: SupportedLanguages): LanguageProvider {
  return providers[language];
}

/** Pre-built extension → provider lookup (built once at module load). */
const extensionMap = new Map<string, LanguageProvider>();
for (const provider of Object.values(providers)) {
  for (const ext of provider.extensions) {
    extensionMap.set(ext, provider);
  }
}

/** Look up a language provider from a file path by extension.
 *  Returns null if the file extension is not recognized.
 *  For .h files, performs content-based classification — when `content` is
 *  supplied and the header does NOT contain Objective-C markers, falls back
 *  to the C/C++ provider instead of ObjectiveC. */
export function getProviderForFile(
  filePath: string,
  content?: string | null,
): LanguageProvider | null {
  if (isBladeTemplateFilename(filePath)) return null;

  const lastDot = filePath.lastIndexOf('.');
  const ext = lastDot >= 0 ? filePath.slice(lastDot).toLowerCase() : '';
  const basename = filePath.slice(filePath.lastIndexOf('/') + 1);
  let provider = extensionMap.get(ext) ?? extensionMap.get(basename) ?? null;

  // .h file smart classification: the extension map assigns `.h` to ObjectiveC
  // (see language-detection.ts), but `.h` is ambiguous between OC and C/C++.
  // When the caller passes file content, sniff it: only route to ObjectiveC if
  // OC markers are found; otherwise fall back to C/C++.
  if (filePath.endsWith('.h') && provider === objectivecProvider && content != null) {
    if (!isOCHeaderContent(content)) {
      provider = cppProvider;
    }
  }
  return provider;
}
