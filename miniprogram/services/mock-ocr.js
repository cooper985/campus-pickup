// 演示数据是固定样例，与所选图片内容无关。
function recognize() {
  return Promise.resolve({
    mock: true,
    lines: ["菜鸟驿站（校园北门店）", "取件码：3-2-1024", "请凭取件码到店领取"],
  });
}
module.exports = { recognize };
