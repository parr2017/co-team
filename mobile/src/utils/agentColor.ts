/** 与 AgentAvatar 同源的稳定配色（镜像 web/src/utils/agentColor.ts）：
 *  按 agent 名散列颜色，用于气泡角色名着色，双端一致。 */

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
