# 基线对照图与校验值

本目录的图像用于**复核"基线确实变了、且变对了"**。哈希使图像可被机器核对，
图像使视觉变化可被人工复核 —— 二者缺一不可（只记哈希看不出变化是否合理，
只放图像则无法确认交付的就是被审过的那一张）。

生成方式（可复跑）：

```
pwsh -File D:\lab\qiniandian\run.ps1     # 产出 logs/ 与 shots/
# 基线图本体由同机位、同参数（cam=hero&detail=2&w=1280&h=720&hud=0）截图得到
node scripts/capture.mjs <baseUrl> docs/baseline 1280 720 'hero:2'
```

## 校验值（完整 SHA256，实测）

| 文件 | 字节 | SHA256 |
|---|---|---|
| `hero-1280x720-before.png` | 380,255 | `451c0aac30caaa4345f652ed79f7166744361c7bfc3b729710c4f26c0dea6710` |
| `hero-1280x720-after.png` | 484,672 | `d126dd613f7f8b5812f8e61ace71e9b1f4ac47a075e2ab7773609f1dc9da2fc1` |
| `portrait-390x844.png` | 243,671 | `1af2ca26c9f56cdf477a6ddf1a3a854192517e118ffe21d4a283fffd99ecd053` |
| `ultrawide-2560x1080.png` | 1,409,314 | `cce0f6392b91a97b97549ddcf9b6b2876a5fd051767a5b8bbd681643da0b62e7` |

复算方式：

```powershell
Get-ChildItem docs/baseline/*.png | ForEach-Object {
  (Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLower()
}
```

> 注：`before`/`after` 与两张响应式基线**不是同一批产物**：前者用于"改了没有/改对了没有"的
> A/B 复核，后者记录当前响应式基线形态。改动取景或画布策略后应重新生成并更新本表。

## before / after 的差别（可用数字核对）

同机位 1280×720，两项关键差异：

| 指标 | before（`5e37fd7`） | after（本轮） |
|---|---|---|
| `size`（场景包围盒） | `[800, 36.82, 800]` — **含半径 400 m 的地面圆盘** | `[97.7, 36.8, 97.7]` — **仅建筑本体**（含台阶外挑） |
| 相机距离 | 96.4 m（预设原值，台基仅占屏宽 ~68%） | 66.2 m（取景规则，台基**恰好占满**屏宽） |
| `framing` 字段 | 无 | `mode/distance/heightFraction/widthFraction/visibleWidth` |

`before` 那张由 `git worktree` 检出改动前的提交 `5e37fd7` 独立构建后同参数截图得到，
确保对照来自**真实旧代码**而不是我的想象。

## 为什么"占满宽度"没有把台阶切掉

建筑本体的横向实测尺寸是 **97.7 m**（台基 90.3 m + 两侧台阶外挑），
而取景的内容宽度用的是**实测值**而非考据常量 90.3 m —— 否则台阶会被切出画面。
`scripts/verify-reframe.mjs` 专门断言：resize 与切机位之后仍用实测尺寸（S15）。
