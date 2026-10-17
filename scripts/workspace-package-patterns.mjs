import { matchesPathPattern } from "./glob-patterns.mjs";

function parseInlinePackagePatterns(value, configPath) {
  let quote = null;
  let closingBracket = -1;

  for (let index = 1; index < value.length; index += 1) {
    const character = value[index];

    if (quote) {
      if (character === quote && value[index - 1] !== "\\") {
        quote = null;
      }
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
    } else if (character === "]") {
      closingBracket = index;
      break;
    }
  }

  if (closingBracket === -1 || quote) {
    throw new Error(
      `Workspace config ${configPath} has a malformed inline package list in the packages: scope.`,
    );
  }

  const trailingContent = value.slice(closingBracket + 1).trim();
  if (trailingContent && !trailingContent.startsWith("#")) {
    throw new Error(
      `Workspace config ${configPath} has unsupported content after the inline packages: list.`,
    );
  }

  const values = [];
  let current = "";
  quote = null;

  for (const character of value.slice(1, closingBracket)) {
    if (quote) {
      current += character;
      if (character === quote) {
        quote = null;
      }
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
      current += character;
    } else if (character === ",") {
      values.push(current);
      current = "";
    } else {
      current += character;
    }
  }
  values.push(current);

  return values
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const quoteMatch = item.match(/^(['"])(.*)\1$/u);
      return quoteMatch ? quoteMatch[2] : item;
    });
}

function assertSupportedWorkspacePattern(pattern, configPath) {
  const glob = pattern.startsWith("!") ? pattern.slice(1) : pattern;
  if (/[\[\]{}]|[!@+*?]\(/u.test(glob)) {
    throw new Error(
      `Workspace config ${configPath} package scope "${pattern}" uses glob syntax unsupported by frontend discovery; supported operators are *, **, ?, and leading ! exclusions.`,
    );
  }
}

export function parseWorkspacePackagePatterns(
  workspaceConfig,
  configPath = "pnpm-workspace.yaml",
) {
  const patterns = [];
  let readingPackages = false;

  for (const line of workspaceConfig.split(/\r?\n/u)) {
    if (/^packages:\s*/u.test(line)) {
      readingPackages = true;
      const inlinePackages = line.replace(/^packages:\s*/u, "").trim();
      if (inlinePackages.startsWith("[")) {
        patterns.push(...parseInlinePackagePatterns(inlinePackages, configPath));
      } else if (
        inlinePackages &&
        !inlinePackages.startsWith("#")
      ) {
        throw new Error(
          `Workspace config ${configPath} uses unsupported syntax in the packages: scope; use a block-list or inline list.`,
        );
      }
      continue;
    }

    if (!readingPackages) {
      continue;
    }

    if (/^\S/u.test(line) && !/^\s*#/u.test(line)) {
      break;
    }

    const match = line.match(/^\s*-\s+(?:"([^"]+)"|'([^']+)'|([^#\s]+))/u);
    if (match) {
      patterns.push(match[1] ?? match[2] ?? match[3]);
    } else if (line.trim() && !line.trim().startsWith("#")) {
      throw new Error(
        `Workspace config ${configPath} has unsupported content in the packages: scope: "${line.trim()}".`,
      );
    }
  }

  if (patterns.length === 0) {
    throw new Error(
      `Workspace config ${configPath} has no supported workspace package patterns in its packages: scope.`,
    );
  }

  for (const pattern of patterns) {
    assertSupportedWorkspacePattern(pattern, configPath);
  }

  return patterns;
}

export function matchesWorkspacePackagePattern(relativePath, pattern) {
  return matchesPathPattern(relativePath, pattern);
}

export function matchesWorkspacePackageScopes(relativePath, patterns) {
  const positivePatterns = patterns.filter(
    (pattern) => !pattern.startsWith("!"),
  );
  const negativePatterns = patterns
    .filter((pattern) => pattern.startsWith("!"))
    .map((pattern) => pattern.slice(1));

  return (
    positivePatterns.some((pattern) =>
      matchesWorkspacePackagePattern(relativePath, pattern),
    ) &&
    !negativePatterns.some((pattern) =>
      matchesWorkspacePackagePattern(relativePath, pattern),
    )
  );
}

export function describeWorkspacePackageScopes(configPath, patterns) {
  return `Workspace config ${configPath} package scopes: ${patterns.join(", ")}.`;
}

export function describeNoFrontendDiscovery(configPath, patterns, dependency) {
  return `No frontend workspace package declares a dependency on ${dependency}. ${describeWorkspacePackageScopes(
    configPath,
    patterns,
  )}`;
}
