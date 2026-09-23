# docs/

本目录的目录树与磁盘实际一致（README 与代码里的目录图若与此不符，以此处为准）。

```
docs/
├── README.md                     # 本文件
├── architecture.md               # 流水线图 + 模块边界表（依赖由 import 实测得出）
├── design/                       # 设计推演史，按时间前缀命名
│   ├── 2026-09-08-tree-of-hypotheses-plan.md          # 原始需求与架构计划（权威）
│   ├── 2026-09-12-pi-package-migration.md             # 独立 JS 应用 → Pi 包
│   └── 2026-09-16-majority-personal-corpus-fix.md     # 配置-代码不一致的单点修复
├── CHANGELOG.md
├── CONTRIBUTING.md
└── superpowers/specs/            # 与人协作迭代的规格稿（工具默认落点，保留以示来源）
    ├── 2026-09-23-engineering-baseline-design.md      # spec-1 工程基线
    └── 2026-09-23-reproducible-evidence-design.md     # spec-2 可复现证据
```

## 关于版本控制历史

本仓的 git 基线 `9e94fa2` 是**既有工作快照**：2026-09-08 至 2026-09-16 期间的开发未纳入版本控制，
因此**没有可查的早期 commit，也没有 blame 到具体决策时刻的历史**。那段时期的设计取舍只能从
`design/` 三份文档读。这是有意选择——伪造一条时间线比留一个诚实的快照更减分。

## 阅读顺序建议

1. `design/2026-09-08-tree-of-hypotheses-plan.md` —— 系统要做什么、为什么必须是多 Agent
2. `architecture.md` —— 现在实际是怎么分层、谁依赖谁
3. `design/2026-09-12-pi-package-migration.md` —— 为什么长成 Pi 包这样
4. `../README.md` 的「与计划文档的对应与偏差」表 —— 声称与实现不一致的地方在哪里
