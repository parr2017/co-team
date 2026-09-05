#!/usr/bin/env bash
# Co_team end-to-end demo (improvement checklist / R10).
#
# Walks the FULL pipeline against a running server with a REAL LLM key:
#   1. create a project (scaffolded)
#   2. create a task with a pinned main model
#   3. poll progress until completed
#   4. print snapshots / knowledge review entries / war-room journal summary
#
# Usage:
#   bash scripts/e2e-demo.sh [BASE_URL] [MODEL_NAME]
#   BASE_URL   defaults to http://localhost:8855
#   MODEL_NAME must exist in the server's model pool (config/config.yaml)
#
# Preconditions:
#   - server running:  npm start
#   - web built:       npm run build
#   - real API key in config/config.yaml model_pool
#
# The task auto-runs: POST /api/tasks with auto_run=true.
# Requirements are written to be CLEAR so the clarification gate passes on the
# first assessment; if the server answers needs_clarification the script fails
# loudly (that path is covered by unit tests instead).

set -euo pipefail

BASE_URL="${1:-http://localhost:8855}"
MODEL_NAME="${2:-}"

WORKSPACE="$(mktemp -d)/demo-project"
DESCRIPTION="实现一个命令行工具：读取 data.txt 中每行一个整数，输出最大值、最小值与平均值到 result.txt，并附带单元测试。"

echo "== Co_team e2e demo =="
echo "server: ${BASE_URL}"
echo "model : ${MODEL_NAME:-（自动选择）}"

# 0. server alive?
if ! curl -sf "${BASE_URL}/api/status" > /dev/null; then
  echo "✗ server not reachable at ${BASE_URL} — start it with: npm start" >&2
  exit 1
fi
echo "✔ server reachable"

# pick the first model from the pool when not given
if [ -z "${MODEL_NAME}" ]; then
  MODEL_NAME=$(curl -sf "${BASE_URL}/api/config/model-pool" | grep -o '"name":"[^"]*"' | head -1 | cut -d'"' -f4 || true)
  if [ -n "${MODEL_NAME}" ]; then echo "using pool model: ${MODEL_NAME}"; fi
fi

# 1. create the scaffolded project
echo "-- 1/4 creating project (scaffold) --"
PROJECT_JSON=$(curl -sf -X POST "${BASE_URL}/api/projects" \
  -H 'Content-Type: application/json' \
  -d "{\"name\":\"e2e-demo\",\"workspace\":\"${WORKSPACE}\",\"description\":\"端到端演示项目\",\"scaffold\":true}")
PROJECT_ID=$(echo "${PROJECT_JSON}" | grep -o '"project_id":"[^"]*"' | cut -d'"' -f4)
echo "✔ project ${PROJECT_ID} created at ${WORKSPACE}"

# 2. create + auto-run the task
echo "-- 2/4 creating task (auto-run) --"
if [ -n "${MODEL_NAME}" ]; then
  TASK_PAYLOAD=$(cat <<EOF
{"description":"${DESCRIPTION}","workspace":"${WORKSPACE}","project_id":"${PROJECT_ID}","main_model_id":"${MODEL_NAME}","auto_run":true}
EOF
)
else
  TASK_PAYLOAD=$(cat <<EOF
{"description":"${DESCRIPTION}","workspace":"${WORKSPACE}","project_id":"${PROJECT_ID}","auto_run":true}
EOF
)
fi
TASK_JSON=$(curl -sf -X POST "${BASE_URL}/api/tasks" -H 'Content-Type: application/json' -d "${TASK_PAYLOAD}")

STATUS=$(echo "${TASK_JSON}" | grep -o '"status":"[^"]*"' | head -1 | cut -d'"' -f4)
if [ "${STATUS}" = "needs_clarification" ]; then
  echo "✗ task needs clarification — this demo assumes a clear requirement; adjust DESCRIPTION" >&2
  exit 1
fi
TASK_ID=$(echo "${TASK_JSON}" | grep -o '"task_id":"[^"]*"' | cut -d'"' -f4)
echo "✔ task ${TASK_ID} created (${STATUS})"

# 3. poll progress until terminal
echo "-- 3/4 polling progress (30s interval) --"
DEADLINE=$(( $(date +%s) + 1800 ))  # 30 min cap
while : ; do
  PROGRESS_JSON=$(curl -sf "${BASE_URL}/api/tasks/${TASK_ID}/progress")
  PSTATUS=$(echo "${PROGRESS_JSON}" | grep -o '"status":"[^"]*"' | head -1 | cut -d'"' -f4)
  PERCENT=$(echo "${PROGRESS_JSON}" | grep -o '"percent":[0-9]*' | head -1 | cut -d: -f2)
  echo "  status=${PSTATUS} progress=${PERCENT:-0}%  ($(date +%H:%M:%S))"
  case "${PSTATUS}" in
    success|completed)
      echo "✔ task completed"; break ;;
    failed|cancelled)
      echo "✗ task ended in ${PSTATUS}"; exit 1 ;;
  esac
  if [ "$(date +%s)" -gt "${DEADLINE}" ]; then
    echo "✗ timed out waiting for completion (30 min)"; exit 1
  fi
  sleep 30
done

# 4. summary: snapshots / knowledge / journal
echo "-- 4/4 results --"
echo "snapshots:"
curl -sf "${BASE_URL}/api/snapshots?task_id=${TASK_ID}" | grep -o '"tag":"[^"]*"' | sed 's/^/  /' || echo "  (none)"
echo "knowledge review entries:"
curl -sf "${BASE_URL}/api/knowledge?q=e2e" | grep -o '"title":"[^"]*"' | sed 's/^/  /' || echo "  (none)"
echo "workspace result:"
[ -f "${WORKSPACE}/result.txt" ] && sed 's/^/  /' "${WORKSPACE}/result.txt" || echo "  (result.txt not produced — inspect the war room)"
echo "war room (journal tail):"
curl -sf "${BASE_URL}/api/tasks/${TASK_ID}/journals" | tail -c 800 | sed 's/^/  /'

echo ""
echo "== e2e demo finished ✔ =="
echo "open the war room: ${BASE_URL} (desktop) or ${BASE_URL}/m/ (mobile)"
