/**
 * 一次性工具：把一张"验收用"的 OpenCode 权限卡真发到飞书（卡片构造与线上一模一样）。
 * 目的：验证租户是否接受 collapsible_panel 折叠面板——渲染层单测证明不了这一点。
 * 用法：node scripts/send-oc-perm-card-preview.cjs
 */
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

async function main() {
  const { loadConfig } = require(path.join(ROOT, 'server/dist/config.js'));
  const { initBus, busGet, closeBus } = require(path.join(ROOT, 'server/dist/bus.js'));
  const { buildOcPermissionCard } = require(path.join(ROOT, 'server/dist/feishu/ocBridge.js'));
  const { sendCard } = require(path.join(ROOT, 'server/dist/feishu/messageService.js'));
  const cfg = loadConfig(ROOT);
  await initBus(cfg.redis);

  const saved = await busGet('feishu:oc:notify_chat');
  const chatId = saved?.chat_id || (cfg.feishu?.approvers || [])[0];
  if (!chatId) {
    console.log('找不到通知落点（feishu:oc:notify_chat 为空且无 approvers）——先在飞书里 /oc 一次。');
    process.exit(1);
  }
  console.log('落点：', chatId, saved?.chat_id ? '(feishu:oc:notify_chat)' : '(approvers 私聊)');

  // 载荷形状 = 实盘 permission.asked（2.x）；8 条资源触发折叠面板分支
  const perm = {
    instance: 'desktop',
    id: 'per_preview_only',
    sessionID: 'ses_f1af29bbeffeLM333ibG510SCJ',
    action: 'bash',
    resources: [
      'npm run build --workspace @co-team/server',
      'npm run build --workspace @co-team/web',
      'npm run build --workspace @co-team/mobile',
      'npm run build --workspace @co-team/opencode-sync',
      'git push origin devoc',
      'rm -rf node_modules/.cache',
      'node scripts/migrate.ts --dry-run',
      'python -m pytest tests/ -x -q',
    ],
    save: ['npm run build *'],
    metadata: { tool: 'bash', note: '验收卡：内容为构造样例，不是真实待批请求' },
  };
  const card = buildOcPermissionCard(perm, {
    instance: 'desktop',
    instanceLabel: '桌面版 / TUI（验收卡）',
    sessionId: perm.sessionID,
    sessionTitle: 'AI中台能力与短板分析',
    directory: 'D:\\pxx\\VIZAInUse\\viza-ai-service',
  });

  const messageId = await sendCard(cfg, chatId, card, saved?.chat_id ? 'chat_id' : 'open_id');
  if (messageId) {
    console.log('✅ 飞书已接受该卡，message_id =', messageId, '（折叠面板在你的租户可用）');
  } else {
    console.log('❌ 飞书拒了整卡（多半是 collapsible_panel 不被支持）——看服务端日志里的 code/msg。');
  }
  closeBus();
  process.exit(messageId ? 0 : 2);
}

main().catch((e) => { console.error('失败：', e); process.exit(1); });
