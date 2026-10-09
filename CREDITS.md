# 第三方资产许可（Third-party asset licences）

本项目**运行时离线自包含**，所有外部资产均已 vendor 进仓库。此处记录每个资产的来源与许可。

## HDRI 环境贴图

| 文件 | 资产 | 许可 | 来源 |
|---|---|---|---|
| `public/hdri/kloofendal_43d_clear_puresky_2k.hdr` | Kloofendal 43d Clear (Pure Sky)，2K HDR | **CC0 1.0**（公共领域奉献，无需署名） | [Poly Haven](https://polyhaven.com/a/kloofendal_43d_clear_puresky) · 直链 `https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/2k/kloofendal_43d_clear_puresky_2k.hdr` |

- 许可说明：<https://polyhaven.com/license> —— "You can use our assets for any purpose, including commercial work… you do not need to give credit."
- 已实测校验：Radiance HDR 头 `#?RADIANCE`，分辨率 **2048×1024**，4,624,289 B，
  `sha256 = 462A3CC63BFCD9FE0299137A0F33F4ADE84E237F4CB6115FE46F5AB400693FE6`
- 用途：IBL 环境光照 + 天空背景。选择理由：晴朗正午，与本项目冻结的基准光照一致。

## 代码依赖

| 包 | 版本 | 许可 |
|---|---|---|
| three | 0.186.1 | MIT |
| vite | 8.3.4 | MIT |
| typescript | 7.0.2 | Apache-2.0 |
| vitest | 3.2.4 | MIT |
| playwright | 1.64.0 | Apache-2.0 |
| @types/three | 0.186.0 | MIT |
| pngjs | （dev，仅量测脚本用） | MIT |

## 几何与贴图：全部程序化生成

**祈年殿本体几何与立面贴图均为本项目自行生成，不含任何第三方模型或贴图。** 依据：

- 经四路检索（Sketchfab downloadable API、Poly Haven 全量模型列表、Smithsonian、Google Arts & Culture）
  确认**不存在祈年殿的 CC0 模型**；唯一相关的 CC-BY 可下载项是**龙首螭首**装饰件，非大殿本身，故未采用。
- Poly Haven **没有大理石分类**、亦无蓝釉瓦贴图套件，故蓝釉瓦颜色取自故宫博物院实测 Lab 值自行换算，
  大理石/青砖等以程序化材质近似。

## 参考照片（不随仓库分发）

用于**人工比对**的祈年殿实景照保存在 `D:\lab\.probe\reference\`（**不在本仓库内**，也不参与运行时）。
其作者与许可已逐张经 Wikimedia Commons API `extmetadata` 核验并记录在
`D:\lab\.probe\reference\REFS.md` 与 `MANIFEST-UNIFIED.json`（含 CC0 / Public domain / CC BY 2.0/3.0）。

## 世界遗产相关声明

祈年殿是**全国重点文物保护单位 / 世界文化遗产**（天坛）的组成部分。
本项目是**独立的建筑形制研究与渲染练习**，
**不代表、也不隶属于**天坛公园管理处或任何文物主管机构；
渲染结果**不得用于任何暗示官方认可或授权的用途**。
