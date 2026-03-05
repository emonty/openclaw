/**
 * Check if a Gerrit project matches a list of project patterns.
 * Supports exact match and trailing glob ("wandertracks/*").
 */
export function matchesProject(project: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    if (pattern === "*") return true;
    if (pattern.endsWith("/*")) {
      const prefix = pattern.slice(0, -2);
      if (project === prefix || project.startsWith(`${prefix}/`)) {
        return true;
      }
    } else if (project === pattern) {
      return true;
    }
  }
  return false;
}
