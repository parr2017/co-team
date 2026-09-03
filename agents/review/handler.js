function preRun(task) {
  return task;
}

function postRun(result) {
  // 审查结果如有严重问题则视为失败，交由重试/接管机制处理
  const errors = result.errors || [];
  if (result.status === 'success' && errors.some((e) => String(e).startsWith('[blocker]'))) {
    result.status = 'failed';
  }
  return result;
}

module.exports = { preRun, postRun };
