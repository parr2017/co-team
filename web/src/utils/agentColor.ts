/** 与 AgentAvatar 同源的稳定配色：按 agent 名散列出颜色，用于气泡名字/边条着色。
 *  avatar 用 class 名，这里给出等价 hex（launcher/front-dev 等名字两端表现一致）。 */

const FRAG_COLORS: [string, string][] = [
  ['dev', '#178a3e'],
  ['test', '#b8860b'],
  ['review', '#7c53c4'],
  ['deploy', '#cc7a29'],
  ['docs', '#0e8fa3'],
  ['refactor', '#c4548f'],
  ['launcher', '#2f6fed'],
  ['grader', '#c4548f'],
];

const PALETTE = ['#178a3e', '#b8860b', '#7c53c4', '#cc7a29', '#0e8fa3', '#c4548f', '#2f6fed', '#8a6d3b'];

export function agentColor(name: string): string {
  const key = (name || '').toLowerCase();
  for (const [frag, hex] of FRAG_COLORS) {
    if (key.includes(frag)) return hex;
  }
  let hash = 0;
  for (const ch of name || '') hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[hash % PALETTE.length];
}
