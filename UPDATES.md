# 热更新（OTA 补丁升级）发布说明

## 目标

App 不用整包重下 150MB+ APK 也能拿到新版。热更新只下变更的文件（通常 < 5MB），
下次启动生效。模型 ONNX/WASM、index.html、sw.js 不热更新，随 APK 走。

## 文件

- `public/updates/manifest.json`（进 git）：APK 内置清单，version = 该 APK 包含的版本。
  初始 `20261017.1`，files 为空（APK 已含全部内容，无需热更新）。
- `scripts/ota-baseline.json`（进 git）：上次发布时的 dist 全量状态（path → sha256），
  供 `build-ota.py` 做 diff 用。不进 APK（不在 public/ 下）。
- `scripts/build-ota.py`：生成清单 + 变更文件暂存（`ota-publish/`）。
- 服务器路径：`https://speak.benext.uk/updates/manifest.json`、
  `https://speak.benext.uk/updates/<path>`（文件在服务器 `/opt/pronunciation-trainer/dist/updates/` 下）。

## 发布流程（手动，脚本不自动部署）

```bash
# 1. 改代码，构建
npm run build

# 2. 生成热更新包（对比 dist 与基线，只列变更文件，版本号自动递增）
python3 scripts/build-ota.py
# 输出示例：新版 20261017.2：变更 2 个文件，共 812 KB

# 3. 检查 ota-publish/（manifest.json + 变更文件），确认无误后发布：
#    先 rsync 文件，再 rsync 清单（清单最后，避免客户端拉到指向尚不存在文件的清单）
rsync -av ota-publish/ root@198.44.81.247:/opt/pronunciation-trainer/dist/updates/ --exclude=manifest.json
rsync -av ota-publish/manifest.json root@198.44.81.247:/opt/pronunciation-trainer/dist/updates/

# 4. 提交基线到 git（build-ota.py 已更新 scripts/ota-baseline.json）
git add scripts/ota-baseline.json && git commit -m "ota: publish <新版>" && git push
```

## 完整 APK 发布时

下一个完整 APK 构建前，把 `public/updates/manifest.json` 的 version bump 到已发布的最新版本、
files 置 `[]`（APK 已包含该版本内容），然后重新快照基线并提交：

```bash
npm run build
python3 scripts/build-ota.py --init-baseline
git add public/updates/manifest.json scripts/ota-baseline.json && git commit -m "ota: bump bundled version" && git push
```

## CI

`.github/workflows/android.yml` 在 `npm run build` 后多了一步 OTA（`continue-on-error: true`，
绝不阻断 APK 构建）：运行 `build-ota.py` 生成 `ota-publish/` 并作为 CI artifact 上传，
供人工检查后手动 rsync 到服务器。CI 不自动部署到服务器。

## 客户端行为

- 启动时后台静默检查（仅 Capacitor App，网页版不走热更新；离线跳过）。
- 有新版则逐个下载，sha256 校验通过后写入 App 私有目录（Filesystem Directory.Data/ota/）。
  单个文件失败只跳过它，保留旧版，不崩、不白屏。
- 下次启动：index.html 引导脚本优先加载热更新版入口 JS/CSS（按 role 找），
  词表/音频由 offline.ts 优先读热更新版；热更新版旧于内置版（新 APK 已包含）时忽略。
- 设置页面 → 检查更新：手动检查，有新版则下载，提示“已更新，下次启动生效”，不自动重启。

## nginx

`server/nginx-speak.benext.uk.conf` 已加 `location ^~ /updates/`（缺失文件返回 404，
不走 SPA 回退）。下次部署该 vhost 时一并生效；未生效前缺失文件会返回 index.html，
但客户端 sha256 校验会拒绝它，不会误用。
