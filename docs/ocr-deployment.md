# OCR 部署与联调方案（尚未执行）

## 当前可验证状态

- 环境：`cloud1-d8g3dicam66594fcf`（上海）。
- 正确账号 OCR 已开通，GeneralBasicOCR 免费剩余 1000 次，已用 0 次，后付费未开通。
- 首页：`pages/pickup/index`，前端只调用本地模拟服务，不上传图片。
- 独立事件云函数：`recognizePickup`，默认 `mock`；真实 SDK 适配器已编写并通过替身测试，尚未真实调用。
- 已在本地安装 wx-server-sdk 4.0.2、tencentcloud-sdk-nodejs-ocr 4.1.328，锁文件纳入版本管理。安装禁用了依赖脚本，缓存位于被 Git 忽略的 `.local-backups/`。

## 云函数契约

输入 `{ "imageBase64": "<纯 base64>" }`，接受 JPEG/PNG，解码后最多 512 KiB。
身份仅通过 `cloud.getWXContext().OPENID` 获取，忽略客户端的身份、模式和权限参数。

成功：`{ ok: true, mock: true或false, lines: ["文字行"] }`。
失败：`{ ok: false, error: { code, message } }`。
当前只返回文字行，不解析取件码、不做驿站分组。

前端模拟页面目前允许选择最多 5 MiB 图片；阶段 E 接入云函数时必须新增压缩/大小检查和用户可见上传说明，不能直接将 5 MiB 图片传入此接口。512 KiB 是当前单张联调的保守传输限制；长截图的清晰度与更大图片方案待真实样本验证。

## 阶段 E 的待批准操作

1. 在上述环境新增并部署 `recognizePickup` 事件函数，先保持 `OCR_MODE=mock`，进行一次模拟云调用。使用受支持的 Node.js 运行时，建议超时 20 秒；不部署原有 QuickStart 函数，不创建数据库或存储数据。
2. 检查该函数运行角色的已有权限。若需要新增角色或调整策略，展示实际角色及变更后另行请求批准。
3. 获批后，服务端配置测试用户 `OCR_ALLOWED_OPENIDS`，再将 `OCR_MODE` 设为 `real`；不接受前端控制此开关。
4. 接通单张前端流程，使用本项目内无个人信息的测试图片，最多进行 3 次真实 GeneralBasicOCR 调用。测试前重新检查免费额度与后付费状态。不自动重试；错误或额度不足即停止。个人取件截图不在这次自动上传测试范围内。

预计消耗：少量云函数调用、运行资源和外网流量，以及最多 3 次 OCR 免费次数。部署和调用本身属于云资源操作；如平台要求升级套餐或启用计费，停止并请求批准。不能承诺云函数部分绝对零费用。

## 最小 OCR 策略草案（未创建、未绑定）

```json
{
  "version": "2.0",
  "statement": [{
    "effect": "allow",
    "action": ["ocr:GeneralBasicOCR"],
    "resource": ["*"]
  }]
}
```

该策略只给目标函数的运行角色授予 GeneralBasicOCR 操作；接口不支持用图片资源 ID 限定资源。需保留平台必要的基础权限，但不扩大到 OCR 全权限。不生成长期密钥；每次请求读取平台临时 SecretId、SecretKey 和 SessionToken，不输出至日志。

当前代码仅做测试用户白名单，不是面向全校开放的配额系统。公开使用前需增加每用户限额及全局调用预算；阶段 E 只对测试用户开放。

## 本地复验

在项目根目录使用 Node.js 执行：

```sh
node --test tests/*.test.js
```

本机 Node 不在默认 PATH，已使用 Codex 附带的 Node.js 24 运行。测试通过不代表真实云身份授权或 OCR 准确率已验证。
