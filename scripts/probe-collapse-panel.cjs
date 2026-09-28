/** 一次性探针：逐个试 collapsible_panel 的字段组合，打印飞书完整报错；成功后自删消息。 */
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const { loadConfig } = require(path.join(ROOT, 'server/dist/config.js'));
const { initBus, busGet, closeBus } = require(path.join(ROOT, 'server/dist/bus.js'));
const { apiBase, getTenantToken } = require(path.join(ROOT, 'server/dist/feishu/tokenManager.js'));

const T = { tag: 'plain_text', content: '展开' };
const M = { tag: 'markdown', content: '内容' };
const variants = [
  ['A 最小', { tag: 'collapsible_panel', header: { title: T }, elements: [M] }],
  ['E +border', { tag: 'collapsible_panel', header: { title: T }, border: { color: 'grey', corner_radius: '6px' }, elements: [M] }],
  ['F +bg', { tag: 'collapsible_panel', header: { title: T, background_color: 'grey' }, elements: [M] }],
  ['G +valign', { tag: 'collapsible_panel', header: { title: T, vertical_align: 'center' }, elements: [M] }],
  ['H +padding', { tag: 'collapsible_panel', header: { title: T, padding: '6px 10px' }, elements: [M] }],
  ['I 全字段(无 expand)', { tag: 'collapsible_panel', header: { title: T, background_color: 'grey', vertical_align: 'center', padding: '6px 10px' }, border: { color: 'grey', corner_radius: '6px' }, elements: [M] }],
];

async function main() {
  const cfg = loadConfig(ROOT);
  await initBus(cfg.redis);
  const chatId = (await busGet('feishu:oc:notify_chat')).chat_id;
  const token = await getTenantToken(cfg);
  const sent = [];
  for (const [name, panel] of variants) {
    const card = { schema: '2.0', header: { title: { tag: 'plain_text', content: `探针 ${name}` }, template: 'grey' }, body: { elements: [{ tag: 'markdown', content: name }, panel] } };
    const res = await fetch(`${apiBase(cfg)}/open-apis/im/v1/messages?receive_id_type=chat_id`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ receive_id: chatId, msg_type: 'interactive', content: JSON.stringify(card) }),
    });
    const data = await res.json().catch(() => ({}));
    const id = data?.data?.message_id;
    if (id) sent.push(id);
    console.log(`${name}: code=${data.code ?? res.status} ${String(data.msg || '').slice(0, 260)}`);
    await new Promise((r) => setTimeout(r, 300));
  }
  for (const id of sent) {
    await fetch(`${apiBase(cfg)}/open-apis/im/v1/messages/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
  }
  console.log(`已撤回 ${sent.length} 条探针消息`);
  closeBus();
}
main().catch((e) => { console.error(e); process.exit(1); });
