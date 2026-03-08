export function fitsInWindow(tokenCount: number, maxTokens: number): boolean {
  return tokenCount <= maxTokens;
}

export function truncateToWindow(tokens: string[], maxTokens: number): string[] {
  if (tokens.length <= maxTokens) {
    return tokens;
  }

  return tokens.slice(tokens.length - maxTokens);
}
