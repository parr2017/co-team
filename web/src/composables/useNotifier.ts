// 桌面通知：监听任务状态跃迁（完成/失败/待审批/需澄清），浏览器 Notification + 页内提示。
// 服务端事件流已含全部所需信号，无需后端改动。
import { ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { useDashboard, onEvent } from './useDashboard';

const KEY = 'ct-desktop-notify';
const enabled = ref(typeof localStorage !== 'undefined' && localStorage.getItem(KEY) === '1');

export function useNotifier() {
  const { tasks } = useDashboard();

  async function setEnabled(v: boolean): Promise<boolean> {
    if (v && typeof Notification !== 'undefined' && Notification.permission !== 'granted') {
      try {
        const p = await Notification.requestPermission();
        if (p !== 'granted') {
          ElMessage.warning('浏览器未授权桌面通知，无法开启');
          return false;
        }
      } catch {
        return false;
      }
    }
    enabled.value = v;
    try { localStorage.setItem(KEY, v ? '1' : '0'); } catch { /* ignore */ }
    return true;
  }

  function fire(title: string, body: string) {
    if (!enabled.value) return;
    ElMessage({ message: `${title} · ${body}`, type: 'info', duration: 6000, grouping: true });
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      try { new Notification(`co-team · ${title}`, { body, tag: `ct-${title}-${body}` }); } catch { /* ignore */ }
    }
  }

  // 状态跃迁检测：首见任务只建档不通知，之后每次变化检查是否值得提醒
  const prev = new Map<string, string>();
  watch(
    () => Object.entries(tasks).map(([id, t]) => `${id}:${t.status}`),
    (entries) => {
      for (const entry of entries) {
        const idx = entry.lastIndexOf(':');
        const id = entry.slice(0, idx);
        const status = entry.slice(idx + 1);
        const before = prev.get(id);
        prev.set(id, status);
        if (!before || before === status) continue;
        const t = tasks[id];
        const name = (t?.description || id).slice(0, 48);
        if (status === 'completed' || status === 'success') fire('任务完成', name);
        else if (status === 'failed') fire('任务失败', name);
        else if (status === 'waiting_approval') fire('等待审批', name);
        else if (status === 'clarifying') fire('需要澄清', name);
      }
    }
  );

  // 群组沟通：成员需要用户拍板 / 方案转项目成功 → 值得打断提醒
  onEvent((msg) => {
    const p: Record<string, any> = msg.payload || {};
    if (msg.type === 'discussion_ask_user') fire('讨论待你拍板', `${p.agent || ''}：${String(p.question || '').slice(0, 60)}`);
    else if (msg.type === 'discussion_converted') fire('方案已转项目开发', `项目 ${p.project_id} · 任务 ${p.task_id}`);
    // 群聊化：任务执行中 agent 对你的插话作出直接回应 → 值得打断（送达回执不弹，防打扰）
    else if (msg.type === 'agent_message' && p.direct && p.to === 'user') fire(`${p.agent} 回复了你`, '到作战室查看回应');
  });

  return { enabled, setEnabled };
}
