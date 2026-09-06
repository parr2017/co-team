---
name: vue3-crud-scaffold
description: Vue3 + Element Plus CRUD 页面开发规范：目录结构、API 封装、表格/表单模板与命名约定，dev 开发前端页面时遵循
tags: [code, frontend, vue]
---

## Vue3 CRUD 页面开发规范（dev Agent 必须遵循）

### 目录结构
- src/api/<module>.ts —— 每个 API 模块独立文件，统一使用封装的 request 实例
- src/views/<module>/index.vue —— 列表页（搜索栏 + el-table + 分页）
- src/views/<module>/form.vue —— 新增/编辑弹窗表单

### 编码约定
- 组件用 <script setup lang="ts">，组合式 API
- 表格列定义用 computed 数组驱动；表单校验用 el-form rules
- 接口命名：listXxx / getXxx / createXxx / updateXxx / deleteXxx
- 删除操作必须二次确认（ElMessageBox.confirm）

### 完成标准
- 每个页面必须有空态展示与加载态
- 提交前运行 npm run build 确认无类型错误
