# 校园取件助手：本地回归

V3.0.2 在 Node.js 24.22.1 验证；在项目根目录运行：

```sh
node --test tests/*.test.js
```

该命令使用内存存储、SDK 替身和离线 OCR 缓存，不调用真实 OCR，不清空微信存储。部分历史对照需要完整 Git 历史，私有回放材料缺失时会明确跳过，不能将其当作同等覆盖。`tests/v302-*.test.js` 是本轮合成回归，与既有真实 OCR 离线回放分开。

微信 UI 优先用已运行的开发者工具检查；浏览器布局脚本必须遵守本地 `AGENTS.md`，不能当作手机验收。真实 OCR 工具默认离线，显式样本清单和后续授权运行方法见 [tests/live-ocr/README.md](tests/live-ocr/README.md)。

以下保留原模板说明；`quickstartFunctions` 不是正式取件业务的云函数，线上部署与权限须在发布前另行核实。

## 云开发 quickstart

这是云开发的快速启动指引，其中演示了如何上手使用云开发的三大基础能力：

- 数据库：一个既可在小程序前端操作，也能在云函数中读写的 JSON 文档型数据库
- 文件存储：在小程序前端直接上传/下载云端文件，在云开发控制台可视化管理
- 云函数：在云端运行的代码，微信私有协议天然鉴权，开发者只需编写业务逻辑代码

## 参考文档

- [云开发文档](https://developers.weixin.qq.com/miniprogram/dev/wxcloud/basis/getting-started.html)

