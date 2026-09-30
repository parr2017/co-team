/**
 * OC 活动会话聚合（跨实例）：OC tab 角标、OC 首页活动横幅、活动会话直达弹层的共享数据源。
 * 单例轮询（12s，仅页面可见时），App 挂角标即常驻；视图直接读状态、下拉时调 refresh() 立即拉。
 * busy 口径 = /session-statuses 里 type 非 idle 的会话。
 */
import { computed, ref } from 'vue';
import { api, type OcInstance, type OcSession } from '../api';

export interface OcBusySession {
  instance: string;
  instanceLabel: string;
  sessionID: string;
  title: string;
  directory: string;
  updatedAt: number;
}

/** 归一化目录（反斜杠→正斜杠、去尾斜杠、小写）——项目归属判断的唯一口径 */
export function normDir(d?: string): string {
  return String(d || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

export function dirBase(d: string): string {
  const uni = String(d || '').replace(/\\/g, '/');
  const seg = uni.split('/').filter(Boolean);
  return seg.length ? seg[seg.length - 1] : String(d || '');
}

const instances = ref<OcInstance[]>([]);
const sessionsByInst = ref<Map<string, OcSession[]>>(new Map());
const busyByInst = ref<Map<string, Set<string>>>(new Map());
const loaded = ref(false);
let timer: number | undefined;
let inFlight = false;

async function poll(): Promise<void> {
  if (inFlight || document.visibilityState !== 'visible') return;
  inFlight = true;
  try {
    const d = await api.ocInstances();
    instances.value = d.instances || [];
    const live = instances.value.filter((i) => i.enabled && (i.state === 'connected' || i.state === 'running'));
    const nextSessions = new Map<string, OcSession[]>();
    const nextBusy = new Map<string, Set<string>>();
    await Promise.all(live.map(async (inst) => {
      const [sess, st] = await Promise.all([
        api.ocSessions(inst.id).catch(() => ({ sessions: [] as OcSession[] })),
        api.ocSessionStatuses(inst.id).catch(() => ({ statuses: {} as Record<string, { type: string }> })),
      ]);
      nextSessions.set(inst.id, sess.sessions || []);
      const busy = new Set<string>();
      for (const [sid, v] of Object.entries(st.statuses || {})) {
        if (String(v?.type || '') !== 'idle') busy.add(sid);
      }
      nextBusy.set(inst.id, busy);
    }));
    sessionsByInst.value = nextSessions;
    busyByInst.value = nextBusy;
    loaded.value = true;
  } catch { /* 软失败：下一拍再拉 */ } finally {
    inFlight = false;
  }
}

/** busy 会话展开为可点行（按最近更新排序） */
const busyList = computed<OcBusySession[]>(() => {
  const out: OcBusySession[] = [];
  for (const [instId, ids] of busyByInst.value) {
    if (!ids.size) continue;
    const inst = instances.value.find((i) => i.id === instId);
    const label = String(inst?.label || instId);
    for (const s of sessionsByInst.value.get(instId) || []) {
      if (!ids.has(String(s.id))) continue;
      const t = (s.time || {}) as Record<string, unknown> | undefined;
      out.push({
        instance: instId,
        instanceLabel: label,
        sessionID: String(s.id),
        title: String(s.title || '（未命名会话）'),
        directory: String(s.directory || ''),
        updatedAt: Number(t?.updated || t?.created || 0),
      });
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
});

const busyCount = computed(() => busyList.value.length);

/** 项目聚合（OC 首页卡片）：normDir 归组，busy 数与最近会话一并算好 */
export interface OcProjectCard {
  dir: string;
  name: string;
  instances: OcInstance[];
  busyCount: number;
  lastTitle: string;
  lastUpdated: number;
  sessionCount: number;
}

const projects = computed<OcProjectCard[]>(() => {
  const map = new Map<string, OcProjectCard>();
  for (const [instId, list] of sessionsByInst.value) {
    const inst = instances.value.find((i) => i.id === instId);
    for (const s of list) {
      const dir = normDir(s.directory);
      if (!dir) continue;
      let card = map.get(dir);
      if (!card) {
        card = { dir, name: dirBase(dir), instances: [], busyCount: 0, lastTitle: '', lastUpdated: 0, sessionCount: 0 };
        map.set(dir, card);
      }
      if (!card.instances.some((i) => i.id === instId)) card.instances.push(inst!);
      card.sessionCount += 1;
      const t = s.time as Record<string, unknown> | undefined;
      const ts = Number(t?.updated || t?.created || 0);
      if (ts > card.lastUpdated) {
        card.lastUpdated = ts;
        card.lastTitle = String(s.title || '（未命名会话）');
      }
    }
  }
  const cards = [...map.values()];
  for (const card of cards) {
    card.busyCount = busyList.value.filter((b) => normDir(b.directory) === card.dir).length;
  }
  return cards.sort((a, b) => b.lastUpdated - a.lastUpdated);
});

export function useOcBusy() {
  if (timer === undefined) {
    void poll();
    timer = window.setInterval(poll, 12_000);
  }
  return { instances, busyList, busyCount, projects, sessionsByInst, loaded, refresh: poll };
}

export function relTime(ts: number): string {
  if (!ts) return '';
  const diff = Date.now() - ts;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return Math.floor(diff / 60_000) + ' 分钟前';
  if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + ' 小时前';
  if (diff < 7 * 86_400_000) return Math.floor(diff / 86_400_000) + ' 天前';
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}
