// 取景阈值的**单一来源**，供浏览器端与 node 验证脚本共用。
//
// 为什么单独抽一个模块：Q30 的两个阈值（45% 占屏高、35.92 m 可见宽下限）此前同时出现在
// src/framing.ts、tests/framing.test.ts 与 scripts/verify-layout.mjs 三处。
// 它们一旦漂移，就会出现"测试通过但门禁用另一套阈值"或反之 —— 这正是本项目反复踩到的
// "两处标准、各自演化"类问题。此文件是唯一来源，其余各处一律 import。
//
// 只含**常量**，不含逻辑，因此既能在 rollup 打进浏览器包，也能被 node 脚本直接 import。

/** 相机竖直视场角（度）——必须与 PerspectiveCamera 的构造参数一致 */
export const FOV_Y_DEG = 42;

/** 建筑本体宽度：台基最下层直径（考据值 90.3 m） */
export const BUILDING_WIDTH = 90.3;
/** 建筑本体高度：通高（考据值 36.8 m） */
export const BUILDING_HEIGHT = 36.8;
/** 大殿身直径（考据值 32.72 m）——必须始终完整可见 */
export const HALL_BODY_WIDTH = 32.72;
/** 可见宽度下限相对大殿本体两侧各留的余量（米） */
export const WIDTH_MARGIN = 1.6;
/** 可见宽度下限 = 大殿本体 + 两侧余量。**永不以切掉主体为代价换取占屏比例。** */
export const MIN_VISIBLE_WIDTH = HALL_BODY_WIDTH + WIDTH_MARGIN * 2;   // 35.92
/** 建筑占屏高的目标下限 */
export const MIN_HEIGHT_FRACTION = 0.45;
