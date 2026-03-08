export function countTokens(text: string): number {
  const charCount = [...text].length;
  if (charCount === 0) {
    return 0;
  }

  return Math.ceil(charCount / 4);
}

export function countTokensBatch(texts: string[]): number[] {
  return texts.map(countTokens);
}
