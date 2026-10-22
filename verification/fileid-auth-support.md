# recognizePickup 云存储鉴权问题（已通过受控验证）

2026-10-22 验证结论：安全诊断补丁已部署，凭证与 Token 齐全，环境和地域匹配。服务端明确拒绝 tcb:GetFileDownloadUrl 和 tcb:DeleteFile。仅为当前上海环境临时授权这两项操作后，同一 SDK 成功读取并删除 68 字节合成 PNG；未改初始化，OCR 调用为 0。原错误已确定为操作权限不足。

上传 1144ms；fileID 调用 1482ms；服务端读取 447ms、删除 326ms。删除接口返回成功，未触发客户端兜底。验证后已解除策略与运行角色的临时关联，策略当前无任何关联对象。后续完整 OCR 验证需要重新启用这两项权限。Android 完整链路尚未测试，正式传输路径未切换。安全元数据见 fileid-auth-result.json。

以下为验证前的问题记录，相关疑问已由上述受控验证解决。

- 环境：cloud1-d8g3dicam66594fcf；上海；函数 recognizePickup；Node.js 16.13；20 秒。
- 运行角色：campusPickupOcrRole，目前仅关联 OCR 策略。
- 实际部署依赖：wx-server-sdk 4.0.2 → @cloudbase/node-sdk 3.17.2；signature-nodejs 2.2.0。
- 初始化：cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })，未传自定义密钥；SDK 按请求从运行时读取 SecretId、SecretKey、SessionToken。尚未在线验证这些值的有效性。
- Android 上传 235820 字节成功（1214ms）；fileID 小参数请求 184 字节，函数返回 421ms。读取失败 61ms，删除失败 37ms；客户端兜底删除成功，无遗留；未调用 OCR。
- 服务端独立复现：downloadFile 与 deleteFile 均抛出 SIGN_PARAM_INVALID，微信 SDK 外层 errCode=-1。
- SDK 源码：downloadFile → getTempFileURL → storage.batchGetDownloadUrl（POST），成功后再 GET 文件；deleteFile → storage.batchDeleteFile（POST）。
- CAM 控制台拒绝 tcb:GetDownloadUrl；tcb:GetFileDownloadUrl 与 tcb:DeleteFile、单个上海环境资源的组合通过草稿校验。未创建或关联策略。
- 尚无证据证明 SIGN_PARAM_INVALID 是缺少授权还是临时凭证无效。旧诊断遗漏了 `not authorized` 英文分类；本地修复尚未部署。

请确认：storage.batchGetDownloadUrl 对应的实际 CAM Action 是 GetFileDownloadUrl 还是 GetDownloadUrl？后者无法在 CAM 创建。如果两个接口使用不同授权映射，当前 SDK 应采用什么官方最小授权方案？资源是否支持限定为 qcs::tcb:ap-shanghai:uin/<本账号>:env/cloud1-d8g3dicam66594fcf？

参考：
- https://cloud.tencent.com/document/product/598/98174 （CAM 操作表 GetFileDownloadUrl / DeleteFile）
- https://docs.cloudbase.net/cam/access-manage （管理端 SDK 操作表 GetDownloadUrl；SIGN_PARAM_INVALID 也可能表示无操作权限）

本说明不包含图片、fileID、用户身份、取件码、临时链接或凭证。后续仅补充安全分类、固定操作名和凭证齐全与否的布尔值。
