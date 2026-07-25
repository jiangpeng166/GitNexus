# OC-Support 分支部署指南

本分支 `oc-support` 在上游 GitNexus 基础上增加了 **Objective-C 支持**（TS 源码），适用于索引 OC 项目（如 iOS 工程）。上游官方版不支持 OC。

> 适用于 macOS（Apple Silicon / Intel）。Linux 理论可行但未实测。Windows 不支持（tree-sitter-objc 原生 binding 限制）。

## 前提

- Node.js ≥ 20（推荐 22+）
- npm
- 已通过 `npm install -g gitnexus` 装好官方版（提供全局 node_modules 框架）。本分支用源码 build 的 dist 覆盖官方 dist，不升级版本号机制。

## 部署步骤

### 1. clone 本 fork 的 oc-support 分支

```bash
git clone -b oc-support https://github.com/jiangpeng166/GitNexus.git
cd GitNexus
```

### 2. 安装依赖 + build dist

```bash
cd gitnexus
npm install                    # 装依赖；postinstall 自动构建 tree-sitter grammars
node scripts/build.js          # build dist（末尾输出 "done — rewrote N files"）
```

`npm install` 只装本地 `node_modules/`，不碰全局（安全）。`postinstall` 会构建 vendored tree-sitter grammars（JS/TS/Python/Java/CPP 等），`prepare` 会自动跑一次 build.js。

### 3. 安装 Objective-C grammar（关键，别漏）

OC grammar（`tree-sitter-objc`）**不在 gitnexus 的 dependencies 里**，必须单独全局安装：

```bash
npm install -g tree-sitter-objc
```

不装的话，OC 文件会被 worker 判为 unsupported 全部跳过，索引里没有 OC 符号。

### 4. 覆盖全局 gitnexus 的 dist

```bash
# 全局 gitnexus 安装路径（npm root -g 查）
GLOBAL_DIR=$(npm root -g)/gitnexus

# 先备份官方 dist（出错可回滚）
cp -r "$GLOBAL_DIR/dist" /tmp/gitnexus-dist-backup-$(date +%Y%m%d)

# 覆盖
rsync -a --delete dist/ "$GLOBAL_DIR/dist/"
```

### 5.（可选）同步 package.json version

`gitnexus --version` 读全局 package.json。rsync dist 不改 package.json，version 还是官方版号。如想让版本号说真话：

```bash
python3 -c "
import json
p = '$(npm root -g)/gitnexus/package.json'
d = json.load(open(p))
src = json.load(open('package.json'))
d['version'] = src['version']
json.dump(d, open(p, 'w'), indent=2, ensure_ascii=False)
print('version →', d['version'])
"
```

### 6. 检查运行时依赖（若上游新增）

上游小版本可能新增运行时依赖（如 1.6.8 新增 `busboy`，`gitnexus serve` 用）。全局 node_modules 是旧的，需手动补：

```bash
# 对比源码 vs 全局 package.json 的 dependencies
python3 -c "
import json
src = json.load(open('package.json')).get('dependencies', {})
glo = json.load(open('$(npm root -g)/gitnexus/package.json')).get('dependencies', {})
for k in src:
    if k not in glo: print('缺:', k, src[k])
"
# 缺的 npm install -g <包>
```

## 验证

```bash
gitnexus --version           # 应报 oc-support 对应版本（如 1.6.9）
gitnexus serve --help        # 应正常（验证 busboy 等依赖不缺）
```

然后索引一个 OC 项目验证：

```bash
cd /path/to/your/oc-project
gitnexus analyze --force --index-only -v   # 先不重建 embedding（快，~3 分钟）
# 日志应显示 OC 文件被解析（scope-lang-start lang=objectivec files=N），无 "Skipped unsupported: objectivec"
```

## 重建索引（完整，含语义搜索）

OC 项目首次索引建议带 embedding（恢复中文语义搜索）：

```bash
cd /path/to/your/oc-project

# 配置 embedding（智谱 embedding-3，OpenAI 兼容端点）
export GITNEXUS_EMBEDDING_URL="https://open.bigmodel.cn/api/paas/v4"
export GITNEXUS_EMBEDDING_MODEL="embedding-3"
export GITNEXUS_EMBEDDING_API_KEY="<你的智谱 key>"
export GITNEXUS_EMBEDDING_DIMS="1024"
export GITNEXUS_SEMANTIC_EXACT_SCAN_LIMIT="200000"

# 后台跑（耗时 ~60-90 分钟，取决于节点数；前台跑可能被超时杀）
nohup gitnexus analyze --force --embeddings 0 -v > /tmp/rebuild.log 2>&1 &
tail -f /tmp/rebuild.log    # 看进度

# 完成后看结尾：应输出 "Repository indexed successfully" + 节点/边/embedding 数
```

`--embeddings 0` 的 `0` 是**禁用 5 万节点安全上限**（大仓库必须，否则节点超 5 万被 skip）。不是「不生成 embedding」。

### MCP 配置（Claude Code 用）

查询时 MCP server 进程需要 embedding env 才能转向量。在 `~/.claude.json` 的 `mcpServers.gitnexus.env` 加：

```json
"gitnexus": {
  "command": "gitnexus",
  "args": ["mcp"],
  "env": {
    "GITNEXUS_EMBEDDING_URL": "https://open.bigmodel.cn/api/paas/v4",
    "GITNEXUS_EMBEDDING_MODEL": "embedding-3",
    "GITNEXUS_EMBEDDING_API_KEY": "<你的智谱 key>",
    "GITNEXUS_EMBEDDING_DIMS": "1024"
  }
}
```

改完 `/mcp` reconnect。CLI 写入（`gitnexus analyze`）和 MCP 查询必须用同一套 env，否则向量空间不一致导致语义搜索失效。

## 常见问题

### `Cannot find module 'busboy'`（或其它模块）

上游新增依赖，全局 node_modules 没装。见步骤 6，`npm install -g busboy`。

### OC 文件被 skip（`Skipped unsupported: objectivec`）

`tree-sitter-objc` 没装或装错。确认 `npm install -g tree-sitter-objc` 且 `node -e "require('tree-sitter-objc')"` 成功。

### 改了 dist 后索引结果没变

`gitnexus analyze --force` **不废 per-file parse-cache**。改 dist 后必须先清 cache：

```bash
rm -rf .gitnexus/parse-cache .gitnexus/parsedfile-cache
```

日志 grep `cache replay`，>0 说明在用旧缓存。

### `gitnexus analyze` 跑挂 / embedding 丢失

长耗时 analyze 必须 `nohup` 后台跑。前台被 SIGTERM 会留 WAL 损坏，导致旧 embedding 不可逆丢失。

### 中文搜索返回 0 结果

MCP server 进程没配 embedding env（见上「MCP 配置」）。CLI 写入有 env 但查询没有，向量空间不一致。

## 升级（同步上游更新）

当上游 main 有新 commit，rebase oc-support 到最新：

```bash
git fetch origin main
git checkout oc-support
git rebase origin/main     # 冲突保留 OC 逻辑 + 手动合并上游
cd gitnexus && npm install
node_modules/.bin/tsc --noEmit -p tsconfig.json   # 0 错误
node scripts/build.js

# 重新部署（同步骤 4-6）+ force push
git push origin oc-support --force-with-lease
```

完整升级 SOP（13 步，含清 cache / 补依赖 / 改 version / nohup 等坑）见维护者的 `~/.claude/plans/gitnexus-oc-migration-progress.md`。

## 支持的 OC 特性

- `@interface` / `@implementation` / `@protocol` 解析
- 多段 selector 方法（`[obj foo:bar baz:qux]`）
- Category（`@implementation ClassName (Cat)`）保留为独立节点 + HAS_CATEGORY 边
- 跨文件 CALLS 边（receiver 类型解析 + EXTENDS 链）
- `@property` HAS_PROPERTY + declaredType（99.8% 有值）
- `@protocol` IMPLEMENTS 边
- .h 文件智能分类（OC 内容用 tree-sitter-objc，纯 C/C++ header 降级到 tree-sitter-cpp）
- 中文语义搜索（cluster_fallback 伪 Process + HNSW vector）

## 已知限制

- **系统框架方法无法解析**：UIKit/Foundation（UIView/NSString 等）不在项目索引里，对它们的调用不生成跨文件 CALLS 边（正常行为，非 bug）。
- **`#if/#endif` 块内的 property**：declaredType 可能为空（tree-sitter preproc 包装层导致，~0.008% 业务代码，不修）。
- **CALLS 边数**：比 v1.6.7 patch 时代少（约 24K vs 51K），因上游 1.6.8 type-binding 成功率变化 + 系统类/局部变量正常 skip。hub 方法调用方正常，非阻断。详见维护者记忆。

## 维护者

源码仓库：`/Users/pengjiang/Downloads/temp_file/GitNexus/`，分支 `oc-support`
权威记忆：`gitnexus-oc-patch-and-fixes`（架构/修复/教训）+ `gitnexus-oc-migration-progress`（升级 SOP）
备份：`~/.gitnexus/gitnexus-oc-backup-v1.6.7/`（v1.6.7 patch 时代产物，历史归档）

## License

继承上游 GitNexus license。
