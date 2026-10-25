# awesome-dsh-plugin 投稿材料

目标仓库：[`awesome-dsh-plugin/awesome-dsh-plugin`](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)（社区精选列表）。

投稿规则要求**一个插件一个 YAML 文件**，放在 `data/plugins/<owner>__<repo>.yml`；monorepo 子包用 `owner/repo#subname` 命名，`url` 指向子目录。两个 README 由脚本生成，不能手改。

本目录里的文件已经按该格式写好：

```
AntonyLang__dsh-workflow-forge--packages-scenario-source-brief.yml
```

## 投稿前置条件（逐条核对）

| 条件 | 状态 |
| --- | --- |
| 仓库声明 `dsh.bundle` | ✅ `packages/scenario-source-brief/package.json` |
| 包旁有 `cordis.patch.yml` | ✅ |
| 仓库有真实可用代码 | ✅ 六个包 + 114 个测试 |
| 仓库带 `dsh-plugin` topic | ✅ 已添加 |
| 仓库创建满 **1 天** | ⏳ CI 会自动检查；仓库创建于 2026-10-25，需等到 2026-10-26 之后 |
| 描述属实、无夸大 | ✅ 只描述已完成的行为；`runtime_verified` 未声称 |
| 官方 `@deepseek-ai/*` 用 peerDependencies | ✅ |
| 预发布 peer 范围可匹配 | ✅ 精确钉到 `0.2.1-rc.3`（带预发布标签的比较符） |
| 预构建分发 | ✅ GitHub Release 附件 tarball；npm 已发布 `dsh-scenario-source-brief@0.1.0` |

## 投稿步骤

仓库满 1 天后（CI 会拒掉创建不足 1 天的仓库）：

```bash
# 1. fork 并克隆
gh repo fork awesome-dsh-plugin/awesome-dsh-plugin --clone
cd awesome-dsh-plugin

# 2. 新建分支并放入条目（文件名必须与 owner__repo 完全一致）
git checkout -b add-antony-dsh-workflow-forge
mkdir -p data/plugins
cp <本仓库>/docs/awesome/AntonyLang__dsh-workflow-forge--packages-scenario-source-brief.yml data/plugins/

# 3. 只提交这一个文件
git add data/plugins/AntonyLang__dsh-workflow-forge--packages-scenario-source-brief.yml
git commit -m "Add AntonyLang/dsh-workflow-forge#scenario-source-brief"
git push -u origin add-antony-dsh-workflow-forge

# 4. 开 PR
gh pr create --repo awesome-dsh-plugin/awesome-dsh-plugin \
  --title "Add AntonyLang/dsh-workflow-forge#scenario-source-brief" \
  --body "Adds the source-brief scenario package: a restricted WorkflowSpec compiler plus a packaged DSH scenario that produces evidence-cited reports."
```

## 注意

- **不要**改 README，也不要动别人的条目；CI 会列出被修改的既有条目。
- `tarball` 字段钉在 `v0.1.0` 标签上，文件名带版本号是允许的（`latest/download/` 才会因文件名带版本而失效）。
- 如果维护者认为 `workflow` 分类不贴切，会直接改，不会因此打回。
- 描述里不要写数字除非能对上代码：本条目没有写「N 个工具」这类数字。
