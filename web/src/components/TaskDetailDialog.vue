<template>
  <el-dialog :model-value="modelValue" title="任务详情" width="94%" style="max-width: 1320px" top="3vh" @open="onOpen" @close="onClose">
    <div v-if="task" class="detail">
      <!-- 顶部任务元信息 -->
      <div class="meta">
        <div class="meta-main">
          <div class="desc">{{ task.description || task.task_id }}</div>
          <div class="mono meta-sub">
            {{ task.task_id }} · {{ task.workspace }} ·
            {{ completedCount }}/{{ task.nodes.length }} 节点
            <template v-if="taskTokens"> · {{ fmtTok(taskTokens) }} tok</template>
            <template v-if="taskCostEstimate"> · ≈${{ taskCostEstimate.toFixed(4) }}（估算）</template>
            <template v-if="task.git_commit"> · ⎇ {{ task.git_commit.branch }}</template>
          </div>
        </div>
        <div class="progress">
          <div class="progress-fill" :style="{ width: progressPct + '%' }"></div>
        </div>
      </div>

      <!-- A3/A2/A1: 验收合并 · 协同文档 · 实时产出 -->
      <div class="meta-actions">
        <el-button v-if="task.status === 'success'" size="small" type="primary" :loading="merging" @click="onMergePreview">⎇ 合并到主分支</el-button>
        <el-button size="small" @click="openDocs">📘 协同文档</el-button>
        <el-button size="small" @click="openOutput">📂 实时产出</el-button>
        <span v-if="mergeMsg" class="mono merge-msg" :class="{ ok: mergeOk }">{{ mergeMsg }}</span>
      </div>

      <el-tabs v-model="tab">
        <!-- 任务频道：阶段 + 轨道 + 检视器（成员会话 / 节点详情） -->
        <el-tab-pane label="任务频道" name="warroom">
          <div class="stage-banner">
            <div class="st-steps">
              <template v-for="(s, i) in STAGE_STEPS" :key="s">
                <div class="st-step" :class="{ done: stageStep > i, active: stageStep === i, failed: stageFailed && i === STAGE_STEPS.length - 1 }">
                  <span class="st-dot mono">{{ stageStep > i ? '✓' : i + 1 }}</span>
                  <span class="st-label">{{ s }}</span>
                </div>
                <span v-if="i < STAGE_STEPS.length - 1" class="st-link" :class="{ passed: stageStep > i }"></span>
              </template>
            </div>
            <div class="st-body">
              <div class="st-text mono">
                <span class="st-state" :class="task.status">{{ stageLabel }}</span>
                <span>{{ completedCount }}/{{ task.nodes.length }} 节点</span>
                <template v-if="progressEta !== null"><span>预计剩余 {{ progressEta }} 分钟</span></template>
              </div>
              <div class="st-progress"><div class="fill" :style="{ width: progressPct + '%' }"></div></div>
              <div v-if="progress?.current_nodes?.length" class="st-current">
                <span class="st-current-label">正在执行</span>
                <el-tag v-for="n in progress.current_nodes" :key="n.id" size="small" type="warning">{{ n.name }} · {{ n.agent }}</el-tag>
              </div>
            </div>
          </div>

          <!-- feature: 实施前澄清 —— 任务被简报门拦下时，在此快速确认 -->
          <div v-if="clarifyNode" class="clarify-card">
            <div class="cl-head mono">
              <span class="cl-title">实施前澄清 · {{ clarifyNode.name }}</span>
              <span class="cl-mode">{{ clarifyState?.mode === 'confirm' ? '需确认' : '实施简报' }}</span>
            </div>
            <div v-if="clarifyState" class="cl-body">
              <div class="cl-line"><span class="mini-label">思路</span>{{ clarifyState.brief?.approach }}</div>
              <div v-if="clarifyState.brief?.files?.length" class="cl-line"><span class="mini-label">改动</span>{{ clarifyState.brief.files.join('、') }}</div>
              <div v-if="clarifyState.brief?.risks?.length" class="cl-line"><span class="mini-label">风险</span>{{ clarifyState.brief.risks.join('；') }}</div>
              <div v-for="(q, i) in clarifyState.brief?.questions || []" :key="i" class="cl-q mono">Q{{ i + 1 }}. {{ q }}</div>
              <el-input v-model="clarifyAnswer" size="small" type="textarea" :rows="2" placeholder="补充说明（可选）：范围取舍、方案偏好、约束…" />
              <div class="cl-ops">
                <el-button size="small" type="primary" :loading="clarifying" @click="confirmClarify(true)">确认，开始实施</el-button>
                <el-button size="small" :disabled="!clarifyAnswer.trim()" :loading="clarifying" @click="confirmClarify(false)">带说明继续</el-button>
              </div>
            </div>
            <div v-else class="cl-body mono">加载简报中…</div>
          </div>

          <div class="warroom">
            <div class="wr-left">
              <div class="member-chips">
                <button class="m-chip mono" :class="{ active: wrView === 'chat' && !selectedAgent }" @click="pickMember('')">全体</button>
                <button
                  v-for="m in members"
                  :key="m.name"
                  class="m-chip mono"
                  :class="{ active: wrView === 'chat' && selectedAgent === m.name, running: m.running }"
                  @click="pickMember(m.name)"
                >
                  <span class="m-dot" :class="{ on: m.running }"></span>{{ m.name }}
                </button>
              </div>
              <PipelineTrack :nodes="task.nodes" :selected-id="selectedNodeId" @select="selectNodeId" />
              <div v-if="branches.length" class="branches mono">
                <div class="sub-title mono">branches</div>
                <div v-for="b in branches" :key="b.name" class="branch-row">
                  <span class="b-name">{{ b.name }}</span>
                  <span class="b-commit">{{ b.commit }}</span>
                </div>
              </div>
              <div class="wr-hint mono">点击节点查看详情与代码变更 · 点击成员切换会话</div>
            </div>
            <div class="wr-right">
              <div class="wr-switch">
                <button class="sw-btn mono" :class="{ active: wrView === 'chat' }" @click="wrView = 'chat'">成员会话</button>
                <button class="sw-btn mono" :class="{ active: wrView === 'node' }" :disabled="!selected" @click="wrView = 'node'">节点详情</button>
                <span v-if="wrView === 'node' && selected" class="sw-cur mono">{{ selected.name }}</span>
              </div>

              <!-- 成员会话视图 -->
              <template v-if="wrView === 'chat'">
                <div class="live-head mono">
                  <span class="live-agent">{{ selectedAgent || '全体成员' }}</span>
                  <span v-if="selectedLive?.model" class="live-model">{{ selectedLive.model }}</span>
                  <span v-if="selectedLive?.currentAction" class="live-action">{{ selectedLive.currentAction }}</span>
                </div>
                <div class="live-chat">
                  <ChatStream :task-id="taskId" :filter-agent="selectedAgent || undefined" />
                </div>
                <InterventionBar :task-id="taskId" :task-status="task.status" />
              </template>

              <!-- 节点详情视图 -->
              <div v-else-if="selected" class="node-view">
                <div class="node-head mono">
                  <span class="n-status" :class="selected.status">{{ statusText(selected.status) }}</span>
                  <span class="n-name">{{ selected.name }}</span>
                  <span class="n-meta">[{{ selected.agent }}]{{ selected.branch ? ' ⎇' + selected.branch : '' }}{{ dur(selected) }}</span>
                  <el-select
                    v-if="selected.status !== 'completed'"
                    size="small"
                    :model-value="selected.agent"
                    class="agent-swap mono"
                    title="更换该节点的执行 Agent"
                    @change="(v: string) => selected && changeAgent(selected, v)"
                  >
                    <el-option v-for="a in agentOptions" :key="a" :label="a" :value="a" />
                  </el-select>
                </div>
                <div class="n-obs mono">
                  <span>{{ selected.result?.model || '模型未记录' }}</span>
                  <span v-if="selected.result?.tokens"> · {{ fmtTok(selected.result.tokens || 0) }} tok</span>
                  <el-button v-if="selected.branch" size="small" link type="primary" class="diff-btn" @click="diffNodeId = selected.id">查看代码变更</el-button>
                </div>
                <div v-if="selected.reason" class="reason"><span class="mini-label">规划理由</span>{{ selected.reason }}</div>
                <div v-if="selected.error" class="error mono">✗ {{ selected.error }}</div>
                <div v-if="selected.result?.summary" class="summary">{{ selected.result.summary }}</div>
                <div v-if="(selected.result as any)?.verification" class="verification"><span class="mini-label green">验证</span>{{ (selected.result as any).verification }}</div>
                <div v-if="(selected.result as any)?.gate_test" class="gate-line mono" :class="(selected.result as any).gate_test.passed ? 'gate-ok' : 'gate-bad'">
                  {{ (selected.result as any).gate_test.passed ? '✓' : '✗' }} 自修改门禁 · {{ (selected.result as any).gate_test.command }}<template v-if="(selected.result as any).gate_test.summary"> · {{ (selected.result as any).gate_test.summary }}</template>
                </div>
                <div v-if="selected.result?.defects?.length" class="report-card defects-card">
                  <div class="r-title">DEFECTS · 发现未修复的缺陷（{{ selected.result.defects.length }}）</div>
                  <div v-for="(d, i) in selected.result.defects" :key="i" class="defect-row">
                    <div class="d-head">
                      <el-tag size="small" :type="d.severity === 'high' ? 'danger' : d.severity === 'medium' ? 'warning' : 'info'" class="mono">{{ d.severity || 'low' }}</el-tag>
                      <span class="d-title">{{ d.title }}</span>
                      <el-button size="small" link type="primary" :loading="converting === selected.id + ':' + i" @click="convertDefect(selected, i)">转修复任务</el-button>
                    </div>
                    <div class="d-detail">{{ d.detail }}</div>
                  </div>
                </div>
                <div v-if="selected.result?.report" class="report-card mono">
                  <div class="r-title">TEST REPORT · {{ selected.result.report.framework || 'tests' }} · {{ selected.result.report.attempts }} 轮</div>
                  <div class="r-line">{{ selected.result.report.summary }}</div>
                  <div v-for="(f, i) in (selected.result.report.failures || []).slice(0, 6)" :key="i" class="r-fail">✗ {{ f.name }}<template v-if="f.message">: {{ f.message.slice(0, 120) }}</template></div>
                </div>
                <div v-if="selected.result?.changes?.length" class="changes mono">
                  <div v-for="c in selected.result.changes" :key="c" class="change">✓ {{ c }}</div>
                </div>
                <div class="sub-title mono">时间线</div>
                <div class="tl">
                  <div v-for="(e, i) in nodeEvents" :key="i" class="tl-row">
                    <span class="tl-time mono">{{ fmt(e.ts) }}</span>
                    <span class="tl-dot" :class="describe(e).level"></span>
                    <span class="tl-text" :class="describe(e).level">{{ describe(e).text }}</span>
                  </div>
                  <div v-if="!nodeEvents.length" class="tl-empty mono">该节点暂无事件</div>
                </div>
                <div class="sub-title mono">会话回放</div>
                <ChatStream :task-id="taskId" :filter-node-id="selected.id" />
              </div>
              <div v-else class="empty mono">← 在左侧轨道选择一个节点</div>
            </div>
          </div>
        </el-tab-pane>

        <!-- 事件归档（全部事件，可筛选） -->
        <el-tab-pane :label="`事件归档 (${events.length})`" name="archive">
          <div class="arch">
            <div class="arch-toolbar">
              <el-radio-group v-model="archCategory" size="small">
                <el-radio-button value="">全部</el-radio-button>
                <el-radio-button value="node">节点</el-radio-button>
                <el-radio-button value="agent">Agent</el-radio-button>
                <el-radio-button value="task">任务</el-radio-button>
                <el-radio-button value="system">系统</el-radio-button>
              </el-radio-group>
              <el-input v-model="archKeyword" size="small" placeholder="搜索事件…" clearable style="width: 200px" />
              <el-checkbox v-model="archShowNoisy" size="small">显示高频细节</el-checkbox>
              <span class="arch-count mono">显示 {{ Math.min(archiveFiltered.length, archLimit) }} / {{ events.length }} 条</span>
            </div>
            <div class="arch-list">
              <div v-for="(e, i) in archiveShown" :key="i" class="tl-row">
                <span class="tl-time mono">{{ fmt(e.ts) }}</span>
                <span class="tl-dot" :class="describe(e).level"></span>
                <span class="tl-text" :class="describe(e).level">{{ describe(e).text }}</span>
                <span v-if="nodeName(e.payload.node_id)" class="tl-chip mono">{{ nodeName(e.payload.node_id) }}</span>
                <span v-if="e.payload.agent" class="tl-chip mono">{{ e.payload.agent }}</span>
              </div>
              <div v-if="!archiveFiltered.length" class="empty mono">没有匹配的事件</div>
              <div v-else-if="archiveFiltered.length > archLimit" class="arch-more">
                <el-button size="small" @click="archLimit += 500">加载更多（还有 {{ archiveFiltered.length - archLimit }} 条）</el-button>
              </div>
            </div>
          </div>
        </el-tab-pane>

        <!-- 管理：进度 / 主Agent模型 / 全局目标 / 快照回滚 -->
        <el-tab-pane label="管理" name="manage">
          <div class="manage">
            <div class="mg-card">
              <div class="mg-title mono">PROGRESS · 实时进度</div>
              <div v-if="progress" class="mg-body">
                <div class="mg-progress">
                  <el-progress :percentage="progress.percent" :stroke-width="10" />
                </div>
                <div class="mg-line mono">
                  {{ progress.completed }}/{{ progress.total }} 节点 · 状态 {{ statusText(progress.status) }}
                  <template v-if="progress.eta_sec !== undefined"> · 预计剩余 {{ Math.ceil(progress.eta_sec / 60) }} 分钟</template>
                </div>
                <div v-if="progress.current_nodes.length" class="mg-line">
                  进行中: <el-tag v-for="n in progress.current_nodes" :key="n.id" size="small" type="warning" class="mg-tag">{{ n.name }} ({{ n.agent }})</el-tag>
                </div>
              </div>
              <div v-else class="mg-empty mono">加载中...</div>
            </div>

            <div v-if="acceptanceReport" class="mg-card">
              <div class="mg-title mono">ACCEPTANCE · 最终验收报告（平台矩阵 + 机审证据）</div>
              <div class="mg-body">
                <div class="mg-line mono">
                  交付端: {{ (acceptanceReport.platforms || []).join(' / ') }} · E2E: {{ acceptanceReport.e2e?.note }} · 测试命令: {{ acceptanceReport.test_command || '（无）' }}
                </div>
                <div v-for="item in acceptanceReport.items" :key="item.id" class="acc-item">
                  <span class="acc-badge" :class="item.status">{{ item.status === 'done' ? '✓' : item.status === 'failed' ? '✗' : '…' }}</span>
                  <div class="acc-body">
                    <div class="acc-req mono">{{ item.requirement }}</div>
                    <div class="acc-note mono">{{ item.evidence || item.audit_note || (item.evidence_type + ' · 待人工裁决') }}</div>
                  </div>
                </div>
              </div>
            </div>

            <div class="mg-card">
              <div class="mg-title mono">SUPERVISOR · 监督者提案（待批准）</div>
              <div class="mg-body">
                <template v-if="(proposals || []).filter((p) => p.status === 'pending').length">
                  <div v-for="p in proposals.filter((p) => p.status === 'pending')" :key="p.id" class="mg-line proposal-row">
                    <div class="proposal-info">
                      <el-tag size="small" type="warning" class="mono">{{ p.type }}</el-tag>
                      <span class="mono">{{ p.reason || p.type }}</span>
                    </div>
                    <div class="proposal-actions">
                      <el-button size="small" type="primary" :loading="deciding === p.id" @click="decideProposal(p.id, true)">批准</el-button>
                      <el-button size="small" :loading="deciding === p.id" @click="decideProposal(p.id, false)">拒绝</el-button>
                    </div>
                  </div>
                </template>
                <div v-else class="mg-empty mono">暂无待批准提案（监督者只在发现卡点时提案）</div>
              </div>
            </div>

            <div class="mg-card">
              <div class="mg-title mono">EXECUTION POLICY · 执行策略（命令执行分级）</div>
              <div class="mg-body mg-row">
                <el-select v-model="policyLevel" size="small" style="width: 200px" @change="savePolicy">
                  <el-option label="跟随全局设置" value="" />
                  <el-option v-for="lv in PERMISSION_LEVELS" :key="lv" :label="PERMISSION_LEVEL_LABELS[lv]" :value="lv" />
                </el-select>
                <span class="mg-hint">
                  只出方案：不写代码只给方案 · 改动需审批：白名单外命令等你批准 · 白名单自动：仅白名单命令自动执行 · 完全控制：全部自动执行
                </span>
              </div>
              <div v-if="pendingCommands.length" class="mg-body">
                <div class="pc-title mono">待审批命令（{{ pendingCommands.length }}）</div>
                <div v-for="c in pendingCommands" :key="c.id" class="pc-row mono">
                  <span class="pc-cmd">{{ c.command }}</span>
                  <span class="pc-node">{{ c.node_name }}</span>
                  <el-button size="small" type="primary" @click="resolveCommand(c, true)">批准执行</el-button>
                  <el-button size="small" type="danger" plain @click="resolveCommand(c, false)">拒绝</el-button>
                </div>
              </div>
            </div>

            <div class="mg-card">
              <div class="mg-title mono">MAIN AGENT MODEL · 主 Agent 模型（锁定）</div>
              <div class="mg-body mg-row">
                <span class="mg-model mono">{{ task.main_model_id || '自动选择' }}</span>
                <el-select v-model="newModel" size="small" style="width: 220px" placeholder="选择新模型">
                  <el-option v-for="m in modelOptions" :key="m.name" :value="m.name" :label="m.name">
                    <span class="model-opt"><i class="dot" :class="m.healthy ? 'on' : 'off'"></i>{{ m.name }}</span>
                  </el-option>
                </el-select>
                <el-button size="small" :disabled="!newModel || newModel === task.main_model_id" :loading="changingModel" @click="changeModel">更换模型</el-button>
                <span class="mg-hint">创建时锁定，任务全程使用；更换后立即生效并留痕</span>
              </div>
            </div>

            <div class="mg-card">
              <div class="mg-title mono">GLOBAL GOAL · 全局目标</div>
              <div class="mg-body">
                <div v-if="!goalEditing" class="mg-goal">{{ goal.content || '（尚未生成）' }}</div>
                <el-input v-else v-model="goalDraft" type="textarea" :rows="5" />
                <div class="mg-row">
                  <el-button v-if="!goalEditing" size="small" @click="goalEditing = true; goalDraft = goal.content">编辑目标</el-button>
                  <template v-else>
                    <el-button size="small" @click="goalEditing = false">取消</el-button>
                    <el-button size="small" type="primary" :loading="savingGoal" @click="saveGoal">保存（Agent 下次调用生效）</el-button>
                  </template>
                  <span class="mg-hint">所有 Agent 的每次调用都会注入该目标，并要求汇报对目标的贡献</span>
                </div>
              </div>
            </div>

            <div class="mg-card">
              <div class="mg-title mono">SNAPSHOTS · 快照与回滚</div>
              <div class="mg-body">
                <div class="mg-row">
                  <el-button size="small" type="primary" :loading="creatingSnap" @click="createSnap">创建快照</el-button>
                  <span class="mg-hint">任务开始 / replan 决策点 / 任务结束 会自动创建快照</span>
                </div>
                <div v-if="!snapshots.length" class="mg-empty mono">暂无快照</div>
                <div v-for="s in snapshots" :key="s.id" class="snap-row mono">
                  <span class="snap-tag" :class="s.tag">{{ s.tag }}</span>
                  <span class="snap-time">{{ fmtTime(s.created_at) }}</span>
                  <span class="snap-ref">{{ s.git_ref?.slice(0, 8) || 'no-git' }}</span>
                  <span v-if="s.note" class="snap-note">{{ s.note }}</span>
                  <el-button size="small" link type="danger" @click="rollback(s)">回滚到此处</el-button>
                </div>
              </div>
            </div>
          </div>
        </el-tab-pane>
      </el-tabs>
    </div>

    <DiffDialog
      :model-value="diffNodeId !== null"
      :task-id="taskId"
      :node-id="diffNodeId || ''"
      :node-name="diffNodeId ? nodeName(diffNodeId) : ''"
      @close="diffNodeId = null"
    />

    <!-- A3 合并确认弹窗 -->
    <el-dialog :model-value="mergeConfirmOpen" title="确认合并" width="560px" append-to-body @close="mergeConfirmOpen = false">
      <div class="md">{{ mergeMsg }}</div>
      <div class="mono" style="margin-top: 8px; color: var(--ct-text3)">合并后成果进入主分支；任务分支保留可回溯。</div>
      <template #footer>
        <el-button size="small" @click="mergeConfirmOpen = false">取消</el-button>
        <el-button size="small" type="primary" :loading="merging" @click="onMerge">确认合并</el-button>
      </template>
    </el-dialog>

    <!-- A2 协同文档列表 -->
    <el-dialog v-model="docsOpen" title="协同文档（SSOT 单一事实来源）" width="680px" append-to-body>
      <div v-if="!docsList.length" class="mono" style="color: var(--ct-text3)">暂无协同文档</div>
      <div v-for="d in docsList" :key="d.type" class="doc-row">
        <el-button link type="primary" @click="docView = { title: `docs/${d.type}.md（v${d.version}）`, content: d.content }">
          📘 docs/{{ d.type }}.md · v{{ d.version }} · {{ d.updated_by }}
        </el-button>
        <el-button link size="small" @click="downloadText(`${d.type}.md`, d.content)">下载</el-button>
      </div>
    </el-dialog>

    <!-- A2/A1 文档与产出文件内容查看器 -->
    <el-dialog :model-value="!!docView" :title="docView?.title || '查看'" width="760px" top="6vh" append-to-body @close="docView = null">
      <div class="md" v-html="mdRender(docView?.content || '')"></div>
    </el-dialog>

    <!-- A1 实时产出视图 -->
    <el-dialog v-model="outputOpen" title="实时产出（沙箱工作副本 · 只读）" width="680px" append-to-body>
      <div class="output-bar">
        <span class="mono" style="color: var(--ct-text3)">{{ outputAvailable ? `沙箱: ${outputSandbox}` : '沙箱已清理或任务未在沙箱中执行' }}</span>
        <el-button size="small" @click="refreshOutput">刷新</el-button>
      </div>
      <div v-if="outputFile" class="output-file">
        <div class="mono output-file-path">{{ outputFile.path }}</div>
        <pre class="mono output-pre">{{ outputFile.content }}</pre>
      </div>
      <div class="output-list">
        <div v-for="f in outputFiles" :key="f" class="output-item mono" @click="viewOutputFile(f)">{{ f }}</div>
        <div v-if="!outputFiles.length" class="mono" style="color: var(--ct-text3)">暂无文件</div>
      </div>
    </el-dialog>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { marked } from 'marked';
import { api, PERMISSION_LEVELS, PERMISSION_LEVEL_LABELS, type TaskEvent, type TaskGraph, type TaskNode, type ProgressInfo, type SnapshotMeta } from '../api';
import PipelineTrack from './PipelineTrack.vue';
import ChatStream from './ChatStream.vue';
import InterventionBar from './InterventionBar.vue';
import DiffDialog from './DiffDialog.vue';
import { describeEvent, statusText, taskStage, type EventView } from '../utils/events';

const props = defineProps<{ modelValue: boolean; taskId: string; liveAgents?: Record<string, { model?: string; currentAction?: string }> }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const task = ref<TaskGraph | null>(null);
const events = ref<TaskEvent[]>([]);
const selectedNodeId = ref('');
const selectedAgent = ref('');
const tab = ref('warroom');
/** 任务频道右栏检视器：成员会话 / 节点详情 */
const wrView = ref<'chat' | 'node'>('chat');
let pollTimer: number | undefined;

// manage tab state (improvements 6/9/10/11)
const progress = ref<ProgressInfo | null>(null);
const modelOptions = ref<{ name: string; healthy: boolean; cost: number }[]>([]);
const newModel = ref('');
const changingModel = ref(false);
const goal = ref<{ content: string }>({ content: '' });
const goalEditing = ref(false);
const goalDraft = ref('');
const savingGoal = ref(false);
const snapshots = ref<SnapshotMeta[]>([]);
const creatingSnap = ref(false);
const diffNodeId = ref<string | null>(null);
// feature: 命令执行分级
const policyLevel = ref('');
const pendingCommands = ref<{ id: string; node_id: string; node_name: string; command: string; ts: string }[]>([]);
// feature: 实施前澄清
const clarifyNode = computed(() => task.value?.nodes.find((n) => n.status === 'waiting_clarify') || null);
const clarifyNodeId = computed(() => clarifyNode.value?.id || '');
const clarifyState = ref<{ mode: string; brief: { approach: string; files: string[]; risks: string[]; questions: string[] }; answers: { question: string; answer: string }[] } | null>(null);
const clarifyAnswer = ref('');
const clarifying = ref(false);
let clarifyStateFetchedFor = '';

const selected = computed(() => task.value?.nodes.find((n) => n.id === selectedNodeId.value) || null);

// ---------- 阶段横幅 ----------

const STAGE_STEPS = ['需求澄清', '计划审核', '节点执行', '完成'];
const stageStep = computed(() => (task.value ? taskStage(task.value.status).step : 0));
const stageLabel = computed(() => (task.value ? taskStage(task.value.status).label : ''));
const stageFailed = computed(() => task.value?.status === 'failed');
const progressEta = computed(() => (progress.value?.eta_sec !== undefined ? Math.max(1, Math.ceil(progress.value.eta_sec / 60)) : null));

// ---------- 成员 chips ----------

const members = computed(() => {
  const out: { name: string; running: boolean }[] = [];
  for (const n of task.value?.nodes || []) {
    if (n.agent === 'orchestrator') continue;
    let m = out.find((x) => x.name === n.agent);
    if (!m) {
      m = { name: n.agent, running: false };
      out.push(m);
    }
    if (n.status === 'running' || n.status === 'retrying') m.running = true;
  }
  return out;
});

function pickMember(name: string) {
  selectedAgent.value = name;
  wrView.value = 'chat';
}

const nodeNames = computed<Record<string, string>>(() => {
  const map: Record<string, string> = {};
  for (const n of task.value?.nodes || []) map[n.id] = n.name;
  return map;
});
function nodeName(id?: string): string {
  return (id && nodeNames.value[id]) || '';
}

// ---------- A3/A2/A1: 验收合并 · 协同文档 · 实时产出 ----------
const merging = ref(false);
const mergeMsg = ref('');
const mergeOk = ref(false);
const mergeConfirmOpen = ref(false);
const docsOpen = ref(false);
const docsList = ref<{ type: string; path: string; version: number; updated_by: string; content: string }[]>([]);
const docView = ref<{ title: string; content: string } | null>(null);
const outputOpen = ref(false);
const outputAvailable = ref(false);
const outputSandbox = ref('');
const outputFiles = ref<string[]>([]);
const outputFile = ref<{ path: string; content: string } | null>(null);

async function onMergePreview() {
  merging.value = true;
  mergeMsg.value = '';
  try {
    const r = await api.mergeTask(props.taskId, true);
    mergeOk.value = r.ok;
    mergeMsg.value = r.message + (r.conflicts.length ? `：${r.conflicts.slice(0, 5).join('、')}` : '');
    if (r.ok) mergeConfirmOpen.value = true;
  } catch (e: any) {
    mergeMsg.value = e.message || '合并预览失败';
  } finally {
    merging.value = false;
  }
}

async function onMerge() {
  merging.value = true;
  try {
    const r = await api.mergeTask(props.taskId, false);
    mergeOk.value = r.ok;
    mergeMsg.value = r.message;
    mergeConfirmOpen.value = false;
    if (r.ok) ElMessage.success(`成果已合并到 ${r.target}`);
    task.value = await api.getTask(props.taskId);
  } catch (e: any) {
    mergeMsg.value = e.message || '合并失败';
  } finally {
    merging.value = false;
  }
}

async function openDocs() {
  try {
    const r = await api.taskDocs(props.taskId);
    docsList.value = r.docs || [];
    docsOpen.value = true;
  } catch (e: any) {
    ElMessage.error(e.message || '加载协同文档失败');
  }
}

function downloadText(name: string, content: string) {
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

async function openOutput() {
  await refreshOutput();
  outputOpen.value = true;
}

async function refreshOutput() {
  try {
    const r = await api.taskOutput(props.taskId);
    outputAvailable.value = r.available;
    outputSandbox.value = r.sandbox_path || '';
    outputFiles.value = r.files || [];
  } catch (e: any) {
    ElMessage.error(e.message || '加载产出失败');
  }
}

async function viewOutputFile(path: string) {
  try {
    outputFile.value = await api.taskOutputFile(props.taskId, path);
  } catch (e: any) {
    ElMessage.error(e.message || '读取文件失败');
  }
}

function mdRender(text: string): string {
  const escaped = (text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return String(marked.parse(escaped, { async: false, breaks: true }));
}

// ---------- 消耗统计（Σ 节点 tokens，按模型池单价估算成本） ----------

const taskTokens = computed(() => (task.value?.nodes || []).reduce((sum, n) => sum + (n.result?.tokens || 0), 0));
const taskCostEstimate = computed(() =>
  (task.value?.nodes || []).reduce((sum, n) => {
    const price = modelOptions.value.find((m) => m.name === n.result?.model)?.cost;
    if (!price || !n.result?.tokens) return sum;
    return sum + (n.result.tokens * price) / 1000;
  }, 0)
);
function fmtTok(n: number): string {
  return n >= 1000 ? (Math.round(n / 100) / 10) + 'k' : String(n);
}

// ---------- 事件归档筛选 ----------

const archCategory = ref('');
const archKeyword = ref('');
const archShowNoisy = ref(false);
const archLimit = ref(500);

function describe(e: TaskEvent): EventView {
  return describeEvent(e.type, e.payload);
}

const archiveFiltered = computed(() =>
  events.value.filter((e) => {
    const v = describe(e);
    if (archCategory.value && v.category !== archCategory.value) return false;
    if (!archShowNoisy.value && v.noisy) return false;
    const kw = archKeyword.value.trim().toLowerCase();
    if (kw) {
      const hay = `${v.text} ${nodeName(e.payload.node_id)} ${e.payload.agent || ''}`.toLowerCase();
      if (!hay.includes(kw)) return false;
    }
    return true;
  })
);
const archiveShown = computed(() => archiveFiltered.value.slice(0, archLimit.value));

// ---------- 节点选择与联动 ----------

function selectNodeId(id: string) {
  selectedNodeId.value = id;
  wrView.value = 'node';
  const n = task.value?.nodes.find((x) => x.id === id);
  if (n && n.agent !== 'orchestrator') selectedAgent.value = n.agent;
}

const nodeEvents = computed(() => events.value.filter((e) => e.payload?.node_id === selectedNodeId.value));
const selectedLive = computed(() => (selectedAgent.value ? props.liveAgents?.[selectedAgent.value] || null : null));
const branches = ref<{ name: string; commit: string }[]>([]);

const agentsInTask = computed(() => [...new Set((task.value?.nodes || []).map((n) => n.agent).filter((a) => a !== 'orchestrator'))]);

// ---------- agent reassignment ----------

const agentOptions = ref<string[]>([]);

async function loadAgentOptions() {
  try {
    const d = await api.listAgents();
    agentOptions.value = (d.agents || []).map((a) => a.name);
  } catch { /* non-fatal — picker stays empty */ }
}

async function changeAgent(n: TaskNode, agent: string) {
  if (agent === n.agent) return;
  try {
    await api.updateNode(props.taskId, n.id, { agent });
    ElMessage.success(`节点「${n.name}」已交给 ${agent}，后续执行生效`);
    void refresh();
  } catch (e: any) {
    ElMessage.error(`更换 Agent 失败: ${e.message || e}`);
    void refresh();
  }
}

// P0-2: convert a structured defect into a fix task with a backlink
const converting = ref('');
async function convertDefect(n: TaskNode, defectIndex: number) {
  converting.value = n.id + ':' + defectIndex;
  try {
    const r = await api.convertDefect(props.taskId, n.id, defectIndex, false);
    if (r.status === 'needs_clarification') {
      ElMessage.warning(`修复任务 ${r.fix_task_id} 已创建，等待需求澄清后执行`);
    } else {
      ElMessage.success(`修复任务 ${r.fix_task_id} 已创建（可在任务中心查看，回链至本节点）`);
    }
  } catch (e: any) {
    ElMessage.error(`转化失败: ${e.message || e}`);
  } finally {
    converting.value = '';
  }
}
const completedCount = computed(() => task.value?.nodes.filter((n) => n.status === 'completed').length || 0);
const progressPct = computed(() => (task.value?.nodes.length ? Math.round((completedCount.value / task.value.nodes.length) * 100) : 0));

function dur(n: TaskNode): string {
  if (!n.started_at) return '';
  const end = n.finished_at ? new Date(n.finished_at).getTime() : Date.now();
  return ' ' + Math.max(0, Math.round((end - new Date(n.started_at).getTime()) / 100) / 10) + 's';
}
function fmt(ts: string): string { return new Date(ts).toLocaleTimeString(); }

function pickDefaultAgent() {
  if (!agentsInTask.value.length) return;
  // E1: 默认「全体」——不再自动选中某个成员（曾导致其他成员的卡片/留言初看不显示）
  selectedAgent.value = '';
}

async function refresh() {
  if (!props.modelValue) return;
  const d = await api.getTask(props.taskId);
  task.value = d;
  const ev = await api.taskEvents(props.taskId);
  events.value = ev.events;
  // feature: 实施前澄清 —— 被简报门拦下时拉取简报
  if (clarifyNode.value && clarifyStateFetchedFor !== clarifyNodeId.value) {
    clarifyStateFetchedFor = clarifyNodeId.value;
    void loadClarifyState(clarifyNodeId.value);
  }
}

async function refreshProgress() {
  if (!props.modelValue) return;
  try {
    progress.value = await api.taskProgress(props.taskId);
  } catch { /* ignore */ }
}

async function refreshManage() {
  if (!props.modelValue) return;
  await refreshProgress();
  try {
    goal.value = await api.getTaskGoal(props.taskId);
  } catch { /* ignore */ }
  try {
    snapshots.value = (await api.listSnapshots(props.taskId)).snapshots;
  } catch { /* ignore */ }
  // feature: 命令执行分级
  try {
    policyLevel.value = (await api.getTaskPolicy(props.taskId)).execution_policy?.level || '';
  } catch { /* ignore */ }
  try {
    pendingCommands.value = (await api.getPendingCommands(props.taskId)).commands;
  } catch { /* ignore */ }
}

async function savePolicy() {
  try {
    await api.setTaskPolicy(props.taskId, policyLevel.value || null);
    ElMessage.success(policyLevel.value ? `执行策略已切换为「${PERMISSION_LEVEL_LABELS[policyLevel.value]}」` : '已恢复跟随全局设置');
  } catch (e: any) {
    ElMessage.error(e.message);
  }
}

async function resolveCommand(c: { id: string; command: string }, approved: boolean) {
  try {
    const r = await api.resolveCommand(props.taskId, c.id, approved);
    if (approved) {
      ElMessage.success(r.returncode === 0 ? `命令已执行（退出码 0）` : `命令已执行但退出码为 ${r.returncode}，请查看任务频道`);
    } else {
      ElMessage.info('命令已拒绝，未执行');
    }
    pendingCommands.value = (await api.getPendingCommands(props.taskId)).commands;
  } catch (e: any) {
    ElMessage.error(e.message);
  }
}

async function loadClarifyState(nodeId: string) {
  try {
    clarifyState.value = await api.getNodeClarify(props.taskId, nodeId);
  } catch {
    clarifyState.value = null;
  }
}

async function confirmClarify(approveOnly: boolean) {
  const nodeId = clarifyNodeId.value;
  if (!nodeId) return;
  clarifying.value = true;
  try {
    const text = clarifyAnswer.value.trim();
    await api.clarifyNode(props.taskId, nodeId, {
      ...(approveOnly ? { approve: true } : {}),
      ...(text ? { text } : {}),
    });
    ElMessage.success('已确认，节点开始实施');
    clarifyAnswer.value = '';
    clarifyState.value = null;
    await refresh();
  } catch (e: any) {
    ElMessage.error(e.message);
  } finally {
    clarifying.value = false;
  }
}

async function loadModels() {
  try {
    const d = await api.getModelPool();
    const health = (d as any).health || {};
    modelOptions.value = d.model_pool.map((m) => ({ name: m.name, healthy: health[m.name]?.healthy !== false, cost: m.cost_per_1k || 0 }));
  } catch { /* ignore */ }
}

async function changeModel() {
  if (!newModel.value) return;
  changingModel.value = true;
  try {
    await api.setTaskModel(props.taskId, newModel.value);
    ElMessage.success(`主 Agent 模型已切换为 ${newModel.value}`);
    task.value = await api.getTask(props.taskId);
    newModel.value = '';
  } catch (e: any) {
    ElMessage.error(e.message);
  } finally {
    changingModel.value = false;
  }
}

async function saveGoal() {
  savingGoal.value = true;
  try {
    await api.updateTaskGoal(props.taskId, goalDraft.value);
    goal.value = { content: goalDraft.value };
    goalEditing.value = false;
    ElMessage.success('全局目标已更新');
  } catch (e: any) {
    ElMessage.error(e.message);
  } finally {
    savingGoal.value = false;
  }
}

async function createSnap() {
  creatingSnap.value = true;
  try {
    await api.createSnapshot(props.taskId, 'manual');
    ElMessage.success('快照已创建');
    snapshots.value = (await api.listSnapshots(props.taskId)).snapshots;
  } catch (e: any) {
    ElMessage.error(e.message);
  } finally {
    creatingSnap.value = false;
  }
}

async function rollback(s: SnapshotMeta) {
  try {
    await ElMessageBox.confirm(
      `确定回滚到快照 ${s.created_at}（${s.tag}）？\n任务状态、Agent 会话与协作状态将恢复为快照时点。`,
      '回滚确认',
      { type: 'warning' }
    );
  } catch {
    return;
  }
  try {
    const r = await api.rollbackSnapshot(s.id);
    ElMessage.success(`回滚完成：${r.git_action}，恢复 ${r.kv_restored} 项状态`);
    await refresh();
    await refreshManage();
  } catch (e: any) {
    ElMessage.error(e.message);
  }
}

function fmtTime(ts: string): string {
  try {
    return new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  } catch {
    return ts;
  }
}

// M3 监督者提案
const proposals = ref<any[]>([]);
const acceptanceReport = ref<any>(null);
const deciding = ref('');
async function loadProposals() {
  try {
    proposals.value = (await api.listProposals(props.taskId)).proposals || [];
    acceptanceReport.value = (await api.acceptanceReport(props.taskId)).report;
  } catch { /* ignore */ }
}
async function decideProposal(proposalId: string, approved: boolean) {
  deciding.value = proposalId;
  try {
    await api.decideProposal(props.taskId, proposalId, approved);
    ElMessage.success(approved ? '提案已批准并执行' : '提案已拒绝');
    await loadProposals();
    await refresh();
  } catch (e: any) {
    ElMessage.error(e.message || '操作失败');
  } finally {
    deciding.value = '';
  }
}

async function onOpen() {
  tab.value = 'warroom';
  wrView.value = 'chat';
  selectedNodeId.value = '';
  newModel.value = '';
  goalEditing.value = false;
  diffNodeId.value = null;
  archCategory.value = '';
  archKeyword.value = '';
  archShowNoisy.value = false;
  archLimit.value = 500;
  await refresh();
  void loadProposals();
  await refreshManage();
  void loadModels();
  void loadAgentOptions();
  branches.value = (task.value?.nodes || [])
    .filter((n) => n.branch)
    .map((n) => ({ name: n.branch as string, commit: (n.result as any)?.git_commit?.commit?.slice(0, 8) || '' }));
  pickDefaultAgent();
  window.clearInterval(pollTimer);
  pollTimer = window.setInterval(() => {
    if (task.value && ['running', 'pending', 'planned', 'retrying', 'waiting_approval', 'waiting_clarify'].includes(task.value.status)) {
      void refresh();
      void refreshProgress();
    }
  }, 3000);
}

function onClose() { window.clearInterval(pollTimer); emit('close'); }
onUnmounted(() => window.clearInterval(pollTimer));
</script>

<style scoped>
.detail { font-size: 13px; }
.meta { display: flex; align-items: center; gap: 16px; margin-bottom: 12px; }
.meta-actions { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
.merge-msg { font-size: 11px; color: var(--ct-text3); }
.merge-msg.ok { color: var(--ct-green); }
.doc-row { display: flex; align-items: center; justify-content: space-between; padding: 4px 0; border-bottom: 1px dashed var(--ct-border); }
.output-bar { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
.output-list { max-height: 260px; overflow-y: auto; border: 1px solid var(--ct-border); border-radius: 6px; padding: 4px; }
.output-item { font-size: 11px; padding: 3px 8px; cursor: pointer; border-radius: 4px; color: var(--ct-text); }
.output-item:hover { background: var(--ct-panel2); }
.output-file-path { font-size: 11px; color: var(--ct-accent); margin: 8px 0 4px; }
.output-pre { max-height: 320px; overflow: auto; background: var(--ct-panel2); border-radius: 6px; padding: 8px; font-size: 11px; white-space: pre-wrap; }
.meta-main { flex: 1; min-width: 0; }
.desc { font-size: 13px; font-weight: 600; color: var(--ct-text); margin-bottom: 4px; }
.meta-sub { font-size: 11px; color: var(--ct-text3); }
.progress { flex: 0 0 160px; height: 6px; background: var(--ct-panel2); border-radius: 3px; overflow: hidden; }
.progress-fill { height: 100%; background: var(--ct-accent); transition: width 0.5s; }

/* ---- 阶段横幅 ---- */
.stage-banner { display: flex; gap: 24px; align-items: flex-start; padding: 12px 14px; background: var(--ct-panel2); border: 1px solid var(--ct-border); border-radius: 8px; margin-bottom: 12px; }
.st-steps { display: flex; align-items: center; gap: 0; flex-shrink: 0; padding-top: 2px; }
.st-step { display: flex; flex-direction: column; align-items: center; gap: 4px; width: 64px; }
.st-dot { width: 20px; height: 20px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-size: 10px; background: var(--ct-panel); border: 1px solid var(--ct-border2); color: var(--ct-text3); }
.st-label { font-size: 11px; color: var(--ct-text3); white-space: nowrap; }
.st-step.done .st-dot { background: var(--ct-green); border-color: var(--ct-green); color: #fff; }
.st-step.done .st-label { color: var(--ct-text2); }
.st-step.active .st-dot { background: var(--ct-accent); border-color: var(--ct-accent); color: #fff; font-weight: 700; }
.st-step.active .st-label { color: var(--ct-text); font-weight: 600; }
.st-step.failed .st-dot { background: var(--ct-red); border-color: var(--ct-red); color: #fff; }
.st-link { width: 22px; height: 1px; background: var(--ct-border2); margin: 0 2px 16px; }
.st-link.passed { background: var(--ct-green); }
.st-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
.st-text { display: flex; gap: 12px; align-items: baseline; font-size: 11px; color: var(--ct-text2); flex-wrap: wrap; }
.st-state { font-weight: 700; font-size: 12px; }
.st-state.running, .st-state.retrying { color: var(--ct-yellow); }
.st-state.completed, .st-state.success { color: var(--ct-green); }
.st-state.failed { color: var(--ct-red); }
.st-state.waiting_approval { color: var(--ct-accent); }
.st-progress { height: 5px; background: var(--ct-panel); border: 1px solid var(--ct-border); border-radius: 3px; overflow: hidden; }
.st-progress .fill { height: 100%; background: var(--ct-accent); transition: width 0.5s; }
.st-current { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.st-current-label { font-size: 11px; color: var(--ct-text3); }

/* ---- 实施前澄清卡片 ---- */
.clarify-card { border: 1px solid var(--ct-accent); border-radius: 8px; padding: 10px 14px; margin-bottom: 12px; background: var(--ct-panel2); }
.cl-head { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
.cl-title { font-size: 12px; font-weight: 700; color: var(--ct-accent); }
.cl-mode { font-size: 10px; border: 1px solid var(--ct-accent); color: var(--ct-accent); border-radius: 3px; padding: 0 6px; }
.cl-body { display: flex; flex-direction: column; gap: 6px; }
.cl-line { font-size: 12px; color: var(--ct-text2); }
.cl-q { font-size: 12px; color: var(--ct-text); background: var(--ct-panel); border-radius: 4px; padding: 4px 8px; }
.cl-ops { display: flex; gap: 8px; margin-top: 4px; }

/* ---- 任务频道布局 ---- */
.warroom { display: grid; grid-template-columns: 420px 1fr; gap: 16px; align-items: start; }
.wr-left, .wr-right { max-height: calc(88vh - 300px); }
.wr-left { overflow-y: auto; padding-right: 12px; }
.wr-hint { font-size: 10px; color: var(--ct-text3); margin-top: 6px; }
.wr-right { display: flex; flex-direction: column; min-width: 0; }
.member-chips { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 10px; }
.m-chip { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; color: var(--ct-text2); background: var(--ct-panel); border: 1px solid var(--ct-border); border-radius: 12px; padding: 3px 10px; cursor: pointer; transition: border-color 0.15s, color 0.15s; }
.m-chip:hover { border-color: var(--ct-border2); color: var(--ct-text); }
.m-chip.active { color: var(--ct-text); border-color: var(--ct-accent); background: var(--ct-panel2); }
.m-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--ct-text3); }
.m-dot.on { background: var(--ct-yellow); animation: member-pulse 1.6s ease-in-out infinite; }
@keyframes member-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(154, 108, 10, 0.35); }
  50% { box-shadow: 0 0 0 4px rgba(154, 108, 10, 0.08); }
}
.wr-switch { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; }
.sw-btn { font-size: 11px; color: var(--ct-text2); background: var(--ct-panel); border: 1px solid var(--ct-border); border-radius: 4px; padding: 4px 12px; cursor: pointer; }
.sw-btn.active { color: #fff; background: var(--ct-accent); border-color: var(--ct-accent); }
.sw-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.sw-cur { font-size: 11px; color: var(--ct-text3); margin-left: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.live-head { display: flex; align-items: center; gap: 10px; padding: 8px 10px; background: var(--ct-panel2); border-radius: 6px; margin-bottom: 8px; font-size: 11px; flex-wrap: wrap; }
.live-agent { font-weight: 700; color: var(--ct-text); }
.live-model { color: var(--ct-accent); border: 1px solid var(--ct-border2); border-radius: 3px; padding: 0 6px; }
.live-action { color: var(--ct-yellow); }
.live-chat { max-height: calc(88vh - 380px); overflow-y: auto; display: flex; flex-direction: column; }
.node-view { max-height: calc(88vh - 340px); overflow-y: auto; min-width: 0; }

/* ---- 节点详情 ---- */
.node-head { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; }
.agent-swap { width: 110px; margin-left: auto; }
.acc-item { display: flex; gap: 8px; align-items: flex-start; padding: 4px 0; border-bottom: 1px dashed var(--ct-border); }
.acc-badge { font-weight: 700; flex-shrink: 0; }
.acc-badge.done { color: var(--ct-green); }
.acc-badge.failed { color: var(--ct-red); }
.acc-badge.open { color: var(--ct-orange, #fa8c16); }
.acc-body { min-width: 0; }
.acc-req { font-size: 12px; }
.acc-note { font-size: 11px; opacity: 0.7; word-break: break-all; }
.proposal-row { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 6px; }
.proposal-info { display: flex; align-items: center; gap: 6px; min-width: 0; }
.proposal-actions { display: flex; gap: 4px; flex-shrink: 0; }
.n-status { font-size: 11px; font-weight: 600; flex-shrink: 0; }
.n-status.completed { color: var(--ct-green); }
.n-status.failed { color: var(--ct-red); }
.n-status.running, .n-status.retrying { color: var(--ct-yellow); }
.n-status.waiting_approval { color: var(--ct-accent); }
.n-status.pending, .n-status.planned, .n-status.cancelled, .n-status.queued { color: var(--ct-text3); }
.n-name { color: var(--ct-text); font-weight: 600; }
.n-meta { color: var(--ct-text3); font-size: 11px; }
.n-obs { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--ct-text3); background: var(--ct-panel2); border-radius: 4px; padding: 4px 10px; margin-bottom: 8px; }
.diff-btn { margin-left: auto; }
.mini-label { display: inline-block; font-size: 10px; color: var(--ct-text3); border: 1px solid var(--ct-border2); border-radius: 3px; padding: 0 5px; margin-right: 8px; vertical-align: 1px; }
.mini-label.green { color: var(--ct-green); border-color: var(--ct-green); }
.reason { font-size: 12px; color: var(--ct-text2); font-style: italic; margin-bottom: 6px; }
.error { color: var(--ct-red); font-size: 12px; margin-bottom: 6px; }
.summary { font-size: 12px; color: var(--ct-text2); margin-bottom: 8px; white-space: pre-wrap; }
.verification { font-size: 12px; color: var(--ct-green); background: var(--ct-panel2); border-left: 3px solid var(--ct-green); border-radius: 4px; padding: 6px 10px; margin-bottom: 8px; }
.gate-line { font-size: 11px; border-radius: 4px; padding: 5px 10px; margin-bottom: 8px; }
.gate-ok { color: var(--ct-green); background: var(--ct-panel2); border-left: 3px solid var(--ct-green); }
.gate-bad { color: var(--ct-red); background: var(--ct-panel2); border-left: 3px solid var(--ct-red); }
.defects-card .d-head { display: flex; align-items: center; gap: 8px; }
.defects-card .d-title { font-size: 12px; color: var(--ct-text); font-weight: 600; }
.defects-card .d-head .el-button { margin-left: auto; }
.defects-card .d-detail { font-size: 11px; color: var(--ct-text2); margin: 4px 0 8px; white-space: pre-wrap; }
.report-card { border: 1px solid var(--ct-border); border-radius: 8px; padding: 10px 12px; margin-bottom: 8px; background: var(--ct-panel2); }
.r-title { font-size: 10px; color: var(--ct-text3); letter-spacing: 1px; margin-bottom: 6px; }
.r-line { font-size: 12px; color: var(--ct-text2); margin-bottom: 4px; }
.r-fail { font-size: 11px; color: var(--ct-red); }
.changes .change { font-size: 11px; color: var(--ct-text2); padding: 1px 0; }

/* ---- 时间线 / 事件行 ---- */
.sub-title { font-size: 10px; color: var(--ct-text3); text-transform: uppercase; letter-spacing: 0.6px; margin: 12px 0 6px; }
.branches { margin-top: 14px; }
.branch-row { display: flex; justify-content: space-between; font-size: 11px; padding: 2px 0; color: var(--ct-text2); }
.b-commit { color: var(--ct-text3); }
.tl { display: flex; flex-direction: column; }
.tl-row { display: flex; align-items: baseline; gap: 8px; padding: 4px 0; border-bottom: 1px solid var(--ct-border); font-size: 12px; }
.tl-row:last-child { border-bottom: none; }
.tl-time { color: var(--ct-text3); font-size: 10px; flex-shrink: 0; width: 62px; }
.tl-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; align-self: center; background: var(--ct-text3); }
.tl-dot.success { background: var(--ct-green); }
.tl-dot.warn { background: var(--ct-yellow); }
.tl-dot.error { background: var(--ct-red); }
.tl-dot.accent { background: var(--ct-accent); }
.tl-dot.info { background: var(--ct-border2); }
.tl-text { color: var(--ct-text2); min-width: 0; }
.tl-text.success { color: var(--ct-green); }
.tl-text.warn { color: var(--ct-text); }
.tl-text.error { color: var(--ct-red); }
.tl-text.accent { color: var(--ct-text); font-weight: 500; }
.tl-chip { font-size: 10px; color: var(--ct-text3); border: 1px solid var(--ct-border); border-radius: 3px; padding: 0 5px; flex-shrink: 0; }
.tl-empty { color: var(--ct-text3); font-size: 12px; padding: 8px 0; }

/* ---- 事件归档 ---- */
.arch { display: flex; flex-direction: column; gap: 10px; }
.arch-toolbar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.arch-count { font-size: 11px; color: var(--ct-text3); margin-left: auto; }
.arch-list { max-height: calc(88vh - 260px); overflow-y: auto; }
.arch-more { display: flex; justify-content: center; padding: 10px 0; }
.empty { color: var(--ct-text3); text-align: center; padding: 40px 0; }

/* manage tab */
.manage { display: flex; flex-direction: column; gap: 14px; max-height: calc(88vh - 200px); overflow-y: auto; }
.mg-card { border: 1px solid var(--ct-border); border-radius: 8px; padding: 12px 14px; }
.mg-title { font-size: 10px; color: var(--ct-text3); letter-spacing: 1px; margin-bottom: 10px; }
.mg-body { display: flex; flex-direction: column; gap: 8px; }
.mg-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.mg-line { font-size: 12px; color: var(--ct-text2); }
.mg-tag { margin-right: 4px; }
.mg-model { font-size: 13px; color: var(--ct-accent); font-weight: 600; }
.mg-hint { font-size: 11px; color: var(--ct-text3); }
.mg-goal { white-space: pre-wrap; font-size: 12px; color: var(--ct-text2); background: var(--ct-panel2); border-radius: 6px; padding: 10px; }
.mg-empty { color: var(--ct-text3); font-size: 12px; }
.mg-progress { max-width: 420px; }
.pc-title { font-size: 11px; color: var(--ct-yellow); margin-top: 4px; }
.pc-row { display: flex; align-items: center; gap: 10px; font-size: 11px; padding: 6px 0; border-bottom: 1px dotted var(--ct-border); }
.pc-cmd { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ct-text); }
.pc-node { color: var(--ct-text3); flex-shrink: 0; }
.snap-row { display: flex; align-items: center; gap: 10px; font-size: 11px; padding: 6px 0; border-bottom: 1px dotted var(--ct-border); }
.snap-tag { border: 1px solid currentColor; border-radius: 3px; padding: 0 6px; font-size: 10px; }
.snap-tag.manual { color: var(--ct-accent); }
.snap-tag.task-start { color: var(--ct-green); }
.snap-tag.task-end { color: var(--ct-text3); }
.snap-tag.decision { color: var(--ct-yellow); }
.snap-time { color: var(--ct-text2); }
.snap-ref { color: var(--ct-text3); }
.snap-note { color: var(--ct-text3); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.model-opt { display: inline-flex; align-items: center; gap: 6px; }
.model-opt .dot { width: 6px; height: 6px; border-radius: 50%; display: inline-block; }
.model-opt .dot.on { background: var(--ct-green); }
.model-opt .dot.off { background: var(--ct-red); }
</style>
