# deploy 专用工具

本目录用于存放 deploy agent 的专用工具定义（阶段三）。
当前共享工具系统位于 src/shared/tools.py，所有 agent 均可使用：
- list_files / read_file（读取类，运行中可用）
- files / commands（写入与命令，最终输出时应用）
