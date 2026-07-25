/**
 * Language Detection — maps file paths to SupportedLanguages enum values.
 *
 * Shared between CLI (ingestion pipeline) and web (syntax highlighting).
 *
 * ADDING A NEW LANGUAGE:
 * 1. Add enum member to SupportedLanguages in languages.ts
 * 2. Add file extensions to EXTENSION_MAP below
 * 3. TypeScript will error if you miss either step (exhaustive Record)
 */

import { SupportedLanguages } from './languages.js';

/** Ruby extensionless filenames recognised as Ruby source */
const RUBY_EXTENSIONLESS_FILES = new Set([
  'Rakefile',
  'Gemfile',
  'Guardfile',
  'Vagrantfile',
  'Brewfile',
]);

/**
 * Exhaustive map: every SupportedLanguages member → its file extensions.
 *
 * If a new language is added to the enum without adding an entry here,
 * TypeScript emits a compile error: "Property 'NewLang' is missing in type..."
 */
const EXTENSION_MAP: Record<SupportedLanguages, readonly string[]> = {
  [SupportedLanguages.JavaScript]: ['.js', '.jsx', '.mjs', '.cjs'],
  [SupportedLanguages.TypeScript]: ['.ts', '.tsx', '.mts', '.cts'],
  [SupportedLanguages.Python]: ['.py'],
  [SupportedLanguages.Java]: ['.java'],
  [SupportedLanguages.C]: ['.c'],
  [SupportedLanguages.CPlusPlus]: [
    '.cpp',
    '.cc',
    '.cxx',
    // NOTE: '.h' intentionally omitted — ambiguous between C/C++ and Objective-C.
    // It is mapped to ObjectiveC below and disambiguated by content via
    // isOCHeaderContent() at parse time (see parse-worker).
    '.hpp',
    '.hxx',
    '.hh',
    '.cu',
    '.cuh',
  ],
  [SupportedLanguages.ObjectiveC]: ['.m', '.mm', '.h'],
  [SupportedLanguages.CSharp]: ['.cs'],
  [SupportedLanguages.Go]: ['.go'],
  [SupportedLanguages.Ruby]: ['.rb', '.rake', '.gemspec'],
  [SupportedLanguages.Rust]: ['.rs'],
  [SupportedLanguages.PHP]: ['.php', '.phtml', '.php3', '.php4', '.php5', '.php8'],
  [SupportedLanguages.Kotlin]: ['.kt', '.kts'],
  [SupportedLanguages.Swift]: ['.swift'],
  [SupportedLanguages.Dart]: ['.dart'],
  [SupportedLanguages.Vue]: ['.vue'],
  [SupportedLanguages.Cobol]: ['.cbl', '.cob', '.cpy', '.cobol'],
} satisfies Record<SupportedLanguages, readonly string[]>; // Ensure exhaustiveness

/** Pre-built reverse lookup: extension → language (built once at module load). */
const extToLang = new Map<string, SupportedLanguages>();
for (const [lang, exts] of Object.entries(EXTENSION_MAP) as [
  SupportedLanguages,
  readonly string[],
][]) {
  for (const ext of exts) {
    extToLang.set(ext, lang);
  }
}

/**
 * Laravel Blade templates are source templates whose filename convention ends
 * in `.blade.php`.  They may contain PHP snippets, but the full file is not a
 * pure PHP translation unit and must not enter the generic PHP provider path.
 */
export const isBladeTemplateFilename = (filePath: string): boolean =>
  filePath.replace(/\\/g, '/').toLowerCase().endsWith('.blade.php');

/**
 * Detect if a .h file is an Objective-C header by scanning its content
 * for OC-specific syntax patterns.
 *
 * `.h` is ambiguous: it may be a C/C++ header or an Objective-C header.
 * The extension map assigns `.h` to ObjectiveC, but at parse time we need a
 * content-based check to decide whether to route the file through the OC
 * provider or fall back to C/C++.
 *
 * Returns true when OC markers are found, OR when the content is empty/null
 * (conservative default: treat unknown content as OC so we never silently
 * drop a header that the extension map already claimed for OC).
 */
export const isOCHeaderContent = (content: string | null | undefined): boolean => {
  if (!content) return true;
  const OC_MARKERS: readonly RegExp[] = [
    /@interface\b/,
    /@implementation\b/,
    /@protocol\b/,
    /@class\b/,
    /@property\b/,
    /@synthesize\b/,
    /@dynamic\b/,
    /@selector\b/,
    /#import\b/,
    /IBOutlet\b/,
    /IBAction\b/,
    /nonatomic\b/,
    /retain\b/,
    /strong\b/,
    /weak\b/,
    /copy\b/,
    /assign\b/,
    /\bNSString\b/,
    /\bNSArray\b/,
    /\bNSDictionary\b/,
    /\bNSObject\b/,
    /\bUIColor\b/,
    /\bUIView\b/,
    /\bUIViewController\b/,
  ];
  for (const marker of OC_MARKERS) {
    if (marker.test(content)) return true;
  }
  return false;
};

/**
 * Map file extension to SupportedLanguage enum.
 * Returns null if the file extension is not recognized.
 */
export const getLanguageFromFilename = (filename: string): SupportedLanguages | null => {
  if (isBladeTemplateFilename(filename)) return null;

  // Fast path: check the extension map
  const lastDot = filename.lastIndexOf('.');
  if (lastDot >= 0) {
    const ext = filename.slice(lastDot).toLowerCase();
    const lang = extToLang.get(ext);
    if (lang !== undefined) return lang;
  }

  // Ruby extensionless files (Rakefile, Gemfile, etc.)
  const basename = filename.split('/').pop() || filename;
  if (RUBY_EXTENSIONLESS_FILES.has(basename)) {
    return SupportedLanguages.Ruby;
  }

  return null;
};

/**
 * Exhaustive map: every SupportedLanguages member → Prism syntax identifier.
 *
 * If a new language is added to the enum without adding an entry here,
 * TypeScript emits a compile error.
 */
const SYNTAX_MAP: Record<SupportedLanguages, string> = {
  [SupportedLanguages.JavaScript]: 'javascript',
  [SupportedLanguages.TypeScript]: 'typescript',
  [SupportedLanguages.Python]: 'python',
  [SupportedLanguages.Java]: 'java',
  [SupportedLanguages.C]: 'c',
  [SupportedLanguages.CPlusPlus]: 'cpp',
  [SupportedLanguages.CSharp]: 'csharp',
  [SupportedLanguages.Go]: 'go',
  [SupportedLanguages.Ruby]: 'ruby',
  [SupportedLanguages.Rust]: 'rust',
  [SupportedLanguages.PHP]: 'php',
  [SupportedLanguages.Kotlin]: 'kotlin',
  [SupportedLanguages.Swift]: 'swift',
  [SupportedLanguages.Dart]: 'dart',
  [SupportedLanguages.Vue]: 'typescript',
  [SupportedLanguages.Cobol]: 'cobol',
  [SupportedLanguages.ObjectiveC]: 'objectivec',
} satisfies Record<SupportedLanguages, string>; // Ensure exhaustiveness

/** Non-code file extensions → Prism-compatible syntax identifiers */
const AUXILIARY_SYNTAX_MAP: Record<string, string> = {
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  md: 'markdown',
  mdx: 'markdown',
  html: 'markup',
  htm: 'markup',
  erb: 'markup',
  xml: 'markup',
  css: 'css',
  scss: 'css',
  sass: 'css',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  sql: 'sql',
  toml: 'toml',
  ini: 'ini',
  dockerfile: 'docker',
};

/** Extensionless filenames → Prism-compatible syntax identifiers */
const AUXILIARY_BASENAME_MAP: Record<string, string> = {
  Makefile: 'makefile',
  Dockerfile: 'docker',
};

/**
 * Map file path to a Prism-compatible syntax highlight language string.
 * Covers all SupportedLanguages (code files) plus common non-code formats.
 * Returns 'text' for unrecognised files.
 */
export const getSyntaxLanguageFromFilename = (filePath: string): string => {
  if (isBladeTemplateFilename(filePath)) return 'markup';

  const lang = getLanguageFromFilename(filePath);
  if (lang) return SYNTAX_MAP[lang];
  const ext = filePath.split('.').pop()?.toLowerCase();
  if (ext && ext in AUXILIARY_SYNTAX_MAP) return AUXILIARY_SYNTAX_MAP[ext];
  const basename = filePath.split('/').pop() || '';
  if (basename in AUXILIARY_BASENAME_MAP) return AUXILIARY_BASENAME_MAP[basename];
  return 'text';
};
