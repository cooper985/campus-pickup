# 真实 OCR 本地测试

复用微信开发者工具中已登录、已获白名单授权的小程序身份与现有 fileID 接口；无需本地腾讯云密钥，不部署云函数，不调用页面的正式保存方法。

默认 `node tests/live-ocr/run.cjs` 仅显示用法，不开服务、不生成 bootstrap、不调用云端。工具不再扫描 `test-data`，新增图片不会自动入选。

需要后续获准进行真实验证时，先在 Git 忽略的私有目录手工建立清单，只列本次已确认可用的文件；不要提交私人路径、原图或清单。例如 `test-data/private/live-ocr-v23/selection.json`：

```json
{"version":1,"samples":[{"id":"case-a","path":"test-data/private/approved/a.png","hash":"填写该文件的64位SHA-256摘要"}]}
```

路径相对项目根目录，只允许 `test-data/` 内的 JPEG/PNG，另允许显式列入项目对照图 `miniprogram/images/create_env.png`。摘要必须与实际字节一致；符号链接逃出允许目录会被拒绝。同摘要只入选一次，图片在启动后被替换也会在发送前停止。

1. 先运行 `node tests/live-ocr/run.cjs --manifest test-data/private/live-ocr-v23/selection.json`，仅离线校验并显示样本数，不启动桥接。
2. 仅在本次真实调用已获授权时运行 `node tests/live-ocr/run.cjs --allow-live --manifest test-data/private/live-ocr-v23/selection.json`。两个参数缺一不会启动桥接；服务仍只绑定 `127.0.0.1`。
3. 核对样本数后，将私有目录 `test-data/private/live-ocr-v23/bootstrap.js` 的内容粘贴到本项目开发者工具 Console 执行，才会请求真实 OCR。预检失败、权限失败或清理未确认时停止，不扩大权限。完成后停止本地服务。

离线 `inventory()` 默认读取既有私有 `manifest.json`，保留历史缓存回放；缺少它时返回空清单，不搜索其他目录。新实时运行的清单快照写入 `last-live-manifest.json`，不覆盖历史清单。`node tests/live-ocr/report.cjs` 仍针对历史清单离线评估，**会覆盖** `verification/v23-live-ocr-report.md` 与同名 JSON；仅分析时不要执行该生成命令。

首次最多预留 30 次 OCR，预留在提交前原子落盘。成功、失败和未确认请求都不会自动重复发送。同一原图及预处理配置优先命中私有缓存；解析算法变更无需再次请求 OCR。不要删除预算文件来绕过首轮上限。

完整 OCR 返回保存在上述私有目录，权限为目录 700、文件 600，不进入 Git。版本库仅保留必要的脱敏失败片段和人工标注。默认 `node --test tests/*.test.js` 不会访问云端；缺少私有样本或本轮缓存时，相关本地回放测试明确跳过。

`ocrMs` 是云函数返回的 OCR 调用段耗时；`totalMs` 还包含预检、准备、上传、调用和清理。缓存批次耗时不代表真实九图 OCR 性能。没有人工标注的公司、详细地址、运单、日期或物流状态不计准确率。
