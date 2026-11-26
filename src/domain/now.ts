/**
 * 全应用统一的"评估基准时刻"。
 * 三维弹窗、寿命页、导出表、任务单都使用这同一个 NOW 调用评估函数，
 * 因此界面点出的剩余寿命/下次检测日期与导出文件中的数字严格一致。
 */
export const NOW = new Date()
export const TODAY_ISO = NOW.toISOString().slice(0, 10)
