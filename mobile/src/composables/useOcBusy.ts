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

/**
 * 会话去重与归属（2026-10-01）：opencode 2.x 的会话库是全机共享的（~/.local/share/opencode），
 * 桌面版与托管实例两个进程返回同一份会话列表——按实例逐个聚合会把每条会话出两遍。
 * 去重后归属实例的优先级：正在跑它的实例（busy 归属，abort/prompt 必须打到该进程）>
 * project_root 匹配的实例 > 配置顺序里第一个在线实例。
 */
const sessionRows = computed<OcSessionRow[]>(() => {
  const busyOwner = new Map<string, string>();
  for (const [instId, ids] of busyByInst.value) {
    for (const sid of ids) if (!busyOwner.has(sid)) busyOwner.set(sid, instId);
  }
  const live = instances.value.filter((i) => i.enabled && (i.state === 'connected' || i.state === 'running'));
  const bySid = new Map<string, { s: OcSession; instId: string }>();
  for (const inst of live) {
    for (const s of sessionsByInst.value.get(inst.id) || []) {
      const sid = String(s.id);
      const prev = bySid.get(sid);
      if (!prev) {
        bySid.set(sid, { s, instId: inst.id });
        continue;
      }
      if (busyOwner.get(sid) === inst.id) { prev.instId = inst.id; continue; }
      if (busyOwner.get(sid) === prev.instId) continue;
      if (normDir(inst.project_root) === normDir(String(s.directory || ''))) prev.instId = inst.id;
    }
  }
  const rows: OcSessionRow[] = [];
  for (const [sid, { s, instId }] of bySid) {
    const inst = instances.value.find((i) => i.id === instId);
    const t = (s.time || {}) as Record<string, unknown>;
    rows.push({
      instId,
      instLabel: String(inst?.label || instId),
      id: sid,
      title: String(s.title || ''),
      directory: String(s.directory || ''),
      parentID: s.parentID ? String(s.parentID) : undefined,
      updatedAt: Number(t.updated || t.created || 0),
      busy: busyOwner.get(sid) === instId,
    });
  }
  return rows.sort((a, b) => b.updatedAt - a.updatedAt);
});

const busyList = computed<OcBusySession[]>(() => {
  const rows = sessionRows.value.filter((r) => r.busy);
  return rows.map((r) => ({
    instance: r.instId,
    instanceLabel: r.instLabel,
    sessionID: r.id,
    title: r.title || '（未命名会话）',
    directory: r.directory,
    updatedAt: r.updatedAt,
  }));
});

const busyCount = computed(() => busyList.value.length);

/** 项目聚合（OC 首页卡片）：去重后的会话按 normDir 归组，busy 数与最近会话一并算好 */
export interface OcProjectCard {
  dir: string;
  name: string;
  instanceLabels: string[];
  busyCount: number;
  lastTitle: string;
  lastUpdated: number;
  sessionCount: number;
}

const projects = computed<OcProjectCard[]>(() => {
  const map = new Map<string, OcProjectCard>();
  for (const r of sessionRows.value) {
    const dir = normDir(r.directory);
    if (!dir) continue;
    let card = map.get(dir);
    if (!card) {
      card = { dir, name: dirBase(dir), instanceLabels: [], busyCount: 0, lastTitle: '', lastUpdated: 0, sessionCount: 0 };
      map.set(dir, card);
    }
    if (!card.instanceLabels.includes(r.instLabel)) card.instanceLabels.push(r.instLabel);
    card.sessionCount += 1;
    if (r.updatedAt > card.lastUpdated) {
      card.lastUpdated = r.updatedAt;
      card.lastTitle = r.title || '（未命名会话）';
    }
  }
  const cards = [...map.values()];
  for (const card of cards) {
    card.busyCount = busyList.value.filter((b) => normDir(b.directory) === card.dir).length;
  }
  return cards.sort((a, b) => b.lastUpdated - a.lastUpdated);
});

/** 去重后的全会话行（归属实例已定）——项目会话列表页直接消费 */
export interface OcSessionRow { instId: string; instLabel: string; id: string; title: string; directory: string; parentID?: string; updatedAt: number; busy: boolean }

export function useOcBusy() {
  if (timer === undefined) {
    void poll();
    timer = window.setInterval(poll, 12_000);
  }
  return { instances, busyList, busyCount, projects, sessionRows, loaded, refresh: poll };
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
