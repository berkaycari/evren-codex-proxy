export interface TokenEstimate {
  tokens: number;
  approximate: true;
  method: "utf8-bytes-divided-by-3";
}

export function estimateInputTokens(text: string): TokenEstimate {
  // Conservative for mixed code/Turkish/English compared with the common chars/4 heuristic.
  return {
    tokens: Math.ceil(Buffer.byteLength(text, "utf8") / 3),
    approximate: true,
    method: "utf8-bytes-divided-by-3",
  };
}
