const SECTION_PATH_REGEX = /^[a-z0-9_-]+(?:\/[a-z0-9_-]+)*$/;

export function validateSectionPath(path: string): boolean {
  return SECTION_PATH_REGEX.test(path);
}

export function assertSectionPath(path: string): void {
  if (!validateSectionPath(path)) {
    throw new Error(`Invalid section path: "${path}". Must match [a-z0-9_-]+(/[a-z0-9_-]+)*`);
  }
}
