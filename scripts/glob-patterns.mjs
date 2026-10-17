export function matchesPathPattern(relativePath, pattern) {
  const normalizedPattern = pattern.replace(/^\.\/|\/$/gu, "");
  let source = "^";

  for (let index = 0; index < normalizedPattern.length; index += 1) {
    const character = normalizedPattern[index];

    if (character === "*" && normalizedPattern[index + 1] === "*") {
      if (normalizedPattern[index + 2] === "/") {
        source += "(?:.*/)?";
        index += 2;
      } else {
        source += ".*";
        index += 1;
      }
      continue;
    }

    if (character === "*") {
      source += "[^/]*";
      continue;
    }

    if (character === "?") {
      source += "[^/]";
      continue;
    }

    source += character.replace(/[|\\{}()[\]^$+?.]/gu, "\\$&");
  }

  return new RegExp(`${source}$`).test(relativePath);
}
